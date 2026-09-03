import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Columns2,
  Copy,
  Eraser,
  FolderOpen,
  History,
  PlugZap,
  Rows2,
  Search,
  Unplug,
  WifiOff,
} from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
import { opsApi, toErrorMessage } from "@/api/ops-api";
import { useDomainStore } from "@/stores/domain-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { RemoteFilePanel } from "@/workbench/views/remote-file/RemoteFilePanel";
import { LineEditor } from "@/lib/terminal-line-editor";
import { useCommandSuggestions } from "@/hooks/use-command-suggestions";
import {
  canAutoFill,
  completionKeys,
  fillPlaceholder,
  hasUnresolvedPlaceholder,
  placeholdersIn,
} from "@/workbench/views/command-center/complete";
import { ParamPicker } from "./ParamPicker";
import type { CommandSearchHit } from "@/api/ops-api";
import type { WorkspaceTab } from "@/workbench/types";
import { sshClosedEvent, sshOutputEvent } from "@/lib/events";
import { terminalTheme } from "./theme";
import { ToolbarIcon } from "./ToolbarIcon";
import { CommandHistoryPanel } from "./CommandHistoryPanel";
import { TerminalPicker } from "./TerminalPicker";
import { TerminalSuggest } from "./TerminalSuggest";
import {
  resolveSuggestKey,
  type SuggestAnchor,
} from "./terminal-suggest";

const KEEPALIVE_MS = 30_000;
/** Consecutive failed probes before the session is declared dead. */
const KEEPALIVE_MAX_FAILURES = 2;
const SELECTION_MENU_DELAY_MS = 450;

function isCommandNotFoundOutput(output: string): boolean {
  return /command ['“”']?[^'“”']+['“”']? not found/i.test(output);
}

type Phase = "idle" | "connecting" | "connected" | "error" | "closed";

