import type { CommandSearchHit, RiskLevel, StructuredCommandResult } from "@/api/ops-api";
import { canonicalCommand, normalizeForParsing } from "./terminal-output-clean";

/**
 * 终端命令协调器 —— 把**终端**与统一输出适配引擎连起来（P4 终端接线）。
 *
 * 职责：
 * 1. 命令提交时识别它是否是知识库里的命令（`match`，两级匹配）；
 * 2. 是 → 开始捕获本次命令的输出（**双缓冲**：raw 给原始输出 Tab，
 *    normalized 清洗后给适配器解析）；
 * 3. 输出静默 → 认为命令结束，调用 `adapt` **只解析已经产生的输出**；
 * 4. 未识别 / 管道命令 / 交互式命令 → 完全不介入，走原始终端。
 *
 * # 绝不重复执行
 *
 * `adapt` 是纯解析（`command_adapt_output` 后端不执行任何命令）。命令只在
 * 终端里跑了一次 —— 重复执行会让 `docker ps` 跑两次，修改型命令更是危险。
 *
 * # 不匹配的命令（绝不介入）
 *
 * - **管道 / 链式命令**（`df -h | grep`）：grep/awk 会改变输出结构，
 *   沿用原适配器会解析出错误表格；
 * - **交互式全屏程序**（vim / top / less / htop）：alternate screen 的
 *   内容不是可解析文本；
 * - 空命令、匹配不到知识库的命令。
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

/** 交互式全屏程序：alternate screen 内容不可解析，绝不介入。 */
const INTERACTIVE = new Set([
  "vim",
  "vi",
  "nano",
  "top",
  "htop",
  "less",
  "more",
  "watch",
  "exit",
  "clear",
  "ssh",
  "mysql",
  "psql",
  "redis-cli",
]);

/** 终端命令的结构化结果（含**真实风险** —— 禁止伪装成只读）。 */
export interface CapturedResult {
  id: string;
  /** 用户实际执行的命令原文（含 sudo / 管道等，展示用）。 */
  command: string;
  knowledgeId: string;
  result: StructuredCommandResult;
  at: number;
  /** 命令真实风险（来自知识库，后端 match 返回）。 */
  risk: RiskLevel;
  mutability: "read" | "change" | "delete";
  /** 知识库是否提供执行（重运行门控用）。 */
  canExecute: boolean;
}

export interface CoordinatorDeps {
  /** 规范化命令文本 → 知识库命中；未识别返回 null。 */
  match: (text: string) => Promise<CommandSearchHit | null>;
  /** 纯解析：raw 与 normalized 分开传（两份数据严格分开）。 */
  adapt: (input: {
    knowledgeId: string;
    command: string;
    stdout: string;
    normalized: string;
    exitCode: number | null;
    durationMs: number;
  }) => Promise<StructuredCommandResult>;
  /** 解析完成后回调（推入结果列表）。 */
  onResult: (result: CapturedResult) => void;
}

interface Session {
  /** 用户实际执行的命令原文。 */
  command: string;
  /** 清洗后的命令（去 sudo / 截管道），用于知识库匹配。 */
  canonical: string;
  knowledgeId: string | null;
  /** 匹配命中的完整信息（风险门控用）。 */
  hit: CommandSearchHit | null;
  /** **原始**终端输出（真实留档，给原始输出 Tab）。 */
  rawBuffer: string;
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
   * 管道 / 交互式 / 空命令不介入；其余先缓冲输出（匹配是异步的，不能丢
   * 这期间的输出），匹配不到就丢弃缓冲、完全不介入。
   */
  submit(command: string): void {
    if (this.disposed) return;
    const trimmed = command.trim();
    if (!trimmed) return;

    // 标准化：去前导 sudo、截取管道之前的**主命令**（grep 只过滤行，
    // 不改列结构 → 沿用原适配器仍然正确；awk -F 那种重组属于少数，
    // 且原始输出 Tab 永远留档）。纯管道（无主命令）→ 不介入。
    const canonical = canonicalCommand(trimmed);
    if (!canonical) return;
    // 交互式全屏程序：alternate screen 内容不可解析。
    const head = canonical.split(" ")[0].toLowerCase();
    if (INTERACTIVE.has(head)) return;

    this.cancel();
    const session: Session = {
      command: trimmed,
      canonical,
      knowledgeId: null,
      hit: null,
      rawBuffer: "",
      startedAt: Date.now(),
      quietTimer: null,
      maxTimer: null,
      done: false,
    };
    this.session = session;

    void this.deps
      .match(canonical)
      .then((hit) => {
        // 会话可能已被新命令或 dispose 取代。
        if (this.session !== session || this.disposed) return;
        if (!hit) {
          this.session = null; // 未识别：不介入
          return;
        }
        session.hit = hit;
        session.knowledgeId = hit.id;
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
    session.rawBuffer += chunk;
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

    const hit = session.hit;
    if (!session.hit || !hit) return;

    const durationMs = Date.now() - session.startedAt;
    // 双缓冲：raw 留档，normalized 给解析器（去 ANSI / 回显 / 提示符）。
    const normalized = normalizeForParsing(session.rawBuffer, session.command);
    void this.deps
      .adapt({
        knowledgeId: session.knowledgeId as string,
        command: session.command,
        stdout: session.rawBuffer,
        normalized,
        exitCode: null,
        durationMs,
      })
      .then((result) => {
        if (this.disposed) return;
        this.deps.onResult({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          command: session.command,
          knowledgeId: hit.id,
          result,
          at: Date.now(),
          risk: hit.risk,
          mutability: hit.mutability,
          canExecute: hit.can_execute,
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
