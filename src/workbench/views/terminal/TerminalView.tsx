import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { useTranslation } from "react-i18next";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyNotice, useCopyFeedback } from "@/components/ui/copy-feedback";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { opsApi, RISK_META, toErrorMessage } from "@/api/ops-api";
import { useDomainStore } from "@/stores/domain-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { RemoteFilePanel } from "@/workbench/views/remote-file/RemoteFilePanel";
import { LineEditor } from "@/lib/terminal-line-editor";
import {
  canAutoFill,
  commandBody,
  completionKeys,
  fillPlaceholder,
  hasUnresolvedPlaceholder,
  placeholdersIn,
} from "@/workbench/views/command-center/complete";
import { ParamPicker } from "./ParamPicker";
import { TerminalResultDrawer } from "./TerminalResultDrawer";
import { TerminalCommandBlocks } from "./TerminalCommandBlocks";
import { TerminalSelectionMenu } from "./terminal-selection-menu";
import type { CommandSearchHit } from "@/api/ops-api";
import type { WorkspaceTab } from "@/workbench/types";
import { CommandHistoryPanel } from "./CommandHistoryPanel";
import { TerminalPicker } from "./TerminalPicker";
import { TerminalSuggest } from "./TerminalSuggest";
import { CommandBoundaryParser } from "./command-boundary";
import { applyTerminalFont, readTerminalFontId, saveTerminalFontId } from "./terminal-font";
import type { Phase } from "./terminal-phase";
import { TerminalErrorBanner } from "./terminal-error-banner";
import { TerminalToolbar } from "./terminal-toolbar";
import { useSshKeepalive } from "./use-ssh-keepalive";
import { useTerminalMenu } from "./use-terminal-menu";
import { useTerminalSearch } from "./use-terminal-search";
import { useTerminalSession, type TerminalCommandEntry } from "./use-terminal-session";
import { useTerminalResults } from "./use-terminal-results";
import {
  ghostTextFor,
  keysForReplace,
  resolveTerminalCompleteKey,
  type SuggestAnchor,
} from "./terminal-suggest";
import { TerminalGhost } from "./terminal-ghost";
import { parseLine } from "./completion/path-input";
import { useTerminalCompletion } from "./use-terminal-completion";
import { useServerEnvironment } from "./use-server-environment";
import { RemoteCwdTracker, CWD_PROBE_LINE, CWD_PROBE_TIMEOUT_MS } from "./remote-cwd";
import { invalidateDirectoryCache } from "./completion/remote-listing";
import { invalidateDockerCache } from "./completion/providers/docker-resource";
import { invalidateServiceCache } from "./completion/providers/service";
import { invalidateProcessCache } from "./completion/providers/process";
import { rememberNginxContainer } from "./completion/providers/environment";
import type { CompletionItem } from "./completion/types";

/**
 * 会改变目录结构的命令。执行后远程目录缓存必须失效 ——
 * 缓存里留着已被 `rm -rf` 删掉的目录，用户就会补出一个不存在的路径。
 */
