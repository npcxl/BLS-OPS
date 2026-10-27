import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type IMarker } from "@xterm/xterm";
import { opsApi } from "@/api/ops-api";
import { sshClosedEvent, sshOutputEvent, sshStderrEvent } from "@/lib/events";
import type { SessionStatus } from "@/stores/session-store";
import type { LineEditor } from "@/lib/terminal-line-editor";
import { invalidateDirectoryCache } from "./completion/remote-listing";
import { invalidateDockerCache } from "./completion/providers/docker-resource";
import { invalidateServiceCache } from "./completion/providers/service";
import { invalidateProcessCache } from "./completion/providers/process";
import { invalidateEnvironmentCache } from "./use-server-environment";
import type { CommandBoundaryParser } from "./command-boundary";
import type { CommandSource, SubmitMode } from "./command-plan";
import type { RemoteCwdTracker } from "./remote-cwd";
import { isCommandNotFoundOutput } from "./terminal-output-clean";
import { writeOutputParts } from "./terminal-output-pipeline";
import type { Phase } from "./terminal-phase";
import { terminalTheme } from "./theme";
import type { RenderOutcome, TerminalCommandCoordinator } from "./TerminalCommandCoordinator";

/** 选中文字后多久弹出选区菜单（避免拖动过程中一直闪）。 */
const SELECTION_MENU_DELAY_MS = 450;

/** 终端里"记历史 + 提交命令"的入口（由 `TerminalView` 提供，ref 里读最新值）。 */
export interface TerminalCommandEntry {
  note: (command: string) => void;
  submit: (
    command: string,
    source: CommandSource,
    options?: { prefix?: string; mode?: SubmitMode },
  ) => void;
}

/**
 * 会话 hook 需要的一切外部依赖。
 *
 * 全是 ref / setState / 稳定回调 —— 因此 hook 内部用 `hostRef` 读**最新**
 * 的一份（xterm 实例只创建一次，它的闭包不能持有首帧的旧函数）。
 */
export interface TerminalSessionHost {
  containerRef: RefObject<HTMLDivElement | null>;
  suggestWrapperRef: RefObject<HTMLDivElement | null>;
  terminalRef: RefObject<Terminal | null>;
  fitRef: RefObject<FitAddon | null>;
  lineEditorRef: RefObject<LineEditor | null>;
  commandEntryRef: RefObject<TerminalCommandEntry>;
  boundaryParserRef: RefObject<CommandBoundaryParser | null>;
  cwdTrackerRef: RefObject<RemoteCwdTracker | null>;
  coordinatorRef: RefObject<TerminalCommandCoordinator | null>;
  captureMarkerRef: RefObject<{ marker: IMarker } | null>;
  selectionMenuTimerRef: RefObject<number | null>;
  cwdProbeTimerRef: RefObject<number | null>;
  keyHandlerRef: RefObject<(event: KeyboardEvent) => boolean>;
  sessionId: string;
  hasTarget: boolean;
  consumeTerminalSnapshot: (held: { marker: IMarker } | null) => RenderOutcome;
  updateSuggestAnchor: () => void;
  /**
   * 文件面板跟随：**只有"目录确实变了"才调用**，两个来源 ——
   * 1. OSC 7 上报值发生变化（**主**：shell 自己报的目录，不可能不存在）；
   * 2. `cd` 成功（退出码 0）的确认结果（**备**：给没有 OSC 7 的 shell）。
   * 提交那一刻的**乐观跟随**绝不能用 —— 那会把面板带到打错字 / 不存在的目录上
   * （事故：`~` 下敲 `cd opt`，shell 报 No such file，面板却跳去 `/root/opt`）。
   */
  onCwdConfirmed: (path: string) => void;
  setInAlternate: (value: boolean) => void;
  setDraft: (value: string) => void;
  setCwd: (value: string | null) => void;
  setSelectionMenu: (value: { x: number; y: number; text: string } | null) => void;
  setPhase: Dispatch<SetStateAction<Phase>>;
  setStatus: (sessionId: string, status: SessionStatus, patch?: { error?: string }) => void;
  connect: () => void;
  removeSession: (sessionId: string) => void;
}

