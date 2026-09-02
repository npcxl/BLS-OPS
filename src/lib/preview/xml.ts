/**
 * Minimal XML helpers for the in-app file preview.
 *
 * Office files (xlsx / docx / pptx) are ZIP containers of XML parts. A full
 * DOM parser would mean pulling in a parser dependency for documents we only
 * ever read once, so these helpers do exactly what the OOXML parsers need:
 * walk a named element (with nesting), read its attributes, and decode the
 * few entities that appear in text runs.
 *
 * Deliberately *not* a compliant XML parser — namespaces, CDATA sections and
 * processing instructions are treated as plain text. That is safe here because
 * every input is a well-known Office part, and a malformed file surfaces as an
 * empty/garbled preview, never as an exception.
 */

export interface ElementMatch {
  /** Index of the `<name …>` opening tag. */
  start: number;
  /** Index just past this element's closing tag. */
  end: number;
  /** Raw attribute text of the opening tag. */
  attrs: string;
  /** Inner XML; empty for self-closing elements. */
  body: string;
  selfClosing: boolean;
}

/** Named entities Office (and hand-written XML) actually emits. */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeXmlEntities(text: string): string {
  if (text.indexOf("&") < 0) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x")) return safeCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return safeCodePoint(parseInt(body.slice(1), 10));
    return ENTITIES[body] ?? match;
  });
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Finds the `>` that closes the tag starting at `start`, ignoring quotes. */
function findTagEnd(xml: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < xml.length; i++) {
    const char = xml[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === ">") return i;
  }
  return -1;
}

/** True when `index` starts `token` followed by a separator, so a search for
 *  `<t` never matches the `<table` element. */
function isTokenAt(xml: string, index: number, token: string): boolean {
  if (!xml.startsWith(token, index)) return false;
  const after = xml[index + token.length];
  return after === undefined || /[\s/>]/.test(after);
}

/**
 * Index of the next `</name` that is really that element's closing tag.
 *
 * A plain `indexOf("</w:p")` also matches `</w:pPr>`, which silently truncated
 * every Word paragraph at its properties element — headings and bullets
 * vanished. The character after the name must end the tag (`>`) or start an
 * attribute/whitespace, exactly like the opening side.
 */
function findCloseIndex(xml: string, name: string, from: number): number {
  const token = `</${name}`;
  let index = Math.max(0, from);
  for (;;) {
    const found = xml.indexOf(token, index);
    if (found < 0) return -1;
    const after = xml[found + token.length];
    if (after === undefined || /[\s>]/.test(after)) return found;
    index = found + token.length;
  }
}

/**
 * The first `<name …>` element at or after `from`, nesting included.
 *
 * Returns `null` when there is none. The `end` index lets callers walk a body
 * in document order (interleaving paragraphs, tables and pictures) instead of
 * collecting one element name at a time.
 */
export function nextElement(xml: string, name: string, from = 0): ElementMatch | null {
  const openToken = `<${name}`;
  let index = Math.max(0, from);

  while (index < xml.length) {
    const start = xml.indexOf(openToken, index);
    if (start < 0) return null;
    if (!isTokenAt(xml, start, openToken)) {
      index = start + openToken.length;
      continue;
    }
    const tagEnd = findTagEnd(xml, start);
    if (tagEnd < 0) return null;
    const attrs = xml.slice(start + openToken.length, tagEnd);

    if (attrs.trimEnd().endsWith("/")) {
      return { start, end: tagEnd + 1, attrs, body: "", selfClosing: true };
    }

    let depth = 1;
    let cursor = tagEnd + 1;
    const bodyStart = cursor;
    let bodyEnd = xml.length;
    while (depth > 0 && cursor < xml.length) {
      const nextOpen = xml.indexOf(openToken, cursor);
      const nextClose = findCloseIndex(xml, name, cursor);
      if (nextClose < 0) {
        bodyEnd = xml.length;
        break;
      }
      if (nextOpen >= 0 && nextOpen < nextClose && isTokenAt(xml, nextOpen, openToken)) {
        depth += 1;
        cursor = nextOpen + openToken.length;
      } else {
        depth -= 1;
        // `</` + name + `>`
        cursor = nextClose + name.length + 3;
        if (depth === 0) bodyEnd = nextClose;
      }
    }
    return { start, end: cursor, attrs, body: xml.slice(bodyStart, bodyEnd), selfClosing: false };
  }
  return null;
}

/** Every `<name …>` element at the top level of `xml` (nesting-aware). */
export function findTags(xml: string, name: string): ElementMatch[] {
  const results: ElementMatch[] = [];
  let cursor = 0;
  for (;;) {
    const match = nextElement(xml, name, cursor);
    if (!match) return results;
    results.push(match);
    cursor = match.end;
  }
}

/** Reads one attribute value from a tag's raw attribute text. */
export function attr(attrs: string, name: string): string | null {
  const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attrs);
  if (!match) return null;
  return decodeXmlEntities(match[2] ?? match[3] ?? "");
}

/** Text of a single `<name>…</name>` element (tags inside it stripped). */
export function elementText(xml: string, name: string): string {
  return findTags(xml, name)
    .map((tag) => decodeXmlEntities(stripTags(tag.body)))
    .join("");
}

/** Concatenates every `<name>` run inside `xml` (Word / PowerPoint text). */
export function runTexts(xml: string, name: string): string {
  return findTags(xml, name)
    .map((tag) => decodeXmlEntities(stripTags(tag.body)))
    .join("");
}

/** Removes every tag from a fragment. */
export function stripTags(xml: string): string {
  return xml.replace(/<[^>]*>/g, "");
}
