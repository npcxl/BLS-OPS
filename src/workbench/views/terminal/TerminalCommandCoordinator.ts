import type { CommandSearchHit, Mutability, RiskLevel } from "@/api/ops-api";
import { detectJsonOutput, type DetectedJson } from "@/lib/detect-json";
import { canonicalCommand, normalizeForParsing } from "./terminal-output-clean";
import type { BoundaryEvent } from "./command-boundary";
import type { CommandPlan, CommandSource } from "./command-plan";

/**
 * 终端命令协调器 —— 只负责**边界 + 风险 + 结果组装**，不做任何文本解析。
 *
 * 终端结果 = xterm 终端快照方案：
 *
 * ```text
 * SSH 原始流 → xterm 完整解析（用户看到什么就抓什么）
 *            → marker 行号 + translateToString(true) + isWrapped 合并
 *            → renderedText（默认展示）      raw stdout → 原始输出 Tab
 * ```
 *
 * 快照的**取与合**在 TerminalView（握着 xterm 实例）；本协调器管状态机：
 *
 * 1. 命令提交（唯一入口 `submit`）→ 识别知识库（只取真实风险 / 可变性）；
 * 2. stdout / stderr 原样累积（原始留档，给"原始输出"调试视图）；
 * 3. 收到**命令边界**输出结束 → 汇合渲染快照 → 产出结果 Tab。
 *
 * **不再调用 `adapt_auto`**：结构化适配器（表格 / 键值 / 日志…）只留给
 * Docker / 服务 / 项目 / 日志等独立模块。终端结果默认是快照视图，仅当
 * 整段输出**严格**是合法 JSON / JSON Lines（每个非空行都合法，坏行即整体
 * 不识别）时才额外给一个 JSON Tab —— 绝不再猜表格。
 *
 * # 绝不重复执行
 *
 * 命令只在终端里跑了一次 —— 本协调器不执行任何命令。
 *
 * # 命令边界（不是"静默 400ms 猜结束"）
 *
 * 结束由**受控标记**（OSC 133 D）给出：命令开始 = 提交时刻；输出开始 =
 * OSC 133 C（缺失则用第一块输出）；输出结束 = OSC 133 D；退出码 = D 的
 * 参数；耗时 = 结束 − 开始。因此慢命令不会被截断、密集输出不会被腰斩。
 *
 * [`NO_MARKER_FAILSAFE_MS`] 只是**护栏**：标记始终没来（shell 不支持
 * `printf`、命令吞掉了 stdin）时兜底收场，它不是边界判定手段。
 *
 * # 渲染快照的两种来源
 *
 * - **受控结束**（OSC 133 D）：TerminalView 在写完 D 之前的文本并解析渲染
 *   完成后调用 [`provideRenderedText`] 汇合 —— 保证抓到的是**已渲染**内容；
 * - **护栏兜底**（无标记）：协调器通过 [`CoordinatorDeps.captureNow`] 主动
 *   向终端要一次当前快照。
 *
 * 若快照不可用（marker 被回滚淘汰、无实例），结果降级为清洗后的原始流并
 * 显式标记 `renderedDegraded` —— 绝不静默丢结果。
 */

/**
 * 标记迟迟不来时的兜底（ms）。
 *
 * **这不是命令边界**：正常路径由 OSC 133 D 立即结束。这里只是防止
 * 一次提交把捕获会话永久挂着（内存 + 永远不出现的结果 Tab）。
 */
export const NO_MARKER_FAILSAFE_MS = 60_000;
/** 单条命令捕获上限（超出只标记 truncated，不丢已收到的内容）。 */
export const MAX_CAPTURE_CHARS = 1_000_000;

