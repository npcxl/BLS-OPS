import type { CommandSearchHit, Mutability, RiskLevel, StructuredCommandResult } from "@/api/ops-api";
import { canonicalCommand, normalizeForParsing } from "./terminal-output-clean";
import type { BoundaryEvent } from "./command-boundary";
import type { CommandPlan, CommandSource } from "./command-plan";

/**
 * 终端命令协调器 —— 把**终端**与统一输出适配引擎连起来（P4 终端接线）。
 *
 * 职责：
 * 1. 命令提交（唯一入口 `submit`）→ 识别它是不是知识库里的命令；
 * 2. 开始捕获本次命令的输出（**双缓冲**：raw 给原始输出 Tab，
 *    normalized 清洗后给适配器解析；stdout 与 stderr 分开累积）；
 * 3. 收到**命令边界**的"输出结束"标记 → 调用 `adapt_auto` 解析；
 * 4. 产出结构化结果 Tab。
 *
 * # 绝不重复执行
 *
 * `adapt` 是纯解析（`command_adapt_output` 后端不执行命令）。命令只在
 * 终端里跑了一次 —— 重复执行会让 `docker ps` 跑两次，修改型命令更危险。
 *
 * # 命令边界（不是"静默 400ms 猜结束"）
 *
 * 结束由**受控标记**（OSC 133 D）给出，五个量都是测出来的：
 * 命令开始 = 提交时刻；输出开始 = OSC 133 C（缺失则用第一块输出）；
 * 输出结束 = OSC 133 D；退出码 = D 的参数；耗时 = 结束 − 开始。
 * 因此：
 * - 慢命令（分两批输出 / 超过 10 秒）**不会被截断**；
 * - 输出密集的长任务不会被超时腰斩。
 *
 * [`NO_MARKER_FAILSAFE_MS`] 只是**护栏**：标记始终没来（shell 不支持
 * `printf`、命令吞掉了 stdin）时兜底收场，它不是边界判定手段。
 *
 * # 未命中知识库也要出结果
 *
 * 知识库只用于**风险门控**和"专用适配器 hint"。没命中不代表不能结构化 ——
 * 输出照常走 `adapt_auto`（表格 / JSON / 键值…都能自动识别）。此时
 * `risk = null`、`mutability = "unknown"`，**绝不伪装成只读**。
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

/** 终端命令的结构化结果（含**真实风险** —— 禁止伪装成只读）。 */
export interface CapturedResult {
  id: string;
  /** 用户实际执行的命令原文（含 sudo / 管道等，展示用）。 */
  command: string;
  /** 知识库 id；未命中为空串。 */
  knowledgeId: string;
  result: StructuredCommandResult;
  at: number;
  /** 命令真实风险（来自知识库）；**未命中 = null，不猜**。 */
  risk: RiskLevel | null;
  /** 可变性；未命中 = `unknown`。 */
  mutability: Mutability | "unknown";
  /** 终端里用户敲过的命令永远可重跑（风险门控另说）。 */
  canExecute: boolean;
  source: CommandSource;
  boundary: CommandBoundary;
  stdout: string;
  stderr: string;
  /**
   * **原始捕获流**（含 ANSI 控制序列、`\r`、退格等，未加工）—— 高级调试 /
   * 完整留档用，展示时必须经转义（见 RawStreamView）。
   */
  rawOutput: string;
  /**
   * **可读输出**：`normalizeForParsing(rawOutput, command)` 的结果
   * （去控制序列 / 回显 / 尾部提示符）。结果面板**默认**展示它 ——
   * 用户不该看到 `ESC[?2004l` 这类控制字符。
   */
  readableOutput: string;
}

export interface AdaptInput {
  knowledgeId: string | null;
  adapterHint: string | null;
  command: string;
  stdout: string;
  stderr: string;
  normalized: string;
  exitCode: number | null;
  durationMs: number;
  truncated: boolean;
}

