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
  filledDraftRef: RefObject<string | null>;
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
      // 用户真的按了回车（行已提交）→ "上次填入的行"作废，避免下一次
      // 补全被误判成执行。
      if (commands.length > 0) host.filledDraftRef.current = null;
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
      const done = new Promise<void>((resolve) => {
        instance.write(text, () => resolve());
      });
      writeQueue = writeQueue.catch(() => undefined).then(() => done);
      return done;
    };
    const unlistenOutput = listen<string>(sshOutputEvent(sessionId), (event) => {
      if (disposed) return;
      const host = hostRef.current;
      const output = event.payload;
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
      const reported = host.cwdTrackerRef.current?.feedOutput(sessionId, output) ?? null;
      if (reported) host.setCwd(reported);
      // 命令结束（OSC 133 D 带真实退出码）：`cd` 成功才更新 cwd，失败不动。
      for (const event of parsed.events) {
        if (event.type === "output_end") {
          host.cwdTrackerRef.current?.onCommandEnd(sessionId, event.exitCode);
          host.setCwd(host.cwdTrackerRef.current?.get(sessionId) ?? null);
        }
      }
      host.coordinatorRef.current?.onOutput(parsed.text, parsed.events);
      const notFound = isCommandNotFoundOutput(parsed.text);
      const display = (text: string) => (notFound ? `\x1b[31m命令无效：${text}\x1b[0m` : text);

      // 同步抓住本次结束对应的 marker —— 异步渲染期间可能有新命令提交。
      const heldAtEnd = host.captureMarkerRef.current;
      // 写出顺序 = 终端输出流水线（见 terminal-output-pipeline.ts）：
      // D 之前写完并渲染完 → 抓快照 → 才写 D 之后的提示符。
      void writeOutputParts(parsed.parts, {
        write: (text) => queueWrite(display(text)),
        flush: () => writeQueue.catch(() => undefined),
        capture: () =>
          host.coordinatorRef.current?.provideRenderedText(host.consumeTerminalSnapshot(heldAtEnd)),
      });
      // 远程输出（回显/补全回显）也会移动光标；顺带采样 alternate screen。
      host.setInAlternate(instance.buffer.active.type !== "normal");
      host.updateSuggestAnchor();
    });
    // stderr 与 stdout 分开：Rust 侧两条流各有独立的流式解码器，事件也分开，
    // 否则结果的原始输出里永远没有 stderr。写入仍走同一 xterm 队列。
    const unlistenStderr = listen<string>(sshStderrEvent(sessionId), (event) => {
      if (disposed) return;
      const text = event.payload;
      hostRef.current.coordinatorRef.current?.onStderr(text);
      // 与 stdout **同一条写入队列**：stderr 事件晚到时也要排在快照之前，
      // 否则它会写进下一个命令的结果，或干脆不进本次快照。
      if (text) void queueWrite(text);
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
      disposed = true;
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