/**
 * xterm 实例的整个生命周期：创建、主题跟随、输入输出接线、缩放、
 * 选区菜单、断开清理。
 *
 * `TerminalView` 只负责组装状态；这里握着"终端与 SSH 会话之间的管道"。
 *
 * 依赖刻意只留 `[hasTarget, sessionId, updateSuggestAnchor]`：换目标/换会话
 * 才重建实例，其余变化一律通过 `hostRef` 读到最新值，**绝不**因为父组件
 * 重渲染就重建终端（会把连接也一起拆掉）。
 */
export function useTerminalSession(host: TerminalSessionHost): void {
  const hostRef = useRef(host);
  hostRef.current = host;
  const { hasTarget, sessionId, updateSuggestAnchor } = host;

  useEffect(() => {
    const container = hostRef.current.containerRef.current;
    if (!container || !hasTarget) return;

    const isDark = document.documentElement.dataset.theme === "dark";
    // 与结果面板共用同一套等宽栈（--font-command-output 的同源变量），
    // 否则终端里的表格和结果快照里的同一份文本会对不齐。
    const terminalFont = getComputedStyle(document.documentElement)
      .getPropertyValue("--font-terminal")
      .trim();
    const instance = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: terminalFont || undefined,
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: terminalTheme(isDark),
    });
    const fit = new FitAddon();
    instance.loadAddon(fit);
    instance.open(container);
    fit.fit();
    hostRef.current.terminalRef.current = instance;
    hostRef.current.fitRef.current = fit;

    // Follow the app theme live (system theme can change while running).
    const themeObserver = new MutationObserver(() => {
      instance.options.theme = terminalTheme(document.documentElement.dataset.theme === "dark");
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    // Claim only the suggestion keys; everything else reaches the shell.
    instance.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      return !hostRef.current.keyHandlerRef.current(event);
    });

    const dataSubscription = instance.onData((data) => {
      const host = hostRef.current;
      // Full-screen programs (vim, top, less) take over the screen: the
      // "current line" is no longer a shell command, so suggestions are noise.
      // Sampled on input — entering them always involves a keystroke.
      const alternate = instance.buffer.active.type !== "normal";
      host.setInAlternate(alternate);

      // Recover whole commands from the raw stream; arrow keys, Ctrl+C, pastes
      // and line continuations are handled by the editor.
      const commands = host.lineEditorRef.current?.feed(data) ?? [];
      if (alternate) {
        void opsApi.sshInput(sessionId, data).catch(() => undefined);
        return;
      }
      // 粘贴多条命令时每条都记历史，但只捕获最后一条（它才会真正产生结果）。
      for (const command of commands) host.commandEntryRef.current.note(command);
      const submitted = commands[commands.length - 1];
      if (submitted) {
        // 唯一提交入口：命令文本就是靠 `data` 一个字符一个字符"敲"进终端的，
        // 所以按键数据必须原样发出（prefix），提交入口只追加受控标记。
        host.commandEntryRef.current.submit(submitted, "input", { prefix: data });
      } else {
        void opsApi.sshInput(sessionId, data).catch(() => undefined);
      }
      // A submitted line (or Ctrl+C, which the editor abandons) clears the
      // draft, which in turn hides the suggestion layer.
      host.setDraft(commands.length > 0 ? "" : (host.lineEditorRef.current?.current ?? ""));
      // 输入会移动光标 → 重算提示面板锚点。
      host.updateSuggestAnchor();
    });

    const resizeObserver = new ResizeObserver(() => {
      // While this tab is hidden (display:none) the container measures 0;
      // refitting would collapse the terminal and spam the connection with
      // resize packets. Skip until it is visible again.
      if (container.clientWidth === 0) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (instance.cols > 0 && instance.rows > 0) {
        void opsApi.sshResize(sessionId, instance.cols, instance.rows).catch(() => undefined);
      }
      // 缩放 / fit 改变单元格尺寸 → 重算锚点。
      hostRef.current.updateSuggestAnchor();
    });
    resizeObserver.observe(container);

    // 回滚缓冲滚动改变光标在视口中的行 → 重算锚点（rAF 节流）。
    const viewport = container.querySelector<HTMLElement>(".xterm-viewport");
    const onViewportScroll = () => hostRef.current.updateSuggestAnchor();
    viewport?.addEventListener("scroll", onViewportScroll, { passive: true });

    let disposed = false;
    // xterm 解析是**异步**的：instance.write(data, callback) 的 callback 在数据
    // 被解析渲染完才触发（同一实例内 FIFO，stdout/stderr 同一条队列）。快照
    // 必须排在"输出结束之前的所有写入"之后 —— 用这条链把 callback 串起来，
    // 严禁 setTimeout 猜渲染。
    let writeQueue: Promise<void> = Promise.resolve();
    const queueWrite = (text: string): Promise<void> => {
      if (!text) return writeQueue;
      // **必须等上一个 write 渲染完再启动下一个**。
      //
      // 旧写法在 `new Promise` 的 executor 里立即调用 `instance.write()`，
      // 只是把"结果"串成链 —— 100 次调用会在渲染回调一个都没回来时连续提交
      // 100 块数据，xterm 内部照样积压。现在 `instance.write` 只在上一块的
      // 渲染回调触发后才执行，队列长度始终 ≤ 1。
      const done = writeQueue
        .catch(() => undefined)
        .then(
          () =>
            new Promise<void>((resolve) => {
              instance.write(text, () => resolve());
            }),
        );
      writeQueue = done;
      return done;
    };
    /**
     * 处理一段输出：边界解析 → cwd → 协调器 → 写入 xterm。
     *
     * 从原来的 listener 回调体原样抽出，供合并后的批量处理调用。
     */
    const handleOutput = async (output: string): Promise<void> => {
      const host = hostRef.current;
      // 命令边界解析**必须**先于 xterm：剔除受控标记与注入行回显，同时把
      // OSC 133 事件按原始顺序切进 parts —— 文本写终端、事件决定快照时机。
      const parsed =
        host.boundaryParserRef.current?.feed(output) ?? {
          text: output,
          events: [],
          parts: [{ kind: "text", text: output }],
        };
      // OSC 7（shell 自己上报的 cwd）：扫**原始**输出，不受边界解析的剔除
      // 影响 —— 这是 cwd 的最可信来源（优先级 1）。
      const report = host.cwdTrackerRef.current?.feedOutput(sessionId, output) ?? {
        path: null,
        changed: null,
      };
      if (report.path) host.setCwd(report.path);
      // 权威 cwd **变了** → 文件面板跟随（主触发点）：shell 自己报的目录不可能
      // 不存在，失败的 cd 也不会改变上报值 —— 不会把面板带到错的目录。
      if (report.changed) host.onCwdConfirmed(report.changed);
      // 命令结束（OSC 133 D 带真实退出码）：`cd` 成功才更新 cwd，失败不动。
      // 这是**没有 OSC 7 时的兜底**跟随 —— 上面已经跟过的那次会把 pending
      // 作废，所以这里不会重复跟随。
      for (const event of parsed.events) {
        if (event.type === "output_end") {
          const tracker = host.cwdTrackerRef.current;
          // 返回值 = **确认成功的** cd 目标；失败 / 不是 cd → null（面板不动）。
          const confirmed = tracker?.onCommandEnd(sessionId, event.exitCode) ?? null;
          host.setCwd(tracker?.get(sessionId) ?? null);
          if (confirmed) host.onCwdConfirmed(confirmed);
        }
      }
      host.coordinatorRef.current?.onOutput(parsed.text, parsed.events);
      const notFound = isCommandNotFoundOutput(parsed.text);
      const display = (text: string) => (notFound ? `\x1b[31m命令无效：${text}\x1b[0m` : text);

      // 同步抓住本次结束对应的 marker —— 异步渲染期间可能有新命令提交。
      const heldAtEnd = host.captureMarkerRef.current;
      // 写出顺序 = 终端输出流水线（见 terminal-output-pipeline.ts）：
      // D 之前写完并渲染完 → 抓快照 → 才写 D 之后的提示符。
      await writeOutputParts(parsed.parts, {
        write: (text) => queueWrite(display(text)),
        flush: () => writeQueue.catch(() => undefined),
        capture: () =>
          host.coordinatorRef.current?.provideRenderedText(host.consumeTerminalSnapshot(heldAtEnd)),
      });
      // 远程输出（回显/补全回显）也会移动光标；顺带采样 alternate screen。
      host.setInAlternate(instance.buffer.active.type !== "normal");
      host.updateSuggestAnchor();
    };

    /**
     * 输出合并（背压）。
     *
     * 高频输出时 Rust 每收到一块就 emit 一次；前端每块都要做边界解析、cwd
     * 追踪、结果协调和 xterm 写入。把**同一轮事件循环**里的多块拼起来再处理，
     * 能显著减少解析与写入次数。
     *
     * 三条保证：
     * 1. **顺序不变**：按到达顺序 append，OSC 133 边界仍由同一个解析器按序吃；
     * 2. **不无限积累**：超过 [`MAX_PENDING_OUTPUT`] 立刻处理；
     * 3. **不拖慢回显**：用 `setTimeout(0)`（下一轮宏任务）而不是 rAF ——
     *    窗口最小化时 rAF 会暂停，输出就卡住了。输入通道完全不经过这里。
     */
    /**
     * 输出合并 + **跨流顺序保证**。
     *
     * stdout 和 stderr 进**同一个队列**。以前 stdout 被缓冲到下一轮、stderr
     * 立即写：`stdout-A → stderr-B` 会变成 `stderr-B → stdout-A`，日志上下文
     * 直接错乱，命令结果也可能归错。
     *
     * 消费是**串行**的（一条处理完再下一条）：`handleOutput` 内部要等 xterm
     * 渲染完成再抓快照，并发启动多个会打乱快照时机。
     */
    type OutputChunk = { stream: "stdout" | "stderr"; text: string };
    let pending: OutputChunk[] = [];
    let pendingBytes = 0;
    let flushTimer: number | null = null;
    let consumeChain: Promise<void> = Promise.resolve();
    const MAX_PENDING_OUTPUT = 512 * 1024;

    const flushOutput = () => {
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (pending.length === 0) return;
      const chunks = pending;
      pending = [];
      pendingBytes = 0;

      consumeChain = consumeChain
        .catch(() => undefined)
        .then(async () => {
          for (const chunk of chunks) {
            if (disposed) return;
            if (chunk.stream === "stdout") {
              await handleOutput(chunk.text);
            } else {
              // stderr 与 stdout 走同一条写入队列，顺序由这个循环保证。
              hostRef.current.coordinatorRef.current?.onStderr(chunk.text);
              await queueWrite(chunk.text);
            }
          }
        });
    };

    const enqueue = (chunk: OutputChunk) => {
      pending.push(chunk);
      pendingBytes += chunk.text.length;
      // 高水位：立刻处理，绝不靠"等下一帧"兜住无限输出。
      if (pendingBytes >= MAX_PENDING_OUTPUT) {
        flushOutput();
        return;
      }
      if (flushTimer === null) {
        flushTimer = window.setTimeout(flushOutput, 0);
      }
    };

    const unlistenOutput = listen<string>(sshOutputEvent(sessionId), (event) => {
      if (disposed) return;
      enqueue({ stream: "stdout", text: event.payload });
    });

    // stderr 与 stdout 分开解码（Rust 侧两条流各有解码器），但**写入顺序**
    // 由上面的统一队列保证。
    const unlistenStderr = listen<string>(sshStderrEvent(sessionId), (event) => {
      if (disposed) return;
      enqueue({ stream: "stderr", text: event.payload });
    });

    const selectionSubscription = instance.onSelectionChange(() => {
      const host = hostRef.current;
      if (host.selectionMenuTimerRef.current !== null) window.clearTimeout(host.selectionMenuTimerRef.current);
      const text = instance.getSelection();
      if (!text) {
        host.setSelectionMenu(null);
        return;
      }
      host.selectionMenuTimerRef.current = window.setTimeout(() => {
        const current = hostRef.current;
        const wrapper = current.suggestWrapperRef.current;
        if (!wrapper || !instance.hasSelection()) return;
        // 菜单渲染在 wrapper（relative 定位父元素）里，坐标必须以 wrapper 为基准。
        const screen = container.querySelector<HTMLElement>(".xterm-screen");
        const cols = instance.cols;
        const rows = instance.rows;
        const pos = instance.getSelectionPosition?.();
        const containerRect = container.getBoundingClientRect();
        const wrapperRect = wrapper.getBoundingClientRect();
        let x: number;
        let y: number;
        if (screen && cols > 0 && rows > 0 && pos) {
          const rect = screen.getBoundingClientRect();
          const cellWidth = rect.width / cols;
          const cellHeight = rect.height / rows;
          // start/end 是缓冲坐标（含回滚偏移）；可视行 = bufferY - viewportY。
          const viewportY = instance.buffer.active.viewportY;
          const endColumn = pos.end.x + 1; // 0 基 → 选中文字右缘
          const endRow = pos.end.y - viewportY + 1; // 选中行下一行上缘
          x = containerRect.left - wrapperRect.left + endColumn * cellWidth;
          y = containerRect.top - wrapperRect.top + endRow * cellHeight;
          // 越界保护：末端滚出视口（选区跨屏）时退回顶部居中。
          if (endRow < 0 || endRow > rows) {
            x = Math.max(12, wrapperRect.width / 2);
            y = 12;
          }
        } else {
          x = Math.max(12, wrapperRect.width / 2);
          y = 12;
        }
        current.setSelectionMenu({ x, y, text });
      }, SELECTION_MENU_DELAY_MS);
    });
    const unlistenClosed = listen<string>(sshClosedEvent(sessionId), () => {
      if (disposed) return;
      hostRef.current.setPhase((current) => (current === "connected" ? "closed" : current));
      hostRef.current.setStatus(sessionId, "closed");
    });

    void hostRef.current.connect();

    return () => {
      const host = hostRef.current;
      // 先把最后一批缓冲的输出处理掉（此时 `disposed` 仍为 false），再拆监听：
      // 直接丢弃会让"命令刚结束就关标签"时的最后一行消失。
      flushOutput();
      disposed = true;
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
      resizeObserver.disconnect();
      themeObserver.disconnect();
      viewport?.removeEventListener("scroll", onViewportScroll);
      dataSubscription.dispose();
      selectionSubscription.dispose();
      if (host.selectionMenuTimerRef.current !== null) window.clearTimeout(host.selectionMenuTimerRef.current);
      void unlistenOutput.then((fn) => fn());
      void unlistenStderr.then((fn) => fn());
      void unlistenClosed.then((fn) => fn());
      void opsApi.sshDisconnect(sessionId).catch(() => undefined);
      host.removeSession(sessionId);
      // 会话结束：该服务器上的目录 / Docker / 服务 / 进程缓存与容器选择全部
      // 失效 —— 重连后环境可能完全不同，留着旧缓存会给出错误的补全。
      invalidateDirectoryCache(sessionId);
      invalidateDockerCache(sessionId);
      invalidateServiceCache();
      invalidateProcessCache();
      invalidateEnvironmentCache(sessionId);
      host.cwdTrackerRef.current?.forget(sessionId);
      if (host.cwdProbeTimerRef.current !== null) window.clearTimeout(host.cwdProbeTimerRef.current);
      instance.dispose();
      host.terminalRef.current = null;
      host.fitRef.current = null;
    };
    // Reconnecting on target change is intentional; `connect` is stable per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasTarget, sessionId, updateSuggestAnchor]);
}