/** 命令边界：全部来自受控标记，不是猜的。 */
export interface CommandBoundary {
  /** 命令提交时刻。 */
  commandStart: number;
  /** 输出开始（OSC 133 C；缺失则用第一块输出的时刻）。 */
  outputStart: number | null;
  /** 输出结束（OSC 133 D）。 */
  outputEnd: number | null;
  /** 退出码（OSC 133 D 的参数）。 */
  exitCode: number | null;
  /** 输出结束 − 命令开始。 */
  durationMs: number;
  /** 结束是如何判定的（诊断用，可见）。 */
  endedBy: "marker" | "failsafe" | "replaced";
}

/** 终端命令的渲染快照结果（含**真实风险** —— 禁止伪装成只读）。 */
export interface CapturedResult {
  id: string;
  /** 用户实际执行的命令原文（含 sudo / 管道等，展示用）。 */
  command: string;
  /** 知识库 id；未命中为空串。 */
  knowledgeId: string;
  at: number;
  /** 命令真实风险（来自知识库）；**未命中 = null，不猜**。 */
  risk: RiskLevel | null;
  /** 可变性；未命中 = `unknown`。 */
  mutability: Mutability | "unknown";
  /** 终端里用户敲过的命令永远可重跑（风险门控另说）。 */
  canExecute: boolean;
  source: CommandSource;
  boundary: CommandBoundary;
  /** 原始 stdout（含命令回显 / 提示符等，标记已剔除）—— 原始输出调试视图。 */
  stdout: string;
  /** 原始 stderr（与 stdout 分开累积、独立解码）。 */
  stderr: string;
  /**
   * 严格 JSON 检测结果（数据完整）：整段输出 trim 后整体合法 JSON，或
   * JSONL 每个非空行都合法 —— 任一行坏即 `null`，绝无“部分解析成功”。
   * 只决定结果面板多不多一个 JSON Tab，终端输出本身不受影响。
   */
  json: DetectedJson | null;
  /**
   * **已渲染文本**：从 xterm buffer（`translateToString(true)` +
   * `line.isWrapped` 合并软换行）提取的结果区域 —— 结果面板**默认**展示。
   * `null` = 快照不可用时的降级文本（见 `renderedDegraded`）。
   */
  renderedText: string | null;
  /**
   * `true` = 渲染快照不可用，`renderedText` 是对原始流做清洗的结果
   * （不能还原终端软换行），面板显示"已降级"提示 —— 绝不伪装成快照。
   */
  renderedDegraded: boolean;
}

export interface RenderOutcome {
  /**
   * 从 xterm buffer 提取的文本；`null` = 本次没有可用的渲染快照
   * （无 marker / marker 被淘汰），由协调器降级。
   */
  text: string | null;
}

export interface CoordinatorDeps {
  /** 规范化命令文本 → 知识库命中；未识别返回 null（只用于风险门控）。 */
  match: (text: string) => Promise<CommandSearchHit | null>;
  /** 渲染结果 Tab。 */
  onResult: (result: CapturedResult) => void;
  /**
   * 立即抓一次当前快照（**护栏兜底**路径用：标记始终没来，协调器主动收）。
   * 缺省 = 直接降级。
   */
  captureNow?: () => RenderOutcome | Promise<RenderOutcome>;
  /** 当前时间（测试可注入）。 */
  now?: () => number;
}

interface Session {
  /** 用户实际执行的命令原文。 */
  command: string;
  source: CommandSource;
  /** 清洗后的命令（去 sudo / 截管道），用于知识库匹配。 */
  canonical: string;
  knowledgeId: string | null;
  hit: CommandSearchHit | null;
  /** **原始** stdout（真实留档，给原始输出调试视图）。 */
  stdout: string;
  /** **原始** stderr（与 stdout 分开累积）。 */
  stderr: string;
  boundary: Omit<CommandBoundary, "durationMs">;
  truncated: boolean;
  /** 异步 match 还没回来 —— 标记已到时要等它，别丢风险信息。 */
  matchPending: boolean;
  /** 输出结束（受控或兜底）后，渲染快照还没汇合。 */
  renderPending: boolean;
  renderedText: string | null;
  renderedDegraded: boolean;
  failsafe: number | null;
  /** 已收尾（标记/兜底）或已作废。 */
  done: boolean;
  /** 已产出（防重复 emit）。 */
  emitted: boolean;
  /**
   * 被新命令提交 / dispose 作废。
   *
   * 与"已收尾但还在等 match"区分开：收尾后 `this.session` 已被置空，
   * 若只靠 `this.session !== session` 判断，match 回来时会被误判成"被取代"
   * 而丢掉结果。
   */
  cancelled: boolean;
}

