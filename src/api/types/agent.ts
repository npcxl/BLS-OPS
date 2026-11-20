/**
 * 超能 Agent 的协议类型。
 *
 * 与 Rust 侧 `agent::protocol` / `agent::state` 一一对应（camelCase）：
 * * `AgentStep`  —— 一次工具执行（命令、真实输出、cwd、备份路径）；
 * * `AgentEvent` —— 后端推送的增量（`agent-event`）；
 * * `AgentSnapshot` —— 当前完整状态（重进 / 轮询时恢复卡片）。
 *
 * 前端**不传命令字符串**给后端：只传对话与 taskId，工具调用完全由模型在
 * Rust 侧解析与执行。这里没有任何"执行任意命令"的入口。
 */

/**
 * 风险等级：`read` 自动执行；`write` / `danger` 在普通权限下确认、完全权限下直接执行。
 * 只查询的任务里后两者会被执行器直接拦下。
 */
export type AgentToolRisk = "read" | "write" | "danger";

/** 运行状态。`waiting` = 正在等用户确认某一步。 */
export type AgentRunStatus = "running" | "waiting" | "success" | "failed" | "cancelled";

/**
 * 任务结论的验证等级。
 *
 * 由后端按**真实步骤**判定：`verified` 有服务器证据（改后有只读验证）；
 * `partial` 只完成了一部分（改完没验证 / 最后一次失败）；`needs_info` 没有任何
 * 可核对的服务器结果。
 */
export type AgentOutcomeLevel = "verified" | "partial" | "needs_info";

export interface AgentOutcome {
  level: AgentOutcomeLevel | string;
  reason: string;
  /** 支撑结论的证据（命令 / 路径 + 步骤序号）。 */
  evidence: string[];
}

/** 步骤状态（与 `DeployStep` 的 state 对齐）。 */
export type AgentStepState = "running" | "waiting" | "success" | "failed" | "skipped";

export interface AgentStep {
  index: number;
  callId: string;
  /** `run_shell` / `read_file` / `write_file` / `list_dir`。 */
  tool: string;
  /** 涉及的文件（读 / 写 / 列目录）。 */
  path?: string | null;
  /** 这条步骤的文件变更记录（只有 `write_file` 带）。 */
  changeId?: string | null;
  risk: AgentToolRisk;
  state: AgentStepState | string;
  /** 用户可读的命令（没有 `cd` 包装与内部标记）。 */
  command: string;
  /** 实际执行脚本（含 `cd` / 退出码回传 / 内部标记），只在调试详情里展开。 */
  script?: string | null;
  /** 一句话操作摘要，例如「更新 Nginx 配置」。 */
  summary?: string | null;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  cwd: string;
  truncated: boolean;
  backupPath?: string | null;
  rollback?: string | null;
  impact?: string | null;
  elapsedMs: number;
}

/** 正在等用户确认的那一条（快照里带出来，刷新/重进后仍能继续确认）。 */
export interface PendingApproval {
  callId: string;
  stepIndex: number;
  tool: string;
  path?: string | null;
  risk: AgentToolRisk;
  /** 用户可读的命令。 */
  command: string;
  /** 实际执行脚本（调试用）。 */
  script?: string | null;
  /** 一句话操作摘要。 */
  summary?: string | null;
  impact?: string | null;
  /** 写文件的备份路径与回滚命令：确认前就能核对。 */
  backupPath?: string | null;
  rollback?: string | null;
  /** 待确认预览的变更记录：确认卡据此打开「查看变更」。 */
  changeId?: string | null;
  cwd: string;
  /**
   * 等待确认的截止时刻（毫秒时间戳）。旧后端/旧快照可能没有：
   * 前端按"收到时刻 + 5min"兜底显示，绝不显示 NaN。
   */
  deadline?: number;
}

/** 一次上下文裁剪的结果：L1 瘦身 / L2 折叠 / L3 丢弃各处理了多少。 */
export interface PruneReport {
  beforeTokens: number;
  afterTokens: number;
  /** L1 瘦身掉的旧工具结果条数。 */
  slimmed: number;
  /** L2 折叠进 system 摘要的早期单元数。 */
  folded: number;
  /** L3 丢弃的单元数。 */
  droppedUnits: number;
}

/** 本任务累计用量：每次模型请求相加（同一段历史会重复计入）。 */
export interface TokenUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

/** 最近一次请求的构成（token）。 */
export interface ContextBreakdown {
  system: number;
  history: number;
  tools: number;
}