const MUTATES_DIRECTORY =
  /^\s*(mkdir|rmdir|rm|mv|cp|touch|unlink|ln|install|git\s+clone|tar\s+-?[xj])\b/;

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
  // 回滚缓冲查找（状态与"往后找下一个"的逻辑都在 hook 里）。
  const search = useTerminalSearch(terminalRef);
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
   * 建议面板是否展开（统一补全状态机，见 `terminal-suggest.ts`）：
   * **默认收起 —— 只显示行内 ghost；Tab / ArrowDown 后才展开完整面板**。
   * 用户继续编辑（draft 变化且不是程序性填入）→ 立即回到收起态。
   */
  const [suggestExpanded, setSuggestExpanded] = useState(false);
  /**
   * 程序性草稿标记：`applySuggestion` / 参数选择器写入的行**不算用户编辑**
   * （否则 Tab 填入后 draft 变化会立刻把刚展开的面板又收回去）。draft 每次
   * 变化都会与标记比对：相同 = 程序性写入，保持 expanded；不同 = 用户在
   * 编辑，回 collapsed。
   */
  const programmaticDraftRef = useRef<string | null>(null);
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
  /** 提示条倒计时（秒）：出现即 5s，递减到 0 自动关闭，无需手动点掉。 */
  const [paramHintCountdown, setParamHintCountdown] = useState(0);
  useEffect(() => {
    if (!paramHint) return;
    setParamHintCountdown(5);
    const timer = window.setInterval(() => {
      setParamHintCountdown((v) => {
        if (v <= 1) {
          setParamHint(null);
          return 0;
        }
        return v - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [paramHint, setParamHint]);
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
  const { t } = useTranslation();
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
  // 空输入（含纯空白）不检索也不提示（用户裁决：保持输入区干净）。
  const suggestionsEnabled =
    phase === "connected" && !inAlternate && suggestOpen && draft.trim().length > 0;

  // 展开态的手动编辑 → 回到收起态（ghost）。程序性填入（Tab/选择器写行）
  // 通过 `programmaticDraftRef` 豁免，否则刚展开的面板会被自己收回去。
  useEffect(() => {
    if (programmaticDraftRef.current !== null) {
      if (draft === programmaticDraftRef.current) return;
      programmaticDraftRef.current = null;
    }
    setSuggestExpanded(false);
  }, [draft]);

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

  // 命令结果面板：增强终端开关、捕获起点、结果 Tab 管理与**唯一提交入口**
  // 全部归 `use-terminal-results.ts`（它依赖上面这个 noteExecutedCommand）。
  const results = useTerminalResults({
    sessionId,
    terminalRef,
    boundaryParserRef,
    noteExecutedCommand,
    setParamHint,
  });
  const executeTerminalCommand = results.execute;

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
   * 终端实例只创建一次，它的 `onData` 闭包会一直持有首帧的函数。用 ref
   * 让它每次都能拿到**最新**的提交入口（否则切服务器后记历史会记错标题）。
   */
  const commandEntryRef = useRef<TerminalCommandEntry>({
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
        setParamHint(
          t("The command still has unfilled parameters ({{command}}); please select values for them first", {
            command: text,
          }),
        );
        return false;
      }
      void opsApi.sshInput(sessionId, text).catch(() => undefined);
      return true;
    },
    [sessionId, t],
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
          // 占位符没有数据源（如 unzip 的 <包名.zip>），开不了选择器 ——
          // 但不能把用户晾在原地：把命令主体（第一个占位符之前的字面部分）
          // 填进行里，参数由用户接着手补；可见提示钉在终端**顶部**，
          // 绝不挡住底部正在输入的命令行。
          const body = commandBody(hit.syntax);
          if (draft.startsWith(body)) {
            // 主体已在行上（参数已补或补到一半）→ 这次"填入"无事可做，
            // 回车交还执行（noop 口径），绝不在这里吞成死胡同。
            return "noop";
          }
          const keys = completionKeys(draft, body);
          // 理论不可达（body 不含占位符）；守住：写不进去就不填。
          if (keys === null) return "blocked";
          // writeToShell 失败时自己会给可见提示，这里不再重复。
          if (!writeToShell(keys)) return "blocked";
          editor.feed(keys);
          const next = editor.current;
          programmaticDraftRef.current = next;
          setDraft(next);
          // 填完主体后立刻回车 = 执行（与无参候选口径一致，缺参由 bash
          // 如实报错）；补全参数后再回车同样直接执行。
          filledDraftRef.current = next;
          updateSuggestAnchor();
          setParamHint(
            t("This command has parameters that must be filled manually; the command body has been filled in, please complete the rest"),
          );
          return "blocked";
        }
        setParamPicker({ hit, syntax: hit.syntax, draft });
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
      programmaticDraftRef.current = next;
      setDraft(next);
      // 补完的行记下来：下一次回车若行内容没变，就是执行（见
      // `filledDraftRef` 的说明）。
      filledDraftRef.current = next;
      updateSuggestAnchor();
      return "filled";
    },
    [t, updateSuggestAnchor, writeToShell],
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
      programmaticDraftRef.current = next;
      setDraft(next);
      // 记下"这次补完的行"：下一次回车若行内容没变，就是执行（见下方
      // `filledDraftRef` 与按键处理）。
      filledDraftRef.current = next;
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
        results.setRunConfirm({ command: line, risk });
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
    const pending = results.runConfirm;
    results.setRunConfirm(null);
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
      programmaticDraftRef.current = line;
      setDraft(line);
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
      // 统一补全状态机（见 terminal-suggest.ts）：
      // collapsed（ghost 态）—— Tab/↓ 接受第一条并展开；Enter 执行第一条；
      // expanded（面板态）—— ↑↓ 移动、Enter 执行当前项、Tab/→ 填入当前项；
      // 任何状态 Esc = 清空整行。其余按键穿透给远程 shell。
      const { items, activeIndex, setActiveIndex } = suggestions;
      const action = resolveTerminalCompleteKey(
        { key: event.key, isComposing: event.isComposing },
        { expanded: suggestExpanded, hasItems: items.length > 0 },
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
        case "accept-first": {
          // 接受第一条（ghost 提示的那条）+ 展开完整面板。
          event.preventDefault();
          const first = items[0];
          if (!first) return true;
          const outcome = applySuggestion(first);
          if (outcome === "noop") {
            // 候选与行内一致 → 这次按键是执行意图，不能吞掉。
            submitCurrentLine();
            setSuggestExpanded(false);
          } else if (outcome === "filled") {
            setSuggestExpanded(true);
          }
          // blocked：参数选择器已打开 / 主体已填（手填参数）→ 不展开面板。
          refocusTerminal();
          return true;
        }
        case "accept-active": {
          // 展开态 Tab/→：填入当前高亮（不执行）—— 多级目录 / 继续补参数。
          event.preventDefault();
          const hit = items[activeIndex] ?? items[0];
          if (!hit) return true;
          const outcome = applySuggestion(hit);
          if (outcome === "noop") {
            submitCurrentLine();
            setSuggestExpanded(false);
          } else if (outcome === "blocked") {
            setSuggestExpanded(false);
          }
          // filled → 保持展开：`cd ops/` 后面板立刻提示下一层。
          refocusTerminal();
          return true;
        }
        case "run-first": {
          // 收起态 Enter：直接执行 ghost 提示的第一条（参数/风险流程照走）。
          event.preventDefault();
          const first = items[0];
          if (!first) return true;
          runSuggestion(first);
          setSuggestExpanded(false);
          refocusTerminal();
          return true;
        }
        case "run-active": {
          // 展开态 Enter：执行当前高亮项。
          event.preventDefault();
          const hit = items[activeIndex] ?? items[0];
          if (!hit) return true;
          runSuggestion(hit);
          setSuggestExpanded(false);
          refocusTerminal();
          return true;
        }
        case "clear-line": {
          // Esc（任何状态）：清空整行 + 关闭面板 + 保持终端焦点。
          // 远程发 Ctrl+U（readline 清行），本地 LineEditor 同步清空。
          event.preventDefault();
          writeToShell("\x15");
          lineEditorRef.current?.feed("\x15");
          setDraft("");
          refocusTerminal();
          return true;
        }
      }
    };
  });

  // 面板是**真正**渲染出来的条件（与下方 JSX 保持一致）：
  // 统一状态机 —— 只有 expanded（Tab/ArrowDown 之后）才允许出现完整面板。
  const suggestPanelVisible =
    suggestionsEnabled &&
    suggestExpanded &&
    !paramPicker &&
    (suggestions.items.length > 0 || Boolean(suggestions.notice));

  // 行内 ghost（收起态）：第一条候选的剩余部分 + Tab 徽标。
  // 裸 `cd` 的 ghost 自带前导空格（insertText 里已含）。
  const parsed = parseLine(draft, draft.length);
  const ghostPrefix = parsed && parsed.index > 0 ? parsed.prefix : null;
  const ghostText = suggestionsEnabled
    ? ghostTextFor(suggestions.items[0], draft, ghostPrefix)
    : "";
  const ghostVisible = suggestionsEnabled && !suggestExpanded && !paramPicker && ghostText !== "";

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
    runConfirm: Boolean(results.runConfirm),
    rerunConfirm: Boolean(results.rerunConfirm),
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
        // 连接成功只给一行绿色 i18n 状态，host/fingerprint 等细节不再刷屏。
        instance?.writeln(`\r\n\x1b[32m${t("Connected")}\x1b[0m`);
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
          ? t("The host fingerprint of {{host}} has changed; please confirm before connecting", { host: challengeLabel })
          : t("First connection to {{host}}; please confirm the host fingerprint", { host: challengeLabel }),
      );
      setStatus(sessionId, "error", { error: t("Waiting for host key confirmation") });
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
      instance?.writeln(`\r\n\x1b[31m${t("Connection failed: {{message}}", { message })}\x1b[0m`);
    } finally {
      connectingRef.current = false;
    }
  }, [
    raiseChallenge,
    register,
    sessionId,
    setStatus,
    t,
    tab.credentialId,
    tab.id,
    tab.oneTimePassword,
    tab.quickTarget,
    tab.serverId,
    tab.subtitle,
    tab.title,
    updateTab,
  ]);

  // xterm 实例的创建、输入/输出接线、缩放、选区菜单与断开清理 —— 见
  // `use-terminal-session.ts`（依赖只留 hasTarget / sessionId：换目标或换
  // 会话才重建实例，绝不因为父组件重渲染就把连接拆掉）。
  useTerminalSession({
    containerRef,
    suggestWrapperRef,
    terminalRef,
    fitRef,
    lineEditorRef,
    commandEntryRef,
    filledDraftRef,
    boundaryParserRef,
    cwdTrackerRef,
    coordinatorRef: results.coordinatorRef,
    captureMarkerRef: results.captureMarkerRef,
    selectionMenuTimerRef,
    cwdProbeTimerRef,
    keyHandlerRef,
    sessionId,
    hasTarget,
    consumeTerminalSnapshot: results.consumeTerminalSnapshot,
    updateSuggestAnchor,
    setInAlternate,
    setDraft,
    setCwd,
    setSelectionMenu,
    setPhase,
    setStatus,
    connect: () => void connect(),
    removeSession,
  });

  /** 存活探测判定断线后的落地：切状态，并在终端里写一行（用户看得到）。 */
  const handleConnectionLost = useCallback(
    (message: string) => {
      setPhase("closed");
      setError(message);
      setStatus(sessionId, "closed", { error: message });
      terminalRef.current?.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
    },
    [sessionId, setStatus],
  );

  /** 主动断开（工具栏按钮与右键菜单共用同一条路径）。 */
  const disconnect = useCallback(() => {
    void opsApi.sshDisconnect(sessionId).catch(() => undefined);
    setPhase("closed");
    setStatus(sessionId, "closed");
  }, [sessionId, setStatus]);

  // 只在真的连着的时候探测：服务端可能早就关了，UI 不能继续显示"活着"。
  useSshKeepalive({ phase, sessionId, onLost: handleConnectionLost });



  // 右键菜单 = 顶部 icon 工具栏的镜像（同一组动作与可见性条件）：终端画布上
  // 右键，可达被滚动/折叠藏起的顶部功能。菜单项构建见 `use-terminal-menu.ts`。
  const openToolbarMenu = useTerminalMenu(terminalMenu, containerRef, {
    searchOpen: search.open,
    historyOpen,
    filesOpen,
    phase,
    enhancedTerminal: results.enhanced,
    onToggleSearch: () => search.setOpen((v) => !v),
    onSplit: (direction) => splitPane(useWorkbenchStore.getState().focusedPaneId ?? "", direction),
    onClear: () => terminalRef.current?.clear(),
    onToggleHistory: () => setHistoryOpen((v) => !v),
    onToggleFiles: () => setFilesOpen((v) => !v),
    onRefreshEnvironment: refreshEnvironmentCaches,
    onToggleEnhanced: results.toggleEnhanced,
    onDisconnect: disconnect,
    onReconnect: () => void connect(),
  });

  if (!hasTarget) {
    return <TerminalPicker tabId={tab.id} servers={servers} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-row bg-surface-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <TerminalToolbar
        phase={phase}
        searchOpen={search.open}
        searchQuery={search.query}
        searchState={search.state}
        historyOpen={historyOpen}
        filesOpen={filesOpen}
        enhancedTerminal={results.enhanced}
        fontId={fontId}
        onToggleSearch={() => search.setOpen((v) => !v)}
        onSearchQueryChange={search.setQuery}
        onSearch={search.run}
        onSplit={(direction) => splitPane(useWorkbenchStore.getState().focusedPaneId ?? "", direction)}
        onClear={() => terminalRef.current?.clear()}
        onToggleHistory={() => setHistoryOpen((v) => !v)}
        onToggleFiles={() => setFilesOpen((v) => !v)}
        onRefreshEnvironment={refreshEnvironmentCaches}
        onToggleEnhanced={results.toggleEnhanced}
        onFontChange={setFontId}
        onDisconnect={disconnect}
        onReconnect={() => void connect()}
      />

      {error && (
        <TerminalErrorBanner
          message={error}
          onCopy={() => void copyToClipboard(error)}
          onRetry={() => void connect()}
        />
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
        {/* 命令块悬浮复制（增强终端产出）：alternate screen（vim/less）下
            缓冲行语义完全不同，不参与。 */}
        {!inAlternate && results.commandBlocks.length > 0 && (
          <TerminalCommandBlocks
            blocks={results.commandBlocks}
            terminalRef={terminalRef}
            containerRef={containerRef}
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
        {ghostVisible && suggestAnchor && (
          <TerminalGhost
            text={ghostText}
            anchor={suggestAnchor}
            terminal={terminalRef.current}
          />
        )}
        {suggestPanelVisible && (
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
        {/* 参数提示钉在**顶部**：命令行通常在终端底部，钉底部会正好盖住
            正在输入的行。整条 pointer-events-none（只有"知道了"可点），
            顶部那两行终端内容照常可点可选，不干扰正常输入。 */}
        {paramHint && (
          <div className="pointer-events-none absolute left-1.5 right-1.5 top-0.5 z-30 flex items-center gap-2 rounded-[8px] border border-warning/40 bg-surface-1 px-2.5 py-1.5 text-11 text-warning shadow-sm">
            <span className="min-w-0 flex-1 truncate">{paramHint}</span>
            <span className="shrink-0 text-warning/70">
              {t("Closes in {{seconds}}s", { seconds: paramHintCountdown })}
            </span>
          </div>
        )}
        {/* 复制提示（选区菜单 / 复制错误信息共用）：绝对定位不占布局，1.5s
            自动消失，不会把终端或结果面板撑大。 */}
        <CopyNotice status={copyStatus} />
      </div>

      {/* 命令结果抽屉：终端内容原样保留，结果面板挂在下方。
          未开启增强终端 / 命令不可捕获（交互式、读 stdin）→ 这里不渲染任何东西。 */}
      {results.enhanced && results.results.length > 0 && !results.drawerClosed && (
        <TerminalResultDrawer
          results={results.results}
          activeId={results.activeId}
          collapsed={results.drawerCollapsed}
          onToggleCollapse={() => results.setDrawerCollapsed((v) => !v)}
          height={results.drawerHeight}
          onHeightChange={results.setDrawerHeight}
          onSelect={results.setActiveId}
          onClose={() => results.setDrawerClosed(true)}
          onCloseTab={results.closeTab}
          onCloseOthers={results.closeOthers}
          onCloseAll={results.clearAll}
          onRerun={results.rerun}
        />
      )}
      {results.rerunConfirm && (
        <ConfirmDialog
          open
          title={t("Rerun this command?")}
          description={t("This command will modify the server state ({{risk}}):\n{{command}}", {
            risk: results.rerunConfirm.risk
              ? RISK_META[results.rerunConfirm.risk].label
              : t("Unknown risk"),
            command: results.rerunConfirm.command,
          })}
          confirmLabel={t("Rerun")}
          onConfirm={results.confirmRerun}
          onCancel={() => results.setRerunConfirm(null)}
        />
      )}
      {results.runConfirm && (
        <ConfirmDialog
          open
          title={t("Run this command?")}
          description={t("This command will modify the server run state ({{risk}}):\n{{command}}", {
            risk: RISK_META[results.runConfirm.risk].label,
            command: results.runConfirm.command,
          })}
          confirmLabel={t("Run")}
          onConfirm={confirmRun}
          onCancel={() => results.setRunConfirm(null)}
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