function nextId(now: number): string {
  return `${now}-${Math.random().toString(36).slice(2, 8)}`;
}

export class TerminalCommandCoordinator {
  private session: Session | null = null;
  /** 已收尾（marker 路径）但渲染还没汇合的会话 —— 只可能有一个。 */
  private waiter: Session | null = null;
  private disposed = false;

  constructor(private deps: CoordinatorDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * 提交一条命令（**唯一入口**）。
   *
   * `plan.capture === false`（空命令 / 交互式 / 会读 stdin 的程序）时不介入，
   * 让命令完全留在原生终端。
   */
  submit(command: string, source: CommandSource, plan: CommandPlan): void {
    if (this.disposed) return;
    const trimmed = command.trim();
    if (!trimmed || !plan.capture) return;

    // 新命令提交 → 上一条作废（它的输出已经不可能再对应到它了）。
    this.cancel();

    const now = this.now();
    const session: Session = {
      command: trimmed,
      source,
      canonical: canonicalCommand(trimmed) ?? trimmed,
      knowledgeId: null,
      hit: null,
      stdout: "",
      stderr: "",
      boundary: {
        commandStart: now,
        outputStart: null,
        outputEnd: null,
        exitCode: null,
        endedBy: "marker",
      },
      truncated: false,
      matchPending: true,
      renderPending: false,
      renderedText: null,
      renderedDegraded: false,
      failsafe: null,
      done: false,
      emitted: false,
      cancelled: false,
    };
    this.session = session;
    // 护栏：标记始终不来时兜底收场（不是边界判定，见 NO_MARKER_FAILSAFE_MS）。
    session.failsafe = window.setTimeout(() => {
      if (session.cancelled || this.session !== session) return;
      session.boundary.endedBy = "failsafe";
      this.finish(session, { viaMarker: false });
    }, NO_MARKER_FAILSAFE_MS);

    const onMatched = (resolved: CommandSearchHit | null) => {
      // 只有**作废**才丢结果；已经收尾（this.session 置空）的仍要产出。
      if (session.cancelled || this.disposed) return;
      session.hit = resolved;
      session.knowledgeId = resolved?.id ?? null;
      session.matchPending = false;
      this.tryEmit(session);
    };
    void this.deps
      .match(session.canonical)
      .then(onMatched)
      // 识别失败不阻断：按"未命中"处理（风险未知，不伪装成只读）。
      .catch(() => onMatched(null));
  }

  /**
   * 收到一段 **stdout**（在写进 xterm 之前调用，原样累积，不做任何加工）。
   * `events` 是同一块数据里解析出的命令边界事件。
   */
  onOutput(chunk: string, events: BoundaryEvent[] = []): void {
    const session = this.session;
    if (!session || session.done) return;
    if (session.stdout.length < MAX_CAPTURE_CHARS) {
      session.stdout += chunk;
      if (session.stdout.length >= MAX_CAPTURE_CHARS) session.truncated = true;
    }
    // 没有"输出开始"标记时（建议执行路径），第一块输出就是输出开始。
    if (session.boundary.outputStart === null) session.boundary.outputStart = this.now();
    this.applyEvents(session, events);
  }

  /** 收到一段 **stderr**（与 stdout 分开累积，独立解码）。 */
  onStderr(chunk: string): void {
    const session = this.session;
    if (!session || session.done) return;
    if (session.stderr.length < MAX_CAPTURE_CHARS) {
      session.stderr += chunk;
    }
  }

  /**
   * 汇合渲染快照（**受控结束**路径）：TerminalView 在写完输出结束标记之前
   * 的所有文本、确认 xterm 已解析完成后调用。
   */
  provideRenderedText(outcome: RenderOutcome): void {
    const session = this.waiter;
    this.waiter = null;
    if (!session || session.cancelled || this.disposed) return;
    this.applyRender(session, outcome);
  }

  /** 放弃当前捕获（新命令提交、切换会话、卸载时用）。 */
  cancel(): void {
    const session = this.session;
    if (!session) return;
    session.done = true;
    session.cancelled = true;
    if (session.failsafe !== null) {
      window.clearTimeout(session.failsafe);
      session.failsafe = null;
    }
    if (this.waiter === session) this.waiter = null;
    this.session = null;
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private applyEvents(session: Session, events: BoundaryEvent[]): void {
    for (const event of events) {
      if (event.type === "output_start") {
        session.boundary.outputStart = this.now();
        continue;
      }
      if (event.type === "output_end") {
        session.boundary.outputEnd = this.now();
        session.boundary.exitCode = event.exitCode;
        this.finish(session, { viaMarker: true });
        return;
      }
    }
  }

  private finish(session: Session, options: { viaMarker: boolean }): void {
    if (this.session !== session) return;
    session.done = true;
    if (session.failsafe !== null) {
      window.clearTimeout(session.failsafe);
      session.failsafe = null;
    }
    this.session = null;
    session.renderPending = true;
    if (options.viaMarker) {
      // 渲染由 TerminalView 在写完 D 之前的文本后提供（见 provideRenderedText）。
      this.waiter = session;
      this.tryEmit(session);
      return;
    }
    // 护栏兜底：协调器主动向终端要快照。
    void this.captureNow(session);
  }

  private async captureNow(session: Session): Promise<void> {
    let outcome: RenderOutcome = { text: null };
    if (this.deps.captureNow) {
      try {
        outcome = await this.deps.captureNow();
      } catch {
        // 抓不到就降级，不抛。
      }
    }
    if (session.cancelled || this.disposed) return;
    this.applyRender(session, outcome);
  }

  private applyRender(session: Session, outcome: RenderOutcome): void {
    session.renderedText = outcome.text ?? null;
    session.renderedDegraded = outcome.text === null;
    session.renderPending = false;
    this.tryEmit(session);
  }

  private tryEmit(session: Session): void {
    if (session.cancelled || this.disposed || session.emitted) return;
    // 还没收尾（done）就不能产出：慢命令正在输出时 match 先回来，若这里
    // 放行会把"进行中的命令"当成"已完成"提前交付一个空/降级结果。
    if (!session.done || session.matchPending || session.renderPending) return;
    session.emitted = true;
    this.emit(session);
  }

  private emit(session: Session): void {
    const end = session.boundary.outputEnd ?? this.now();
    const durationMs = Math.max(0, end - session.boundary.commandStart);
    const rawOutput = session.stdout;
    // 快照不可用 → 降级为对原始流的清洗结果，并显式标记（不伪装成快照）。
    const degraded =
      session.renderedText === null || session.renderedDegraded
        ? normalizeForParsing(rawOutput, session.command)
        : null;
    const renderedText = session.renderedText ?? degraded ?? "";
    // 严格 JSON 检测：坏行 → null，只决定结果面板 JSON Tab 出不出来。
    const json = session.truncated ? null : detectJsonOutput(renderedText, session.command);
    const at = this.now();
    this.deps.onResult({
      id: nextId(at),
      command: session.command,
      knowledgeId: session.knowledgeId ?? "",
      at,
      // 知识库没命中 → null：绝不把未知命令伪装成只读。
      risk: session.hit?.risk ?? null,
      mutability: session.hit?.mutability ?? "unknown",
      canExecute: true,
      source: session.source,
      boundary: { ...session.boundary, durationMs },
      stdout: rawOutput,
      stderr: session.stderr,
      json,
      renderedText,
      renderedDegraded: degraded !== null,
    });
  }
}
