/**
 * 危险 SQL 的识别 —— 只用于**执行前的确认**，不参与任何安全校验。
 *
 * 为什么放在前端：这里判断的是"用户意图"（他要不要删库/清表），而不是
 * "这条语句合不合法"。后端仍然照常执行，权限与只读模式在后端把守。
 *
 * 识别口径只覆盖**会删数据**的语句：
 * - `DROP <对象>`：删表/库/视图/索引/过程…
 * - `TRUNCATE [TABLE]`：清空表
 * - `DELETE FROM ...` 且**没有 WHERE**：整表删除
 *
 * 有意不包含 `UPDATE`：它改数据但不删数据，用户明确说的是"删除"。
 * 误报的代价只是一次多余的确认；漏报的代价是数据没了，所以宁可宽一点。
 */

export type DestructiveKind = "drop" | "truncate" | "delete-all";

export interface DestructiveStatement {
  /** 去掉首尾空白与结尾分号的语句原文（弹窗里展示用）。 */
  statement: string;
  kind: DestructiveKind;
}

/** 去掉行注释，避免 `-- drop table` 这种注释被当成语句。 */
function stripLeadingComments(sql: string): string {
  let text = sql.trimStart();
  for (;;) {
    if (text.startsWith("--") || text.startsWith("#")) {
      const end = text.indexOf("\n");
      if (end < 0) return "";
      text = text.slice(end + 1).trimStart();
      continue;
    }
    if (text.startsWith("/*")) {
      const end = text.indexOf("*/", 2);
      if (end < 0) return "";
      text = text.slice(end + 2).trimStart();
      continue;
    }
    return text;
  }
}

/**
 * `WHERE` 是否出现在"代码里"（不是字符串、注释或标识符里）。
 *
 * 逐字符扫描：字符串/反引号里的 `where` 不算条件 —— 否则
 * `DELETE FROM t -- where id=1` 这种会被误判成"有条件"。
 */
function hasTopLevelWhere(sql: string): boolean {
  const lower = sql.toLowerCase();
  let state: "code" | "single" | "double" | "backtick" | "line-comment" | "block-comment" =
    "code";
  let index = 0;
  while (index < lower.length) {
    const char = lower[index];
    const next = lower[index + 1] ?? "";
    if (state === "code") {
      if (char === "'") state = "single";
      else if (char === '"') state = "double";
      else if (char === "`") state = "backtick";
      else if (char === "-" && next === "-") state = "line-comment";
      else if (char === "#") state = "line-comment";
      else if (char === "/" && next === "*") state = "block-comment";
      else if (char === "w" && lower.startsWith("where", index)) {
        // 前后必须是词边界：`somewhere` / `wherever` 不算。
        const before = lower[index - 1] ?? " ";
        const after = lower[index + 5] ?? " ";
        if (!/[a-z0-9_]/i.test(before) && !/[a-z0-9_]/i.test(after)) return true;
      }
    } else if (state === "single") {
      if (char === "'" && next === "'") index += 1;
      else if (char === "'") state = "code";
    } else if (state === "double") {
      if (char === '"') state = "code";
    } else if (state === "backtick") {
      if (char === "`") state = "code";
    } else if (state === "line-comment") {
      if (char === "\n") state = "code";
    } else if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "code";
        index += 1;
      }
    }
    index += 1;
  }
  return false;
}

function classify(sql: string): DestructiveKind | null {
  const text = stripLeadingComments(sql);
  if (!text) return null;
  const head = text.toLowerCase();

  if (/^drop\s/i.test(head)) return "drop";
  if (/^truncate\s/i.test(head)) return "truncate";
  // `DELETE t FROM t JOIN ...` 这种 MySQL 写法也一并覆盖：只要以 delete 开头且
  // 没有 WHERE，就是整表级别的删除。
  if (/^delete\s/i.test(head) && !hasTopLevelWhere(text)) return "delete-all";
  return null;
}

/** 挑出需要用户二次确认的语句（保持原顺序）。 */
export function detectDestructive(statements: readonly string[]): DestructiveStatement[] {
  const risky: DestructiveStatement[] = [];
  for (const raw of statements) {
    const kind = classify(raw);
    if (kind) {
      risky.push({ statement: raw.trim().replace(/;\s*$/, ""), kind });
    }
  }
  return risky;
}

/** 弹窗里的短标签：纯 ASCII，界面语言切换时也不会出现中英混排。 */
export const DESTRUCTIVE_LABEL: Record<DestructiveKind, string> = {
  drop: "DROP",
  truncate: "TRUNCATE",
  "delete-all": "DELETE",
};

/** 弹窗里每条语句只占一行：折叠空白 + 截断，长 SQL 不撑破弹窗。 */
export function shortSql(sql: string, max = 110): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}