/** 最近一轮的上下文用量（裁剪后真正发给模型的估算 token）。 */
export interface ContextUsage {
  budget: number;
  used: number;
  report: PruneReport;
  /** 本任务累计（跨多次请求相加）。 */
  cumulative: TokenUsage;
  /** 最近一次请求的构成。 */
  breakdown: ContextBreakdown;
  /** 用户目标：最后一条真人用户消息的首行。 */
  goal: string;
  /** 本任务累计执行的工具调用数。 */
  toolCalls: number;
}

export interface AgentSnapshot {
  taskId: string;
  status: AgentRunStatus | string;
  model: string;
  /** 终态时的模型正文。 */
  content: string;
  error?: string | null;
  cwd: string;
  server: string;
  sessionId: string;
  steps: AgentStep[];
  /** 有值 = 这一步正在等确认，`callId` 可以直接交给 `aiAgentApprove`。 */
  pendingApproval?: PendingApproval | null;
  /** 最近一轮的上下文用量；还没请求过模型时为空。 */
  context?: ContextUsage | null;
  /** 终态验证结论；没有执行过步骤时为空。 */
  outcome?: AgentOutcome | null;
  updatedAt: number;
}

export type AgentEventKind =
  /** 模型正文增量：边生成边追加到**同一条**回复气泡。 */
  | "text_delta"
  | "context_usage"
  | "tool_started"
  | "tool_output"
  | "tool_finished"
  | "approval_required"
  /** 文件变更记录新增 / 状态变化（只带摘要，正文按需加载）。 */
  | "file_change"
  | "approval_withdrawn"
  | "steer_applied"
  | "finished"
  | "failed"
  | "cancelled";

export interface AgentEvent {
  taskId: string;
  kind: AgentEventKind | string;
  stepIndex?: number;
  callId?: string;
  tool?: string;
  path?: string | null;
  risk?: AgentToolRisk;
  state?: AgentStepState | string;
  command?: string;
  script?: string | null;
  summary?: string | null;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  cwd?: string;
  truncated?: boolean;
  backupPath?: string | null;
  rollback?: string | null;
  impact?: string | null;
  /** 这一步对应的文件变更记录（`file_change` / 步骤事件都带）。 */
  changeId?: string | null;
  /** 变更摘要：列表与角标据此刷新，正文不在这里。 */
  change?: FileChangeSummary | null;
  content?: string;
  model?: string;
  context?: ContextUsage;
  /** 终态验证结论（只有 `finished` 且执行过步骤时带）。 */
  outcome?: AgentOutcome | null;
  message?: string;
  elapsedMs?: number;
  /** 只有 `approval_required` 带：等待确认的截止时刻（毫秒）。 */
  deadline?: number;
}

/** 思考强度（供应商原生参数；界面上的 MAX 会先映射成模型最高档）。 */
export type ReasoningEffort = "low" | "medium" | "high" | "max";

/** 启动一次 Agent 运行（工具集中定义在 Rust，前端不传命令）。 */
export interface AgentStartRequest {
  taskId: string;
  sessionId: string;
  server: string;
  /** 服务器配置 id / 对话 id：文件变更记录按它们归属。 */
  serverId?: string | null;
  workspaceId?: string | null;
  cwd: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  /** 只有打开「完全权限」才允许 sudo。 */
  /** 这条会话选中的模型（provider id）；不传 = 默认提供方。 */
  providerId?: string | null;
  /** 思考强度；不传 = 供应商默认。 */
  reasoningEffort?: ReasoningEffort | null;
  /** 上下文输入预算（tokens）；不传 = 按模型窗口自动。 */
  contextBudget?: number | null;
  /**
   * 界面语言（`zh-CN` / `en`）：后端按它写系统提示词。
   *
   * 不传 = 中文。只影响提示词语言，不改权限与审批。
   */
  locale?: string | null;
  /** 续跑同一个 taskId 时带上已知的累计用量（后端从它继续加）。 */
  carryUsage?: TokenUsage | null;
  allowSudo?: boolean;
  /**
   * 「完全权限」：修改范围内的写入 / 修改 / 删除不再逐条确认（含危险档）。
   *
   * 写文件仍然自动备份；sudo 由 `allowSudo` 单独控制；只查询任务由后端拦下写操作。
   */
  autoApproveWrites?: boolean;
  maxRounds?: number;
}

/** 从检查点恢复一条被中断的任务（历史里「继续执行」）。 */
export interface AgentResumeRequest {
  taskId: string;
  /** 当前可用的 SSH 会话；重连后和记录里的不同。 */
  sessionId: string;
  /** 归属：继续执行时新产生的变更仍挂回原来那条对话 / 服务器。 */
  serverId?: string | null;
  workspaceId?: string | null;
  providerId?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  contextBudget?: number | null;
  /** 界面语言（`zh-CN` / `en`）：恢复时同样按它写系统提示词；不传 = 中文。 */
  locale?: string | null;
  allowSudo?: boolean;
  autoApproveWrites?: boolean;
  maxRounds?: number;
}

