/**
 * SQL 语句拆分。
 *
 * **不是** `split(';')`：分号可能出现在字符串、反引号标识符、`--`/`#`
 * 行注释或 `/* *\/` 块注释里。这里逐字符扫描并维护状态。
 *
 * 首版边界（明确不支持，而不是假装支持）：
 * - MySQL CLI 的 `DELIMITER $$` 指令不解析：存储过程/触发器定义请单独执行；
 * - `\g` / `\G` 客户端命令不解析；
 * - 语句内的 `;` 只有在状态机认为"代码里"时才算分隔符。
 */

interface SplitOutcome {
  statements: string[];
  /** 发现 DELIMITER 这类不支持的语法时给出明确提示。 */
  warnings: string[];
}

export function splitSqlStatements(sql: string): SplitOutcome {
  const statements: string[] = [];
  const warnings: string[] = [];

  let current = "";
  let index = 0;
  let state: "code" | "single" | "double" | "backtick" | "line-comment" | "block-comment" =
    "code";

  const push = () => {
    const trimmed = current.trim();
    if (trimmed) statements.push(trimmed);
    current = "";
  };

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1] ?? "";

    if (state === "code") {
      if (char === "'") {
        state = "single";
        current += char;
      } else if (char === '"') {
        state = "double";
        current += char;
      } else if (char === "`") {
        state = "backtick";
        current += char;
      } else if (char === "-" && next === "-") {
        state = "line-comment";
        current += char;
      } else if (char === "#") {
        state = "line-comment";
        current += char;
      } else if (char === "/" && next === "*") {
        state = "block-comment";
        current += char;
      } else if (char === ";") {
        push();
      } else {
        current += char;
      }
      index += 1;
      continue;
    }

    if (state === "single" || state === "double") {
      const quote = state === "single" ? "'" : '"';
      if (char === "\\") {
        // MySQL 默认反斜杠转义：连同下一个字符一起吞掉。
        current += char;
        if (next) current += next;
        index += 2;
        continue;
      }
      if (char === quote && next === quote) {
        current += char + next;
        index += 2;
        continue;
      }
      current += char;
      if (char === quote) state = "code";
      index += 1;
      continue;
    }

    if (state === "backtick") {
      current += char;
      if (char === "`" && next === "`") {
        current += next;
        index += 2;
        continue;
      }
      if (char === "`") state = "code";
      index += 1;
      continue;
    }

    if (state === "line-comment") {
      current += char;
      if (char === "\n") state = "code";
      index += 1;
      continue;
    }

    // block-comment
    current += char;
    if (char === "*" && next === "/") {
      current += next;
      state = "code";
      index += 2;
      continue;
    }
    index += 1;
  }

  push();

  for (const statement of statements) {
    if (/^\s*delimiter\b/i.test(statement)) {
      warnings.push(
        "检测到 DELIMITER 指令：首版不支持客户端 DELIMITER。请把存储过程/触发器定义作为单条语句执行，或改用其他客户端。",
      );
    }
  }

  return { statements, warnings };
}

/** 当前光标所在的语句（用于"执行当前语句"）。 */
export function statementAtCursor(sql: string, cursor: number): string {
  const { statements } = splitSqlStatements(sql);
  if (statements.length === 0) return "";
  if (statements.length === 1) return statements[0];

  // 用分号位置近似：找到光标之前最后一个顶层分号所属的语句。
  let offset = 0;
  for (const statement of statements) {
    const start = sql.indexOf(statement, offset);
    if (start < 0) continue;
    const end = start + statement.length;
    if (cursor >= start && cursor <= end + 1) return statement;
    offset = end;
  }
  return statements[statements.length - 1];
}
