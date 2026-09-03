/**
 * 统一命令结果协议（与 Rust `output_adapter::model` 一一对应）。
 *
 * 前端**只认这个类型**：渲染完全按 `view` 分发，不需要知道命令来自
 * Docker、Nginx 还是普通 Linux 工具。新增命令不需要改前端渲染层。
 */

/** 通用 UI 视图类型（有限集合 —— 新增命令不新增视图）。 */
export type ResultView =
  | "table"
  | "key_value"
  | "metrics"
  | "log"
  | "tree"
  | "json"
  | "diff"
  | "progress"
  | "raw";

/** 数值列的阈值着色。 */
export interface ColumnThresholds {
  warn: number;
  danger: number;
}

export interface ColumnDefinition {
  /** 行数据里的字段名。 */
  key: string;
  label: string;
  /** 数值列：等宽数字 + 右对齐 + 阈值着色。 */
  numeric?: boolean;
  thresholds?: ColumnThresholds;
}

export interface SummaryItem {
  label: string;
  value: string;
  /** 语义色：success / warning / danger / accent。 */
  tone?: string;
}

/** 一个分区（docker info 这类分块输出）。 */
export interface ResultSection {
  title: string;
  view: ResultView;
  columns?: ColumnDefinition[];
  rows: Record<string, unknown>[];
}

export interface CommandMeta {
  command: string;
  exit_code: number | null;
  duration_ms: number;
  truncated: boolean;
}

export interface RawOutput {
  stdout: string;
  stderr: string;
}

export interface StructuredCommandResult {
  view: ResultView;
  title: string;
  summary: SummaryItem[];
  columns: ColumnDefinition[];
  rows: Record<string, unknown>[];
  sections: ResultSection[];
  /** 解析期提示（不是错误），如"输出不是合法 JSON"。 */
  warnings: string[];
  meta: CommandMeta;
  raw: RawOutput;
  json?: unknown;
}

/** 从未知格式的后端负载里安全取统一结果（解析失败返回 null）。 */
export function parseStructuredResult(value: unknown): StructuredCommandResult | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Partial<StructuredCommandResult>;
  if (typeof data.view !== "string" || typeof data.raw !== "object") return null;
  return {
    view: data.view as ResultView,
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
export function numericTone(value: unknown, column?: ColumnDefinition): string | null {
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
