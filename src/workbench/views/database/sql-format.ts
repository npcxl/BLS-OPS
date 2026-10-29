/**
 * 轻量 SQL 美化。
 *
 * 目标不是做一个完整的 SQL 解析器，而是**只动空白与关键字大小写**：
 * - 字符串 / 反引号标识符 / 注释里的内容一个字都不改，避免"格式化把 SQL 弄坏"；
 * - 主要子句（SELECT / FROM / WHERE / JOIN …）另起一行，AND/OR 缩进一层；
 * - 关键字统一大写，其余 token 原样保留。
 *
 * 宁可少做也不改错：看不懂的地方（比如奇怪的符号）就原样输出。
 */

/** 另起一行、与当前括号深度对齐的子句关键字。 */
const CLAUSE_KEYWORDS = new Set([
  "select",
  "from",
  "where",
  "group",
  "order",
  "having",
  "limit",
  "offset",
  "union",
  "insert",
  "update",
  "delete",
  "values",
  "set",
  "join",
  "left",
  "right",
  "inner",
  "outer",
  "cross",
  "on",
  "returning",
  "using",
]);

/** 这些词后面的子句关键字属于同一个词组，不能换行拆开（LEFT JOIN / DELETE FROM）。 */
const CLUSTER_HEADS = new Set([
  "left",
  "right",
  "inner",
  "outer",
  "cross",
  "union",
  "delete",
]);

/** 需要缩进一层的连接词。 */
const INDENTED_KEYWORDS = new Set(["and", "or"]);

/** 其余需要大写的关键字（包含类型与常用函数之外的词）。 */
const OTHER_KEYWORDS = new Set([
  "as",
  "asc",
  "desc",
  "distinct",
  "null",
  "not",
  "is",
  "in",
  "like",
  "between",
  "exists",
  "case",
  "when",
  "then",
  "else",
  "end",
  "by",
  "all",
  "any",
  "true",
  "false",
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "if",
  "default",
  "primary",
  "key",
  "unique",
  "index",
  "table",
  "database",
  "view",
  "alter",
  "create",
  "drop",
  "replace",
  "truncate",
  "add",
  "modify",
  "change",
  "column",
  "constraint",
  "foreign",
  "references",
  "cascade",
  "restrict",
  "ignore",
  "duplicate",
]);

type TokenKind = "word" | "space" | "string" | "comment" | "punct";

interface Token {
  kind: TokenKind;
  text: string;
}

/** 只切分、不解释：引号/注释原样成 token，格式化时整段搬运。 */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let pending = "";

  const flushWord = () => {
    if (pending) {
      tokens.push({ kind: "word", text: pending });
      pending = "";
    }
  };

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (/\s/.test(char)) {
      flushWord();
      let end = index;
      while (end < sql.length && /\s/.test(sql[end])) end += 1;
      tokens.push({ kind: "space", text: sql.slice(index, end) });
      index = end;
      continue;
    }

    // 单/双引号字符串与反引号标识符：整段搬运，内部不再分词。
    if (char === "'" || char === '"' || char === "`") {
      flushWord();
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === "\\" && char !== "`") {
          end += 2;
          continue;
        }
        if (sql[end] === char) {
          if (sql[end + 1] === char) {
            end += 2;
            continue;
          }
          end += 1;
          break;
        }
        end += 1;
      }
      tokens.push({ kind: "string", text: sql.slice(index, end) });
      index = end;
      continue;
    }

    // -- 行注释 / # 行注释
    if ((char === "-" && next === "-") || char === "#") {
      flushWord();
      let end = index;
      while (end < sql.length && sql[end] !== "\n") end += 1;
      tokens.push({ kind: "comment", text: sql.slice(index, end) });
      index = end;
      continue;
    }

    if (char === "/" && next === "*") {
      flushWord();
      const close = sql.indexOf("*/", index + 2);
      const end = close < 0 ? sql.length : close + 2;
      tokens.push({ kind: "comment", text: sql.slice(index, end) });
      index = end;
      continue;
    }

    if (/[(),;.]/.test(char)) {
      flushWord();
      tokens.push({ kind: "punct", text: char });
      index += 1;
      continue;
    }

    pending += char;
    index += 1;
  }

  flushWord();
  return tokens;
}

const indentOf = (depth: number) => "  ".repeat(depth);

/** 把一段 SQL 排成"关键字大写 + 子句换行"的多行文本。 */
export function formatSql(sql: string): string {
  const tokens = tokenize(sql);
  const lines: string[] = [];
  let current = "";
  let depth = 0;
  /** 上一个词 token（小写），用来判断 LEFT JOIN / DELETE FROM 这类词组。 */
  let lastWord: string | null = null;

  const pushLine = () => {
    const trimmed = current.trimEnd();
    if (trimmed.trim()) lines.push(trimmed);
    current = "";
  };

  const append = (text: string, spaced: boolean) => {
    if (!current) {
      current = text;
      return;
    }
    if (spaced && !current.endsWith(" ")) current += " ";
    current += text;
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token.kind === "space") {
      if (current && !current.endsWith(" ")) current += " ";
      continue;
    }

    if (token.kind === "comment") {
      const inline = current.trim().length > 0;
      if (inline) {
        current = `${current.trimEnd()} ${token.text}`;
        pushLine();
      } else {
        current = `${indentOf(depth)}${token.text}`;
        pushLine();
      }
      continue;
    }

    if (token.kind === "punct") {
      if (token.text === "(") {
        // 函数调用 `count(` 和子查询 `(select` 都不加空格。
        current = `${current.trimEnd()}(`;
        depth += 1;
        continue;
      }
      if (token.text === ")") {
        depth = Math.max(0, depth - 1);
        current = `${current.trimEnd()})`;
        continue;
      }
      if (token.text === ",") {
        current = `${current.trimEnd()},`;
        continue;
      }
      if (token.text === ";") {
        current = `${current.trimEnd()};`;
        pushLine();
        continue;
      }
      // `.` 直接贴住两侧标识符。
      current = `${current.trimEnd()}${token.text}`;
      continue;
    }

    if (token.kind === "string") {
      append(token.text, true);
      continue;
    }

    const lower = token.text.toLowerCase();
    const spaced = !current.endsWith("(") && !current.endsWith("`") && !current.endsWith(".");
    const clustered = lastWord !== null && CLUSTER_HEADS.has(lastWord);

    if (CLAUSE_KEYWORDS.has(lower) && !clustered) {
      // 子句关键字另起一行；词组（LEFT JOIN / DELETE FROM）保持在同行。
      pushLine();
      current = `${indentOf(depth)}${token.text.toUpperCase()}`;
      lastWord = lower;
      continue;
    }

    if (INDENTED_KEYWORDS.has(lower) && !clustered) {
      pushLine();
      current = `${indentOf(depth + 1)}${token.text.toUpperCase()}`;
      lastWord = lower;
      continue;
    }

    const text =
      CLAUSE_KEYWORDS.has(lower) || OTHER_KEYWORDS.has(lower)
        ? token.text.toUpperCase()
        : token.text;
    append(text, spaced);
    lastWord = lower;
  }

  pushLine();
  return lines.join("\n");
}
