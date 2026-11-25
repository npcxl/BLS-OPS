import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfigProvider } from "antd";
import { useTranslation } from "react-i18next";
import { opsApi } from "@/api/ops-api";
import type {
  AgentStep,
} from "@/api/types/agent";
import AeroShards from "@/components/backgrounds/aero-shards";
import ShapeWaves from "@/components/backgrounds/shape-waves";
import { isMacOS } from "@/lib/platform";
import { toAppError } from "@/lib/app-error";
import { cn } from "@/lib/cn";
import {
  effectiveModelSetting,
  mergedModelSettings,
  useExtremeStore,
  type ExtremeMessage,
} from "@/stores/extreme-store";
import { useExtremeSettingsStore } from "@/stores/extreme-settings-store";
import { useDomainStore } from "@/stores/domain-store";
import {
  effectivePermission,
  useExtremePermissionsStore,
} from "@/stores/extreme-permissions-store";
import { enterExtremeForServer } from "./enter-extreme";
import FilePreviewModal from "@/workbench/views/preview/FilePreviewModal";
import { ComposerPanel } from "./ComposerPanel";
import { WorkspacePanel } from "./WorkspacePanel";
import { ManualTerminal } from "./ManualTerminal";
import { Tooltip } from "@/components/ui/tooltip";
import {
  disposeAllManualShells,
  disposeManualShell,
  ensureManualShell,
  manualShellSend,
  manualShellTail,
} from "./manual-shell";
import {
  panelTitle,
  probeCommand as panelProbeCommand,
  probeSucceeded,
  type PanelRequest,
} from "./panel-target";
import {
  ambiguityQuestion,
  discoveryCommand,
  parseCandidates,
  pickLogSource,
} from "./log-discovery";
import type { LogSource } from "@/api/types/panel";

/** 新建会话时的默认输入偏好。 */
const DEFAULT_CHAT_PREFS = {
  context: "session" as const,
  output: "auto" as const,
  picked: [],
  providerId: null,
};
import { TaskHistoryPanel } from "./TaskHistoryPanel";
import { BrowserPane } from "./BrowserPane";
import { LogsPane } from "./LogsPane";
import { activeLogFor, useLogStreamStore } from "./log-stream-store";
import { blockedWorkspaces, type TaskCardModel } from "./task-view";
import { cardFromAgent } from "./agent-steps";
import {
  forgetAgentWait,
  waitForAgentRun,
} from "./agent-run";
import { ExtremeHeader } from "./ExtremeHeader";
import { ServiceCandidates } from "./ServiceCandidates";
import { WelcomeIntro } from "./WelcomeIntro";
import { TaskSidebar, type RailPage } from "./TaskSidebar";
import { ExtremeSettingsPage } from "./view/ExtremeSettingsPage";
import { ExtremePermissionsPage } from "./view/ExtremePermissionsPage";
import { ExtremeMcpPage } from "./view/ExtremeMcpPage";
import { useMcpCapabilities } from "./view/use-mcp-capabilities";
import { RemoteWorkspacePanel, type WorkspaceTarget } from "./RemoteWorkspacePanel";
import { createScopeTracker, type RequestScope, type ScopeTracker } from "./request-scope";
import {
  checkScope,
  explainBlocker,
  scopeForeground,
  type ActionScope,
  type ScopeWorld,
} from "./action-scope";
import { sendsFor, type QueuedSend } from "./send-queue";
import { SendQueuePanel } from "./SendQueuePanel";
import { useChatScroll } from "./use-chat-scroll";
import { runReport } from "./execution-report";
import type { CheckItem } from "./checks";
import { checksFromProbe, parseProbe, probeCommand } from "./probe-runner";
import type { PermissionMode } from "./permissions";
import {
  effectiveProvider,
  effortParam,
  modelKey,
  normalizeEfforts,
  type ModelSelection,
  type ProviderChoice,
} from "./model-choice";
import { antdThemeFor } from "./theme";
import { runPreflight, type PreflightResult } from "./preflight";
import type { ServiceCandidate } from "./update-plan";
import { deriveRunState, runStateLabel } from "./run-state";
import {
  headlineFor,
  shouldPlan,
  stepsFromExecution,
  type RunRecord,
  type RunStatus,
} from "./run-plan";
import "./extreme-core.css";
import { focusComposerEnd, quoteBlock } from "./view/helpers";
import { approvalKeyOf, type ActionResult } from "./view/types";
import { anchoredSteps, latestPlan, planForTask } from "./message-parts";
import { CommandOutput } from "./view/CommandOutput";
import { useApprovalEntries } from "./view/use-approval-entries";
import { useApprovalActions } from "./view/use-approval-actions";
import { usePane } from "./view/use-pane";
import { useAttachments } from "./view/use-attachments";
import { useDeployActions } from "./view/use-deploy-actions";
import { useAsk } from "./view/use-ask";
import { ChatColumn } from "./view/ChatColumn";
import { FileChangesPane } from "./FileChangesPane";
import { StatusStack } from "./view/StatusStack";
import { useAgentStream } from "./view/use-agent-stream";

/**
 * Work模式 —— **应用级工作台**（整个窗口切换）。
 *
 * 挂在 `App` 最外层（`fixed inset-0`），覆盖标题栏以下的全部区域：Work开启时
 * 底层终端仍然挂载（SSH 会话、滚动、草稿都不丢），只是被盖住。
 *
 * 布局：左侧会话 / 附件 / 任务，中间对话与部署过程，右侧按需展开预检、步骤、
 * 日志（默认收起，让对话有足够宽度）。状态在 `useExtremeStore` 里，所以退出
 * Work或切服务器时，任务与对话都还在。
 */

