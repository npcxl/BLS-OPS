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

/** 步骤状态（与 `DeployStep` 的 state 对齐）。 */
export type AgentStepState = "running" | "waiting" | "success" | "failed" | "skipped";

export interface AgentStep {
  index: number;
  callId: string;
  /** `run_shell` / `read_file` / `write_file` / `list_dir`。 */
  tool: string;
  /** 涉及的文件（读 / 写 / 列目录）。 */
  path?: string | null;
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
  content?: string;
  model?: string;
  context?: ContextUsage;
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
  cwd: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  /** 只有打开「完全权限」才允许 sudo。 */
  /** 这条会话选中的模型（provider id）；不传 = 默认提供方。 */
  providerId?: string | null;
  /** 思考强度；不传 = 供应商默认。 */
  reasoningEffort?: ReasoningEffort | null;
  /** 上下文输入预算（tokens）；不传 = 按模型窗口自动。 */
  contextBudget?: number | null;
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
}
