/**
 * 统一命令结果：类型单一事实来源在 `@/api/types/command`（与 Rust
 * `output_adapter::model` 对齐），这里只放**渲染层辅助逻辑**并转发类型，
 * 避免两处各写一份协议。
 */

import type {
  ResultColumn,
  ResultSection,
  ResultSummary,
  ResultView,
  StructuredCommandResult,
} from "@/api/ops-api";

export type {
  ResultColumn,
  ResultSection,
  ResultSummary,
  ResultView,
  StructuredCommandResult,
};

/** 协议类型别名（组件内习惯用 ColumnDefinition 等短名）。 */
export type ColumnDefinition = ResultColumn;
export type SummaryItem = ResultSummary;

/** 从未知格式的后端负载里安全取统一结果（解析失败返回 null）。 */
export function parseStructuredResult(value: unknown): StructuredCommandResult | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Partial<StructuredCommandResult>;
  if (typeof data.view !== "string" || typeof data.raw !== "object") return null;
  return {
    view: data.view,
    title: data.title ?? "",
    summary: data.summary ?? [],
    columns: data.columns ?? [],
    rows: data.rows ?? [],
    sections: data.sections ?? [],
    warnings: data.warnings ?? [],
    meta: data.meta ?? { command: "", exit_code: null, duration_ms: 0, truncated: false },
    raw: data.raw,
    json: data.json,
  };
}

/**
 * 数值列取色：按阈值给 warn/danger，非数值列或无法解析返回 null。
 *
 * 只解析数字前缀（"85%" → 85），解析不出来就不着色 —— 不猜。
 */
export function numericTone(value: unknown, column?: ResultColumn): string | null {
  if (!column?.numeric || !column.thresholds) return null;
  const text = String(value ?? "").trim();
  const match = text.match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const num = Number.parseFloat(match[0]);
  if (!Number.isFinite(num)) return null;
  if (num >= column.thresholds.danger) return "text-danger";
  if (num >= column.thresholds.warn) return "text-warning";
  return null;
}

/** 摘要项的语义色 → class。 */
export const SUMMARY_TONES: Record<string, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  accent: "text-accent",
};

/** 各视图的中文名（Tab 与空状态文案用）。 */
export const VIEW_LABELS: Record<ResultView, string> = {
  table: "表格",
  key_value: "属性",
  metrics: "指标",
  log: "日志",
  tree: "树结构",
  json: "JSON",
  diff: "差异",
  progress: "进度",
  raw: "原始输出",
};
