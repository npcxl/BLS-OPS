/**
 * P4 命令智能中心类型（与 Rust `command_center::model` / commands 对齐）。
 *
 * 安全契约：前端只传 `knowledgeId` + 结构化参数；命令字符串由后端白名单
 * 生成并在结果里如实回显（`command_executed`）。
 */

/** 风险等级（readonly 可直接执行；medium 需确认；high/destructive 第一批不收录）。 */
export type RiskLevel = "read_only" | "low" | "medium" | "high" | "destructive";

/** 可变性。 */
export type Mutability = "read" | "change" | "delete";

/** 一级分类（UI 分组固定，产品无限扩展）。 */
export type CommandCategory =
  | "system"
  | "process"
  | "service"
  | "container"
  | "gateway"
  | "vcs"
  | "database";

/** 检索命中（提示面板的一行）。 */
export interface CommandSearchHit {
  id: string;
  executable: string;
  subcommand: string;
  title: string;
  description: string;
  category: CommandCategory;
  /** 展示语法（可能与实际执行命令不同，执行结果里有真实命令）。 */
  syntax: string;
  risk: RiskLevel;
  mutability: Mutability;
  /** 输出适配器（决定结构化视图渲染方式）。 */
  output_adapter: string;
  /** 需要服务器上存在的工具（空 = 系统自带）。 */
  requires: string[];
  /** 执行前必须提供的参数名（container / unit / path）。 */
  required_params: string[];
  /**
   * 展示语法里未替换的占位符（`journalctl -u <unit>` → `["unit"]`）。
   * **非空 = 禁止直接写进 shell**：`<unit>` 会被 bash 当成输入重定向，
   * 必须先替换成服务器上真实存在的取值。
   */
  placeholders: string[];
  /** 是否可直接执行。 */
  can_execute: boolean;
  /** 是否已收藏。 */
  favorite: boolean;
  /** 综合得分（调试用）。 */
  score: number;
}

/** 结构化执行参数（字段内容会经过后端白名单校验）。 */
export interface CommandParams {
  container?: string;
  unit?: string;
  /** 绝对路径（git -C）。 */
  path?: string;
  lines?: number;
}

/** 原始输出（永久保留；结构化只是第二种视图）。 */
export interface CommandRawOutput {
  /** 实际执行的命令（与展示语法可能不同）。 */
  command_executed: string;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

/** docker-container-table 结构化数据。 */
export interface DockerContainerRow {
  id: string;
  short_id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  created_at: string;
}

/** systemd-unit-table：一行服务。 */
export interface SystemdUnitRow {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
}

/** journal-log-viewer：一条日志（level = journald PRIORITY，0-7）。 */
export interface JournalEntryRow {
  timestamp: string;
  unit: string;
  level: string;
  message: string;
}

/** nginx-config-tree：一个站点块。 */
export interface NginxSiteRow {
  server_name: string;
  listen_ports: number[];
  root?: string | null;
  proxy_targets: string[];
  config_file?: string | null;
}

/** process-table：一行进程。 */
export interface ProcessRow {
  pid: string;
  comm: string;
  etimes: string;
  pcpu: string;
  pmem: string;
}

/** disk-usage-table：一行文件系统。 */
export interface DiskRow {
  filesystem: string;
  size: string;
  used: string;
  avail: string;
  use_percent: string;
  mounted_on: string;
}

/** port-listener-table：一行监听。 */
export interface ListenerRow {
  local: string;
  port: string;
  pid: string;
  process: string;
}

export interface CommandStructuredOutput {
  adapter: string;
  containers?: DockerContainerRow[];
  units?: SystemdUnitRow[];
  entries?: JournalEntryRow[];
  sites?: NginxSiteRow[];
  processes?: ProcessRow[];
  filesystems?: DiskRow[];
  listeners?: ListenerRow[];
}

/** 一次执行的完整结果。 */
export interface CommandExecutionResult {
  knowledge_id: string;
  title: string;
  risk: RiskLevel;
  raw: CommandRawOutput;
  structured: CommandStructuredOutput | null;
}

/** 知识库元信息。 */
export interface CommandCatalogMeta {
  total: number;
  executable: number;
  /** [categoryId, label, count] */
  categories: [string, string, number][];
}

/** 风险等级的 UI 标签与配色。 */
export const RISK_META: Record<RiskLevel, { label: string; tone: string }> = {
  read_only: { label: "只读", tone: "bg-success/12 text-success" },
  low: { label: "低风险", tone: "bg-warning/12 text-warning" },
  medium: { label: "需确认", tone: "bg-warning/15 text-warning" },
  high: { label: "高风险", tone: "bg-danger/15 text-danger" },
  destructive: { label: "删除", tone: "bg-danger/20 text-danger" },
};

/** 可变性标签。 */
export const MUTABILITY_LABELS: Record<Mutability, string> = {
  read: "读取",
  change: "会修改服务器",
  delete: "会删除数据",
};
