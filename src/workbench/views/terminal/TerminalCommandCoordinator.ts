import type { StructuredCommandResult } from "@/api/ops-api";

/**
 * 终端命令协调器 —— 把**终端**与统一输出适配引擎连起来（P4 终端接线）。
 *
 * 职责：
 * 1. 命令提交时识别它是否是知识库里的命令（`match`，确定性匹配）；
 * 2. 是 → 开始捕获本次命令的 stdout/stderr/退出码；
 * 3. 输出静默 → 认为命令结束，调用 `adapt` **只解析已经产生的输出**；
 * 4. 未识别 → 完全不介入，走原始终端。
 *
 * # 绝不重复执行
 *
 * `adapt` 是纯解析（`command_adapt_output` 后端不执行任何命令）。命令只在
 * 终端里跑了一次 —— 重复执行会让 `docker ps` 跑两次，修改型命令更是危险。
 *
 * # 输出边界怎么定
 *
 * **不猜 shell 提示符**（`$`/`#` 可自定义，猜必错）。当前用**受控输出边界**：
 * 命令提交后开始收输出，输出静默 `QUIET_MS` 即认为结束，并有 `MAX_MS` 兜底
 * 上限（防止 `tail -f` 这类长流永久挂着）。
 *
 * 这是 v1 的务实选择：不改用户命令、不注入 shell、不依赖 shell 配置。
 * 后续升级为 OSC 133 Shell Integration 标记时，只需替换
 * `finish()` 的触发条件，适配协议与 UI 完全不动。
 */

/** 输出静默多久认为命令结束（ms）。 */
export const QUIET_MS = 400;
/** 捕获总时长上限（ms）：长流命令（tail -f）到此为止，不再等静默。 */
export const MAX_MS = 10_000;

export interface CapturedResult {
  id: string;
  /** 用户实际执行的命令原文。 */
  command: string;
  knowledgeId: string;
  result: StructuredCommandResult;
  at: number;
}

export interface CoordinatorDeps {
  /** 命令文本 → 知识库条目 ID；未识别返回 null。 */
  match: (text: string) => Promise<string | null>;
  /** 纯解析：把已产生的输出交给统一适配引擎。 */
  adapt: (input: {
    knowledgeId: string;
    command: string;
    stdout: string;
    exitCode: number | null;
    durationMs: number;
  }) => Promise<StructuredCommandResult>;
  /** 解析完成后回调（推入结果列表）。 */
  onResult: (result: CapturedResult) => void;
}

interface Session {
  command: string;
  knowledgeId: string | null;
  buffer: string;
  startedAt: number;
  quietTimer: number | null;
  maxTimer: number | null;
  done: boolean;
}

export class TerminalCommandCoordinator {
  private session: Session | null = null;
  private disposed = false;

  constructor(private deps: CoordinatorDeps) {}

  /**
   * 用户提交了一条命令。
   *
   * 立即开始缓冲输出（匹配是异步的，不能丢这期间的输出）；匹配不到就丢弃
   * 缓冲、完全不介入 —— 未识别命令只显示原始终端。
   */
  submit(command: string): void {
    if (this.disposed) return;
    const trimmed = command.trim();
    if (!trimmed) return;
    this.cancel();

    const session: Session = {
      command: trimmed,
      knowledgeId: null,
      buffer: "",
      startedAt: Date.now(),
      quietTimer: null,
      maxTimer: null,
      done: false,
    };
    this.session = session;

    void this.deps
      .match(trimmed)
      .then((knowledgeId) => {
        // 会话可能已被新命令或 dispose 取代。
        if (this.session !== session || this.disposed) return;
        if (!knowledgeId) {
          this.session = null; // 未识别：不介入
          return;
        }
        session.knowledgeId = knowledgeId;
        this.armTimers(session);
      })
      .catch(() => {
        if (this.session === session) this.session = null;
      });
  }

  /** 收到一段终端输出（在写进 xterm 之前调用，原样累积，不做任何加工）。 */
  onOutput(chunk: string): void {
    const session = this.session;
    if (!session || session.done) return;
    session.buffer += chunk;
    // 只有匹配成功后才启动计时器（避免匹配期间被 MAX_MS 打断）。
    if (session.knowledgeId) this.armTimers(session);
  }

  private armTimers(session: Session): void {
    if (session.done) return;
    if (session.quietTimer !== null) window.clearTimeout(session.quietTimer);
    session.quietTimer = window.setTimeout(() => this.finish(session), QUIET_MS);
    if (session.maxTimer === null) {
      session.maxTimer = window.setTimeout(() => this.finish(session), MAX_MS);
    }
  }

  private finish(session: Session): void {
    if (session.done || this.session !== session) return;
    session.done = true;
    if (session.quietTimer !== null) window.clearTimeout(session.quietTimer);
    if (session.maxTimer !== null) window.clearTimeout(session.maxTimer);
    this.session = null;

    const knowledgeId = session.knowledgeId;
    if (!knowledgeId) return;

    const durationMs = Date.now() - session.startedAt;
    void this.deps
      .adapt({
        knowledgeId,
        command: session.command,
        stdout: session.buffer,
        // 终端拿不到独立退出码（需要 shell integration），如实传 null。
        exitCode: null,
        durationMs,
      })
      .then((result) => {
        if (this.disposed) return;
        this.deps.onResult({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          command: session.command,
          knowledgeId,
          result,
          at: Date.now(),
        });
      })
      .catch(() => {
        /* 解析失败不打扰用户：终端输出已经原样显示了 */
      });
  }

  /** 放弃当前捕获（新命令提交、切换会话、卸载时用）。 */
  cancel(): void {
    const session = this.session;
    if (!session) return;
    session.done = true;
    if (session.quietTimer !== null) window.clearTimeout(session.quietTimer);
    if (session.maxTimer !== null) window.clearTimeout(session.maxTimer);
    this.session = null;
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }
}