export function ExtremeCoreView() {
  const { t, i18n } = useTranslation();
  const active = useExtremeStore((state) => state.active);
  /** 服务器配置 id：同名服务器 / 同地址不同账号靠它区分。 */
  const serverId = useExtremeStore((state) => state.serverId);
  const server = useExtremeStore((state) => state.server);
  const serverHost = useExtremeStore((state) => state.serverHost);
  /** 当前绑定的 SSH 连接；`null` = 这条对话所属服务器现在没有可用连接。 */
  const sessionId = useExtremeStore((state) => state.sessionId);
  const messages = useExtremeStore((state) => state.messages);
  const workspaces = useExtremeStore((state) => state.workspaces);
  const workspaceId = useExtremeStore((state) => state.workspaceId);
  const openWorkspace = useExtremeStore((state) => state.openWorkspace);
  const addWorkspace = useExtremeStore((state) => state.addWorkspace);
  const renameWorkspace = useExtremeStore((state) => state.renameWorkspace);
  const removeWorkspace = useExtremeStore((state) => state.removeWorkspace);
  const addFolders = useExtremeStore((state) => state.addFolders);
  const model = useExtremeStore((state) => state.model);
  const [workspaceTarget, setWorkspaceTarget] = useState<WorkspaceTarget | null>(null);
  /** 任务历史「打开原对话」的落点：切过去后滚到发起这条任务的消息。 */
  const [historyFocus, setHistoryFocus] = useState<{
    workspaceId: string;
    taskId: string;
  } | null>(null);
  /**
   * 任务执行中发送一句话时走哪条路：
   * * `steer` —— **补充给当前任务**，下一步开始前生效（默认）；
   * * `queue` —— **完成后发送**，进入这条对话的队列，等它空闲后按顺序发。
   */
  // 执行中再发一条默认进队列：用户明确要"一条一条来"，不再悄悄并进当前任务。
  const [sendWhileRunning, setSendWhileRunning] = useState<"steer" | "queue">("queue");
  /**
   * 「完成后发送」的队列（store 里按对话分桶）。
   *
   * 只显示**当前这条对话**的项；派发在后台按对话各自进行，切走也照常发。
   */
  const queuedSends = useExtremeStore((state) => state.queuedSends);
  const queueSend = useExtremeStore((state) => state.queueSend);
  const dropSend = useExtremeStore((state) => state.dropSend);
  const moveSendUp = useExtremeStore((state) => state.moveSendUp);
  const failSend = useExtremeStore((state) => state.failSend);
  const retrySend = useExtremeStore((state) => state.retrySend);
  const patchWorkspaceContext = useExtremeStore((state) => state.patchWorkspaceContext);
  const connections = useExtremeStore((state) => state.connections);
  const currentQueue = useMemo(() => sendsFor(queuedSends, workspaceId), [queuedSends, workspaceId]);
  /** 编辑排队项：取回队列、放回输入框与勾选，改完重新发送（会排到队尾）。 */
  const editQueuedSend = (item: QueuedSend) => {
    dropSend(item.id);
    setDraft(draft.trim() ? `${draft}\n${item.text}` : item.text);
    setSelectedAttachmentIds((ids) => [
      ...new Set([...ids, ...item.attachments.map((file) => file.id)]),
    ]);
    requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>(".extreme-core textarea")?.focus();
    });
  };

  /*
   * 手动终端的 PTY 通道跟着会话走：
   * - 换会话时关掉上一条 channel（远端 shell 不会留着）；
   * - 组件卸载（退出超能）时把所有通道一起释放。
   * 切右栏标签不会触发这两条 effect，输入与回显保留。
   */
  useEffect(() => {
    const id = workspaceId;
    return () => {
      if (id) disposeManualShell(id);
    };
  }, [workspaceId]);
  useEffect(() => () => disposeAllManualShells(), []);

  const plan = useExtremeStore((state) => state.plan);
  const planSession = useExtremeStore((state) => state.planSession);
  const notice = useExtremeStore((state) => state.notice);
  const panelOpen = useExtremeStore((state) => state.panelOpen);

  const panelTarget = useExtremeStore((state) => state.panelTarget);
  const openPanel = useExtremeStore((state) => state.openPanel);
  const browserByWorkspace = useExtremeStore((state) => state.browserByWorkspace);
  const setBrowserUrl = useExtremeStore((state) => state.setBrowserUrl);
  const logSourceByWorkspace = useExtremeStore((state) => state.logSourceByWorkspace);
  const setLogSource = useExtremeStore((state) => state.setLogSource);
  const setRemotePath = useExtremeStore((state) => state.setRemotePath);
  const [askError, setAskError] = useState<string | null>(null);
  const {
    paneTab,
    paneLists,
    closePane,
    paneView,
    terminalPane,
    setPaneTab,
    setPaneView,
    setPaneWidth,
    setPaneDragging,
    setTerminalPane,
    paneShown,
    pendingChangeCount,
    openPaneTab,
    changeFocus,
    openChanges,
    collapsePane,
    togglePane,
    rowRef,
    railRef,
    paneFit,
    paneOverlay,
    onPaneOuterDragStart,
  } = usePane({ workspaceId, setAskError });
  /**
   * 任务历史「打开原对话」：切过去后滚到**发起这条任务的那条消息**，
   * 同时把右栏切到执行输出，用户不用再从长对话里自己找。
   */
  useEffect(() => {
    if (!historyFocus || historyFocus.workspaceId !== workspaceId) return;
    const message = messages.find((item) => item.taskId === historyFocus.taskId);
    if (!message) return;
    openPaneTab("terminal", "output");
    const timer = window.setTimeout(() => {
      document
        .getElementById(`extreme-message-${message.id}`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 120);
    setHistoryFocus(null);
    return () => window.clearTimeout(timer);
  }, [historyFocus, messages, openPaneTab, workspaceId]);

  /** 桌面通知点击：切到所属对话后定位到那条任务的消息（只消费一次）。 */
  const focusTaskId = useExtremeStore((state) => state.focusTaskId);
  const setFocusTaskId = useExtremeStore((state) => state.setFocusTaskId);
  useEffect(() => {
    if (!focusTaskId || !active) return undefined;
    const message = messages.find((item) => item.taskId === focusTaskId);
    if (!message) return undefined;
    const timer = window.setTimeout(() => {
      document
        .getElementById(`extreme-message-${message.id}`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 120);
    setFocusTaskId(null);
    return () => window.clearTimeout(timer);
  }, [active, focusTaskId, messages, setFocusTaskId]);

  /** 文件变更摘要：事件与右栏查询都写进 store（正文按需加载）。 */
  const mergeFileChange = useExtremeStore((state) => state.mergeFileChange);
  const logStream = useLogStreamStore((state) => activeLogFor(state, workspaceId));
  /** 输入框底栏：上下文范围 / 输出形态 / 自选材料（按会话记忆）。 */
  const chatPrefs = useExtremeStore((state) => state.chatPrefs);
  const followLatest = useExtremeSettingsStore((state) => state.followLatest);
  const motionMode = useExtremeSettingsStore((state) => state.motion);
  const setContextMode = useExtremeStore((state) => state.setContextMode);
  const setOutputStyle = useExtremeStore((state) => state.setOutputStyle);
  const removePicked = useExtremeStore((state) => state.removePicked);
  const addPicked = useExtremeStore((state) => state.addPicked);
  const setProviderId = useExtremeStore((state) => state.setProviderId);
  /** 按模型记住的上下文预算与思考强度（模型默认 + 当前会话覆盖）。 */
  const baseModelSettings = useExtremeStore((state) => state.modelSettings);
  const modelOverrides = useExtremeStore((state) => state.modelSettingsByWorkspace);
  const modelSettings = useMemo(
    () =>
      mergedModelSettings({
        workspaceId,
        modelSettings: baseModelSettings,
        modelSettingsByWorkspace: modelOverrides,
      }),
    [workspaceId, baseModelSettings, modelOverrides],
  );
  const setModelSetting = useExtremeStore((state) => state.setModelSetting);
  /** 已配置且启用的模型（底栏「模型」菜单用）。 */
  const [providers, setProviders] = useState<ProviderChoice[]>([]);
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    // 读不到就保持空列表（菜单里只剩「默认模型」），不影响对话。
    void (async () => {
      try {
        const list = await opsApi.aiProviderList();
        if (cancelled || !Array.isArray(list)) return;
        setProviders(
          list
            .filter((item) => item.enabled)
            .map((item) => ({
              id: item.id,
              name: item.name,
              model: item.model,
              isDefault: item.is_default,
              updatedAt: item.updated_at,
              // 能力由后端给：预算档位与窗口都照抄，未知时界面只显示「自动」。
              contextWindow: item.context_window ?? 0,
              budgets: item.context_budgets ?? [],
              efforts: normalizeEfforts(item.reasoning_efforts),
              // 内置表与用户声明都没覆盖到这个模型：界面必须说明，
              // 否则「只有默认 / 只有自动」会被当成 bug。
              capabilityKnown: item.capability_known ?? true,
            })),
        );
      } catch {
        // 忽略：没有配置模型时后端本身会给出明确错误。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);
  const executing = useExtremeStore((state) => state.executing);
  const setExecutingFor = useExtremeStore((state) => state.setExecutingFor);

  const exit = useExtremeStore((state) => state.exit);
  const pushMessage = useExtremeStore((state) => state.pushMessage);
  const setMessages = useExtremeStore((state) => state.setMessages);
  const setAttachments = useExtremeStore((state) => state.setAttachments);
  /** 按**对话**回写附件：后台动作（上传完成）不能写进当前镜像。 */
  const setAttachmentsIn = useExtremeStore((state) => state.setAttachmentsIn);
  const setPlan = useExtremeStore((state) => state.setPlan);
  const setPlanSession = useExtremeStore((state) => state.setPlanSession);
  const updatePlan = useExtremeStore((state) => state.updatePlan);
  const setNotice = useExtremeStore((state) => state.setNotice);
  const {
    attachments,
    selectedAttachmentIds,
    setSelectedAttachmentIds,
    composerAttachments,
    preview,
    setPreview,
    filePreview,
    setFilePreview,
    focusId,
    setFocusId,
    addFiles,
    collectDropped,
    handlePreview,
    handleRemoveAttachment,
    handleAttachmentRemove,
    openArtifact,
    handleAttachmentPreview,
    handleAddToChat,
    addTerminalOutput,
    handleAddRemoteToChat,
  } = useAttachments({ workspaceId, sessionId, t, setAttachments, setNotice, addPicked, openPaneTab });
  const setModel = useExtremeStore((state) => state.setModel);
  const patchMessage = useExtremeStore((state) => state.patchMessage);
  const patchMessageIn = useExtremeStore((state) => state.patchMessageIn);
  const pushMessageTo = useExtremeStore((state) => state.pushMessageTo);
  const removeMessageIn = useExtremeStore((state) => state.removeMessageIn);
  const setDraftText = useExtremeStore((state) => state.setDraftText);
  const setPanelOpen = useExtremeStore((state) => state.setPanelOpen);
  const upsertTask = useExtremeStore((state) => state.upsertTask);
  const upsertReport = useExtremeStore((state) => state.upsertReport);
  const tasks = useExtremeStore((state) => state.tasks);

  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [, setPreflightError] = useState<string | null>(null);
  /**
   * 草稿：本地态 + store 双写。
   *
   * 本地态保证输入不卡；store 负责"切走再回来还在"（每条对话各自一份）。
   */
  const [draft, setDraftState] = useState(() => useExtremeStore.getState().draft);
  const setDraft = useCallback(
    (value: string) => {
      setDraftState(value);
      setDraftText(value);
    },
    [setDraftText],
  );
  const [asking, setAsking] = useState(false);
  /**
   * 每结束一次运行就 +1，用来唤醒「完成后发送」的派发。
   *
   * `inFlightRef` 是 ref，清掉它不会触发重渲染 —— 而 `setAsking(false)` 可能
   * 在终态事件里就已经发生了，effect 再跑时 inFlight 还在，于是那条对话的
   * 队列就永远卡住。这个计数器保证"结束之后一定会再判断一次"。
   */
  const [runEpoch, setRunEpoch] = useState(0);
  /**
   * 任务级用量：按 taskId 存在 store 里（并落盘）。
   *
   * 不从组件 state 走：切会话、退出再进都要能按当前任务取回来，任务结束后
   * 也要保留最终值。
   */
  const taskUsage = useExtremeStore((state) => state.taskUsage);
  const setTaskUsage = useExtremeStore((state) => state.setTaskUsage);
  const unread = useExtremeStore((state) => state.unread);
  const historyError = useExtremeStore((state) => state.historyError);
  const dismissHistoryError = useExtremeStore((state) => state.dismissHistoryError);
  /**
   * 两阶段停止：点了停止 → 记下 taskId（显示"正在停止"），
   * 直到后端给出终态事件才移除。**不能**在点下去的瞬间就显示"已停止"。
   *
   * 按 taskId 记而不是一个布尔：A 在停止时切到 B，B 不该跟着显示"正在停止"。
   */
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(() => new Set());
  /**
   * 停止已发出、后端迟迟没有确认的 taskId。
   *
   * 只在这种时候才出现「强制结束」：正常停止的几秒里不该让用户误点，把一个
   * 其实能正常收尾的任务硬砍掉。
   */
  const [stopOverdueId, setStopOverdueId] = useState<string | null>(null);
  /**
   * 每条运行进入"正在停止"的时刻。
   *
   * 后端可能因为一条长命令迟迟不确认；超过 8 秒就把「强制结束」摆出来，用户
   * 不必无限重试。用 ref + 一个全局 interval（而不是每个任务一个 setTimeout）：
   * 切走 / 卸载时不会留下孤儿定时器。
   */
  const stoppingSinceRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    for (const id of [...stoppingSinceRef.current.keys()]) {
      if (!stoppingIds.has(id)) stoppingSinceRef.current.delete(id);
    }
    if (stoppingIds.size === 0) return undefined;
    const now = Date.now();
    for (const id of stoppingIds) {
      if (!stoppingSinceRef.current.has(id)) stoppingSinceRef.current.set(id, now);
    }
    const timer = window.setInterval(() => {
      const at = Date.now();
      const overdue = [...stoppingIds].find(
        (id) => at - (stoppingSinceRef.current.get(id) ?? at) > 8000,
      );
      if (overdue) setStopOverdueId((current) => current ?? overdue);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [stoppingIds]);
  /**
   * 部署计划已请求停止、当前步骤还没跑完。
   *
   * 与 Agent 的两阶段停止分开：计划是本地循环（`stopRef`），没有后端确认，
   * 但同样要"点了就显示正在停止"，否则用户会以为没点上而连按。
   */
  const [planStopping, setPlanStopping] = useState(false);
  /** 计划跑完 / 被中止：把"正在停止"收掉，停止键回到发送键。 */
  useEffect(() => {
    if (!executing) setPlanStopping(false);
  }, [executing]);
  /**
   * 有歧义的日志来源（Docker 的 nginx 与 systemd 的 nginx 同时存在）。
   *
   * 只问一句；用户回答里点到哪个就开哪个，点不清就再问一次。
   *
   * **带归属**：候选是 A 问出来的，B 里的一句短回复（"1" / "n"）不能被当成
   * 在回答 A —— 同一台服务器上的两条对话共用连接，光看 `sessionId` 分不出。
   */
  const [logChoices, setLogChoices] = useState<
    { scope: RequestScope; choices: LogSource[] } | null
  >(null);
  /**
   * 异步探测（日志来源 / 面板目标）的归属号：只有发起它的那条对话、那次连接
   * 还在前台时，结果才允许落界面。
   */
  const scopeTracker = useRef<ScopeTracker | null>(null);
  if (!scopeTracker.current) scopeTracker.current = createScopeTracker();
  /**
   * 后台对话的待打开面板：探测完成时它不在前台，就记下来，**切回去再开**。
   *
   * 结果归发起的对话（消息也写回它自己那条），既不丢掉、也不弹到别人脸上。
   */
  const pendingPanelRef = useRef<Map<string, PanelRequest & { scope: RequestScope }> | null>(null);
  if (!pendingPanelRef.current) pendingPanelRef.current = new Map();
  /** 事件丢失 / 快照超时：这次运行的进度不明，需要重新核对。 */
  const [staleTaskId, setStaleTask] = useState<string | null>(null);
  const staleTask = staleTaskId && tasks[staleTaskId]?.workspaceId === workspaceId ? staleTaskId : null;
  const [retryMessage, setRetryMessage] = useState<ExtremeMessage | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  /**
   * 主内容区当前打开的管理页；null = 聊天。
   *
   * 页面在 main 里切换，但聊天组件保持挂载（用 hidden 隐藏），这样返回时
   * 草稿、滚动位置和右栏都不重置；后台任务也照常继续。
   */
  const [mainView, setMainView] = useState<RailPage | null>(null);
  /** MCP 页默认标签：从输入区「打开市场 / 管理连接」进来时直达对应页。 */
  const [mcpTab, setMcpTab] = useState<"market" | "connections">("market");
  /**
   * 正文最多占聊天区约三分之一（按行高 ~24px 折算）。
   *
   * 超过后在输入框**内部**滚动，底部四个控件始终留在原位。
   */
  const [composerMaxRows, setComposerMaxRows] = useState(8);
  useEffect(() => {
    const update = () => {
      const rows = Math.floor((window.innerHeight * 0.33) / 24);
      setComposerMaxRows(Math.max(4, Math.min(16, rows)));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const {
    approvalEntries,
    approvalEntriesRef,
    currentApprovals,
    approval,
    decideApprovalRef,
    setApprovalEntry,
    updateApprovalEntry,
    dropApprovals,
    dropClosedApprovals,
  } = useApprovalEntries(tasks, workspaceId);
  /*
   * 审批画在**对应步骤**上：时间线里已有的步骤不再往输入框上方放一张卡，
   * 否则同一件事要确认两遍，状态也会两处各说各话。
   */
  const inlineApprovalKeys = useMemo(() => anchoredSteps(messages), [messages]);
  const composerApprovals = useMemo(
    () =>
      currentApprovals.filter(
        (entry) =>
          !inlineApprovalKeys.has(`${entry.approval.taskId}:${entry.approval.stepIndex}`),
      ),
    [currentApprovals, inlineApprovalKeys],
  );
  /**
   * 当前是否深色主题。
   *
   * antd 的算法不读 CSS 变量，只能靠它显式切 `darkAlgorithm` /
   * `defaultAlgorithm`；用 MutationObserver 跟住 `data-theme` 的变化，
   * 用户在设置里切换主题时Work内的弹窗、输入框也会跟着变。
   */
  const [dark, setDark] = useState(
    () => document.documentElement.dataset.theme !== "light",
  );
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDark(root.dataset.theme !== "light");
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  /**
   * 服务器上的**临时工作目录**（空 = 还没上传）。
   *
   * 拖进来的文件默认只在本机读取：二进制读不到内容，超大项目也读不全。
   * 点「上传到服务器」后，所有附件按原目录结构落到这个目录，之后既能让我
   * 按路径读（`cat` / `head`），部署计划也能直接从它里面复制 —— 退出Work
   * 或清空上下文时整个目录会被删掉。
   */
  const [remoteRoot, setRemoteRoot] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  /** 用户点了「取消任务」：执行循环在下一步之前看到它就停下。 */
  /**
   * 哪些**部署任务**被要求停止（按 taskId）。
   *
   * 以前是一个全局布尔：A 在停止时启动 B 会把它清掉，停止 A 也可能影响 B。
   * 现在停止指令跟着任务走，跨对话互不干扰。
   */
  const stopTasksRef = useRef<Set<string>>(new Set());
  /**
   * 本次计划的稳定 id：写入本地库时作为主键。
   *
   * 重试 / 继续执行会复用同一个 id，于是历史里是一条被更新的记录，而不是
   * 每次点「继续」都多出一条。
   */
  const planTaskIdRef = useRef<string | null>(null);
  /**
   * 每个 taskId 的**原始 Agent 步骤**。
   *
   * 卡片里的 `DeployStep` 是渲染模型（`write_file` 的命令体已被替换成路径），
   * 增量事件必须合并回原始步骤再整体重算，否则 `step_output` 会把标题与
   * 备份信息冲掉。
   */
  const agentStepsRef = useRef<Map<string, AgentStep[]>>(new Map());
  /** cwd 变化 → 右侧文件面板跟随。 */
  const [followNonce, setFollowNonce] = useState(0);
  /** 下一次请求从这里开始：接着上一轮命令所在的目录。 */
  const agentCwdRef = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  /**
   * 「更新现有服务」的**只读探测结果**。
   *
   * 有值就说明用户点了入口、正在等服务选择：界面上显示成一条可点的候选栏。
   * 探测只跑 `docker ps` 与 `docker inspect`，不改任何东西。
   */
  const [candidates, setCandidates] = useState<ServiceCandidate[] | null>(null);
  const [probing, setProbing] = useState(false);
  /**
   * 权限模式。默认**只读**：查询直接执行，写 / 改 / 删确认一次、sudo 禁用。
   *
   * 打开「完全权限」后写入 / 修改 / 删除直接执行（写文件仍会自动备份），
   * 并允许 sudo；"只查询"的请求由后端执行器拦下写操作（见 `permissions.ts`）。
   */
  const permissionDefault = useExtremePermissionsStore((state) => state.defaultMode);
  const permissionByWorkspace = useExtremePermissionsStore((state) => state.byWorkspace);
  const setWorkspacePermission = useExtremePermissionsStore((state) => state.setWorkspaceMode);
  const permission = effectivePermission(
    { defaultMode: permissionDefault, byWorkspace: permissionByWorkspace },
    workspaceId,
  );
  const setPermission = useCallback(
    (mode: PermissionMode) => {
      if (workspaceId) setWorkspacePermission(workspaceId, mode);
    },
    [setWorkspacePermission, workspaceId],
  );
  /*
   * 进入一条对话时把当时的权限**钉住**：之后在权限页改「新任务默认值」
   * 只影响以后创建的对话，不会悄悄改掉正在用的这条。
   * 用户显式点「跟随默认」会移除覆盖，那之后才随默认值走。
   */
  useEffect(() => {
    if (!workspaceId) return;
    const state = useExtremePermissionsStore.getState();
    if (!state.byWorkspace[workspaceId]) {
      state.setWorkspaceMode(workspaceId, state.defaultMode);
    }
  }, [workspaceId]);
  /**
   * 前置条件的实测结论（目录可写 / 磁盘 / 端口…）。
   *
   * 进极核时跑一次只读探测；结论随每次提问发给模型，也用于任务卡上的
   * "4/6 已验证 · 2 项阻塞"。因为带稳定 id，用户改完 DNS 后可以只复查那一项。
   */
  const [envChecks, setEnvChecks] = useState<CheckItem[]>([]);
  /**
   * 进极核后跑一次**只读**探测，把前置条件变成可核对的结论。
   *
   * 一次 SSH 拿齐：目录可写、磁盘余量、监听端口。失败时什么都不设 ——
   * `checks` 会因此停在"无法验证"，而不是编一个"通过"。
   */
  useEffect(() => {
    const home = preflight?.home;
    if (!active || !sessionId || !home) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        // 解压 + 备份大约占三倍体积，另留 200 MB 缓冲。
        const payload = attachments.reduce((sum, item) => sum + item.size, 0);
        const needBytes = payload * 3 + 200 * 1024 * 1024;
        const out = await opsApi.sshExec(sessionId, probeCommand(home), 25_000);
        if (cancelled || out.exit_code !== 0) return;
        setEnvChecks(checksFromProbe({ probe: parseProbe(out.stdout), path: home, needBytes }));
      } catch {
        // 探测失败不阻塞对话：结论自然落到"无法验证"。
      }
    })();
    return () => {
      cancelled = true;
    };
    // 附件只影响 needBytes，不必因每次拖入而重跑探测。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, preflight?.home, sessionId]);
  /**
   * 每条对话各自的请求版本。
   *
   * 以前是全工作台一个计数器：B 一发请求就把 A 的版本号顶掉，A 虽然还能收
   * 正文，但上传 / 计划这类"前端接力"会以为自己过期了而被丢弃。版本号必须
   * 限定在所属对话内。
   */
  const askSeqRef = useRef<Record<string, number>>({});

  /* --------------------------------------------------------------------- *
   * 归属核对：每一步动作之前都要问一次"这条对话还在吗、连接还是那条吗"
   * --------------------------------------------------------------------- */

  /** 从 store 现读"当前世界"：不用渲染闭包，闭包可能是切走之前的。 */
  const scopeWorld = useCallback((): ScopeWorld => {
    const state = useExtremeStore.getState();
    return {
      workspaceId: state.workspaceId,
      sessionId: state.sessionId,
      workspaces: state.workspaces.map((entry) => ({
        id: entry.id,
        serverId: entry.serverId,
      })),
      connections: state.connections,
    };
  }, []);

  /** 这一步还能不能继续；不能就返回一句要写回原对话的原因。 */
  const scopeBlocked = useCallback(
    (scope: ActionScope): string | null => {
      const check = checkScope(scope, scopeWorld());
      return check.ok ? null : explainBlocker(check.reason, t);
    },
    [scopeWorld, t],
  );

  /** 快照所属对话是否就在眼前（只有这时才允许动右栏 / 焦点 / 草稿）。 */
  const scopeIsForeground = useCallback(
    (scope: ActionScope) => scopeForeground(scope, scopeWorld()),
    [scopeWorld],
  );

  /** 归属失效：暂停这一步，并在**原对话**里说明原因（绝不借用前台连接）。 */
  const pauseAction = useCallback(
    (scope: ActionScope, reason: string) => {
      pushMessageTo(scope.workspaceId, {
        id: `msg-${crypto.randomUUID()}`,
        role: "assistant",
        local: true,
        text: t("这一步没有继续：{{reason}}", { reason }),
      });
    },
    [pushMessageTo, t],
  );

  /**
   * 按钮入口的归属快照：就是"此刻界面上这条对话"。
   *
   * 与 `ask` 里的那份同构，只是数据现取；模型动作链始终用发起时的快照。
   */
  const currentScope = useCallback((): ActionScope => {
    const state = useExtremeStore.getState();
    const owner = state.workspaceId ?? "";
    return {
      workspaceId: owner,
      serverId: state.serverId,
      server: state.server ?? "",
      sessionId: state.sessionId ?? "",
      requestId: askSeqRef.current[owner] ?? 0,
      home: preflight?.home ?? null,
      permission,
      preflight,
      envChecks,
      attachments,
      prefs: { context: chatPrefs.context, output: chatPrefs.output, picked: chatPrefs.picked },
      focusId,
      selectedAttachmentIds,
      plan,
      planSession,
      planTaskId: planTaskIdRef.current ?? state.planTaskId,
      candidates,
      remoteRoot,
    };
  }, [
    attachments,
    candidates,
    chatPrefs.context,
    chatPrefs.output,
    chatPrefs.picked,
    envChecks,
    focusId,
    permission,
    plan,
    planSession,
    preflight,
    remoteRoot,
    selectedAttachmentIds,
  ]);


  /**
   * 聊天动作的执行入口。
   *
   * 执行器（上传 / 生成计划 / 跑计划）都定义在 `ask` 之后，`const` 不提升，
   * 直接在 `ask` 里引用会撞 TDZ。用 ref 把它们挂上来：`ask` 拿到的永远是
   * **当前**这一轮的实现，也顺带避免把这些函数塞进依赖数组。
   *
   * 每个执行器都**必须**接收发起时的归属快照（`scope`）：后台继续跑的时候，
   * 附件、连接、计划都从快照取，而不是从"现在前台是谁"取。
   */
  const execRef = useRef<{
    /**
     * 每个执行器都返回**给模型的回执**（真实结果，不是"已请求"）。
     *
     * 回执由 `feedToolReport` 交给模型；用户看到的是任务下面的「执行结果」。
     * `paused` = 归属失效（断连 / 换服务器 / 计划过期），动作链到此为止。
     */
    upload: (scope: ActionScope, taskId?: string) => Promise<ActionResult>;
    plan: (scope: ActionScope, service?: string, originMessageId?: string) => Promise<ActionResult>;
    start: (scope: ActionScope, taskId?: string) => Promise<ActionResult>;
    /** 把长驻监听命令写进右侧真实终端。 */
    terminal: (scope: ActionScope, command: string) => Promise<ActionResult>;
  } | null>(null);
  /** 进行中请求的取消令牌（`ai_chat_cancel` 用它让后端断开）。 */
  const taskIdRef = useRef<string | null>(null);
  /** 每条任务启动时锁定的模型 / 强度 / 预算；续跑与后台切换都只认它。 */
  const taskSelectionsRef = useRef<Map<string, ModelSelection>>(new Map());
  /**
   * **用户明确确认过**的计划（按 taskId）。
   *
   * 模型输出 `[[start]]` 只是"它建议开始"，不是用户同意：这条链必须用过一次
   * 用户的表态（说「开始吧」/ 点确认）才放行，否则等于让模型自己按执行键。
   * 计划重新生成时清掉旧记录。
   */
  const userConfirmedPlansRef = useRef<Set<string>>(new Set());
  /**
   * 是否有一次运行在飞（**同步**）。
   *
   * `asking` 是 React state，连点两下时第二次读到的还是旧值；重试与重复提交
   * 都靠这个 ref 保证"只起一次"。
   */
  /**
   * 正在飞的运行，**按对话记录**。
   *
   * 全局一个布尔值会误伤：A 在跑时切到 B，B 明明空闲却发不出去。
   */
  const inFlightRef = useRef<Set<string>>(new Set());
  /**
   * 这一轮发起时用的上下文 / 输出 / 模型。
   *
   * 运行中改选只对下一条生效；运行记录保留**发起那一刻**的事实。
   */
  const runMetaRef = useRef<{
    taskId: string;
    context: string;
    output: string;
    providerId: string | null;
  } | null>(null);

  const {
    streamingReplies,
    streamFilters,
    textBuffers,
    applyTerminalSnapshot,
    saveAgentTask,
  } = useAgentStream({
    active,
    workspaceId,
    sessionId,
    t,
    agentStepsRef,
    agentCwdRef,
    taskIdRef,
    inFlightRef,
    approvalEntriesRef,
    setAsking,
    setStoppingIds,
    setStopOverdueId,
    setStaleTask,
    setFollowNonce,
    setNotice,
    setTaskUsage,
    upsertTask,
    patchMessage,
    patchMessageIn,
    mergeFileChange,
    dropApprovals,
    setApprovalEntry,
  });

  /**
   * 每条对话的**阅读位置**（滚动高度）。
   *
   * 切走时记下来、切回来还原：翻着历史被拉回底部，等于把"回忆"打断。
   */
  const scrollPositionsRef = useRef<Map<string, number>>(new Map());
  const previousWorkspaceRef = useRef<string | null>(null);
  /**
   * 滚动容器与"贴着底部"的**用户意图**。
   *
   * 自动跟随只在用户本来就想看最新内容时生效：判断依据是真实输入
   * （滚轮 / 触摸 / 按键），不是"当前距底多少" —— 后者会被程序化滚动后的
   * 补发事件误判成"用户往上翻了"。细节见 `use-chat-scroll.ts`。
   */
  const {
    ref: scrollRef,
    stick: stickToBottom,
    follow: followBottom,
    restore: restoreScroll,
    atBottom,
    scrollToBottom,
  } = useChatScroll(active, followLatest);

  /*
   * Work自己是深色，但**不改全局主题**。
   *
   * 之前这里调 `setThemeMode("dark")`：它写的是全局偏好 + Windows 窗口材质，
   * 相当于"开一次Work把整个应用的配色改掉"，退出再恢复一次 —— 用户能明显
   * 感觉到闪一下，而且期间其他页面也跟着变。
   *
   * 现在深色 token 只在 `.extreme-core` 这棵子树内生效（见 extreme-core.css
   * 里的变量覆盖），外层主题、窗口材质、系统偏好都不动。
   */

  /*
   * 换服务器：先把上一台留下的东西全部清干净。
   *
   * 预检、错误、重试文本、预览、草稿都是**组件内**状态，不清就会把 A 的
   * 预检摘要和报错显示在 B 上（对话与附件已经在 store 里按会话分桶）。
   */
  useEffect(() => {
    setPreflight(null);
    setPreflightError(null);
    setAskError(null);
    setRetryMessage(null);
    setNotice(null);
    setPreview(null);
    // 草稿跟着**对话**走：store 里已经切到目标那条了，这里只同步本地输入框。
    setDraftState(useExtremeStore.getState().draft);
    // 临时目录、候选服务、执行标记都只属于上一台：留着会显示/操作错服务器。
    setRemoteRoot(null);
    setCandidates(null);
    setProbing(false);
    setPlanStopping(false);
    setStopOverdueId(null);
    planTaskIdRef.current = null;
    // Agent 的目录与原始步骤只属于上一台：留着会对着错服务器操作。
    agentCwdRef.current = null;
    agentStepsRef.current.clear();
    /*
     * **待确认不能跟着会话清空。**
     *
     * 审批按 taskId + callId 归各自对话：切到另一台服务器时，A 那条任务还在
     * 等确认，清掉就等于把它的审批弄丢了（窗口收起后连通知也没了）。真实
     * 失效由 `approval_withdrawn` / 任务终态 / 后端拒绝来收。
     */
  }, [sessionId]);


  useEffect(() => {
    const state = useExtremeStore.getState();
    /*
     * 阅读位置：先把上一条对话滚到哪记下来，再恢复目标那条的位置。
     *
     * 停在底部的不记：那条对话在后台继续流式输出时，切回来应该看到最新的
     * 尾巴，而不是离开时那个已经过时的"底部"。
     */
    const previousId = previousWorkspaceRef.current;
    if (previousId && previousId !== workspaceId && scrollRef.current) {
      if (stickToBottom.current) scrollPositionsRef.current.delete(previousId);
      else scrollPositionsRef.current.set(previousId, scrollRef.current.scrollTop);
    }
    previousWorkspaceRef.current = workspaceId;
    // 切对话：草稿、焦点、目录都从**目标那条**恢复，而不是清空。
    setDraftState(state.draft);
    setPreview(null);
    setFocusId(null);
    setFilePreview(null);
    setCandidates(null);
    setAskError(null);
    setRetryMessage(null);
    setNotice(null);
    // 「停止没有确认」也只属于上一个对话：切走后不该跟着出现。
    setStopOverdueId(null);
    // 待确认按对话归属（见上）：切走不清理，切回来按 workspaceId 过滤显示。
    const savedPath = workspaceId ? state.remotePathByWorkspace[workspaceId] : undefined;
    setWorkspaceTarget(savedPath && sessionId ? { kind: "directory", path: savedPath, sessionId } : null);
    /*
     * 「谁在跑、停止按钮指向谁」是**按对话**的：A 在后台跑时切到 B，
     * B 不该显示停止，也不该把 A 的 taskId 当成自己的取消目标。
     */
    const runningTask = Object.values(state.tasks).find(
      (task) =>
        task.workspaceId === workspaceId &&
        (task.status === "running" || task.status === "confirming"),
    );
    setAsking(Boolean(runningTask));
    taskIdRef.current = runningTask?.id ?? null;
    // 下一次命令从这条对话最后那个任务的目录继续（没有就回到预检家目录）。
    const latestCwd = state.messages
      .map((message) => (message.taskId ? state.tasks[message.taskId]?.cwd : undefined))
      .filter((cwd): cwd is string => Boolean(cwd))
      .pop();
    agentCwdRef.current = latestCwd ?? null;
    planTaskIdRef.current = state.planTaskId;
    // Only restore the managed upload directory of this workspace.
    const marker = workspaceId ? `/.bls-ops/extreme-${workspaceId}/` : null;
    const path = state.attachments.find((item) => item.uploadState === "uploaded" &&
      marker && item.remotePath?.includes(marker))?.remotePath;
    setRemoteRoot(path && marker ? path.slice(0, path.indexOf(marker) + marker.length - 1) : null);
  }, [workspaceId, sessionId]);

  // 只读预检：进入即跑一次。失败明确显示原因。
  useEffect(() => {
    if (!active || !sessionId) return undefined;
    let cancelled = false;
    setPreflightError(null);
    void runPreflight(sessionId)
      .then((result) => {
        if (!cancelled) setPreflight(result);
      })
      .catch((cause) => {
        if (!cancelled) setPreflightError(cause instanceof Error ? cause.message : t("预检失败"));
      });
    return () => {
      cancelled = true;
    };
  }, [active, sessionId, t]);

  /** 最后一条消息的文本长度：流式追加时 length 不变，靠它触发滚动。 */
  const lastTextLength =
    messages.length > 0 ? messages[messages.length - 1].text.length : 0;

  useEffect(() => {
    if (!active) return;
    const saved = workspaceId ? scrollPositionsRef.current.get(workspaceId) : undefined;
    stickToBottom.current = true;
    if (saved !== undefined) restoreScroll(saved);
    else scrollToBottom();
  }, [active, workspaceId, stickToBottom, scrollToBottom, restoreScroll]);

  /*
   * 内容变了 → 跟着滚（用户翻过历史就不动）。
   *
   * 步骤、执行活动、确认条长高不改变消息条数或最后一条的文本长度，那一类由
   * `useChatScroll` 里的 ResizeObserver 兜住 —— 内容容器与滚动容器自身都盯。
   */
  useEffect(() => {
    if (!active) return undefined;
    followBottom();
    return undefined;
  }, [active, lastTextLength, messages.length, plan?.length, followBottom]);




  /**
   * 这次「重试」该重跑哪一条。
   *
   * 优先用错误条绑定的那条消息（`retryMessage`）；没有就找当前会话里最新的
   * 失败 / 已取消任务，按它的发起消息重放 —— 重试的是"上次那件事"，不是
   * 「重试」这两个字。
   */
  const resolveRetrySource = (): { message: ExtremeMessage; card?: TaskCardModel } | null => {
    const state = useExtremeStore.getState();
    /*
     * **只认当前这条对话的任务**。
     *
     * 以前按 `sessionId` 过滤：同一台服务器上另一条对话的失败任务也会被选中，
     * 于是「重试」去重跑了别人的任务（甚至可能是另一条对话里刚拒绝过的写操作）。
     */
    const cards = Object.values(state.tasks).filter((card) =>
      card.workspaceId
        ? card.workspaceId === state.workspaceId
        : // 旧卡片没有归属：只有它的发起消息就在当前对话里才算。
          Boolean(card.originMessageId) &&
          state.messages.some((message) => message.id === card.originMessageId),
    );
    if (retryMessage) {
      const card = cards
        .filter((item) => item.originMessageId === retryMessage.id)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      return { message: retryMessage, card };
    }
    const failed = cards
      .filter(
        (card) =>
          (card.status === "failed" || card.status === "cancelled") && card.originMessageId,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const message = failed?.originMessageId
      ? state.messages.find((item) => item.id === failed.originMessageId)
      : undefined;
    return message ? { message, card: failed } : null;
  };

  /**
   * 重试时补一句给模型：上次停在哪、**先核对远端状态**再继续。
   *
   * 上一次可能已经把文件写下去、把服务重启了，只是后面某步失败 —— 直接重放
   * 会把同一件事做两遍。
   */
  const retryNoteFor = (card?: TaskCardModel): string => {
    const failedStep = [...(card?.steps ?? [])].reverse().find((step) => step.state === "failed");
    const where = failedStep?.title ?? card?.result ?? "";
    return t(
      "上一次停在「{{step}}」。如果这一步涉及写文件、改配置或重启服务，先用只读命令核对远端当前状态，确认没有已经生效后再继续；不要盲目重复执行。",
      { step: where },
    );
  };

  /**
   * **用户发送入口**：`Sender` 提交的文本、回车、重试都走这里。
   *
   * 只有它会 push 用户气泡、清空草稿、落会话标题、跑意图路由。工具执行完把
   * 结果交给模型走 `feedToolReport`（见下），**不要**用字符串再调这里。
   *
   * **直接用调用方给的文本**，不再「先 setDraft 再延迟读 state」—— 那条路径
   * 里 `ask()` 读到的可能还是上一轮的草稿，会把旧内容发出去。
   */
  /**
   * 模型请求打开面板：**先核对目标真实存在**，再打开。
   *
   * `journal:nginx` 在一台用 Docker 跑 nginx 的机器上会永远空着 —— 与其打开
   * 一个空面板，不如回一句"这台机器上没有 systemd 的 nginx"。
   */
  /**
   * 扫描这台机器上的日志来源，按用户这句话挑一个（歧义时只问一句）。
   *
   * `workspaceAt` / `sessionAt` 由调用方给出（发起这次运行的那条对话与连接），
   * 不用渲染闭包里的值 —— 响应回来时闭包可能已经是另一条对话了。
   */
  const openLogFromIntent = useCallback(
    async (
      text: string,
      workspaceAt: string,
      sessionAt: string,
    ): Promise<{ opened: boolean; question?: string; deferred?: boolean }> => {
      if (!sessionAt) return { opened: false };
      const tracker = scopeTracker.current!;
      const request = tracker.begin(workspaceAt, sessionAt);
      const scan = await opsApi
        .sshExec(sessionAt, discoveryCommand(), 10_000)
        .catch(() => null);
      /*
       * 探测期间可能：切了对话 / 重连换了连接 / 这条对话又发了一次请求。
       *
       * 结果**归发起的对话**：还在前台就直接开；不在前台就记下来，切回去
       * 再开 —— 既不打开另一条对话的右栏，也不把已经查到的结果丢掉。
       */
      const now = useExtremeStore.getState();
      const current = tracker.accept(request, {
        workspaceId: now.workspaceId,
        sessionId: now.sessionId,
      });
      const candidates = scan ? parseCandidates(scan.stdout) : [];
      const { pick, choices } = pickLogSource(candidates, text);
      if (pick) {
        const panelRequest: PanelRequest = { tab: "logs", source: pick, sessionId: sessionAt };
        if (current) {
          openPanel(panelRequest);
          return { opened: true };
        }
        pendingPanelRef.current!.set(workspaceAt, { ...panelRequest, scope: request });
        return { opened: false, deferred: true };
      }
      if (choices.length > 1) {
        // 候选连同归属一起存：只有发起它的那条对话能回答。
        setLogChoices({ scope: request, choices });
        return { opened: false, question: ambiguityQuestion(choices) };
      }
      return { opened: false };
    },
    [openPanel],
  );

  /**
   * 按模型的 `[[panel:…]]` 打开右栏。
   *
   * `workspaceAt` / `sessionAt` 是**发起这次运行的那条对话与连接**：探测期间
   * 用户可能已经切走，结果只允许回到它自己那条对话（否则 A 的日志会弹到
   * B 的脸上）。
   */
  const openPanelFromAction = useCallback(
    async (request: PanelRequest, workspaceAt: string, sessionAt: string): Promise<string> => {
      const tracker = scopeTracker.current!;
      const scope = tracker.begin(workspaceAt, sessionAt);
      const stillMine = () => {
        const now = useExtremeStore.getState();
        return tracker.accept(scope, { workspaceId: now.workspaceId, sessionId: now.sessionId });
      };
      if (request.tab !== "output") {
        const command = panelProbeCommand(request);
        if (command) {
          if (!sessionAt) return t("这条对话没有可用连接，先重新连接服务器。");
          const probe = await opsApi.sshExec(sessionAt, command, 8000).catch(() => null);
          if (!probe || !probeSucceeded(request, probe.stdout)) {
            // 目标不存在是**结果**：写回发起它的那条对话（不在前台也照样告知）。
            return t("这台服务器上没有找到 {{what}}：换个来源再试，或者先让我查一下它怎么跑的。", {
              what: panelTitle(request),
            });
          }
        }
      }
      const panelRequest: PanelRequest = { ...request, sessionId: sessionAt };
      if (!stillMine()) {
        // 已经切走：记在它自己那条对话名下，切回去再打开，不弹到别人脸上。
        pendingPanelRef.current!.set(workspaceAt, { ...panelRequest, scope });
        return "";
      }
      /*
       * 「远程文件」：AI 指了路径，右栏就得**真的展开**到文件标签 ——
       * 只写 workspaceTarget 而不展开，用户看到的还是收起的右栏。
       */
      if (request.tab === "files") {
        if (!request.path || !sessionAt) return "";
        setWorkspaceTarget({ kind: "directory", path: request.path, sessionId: sessionAt });
        openPaneTab("files");
        return "";
      }
      // 「命令输出」不传 taskId：面板按**当前对话最新那次执行**展示。
      openPanel(panelRequest);
      return t("已打开 {{what}}", { what: panelTitle(request) });
    },
    [openPaneTab, openPanel, t],
  );

  /** 从当前 workspace 的设置读一份模型快照（非输入区路径用）。 */
  const selectionFromStore = useCallback((): ModelSelection => {
    const state = useExtremeStore.getState();
    const provider = effectiveProvider(providers, state.chatPrefs.providerId);
    const modelName = provider?.model ?? model ?? "";
    const setting = effectiveModelSetting(
      state,
      modelKey(provider?.id ?? state.chatPrefs.providerId, modelName),
    );
    return {
      providerId: provider?.id ?? state.chatPrefs.providerId,
      model: modelName,
      effort: setting.effort,
      contextBudget: setting.budget,
    };
  }, [model, providers]);



  const { decideApprovalById } = useApprovalActions({
    t,
    approvalEntries,
    approvalEntriesRef,
    decideApprovalRef,
    updateApprovalEntry,
    dropApprovals,
    setNotice,
  });

  /** 按钮触发的用户动作：补一条消息，卡片才有"发起它的那句话"可挂。 */
  const pushUserMessageTo = useCallback((workspaceId: string, text: string): ExtremeMessage => {
    const message: ExtremeMessage = { id: `msg-${crypto.randomUUID()}`, role: "user", text };
    if (!workspaceId) return message;
    useExtremeStore.getState().pushMessageTo(workspaceId, message);
    // 只有原对话在前台时才动输入框。
    if (useExtremeStore.getState().workspaceId === workspaceId) setDraft("");
    return message;
  }, []);
  const pushUserMessage = useCallback(
    (text: string): ExtremeMessage =>
      pushUserMessageTo(useExtremeStore.getState().workspaceId ?? "", text),
    [pushUserMessageTo],
  );

  /**
   * 落一版计划。
   *
   * 卡片与聊天里那条消息在**同一处**绑定（显式 `originMessageId`）：不再
   * `reverse().find` 一条"最近还没挂卡"的消息 —— 连发几句或切服务器时，那
   * 正是卡片挂错地方的根源。计划为空也不算失败：卡片停在「等待补充信息」，
   * 下一步是「重新检查」。
   */
  const {
    generatePlan,
    runPlan,
    uploadToServer,
    probeServices,
    planUpdate,
    cleanupRemote,
  } = useDeployActions({
    t,
    currentScope,
    scopeBlocked,
    scopeIsForeground,
    pauseAction,
    pushMessageTo,
    pushUserMessageTo,
    setNotice,
    setPlan,
    setPlanSession,
    updatePlan,
    patchMessageIn,
    patchWorkspaceContext,
    mergeFileChange,
    setAttachmentsIn,
    setExecutingFor,
    upsertTask,
    upsertReport,
    openPaneTab,
    planTaskIdRef,
    stopTasksRef,
    userConfirmedPlansRef,
    remoteRoot,
    setRemoteRoot,
    sessionId,
    uploading,
    setUploading,
    probing,
    setProbing,
    setCandidates,
  });

  /*
   * 输入区下栏的 MCP 能力：内置技能按服务器探测缓存默认勾选，外部连接
   * 要求已连接 + 绑定当前服务器/工作区；勾选按会话+服务器独立保存。
   */
  const mcpCapabilities = useMcpCapabilities({
    workspaceId,
    serverId,
    sessionId,
    connected: Boolean(sessionId),
  });
  const mcpSelectionRef = useRef(mcpCapabilities);
  mcpSelectionRef.current = mcpCapabilities;

  const { ask, cancelAsk, settleStoppedLocally } = useAsk({
    t,
    i18n,
    active,
    asking,
    executing,
    draft,
    approval,
    sendWhileRunning,
    logChoices,
    setLogChoices,
    messages,
    tasks,
    queuedSends,
    connections,
    runEpoch,
    composerAttachments,
    chatPrefs,
    plan,
    planSession,
    candidates,
    remoteRoot,
    preflight,
    permission,
    envChecks,
    getMcpSelection: () => ({
      builtins: mcpSelectionRef.current.selectedBuiltins,
      tools: mcpSelectionRef.current.selectedToolNames,
    }),
    attachments,
    focusId,
    selectedAttachmentIds,
    providers,
    server,
    serverId,
    sessionId,
    staleTask,
    currentScope,
    setDraft,
    setNotice,
    setAskError,
    setRetryMessage,
    setAsking,
    setFocusId,
    setSelectedAttachmentIds,
    setModel,
    setTaskUsage,
    upsertTask,
    setStaleTask,
    setRunEpoch,
    setStoppingIds,
    setStopOverdueId,
    pushMessage,
    pushUserMessage,
    pushMessageTo,
    patchMessage,
    patchMessageIn,
    removeMessageIn,
    dropClosedApprovals,
    decideApprovalById,
    openPanel,
    generatePlan,
    runPlan,
    queueSend,
    dropSend,
    failSend,
    saveAgentTask,
    applyTerminalSnapshot,
    selectionFromStore,
    resolveRetrySource,
    retryNoteFor,
    openLogFromIntent,
    openPanelFromAction,
    taskSelectionsRef,
    taskIdRef,
    inFlightRef,
    askSeqRef,
    scopeTracker,
    planTaskIdRef,
    stopTasksRef,
    userConfirmedPlansRef,
    runMetaRef,
    streamingReplies,
    streamFilters,
    textBuffers,
    agentStepsRef,
    agentCwdRef,
    execRef,
    scopeWorld,
    stickToBottom,
    getActiveTaskId: () => activeTask?.id ?? null,
    getStopping: () => stopping,
  });

  /**
   * 强制结束：用户明确选择不再等后端确认。
   *
   * 只停止跟踪，撤回不了已经发到服务器上的命令 —— 提示必须把这一点说清。
   */
  const forceStop = async () => {
    const taskId = stopOverdueId ?? staleTask ?? taskIdRef.current ?? activeTask?.id;
    if (!taskId) return;
    setNotice(null);
    try {
      const snapshot = await opsApi.aiAgentAbandon(taskId);
      if (snapshot) applyTerminalSnapshot(snapshot, false);
      else settleStoppedLocally(taskId, t("后端已经没有这条运行。"));
      setNotice(
        t("已强制结束这次运行：后端不再跟踪它。已经发到服务器上的命令可能仍在执行，请先核对。"),
      );
    } catch (cause) {
      setNotice(toAppError(cause).message);
    }
  };




  /**
   * 「状态待核对」时重新问一次后端。
   *
   * 事件流可能丢包、快照也可能超时；这里按 taskId 直查，把卡片/气泡补回来。
   * 查不到明确告诉用户"没有这次运行的记录"，不臆测结果。
   */
  const recheckTask = useCallback(
    async (taskId: string) => {
      const taskWorkspace = useExtremeStore.getState().tasks[taskId]?.workspaceId;
      try {
        const snapshot = await opsApi.aiAgentSnapshot(taskId);
        if (!snapshot) {
          if (useExtremeStore.getState().workspaceId === taskWorkspace) {
            setNotice(t("后端没有这次运行的记录：它可能已经结束并被清理。"));
          }
          return;
        }
        if (applyTerminalSnapshot(snapshot)) return;
        const state = useExtremeStore.getState();
        const existing = state.tasks[taskId];
        if (!existing || (existing.status !== "running" && existing.status !== "confirming")) return;
        const steps = snapshot.steps ?? [];
        agentStepsRef.current.set(taskId, steps);
        const card = cardFromAgent({
          taskId,
          server: snapshot.server || existing?.server || "",
          sessionId: snapshot.sessionId || existing?.sessionId || "",
          workspaceId: existing?.workspaceId ?? state.workspaceId,
          serverId: existing?.serverId ?? state.serverId,
          originMessageId: existing?.originMessageId,
          goal: existing?.goal ?? "",
          steps,
          status: snapshot.status,
          error: snapshot.status === "failed" ? snapshot.error : undefined,
          cwd: snapshot.cwd,
          outcome: snapshot.outcome ?? null,
          existing,
          t,
        });
        upsertTask(card);
        saveAgentTask(card, true);
        setStaleTask((current) => (current === taskId ? null : current));
        if (existing?.workspaceId === state.workspaceId) {
          setAsking(true);
          taskIdRef.current = taskId;
        }
      } catch (cause) {
        if (useExtremeStore.getState().workspaceId === taskWorkspace) {
          setNotice(toAppError(cause).message);
        }
      }
    },
    [applyTerminalSnapshot, saveAgentTask, selectionFromStore, setNotice, t, upsertTask],
  );

  /**
   * 从检查点恢复一条被中断 / 失败的任务。
   *
   * 后端会先让模型只读核对已完成的步骤，再从第一条未完成处继续；这里只负责
   * 用**当前会话**与当前模型设置重新启动，并把事件接回同一张任务卡。
   */
  const resumeTask = useCallback(
    async (task: TaskCardModel) => {
      if (!sessionId) {
        setNotice(t("服务器未连接：重新连接后才能恢复任务。"));
        return;
      }
      if (asking) {
        setNotice(t("任务仍在执行：等它结束或点「停止」后再恢复。"));
        return;
      }
      pushMessage({
        id: `msg-${crypto.randomUUID()}`,
        role: "assistant",
        local: true,
        text: t("从检查点继续：先只读核对已完成的步骤，再继续未完成的部分。"),
      });
      setAsking(true);
      taskIdRef.current = task.id;
      const workspaceAtRequest = useExtremeStore.getState().workspaceId ?? "";
      if (workspaceAtRequest) inFlightRef.current.add(workspaceAtRequest);
      const startedAt = Date.now();
      const finished = waitForAgentRun(task.id, {
        since: startedAt,
        onSnapshot: (snap) => {
          if (snap.context) setTaskUsage(snap.taskId, snap.context);
        },
      });
      try {
        // 这条任务启动时锁过设置就沿用；没有则用当前 workspace 的设置。
        const selection = taskSelectionsRef.current.get(task.id) ?? selectionFromStore();
        taskSelectionsRef.current.set(task.id, selection);
        const activeProvider = effectiveProvider(providers, selection.providerId);
        const resumeBudget =
          selection.contextBudget &&
          (activeProvider?.budgets ?? []).includes(selection.contextBudget)
            ? selection.contextBudget
            : null;
        /*
         * 恢复 MAX 门控：计划在消息里（跟着这轮落盘），任务上还留着当初的
         * `planRequired`。有任意一样就按 MAX 恢复，不能因为当前菜单切成了
         * 普通档就悄悄绕过计划。
         */
        const stateNow = useExtremeStore.getState();
        const taskMessages = [
          ...stateNow.workspaces.flatMap((entry) => entry.messages),
          ...stateNow.messages,
        ];
        const knownPlan = planForTask(taskMessages, task.id);
        const planRequired =
          Boolean(knownPlan) ||
          taskMessages.some((message) => message.taskId === task.id && message.planRequired);
        // 续跑沿用当前会话的勾选快照（与发送时同一套）。
        const mcp = mcpSelectionRef.current;
        await opsApi.aiAgentResume({
          taskId: task.id,
          // 重连后的会话：记录里的那个 session 只用于关联。
          sessionId,
          // 继续执行时的新变更仍挂回原来那条对话 / 服务器。
          serverId: task.serverId ?? serverId ?? null,
          workspaceId: task.workspaceId ?? workspaceId,
          // 恢复也按当前界面语言：提示词不会因为"接着上次跑"就退回中文。
          locale: i18n.resolvedLanguage ?? i18n.language,
          replyLanguage:
            useExtremeSettingsStore.getState().replyLanguage === "auto"
              ? null
              : (useExtremeSettingsStore.getState().replyLanguage as "zh" | "en"),
          providerId: activeProvider?.id ?? selection.providerId,
          reasoningEffort: planRequired
            ? "max"
            : effortParam(selection.effort, activeProvider?.efforts ?? []),
          planRequired,
          plan: knownPlan,
          contextBudget: resumeBudget,
          permissionMode: permission,
          allowSudo:
            permission !== "readonly" &&
            useExtremePermissionsStore.getState().allowSudo,
          ...(() => {
            const backup = useExtremePermissionsStore.getState().backup;
            return {
              backupBeforeWrite: backup.beforeWrite,
              backupBeforeDelete: backup.beforeDelete,
              backupRetentionDays: backup.retentionDays,
            };
          })(),
          enabledMcpTools: mcp.selectedToolNames,
          enabledBuiltins: mcp.selectedBuiltins,
        });
        const snapshot = await finished;
        if (!snapshot) {
          // 事件丢了不代表任务失败：标成待核对，不假装完成。
          setStaleTask(task.id);
          return;
        }
        setTaskUsage(task.id, snapshot.context ?? null);
      } catch (cause) {
        setNotice(toAppError(cause).message);
      } finally {
        forgetAgentWait(task.id);
        if (workspaceAtRequest) {
          inFlightRef.current.delete(workspaceAtRequest);
          setRunEpoch((value) => value + 1);
        }
        if (useExtremeStore.getState().workspaceId === workspaceAtRequest) setAsking(false);
        if (taskIdRef.current === task.id) taskIdRef.current = null;
      }
    },
    [
      asking,
      effectiveProvider,
      model,
      permission,
      providers,
      pushMessage,
      sessionId,
      setNotice,
      setStaleTask,
      setTaskUsage,
      t,
    ],
  );



  const doneCount = plan?.filter((step) => step.state === "success").length ?? 0;
  const failedStep = plan?.find((step) => step.state === "failed") ?? null;
  const currentStep =
    plan?.find((step) => step.state === "running") ?? failedStep ?? plan?.find((step) => step.state !== "success");
  const welcome = messages.length === 0 && !plan?.length;
  /**
   * 附件改成"一次上传 = 一份文件夹"的 3D 展示后，这里不再需要 antd 的 items。
   */

  /**
   * 聊天里只显示**这一台**的任务卡。
   *
   * 切服务器时对话按会话分桶，任务卡却在全局 store 里：不过滤的话，上一台的
   * 「待确认」会作为孤儿卡出现在这一台的对话末尾。
   */
  /*
   * 卡片归属只看"这条对话里有没有引用它"。
   *
   * 不再按 `sessionId` 过滤：同一条对话重连后 sessionId 会变，旧卡片就再也
   * 找不到了；而 `taskId` 是稳定主键。
   */
  const sessionTasks = useMemo(() => {
    const taskIds = new Set(messages.map((message) => message.taskId));
    return Object.fromEntries(
      Object.entries(tasks).filter(([id]) => taskIds.has(id)),
    );
  }, [messages, tasks]);

  /**
   * 右上角计划卡：只认**当前对话最近一版**计划。
   *
   * 计划写在消息片段里（跟着这一轮落盘），所以切换会话各看各的；后台任务
   * 更新不会把另一条对话的卡顶掉。
   */
  const planCard = useMemo(() => latestPlan(messages), [messages]);

  /**
   * **当前这条对话**有没有在跑的任务。
   *
   * 用它决定输入区显示「发送」还是「停止」：A 在后台跑时，切到 B 的输入区
   * 必须是可用的，不能跟着 A 一起转圈。
   */
  const workspaceRunning = useMemo(
    () =>
      Object.values(tasks).some(
        (task) =>
          task.workspaceId === workspaceId &&
          (task.status === "running" || task.status === "confirming"),
      ),
    [tasks, workspaceId],
  );

  /** 当前对话里最新的一次执行：状态机、过程区、停止按钮都以它为准。 */
  const activeTaskId = useMemo(() => {
    const ids = messages
      .map((message) => message.taskId)
      .filter((id): id is string => Boolean(id));
    return ids.length > 0 ? ids[ids.length - 1] : null;
  }, [messages]);
  const activeTask = activeTaskId ? tasks[activeTaskId] : undefined;
  /** 发起这条任务的那条用户消息（附件数等"材料"从它读，重开后也在）。 */
  const activeTaskMessage = activeTaskId
    ? messages.find((message) => message.taskId === activeTaskId)
    : undefined;
  const activeTaskAttachmentNames = (activeTaskMessage?.attachmentIds ?? [])
    .map((id) => attachments.find((item) => item.id === id)?.name)
    .filter((name): name is string => Boolean(name));

  /**
   * 底栏显示的用量：按**消息里的 taskId** 取，不强依赖任务卡还在内存里。
   * 重开应用后卡片没了，但历史消息与用量还在 —— 依然能显示最终值。
   */
  const contextUsage = activeTaskId ? taskUsage[activeTaskId] : undefined;

  /** 两阶段停止的中间态：点了停止、后端还没确认。 */
  const stopping = Boolean(activeTask && stoppingIds.has(activeTask.id));

  /**
   * 停止等待期在等什么：当前命令要跑完才停（最长 10 分钟），只说
   * "正在停止"用户会以为卡死了。从任务卡现有的步骤推导，不新增状态字段。
   */
  const stoppingDetail =
    stopping && activeTask
      ? (() => {
          const running = [...activeTask.steps]
            .reverse()
            .find((step) => step.state === "running");
          return running
            ? t("等待当前命令结束：{{title}}", {
                title: running.title || running.command || t("执行命令"),
              })
            : t("等待模型连接断开…");
        })()
      : null;

  /**
   * 一次运行在界面上的**唯一状态**（分析 / 执行 / 等待 / 停止中 / 待核对 / 终态）。
   *
   * 输入框、过程区、停止按钮都从它派生，避免三处各自猜。
   */
  const runState = deriveRunState({
    task: activeTask,
    thinking: asking && !activeTask,
    stopping,
    stale: Boolean(staleTask),
  });

  /*
   * ── 唯一的「停止」入口 ──────────────────────────────────────────────
   *
   * 聊天区里只有 Prompt Bar 右下角那一个停止键，它停的是"现在在跑的那件事"：
   * Agent 循环 / 状态待核对的那次运行 / 部署计划执行。状态行只负责说明进度，
   * 不再各自摆一个按钮 —— 之前三处各有一个「停止」，哪个是权威全靠用户猜。
   */
  const canStop =
    executing ||
    planStopping ||
    runState === "analyzing" ||
    runState === "running" ||
    runState === "waiting" ||
    runState === "stopping" ||
    runState === "stale";
  /**
   * 已发出停止、还在等确认。
   *
   * 按钮仍可点：停止请求是幂等的，再点一次能重新问后端；禁用只会让用户觉得
   * "点了没反应"，也正是僵尸任务看起来停不下来的原因之一。
   */
  const stopPending = stopping || planStopping;
  /**
   * 点「停止」：按"现在在跑什么"分派。
   *
   * 部署计划是本地循环（`stopRef` 让它在下一步之前停下），Agent 循环在 Rust
   * 侧、必须通知后端；两条路都在**后端/循环确认之后**才改界面状态。
   */
  const stopRun = () => {
    if (executing) {
      if (planStopping) return;
      const currentPlanTask =
        planTaskIdRef.current ?? useExtremeStore.getState().planTaskId;
      if (currentPlanTask) stopTasksRef.current.add(currentPlanTask);
      setPlanStopping(true);
      setNotice(t("正在停止。当前步骤结束后不会运行后续步骤。"));
      return;
    }
    // 已经在等停止：再发一次（幂等），让用户看到"有反应"。
    void cancelAsk();
  };
  /**
   * 状态行那一句（空 = 没有在跑，不占高度）。
   *
   * 部署计划与 Agent 是两条独立的执行线：计划在跑时先说计划，否则按 Agent
   * 的真实状态说。都只说"在做什么"，可不可以停止由上面那一个键决定。
   */
  const statusLine = (() => {
    if (executing) {
      if (planStopping) return t("正在停止…当前步骤结束后不会再继续。");
      const total = plan?.length ?? 0;
      return total > 0
        ? t("正在执行部署计划：已完成 {{n}}/{{total}} 步", { n: doneCount, total })
        : t("正在执行部署计划…");
    }
    // 停止等待期把"在等什么"一起说清：只说"正在停止"会被当成卡死。
    if (stopping) return stoppingDetail ? `${t("正在停止…")} ${stoppingDetail}` : t("正在停止…");
    if (runState === "idle") return "";
    /*
     * 正常完成不再占一行状态：`已完成 · 已完成 3 步` 与任务卡、正文重复，
     * 还一直挂在对话上方。失败 / 停止 / 中断仍然要说（那是用户需要知道的）。
     */
    if (runState === "done") return "";
    /*
     * 带上这一句"在做什么"：重进接回来的卡片标题往往只是"服务器 · 自动化"，
     * 只显示"执行中"等于告诉用户有任务、却不知道是什么任务。
     */
    const summary = activeTask?.result?.trim() || activeTask?.goal.trim() || "";
    const label = runStateLabel(runState, t);
    return summary ? `${label} · ${summary}` : label;
  })();

  /**
   * 这次的**运行记录**：计划页的数据源。
   *
   * 简单查询（没有步骤、没有写操作）只有一行状态；复杂任务才展开步骤。
   * 状态与证据全部来自执行器，模型的说法不进这里。
   */
  const runRecord = useMemo<RunRecord | null>(() => {
    if (!activeTask) return null;
    const steps = stepsFromExecution(
      (activeTask.steps ?? []) as unknown as Parameters<typeof stepsFromExecution>[0],
    );
    const goal =
      activeTask.goal ||
      [...messages].reverse().find((message) => message.role === "user")?.text ||
      "";
    const status: RunStatus =
      runState === "waiting"
        ? "waiting"
        : runState === "done"
          ? "done"
          : runState === "failed"
            ? "failed"
            : runState === "cancelled"
              ? "cancelled"
              : runState === "stale"
                ? "stale"
                : "running";
    /*
     * 本次实际用的上下文 / 输出 / 模型：只认发起时的快照；快照不属于这条
     * 任务（比如是从历史里点开的旧卡）就不显示，避免张冠李戴。
     */
    const snapshot = runMetaRef.current?.taskId === activeTask.id ? runMetaRef.current : null;
    const meta = snapshot
      ? [
          {
            session: t("当前会话"),
            only: t("仅本条"),
            picked: t("自选"),
          }[snapshot.context] ?? snapshot.context,
          {
            auto: t("自动"),
            brief: t("简洁结论"),
            detailed: t("详细说明"),
            structured: t("结构化结果"),
          }[snapshot.output] ?? snapshot.output,
          providers.find((provider) => provider.id === snapshot.providerId)?.name ??
            t("默认模型"),
        ].join(" · ")
      : null;
    const base = {
      taskId: activeTask.id,
      goal,
      status,
      complexity: shouldPlan({ goal, steps, approvals: approval ? 1 : 0 })
        ? ("plan" as const)
        : ("simple" as const),
      steps,
      meta,
      updatedAt: activeTask.updatedAt,
    };
    return { ...base, headline: headlineFor(base) };
  }, [activeTask, messages, runState, approval, providers, t]);

  /**
   * 从左侧「待确认」点进来：定位到具体审批卡。
   *
   * 只在每条审批第一次出现时滚一次，不跟用户抢滚动（之后手动滚动不会被拉回）。
   * 键用 `taskId:callId`：同一任务的第二条审批也要能定位。
   */
  const scrolledApprovals = useRef<Set<string>>(new Set());
  const firstApprovalKey = approval ? approvalKeyOf(approval.taskId, approval.callId) : null;
  useEffect(() => {
    if (!approval || !firstApprovalKey) return;
    if (scrolledApprovals.current.has(firstApprovalKey)) return;
    scrolledApprovals.current.add(firstApprovalKey);
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-approval-key="${firstApprovalKey}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }, [approval, firstApprovalKey]);


  /**
   * 左栏：**所有服务器**的对话（默认），按最近活跃排序。
   *
   * 真正的"按服务器筛选"在 `TaskSidebar` 内部做：它需要每台的展示名与地址，
   * 这里把 `server`/`host` 一起带过去。
   */
  const workspaceEntries = useMemo(
    () => [...workspaces].sort((a, b) => b.updatedAt - a.updatedAt),
    [workspaces],
  );

  /** 左栏只标"需要关注"的状态：待确认 / 失败；其余靠标题与未读点。 */
  const attentionById = useMemo(() => {
    const out: Record<string, "waiting" | "failed"> = {};
    /*
     * **真实仍在等确认的审批**优先：它可能来自后台对话（任务卡状态还没刷新），
     * 左栏必须能点回去处理。点开只是切对话，不动当前输入焦点。
     */
    for (const entry of Object.values(approvalEntries)) {
      if (entry.closed) continue;
      // 卡片不在内存（重进）时按"哪条对话引用了这个 taskId"认归属。
      const owner =
        tasks[entry.approval.taskId]?.workspaceId ??
        workspaces.find((item) =>
          item.messages.some((message) => message.taskId === entry.approval.taskId),
        )?.id;
      if (owner) out[owner] = "waiting";
    }
    for (const task of Object.values(tasks)) {
      if (!task.workspaceId) continue;
      if (task.status === "confirming" || task.status === "waiting") {
        out[task.workspaceId] = "waiting";
      } else if (
        task.status === "failed" &&
        out[task.workspaceId] !== "waiting" &&
        // 失败标记跟未读同生命周期：点开看过后就消失，不永久挂在左栏。
        unread[task.workspaceId]
      ) {
        out[task.workspaceId] = "failed";
      }
    }
    return out;
  }, [approvalEntries, tasks, unread]);
  const unreadIds = useMemo(() => new Set(Object.keys(unread)), [unread]);

  /**
   * 切会话时恢复它自己记住的标签。
   *
   * 四个标签的位置是固定的，用户在 A 看文件、在 B 看计划，切回来应该各归各的。
   */
  useEffect(() => {
    const state = useExtremeStore.getState();
    const key = state.workspaceId ?? "";
    if (!key) return;
    const nextPane = state.paneByWorkspace[key] ?? "files";
    // 输入偏好也按会话恢复：A 用「自选 + 简洁结论」，切到 B 不该沿用。
    const prefs = state.chatPrefsByWorkspace[key] ?? DEFAULT_CHAT_PREFS;
    useExtremeStore.setState({
      paneTab: nextPane,
      // 老数据只有"当前标签"：补成已打开列表，避免标签栏空着。
      paneLists: {
        ...state.paneLists,
        [key]: state.paneLists[key]?.length ? state.paneLists[key] : [nextPane],
      },
      paneMru: {
        ...state.paneMru,
        [key]: state.paneMru[key]?.length ? state.paneMru[key] : [nextPane],
      },
      chatPrefs: prefs,
    });
  }, [workspaceId]);

  /**
   * 切回某条对话时，把它在后台等着的面板打开。
   *
   * A 在看日志时切到 B：A 的探测结果**归 A**（消息已经写回它那条），右栏等
   * 用户回到 A 再展开 —— 既不弹到 B 脸上，也不把查到的结果丢在路上。
   */
  useEffect(() => {
    if (!workspaceId) return;
    const pending = pendingPanelRef.current!;
    const request = pending.get(workspaceId);
    if (!request) return;
    pending.delete(workspaceId);
    const now = useExtremeStore.getState();
    // 连接换了：旧来源不能打开（那是上一台机器/上一次连接的日志）。
    if (request.scope.sessionId !== now.sessionId) return;
    const { scope: _scope, ...panelRequest } = request;
    if (panelRequest.tab === "files") {
      if (!panelRequest.path) return;
      setWorkspaceTarget({
        kind: "directory",
        path: panelRequest.path,
        sessionId: request.scope.sessionId,
      });
      openPaneTab("files");
      return;
    }
    openPanel(panelRequest);
  }, [workspaceId, openPanel, openPaneTab, setWorkspaceTarget]);

  /**
   * 左栏当前对话的标题。
   *
   * 传**字符串**而不是整个 `messages`：流式回答时 messages 每个 token 都变，
   * 传数组会让整个侧栏跟着重渲染；标题只在首个用户消息变化时才不同。
   */
  const currentWorkspaceTitle = useMemo(() => {
    const entry = workspaces.find((item) => item.id === workspaceId);
    const custom = entry?.title?.trim();
    if (custom) return custom;
    const first = messages.find((message) => message.role === "user")?.text ?? "";
    return first.trim().split("\n")[0] ?? "";
  }, [workspaces, workspaceId, messages]);

  const handleNewWorkspace = useCallback(() => addWorkspace([]), [addWorkspace]);

  /**
   * 还有任务要处理的对话：删除会被拦下。
   *
   * 「删除对话」和「停止任务」是两件事 —— 正在跑或等确认时删掉记录，用户就
   * 再也看不到进度与输出，任务却还在服务器上跑。
   */
  const blockedIds = useMemo(
    () => blockedWorkspaces(tasks, workspaceId, executing),
    [tasks, workspaceId, executing],
  );

  /**
   * 正在跑的对话（左栏小状态点）。
   *
   * 只算真正在推进的状态：等确认 / 等补充信息是**停下来等用户**，不该亮
   * "运行中"。后台会话靠 `workspaceId` 归属，切走也不会丢。
   */
  const runningIds = useMemo(() => {
    const ids = new Set<string>();
    for (const task of Object.values(tasks)) {
      if (
        task.workspaceId &&
        (task.status === "inspecting" || task.status === "running" || task.status === "verifying")
      ) {
        ids.add(task.workspaceId);
      }
    }
    if (executing && workspaceId) ids.add(workspaceId);
    return ids;
  }, [tasks, workspaceId, executing]);

  const targetRequest = useRef(0);
  const openWorkspaceTarget = useCallback(
    async (target: WorkspaceTarget): Promise<boolean> => {
      const request = ++targetRequest.current;
      const state = useExtremeStore.getState();
      const owner = state.workspaceId;
      if (!owner) return false;
      if (target.kind === "website") {
        setBrowserUrl(owner, target.url);
        openPaneTab("browser");
        return true;
      }
      const session = state.sessionId;
      if (!session || (target.serverId ? target.serverId !== state.serverId : target.sessionId !== session)) {
        setNotice(t("服务器未连接：重新连接后才能打开这个文件。"));
        return false;
      }
      const stillHere = () => {
        const current = useExtremeStore.getState();
        return targetRequest.current === request && current.workspaceId === owner && current.sessionId === session;
      };
      try {
        const entry = await opsApi.sftpStat(session, target.path);
        if (!stillHere()) return true;
        if (entry.kind !== "directory" && entry.kind !== "file") return false;
        setWorkspaceTarget((previous) => ({
          ...target,
          path: entry.path,
          sessionId: session,
          revealNonce: previous?.kind === "directory" && previous.path === entry.path
            ? (previous.revealNonce ?? 1) + 1
            : 1,
        }));
        openPaneTab("files");
        return true;
      } catch (cause) {
        if (!stillHere()) return true;
        setNotice(toAppError(cause).message);
        return false;
      }
    },
    [openPaneTab, setBrowserUrl, t],
  );

  /** 回退：只退出Work，SSH 会话、滚动位置与草稿都由底层终端自己保留。 */
  const back = () => {
    exit();
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>("[data-terminal-composer]")?.focus();
    });
  };

  /**
   * 重新连接：超能自己的会话断了（或从首页进入后连接失效）时用。
   *
   * 走与首页 / 右键菜单同一条入口：复用已连接的会话，否则重新握手。
   * 对话本身不动，只换绑新连接。
   */
  const reconnect = () => {
    const state = useExtremeStore.getState();
    const target = state.serverId
      ? useDomainStore.getState().servers.find((item) => item.id === state.serverId)
      : undefined;
    if (!target) {
      setNotice(t("这台服务器已经不在服务器列表里：无法自动重连，请从服务器列表重新进入。"));
      return;
    }
    void enterExtremeForServer(target, {
      workspaceId: state.workspaceId ?? undefined,
      reconnect: true,
    });
  };


  /** 删掉服务器上的临时目录。退出Work、清空上下文都会调用。 */
  const planFromComposer = useCallback(() => {
    if (attachments.length === 0) {
      pushMessage({
        id: `msg-${crypto.randomUUID()}`,
        role: "assistant",
        local: true,
        text: t("先拖入 compose.yaml 或项目文件，再生成计划。"),
      });
      return;
    }
    const message = pushUserMessage(t("用这些附件生成部署计划"));
    // 按钮入口：这一次点击的对话与连接就是归属。
    void generatePlan(currentScope(), { originMessageId: message.id });
  }, [attachments.length, currentScope, generatePlan, pushMessage, pushUserMessage, t]);

  /**
   * 编辑自己发过的那句：原文回填输入框，替换掉当前草稿。
   *
   * 只改"接下来要发什么"，不会去改那条已经发出去的消息 —— 请求已经发出，
   * 假装它能被改写只会让人以为历史变了。
   */
  const editMessage = useCallback(
    (message: ExtremeMessage) => {
      /*
       * **编辑不能覆盖未发送的草稿**。
       *
       * 用户一边翻历史一边写了一半，点「编辑」把草稿清掉是数据丢失 ——
       * 这里宁可拒绝并说明，让他先发送或清空。
       */
      if (draft.trim() && draft.trim() !== message.text.trim()) {
        setNotice(t("输入框里还有未发送的草稿：先发送或清空，再编辑这条消息。"));
        return;
      }
      setDraft(message.text);
      focusComposerEnd();
    },
    [draft, setDraft, setNotice, t],
  );

  /**
   * 「重试」入口在**中断的那条回复**旁边：用同一个原问题重跑。
   *
   * 复用原任务卡（`retry.of`），不会每次重试都多出一张卡。
   */
  const retryInterrupted = useCallback(
    (assistant: ExtremeMessage) => {
      const state = useExtremeStore.getState();
      const list = state.messages;
      const at = list.findIndex((item) => item.id === assistant.id);
      if (at < 0) return;
      const source = [...list.slice(0, at)].reverse().find((item) => item.role === "user");
      if (!source) return;
      const running = Object.values(state.tasks).some(
        (task) =>
          task.workspaceId === state.workspaceId &&
          (task.status === "running" || task.status === "confirming"),
      );
      if (running) {
        setNotice(t("任务仍在执行：等它结束或点「停止」后再重试。"));
        return;
      }
      const card = assistant.taskId ? state.tasks[assistant.taskId] : undefined;
      // 重新发起前收掉旧标记：否则会看到两个"回复中断"。
      if (state.workspaceId) {
        patchMessageIn(state.workspaceId, assistant.id, {
          interrupted: null,
          interruptReason: null,
        });
      }
      void ask(source, 0, { of: card, bubble: source });
    },
    [ask, patchMessageIn, setNotice, t],
  );

  /** 没送达的那句话：原文放回输入框（连同已有草稿），用户直接重发。 */
  const resendMessage = useCallback(
    (message: ExtremeMessage) => {
      const owner = useExtremeStore.getState().workspaceId;
      if (owner) patchMessageIn(owner, message.id, { deliveryError: null });
      setDraft(draft.trim() ? `${draft}\n${message.text}` : message.text);
      focusComposerEnd();
    },
    [draft, patchMessageIn, setDraft],
  );

  /**
   * 引用一条模型回复：整段作为引用块插到草稿**前面**，原有草稿留着。
   *
   * 用户点「引用」通常是"对这段继续追问"，手头可能已经写了一半，直接覆盖就
   * 丢了。
   */
  const quoteMessage = useCallback(
    (message: ExtremeMessage) => {
      // `setDraft` 是普通 setter（草稿同时镜像到 store），当前值从 state 读。
      setDraft(`${quoteBlock(message.text)}${draft}`);
      focusComposerEnd();
    },
    [draft, setDraft],
  );

  const clearContext = () => {
    /*
     * 上传中清空会让"正在写的文件"失去归属（临时目录也可能被顺手删掉）：
     * 明确拒绝并要求等它结束 —— 清空是独立动作，但不该打断正在进行的执行。
     */
    if (uploading) {
      setNotice(t("正在上传文件：等上传结束后再清空对话。"));
      return;
    }
    // 附件没了，服务器上的临时副本也没有意义。
    cleanupRemote();
    setMessages([]);
    setAttachments(() => []);
    setPlan(null);
    setPlanSession(null);
    planTaskIdRef.current = null;
    useExtremeStore.setState({ planTaskId: null });
    setNotice(null);
    setPreview(null);
  };

  const mac = isMacOS();
  const hasContext = messages.length > 0 || attachments.length > 0 || !!plan?.length;

  /*
   * **提前 return 必须在所有 hooks 之后**。
   *
   * 之前它在中间：`active` 从 false 变 true 时，后面的 `useCallback` /
   * `useEffect` 会突然多执行几个，React 直接报
   * `Rendered more hooks than during the previous render`。
   */
  /*
   * 把执行器挂给 `ask`。放在这里是因为上传、生成计划、跑计划都已定义完毕；
   * 每次渲染重新赋值，`ask` 里拿到的就是最新的闭包。
   */
  execRef.current = {
    upload: async (scope, taskId) => uploadToServer(scope, taskId),
    plan: async (scope, service, originMessageId) => {
      if (service) {
        /*
         * 指定了服务就**先探测再匹配**：候选只存在于这一轮渲染的 state 里，
         * 模型发起 `[[plan:x]]` 时通常还没探测过。探测走**发起时那条连接**。
         */
        const list =
          scope.candidates && scope.candidates.length > 0
            ? scope.candidates
            : await probeServices(scope);
        const chosen = list.find((item) => item.name === service);
        if (!chosen) {
          return {
            receipt: t("没有找到容器 {{name}}：先说清要更新哪个服务，我再列一遍在跑的容器。", {
              name: service,
            }),
          };
        }
        // 卡片挂在**那条回复**下面：模型发起的就是任务来源，不另造一条用户消息。
        planUpdate(scope, chosen, originMessageId);
        return {
          receipt: t("已生成 {{name}} 的更新计划（备份 → 解压 → 替换 → 重启 → 验证）。", {
            name: chosen.name,
          }),
        };
      }
      /*
       * 没有来源消息时补一条**本机提示**，绝不能补用户消息：那等于凭空多出一
       * 条"用户说过"的蓝色气泡，还会清掉草稿、改会话标题。
       */
      let origin = originMessageId;
      if (!origin) {
        const notice: ExtremeMessage = {
          id: `msg-${crypto.randomUUID()}`,
          role: "assistant",
          local: true,
          text: t("已按你的要求生成部署计划。"),
        };
        pushMessageTo(scope.workspaceId, notice);
        origin = notice.id;
      }
      await generatePlan(scope, { originMessageId: origin });
      return { receipt: t("已生成部署计划。") };
    },
    terminal: async (scope, command) => {
      const blocked = scopeBlocked(scope);
      if (blocked) {
        pauseAction(scope, blocked);
        return { receipt: t("这一步已暂停：{{reason}}", { reason: blocked }), paused: true };
      }
      /*
       * 面板收着时 `ManualTerminal` 还没挂载、PTY 也不存在，直接发命令会失败。
       * 先建好通道，用户看到的是命令自己跑起来，而不是"你先手动打开终端"。
       */
      if (scopeIsForeground(scope)) openPaneTab("terminal", "manual");
      await ensureManualShell(scope.workspaceId, scope.sessionId);
      const sent = await manualShellSend(scope.workspaceId, command);
      if (!sent) {
        return {
          receipt: t("右侧真实终端打不开：这条会话的终端通道没有起来，重连服务器再试。"),
        };
      }
      const tail = await manualShellTail(scope.workspaceId, 40);
      return {
        receipt: t("已在右侧真实终端开始监听：{{command}}\n最近输出：\n{{tail}}", {
          command,
          tail: tail || t("（暂时没有输出，日志一有内容就会出现在终端里）"),
        }),
      };
    },
    start: async (scope, taskId) => {
      const steps = scope.plan ?? [];
      if (steps.length === 0) return { receipt: t("还没有可执行的计划，先说明要做什么。") };
      const planTask = scope.planTaskId;
      /*
       * **模型只能"建议开始"**：`[[start]]` 不是用户的同意。没有用户表态就
       * 直接执行，等于让模型自己按了执行键 —— 这里把话退回给模型，让它去请
       * 用户回复「开始吧」。
       */
      if (!planTask || !userConfirmedPlansRef.current.has(planTask)) {
        return {
          receipt: t(
            "计划还没有得到用户确认：请用一句话请用户回复「开始吧」，不要假设已经执行。",
          ),
        };
      }
      await runPlan(planTask, scope);
      /*
       * 回执按**执行完的真实状态**拼：任务卡与「执行结果」用的是同一份数据，
       * 模型看到的就是用户看到的。
       */
      const done = steps.map((step) => ({ ...step }));
      const report = runReport(t, done);
      if (taskId) upsertReport(taskId, report);
      return {
        receipt: report.detail
          ? `${t(report.title)}\n${report.detail}`
          : t(report.title),
        // 归属在跑的过程中断了：`runPlan` 已把原因写回原对话。
        paused: scopeBlocked(scope) !== null,
      };
    },
  };

  if (!active) return null;

  return (
    /* 主题提在根节点：气泡、输入、附件、弹窗共用同一套深色 token。 */
    <ConfigProvider theme={antdThemeFor(dark)}>
    <div
      className="extreme-core fixed inset-0 z-50 flex flex-col overflow-hidden text-fg"
      /*
       * **跟随应用主题**：不写死颜色、也不覆盖 token 变量，外层
       * `data-theme` 是浅色就是浅色、深色就是深色，和其他页面一致。
       */
      style={{ colorScheme: dark ? "dark" : "light" }}
      data-welcome={welcome}
      data-motion={motionMode}
      onDragOver={(event) => {
        /*
         * 拖**文件夹**时 `dataTransfer.types` 不一定含 "Files"（不同平台与
         * 浏览器给的值不一样）。以前这里一看到没有 "Files" 就直接 return，
         * 于是没有 `preventDefault`，浏览器认为"此区域不可放置"，**drop 事件
         * 根本不会触发** —— 这就是拖文件夹完全没反应的原因。
         */
        if (event.dataTransfer.items.length === 0 && event.dataTransfer.types.length === 0) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragOver(true);
      }}
      onDragLeave={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
          setDragOver(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        // 文件夹会被递归展开成相对路径；没有 Entry API 时退回普通文件列表。
        void collectDropped(event.dataTransfer).then((entries) => {
          if (entries.length > 0) addFiles(entries);
        });
      }}
    >
      {/*
       * 背景按主题分工：深色用 ShapeWaves，浅色用官方 **Aero Shards**。
       *
       * 两个都是 WebGPU 组件，互斥挂载，任何时刻只初始化一个。浅色这边只用
       * 组件公开参数（材质、密度、颗粒、暗角）把它压到"从空白处透出来"的强度，
       * 着色器、玻璃折射、景深、鼠标扰动全部走官方实现。
       */}
      {welcome && (dark ? (
        <div className="extreme-core-background" aria-hidden="true" style={{ opacity: 0.2 }}>
          <ShapeWaves
            shapes="mixed"
            text="BLS-OPS"
            textSize={0.42}
            fontWeight={600}
            cellSize={15}
            dotSize={0.72}
            color="#929292"
            hoverColor="#a8d7ff"
            backgroundColor="#08090d"
            brightness={0.48}
            glow={0.42}
            speed={1}
            interactive
          />
        </div>
      ) : (
        <div
          className="pointer-events-none absolute inset-0 overflow-hidden"
          aria-hidden="true"
          style={{ opacity: 0.7 }}
        >
          <AeroShards
            lightMode
            backgroundColor="transparent"
            shardColor="#33405c"
            accentColor="#4d82ff"
            material="glass"
            count={900}
            glow={0}
            grain={0.04}
            vignette={0.12}
            markers="plus"
            mouseInteraction
            dpr={1.5}
          />
        </div>
      ))}

      <ExtremeHeader
        server={server}
        serverHost={serverHost}
        mac={mac}
        onBack={back}
        paneShown={paneShown}
        onOpenPane={togglePane}
        onOpenHistory={() => setHistoryOpen(true)}
      />

      <div ref={rowRef} className="extreme-core-row relative z-10 flex min-h-0 flex-1">
        {/*
         * 已上传到服务器 → 左栏直接显示**服务器的那个临时目录**，用项目
         * 自己的文件面板（浏览、预览、右键操作全都现成）。没上传时显示
         * 本机附件树。
         */}
        <div ref={railRef} className="flex min-h-0 shrink-0">
          <TaskSidebar
            entries={workspaceEntries}
            currentId={workspaceId}
            currentTitle={currentWorkspaceTitle}
            busy={executing || workspaceRunning || uploading || probing}
            /* 新建任务 = 主动开一条空白对话（唯一会主动建记录的地方之一）。 */
            onNew={() => {
              setMainView(null);
              handleNewWorkspace();
            }}
            onOpen={(id) => {
              setMainView(null);
              openWorkspace(id);
            }}
            onRename={renameWorkspace}
            onDelete={removeWorkspace}
            blockedIds={blockedIds}
            runningIds={runningIds}
            attentionById={attentionById}
            unreadIds={unreadIds}
            outputStyle={chatPrefs.output}
            onOutputStyleChange={setOutputStyle}
            hasContext={hasContext}
            onClearCurrent={clearContext}
            activePage={mainView}
            onOpenPage={(page) => {
              if (page === "mcp") setMcpTab("market");
              setMainView(page);
            }}
            onShowChat={() => setMainView(null)}
          />
        </div>
        <main className="extreme-core-main relative flex min-w-0 flex-1 flex-col">
          {/*
           * 聊天区始终挂载，只用 hidden 隐藏：切到设置 / 权限 / MCP 再回来，
           * 滚动位置、草稿和输入区状态都保持原样，后台任务继续输出。
           */}
          <div className={cn("flex min-h-0 flex-1 flex-col", mainView && "hidden")}>
          {/*
           * 只读提示：这条对话所属的服务器现在没有连接。
           *
           * 常见于「从左侧打开了另一台服务器的历史」或「刚断开」——可以看历史
           * 与产物，不能继续执行。绝不借用当前这台服务器的连接。
           */}
          {!sessionId && (
            <div
              role="status"
              className="mx-3 mt-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-11 text-warning"
            >
              {t("这条对话所属的服务器当前未连接：可以查看历史，重新连接后才能继续执行。")}
            </div>
          )}
          {/*
           * 本地历史保存失败（配额满 / 被禁用）：明确告诉用户"现在能看，重启后
           * 可能没有"。以前这个错误被吞掉，最容易出现"聊了一下午，重开全没了"。
           */}
          {historyError && (
            <div
              role="alert"
              className="mx-3 mt-2 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-11 text-warning"
            >
              <span className="min-w-0 flex-1">{historyError}</span>
              <Tooltip label={t("关闭提示")}>
                <button
                  type="button"
                  aria-label={t("关闭提示")}
                  className="shrink-0 px-0.5 hover:text-fg"
                  onClick={dismissHistoryError}
                >
                  ×
                </button>
              </Tooltip>
            </div>
          )}
          {/*
           * 服务候选：探测完在这里列出，点一个就直接生成更新计划。
           * 只读探测的结果，不点就不会动服务器。
           */}
          {candidates && (
            <ServiceCandidates
              candidates={candidates}
              onPick={(service) => planUpdate(currentScope(), service)}
              onDismiss={() => setCandidates(null)}
            />
          )}
          {/*
           * 拖拽反馈：**只在拖动时**出现（松手后附件进左栏树），平时不占高度。
           */}
          {welcome && (
            <WelcomeIntro
              attachmentCount={attachments.length}
              remoteRoot={remoteRoot}
              uploading={uploading}
              onUpload={() => void uploadToServer(currentScope())}
              onGeneratePlan={planFromComposer}
              onImportFolders={(folders, added) => {
                addFolders(folders);
                setAttachments((list) => [...list, ...added]);
              }}
            />
          )}


          <ChatColumn
            welcome={welcome}
            scrollRef={scrollRef}
            stickToBottom={stickToBottom}
            atBottom={atBottom}
            scrollToBottom={scrollToBottom}
            messages={messages}
            asking={asking}
            attachments={attachments}
            sessionTasks={sessionTasks}
            openArtifact={openArtifact}
            sessionId={sessionId}
            openWorkspaceTarget={openWorkspaceTarget}
            resumeTask={resumeTask}
            quoteMessage={quoteMessage}
            editMessage={editMessage}
            retryInterrupted={retryInterrupted}
            resendMessage={resendMessage}
            openChanges={openChanges}
            plan={plan}
            panelOpen={panelOpen}
            setPanelOpen={setPanelOpen}
            executing={executing}
            doneCount={doneCount}
            currentStep={currentStep}
            failedStep={failedStep}
            notice={notice}
            setNotice={setNotice}
            workspaceId={workspaceId}
            planCard={planCard}
            approvals={approvalEntries}
            onDecideApproval={(allow, callId, taskId) =>
              void decideApprovalById(allow, callId, taskId)
            }
          />

          <StatusStack
            askError={askError}
            retryMessage={retryMessage}
            currentApprovals={composerApprovals}
            tasks={tasks}
            decideApprovalById={decideApprovalById}
            openPaneTab={openPaneTab}
            openChanges={openChanges}
            sessionId={sessionId}
            reconnect={reconnect}
            notice={notice}
            setNotice={setNotice}
            stopOverdueId={stopOverdueId}
            activeTask={activeTask}
            forceStop={forceStop}
            staleTask={staleTask}
            stopPending={stopPending}
            statusLine={statusLine}
            recheckTask={recheckTask}
            executing={executing}
          />

          <SendQueuePanel
            items={currentQueue}
            onMoveUp={moveSendUp}
            onEdit={editQueuedSend}
            onDrop={dropSend}
            onRetry={retrySend}
          />

          <ComposerPanel
            draft={draft}
            onDraftChange={setDraft}
            onSend={(text, selection) => void ask(text, 0, undefined, { selection })}
            onCancel={stopRun}
            busy={canStop}
            onOpenAttachments={() => openPaneTab("attachments")}
            contextUsage={contextUsage}
            attachmentNames={activeTaskAttachmentNames}
            planSteps={activeTask?.steps.length ?? 0}
            selectedAttachments={composerAttachments.map((item) => item.path ?? item.name)}
            onRemoveAttachment={(name) => {
              // 输入区里删掉的附件 = 右栏取消勾选（文件本身仍在会话里）。
              // 用路径做标识：不同目录下的同名文件不会一起被删掉。
              setSelectedAttachmentIds((ids) =>
                ids.filter((id) => {
                  const item = attachments.find((entry) => entry.id === id);
                  return (item?.path ?? item?.name) !== name;
                }),
              );
            }}
            focusLabel={
              focusId
                ? (() => {
                    const item = attachments.find((entry) => entry.id === focusId);
                    return item ? (item.path ?? item.name) : null;
                  })()
                : null
            }
            onClearFocus={() => setFocusId(null)}
            permission={permission}
            onPermissionChange={setPermission}
            onManagePermissions={() => setMainView("permissions")}
            connected={Boolean(sessionId)}
            contextMode={chatPrefs.context}
            onContextModeChange={setContextMode}
            picked={chatPrefs.picked}
            onRemovePicked={removePicked}
            providers={providers}
            providerId={chatPrefs.providerId}
            onProviderChange={setProviderId}
            modelSettings={modelSettings}
            onModelSettingChange={setModelSetting}
            running={asking}
            sendWhileRunning={sendWhileRunning}
            onSendWhileRunningChange={setSendWhileRunning}
            maxRows={composerMaxRows}
            mcp={mcpCapabilities}
            onOpenMcpMarket={() => {
              setMcpTab("market");
              setMainView("mcp");
            }}
            onManageMcp={() => {
              setMcpTab("connections");
              setMainView("mcp");
            }}
          />
          {/*
           * 拖拽反馈只盖聊天区：右栏（尤其是文件变更面板）不能被这层半透明
           * 框罩住 —— 它同样接收 drop，但视觉上应该保持清晰可读。
           */}
          {dragOver && !mainView && (
            <div className="pointer-events-none absolute inset-0 z-20 border-2 border-dashed border-accent/50 bg-accent/5" />
          )}
          </div>
          {/* 管理页：只换 main 里的内容，右栏与聊天状态都不动。 */}
          {mainView === "settings" && (
            <ExtremeSettingsPage
              onBack={() => setMainView(null)}
              onManagePermissions={() => setMainView("permissions")}
              onManageMcp={() => {
                setMcpTab("connections");
                setMainView("mcp");
              }}
            />
          )}
          {mainView === "permissions" && (
            <ExtremePermissionsPage
              workspaceId={workspaceId}
              workspaceTitle={currentWorkspaceTitle}
              serverId={serverId}
              onBack={() => setMainView(null)}
              onManageMcp={() => {
                setMcpTab("connections");
                setMainView("mcp");
              }}
              onRestoreBackup={(backupPath, originalPath) => {
                setMainView(null);
                void ask(
                  `请把备份 ${backupPath} 还原到 ${originalPath}。先确认目标文件、当前版本和权限；目标不明确或备份不存在就停下说明原因，不要猜路径。`,
                );
              }}
            />
          )}
          {mainView === "mcp" && (
            <ExtremeMcpPage
              initialTab={mcpTab}
              workspaceId={workspaceId}
              serverId={serverId}
              serverName={server ?? ""}
              connected={Boolean(sessionId)}
              onBack={() => setMainView(null)}
            />
          )}
        </main>

        {paneShown && (
          <WorkspacePanel
            sessionId={sessionId}
            serverName={server ?? ""}
            view={paneView === "expanded" ? "expanded" : "split"}
            width={paneFit}
            overlay={paneOverlay}
            tab={paneTab}
            tabs={paneLists[workspaceId ?? ""] ?? [paneTab]}
            terminalTab={terminalPane}
            onTabChange={setPaneTab}
            onOpenPaneTab={openPaneTab}
            onCloseTab={closePane}
            onTerminalTabChange={setTerminalPane}
            logLive={logStream?.status === "connecting" || logStream?.status === "live"}
            logs={
              workspaceId ? (
                <LogsPane
                  key={workspaceId}
                  workspaceId={workspaceId}
                  serverId={serverId}
                  sessionId={sessionId}
                  source={logSourceByWorkspace[workspaceId] ?? logStream?.source ?? null}
                  onChoose={(source) => {
                    setLogSource(workspaceId, source);
                    openPaneTab("logs");
                  }}
                />
              ) : null
            }
            browser={
              workspaceId ? (
                <BrowserPane
                  key={workspaceId}
                  workspaceId={workspaceId}
                  url={browserByWorkspace[workspaceId] ?? null}
                  onUrlChange={(url) => setBrowserUrl(workspaceId, url)}
                />
              ) : null
            }
            changes={
              <FileChangesPane
                key={workspaceId ?? "none"}
                workspaceId={workspaceId}
                serverName={server ?? ""}
                sessionId={sessionId}
                focus={changeFocus}
                onOpenRemotePath={(path) => {
                  // 打开**所在目录**：远程面板按目录定位，文件本身由面板高亮。
                  setWorkspaceTarget({
                    kind: "directory",
                    path: path.slice(0, path.lastIndexOf("/")) || "/",
                    sessionId: sessionId ?? "",
                  });
                  openPaneTab("files");
                }}
              />
            }
            pendingChanges={pendingChangeCount}
            // 拖到"聊天只剩 520"为止；再往里拖没有意义，宽度也存不下。
            onWidthChange={(next, persist) => setPaneWidth(next, { persist })}
            onOuterDragStart={onPaneOuterDragStart}
            onDraggingChange={setPaneDragging}
            onCollapse={collapsePane}
            onAddTerminalOutput={() => void addTerminalOutput()}
            onExpand={() => setPaneView("expanded")}
            onRestore={() => setPaneView("split")}
            attachments={attachments}
            selectedIds={selectedAttachmentIds}
            onSelectedChange={setSelectedAttachmentIds}
            onPreviewAttachment={(id) => handleAttachmentPreview({ uid: id })}
            onRetryAttachment={() => void uploadToServer(currentScope())}
            onUploadAttachments={() => void uploadToServer(currentScope())}
            uploadingAttachments={uploading}
            onRemoveAttachment={(id) => handleAttachmentRemove({ uid: id })}
            onOpenRemotePath={(path) => {
              setWorkspaceTarget({
                kind: "directory",
                path: path.slice(0, path.lastIndexOf("/")) || "/",
                sessionId: sessionId ?? "",
              });
              openPaneTab("files");
            }}
            runLabel={runStateLabel(runState, t)}
            steps={activeTask?.steps ?? []}
            plan={runRecord}
            onFocusStep={() => {
              setPaneTab("terminal");
              setTerminalPane("output");
            }}
            outputCount={activeTask?.steps.length ?? 0}
            files={
              <RemoteWorkspacePanel
                embedded
                sessionId={sessionId ?? ""}
                remoteRoot={remoteRoot}
                target={
                  workspaceTarget ??
                  (panelTarget?.path
                    ? { kind: "directory", path: panelTarget.path, sessionId: sessionId ?? "" }
                    : null)
                }
                onReset={() => setWorkspaceTarget(null)}
                onClose={collapsePane}
                attachments={attachments}
                preview={preview}
                follow={
                  workspaceTarget
                    ? null
                    : agentCwdRef.current
                      ? { nonce: followNonce, path: agentCwdRef.current }
                      : null
                }
                onPreview={handlePreview}
                onRemove={handleRemoveAttachment}
                onAddToChat={handleAddToChat}
                onAddRemoteToChat={handleAddRemoteToChat}
                onPathChange={(path) => {
                  if (workspaceId) setRemotePath(workspaceId, path);
                }}
                onError={(cause) => setAskError(toAppError(cause).message)}
              />
            }

            manual={<ManualTerminal workspaceId={workspaceId} sessionId={sessionId} />}
            output={
              <CommandOutput key={activeTask?.id ?? workspaceId} task={activeTask} />
            }
          />
        )}
      </div>

      {/* 任务历史与统一文件预览：都是浮层，挂在最外层，切面板不会把它们带走。 */}
      <TaskHistoryPanel
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onPreview={openArtifact}
        onOpenWorkspace={(id) => {
          setHistoryOpen(false);
          openWorkspace(id);
        }}
        onOpenTask={(id, taskId) => {
          setHistoryOpen(false);
          openWorkspace(id);
          // 切过去之后 effect 再滚到消息：这里只记下目标。
          setHistoryFocus({ workspaceId: id, taskId });
        }}
      />
      {filePreview && (
        <FilePreviewModal source={filePreview} onClose={() => setFilePreview(null)} />
      )}
    </div>
    </ConfigProvider>
  );
}
