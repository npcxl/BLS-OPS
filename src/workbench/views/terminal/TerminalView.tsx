import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  ChevronDown,
  Columns2,
  Copy,
  Eraser,
  FolderOpen,
  History,
  PlugZap,
  RefreshCw,
  Rows2,
  Search,
  Sparkles,
  Unplug,
  WifiOff,
} from "lucide-react";
import { Terminal, type IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyNotice, useCopyFeedback } from "@/components/ui/copy-feedback";
import { ContextMenu, useContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import { opsApi, RISK_META, toErrorMessage } from "@/api/ops-api";
import { useDomainStore } from "@/stores/domain-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { RemoteFilePanel } from "@/workbench/views/remote-file/RemoteFilePanel";
import { LineEditor } from "@/lib/terminal-line-editor";
import {
  canAutoFill,
  completionKeys,
  fillPlaceholder,
  hasUnresolvedPlaceholder,
  placeholdersIn,
} from "@/workbench/views/command-center/complete";
import { ParamPicker } from "./ParamPicker";
import {
  TerminalCommandCoordinator,
  type CapturedResult,
  type RenderOutcome,
} from "./TerminalCommandCoordinator";
import { extractTerminalSnapshot } from "./extract-terminal-snapshot";
import { TerminalResultDrawer } from "./TerminalResultDrawer";
import { TerminalSelectionMenu } from "./terminal-selection-menu";
import type { CommandSearchHit } from "@/api/ops-api";
import type { SuggestedRisk } from "@/api/types/environment";
import type { WorkspaceTab } from "@/workbench/types";
import { sshClosedEvent, sshOutputEvent, sshStderrEvent } from "@/lib/events";
import { terminalTheme } from "./theme";
import { ToolbarIcon } from "./ToolbarIcon";
import { CommandHistoryPanel } from "./CommandHistoryPanel";
import { TerminalPicker } from "./TerminalPicker";
import { TerminalSuggest } from "./TerminalSuggest";
import { CommandBoundaryParser } from "./command-boundary";
import { writeOutputParts } from "./terminal-output-pipeline";
import {
  TERMINAL_FONTS,
  applyTerminalFont,
  readTerminalFontId,
  saveTerminalFontId,
} from "./terminal-font";
import { planCommandSubmission, type CommandSource, type SubmitMode } from "./command-plan";
import {
  keysForReplace,
  resolveSuggestKey,
  type SuggestAnchor,
} from "./terminal-suggest";
import { useTerminalCompletion } from "./use-terminal-completion";
import { useServerEnvironment, invalidateEnvironmentCache } from "./use-server-environment";
import { RemoteCwdTracker, CWD_PROBE_LINE, CWD_PROBE_TIMEOUT_MS } from "./remote-cwd";
import { invalidateDirectoryCache } from "./completion/remote-listing";
import { invalidateDockerCache } from "./completion/providers/docker-resource";
import { invalidateServiceCache } from "./completion/providers/service";
import { invalidateProcessCache } from "./completion/providers/process";
import { rememberNginxContainer } from "./completion/providers/environment";
import type { CompletionItem } from "./completion/types";

/** 增强终端开关的持久化键（关着 = 纯终端：没有标记注入、没有结果面板）。 */
const ENHANCED_TERMINAL_KEY = "bls-ops.terminal.enhanced";

const KEEPALIVE_MS = 30_000;
/** Consecutive failed probes before the session is declared dead. */
const KEEPALIVE_MAX_FAILURES = 2;
const SELECTION_MENU_DELAY_MS = 450;

function isCommandNotFoundOutput(output: string): boolean {
  return /command ['“”']?[^'“”']+['“”']? not found/i.test(output);
}

/**
 * 会改变目录结构的命令。执行后远程目录缓存必须失效 ——
 * 缓存里留着已被 `rm -rf` 删掉的目录，用户就会补出一个不存在的路径。
 */
const MUTATES_DIRECTORY =
  /^\s*(mkdir|rmdir|rm|mv|cp|touch|unlink|ln|install|git\s+clone|tar\s+-?[xj])\b/;

type Phase = "idle" | "connecting" | "connected" | "error" | "closed";

/**
 * 接受候选（Enter / → / Tab）的结果。
 *
 * `noop` 是关键：候选与已输入内容完全一致时，"填入"什么都不会做。此时
 * 必须把这次回车当成**执行命令**，否则建议面板会一直吞掉回车 —— 命令永远
 * 发不出去，用户只看到"结果面板没出现"（曾是这个 bug 的根因）。
 */
type AcceptOutcome = "filled" | "noop" | "blocked";

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
  // 终端里的复制（选区菜单 / 复制错误信息）统一走共用模块：有成功失败提示、
  // 一个计时器、绝不散落 navigator.clipboard。
  const { status: copyStatus, copy: copyToClipboard } = useCopyFeedback();
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
  /**
   * 本次会话的命令结果（快照 + 原始流，最新在后）。与是否命中知识库无关：
   * 只要是可捕获命令（非交互式、不读 stdin）都会产出一条；命令本身的
   * 输出为空也是有效结果（显示为空，不回落）。
   */
  const [commandResults, setCommandResults] = useState<CapturedResult[]>([]);
  const [activeResultId, setActiveResultId] = useState<string | null>(null);
  const [drawerCollapsed, setDrawerCollapsed] = useState(false);
  const [drawerClosed, setDrawerClosed] = useState(false);
  /**
   * **增强终端开关**（默认关）：只有打开时命令才会注入受控标记、捕获输出并
   * 生成结果面板；关着时终端就是纯终端 —— 不注入任何标记、不产生任何结果
   * Tab。状态持久化到 localStorage（隐私模式下写不进去也不影响使用）。
   */
  const [enhancedTerminal, setEnhancedTerminal] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(ENHANCED_TERMINAL_KEY) === "1";
    } catch {
      return false;
    }
  });
  /** 协调器只创建一次，onResult / 提交决策都要读到**当前**开关值。 */
  const enhancedRef = useRef(enhancedTerminal);
  enhancedRef.current = enhancedTerminal;
  useEffect(() => {
    try {
      window.localStorage.setItem(ENHANCED_TERMINAL_KEY, enhancedTerminal ? "1" : "0");
    } catch {
      /* 隐私模式等场景下写不进去，忽略即可 */
    }
  }, [enhancedTerminal]);
  /**
   * **就一个开关**：开 → 命令结果面板随结果自动出现；关 → 纯终端，什么都没有
   * （结果面板、已存结果全部撤掉）。面板自己的 × 只是临时收起，下一条命令
   * 的结果会重新展开它 —— 不再需要第二个"显示/隐藏结果"按钮。
   */
  const toggleEnhancedTerminal = useCallback(() => {
    const next = !enhancedRef.current;
    setEnhancedTerminal(next);
    if (!next) {
      // 关掉 = 回到纯终端：已有结果面板全部撤掉，飞行中的捕获也会被丢弃。
      setCommandResults([]);
      setActiveResultId(null);
      setDrawerClosed(true);
    } else {
      // 重新打开：面板跟着新结果出来（之前只是被 × 收起）。
      setDrawerClosed(false);
    }
  }, []);

  /**
   * 终端 / 命令输出字体（用户可选，与结果面板共用同一套栈）。
   * 切换后要 `fit()` 重排 —— 字宽变了，xterm 的行列数会跟着变。
   */
  const [fontId, setFontId] = useState<string>(readTerminalFontId);
  useEffect(() => {
    saveTerminalFontId(fontId);
    applyTerminalFont(fontId);
    // 已存在的 xterm 实例：改 options 后重排（新建实例时读的是同一变量）。
    const instance = terminalRef.current;
    if (instance) {
      instance.options.fontFamily = document.documentElement.style.getPropertyValue(
        "--font-terminal",
      );
      fitRef.current?.fit();
      updateSuggestAnchor();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontId]);
  /**
   * 捕获命令在 xterm 缓冲里的**起始行**（提交时注册一次）。
   *
   * 命令输出滚出回滚缓冲 / 清屏时 xterm 会把 marker 置为失效（line = -1）
   * 并自动丢弃 —— 快照取不到就由协调器降级（见 consumeTerminalSnapshot），
   * 绝不在错误的行上猜起点。
   */
  const captureMarkerRef = useRef<{ marker: IMarker } | null>(null);
  const releaseCaptureMarker = useCallback(() => {
    const held = captureMarkerRef.current;
    captureMarkerRef.current = null;
    if (held) held.marker.dispose();
  }, []);

  /**
   * 从已渲染的 xterm buffer 提取命令区快照并**消费**（释放）本次的起始行
   * marker。只释放传入的那个 marker —— 异步快照期间可能有新命令提交登记了
   * 新的 marker，绝不能误放别人的。
   */
  const consumeTerminalSnapshot = useCallback(
    (held: { marker: IMarker } | null): RenderOutcome => {
      const instance = terminalRef.current;
      const line = held ? held.marker.line : -1;
      if (held) {
        if (captureMarkerRef.current === held) captureMarkerRef.current = null;
        held.marker.dispose();
      }
      // marker 失效 / 终端已销毁 → { text: null }：协调器走原始流降级。
      if (!instance || line < 0) return { text: null };
      const buffer = instance.buffer.active;
      return {
        text: extractTerminalSnapshot({
          // IBuffer.getLine 返回 undefined，纯函数以 null 为缺省值 —— 包一层。
          buffer: { length: buffer.length, getLine: (index) => buffer.getLine(index) ?? null },
          startLine: line,
        }),
      };
    },
    [],
  );

  const coordinatorRef = useRef<TerminalCommandCoordinator | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = new TerminalCommandCoordinator({
      match: (text) => opsApi.commandMatchText(text),
      onResult: (result) => {
        // 增强终端关着时不产出任何结果面板（含飞行中捕获的迟到结果）。
        if (!enhancedRef.current) return;
        setCommandResults((current) => [...current, result]);
        setActiveResultId(result.id);
        setDrawerCollapsed(false);
        setDrawerClosed(false);
      },
      // 护栏兜底（受控标记始终没来）：主动向终端要一次当前快照。
      captureNow: () => consumeTerminalSnapshot(captureMarkerRef.current),
    });
  }
  useEffect(
    () => () => {
      coordinatorRef.current?.dispose();
      releaseCaptureMarker();
    },
    [releaseCaptureMarker],
  );

  /** 重运行：按**真实风险**门控（详见文件下方的 rerun —— 依赖唯一提交入口）。 */
  const [rerunConfirm, setRerunConfirm] = useState<CapturedResult | null>(null);

  /**
   * 补全候选的"补全并立即执行"也要按**真实风险**门控：
   * `nginx -s reload` / `docker compose restart` 是"需确认"，确认前不写 shell。
   */
  const [runConfirm, setRunConfirm] = useState<{ command: string; risk: SuggestedRisk } | null>(
    null,
  );

  /** 右键 = 顶部工具栏镜像：终端画布上右键可达被滚动/折叠藏起的顶部功能。 */
  const terminalMenu = useContextMenu();

  /**
   * 上一次**填入候选之后**的完整行。
   *
   * 用于实现"再按一次回车 = 执行"：用户在 `cd o` 上按回车 → 补成 `cd opt/`；
   * 行内容没再变过就再按回车 → 这次是执行 `cd opt/`。
   *
   * 不能只靠"候选与已输入一致才执行"来判断：目录补完后行以 `/` 结尾，
   * 面板会立刻去列下一层（异步），**执行还是继续补全取决于网络快慢** ——
   * 同样的操作有时执行有时往下钻，这就是"交互不顺畅"的来源。用"行内容
   * 自上次填入后是否变过"判定，结果与网络时序无关。
   */
  const filledDraftRef = useRef<string | null>(null);

  /** 关闭单个结果 Tab：优先选择右侧相邻，没有则选左侧。 */
  const closeResultTab = (id: string) => {
    setCommandResults((current) => {
      const index = current.findIndex((item) => item.id === id);
      if (index === -1) return current;
      const next = current.filter((item) => item.id !== id);
      setActiveResultId((activeId) => {
        if (activeId !== id) return activeId;
        // 右侧优先，没有则左侧；全部关完 → null（抽屉隐藏）。
        return next[index] ? next[index].id : (next[index - 1]?.id ?? null);
      });
      return next;
    });
  };
  const closeOtherTabs = (id: string) => {
    setCommandResults((current) => current.filter((item) => item.id === id));
    setActiveResultId(id);
  };
  const closeAllTabs = () => {
    setCommandResults([]);
    setActiveResultId(null);
    setDrawerClosed(true);
  };
  /** 终端定位容器（提示面板的 absolute 父元素）。 */
  const suggestWrapperRef = useRef<HTMLDivElement>(null);

  /**
   * 把焦点还给终端（**只在焦点真的丢了的时候**）。
   *
   * 为什么需要：xterm 接收按键的是它的隐藏 `textarea`。一旦焦点落到
   * `body`（浮层里的 `<button>` 被 React 卸载时浏览器就会这么干），xterm
   * 进入失焦态 —— 光标停止闪烁、变成空心框，看起来就是"光标消失了"，
   * 而且接下来敲的字也不进终端。
   *
   * 焦点还在时**不做任何事**：避免无谓的 focus 事件（会重置光标闪烁节奏）。
   */
  const refocusTerminal = useCallback(() => {
    const instance = terminalRef.current;
    if (!instance) return;
    const textarea = containerRef.current?.querySelector("textarea");
    if (document.activeElement === textarea) return;
    instance.focus();
  }, []);
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

  // 补全统一走 `CompletionProvider`：知识库、远程目录（cd）、Docker 资源、
  // 服务、进程、环境生成的命令都是同一个 `CompletionItem`。
  // dismissedDraft = 填入候选或关闭面板时的草稿：相同就不再检索
  // （见 dismissedDraft 注释）。
  const suggestionsEnabled =
    phase === "connected" &&
    !inAlternate &&
    suggestOpen &&
    draft.trim().length > 0 &&
    draft !== dismissedDraft;

  /**
   * 远程 cwd 追踪：每个 TerminalView 实例一份 → **不同 SSH Tab 天然隔离**。
   *
   * 来源优先级：Shell Integration 的 OSC 7 > 跟踪到的 `cd`（且命令真的成功）
   * > 受控 pwd 探测 > 登录目录。绝不用提示符文本猜。
   */
  const cwdTrackerRef = useRef<RemoteCwdTracker | null>(null);
  if (!cwdTrackerRef.current) cwdTrackerRef.current = new RemoteCwdTracker();
  const [cwd, setCwd] = useState<string | null>(null);
  const [remoteHome, setRemoteHome] = useState<string | null>(null);
  const cwdProbeTimerRef = useRef<number | null>(null);
  const cwdProbedRef = useRef(false);

  /** 服务器运行环境（Nginx 在宿主机 / Docker / Compose）：连接后异步探测一次。 */
  const { environment, refresh: refreshEnvironment } = useServerEnvironment(
    sessionId,
    phase === "connected" && !inAlternate,
  );

  /**
   * 手动刷新：目录 / Docker / 服务 / 进程缓存与环境一起失效并重新探测。
   *
   * 只有用户点这里才会重新打 `docker ps` —— 敲字符时一律用缓存（见
   * `useServerEnvironment` 与 `remote-listing`）。
   */
  const refreshEnvironmentCaches = useCallback(() => {
    invalidateDirectoryCache(sessionId);
    invalidateDockerCache(sessionId);
    invalidateServiceCache();
    invalidateProcessCache();
    refreshEnvironment();
  }, [refreshEnvironment, sessionId]);

  const suggestions = useTerminalCompletion({
    sessionId,
    line: draft,
    cursor: draft.length,
    enabled: suggestionsEnabled,
    cwd,
    home: remoteHome,
    environment,
  });

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
        // 光标所在行高：提示面板底部放不下翻到上方时让开整行，
        // 否则候选列表会盖住用户正在敲的命令（看不见自己在打什么）。
        rowHeight: cellHeight,
      });
    });
  }, []);

  /**
   * 命令边界解析器：从输出流里挑出受控标记（OSC 133）并剔除注入行的回显。
   * **必须**在写进 xterm 之前跑，否则用户会看到标记行。
   */
  const boundaryParserRef = useRef<CommandBoundaryParser | null>(null);
  if (!boundaryParserRef.current) boundaryParserRef.current = new CommandBoundaryParser();

  /** 记历史 + `cd` 跟随 —— 任何来源的执行都要留下痕迹。 */
  const noteExecutedCommand = useCallback(
    (command: string) => {
      if (tab.serverId || tab.quickTarget) {
        void opsApi
          .recordHistory(sessionId, tab.serverId ?? "", tab.title, command)
          .catch(() => undefined);
      }
      // `cd` 跟随：文件面板用自己的 cwd 解析参数（支持 cd ~ / cd - / 相对路径）。
      const match = /^cd(?:\s+(.*))?$/.exec(command.trim());
      if (match) {
        const arg = (match[1] ?? "").trim().replace(/^["']|["']$/g, "");
        setFollow((current) => ({ nonce: current.nonce + 1, arg }));
      }
      // `cd` 跟踪：先记下"待定目标"，等 OSC 133 D 的真实退出码确认成功才
      // 真正更新（cd 失败 → 目录没变）。
      cwdTrackerRef.current?.noteCd(sessionId, command);
      // 目录结构被改动的命令 → 远程目录缓存立刻失效：给用户看一份"刚才还
      // 存在、现在已经没了"的候选，比不给补全更糟。
      if (MUTATES_DIRECTORY.test(command)) invalidateDirectoryCache(sessionId);
    },
    [sessionId, tab.quickTarget, tab.serverId, tab.title],
  );

  /**
   * 受控 pwd 探测：前两条来源（OSC 7 / 跟踪的 cd）都没答案时才用。
   *
   * 让 shell 自己用 OSC 7 把 cwd 报回来（不是我们解析提示符）；整行作为
   * 注入行交给边界解析器剔除回显 → 终端里不留可见文字，也不生成结果 Tab。
   * 每个会话最多同时一次，超时后允许下次重试（但绝不循环重试）。
   */
  const requestCwdProbe = useCallback(() => {
    const tracker = cwdTrackerRef.current;
    if (!tracker || cwdProbedRef.current) return;
    if (!tracker.needsProbe(sessionId)) return;
    cwdProbedRef.current = true;
    boundaryParserRef.current?.expect([CWD_PROBE_LINE]);
    void opsApi
      .sshInput(sessionId, `${CWD_PROBE_LINE}\r`)
      .catch(() => undefined)
      .finally(() => {
        if (cwdProbeTimerRef.current !== null) window.clearTimeout(cwdProbeTimerRef.current);
        cwdProbeTimerRef.current = window.setTimeout(() => {
          // 超时没等到 OSC 7：放开一次重试机会（用户下次输入 cd 时再探）。
          cwdProbedRef.current = false;
        }, CWD_PROBE_TIMEOUT_MS);
      });
  }, [sessionId]);

  /**
   * 受控 pwd 探测的时机。
   *
   * **只在命令行是空的时候发**：探测行是写进当前输入行的，用户已经敲了
   * `cd opt` 再发就会变成 `cd opt printf …` —— 那是在破坏他正在输入的
   * 命令，宁可不知道 cwd 也不能这么干。
   *
   * 因此时机是"连接成功后"与"每次命令行被清空/提交之后"（此时 shell 停在
   * 干净的提示符上）。探测本身只输出 OSC 7，不留可见文字。
   */
  useEffect(() => {
    if (phase !== "connected") return;
    if (draft !== "") return;
    // 连接刚建立时 shell 可能还没画出第一个提示符，稍等一下再问。
    const timer = window.setTimeout(requestCwdProbe, 800);
    return () => window.clearTimeout(timer);
  }, [draft, phase, requestCwdProbe]);

  /**
   * **唯一命令提交入口。**
   *
   * 所有来源（用户手动输入 / 结果右键重新运行 / 命令历史重新运行 / 命令
   * 建议执行）都必须经过这里：
   *
   * ```text
   * executeTerminalCommand(command, source)
   *   → coordinator.submit(command, source, plan)   // 开始捕获 + 记边界起点
   *   → 注册 xterm 起始行 marker                     // 快照起点（一次一个）
   *   → sshInput(command + 受控标记)                 // 只写一次
   *   → stdout / stderr 原样累积，只写主 Terminal
   *   → OSC 133 D → D 之前文本写完渲染后截图          // provideRenderedText 汇合
   *   → 新建结果 Tab（默认渲染快照，原始输出调试）
   * ```
   *
   * `options.prefix` 是需要**原样**先发出去的按键数据（用户敲的回车、建议
   * 补全的字符）—— 命令文本就是这么被"敲"进终端的，不能重复发送。
   */
  const executeTerminalCommand = useCallback(
    (
      command: string,
      source: CommandSource,
      options?: { prefix?: string; mode?: SubmitMode },
    ) => {
      const trimmed = command.trim();
      if (!trimmed) return;
      // 未解析占位符绝不进 shell（bash 会当成输入重定向）。
      if (hasUnresolvedPlaceholder(trimmed)) {
        setParamHint(`命令里还有未替换的参数（${trimmed}），请先选择具体值`);
        return;
      }
      const mode: SubmitMode =
        options?.mode ?? (options?.prefix === undefined ? "full" : "line-ready");
      // 增强终端关着 → 不注入受控标记、不捕获输出（命令照常发往 shell）。
      const plan = planCommandSubmission(trimmed, mode, { capture: enhancedRef.current });
      coordinatorRef.current?.submit(trimmed, source, plan);
      boundaryParserRef.current?.expect(plan.markers);
      // 捕获起点：当前光标行 = 命令回显所在行。一次提交只注册一个 marker，
      // 等输出结束后（D 标记 / 兜底）由 consumeTerminalSnapshot 消费释放。
      if (plan.capture) {
        releaseCaptureMarker();
        const instance = terminalRef.current;
        if (instance) {
          const marker = instance.registerMarker(0);
          captureMarkerRef.current = marker ? { marker } : null;
        }
      }
      const prefix = options?.prefix ?? "";
      if (!prefix && !plan.write) return;
      // `line-ready` 依赖调用方把回车一起发出来；没有（如 Ctrl+C 放弃行）
      // 就补一个，否则命令不会被提交。
      const needsSubmit = mode === "line-ready" && prefix.length > 0 && !/[\r\n]$/.test(prefix);
      void opsApi
        .sshInput(sessionId, prefix + (needsSubmit ? "\r" : "") + plan.write)
        .catch(() => undefined);
    },
    [releaseCaptureMarker, sessionId],
  );

  /** 重运行：按**真实风险**门控（只读直接跑；修改型 / 未知必须确认；删除类不提供）。 */
  const rerun = (item: CapturedResult) => {
    if (!item.canExecute) return;
    if (item.mutability === "delete") return; // 删除类走 P4.4 软删除流程
    // 知识库未命中 → `unknown`，同样要确认：绝不把未知命令假装成只读。
    if (item.mutability === "change" || item.mutability === "unknown") {
      setRerunConfirm(item);
      return;
    }
    noteExecutedCommand(item.command);
    executeTerminalCommand(item.command, "rerun");
  };
  const confirmRerun = () => {
    const item = rerunConfirm;
    setRerunConfirm(null);
    if (!item) return;
    noteExecutedCommand(item.command);
    executeTerminalCommand(item.command, "rerun");
  };

  /**
   * 终端实例只创建一次，它的 `onData` 闭包会一直持有首帧的函数。用 ref
   * 让它每次都能拿到**最新**的提交入口（否则切服务器后记历史会记错标题）。
   */
  const commandEntryRef = useRef({
    note: noteExecutedCommand,
    submit: executeTerminalCommand,
  });
  commandEntryRef.current = { note: noteExecutedCommand, submit: executeTerminalCommand };

  /**
   * 把一段文本写进远程 shell 的当前行。
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

  /** 知识库候选（含占位符 → 二级选择器）。见下方 `applySuggestion`。 */
  const applyKnowledgeHit = useCallback(
    (hit: CommandSearchHit): AcceptOutcome => {
      const editor = lineEditorRef.current;
      if (!editor) return "blocked";
      const draft = editor.current;

      // 占位符以后端 `hit.placeholders` 为准（语法解析在 Rust 侧），
      // 前端的空数组只会出现在旧快照上 —— 此时退回前端解析，宁可多拦。
      const hasPlaceholder = hit.placeholders?.length ?? placeholdersIn(hit.syntax).length > 0;
      if (hasPlaceholder) {
        if (!canAutoFill(hit.syntax)) {
          setParamHint("该命令含需要手填的参数，已为你填入命令主体，请自行补全");
          return "blocked";
        }
        setParamPicker({ hit, syntax: hit.syntax, draft });
        setDismissedDraft(draft);
        return "blocked";
      }

      const keys = completionKeys(draft, hit.syntax);
      // 理论上不会为 null（无占位符），仍守住：写不进去就不写，也不执行。
      if (keys === null) return "blocked";
      // **空串 = 候选与已输入内容完全一致**：这次"填入"什么都不会做。
      // 必须如实上报，让调用方把这次回车当成"执行命令"（否则面板会一直
      // 吞掉回车 —— 命令永远发不出去，用户只看到结果面板不出现）。
      if (keys === "") return "noop";
      if (!writeToShell(keys)) return "blocked";
      editor.feed(keys);
      const next = editor.current;
      setDraft(next);
      setDismissedDraft(next);
      // 补完的行记下来：下一次回车若行内容没变，就是执行（见
      // `filledDraftRef` 的说明）。
      filledDraftRef.current = next;
      updateSuggestAnchor();
      return "filled";
    },
    [updateSuggestAnchor, writeToShell],
  );

  /**
   * 接受候选（**只填入，不执行**），并如实上报结果：
   *
   * - `filled` —— 真的往命令行写了东西（第二次回车才执行）；
   * - `noop` —— **候选与当前命令行完全一致**，这次"填入"什么都不会做。
   *   调用方必须把这次回车当成"执行命令"，否则面板会一直吞掉回车；
   * - `blocked` —— 有未替换参数 / 写不进去，本次回车不应执行。
   *
   * 统一 `CompletionItem` 的写入口径：
   * - 知识库候选 → 走原有的占位符 / 二级参数选择流程；
   * - 容器选择器 → 记住本次会话的选择（下次直接给这个容器的命令）；
   * - 其余（远程目录、Docker 资源、服务、进程、环境命令）→ 按
   *   `replaceRange` 退格 + 写入，`insertText` 已转义，可安全进 shell。
   *
   * 目录候选**不写 dismissedDraft** —— 补成 `cd opt/` 后要立刻提示 `opt`
   * 的子目录，否则"继续补全下一层"就断了。
   */
  const applySuggestion = useCallback(
    (item: CompletionItem): AcceptOutcome => {
      const editor = lineEditorRef.current;
      if (!editor) return "blocked";

      if (item.hit) {
        return applyKnowledgeHit(item.hit);
      }
      if (item.container) {
        // 多容器环境：先记住选择，再把容器名写进行里。
        rememberNginxContainer(sessionId, item.container.name);
      }

      const keys = keysForReplace(editor.current, item.replaceRange, item.insertText);
      // 空串 = 替换范围为空且没有要插入的内容（候选与行内已有内容一致）。
      if (keys === "") return "noop";
      if (!writeToShell(keys)) return "blocked";
      editor.feed(keys);
      const next = editor.current;
      setDraft(next);
      // 记下"这次补完的行"：下一次回车若行内容没变，就是执行（见下方
      // `filledDraftRef` 与按键处理）。
      filledDraftRef.current = next;
      // 目录继续提示下一层；其它候选填完就不再打扰（第二次 Enter 才能执行）。
      if (item.type !== "directory") setDismissedDraft(next);
      updateSuggestAnchor();
      return "filled";
    },
    [applyKnowledgeHit, sessionId, updateSuggestAnchor, writeToShell],
  );

  /**
   * 把当前行**当作回车提交**（走唯一入口 `executeTerminalCommand`）。
   *
   * 用于"候选与命令行一致、回车被建议面板接受"的场景：此时用户按回车的
   * 意图就是执行，不该被吞掉。
   */
  const submitCurrentLine = useCallback(() => {
    const editor = lineEditorRef.current;
    const command = editor?.current.trim() ?? "";
    // 提交后行清空，"上次填入的行"就作废了 —— 留着会让下一次补全被
    // 误判成"执行"。
    filledDraftRef.current = null;
    if (!command) return;
    // 与真实回车一致：`feed("\r")` 提交并清空行编辑器。
    editor?.feed("\r");
    setDraft("");
    noteExecutedCommand(command);
    executeTerminalCommand(command, "input", { prefix: "\r" });
  }, [executeTerminalCommand, noteExecutedCommand]);

  /**
   * **执行**候选（区别于 `applySuggestion` 的"只填入不执行"）：补全剩余
   * 字符后**立刻提交**，走唯一入口 `executeTerminalCommand`（→ 标记 → 捕获
   * → 渲染快照 → 结果 Tab）。
   *
   * 补全字符与回车**一次写入**，不做两次 `sshInput` —— 否则标记行可能插到
   * 命令行中间。
   *
   * 风险等级保持真实：环境命令里的 `reload` / `restart` 是"需确认"，
   * 必须先过确认框；删除类压根不会出现在建议里。
   */
  const runSuggestion = useCallback(
    (item: CompletionItem) => {
      const editor = lineEditorRef.current;
      if (!editor) return;
      // 走的是"补完即执行"，行会清空 —— 作废"上次填入的行"。
      filledDraftRef.current = null;

      if (item.hit) {
        const hit = item.hit;
        const hasPlaceholder = hit.placeholders?.length ?? placeholdersIn(hit.syntax).length > 0;
        if (hasPlaceholder) {
          // 还有参数要填 → 走参数选择器流程，绝不带着占位符提交。
          applySuggestion(item);
          return;
        }
        const keys = completionKeys(editor.current, hit.syntax);
        if (keys === null) return;
        editor.feed(keys);
        const line = editor.current;
        setDraft("");
        noteExecutedCommand(line);
        executeTerminalCommand(line, "suggest", { prefix: `${keys}\r` });
        updateSuggestAnchor();
        return;
      }

      const keys = keysForReplace(editor.current, item.replaceRange, item.insertText);
      editor.feed(keys);
      const line = editor.current;
      const risk = item.command?.risk;
      // 修改运行状态 / 危险操作：先确认，再写 shell（绝不自动执行）。
      if (risk === "medium" || risk === "high") {
        setRunConfirm({ command: line, risk });
        return;
      }
      setDraft("");
      noteExecutedCommand(line);
      executeTerminalCommand(line, "suggest", { prefix: `${keys}\r` });
      updateSuggestAnchor();
    },
    [applySuggestion, executeTerminalCommand, noteExecutedCommand, updateSuggestAnchor],
  );

  /** 确认后真正执行（reload / restart 之类改变运行状态的命令）。 */
  const confirmRun = () => {
    const pending = runConfirm;
    setRunConfirm(null);
    if (!pending) return;
    setDraft("");
    noteExecutedCommand(pending.command);
    executeTerminalCommand(pending.command, "suggest");
  };

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
      // Ctrl+Enter：补全候选并**立即执行**（走唯一提交入口 → 结果 Tab）。
      if (event.ctrlKey && (event.key === "Enter" || event.code === "Enter")) {
        const hit = suggestions.items[suggestions.activeIndex];
        if (!hit) return false;
        event.preventDefault();
        runSuggestion(hit);
        return true;
      }
      // 二级选择器打开期间：按键交给它（window 捕获阶段），本层不参与，
      // 否则 ↑↓/Enter 会被两层各处理一次。
      if (paramPickerRef) return false;
      if (event.isComposing || event.keyCode === 229) return false;
      // 补全候选（新 hook 用 `items`；见 use-terminal-completion.ts）。
      const { items, activeIndex, setActiveIndex } = suggestions;
      const action = resolveSuggestKey(
        { key: event.key, isComposing: event.isComposing },
        items.length > 0,
      );
      switch (action.type) {
        case "none":
          return false;
        case "move": {
          event.preventDefault();
          setActiveIndex(
            Math.min(Math.max(activeIndex + action.delta, 0), items.length - 1),
          );
          refocusTerminal();
          return true;
        }
        case "accept": {
          event.preventDefault();
          const hit = items[activeIndex];
          if (!hit) {
            refocusTerminal();
            return true;
          }
          // 上一次回车已经补过、之后用户一个字符都没再敲 → 这次回车就是
          // 执行。判据是"行内容自上次填入后变没变"，与网络快慢无关
          // （详见 `filledDraftRef` 的注释）。
          const currentLine = lineEditorRef.current?.current ?? "";
          if (filledDraftRef.current !== null && filledDraftRef.current === currentLine) {
            filledDraftRef.current = null;
            submitCurrentLine();
            refocusTerminal();
            return true;
          }
          const outcome = applySuggestion(hit);
          // 候选与已输入内容一致 → 这次"填入"是空操作，回车**必须**执行
          // 命令，否则面板会一直吞掉回车（表现为命令没跑、结果面板不出现）。
          if (outcome === "noop") submitCurrentLine();
          // 填入后面板通常会消失（DOM 卸载）→ 焦点可能被丢回 body，
          // 光标会随之"消失"。这里立刻把它还给终端，交互才连贯。
          refocusTerminal();
          return true;
        }
        case "dismiss": {
          event.preventDefault();
          // 关闭面板：记录当前草稿，draft 变化前面板不再出现。
          setDismissedDraft(draft);
          refocusTerminal();
          return true;
        }
      }
    };
  });

  // 面板是**真正**渲染出来的条件（与下方 JSX 保持一致）：
  // TerminalSuggest 自己也会在"没有候选也没有说明"时返回 null。
  const suggestPanelVisible =
    suggestionsEnabled &&
    !paramPicker &&
    (suggestions.items.length > 0 || Boolean(suggestions.notice));

  /**
   * 面板消失 → 焦点还给终端（**真正的修复点**）。
   *
   * 按键处理里那次同步 `refocusTerminal()` 救不了这个场景：React 的状态
   * 更新是异步的，面板 DOM 要等提交之后才卸载；同步时机上焦点还在
   * textarea，"检查→没丢→不管"，紧接着 DOM 卸载才把焦点丢回 body。
   *
   * 所以必须在**提交之后**（这里）捞回来。不捞的后果：xterm 进入失焦态 →
   * 光标停止闪烁、变空心，用户看到的就是"回车选中提示后光标消失了"，
   * 而且接下来敲的字也不再进终端。
   */
  /**
   * 浮层关闭 → 把焦点还给终端。
   *
   * 为什么需要：这些浮层打开时焦点就不在终端了（二级选择器有 `autoFocus`
   * 的筛选框、对话框聚焦确认按钮、历史/文件面板同理）。关闭时浏览器把焦点
   * 丢回 `body` —— xterm 进入失焦态：光标停止闪烁、变空心（用户说的"光标
   * 消失了"），而且**接下来敲的字也不再进终端**。
   *
   * 每个浮层**独立**追踪"开 → 关"，不能合并成一个"任一浮层打开"的布尔
   * 量：文件面板默认就是展开的，合并后它会一直为真，把二级选择器之类的
   * 关闭事件整个挡掉。
   */
  const overlays = {
    paramPicker: Boolean(paramPicker),
    paramHint: Boolean(paramHint),
    runConfirm: Boolean(runConfirm),
    rerunConfirm: Boolean(rerunConfirm),
    selectionMenu: Boolean(selectionMenu),
    history: historyOpen,
    files: filesOpen,
  };
  const overlayStatesRef = useRef<Record<string, boolean>>({});
  useEffect(() => {
    const previous = overlayStatesRef.current;
    overlayStatesRef.current = overlays;
    // 渲染之间**没有**浮层状态数据 → 首次渲染，不处理。
    if (Object.keys(previous).length === 0) return;
    // 关键：React 的状态更新是异步的，浮层 DOM 要等这次提交之后才卸载。
    // 所以必须在**提交之后**（这里）捞，同步时机上焦点还在 textarea，
    // "检查→没丢→不管"，紧接着 DOM 卸载才把焦点丢回 body。
    const closed = (Object.keys(overlays) as (keyof typeof overlays)[]).some(
      (key) => previous[key] && !overlays[key],
    );
    if (closed) refocusTerminal();
  }, [
    overlays.paramPicker,
    overlays.paramHint,
    overlays.runConfirm,
    overlays.rerunConfirm,
    overlays.selectionMenu,
    overlays.history,
    overlays.files,
    filesOpen,
    historyOpen,
    refocusTerminal,
  ]);

  const panelVisibleRef = useRef(false);
  useEffect(() => {
    const wasVisible = panelVisibleRef.current;
    panelVisibleRef.current = suggestPanelVisible;
    // 二级选择器打开时它自己接管键盘（window 捕获阶段），不能把焦点抢回来。
    if (wasVisible && !suggestPanelVisible && !paramPicker) refocusTerminal();
  }, [suggestPanelVisible, paramPicker, refocusTerminal]);

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
        // 登录目录：cwd 的兜底答案（`cd ~`、以及还没探测到时用它）。
        // 只信 SFTP 的 canonicalize 结果 —— 绝不从提示符文本猜。
        void opsApi
          .sftpListDir(sessionId, ".")
          .then((listing) => {
            const home = listing.path;
            if (!home) return;
            setRemoteHome(home);
            cwdTrackerRef.current?.setHome(sessionId, home);
            setCwd((current) => current ?? home);
          })
          .catch(() => undefined);
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
      // 用户真的按了回车（行已提交）→ "上次填入的行"作废，避免下一次
      // 补全被误判成执行。
      if (commands.length > 0) filledDraftRef.current = null;
      // 粘贴多条命令时每条都记历史，但只捕获最后一条（它才会真正产生结果）。
      for (const command of commands) commandEntryRef.current.note(command);
      const submitted = commands[commands.length - 1];
      if (submitted) {
        // 唯一提交入口：命令文本就是靠 `data` 一个字符一个字符"敲"进终端的，
        // 所以按键数据必须原样发出（prefix），提交入口只追加受控标记。
        commandEntryRef.current.submit(submitted, "input", { prefix: data });
      } else {
        void opsApi.sshInput(sessionId, data).catch(() => undefined);
      }
      // A submitted line (or Ctrl+C, which the editor abandons) clears the
      // draft, which in turn hides the suggestion layer.
      setDraft(commands.length > 0 ? "" : (lineEditorRef.current?.current ?? ""));
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
      const output = event.payload;
      // 命令边界解析**必须**先于 xterm：剔除受控标记与注入行回显，同时把
      // OSC 133 事件按原始顺序切进 parts —— 文本写终端、事件决定快照时机。
      const parsed =
        boundaryParserRef.current?.feed(output) ?? {
          text: output,
          events: [],
          parts: [{ kind: "text", text: output }],
        };
      // OSC 7（shell 自己上报的 cwd）：扫**原始**输出，不受边界解析的剔除
      // 影响 —— 这是 cwd 的最可信来源（优先级 1）。
      const reported = cwdTrackerRef.current?.feedOutput(sessionId, output) ?? null;
      if (reported) setCwd(reported);
      // 命令结束（OSC 133 D 带真实退出码）：`cd` 成功才更新 cwd，失败不动。
      for (const event of parsed.events) {
        if (event.type === "output_end") {
          cwdTrackerRef.current?.onCommandEnd(sessionId, event.exitCode);
          setCwd(cwdTrackerRef.current?.get(sessionId) ?? null);
        }
      }
      coordinatorRef.current?.onOutput(parsed.text, parsed.events);
      const notFound = isCommandNotFoundOutput(parsed.text);
      const display = (text: string) => (notFound ? `\x1b[31m命令无效：${text}\x1b[0m` : text);

      // 同步抓住本次结束对应的 marker —— 异步渲染期间可能有新命令提交。
      const heldAtEnd = captureMarkerRef.current;
      // 写出顺序 = 终端输出流水线（见 terminal-output-pipeline.ts）：
      // D 之前写完并渲染完 → 抓快照 → 才写 D 之后的提示符。
      void writeOutputParts(parsed.parts, {
        write: (text) => queueWrite(display(text)),
        flush: () => writeQueue.catch(() => undefined),
        capture: () =>
          coordinatorRef.current?.provideRenderedText(consumeTerminalSnapshot(heldAtEnd)),
      });
      // 远程输出（回显/补全回显）也会移动光标；顺带采样 alternate screen。
      setInAlternate(instance.buffer.active.type !== "normal");
      updateSuggestAnchor();
    });
    // stderr 与 stdout 分开：Rust 侧两条流各有独立的流式解码器，事件也分开，
    // 否则结果的原始输出里永远没有 stderr。写入仍走同一 xterm 队列。
    const unlistenStderr = listen<string>(sshStderrEvent(sessionId), (event) => {
      if (disposed) return;
      const text = event.payload;
      coordinatorRef.current?.onStderr(text);
      // 与 stdout **同一条写入队列**：stderr 事件晚到时也要排在快照之前，
      // 否则它会写进下一个命令的结果，或干脆不进本次快照。
      if (text) void queueWrite(text);
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
      void unlistenStderr.then((fn) => fn());
      void unlistenClosed.then((fn) => fn());
      void opsApi.sshDisconnect(sessionId).catch(() => undefined);
      removeSession(sessionId);
      // 会话结束：该服务器上的目录 / Docker / 服务 / 进程缓存与容器选择全部
      // 失效 —— 重连后环境可能完全不同，留着旧缓存会给出错误的补全。
      invalidateDirectoryCache(sessionId);
      invalidateDockerCache(sessionId);
      invalidateServiceCache();
      invalidateProcessCache();
      invalidateEnvironmentCache(sessionId);
      cwdTrackerRef.current?.forget(sessionId);
      if (cwdProbeTimerRef.current !== null) window.clearTimeout(cwdProbeTimerRef.current);
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

  /**
   * 右键菜单 = 顶部 icon 工具栏的镜像（同样的动作与可见性条件）：
   * 终端画布上右键，可达被滚动/折叠藏起的顶部功能。toggle 类菜单项
   * 用 hint 标注当前展开状态；连接动作按 phase 二选一，与 toolbar 一致。
   */
  const openToolbarMenu = terminalMenu.onContextMenu(() => {
    // xterm 的隐藏 textarea 持有焦点时，菜单的键盘导航（↑↓/Enter）会被
    // 终端当成 shell 按键吞掉 —— 先让它失焦，焦点回到 body。
    containerRef.current?.querySelector("textarea")?.blur();
    const items: ContextMenuItem[] = [
      {
        label: "查找",
        icon: Search,
        hint: searchOpen ? "已展开" : undefined,
        onSelect: () => setSearchOpen((v) => !v),
      },
      {
        label: "垂直分栏",
        icon: Columns2,
        onSelect: () => splitPane(useWorkbenchStore.getState().focusedPaneId ?? "", "horizontal"),
      },
      {
        label: "水平分栏",
        icon: Rows2,
        onSelect: () => splitPane(useWorkbenchStore.getState().focusedPaneId ?? "", "vertical"),
      },
      {
        label: "清空屏幕",
        icon: Eraser,
        onSelect: () => terminalRef.current?.clear(),
      },
      {
        label: "命令历史",
        icon: History,
        hint: historyOpen ? "已展开" : undefined,
        onSelect: () => setHistoryOpen((v) => !v),
      },
      {
        label: "远程文件",
        icon: FolderOpen,
        hint: filesOpen ? "已展开" : undefined,
        onSelect: () => setFilesOpen((v) => !v),
      },
      {
        label: "刷新环境",
        icon: RefreshCw,
        hint: "重新探测 Docker / Nginx",
        disabled: phase !== "connected",
        onSelect: refreshEnvironmentCaches,
      },
    ];
    items.push({
      label: "增强终端",
      icon: Sparkles,
      hint: enhancedTerminal ? "已开启" : undefined,
      onSelect: toggleEnhancedTerminal,
    });
    items.push({ separator: true });
    if (phase === "connected") {
      items.push({
        label: "断开连接",
        icon: Unplug,
        danger: true,
        onSelect: () => {
          void opsApi.sshDisconnect(sessionId).catch(() => undefined);
          setPhase("closed");
          setStatus(sessionId, "closed");
        },
      });
    } else {
      items.push({
        label: "重新连接",
        icon: PlugZap,
        disabled: phase === "connecting",
        onSelect: () => void connect(),
      });
    }
    return items;
  });

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
        {/* 刷新环境：目录 / Docker / 服务 / 进程缓存一起失效并重新探测。
            只有点这里才会重新跑 `docker ps`，敲字符时一律用缓存。 */}
        <ToolbarIcon
          label="刷新环境"
          icon={RefreshCw}
          disabled={phase !== "connected"}
          onClick={refreshEnvironmentCaches}
        />
        {/* 增强终端：关着时终端就是纯终端（不注入标记、无结果面板）；
            打开后命令才会生成结果面板（不另设开关：开了就有、关了就什么都没有）。 */}
        <ToolbarIcon
          label="增强终端"
          icon={Sparkles}
          active={enhancedTerminal}
          onClick={toggleEnhancedTerminal}
        />
        <div className="mx-1 h-4 w-px bg-line" />
        {/* 字体：终端与命令输出共用一套栈（不打包字体，没装则回退）。 */}
        <label className="flex items-center gap-1 text-11 text-fg-muted">
          字体
          <span className="relative inline-flex items-center">
            <select
              value={fontId}
              onChange={(event) => setFontId(event.target.value)}
              className="h-[26px] w-[132px] appearance-none rounded-[7px] border border-line bg-surface-2 pl-2 pr-5 text-11 text-fg outline-none focus:border-accent"
            >
              {TERMINAL_FONTS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <ChevronDown size={12} className="pointer-events-none absolute right-1.5 text-fg-subtle" />
          </span>
        </label>
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
            onClick={() => void copyToClipboard(error)}
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
        <div
          ref={containerRef}
          className="min-h-0 min-w-0 flex-1 overflow-hidden bg-surface-1"
          data-selectable
          onContextMenu={openToolbarMenu}
        />
        {selectionMenu && (
          <TerminalSelectionMenu
            x={selectionMenu.x}
            y={selectionMenu.y}
            text={selectionMenu.text}
            containerRef={suggestWrapperRef}
            onCopy={async (value) => {
              await copyToClipboard(value);
              // 复制完就收起浮层（提示由共用模块继续显示）。
              setSelectionMenu(null);
            }}
          />
        )}
        {historyOpen && (
          <CommandHistoryPanel
            sessionId={sessionId}
            serverId={tab.serverId}
            onPick={(command) => {
              noteExecutedCommand(command);
              executeTerminalCommand(command, "history");
            }}
          />
        )}
        {suggestionsEnabled && !paramPicker && (
          <TerminalSuggest
            items={suggestions.items}
            notice={suggestions.notice}
            activeIndex={suggestions.activeIndex}
            onHover={suggestions.setActiveIndex}
            onApply={applySuggestion}
            onRun={runSuggestion}
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
        {/* 复制提示（选区菜单 / 复制错误信息共用）：绝对定位不占布局，1.5s
            自动消失，不会把终端或结果面板撑大。 */}
        <CopyNotice status={copyStatus} />
      </div>

      {/* 命令结果抽屉：终端内容原样保留，结果面板挂在下方。
          未开启增强终端 / 命令不可捕获（交互式、读 stdin）→ 这里不渲染任何东西。 */}
      {enhancedTerminal && commandResults.length > 0 && !drawerClosed && (
        <TerminalResultDrawer
          results={commandResults}
          activeId={activeResultId}
          collapsed={drawerCollapsed}
          onToggleCollapse={() => setDrawerCollapsed((v) => !v)}
          onSelect={setActiveResultId}
          onClose={() => setDrawerClosed(true)}
          onCloseTab={closeResultTab}
          onCloseOthers={closeOtherTabs}
          onCloseAll={closeAllTabs}
          onRerun={rerun}
        />
      )}
      {rerunConfirm && (
        <ConfirmDialog
          open
          title="重新运行该命令？"
          description={`该命令会修改服务器状态（${
            rerunConfirm.risk ? RISK_META[rerunConfirm.risk].label : "风险未知"
          }）：\n${rerunConfirm.command}`}
          confirmLabel="重新运行"
          onConfirm={confirmRerun}
          onCancel={() => setRerunConfirm(null)}
        />
      )}
      {runConfirm && (
        <ConfirmDialog
          open
          title="执行该命令？"
          description={`该命令会修改服务器运行状态（${
            RISK_META[runConfirm.risk].label
          }）：\n${runConfirm.command}`}
          confirmLabel="执行"
          onConfirm={confirmRun}
          onCancel={() => setRunConfirm(null)}
        />
      )}
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

      {/* 右键菜单（portal 到 body）：终端画布上的 onContextMenu 打开。 */}
      <ContextMenu {...terminalMenu.props} />
    </div>
  );
}
