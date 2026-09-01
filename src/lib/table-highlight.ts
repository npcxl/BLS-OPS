/**
 * Terminal output highlighting for tabular commands (docker ps / ls -l / df / ps
 * / systemctl / etc.). This is a *presentation* layer only: it takes the raw
 * text lines the shell printed and returns the same lines re-emitted with ANSI
 * color/weight codes. No structural parsing, no layout re-flow — the original
 * column spacing from the remote shell is preserved, so the terminal keeps its
 * native feel while gaining readable tables.
 *
 * The highlighter is stateful across a session: it remembers which tabular
 * command was last run so it can color that command's output block until the
 * next prompt.
 */

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  // 256-ish palette mapped to our theme accents
  header: "\x1b[1;36m", // bold cyan
  green: "\x1b[32m",
  brightGreen: "\x1b[92m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  brightRed: "\x1b[91m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
} as const;

export type TableCommand =
  | "docker-ps"
  | "docker-images"
  | "ls-l"
  | "df"
  | "ps"
  | "systemctl"
  | "du"
  | null;

/** Map a typed command to the kind of table output it produces. */
export function classifyCommand(command: string): TableCommand {
  const c = command.trim();
  if (/^docker\s+(container\s+)?ps\b/.test(c) || /^docker\s+ps\b/.test(c)) return "docker-ps";
  if (/^docker\s+(image\s+)?(ls|images)\b/.test(c)) return "docker-images";
  if (/^(\/usr\/bin\/)?ls\s+.*\s-l/.test(c) || /^ls\s+-l/.test(c)) return "ls-l";
  if (/^df\b/.test(c)) return "df";
  if (/^ps\b/.test(c)) return "ps";
  if (/^systemctl\b/.test(c) || /^(\/bin\/)?systemctl\b/.test(c)) return "systemctl";
  if (/^du\b/.test(c) && /-h/.test(c)) return "du";
  return null;
}

/**
 * Returns true for lines that look like a command's header row rather than a
 * data row, so we can bold them.
 */
function isHeaderLine(cmd: TableCommand, line: string): boolean {
  switch (cmd) {
    case "docker-ps":
      return /^CONTAINER ID/.test(line);
    case "docker-images":
      return /^REPOSITORY/.test(line);
    case "ls-l":
      return false; // ls -l has no header
    case "df":
      return /^Filesystem/.test(line);
    case "ps":
      return /^PID\s+TTY/.test(line) || /^USER\s+PID/.test(line);
    case "systemctl":
      return /^UNIT\s|^\s*UNIT/.test(line);
    default:
      return false;
  }
}

/**
 * Docker status coloring: "Up ..." green, "Exited" red, "Restarting"/"Created"
 * yellow, "Paused" magenta.
 */
function colorDockerStatus(line: string): string {
  // Tokenize by 2+ spaces (docker's column separator).
  const cols = line.split(/\s{2,}/);
  const out = cols.map((tok) => {
    const t = tok.trim();
    if (/^Up\b/.test(t)) return ANSI.brightGreen + t + ANSI.reset;
    if (/^Exited\b/.test(t) || /^Dead\b/.test(t)) return ANSI.brightRed + t + ANSI.reset;
    if (/^Restarting\b/.test(t) || /^Created\b/.test(t)) return ANSI.yellow + t + ANSI.reset;
    if (/^Paused\b/.test(t)) return ANSI.magenta + t + ANSI.reset;
    return t;
  });
  return out.join("  ");
}

/** df usage percentage: green < 70, yellow < 90, red otherwise. */
function colorDfUsage(line: string): string {
  return line.replace(/(\d+)%/.exec(line)?.[0] ?? "", (m) => {
    const pct = parseInt(m, 10);
    const color = pct >= 90 ? ANSI.brightRed : pct >= 70 ? ANSI.yellow : ANSI.brightGreen;
    return color + m + ANSI.reset;
  });
}

/** ps state column: R running green, S sleeping dim, D/Z/T warning colors. */
function colorPsState(line: string): string {
  // ps aux style: STAT near the middle. Color the whole STAT token.
  return line.replace(/\b([RSDZT])[<N>]?\b/, (m, s: string) => {
    const color =
      s === "R" ? ANSI.brightGreen : s === "S" || s === "D" ? ANSI.blue : s === "Z" || s === "T" ? ANSI.red : "";
    return color ? color + m + ANSI.reset : m;
  });
}

/** Wrap the line in the right ANSI treatment for the active table command. */
function decorate(cmd: TableCommand, line: string): string {
  if (!cmd || !line.trim()) return line;
  if (isHeaderLine(cmd, line)) {
    return ANSI.header + line + ANSI.reset;
  }
  switch (cmd) {
    case "docker-ps":
      return colorDockerStatus(line);
    case "df":
      return colorDfUsage(line);
    case "ps":
      return colorPsState(line);
    case "ls-l": {
      // Color the permission string and the size column.
      const m = /^(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s/.exec(line);
      if (m) {
        const sizeColor = ANSI.blue + m[5] + ANSI.reset;
        return line.replace(m[5], sizeColor);
      }
      return line;
    }
    default:
      return line;
  }
}

/**
 * Accumulates streamed output, emits complete lines (those terminated by a
 * newline) already decorated, and keeps any trailing partial line buffered.
 */
export class OutputDecorator {
  private partial = "";
  private active: TableCommand = null;

  /** Tell the decorator which tabular command produced the next output block. */
  setActiveCommand(cmd: TableCommand) {
    this.active = cmd;
  }

  /**
   * Feed a raw chunk. Returns an array of *complete* lines (newline-terminated
   * in the original stream) to write to the terminal, with ANSI codes applied.
   * The trailing partial line (if any) is held until a newline arrives.
   */
  push(chunk: string): string[] {
    const merged = this.partial + chunk;
    const lines = merged.split("\n");
    // Last element is the (possibly empty) trailing partial line.
    this.partial = lines.pop() ?? "";
    return lines.map((ln) => decorate(this.active, ln));
  }

  /** Flush any buffered partial line (e.g. on disconnect). */
  flush(): string[] {
    if (!this.partial) return [];
    const ln = this.partial;
    this.partial = "";
    return [decorate(this.active, ln)];
  }
}
