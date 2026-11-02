/**
 * SQL 语句拆分。
 *
 * **不是** `split(';')`：分号可能出现在字符串、标识符、注释或
 * PostgreSQL 的 `$$ … $$` 里。这里逐字符扫描并维护状态。
 *
 * 方言差异由调用方传入 `SplitRules`（来自后端注册表的 `dialect_rules`）：
 * - `hash_line_comment`：只有 MySQL 把 `#` 当行注释；
 * - `backslash_escapes`：只有 MySQL 在字符串里用反斜杠转义，标准 SQL 里
 *   `'a\'` 的 `\` 是普通字符、后面的 `'` 才结束字符串；
 * - `dollar_quoting`：PostgreSQL 的 `$$ … $$` 里不拆语句；
 * - `batch_terminator`：SQL Server 的 `GO` 独占一行。
 *
 * 不传 rules 时按 MySQL 处理 —— 与改造前行为一致，既有调用点无需改动。
 *
 * 明确不支持（而不是假装支持）：
 * - MySQL CLI 的 `DELIMITER $$` 指令；
 * - `\g` / `\G` 客户端命令；
 * - Oracle SQL*Plus 的 `/` 块提交；
 * - PostgreSQL 的 `$tag$ … $tag$`（只认 `$$`）。
 */

export interface SplitRules {
  hash_line_comment: boolean;
  backslash_escapes: boolean;
  dollar_quoting: boolean;
  batch_terminator: string | null;
  statement_terminator: string;
}

/** 改造前的行为：MySQL 客户端语义。 */
export const MYSQL_SPLIT_RULES: SplitRules = {
  hash_line_comment: true,
  backslash_escapes: true,
  dollar_quoting: false,
  batch_terminator: null,
  statement_terminator: ";",
};

interface SplitOutcome {
  statements: string[];
  /** 发现 DELIMITER 这类不支持的语法时给出明确提示。 */
  warnings: string[];
}

type ScanState =
  | "code"
  | "single"
  | "double"
  | "backtick"
  | "line-comment"
  | "block-comment"
  | "dollar";

export function splitSqlStatements(
  sql: string,
  rules: SplitRules = MYSQL_SPLIT_RULES,
): SplitOutcome {
  const statements: string[] = [];
  const warnings: string[] = [];

  let current = "";
  let index = 0;
  let state: ScanState = "code";
  /** 自上一个换行以来只有空白：`GO` 只能出现在行首。 */
  let atLineStart = true;

  const push = () => {
    const trimmed = current.trim();
    if (trimmed) statements.push(trimmed);
    current = "";
  };

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1] ?? "";

    if (state === "code") {
      // SQL Server 的 `GO`：独占一行，不分大小写。
      if (atLineStart && rules.batch_terminator) {
        const rest = sql.slice(index);
        const go = new RegExp(
          `^[ \\t]*${rules.batch_terminator}[ \\t]*(?=\\r?\\n|$)`,
          "i",
        ).exec(rest);
        if (go) {
          push();
          index += go[0].length;
          continue;
        }
      }

      if (!/\s/.test(char)) atLineStart = false;
      if (char === "\n") atLineStart = true;

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
      } else if (char === "#" && rules.hash_line_comment) {
        state = "line-comment";
        current += char;
      } else if (char === "/" && next === "*") {
        state = "block-comment";
        current += char;
      } else if (rules.dollar_quoting && char === "$" && next === "$") {
        state = "dollar";
        current += char + next;
        index += 2;
        continue;
      } else if (char === rules.statement_terminator) {
        push();
      } else {
        current += char;
      }
      index += 1;
      continue;
    }

    if (state === "dollar") {
      if (char === "$" && next === "$") {
        current += "$$";
        state = "code";
        index += 2;
        continue;
      }
      current += char;
      index += 1;
      continue;
    }

    if (state === "single" || state === "double") {
      const quote = state === "single" ? "'" : '"';
      if (char === "\\" && rules.backslash_escapes) {
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
      if (char === "\n") {
        state = "code";
        atLineStart = true;
      }
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
export function statementAtCursor(
  sql: string,
  cursor: number,
  rules: SplitRules = MYSQL_SPLIT_RULES,
): string {
  const { statements } = splitSqlStatements(sql, rules);
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