/** Real interactive SSH terminal: input, output, resize, reconnect, keepalive. */
export function TerminalView({ tab }: { tab: WorkspaceTab }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // A tab created without a connection still needs a stable id; once the user
  // picks a target the tab carries its own session id.
  const fallbackSessionRef = useRef<string | null>(null);
  if (!fallbackSessionRef.current) fallbackSessionRef.current = crypto.randomUUID();
  const sessionId = tab.sessionId ?? fallbackSessionRef.current;
  const connectingRef = useRef(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchState, setSearchState] = useState<{ index: number; total: number } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(true);
  /**
   * Shell-to-panel sync: every `cd` typed in the terminal bumps this nonce
   * with the raw argument; the file panel resolves it against its own cwd.
   */
  const [follow, setFollow] = useState<{ nonce: number; arg: string }>({ nonce: 0, arg: "" });
  const [selectionMenu, setSelectionMenu] = useState<{ x: number; y: number; text: string } | null>(null);
  const selectionMenuTimerRef = useRef<number | null>(null);
  /**
   * 正在输入的命令行（由 LineEditor 从按键流还原）。驱动命令提示 —— 与
   * 命令中心共用 `useCommandSuggestions`，因此输入 `docker p` 的行为一致。
   */
  const [draft, setDraft] = useState("");
  /** Ctrl+Space 可临时关闭提示（有人就是不喜欢）。 */
  const [suggestOpen, setSuggestOpen] = useState(true);
  /**
   * 提示面板的"已关闭"草稿：填入候选（→ / Enter / 点击）或 ← / Esc 关闭后
   * 记录当前草稿，面板暂时不再出现 —— **否则第二次 Enter 会再次命中候选，
   * 永远无法真正执行**。用户继续输入/删除/修改草稿后（draft 变化）自动恢复。
   */
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null);
  /** 提示面板锚点：光标单元格右下角（px，相对终端定位容器）。 */
  const [suggestAnchor, setSuggestAnchor] = useState<SuggestAnchor | null>(null);
  /**
   * 二级参数选择：候选语法含 `<unit>`/`<容器>` 时打开，从服务器拉真实取值。
   * 选中后替换一个占位符；还有占位符就继续选，全替换完才写入 shell。
   */
  const [paramPicker, setParamPicker] = useState<{
    hit: CommandSearchHit;
    syntax: string;
    draft: string;
  } | null>(null);
  /** 参数相关的可见提示（如"还有未替换的参数"）—— 绝不静默失败。 */
  const [paramHint, setParamHint] = useState<string | null>(null);
  /** 终端定位容器（提示面板的 absolute 父元素）。 */
  const suggestWrapperRef = useRef<HTMLDivElement>(null);
  /**
   * 是否处于 alternate screen（vim / top / less …）。这些程序自己接管整屏，
   * 此时任何提示都是噪音，且"当前行"也不再是 shell 命令行。
   */
  const [inAlternate, setInAlternate] = useState(false);

  const splitPane = useWorkbenchStore((s) => s.splitPane);
  const updateTab = useWorkbenchStore((s) => s.updateTab);
  const servers = useDomainStore((s) => s.servers);
  const register = useSessionStore((s) => s.register);
  const setStatus = useSessionStore((s) => s.setStatus);
  const removeSession = useSessionStore((s) => s.remove);
  const raiseChallenge = useSessionStore((s) => s.raiseChallenge);

  const hasTarget = Boolean(tab.serverId || tab.quickTarget);

  // Recovers the command being typed from the raw keystroke stream so it can be
  // recorded as history. Created once per session.
  const lineEditorRef = useRef<LineEditor | null>(null);
  if (!lineEditorRef.current) lineEditorRef.current = new LineEditor();

  // Command suggestions share the knowledge base with the command centre.
  // Retrieval is local — it needs no connection — but suggestions only make
  // sense while a shell is actually waiting for input. dismissedDraft =
  // 填入候选或关闭面板时的草稿：相同就不再检索（见 dismissedDraft 注释）。
  const suggestionsEnabled =
    phase === "connected" &&
    !inAlternate &&
    suggestOpen &&
    draft.trim().length > 0 &&
    draft !== dismissedDraft;
  const suggestions = useCommandSuggestions(draft, { enabled: suggestionsEnabled, limit: 8 });

  /**
   * 重算提示面板锚点：读 xterm 光标单元格（cursorX/cursorY），按 `.xterm-screen`
   * 的实际尺寸换算成像素，得到光标**右下角**相对定位容器的坐标。
   *
   * 全部走 requestAnimationFrame：等 xterm 把本次写入/滚动渲染完再读，否则
   * 读到的是上一帧的光标位置。输入、输出、滚动、缩放、fit 之后都要调用。
   */
  const updateSuggestAnchor = useCallback(() => {
    requestAnimationFrame(() => {
      const instance = terminalRef.current;
      const container = containerRef.current;
      const wrapper = suggestWrapperRef.current;
      if (!instance || !container || !wrapper) {
        setSuggestAnchor(null);
        return;
      }
      const screen = container.querySelector<HTMLElement>(".xterm-screen");
      const cols = instance.cols;
      const rows = instance.rows;
      if (!screen || cols <= 0 || rows <= 0) {
        setSuggestAnchor(null);
        return;
      }
      const rect = screen.getBoundingClientRect();
      const cellWidth = rect.width / cols;
      const cellHeight = rect.height / rows;
      if (cellWidth <= 0 || cellHeight <= 0) {
        setSuggestAnchor(null);
        return;
      }
      const cursorX = instance.buffer.active.cursorX;
      const cursorY = instance.buffer.active.cursorY;
      // 光标滚出可视区（用户上翻回滚缓冲）时不显示提示。
      if (cursorY < 0 || cursorY >= rows || cursorX < 0 || cursorX >= cols) {
        setSuggestAnchor(null);
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const wrapperRect = wrapper.getBoundingClientRect();
      setSuggestAnchor({
        x: containerRect.left - wrapperRect.left + (cursorX + 1) * cellWidth,
        y: containerRect.top - wrapperRect.top + (cursorY + 1) * cellHeight,
      });
    });
  }, []);

  /**
   * 把一段文本写进远程 shell 的当前行（**唯一**的写入口）。
   *
   * 这里是"未解析占位符绝不进 shell"的**最后一道拦截**：`<unit>` 之类
   * 一旦漏到这里，bash 会当成输入重定向而报 `No such file or directory`。
   * 拦截失败时不写任何东西，并给出可见提示（绝不静默）。
   */
  const writeToShell = useCallback(
    (text: string): boolean => {
      if (hasUnresolvedPlaceholder(text)) {
        setParamHint(`命令里还有未替换的参数（${text}），请先选择具体值`);
        return false;
      }
      void opsApi.sshInput(sessionId, text).catch(() => undefined);
      return true;
    },
    [sessionId],
  );

  /**
   * 接受候选：
   *
   * - 语法**不含**占位符 → 直接补全（不执行，第二次 Enter 才发给 shell）；
   * - 语法**含**占位符 → 打开二级参数选择器挑真值，替换后再写；
   *   认不出种类的占位符（`<时间>` 之类，无数据源）不写、也不开选择器。
   */
  const applySuggestion = useCallback(
    (hit: CommandSearchHit) => {
      const editor = lineEditorRef.current;
      if (!editor) return;
      const draft = editor.current;

      // 占位符以后端 `hit.placeholders` 为准（语法解析在 Rust 侧），
      // 前端的空数组只会出现在旧快照上 —— 此时退回前端解析，宁可多拦。
      const hasPlaceholder = hit.placeholders?.length ?? placeholdersIn(hit.syntax).length > 0;
      if (hasPlaceholder) {
        if (!canAutoFill(hit.syntax)) {
          setParamHint("该命令含需要手填的参数，已为你填入命令主体，请自行补全");
          return;
        }
        setParamPicker({ hit, syntax: hit.syntax, draft });
        setDismissedDraft(draft);
        return;
      }

      const keys = completionKeys(draft, hit.syntax);
      // 理论上不会为 null（无占位符），仍守住：写不进去就不写。
      if (keys === null) return;
      if (!writeToShell(keys)) return;
      editor.feed(keys);
      const next = editor.current;
      setDraft(next);
      setDismissedDraft(next);
      updateSuggestAnchor();
    },
    [updateSuggestAnchor, writeToShell],
  );

  /** 二级选择器选中一个值：替换当前占位符，还有占位符就继续选，否则写入 shell。 */
  const applyParamValue = useCallback(
    (value: string) => {
      const picker = paramPicker;
      const editor = lineEditorRef.current;
      if (!picker || !editor) return;
      const next = placeholdersIn(picker.syntax)[0];
      if (!next) return;
      const filled = fillPlaceholder(picker.syntax, next.token, value);
      const remaining = placeholdersIn(filled);
      if (remaining.length > 0) {
        setParamPicker({ ...picker, syntax: filled });
        return;
      }
      // 全部占位符都已替换：整条写入（不再走 completionKeys 的差分逻辑），
      // 填入不执行 —— 第二次 Enter 才发给 shell。
      const keys = completionKeys(picker.draft, filled);
      setParamPicker(null);
      if (keys === null || !writeToShell(keys)) return;
      editor.feed(keys);
      const line = editor.current;
      setDraft(line);
      setDismissedDraft(line);
      updateSuggestAnchor();
    },
    [paramPicker, updateSuggestAnchor, writeToShell],
  );

  /**
   * 键盘接管（提示面板打开时，映射见 `terminal-suggest.ts`）：
   * ↑↓ 选择、→ / Enter 填入（**不执行**）、← / Esc 关闭面板。
   * 其余按键（含面板关闭后的全部按键）原样交给远程 shell —— 方向键是
   * shell 历史，Tab 是远程补全。Ctrl+Space 仍是提示开关。
   *
   * 输入法组合中（isComposing / keyCode 229）绝不拦截。Held in a ref so the
   * terminal — created once — always calls the latest handler.
   */
  const keyHandlerRef = useRef<(event: KeyboardEvent) => boolean>(() => false);
  const paramPickerRef = paramPicker;
  // No dep array on purpose: the terminal is created once, so the handler has
  // to be refreshed after every render to see the current suggestions/draft.
  useEffect(() => {
    keyHandlerRef.current = (event) => {
      if (event.ctrlKey && event.code === "Space") {
        // 二级选择器打开时先关它（它有自己的 window 级监听）。
        if (paramPicker) setParamPicker(null);
        else setSuggestOpen((open) => !open);
        return true;
      }
      // 二级选择器打开期间：按键交给它（window 捕获阶段），本层不参与，
      // 否则 ↑↓/Enter 会被两层各处理一次。
      if (paramPickerRef) return false;
      if (event.isComposing || event.keyCode === 229) return false;
      const { hits, activeIndex, setActiveIndex } = suggestions;
      const action = resolveSuggestKey(
        { key: event.key, isComposing: event.isComposing },
        hits.length > 0,
      );
      switch (action.type) {
        case "none":
          return false;
        case "move": {
          event.preventDefault();
          setActiveIndex(
            Math.min(Math.max(activeIndex + action.delta, 0), hits.length - 1),
          );
          return true;
        }
        case "accept": {
          event.preventDefault();
          const hit = hits[activeIndex];
          if (hit) applySuggestion(hit);
          return true;
        }
        case "dismiss": {
          event.preventDefault();
          // 关闭面板：记录当前草稿，draft 变化前面板不再出现。
          setDismissedDraft(draft);
          return true;
        }
      }
    };
  });

  const connect = useCallback(async () => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    setPhase("connecting");
    setError(null);

    const instance = terminalRef.current;
    const cols = instance?.cols ?? 120;
    const rows = instance?.rows ?? 32;
    const startedAt = performance.now();

    register({
      sessionId,
      tabId: tab.id,
      title: tab.title,
      subtitle: tab.subtitle,
      serverId: tab.serverId,
    });

    try {
      const result = await opsApi.sshConnect({
        sessionId,
        serverId: tab.serverId,
        target: tab.quickTarget,
        credentialId: tab.credentialId,
        password: tab.oneTimePassword,
        cols,
        rows,
      });

      if (result.status === "connected") {
        const elapsed = Math.round(performance.now() - startedAt);
        setPhase("connected");
        setStatus(sessionId, "connected", { connectMs: elapsed, connectedAt: Date.now() });
        instance?.writeln(`\r\n已连接 ${result.host}:${result.port}（${result.fingerprint_type}）`);
        // The one-time password has served its purpose; drop it from tab state
        // so it is not kept in memory or reused for a later reconnect.
        if (tab.oneTimePassword) updateTab(tab.id, { oneTimePassword: undefined });
        return;
      }

      // Host key needs a human decision — never silently accepted.
      // With ProxyJump `challenge_host` is a jump host, so the copy has to
      // name the endpoint being trusted rather than the tab's destination.
      const challengeLabel = `${result.challenge_host}:${result.challenge_port}`;
      const isJumpHop = challengeLabel !== `${result.host}:${result.port}`;
      setPhase("error");
      setError(
        result.status === "host_key_changed"
          ? `${challengeLabel} 的主机指纹已变化，请确认后再连接`
          : `首次连接 ${challengeLabel}，请确认主机指纹`,
      );
      setStatus(sessionId, "error", { error: "等待主机指纹确认" });
      raiseChallenge({
        sessionId,
        kind: result.status === "host_key_changed" ? "changed" : "unknown",
        challengeHost: result.challenge_host,
        challengePort: result.challenge_port,
        targetHost: result.host,
        targetPort: result.port,
        isJumpHop,
        fingerprint: result.fingerprint,
        fingerprintType: result.fingerprint_type,
        knownFingerprint: "known_fingerprint" in result ? result.known_fingerprint : undefined,
        retry: () => void connect(),
        cancel: () => {
          setPhase("closed");
          setStatus(sessionId, "closed");
        },
      });
    } catch (cause) {
      const message = toErrorMessage(cause);
      setPhase("error");
      setError(message);
      setStatus(sessionId, "error", { error: message });
      instance?.writeln(`\r\n\x1b[31m连接失败：${message}\x1b[0m`);
    } finally {
      connectingRef.current = false;
    }
  }, [
    raiseChallenge,
    register,
    sessionId,
    setStatus,
    tab.credentialId,
    tab.id,
    tab.oneTimePassword,
    tab.quickTarget,
    tab.serverId,
    tab.subtitle,
    tab.title,
    updateTab,
  ]);

  // Terminal instance + data plumbing.
  useEffect(() => {
    if (!containerRef.current || !hasTarget) return;

    const isDark = document.documentElement.dataset.theme === "dark";
    const instance = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 13,
      scrollback: 5000,
      theme: terminalTheme(isDark),
    });
    const fit = new FitAddon();
    instance.loadAddon(fit);
    instance.open(containerRef.current);
    fit.fit();
    terminalRef.current = instance;
    fitRef.current = fit;

    // Follow the app theme live (system theme can change while running).
    const themeObserver = new MutationObserver(() => {
      instance.options.theme = terminalTheme(document.documentElement.dataset.theme === "dark");
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    // Claim only the suggestion keys; everything else reaches the shell.
    instance.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      return !keyHandlerRef.current(event);
    });

    const dataSubscription = instance.onData((data) => {
      // Full-screen programs (vim, top, less) take over the screen: the
      // "current line" is no longer a shell command, so suggestions are noise.
      // Sampled on input — entering them always involves a keystroke.
      const alternate = instance.buffer.active.type !== "normal";
      setInAlternate(alternate);

      // Recover whole commands from the raw stream; arrow keys, Ctrl+C, pastes
      // and line continuations are handled by the editor.
      const commands = lineEditorRef.current?.feed(data) ?? [];
      if (alternate) {
        void opsApi.sshInput(sessionId, data).catch(() => undefined);
        return;
      }
      for (const command of commands) {
        if (tab.serverId || tab.quickTarget) {
          void opsApi
            .recordHistory(sessionId, tab.serverId ?? "", tab.title, command)
            .catch(() => undefined);
        }
        // Follow `cd` commands in the file panel: the panel resolves the
        // argument against its own cwd (handles `cd`, `cd ~`, `cd -`, paths).
        const match = /^cd(?:\s+(.*))?$/.exec(command.trim());
        if (match) {
          const arg = (match[1] ?? "").trim().replace(/^["']|["']$/g, "");
          setFollow((current) => ({ nonce: current.nonce + 1, arg }));
        }
      }
      // A submitted line (or Ctrl+C, which the editor abandons) clears the
      // draft, which in turn hides the suggestion layer.
      setDraft(commands.length > 0 ? "" : (lineEditorRef.current?.current ?? ""));
      void opsApi.sshInput(sessionId, data).catch(() => undefined);
      // 输入会移动光标 → 重算提示面板锚点。
      updateSuggestAnchor();
    });

    const resizeObserver = new ResizeObserver(() => {
      // While this tab is hidden (display:none) the container measures 0;
      // refitting would collapse the terminal and spam the connection with
      // resize packets. Skip until it is visible again.
      if (containerRef.current && containerRef.current.clientWidth === 0) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (instance.cols > 0 && instance.rows > 0) {
        void opsApi.sshResize(sessionId, instance.cols, instance.rows).catch(() => undefined);
      }
      // 缩放 / fit 改变单元格尺寸 → 重算锚点。
      updateSuggestAnchor();
    });
    resizeObserver.observe(containerRef.current);

    // 回滚缓冲滚动改变光标在视口中的行 → 重算锚点（rAF 节流）。
    const viewport = containerRef.current.querySelector<HTMLElement>(".xterm-viewport");
    const onViewportScroll = () => updateSuggestAnchor();
    viewport?.addEventListener("scroll", onViewportScroll, { passive: true });

    let disposed = false;
    const unlistenOutput = listen<string>(sshOutputEvent(sessionId), (event) => {
      if (disposed) return;
      const output = event.payload;
      if (isCommandNotFoundOutput(output)) {
        instance.write(`\x1b[31m命令无效：${output}\x1b[0m`);
      } else {
        instance.write(output);
      }
      // 远程输出（回显/补全回显）也会移动光标；顺带采样 alternate screen。
      setInAlternate(instance.buffer.active.type !== "normal");
      updateSuggestAnchor();
    });

    const selectionSubscription = instance.onSelectionChange(() => {
      if (selectionMenuTimerRef.current !== null) window.clearTimeout(selectionMenuTimerRef.current);
      const text = instance.getSelection();
      if (!text) {
        setSelectionMenu(null);
        return;
      }
      selectionMenuTimerRef.current = window.setTimeout(() => {
        const container = containerRef.current;
        // 菜单渲染在 wrapper（relative 定位父元素）里，坐标必须以 wrapper 为基准。
        const wrapper = suggestWrapperRef.current;
        if (!container || !wrapper || !instance.hasSelection()) return;
        // 菜单贴着**选区末端**（最后一个选中单元格的右下方），不是写死的顶部居中。
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
        setSelectionMenu({ x, y, text });
      }, SELECTION_MENU_DELAY_MS);
    });
    const unlistenClosed = listen<string>(sshClosedEvent(sessionId), () => {
      if (disposed) return;
      setPhase((current) => (current === "connected" ? "closed" : current));
      setStatus(sessionId, "closed");
    });

    void connect();

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      themeObserver.disconnect();
      viewport?.removeEventListener("scroll", onViewportScroll);
      dataSubscription.dispose();
      selectionSubscription.dispose();
      if (selectionMenuTimerRef.current !== null) window.clearTimeout(selectionMenuTimerRef.current);
      void unlistenOutput.then((fn) => fn());
      void unlistenClosed.then((fn) => fn());
      void opsApi.sshDisconnect(sessionId).catch(() => undefined);
      removeSession(sessionId);
      instance.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
    // Reconnecting on target change is intentional; `connect` is stable per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasTarget, sessionId, updateSuggestAnchor]);

  // Keepalive only runs while the session is actually connected. Consecutive
  // failures flip the session to "closed" so the UI stops claiming a live
  // connection that the server has already dropped.
  useEffect(() => {
    if (phase !== "connected") return;

    let failures = 0;
    const timer = window.setInterval(() => {
      opsApi.sshKeepalive(sessionId).then(
        () => {
          failures = 0;
        },
        (cause) => {
          failures += 1;
          if (failures < KEEPALIVE_MAX_FAILURES) return;
          window.clearInterval(timer);
          const message = `连接已断开：${toErrorMessage(cause)}`;
          setPhase("closed");
          setError(message);
          setStatus(sessionId, "closed", { error: message });
          terminalRef.current?.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
        },
      );
    }, KEEPALIVE_MS);

    return () => window.clearInterval(timer);
  }, [phase, sessionId, setStatus]);

  const runSearch = useCallback(() => {
    const instance = terminalRef.current;
    if (!instance || !searchQuery.trim()) {
      setSearchState(null);
      return;
    }
    const needle = searchQuery.toLowerCase();
    const buffer = instance.buffer.active;
    let total = 0;
    let firstLine: number | null = null;
    for (let i = 0; i < buffer.length; i += 1) {
      const text = buffer.getLine(i)?.translateToString(true).toLowerCase() ?? "";
      if (text.includes(needle)) {
        total += 1;
        firstLine ??= i;
      }
    }
    if (firstLine === null) {
      setSearchState({ index: 0, total: 0 });
      return;
    }
    // Walk forward from the current position so repeated searches advance.
    const start = (searchState?.index ?? 0) % Math.max(total, 1);
    let seen = -1;
    let target = firstLine;
    for (let i = 0; i < buffer.length && seen < start; i += 1) {
      const text = buffer.getLine(i)?.translateToString(true).toLowerCase() ?? "";
      if (!text.includes(needle)) continue;
      seen += 1;
      target = i;
    }
    instance.scrollToLine(target);
    setSearchState({ index: (seen + 1) % Math.max(total, 1), total });
  }, [searchQuery, searchState]);

  if (!hasTarget) {
    return <TerminalPicker tabId={tab.id} servers={servers} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-row bg-surface-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1  border-line bg-transparent px-2">
        <ToolbarIcon label="查找" icon={Search} active={searchOpen} onClick={() => setSearchOpen((v) => !v)} />
        <ToolbarIcon label="垂直分栏" icon={Columns2} onClick={() => splitPane(useWorkbenchStore.getState().focusedPaneId ?? "", "horizontal")} />
        <ToolbarIcon label="水平分栏" icon={Rows2} onClick={() => splitPane(useWorkbenchStore.getState().focusedPaneId ?? "", "vertical")} />
        <ToolbarIcon label="清空屏幕" icon={Eraser} onClick={() => terminalRef.current?.clear()} />
        <ToolbarIcon label="命令历史" icon={History} active={historyOpen} onClick={() => setHistoryOpen((v) => !v)} />
        <ToolbarIcon label="远程文件" icon={FolderOpen} active={filesOpen} onClick={() => setFilesOpen((v) => !v)} />
        <div className="mx-1 h-4 w-px bg-line" />
        {phase === "connected" ? (
          <ToolbarIcon
            label="断开连接"
            icon={Unplug}
            onClick={() => {
              void opsApi.sshDisconnect(sessionId).catch(() => undefined);
              setPhase("closed");
              setStatus(sessionId, "closed");
            }}
          />
        ) : (
          <ToolbarIcon label="重新连接" icon={PlugZap} disabled={phase === "connecting"} onClick={() => void connect()} />
        )}

        {searchOpen && (
          <div className="ml-2 flex items-center gap-1">
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") runSearch();
              }}
              placeholder="在回滚缓冲中查找"
              spellCheck={false}
              className="h-[26px] w-48 rounded-[7px] border border-line bg-surface-2 px-2 text-11 text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
            />
            <Button variant="ghost" size="xs" className="rounded-[7px]" onClick={runSearch}>
              查找
            </Button>
            {searchState && (
              <span className="text-11 text-fg-subtle">
                {searchState.total === 0 ? "无匹配" : `${searchState.index + 1}/${searchState.total}`}
              </span>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-11 text-danger">
          <WifiOff size={12} />
          <span className="min-w-0 flex-1 truncate">{error}</span>
          <button
            type="button"
            aria-label="复制错误信息"
            title="复制错误信息"
            className="flex h-6 shrink-0 items-center gap-1 rounded-[6px] px-1.5 text-11 text-danger/80 hover:bg-danger/10 hover:text-danger"
            onClick={() => void navigator.clipboard.writeText(error)}
          >
            <Copy size={12} />
            复制
          </button>
          <Button variant="ghost" size="xs" onClick={() => void connect()}>
            重试
          </Button>
        </div>
      )}

      {/* padding 放在包装层：FitAddon 读的是测量元素（containerRef）的
          border-box 高度且不扣它的 padding —— 若 padding 和 xterm 在同一个
          div 上，算出的行数会多一行，最后一行被裁掉半个字符。
          同时是提示面板的定位容器（relative）。 */}
      <div
        ref={suggestWrapperRef}
        className="relative flex min-h-0 flex-1 p-2"
        onMouseDown={() => setSelectionMenu(null)}
      >
        <div ref={containerRef} className="min-h-0 min-w-0 flex-1 overflow-hidden bg-surface-1" data-selectable />
        {selectionMenu && (
          <div
            className="absolute left-1/2 top-3 z-40 flex -translate-x-1/2 items-center gap-1 rounded-[9px] border border-line bg-surface-1 px-1.5 py-1 shadow-lg"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="px-1 text-11 text-fg-subtle">已选择 {selectionMenu.text.length} 个字符</span>
            <button
              type="button"
              className="flex h-6 items-center gap-1 rounded-[6px] px-2 text-11 text-fg-muted hover:bg-surface-hover hover:text-fg"
              onClick={() => {
                void navigator.clipboard.writeText(selectionMenu.text);
                setSelectionMenu(null);
              }}
            >
              <Copy size={12} />
              复制
            </button>
          </div>
        )}
        {historyOpen && (
          <CommandHistoryPanel
            sessionId={sessionId}
            serverId={tab.serverId}
            onPick={(command) => void opsApi.sshInput(sessionId, `${command}\n`)}
          />
        )}
        {suggestionsEnabled && !paramPicker && (
          <TerminalSuggest
            hits={suggestions.hits}
            activeIndex={suggestions.activeIndex}
            onHover={suggestions.setActiveIndex}
            onApply={applySuggestion}
            anchor={suggestAnchor}
          />
        )}
        {paramPicker && (
          <ParamPicker
            sessionId={sessionId}
            syntax={paramPicker.syntax}
            onPick={applyParamValue}
            onCancel={() => {
              setParamPicker(null);
              updateSuggestAnchor();
            }}
            anchor={suggestAnchor}
          />
        )}
        {paramHint && (
          <div className="absolute bottom-1.5 left-1.5 right-1.5 z-30 flex items-center gap-2 rounded-[8px] border border-warning/40 bg-warning/12 px-2.5 py-1.5 text-11 text-warning">
            <span className="min-w-0 flex-1 truncate">{paramHint}</span>
            <button
              type="button"
              className="shrink-0 rounded px-1 text-11 text-warning/80 hover:text-warning"
              onClick={() => setParamHint(null)}
            >
              知道了
            </button>
          </div>
        )}
      </div>

      </div>

      {filesOpen && (
        <RemoteFilePanel
          key={sessionId}
          sessionId={sessionId}
          connected={phase === "connected"}
          follow={follow}
          onClose={() => setFilesOpen(false)}
        />
      )}
    </div>
  );
}
