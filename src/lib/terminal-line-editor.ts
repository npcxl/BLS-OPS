/**
 * Terminal line editor used to recover the command the user actually typed.
 *
 * xterm gives us a raw byte stream and the shell does the real line editing —
 * but we still need to know what was submitted in order to record command
 * history. Naively accumulating "printable" characters breaks on:
 *
 *   - arrow keys / Home / End (`ESC [ A` etc.) — printable, but not text
 *   - Ctrl+C / Ctrl+D — abandon the line instead of recording it
 *   - bracketed paste (`ESC [ 200 ~` … `ESC [ 201 ~`) — one chunk, often multi-line
 *   - line continuations (`\` at EOL, or an unterminated quote) — the command
 *     is not finished yet, so recording it would store a fragment
 *
 * `LineEditor.feed()` consumes the raw stream and returns every command that
 * reached a completed state, in order.
 */

const ABORT_CODES = new Set([
  0x03, // Ctrl+C — interrupt
  0x04, // Ctrl+D — EOF
  0x1a, // Ctrl+Z — suspend
]);

/**
 * Ctrl keys we can model without tracking the cursor position.
 *
 * Anything that depends on cursor position (Ctrl+A/E/K moving or killing
 * relative to the cursor) cannot be reproduced faithfully here: the cursor is
 * on the remote side. These cases degrade to the nearest safe behaviour rather
 * than corrupting the buffer.
 */
const CTRL_KEYS: Record<number, (line: string) => string> = {
  0x01: () => "", // Ctrl+A
  0x15: () => "", // Ctrl+U — clear line
  0x17: (line) => line.replace(/\S*\s*$/, ""), // Ctrl+W — delete last word
};

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** CSI: ESC [ params final-byte */
const CSI = /^\x1b\[[0-9;]*[A-Za-z~]/;

/** Guards against buffering forever on a malformed sequence. */
const MAX_ESCAPE_LENGTH = 32;

export function hasUnterminatedQuote(line: string): boolean {
  let quote: string | null = null;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
    }
  }
  return quote !== null;
}

/** True when the shell will wait for another line (`\` at end of line). */
export function isContinuation(line: string): boolean {
  return /(^|[^\\])(\\\\)*\\$/.test(line);
}

/**
 * Accumulates raw terminal input into the command being typed.
 *
 * One instance per terminal session: it holds the in-progress line between
 * chunks of input.
 */
export class LineEditor {
  private line = "";
  /** Bytes of an escape sequence received so far but not yet recognised. */
  private pending = "";
  private inPaste = false;
  private paste = "";

  /** The line currently being typed. */
  get current(): string {
    return this.line;
  }

  /**
   * Best-effort cursor position within the tracked line.
   *
   * The real cursor lives in the remote shell — we only see the keystrokes —
   * so this reports the end of the tracked buffer. That is exact for the
   * common case (typing at the end of the line) and is the only safe
   * approximation: guessing a mid-line offset from arrow-key escapes would
   * desynchronise completion and corrupt the command.
   */
  get cursor(): number {
    return this.line.length;
  }

  /** Drops the in-progress line (after submit, Ctrl+C, or a lost focus). */
  reset(): void {
    this.line = "";
    this.pending = "";
    this.inPaste = false;
    this.paste = "";
  }

  /**
   * Consumes raw terminal input and returns the commands it completed.
   *
   * A paste holding three newlines yields three commands; an aborted line
   * (Ctrl+C) yields none.
   */
  feed(data: string): string[] {
    const completed: string[] = [];
    let i = 0;

    while (i < data.length) {
      // An escape sequence that spanned the previous chunk: the current chunk
      // starts *inside* the sequence, so resume matching before anything else.
      if (this.pending) {
        const sequence = this.pending + data.slice(i);
        const matched = matchEscape(sequence);
        if (matched === null) {
          this.pending = sequence;
          return completed;
        }
        i += matched.length - this.pending.length;
        this.pending = "";
        continue;
      }

      // Bracketed paste: everything up to the end marker is literal text.
      if (this.inPaste) {
        const end = data.indexOf(PASTE_END, i);
        if (end === -1) {
          this.paste += data.slice(i);
          return completed;
        }
        this.paste += data.slice(i, end);
        i = end + PASTE_END.length;
        this.inPaste = false;
        completed.push(...this.consumeText(this.paste));
        this.paste = "";
        continue;
      }

      if (data.startsWith(PASTE_START, i)) {
        this.inPaste = true;
        this.paste = "";
        i += PASTE_START.length;
        continue;
      }

      if (data[i] === "\x1b") {
        const matched = matchEscape(data.slice(i));
        if (matched === null) {
          // Incomplete — wait for the rest of the sequence.
          this.pending = data.slice(i);
          return completed;
        }
        // Escape sequences never contribute text.
        i += matched.length;
        continue;
      }

      const char = data[i];
      i += 1;

      if (char === "\r" || char === "\n") {
        completed.push(...this.submit());
      } else if (char === "\x7f" || char === "\b") {
        this.line = this.line.slice(0, -1);
      } else {
        const code = char.charCodeAt(0);
        if (ABORT_CODES.has(code)) {
          this.line = "";
        } else if (CTRL_KEYS[code]) {
          this.line = CTRL_KEYS[code](this.line);
        } else if (code >= 0x20 || char === "\t") {
          this.line += char;
        }
        // Other control bytes are forwarded to the shell but contribute no text.
      }
    }

    return completed;
  }

  /**
   * Appends a chunk of literal text, splitting it on newlines.
   *
   * A multi-line paste is executed line by line by the shell, so each newline
   * completes a command.
   */
  private consumeText(chunk: string): string[] {
    const completed: string[] = [];
    const parts = chunk.split(/\r\n|\r|\n/);
    parts.forEach((part, index) => {
      this.line += part;
      if (index < parts.length - 1) completed.push(...this.submit());
    });
    return completed;
  }

  /**
   * Commits the pending line, unless the shell is still waiting for more input.
   */
  private submit(): string[] {
    const line = this.line;

    // Continuation: keep accumulating and drop the trailing backslash so the
    // final command reads naturally.
    if (isContinuation(line)) {
      this.line = `${line.replace(/(^|[^\\])(\\\\)*\\$/, "$1$2").trimEnd()} `;
      return [];
    }
    // Unterminated quote: the shell is still reading, so wait.
    if (hasUnterminatedQuote(line)) {
      return [];
    }

    this.line = "";
    const trimmed = line.trim();
    return trimmed ? [trimmed] : [];
  }
}

/**
 * Returns the escape sequence at the start of `text`, or null when more bytes
 * are needed to decide.
 */
function matchEscape(text: string): string | null {
  if (text.length < 2) return null;
  if (text.length > MAX_ESCAPE_LENGTH) return text.slice(0, 2);

  // CSI must wait for its final byte. Without this guard a bare `ESC [` looks
  // like a complete two-byte sequence, the `[` is consumed early, and the next
  // byte (the real final byte) leaks into the command as text.
  if (text[1] === "[") {
    const match = CSI.exec(text);
    return match ? match[0] : null;
  }

  // SS3 (ESC O <char>) is always three bytes.
  if (text[1] === "O") {
    return text.length >= 3 ? text.slice(0, 3) : null;
  }

  // Any other ESC <char> is a complete two-byte sequence, e.g. Alt+<char>.
  return text.slice(0, 2);
}