export interface CoordinatorDeps {
  /** 规范化命令文本 → 知识库命中；未识别返回 null。 */
  match: (text: string) => Promise<CommandSearchHit | null>;
  /** 纯解析：raw 与 normalized 分开传（两份数据严格分开）。 */
  adapt: (input: AdaptInput) => Promise<StructuredCommandResult>;
  /** 解析完成后回调（推入结果列表）。 */
  onResult: (result: CapturedResult) => void;
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
  adapterHint: string | null;
  hit: CommandSearchHit | null;
  /** **原始** stdout（真实留档，给原始输出 Tab）。 */
  stdout: string;
  /** **原始** stderr（与 stdout 分开累积）。 */
  stderr: string;
  boundary: Omit<CommandBoundary, "durationMs">;
  truncated: boolean;
  /** 异步 match 还没回来 —— 标记已到时要等它，别丢风险信息。 */
  matchPending: boolean;
  failsafe: number | null;
  /** 已收尾（标记/兜底）或已作废。 */
  done: boolean;
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
      adapterHint: null,
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
      failsafe: null,
      done: false,
      cancelled: false,
    };
    this.session = session;
    // 护栏：标记始终不来时兜底收场（不是边界判定，见 NO_MARKER_FAILSAFE_MS）。
    session.failsafe = window.setTimeout(() => {
      if (session.cancelled || this.session !== session) return;
      session.boundary.endedBy = "failsafe";
      this.finish(session);
    }, NO_MARKER_FAILSAFE_MS);

    const onMatched = (resolved: CommandSearchHit | null) => {
      // 只有**作废**才丢结果；已经收尾（this.session 置空）的仍要产出。
      if (session.cancelled || this.disposed) return;
      session.hit = resolved;
      session.knowledgeId = resolved?.id ?? null;
      session.adapterHint = resolved?.output_adapter ?? null;
      session.matchPending = false;
      // 标记已经在等 match 了 → 现在产出结果。
      if (session.done) this.emit(session);
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

  private applyEvents(session: Session, events: BoundaryEvent[]): void {
    for (const event of events) {
      if (event.type === "output_start") {
        session.boundary.outputStart = this.now();
        continue;
      }
      if (event.type === "output_end") {
        session.boundary.outputEnd = this.now();
        session.boundary.exitCode = event.exitCode;
        this.finish(session);
        return;
      }
    }
  }

  private finish(session: Session): void {
    if (this.session !== session) return;
    session.done = true;
    if (session.failsafe !== null) {
      window.clearTimeout(session.failsafe);
      session.failsafe = null;
    }
    this.session = null;
    // match 还没回来：等它（风险信息不能丢），回来后再产出。
    if (session.matchPending) return;
    this.emit(session);
  }

  private emit(session: Session): void {
    const end = session.boundary.outputEnd ?? this.now();
    const durationMs = Math.max(0, end - session.boundary.commandStart);
    // 双缓冲：rawOutput 原始流留档（含 ESC 控制序列），readableOutput 给解析器
    // 同时是结果面板**默认展示**的可读文本（去 ANSI / 回显 / 提示符）。
    const rawOutput = session.stdout;
    const readableOutput = normalizeForParsing(rawOutput, session.command);
    void this.deps
      .adapt({
        knowledgeId: session.knowledgeId,
        adapterHint: session.adapterHint,
        command: session.command,
        stdout: rawOutput,
        stderr: session.stderr,
        normalized: readableOutput,
        exitCode: session.boundary.exitCode,
        durationMs,
        truncated: session.truncated,
      })
      .then((result) => {
        if (this.disposed) return;
        const at = this.now();
        this.deps.onResult({
          id: nextId(at),
          command: session.command,
          knowledgeId: session.knowledgeId ?? "",
          result,
          at,
          // 知识库没命中 → null：绝不把未知命令伪装成只读。
          risk: session.hit?.risk ?? null,
          mutability: session.hit?.mutability ?? "unknown",
          canExecute: true,
          source: session.source,
          boundary: { ...session.boundary, durationMs },
          stdout: rawOutput,
          stderr: session.stderr,
          rawOutput,
          readableOutput,
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
    session.cancelled = true;
    if (session.failsafe !== null) {
      window.clearTimeout(session.failsafe);
      session.failsafe = null;
    }
    this.session = null;
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }
}