/** 需要用户确认的一条写 / 危险操作。 */
export interface AgentApproval {
  taskId: string;
  callId: string;
  stepIndex: number;
  tool: string;
  /** 目标服务器展示名：切到别的服务器时也能看清这条命令发给谁。 */
  server: string;
  path?: string | null;
  risk: AgentToolRisk;
  /** 用户可读的命令（首屏不展开，详情里核对）。 */
  command: string;
  /** 实际执行脚本（`cd` 包装、退出码回传、内部标记都在这里）。 */
  script?: string | null;
  /** 一句话操作摘要：确认卡第一行。 */
  summary?: string | null;
  impact?: string | null;
  backupPath?: string | null;
  rollback?: string | null;
  cwd: string;
  /** 等待确认的截止时刻（毫秒）；缺失时界面按收到时刻兜底。 */
  deadline?: number;
  /** 待确认预览的变更记录（没有 Diff 时不带）。 */
  changeId?: string | null;
}

/* ---------------- 服务器文件变更审阅 ---------------- */

/**
 * 一条变更记录的状态。
 *
 * * `proposed`       —— 拟修改，等你确认；
 * * `written`        —— 已写入，并按服务器上的**回读内容**生成实际 Diff；
 * * `unchanged`      —— 写入完成，但回读内容与写入前完全一致；
 * * `write_failed`   —— 写入失败，文件没有被这次写入改动；
 * * `readback_failed`—— 写入已发送，但回读失败（无法证明实际内容）；
 * * `rejected` / `withdrawn` —— 你没有放行；
 * * `stale`          —— 确认前文件被外部修改，这份预览已作废；
 * * `uncollected`    —— 普通 shell 命令，未采集文件差异；
 * * `unavailable`    —— 读不到原文 / 目标不是普通文件，不生成假 Diff。
 */
export type FileChangeStatus =
  | "proposed"
  | "written"
  | "unchanged"
  | "write_failed"
  | "readback_failed"
  | "rejected"
  | "withdrawn"
  | "stale"
  | "uncollected"
  | "unavailable";

/** 这条记录展示哪一版内容：拟修改 / 实际回读 / 没有可展示的 Diff。 */
export type FileChangeStage = "proposed" | "actual" | "none";

/** 列表项：只带标识与摘要，正文按需用 `agentFileChangeDetail` 取。 */
export interface FileChangeSummary {
  id: string;
  taskId: string;
  callId: string;
  stepIndex: number;
  workspaceId?: string | null;
  server: string;
  serverId?: string | null;
  tool: string;
  path: string;
  status: FileChangeStatus | string;
  stage: FileChangeStage | string;
  /** 修改前不存在 = 全新增。 */
  created: boolean;
  binary: boolean;
  tooLarge: boolean;
  /** 增删行数；没有可展示的 Diff 时为 0。 */
  additions: number;
  deletions: number;
  diffReady: boolean;
  backupPath?: string | null;
  /** 备份**已验证存在**（只是计划中的备份名为 false）。 */
  backupVerified: boolean;
  /** 目标文件在最近一次回读里确认存在。 */
  canOpen: boolean;
  /** 普通 shell 之类的"未采集差异"说明项。 */
  uncollected: boolean;
  note?: string | null;
  createdAt: number;
  updatedAt: number;
}

export type DiffLineKind = "context" | "add" | "del";

export interface DiffLine {
  kind: DiffLineKind | string;
  text: string;
  /** 旧文件行号（新增行没有）。 */
  oldNo?: number | null;
  /** 新文件行号（删除行没有）。 */
  newNo?: number | null;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  /** 未修改行总数（界面据此显示「N unmodified lines」）。 */
  unchanged: number;
  tooLarge: boolean;
  note?: string | null;
}

export interface FileSnapshotView {
  exists: boolean;
  path: string;
  sha: string;
  size: number;
  binary: boolean;
  tooLarge: boolean;
  note?: string | null;
}

/** 按需加载的 Diff 正文：用的是记录当时保存的快照。 */
export interface FileChangeDetail {
  summary: FileChangeSummary;
  before?: FileSnapshotView | null;
  after?: FileSnapshotView | null;
  diff: FileDiff;
  /** 两版正文（已脱敏）：展开被折叠的未修改段时用。 */
  beforeText?: string | null;
  afterText?: string | null;
  /** 可见的限制说明（二进制 / 过大 / 脱敏 / 回读失败…）。 */
  limits: string[];
  redacted: boolean;
}
