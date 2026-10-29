/**
 * SQL 结果面板的「消息 / 摘要」文本。
 *
 * 抽成纯函数是为了可测试：这里最容易出错的地方是**把错误当成功**、
 * 把 DML 的影响行数写成返回行数，以及多语句时把总耗时算成单条耗时。
 */
import type { TFunction } from "i18next";
import type { DbColumn, DbErrorInfo } from "@/api/types/database";

/** 只取渲染需要的字段，store 里的完整结果集可以直接传入。 */
export interface StatementResultLike {
  key: string;
  statement: string;
  columns: DbColumn[];
  affectedRows: number;
  lastInsertId: string | null;
  warnings: number;
  info: string;
  elapsedMs: number;
  receivedRows: number;
  truncated: boolean;
  error: DbErrorInfo | null;
}

export interface SummaryRow {
  key: string;
  index: number;
  ok: boolean;
  status: string;
  counts: string;
  elapsed: string;
  statement: string;
  error: string;
}

/** DBeaver 风格：0.004s。比 `4 ms` 更容易一眼比出量级。 */
export function formatSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0.000s";
  return ms < 1000 ? `${(ms / 1000).toFixed(3)}s` : `${(ms / 1000).toFixed(2)}s`;
}

/** 语句只显示第一行非空内容，长 SQL 用省略号收掉。 */
export function statementLine(sql: string, max = 120): string {
  const line =
    sql
      .split("\n")
      .map((item) => item.trim())
      .find((item) => item.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** 消息页：每个语句一段（语句 → 结果/错误 → 耗时），末尾一行总耗时。 */
export function buildMessageLog(
  results: readonly StatementResultLike[],
  totalElapsedMs: number,
  t: TFunction,
): string {
  if (results.length === 0) return t("这次执行没有返回结果");
  const lines: string[] = [];

  results.forEach((result, index) => {
    lines.push(`[${index + 1}] ${result.statement.trim()}`);
    if (result.error) {
      lines.push(`> ${t("错误")}: ${result.error.message}`);
      if (result.error.code !== null) {
        const state = result.error.sql_state ? ` ${result.error.sql_state}` : "";
        lines.push(`> code: ${result.error.code}${state}`);
      }
      if (result.error.detail) lines.push(`> ${result.error.detail}`);
    } else if (result.columns.length > 0) {
      lines.push(`> ${t("返回 {{count}} 行", { count: result.receivedRows.toLocaleString() })}`);
    } else {
      lines.push(`> ${t("影响 {{count}} 行", { count: result.affectedRows.toLocaleString() })}`);
      if (result.lastInsertId) lines.push(`> last_insert_id = ${result.lastInsertId}`);
      if (result.info) lines.push(`> ${result.info}`);
    }
    if (result.warnings > 0) {
      lines.push(`> ${t("警告 {{count}} 条", { count: result.warnings })}`);
    }
    if (result.truncated) lines.push(`> ${t("结果已截断")}`);
    lines.push(`> ${t("查询时间")}: ${formatSeconds(result.elapsedMs)}`);
    lines.push("");
  });

  lines.push(
    `> ${t("总耗时")}: ${formatSeconds(totalElapsedMs)} · ${t("共 {{count}} 个结果", {
      count: results.length,
    })}`,
  );
  return lines.join("\n");
}

/** 摘要页：一行一个结果集，「行数」列要区分 SELECT 的返回行与 DML 的影响行。 */
export function buildSummaryRows(
  results: readonly StatementResultLike[],
  t: TFunction,
): SummaryRow[] {
  return results.map((result, index) => ({
    key: result.key,
    index: index + 1,
    ok: !result.error,
    status: result.error ? t("失败") : t("成功"),
    counts:
      result.columns.length > 0
        ? t("返回 {{count}} 行", { count: result.receivedRows.toLocaleString() })
        : t("影响 {{count}} 行", { count: result.affectedRows.toLocaleString() }),
    elapsed: formatSeconds(result.elapsedMs),
    statement: statementLine(result.statement),
    error: result.error?.message ?? "",
  }));
}

/** 摘要页的复制内容：TSV，粘进 Excel 就是一张表。 */
export function buildSummaryTsv(rows: readonly SummaryRow[], t: TFunction): string {
  return [
    ["#", t("状态"), t("行数"), t("耗时"), t("语句")].join("\t"),
    ...rows.map((row) =>
      [row.index, row.status, row.counts, row.elapsed, row.statement].join("\t"),
    ),
  ].join("\n");
}
