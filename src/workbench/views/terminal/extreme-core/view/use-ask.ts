/**
 * 一次提问的**完整生命周期**：归属快照 → 意图路由 → 调后端 → 动作链 → 收尾。
 *
 * 这是整个超能视图里唯一会 push 用户气泡、清草稿、发起 `agent_start` 的地方。
 * 工具执行完把回执交给模型走 `feedToolReport`（不再伪装成"用户又发了一句"）。
 *
 * 所有异步步骤只认发起时的 `ActionScope`：切对话 / 换服务器都不会把 A 的
 * 请求落到 B 上；只有"动界面"的部分才按前台判断。
 */
import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { i18n as I18n } from "i18next";
import { opsApi } from "@/api/ops-api";
import type { AgentApproval, AgentStep } from "@/api/types/agent";
import { useExtremeStore } from "@/stores/extreme-store";
import type { ExtremeAttachment, ExtremeMessage, SentAttachment } from "@/stores/extreme-store";
import { toAppError } from "@/lib/app-error";
import { scopeForeground, type ActionScope, type ScopeWorld } from "../action-scope";
import { cardFromAgent } from "../agent-steps";
import { forgetAgentWait, waitForAgentRun } from "../agent-run";
import { parseActions, type StreamFilter } from "../chat-actions";
import { isLogIntent, matchChoice } from "../log-discovery";
import { manualShellTail } from "../manual-shell";
import { effectiveProvider, effortParam, type ModelSelection, type ProviderChoice } from "../model-choice";
import { parsePanelAction, stripPanelAction, type PanelRequest } from "../panel-target";
import { attachmentReadState } from "../attachments";
import { shouldAttachTerminalTail, terminalTailBlock } from "../chat-context";
import { approvalIntent, isRetryIntent, isStopIntent, routeIntent } from "../intent";
import type { LogSource } from "@/api/types/panel";
import type { CheckItem } from "../checks";
import type { DeployStep } from "../deploy-plan";
import type { PermissionMode } from "../permissions";
import type { PreflightResult } from "../preflight";
import { nextSend, queuedSend as newQueuedSend, type QueuedSend } from "../send-queue";
import type { RequestScope, ScopeTracker } from "../request-scope";
import type { ServiceCandidate } from "../update-plan";
import { contextsOfTasks } from "../task-bridge";
import type { TaskCardModel } from "../task-view";
import { explainApproval } from "./helpers";
import { buildMessages } from "./prompt";
import type { ActionResult } from "./types";

type Store = ReturnType<typeof useExtremeStore.getState>;

/** `ask` 能调用的执行器集合（上传 / 计划 / 执行 / 终端）。 */
export interface AgentExecutors {
  upload: (scope: ActionScope, taskId?: string) => Promise<ActionResult>;
  plan: (scope: ActionScope, service?: string, originMessageId?: string) => Promise<ActionResult>;
  start: (scope: ActionScope, taskId?: string) => Promise<ActionResult>;
  terminal: (scope: ActionScope, command: string) => Promise<ActionResult>;
}

export interface AskDeps {
  t: (key: string, options?: Record<string, unknown>) => string;
  i18n: I18n;
  active: boolean;
  asking: boolean;
  /** 停止请求已发出、后端还没确认。 */
  getStopping: () => boolean;
  executing: boolean;
  draft: string;
  approval: AgentApproval | null;
  sendWhileRunning: "steer" | "queue";
  logChoices: { scope: RequestScope; choices: LogSource[] } | null;
  setLogChoices: Dispatch<SetStateAction<{ scope: RequestScope; choices: LogSource[] } | null>>;
  messages: ExtremeMessage[];
  tasks: Record<string, TaskCardModel>;
  queuedSends: QueuedSend[];
  connections: Store["connections"];
  runEpoch: number;
  composerAttachments: ExtremeAttachment[];
  chatPrefs: Store["chatPrefs"];
  plan: DeployStep[] | null;
  planSession: string | null;
  candidates: ServiceCandidate[] | null;
  remoteRoot: string | null;
  preflight: PreflightResult | null;
  permission: PermissionMode;
  envChecks: CheckItem[];
  attachments: ExtremeAttachment[];
  focusId: string | null;
  selectedAttachmentIds: string[];
  providers: ProviderChoice[];
  server: string | null;
  serverId: string | null;
  sessionId: string | null;
  /** 事件丢失 / 快照超时的那条任务（停止入口会优先指向它）。 */
  staleTask: string | null;
  /** 按钮入口的归属快照（重试部署计划时用）。 */
  currentScope: () => ActionScope;
  setDraft: (value: string) => void;
  setNotice: Store["setNotice"];
  setAskError: (value: string | null) => void;
  setRetryMessage: (value: ExtremeMessage | null) => void;
  setAsking: Dispatch<SetStateAction<boolean>>;
  setFocusId: Dispatch<SetStateAction<string | null>>;
  setSelectedAttachmentIds: Dispatch<SetStateAction<string[]>>;
  setModel: Store["setModel"];
  setTaskUsage: Store["setTaskUsage"];
  upsertTask: Store["upsertTask"];
  setStaleTask: Dispatch<SetStateAction<string | null>>;
  setRunEpoch: Dispatch<SetStateAction<number>>;
  setStoppingIds: Dispatch<SetStateAction<Set<string>>>;
  setStopOverdueId: Dispatch<SetStateAction<string | null>>;
  pushMessage: Store["pushMessage"];
  pushUserMessage: (text: string) => ExtremeMessage;
  pushMessageTo: Store["pushMessageTo"];
  patchMessage: Store["patchMessage"];
  patchMessageIn: Store["patchMessageIn"];
  removeMessageIn: Store["removeMessageIn"];
  dropClosedApprovals: () => void;
  decideApprovalById: (allow: boolean, callId: string, taskId: string) => Promise<void>;
  openPanel: Store["openPanel"];
  generatePlan: (scope: ActionScope, input: { originMessageId: string; taskId?: string }) => Promise<void>;
  runPlan: (targetId?: string, scope?: ActionScope) => Promise<void>;
  queueSend: Store["queueSend"];
  dropSend: Store["dropSend"];
  failSend: Store["failSend"];
  saveAgentTask: (card: TaskCardModel, immediate: boolean) => void;
  applyTerminalSnapshot: (snapshot: import("@/api/types/agent").AgentSnapshot, notify?: boolean) => boolean;
  selectionFromStore: () => ModelSelection;
  resolveRetrySource: () => { message: ExtremeMessage; card?: TaskCardModel } | null;
  retryNoteFor: (card?: TaskCardModel) => string;
  openLogFromIntent: (
    text: string,
    workspaceAt: string,
    sessionAt: string,
  ) => Promise<{ opened: boolean; question?: string; deferred?: boolean }>;
  openPanelFromAction: (request: PanelRequest, workspaceAt: string, sessionAt: string) => Promise<string>;
  taskSelectionsRef: MutableRefObject<Map<string, ModelSelection>>;
  taskIdRef: MutableRefObject<string | null>;
  inFlightRef: MutableRefObject<Set<string>>;
  askSeqRef: MutableRefObject<Record<string, number>>;
  scopeTracker: MutableRefObject<ScopeTracker | null>;
  planTaskIdRef: MutableRefObject<string | null>;
  stopTasksRef: MutableRefObject<Set<string>>;
  userConfirmedPlansRef: MutableRefObject<Set<string>>;
  runMetaRef: MutableRefObject<{
    taskId: string;
    context: string;
    output: string;
    providerId: string | null;
  } | null>;
  streamingReplies: MutableRefObject<Map<string, string>>;
  streamFilters: MutableRefObject<Map<string, StreamFilter>>;
  textBuffers: MutableRefObject<Map<string, { ownerId: string; messageId: string; raw: string }>>;
  agentStepsRef: MutableRefObject<Map<string, AgentStep[]>>;
  agentCwdRef: MutableRefObject<string | null>;
  execRef: MutableRefObject<AgentExecutors | null>;
  scopeWorld: () => ScopeWorld;
  stickToBottom: MutableRefObject<boolean>;
  /** 停止按钮指向的那条任务：取消入口在渲染后才知道，用 getter 取。 */
  getActiveTaskId: () => string | null;
}

export function useAsk(deps: AskDeps) {
  const {
    t,
    i18n,
    active,
    asking,
    getStopping,
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
    getActiveTaskId,
  } = deps;

  const ask = async (
    input?: string | ExtremeMessage,
    depth = 0,
    retry?: { of?: TaskCardModel; bubble?: ExtremeMessage },
    /**
     * 复用同一个 taskId：**工具回执续跑**时用。
     *
     * 续跑是同一件事的下一步，卡片 / 操作链 / 执行结果都必须还是那一条；
     * 新起一个 id 会让上传结果挂在一张已经没人看的卡下面。
     */
    options?: {
      taskId?: string;
      selection?: ModelSelection;
      /** 队列派发：目标对话 / 附件 / 模型都来自入队那一刻的快照。 */
      queued?: QueuedSend;
      /** 动作续跑：明确回到发起它的那条对话（可能已在后台）。 */
      workspaceId?: string;
      /**
       * 消息已经落进对话（受理成功）。
       *
       * 队列派发用它**立刻出队**：请求会跑很久，等 `ask` 返回才出队的话，
       * 界面上会一直挂着"待发送"。
       */
      onAccepted?: () => void;
    },
  ): Promise<boolean> => {
    const queued = options?.queued;
    /*
     * **点击发送那一刻**的快照：必须在任何 await 之前取。
     *
     * 之后等终端输出 / 附件、切到 B、改模型都不再读 store；续跑按 taskId
     * 复用第一次的快照，运行中的任务因此始终使用启动时的模型。
     */
    const selectionAtRequest =
      queued?.selection ??
      options?.selection ??
      (options?.taskId ? taskSelectionsRef.current.get(options.taskId) : undefined) ??
      selectionFromStore();
    /*
     * **新消息 vs 重试**，两者行为不同：
     * * 无参 / 字符串 —— 用户在输入框里发的**新消息**：要 push 气泡并清空草稿；
     * * 消息对象 —— 失败后的**重试**：那条已经 push 过，不能再推一次、也不该
     *   动草稿。
     */
    const isNew = input === undefined || typeof input === "string";
    /**
     * 用户主动发起的交互（表态 / 补要求 / 重试 / 排队）。
     *
     * 队列派发**不算**：它可能在 B 的前台替 A 发送，绝不能命中"当前审批"
     * 这类只属于前台对话的分支。
     */
    const interactive = isNew && !queued;
    /*
     * 欢迎态（这台服务器还没有任何对话）发出第一条消息时才落记录。
     * 先建再发，后面的气泡 / 任务卡才有 workspace 可挂。
     */
    if (interactive && depth === 0) {
      const id = useExtremeStore.getState().ensureWorkspace();
      if (!id) return false;
    }
    const text = (typeof input === "string" ? input : input?.text ?? draft).trim();
    // 空文本静默是合理的；未连接却静默丢弃违反"静默丢弃比报错更糟"。
    if (!text) return false;
    /*
     * 这次请求发给哪条对话 / 哪条连接。
     *
     * 队列派发时**不读渲染闭包**：目标对话自己的服务器连接才是唯一合法目标；
     * 拿不到就保留队列项并说明原因。
     */
    const stateBefore = useExtremeStore.getState();
    const explicitOwner = queued?.workspaceId ?? options?.workspaceId;
    const workspaceAtRequest = explicitOwner ?? stateBefore.workspaceId ?? "";
    const entryBefore = stateBefore.workspaces.find((entry) => entry.id === workspaceAtRequest);
    const sessionAtRequest = explicitOwner
      ? (entryBefore?.serverId
          ? stateBefore.connections[entryBefore.serverId]?.sessionId ?? ""
          : stateBefore.workspaceId === workspaceAtRequest
            ? stateBefore.sessionId ?? ""
            : "")
      : sessionId;
    if (!sessionAtRequest) {
      if (queued) failSend(queued.id, t("这条对话的服务器未连接：重新连接后才能发送。"));
      setNotice(t("服务器未连接：重新连接后才能发送。"));
      return false;
    }
    /*
     * `asking` 只在**用户主动发起**时拦：动作执行完要自动续问一轮，那一轮
     * 是自己触发的，不该被上一次请求的 loading 状态挡住。
     */
    /*
     * 已经处理过的确认（已允许 / 已拒绝）在用户开口时收起。
     *
     * **还没处理的绝不能收起**：用户这句话可能就是在补充条件（"先确认备份
     * 存在"），确认条得留在原地等后端。
     */
    if (interactive) dropClosedApprovals();
    /*
     * 两阶段停止的中间态：停止还没被后端确认。
     *
     * 消息不受理、草稿留着，并明确说明正在发生什么 —— 静默丢弃比报错更糟。
     */
    if (interactive && asking && getStopping()) {
      setNotice(t("正在停止当前任务：停止完成后这条消息才能发送。"));
      return false;
    }
    /*
     * 这条**对话**是否真在跑。
     *
     * 不能用一个全局布尔：A 在跑时切到 B，B 明明空闲却发不出去。判断依据两条：
     * * `inFlightRef`（同步，连点两下时第二次也读得到）；
     * * 这条对话里有没有 running / waiting 的任务（重进接回来的任务没有 ask 在飞）。
     */
    const askWorkspace = workspaceAtRequest;
    const runningTask = Object.values(stateBefore.tasks).find(
      (task) =>
        task.workspaceId === askWorkspace &&
        (task.status === "running" || task.status === "confirming"),
    );
    const runningHere = Boolean(runningTask);
    const busy = depth === 0 && (inFlightRef.current.has(askWorkspace) || runningHere);
    /**
     * 把这句话按**入队那一刻**的选择存进当前对话的队列。
     *
     * 只清文字：勾选的附件仍留在右栏，取消排队后可以连同文字一起恢复成草稿。
     */
    const enqueueHere = () => {
      queueSend(
        newQueuedSend({
          workspaceId: askWorkspace,
          text,
          attachments: composerAttachments.map((item) => ({
            id: item.id,
            name: item.name,
            size: item.size,
            path: item.path,
            remotePath: item.remotePath,
          })),
          selection: selectionAtRequest,
          context: chatPrefs.context,
          output: chatPrefs.output,
          picked: chatPrefs.picked,
        }),
      );
      setDraft("");
      // 排队卡已经把内容和状态说全了；清掉上一条残留提示。
      setNotice(null);
    };
    if (interactive && executing && isStopIntent(text)) {
      pushUserMessage(text);
      const currentPlanTask =
        planTaskIdRef.current ?? useExtremeStore.getState().planTaskId;
      if (currentPlanTask) stopTasksRef.current.add(currentPlanTask);
      pushMessage({
        id: `msg-${crypto.randomUUID()}`,
        role: "assistant",
        local: true,
        text: t("正在停止。当前步骤结束后不会运行后续步骤。"),
      });
      return true;
    }
    /*
     * 执行中回「停」：Agent 循环在 Rust 侧，必须**通知后端**停下来
     * （当前命令跑完再停）；只清界面状态等于让它继续在服务器上跑。
     */
    if (interactive && asking && isStopIntent(text)) {
      pushUserMessage(text);
      void cancelAsk();
      return true;
    }
    /*
     * **有待确认的写操作**：用户这句话可能是在表态，而不是在提新任务。
     *
     * 「按你说的改 / 先别动」直接交给**原来那条任务**（`agent_approve`），不再
     * 新起一次运行；「会影响什么」只用卡片上的事实回答 —— 比重新问模型更快、
     * 也不会和正在等确认的这一步抢同一台机器。其余内容照常往下走。
     */
    if (interactive && approval) {
      const decision = approvalIntent(text);
      if (decision) {
        pushUserMessage(text);
        if (decision === "explain") {
          pushMessage({
            id: `msg-${crypto.randomUUID()}`,
            role: "assistant",
            local: true,
            text: explainApproval(approval, t),
          });
          return true;
        }
        await decideApprovalById(decision === "allow", approval.callId, approval.taskId);
        return true;
      }
      /*
       * 「完成后发送」：用户选的是排队，**不能**顺手撤回审批。
       *
       * 撤回只属于「补充给当前任务」—— 那是明确要改这一步；排队只是"等它
       * 结束再发"，把审批撤掉会让正在等确认的任务白等。
       */
      if (sendWhileRunning === "queue") {
        enqueueHere();
        return true;
      }
      /*
       * 不是表态、而是在补充条件：**就地撤回**这条待确认操作，把要求交给
       * 正在跑的任务重新评估。用户只需要说一遍，不必先拒绝再重发。
       */
      const bubble = pushUserMessage(text);
      try {
        const accepted = await opsApi.aiAgentSteer(approval.taskId, text);
        if (!accepted) {
          patchMessage(bubble.id, {
            deliveryError: t("这条任务已经结束：请重新发送。"),
          });
          setNotice(t("这条任务已经结束：请重新发送。"));
          return true;
        }
        // 确认条不在这里卸载：等后台的 `approval_withdrawn` 事件到达再收，
        // 桌面通知才有机会把"已撤回"推给用户。
        setNotice(t("已收到补充要求：撤回待确认操作，按新要求重新评估。"));
      } catch (cause) {
        const reason = toAppError(cause).message;
        // 没送达：原文字放回输入框，气泡上标出来，用户可以直接重发。
        patchMessage(bubble.id, { deliveryError: reason });
        setDraft(text);
        setAskError(reason);
      }
      return true;
    }
    /*
     * 上一条在问"要看哪个日志"：用户这句话点到哪个候选就开哪个。
     *
     * 候选**只属于问出它的那条对话**：同一台服务器上的两条对话共用连接，
     * B 里一句 "1" / "n" 不能被当成在回答 A。不是自己那条就完全不碰，
     * 让这句话照常走问答。
     */
    if (interactive && logChoices) {
      const here = useExtremeStore.getState();
      const tracker = scopeTracker.current!;
      const mine = tracker.accept(logChoices.scope, {
        workspaceId: here.workspaceId,
        sessionId: here.sessionId,
      });
      const chosen = mine ? matchChoice(text, logChoices.choices) : null;
      if (chosen) {
        pushUserMessage(text);
        setLogChoices(null);
        openPanel({ tab: "logs", source: chosen, sessionId: logChoices.scope.sessionId });
        return true;
      }
    }
    /*
     * 「重试」：先认出这句话指哪一次失败，再决定要不要真起一次运行。
     *
     * 无论是否受理，用户说的这句话都**立刻上屏并清空输入框** —— 之前这条路径
     * 直接 `ask(旧消息)`，界面上什么都不出现，看起来像"没发出去"。
     */
    if (interactive && isRetryIntent(text)) {
      // 部署任务在跑也算"仍在执行"：重试会和它抢同一台机器。
      if (busy || executing) {
        // 不受理就不重复显示这句话（第一条已经上屏了），只说明为什么没动。
        setNotice(t("任务仍在执行：等它结束或点「停止」后再重试。"));
        return true;
      }
      const bubble = pushUserMessage(text);
      inFlightRef.current.add(askWorkspace);
      try {
        const source = resolveRetrySource();
        if (source) {
          // 用**原请求**的消息重放：目标与上下文不变，也不再显示原提问。
          await ask(source.message, depth + 1, { of: source.card, bubble });
          return true;
        }
        // 没有失败的 Agent 任务：退回"上一次部署计划失败"的那条路。
        if (!executing && planTaskIdRef.current && plan?.some((step) => step.state === "failed")) {
          // 「重试」是用户自己下的指令，等价于确认了这一版计划。
          userConfirmedPlansRef.current.add(planTaskIdRef.current);
          await runPlan(planTaskIdRef.current, currentScope());
          return true;
        }
        pushMessage({
          id: `msg-${crypto.randomUUID()}`,
          role: "assistant",
          local: true,
          text: t("没有可重试的失败任务。"),
        });
      } finally {
        inFlightRef.current.delete(askWorkspace);
      }
      return true;
    }
    /*
     * 已经有任务在跑：不新开一条，而是作为**补充要求**交给正在跑的任务。
     *
     * 后端在下一步开始前把它交给模型；正在等确认的那一步会先撤回，避免用户
     * 说了"只查容器里的"、旧写操作却照样执行。任务刚好结束（拿不到任务）时
     * 明确让用户重发，不静默吞掉。
     */
    if (interactive && busy) {
      if (!runningTask) {
        setNotice(t("任务仍在执行：等它结束或点「停止」后再发送。"));
        return false;
      }
      /*
       * **僵尸任务检测**：卡片说还在跑，但后端已经没有这条运行（WebView
       * 重载 / 进程重启 / 循环异常退出）。这时 steer 一定失败，用户看到的
       * 是"永远发不出去"。先问一次快照：拿不到 / 已是终态就收敛卡片，
       * 这句话按**新任务**照常发送。
       */
      let alive = await opsApi.aiAgentSnapshot(runningTask.id).catch(() => null);
      if (!alive) {
        // 刚启动 / 注册尚未落定的极短窗口：再确认一次，避免误判成僵尸。
        await new Promise((resolve) => setTimeout(resolve, 500));
        alive = await opsApi.aiAgentSnapshot(runningTask.id).catch(() => null);
      }
      const zombie =
        !alive ||
        alive.status === "success" ||
        alive.status === "failed" ||
        alive.status === "cancelled";
      if (!zombie) {
        /*
         * 「完成后发送」：进这条对话的队列，等它空闲后按顺序发。
         * 入队时已锁定模型 / 附件 / 范围，之后改选不影响这一条。
         */
        if (sendWhileRunning === "queue") {
          enqueueHere();
          return true;
        }
        const runningStep = runningTask.steps.find((step) => step.state === "running");
        const bubble = pushUserMessage(text);
        try {
          const accepted = await opsApi.aiAgentSteer(runningTask.id, text);
          if (!accepted) {
            const reason = t("这条任务已经结束：请重新发送。");
            patchMessage(bubble.id, { deliveryError: reason });
            setNotice(reason);
            return true;
          }
          // 只有后端**接受之后**才说"已更新当前任务"。
          setNotice(
            runningStep
              ? t("已更新当前任务：下一步开始前生效。当前正在执行：{{step}}", {
                  step: t(runningStep.title),
                })
              : t("已更新当前任务：下一步开始前生效。"),
          );
        } catch (cause) {
          const reason = toAppError(cause).message;
          patchMessage(bubble.id, { deliveryError: reason });
          // 保留原文字：放回输入框，用户可以直接重发。
          setDraft(text);
          setAskError(reason);
        }
        return true;
      }
      // 后端已经没有这条运行：收敛卡片，这句话继续往下走成一次**新任务**。
      if (alive) applyTerminalSnapshot(alive);
      else settleStoppedLocally(runningTask.id, t("后端已经没有这条运行。"));
      setNotice(t("上一条运行已经结束：这句话按新任务发送。"));
    }
    /*
     * 本次发送的附件：**队列项按入队时的快照**，其余按当前勾选。
     *
     * 之后改选、移除附件、切服务器都不会影响这一条 —— 气泡显示与模型请求
     * 都读这份快照，不再回读"此刻勾着什么"的易变状态。
     */
    const ownedAttachments = queued
      ? stateBefore.workspaceId === queued.workspaceId
        ? stateBefore.attachments
        : entryBefore?.context?.attachments ?? []
      : attachments;
    /**
     * 这次消息**带上**的附件（勾选的那几个）。
     *
     * 动作链用的是**整条对话的附件**（上传 / 计划要看全部材料），两者分开：
     * `outgoing` 只决定气泡与清单，`attachmentsAtRequest` 是执行器的输入。
     */
    const outgoing: ExtremeAttachment[] = queued
      ? queued.attachments.map(
          (snap) =>
            ownedAttachments.find((item) => item.id === snap.id) ?? {
              id: snap.id,
              name: snap.name,
              size: snap.size,
              path: snap.path,
              remotePath: snap.remotePath,
              state: "ready" as const,
            },
        )
      : composerAttachments;
    /*
     * 整条对话的附件快照。队列项里选中的附件即使已经被移出会话，也补回清单：
     * 入队时定下的材料不能因为后来删掉就静默消失。
     */
    const attachmentsAtRequest: ExtremeAttachment[] = queued
      ? [
          ...ownedAttachments,
          ...outgoing.filter((item) => !ownedAttachments.some((live) => live.id === item.id)),
        ]
      : attachments;
    const sentAttachments: SentAttachment[] = outgoing.map((item) => ({
      id: item.id,
      name: item.name,
      size: item.size,
      server,
      remotePath: item.remotePath,
      path: item.path,
      read: attachmentReadState(item),
    }));
    /** 把这份快照挂到消息上（气泡展示与请求都用它）。 */
    const withSnapshot = (message: ExtremeMessage): ExtremeMessage =>
      sentAttachments.length > 0
        ? {
            ...message,
            attachmentIds: sentAttachments.map((item) => item.id),
            attachmentSnapshot: sentAttachments,
          }
        : message;
    // 版本号按对话递增：B 的请求不会让 A 的后续动作失效。
    const requestId = (askSeqRef.current[workspaceAtRequest] =
      (askSeqRef.current[workspaceAtRequest] ?? 0) + 1);
    /**
     * 这次发送的**归属快照**。
     *
     * 队列派发用它入队时定下的附件 / 范围 / 计划；用户直接发送则用当前这一
     * 刻的镜像。之后所有动作都从这里取值，**不再读渲染闭包**。
     */
    const scopeAtRequest: ActionScope = {
      workspaceId: workspaceAtRequest,
      serverId: entryBefore?.serverId ?? serverId,
      server: entryBefore?.server ?? server ?? "",
      sessionId: sessionAtRequest,
      requestId,
      home: preflight?.home ?? null,
      permission,
      preflight,
      envChecks,
      attachments: attachmentsAtRequest,
      prefs: queued
        ? { context: queued.context, output: queued.output, picked: queued.picked }
        : { context: chatPrefs.context, output: chatPrefs.output, picked: chatPrefs.picked },
      focusId: queued ? null : focusId,
      selectedAttachmentIds: queued
        ? queued.attachments.map((item) => item.id)
        : selectedAttachmentIds,
      plan: queued ? null : plan,
      planSession: queued ? null : planSession,
      planTaskId: queued
        ? entryBefore?.context?.planTaskId ?? null
        : planTaskIdRef.current ?? useExtremeStore.getState().planTaskId,
      candidates: queued ? null : candidates,
      remoteRoot,
    };
    /** 这条对话正显示在眼前：只有此时才允许动草稿 / 滚动 / 输入状态。 */
    const foregroundHere = () => scopeForeground(scopeAtRequest, scopeWorld());
    const ownerMessages = queued
      ? stateBefore.workspaceId === workspaceAtRequest
        ? stateBefore.messages
        : entryBefore?.messages ?? []
      : messages;
    /*
     * **先路由，再决定要不要请求模型**。
     *
     * 「开始吧 / 继续」这类短句不是提问，而是在推进已有任务：唯一可继续的 →
     * 直接执行，或原地生成它缺的那版计划；多个候选 → 让用户指明，绝不新起
     * 任务；其余情况照旧走问答。只在用户**新发**消息时路由（排队派发也算）。
     */
    if (isNew) {
      const taskIds = new Set(ownerMessages.map((message) => message.taskId));
      const visibleTasks = Object.fromEntries(
        Object.entries(stateBefore.tasks).filter(([id]) => taskIds.has(id)),
      );
      const route = routeIntent(text, contextsOfTasks(visibleTasks, sessionAtRequest));
      if (route.kind !== "chat") {
        const message = withSnapshot({
          id: `msg-${crypto.randomUUID()}`,
          role: "user" as const,
          text,
        });
        pushMessageTo(workspaceAtRequest, message);
        options?.onAccepted?.();
        if (foregroundHere()) {
          setDraft("");
          // 焦点文件只对**这一条消息**有效，发完就清。
          setFocusId(null);
          // 消息已受理：这次勾选消费掉（附件已经写进气泡快照）。
          setSelectedAttachmentIds([]);
          setAskError(null);
          setRetryMessage(null);
        }
        if (route.kind === "choose") {
          const cards = useExtremeStore.getState().tasks;
          const list = route.taskIds.map((id) => cards[id]?.title ?? id).join("、");
          pushMessageTo(workspaceAtRequest, {
            id: `msg-${crypto.randomUUID()}`,
            role: "assistant",
            local: true,
            text: t("有 {{n}} 个任务可以继续：{{list}}。请指明要继续哪一个。", {
              n: route.taskIds.length,
              list,
            }),
          });
          return true;
        }
        if (route.action === "run") {
          // 用户说了「开始吧」= 明确确认这版计划，执行入口才放行。
          userConfirmedPlansRef.current.add(route.taskId);
          await runPlan(route.taskId, scopeAtRequest);
        } else {
          await generatePlan(scopeAtRequest, { originMessageId: message.id, taskId: route.taskId });
        }
        return true;
      }
    }
    const userMessage: ExtremeMessage =
      typeof input === "string" || !input
        ? withSnapshot({ id: `msg-${crypto.randomUUID()}`, role: "user", text })
        : input;
    if (isNew) {
      /*
       * 随这条消息发出的附件**归属到这条消息**：输入区随即可清空，
       * 气泡上仍能看到名字、大小与"已上传"状态；会话里的附件列表不动
       * （模型上下文、部署计划与右栏树还要用）。
       */
      pushMessageTo(workspaceAtRequest, userMessage);
      // 受理点：队列项从这里起就该消失（失败由 return false 走另一条路）。
      options?.onAccepted?.();
      if (foregroundHere()) {
        stickToBottom.current = true;
        setDraft("");
        // 焦点文件只对**这一条消息**有效，发完就清；右栏的勾选同样消费掉。
        setFocusId(null);
        // 消息已受理：这次勾选消费掉（附件已经在气泡快照里）。
        setSelectedAttachmentIds([]);
      }
    }
    if (foregroundHere()) {
      setAskError(null);
      setRetryMessage(null);
      setAsking(true);
    }
    /**
     * 本次请求的 taskId：既是取消令牌，也是任务卡与历史记录的主键。
     *
     * 每次请求独立 —— 步骤 index 从 0 开始，复用 id 会把上一次的步骤覆盖掉。
     */
    const taskId =
      options?.taskId ?? `task-${requestId}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    /*
     * `taskIdRef` 是**前台**那条运行的指针（停止键、asking 收尾都读它）。
     * 后台 / 队列派发的请求不能覆盖它：否则 B 的终态事件会因为 `taskIdRef`
     * 指向 A 而收不掉 `asking`，B 的队列就永远等在那里。
     */
    if (useExtremeStore.getState().workspaceId === workspaceAtRequest) {
      taskIdRef.current = taskId;
    }
    // 归属快照补上 taskId：之后每一步的回写都按它定位。
    scopeAtRequest.taskId = taskId;
    taskSelectionsRef.current.set(taskId, selectionAtRequest);
    {
      // 快照：之后用户改选不会篡改这条运行记录。
      runMetaRef.current = {
        taskId,
        context: scopeAtRequest.prefs.context,
        output: scopeAtRequest.prefs.output,
        providerId: selectionAtRequest.providerId,
      };
    }
    if (depth === 0) inFlightRef.current.add(workspaceAtRequest);
    /** 这次运行仍然有效（没有被同一对话里更新的一次请求取代）。 */
    const stillCurrent = () => requestId === askSeqRef.current[workspaceAtRequest];
    /** 这次运行既有效、又正好在前台（只有这时才允许动界面）。 */
    const belongsHere = () =>
      stillCurrent() && useExtremeStore.getState().workspaceId === workspaceAtRequest;
    // 占位消息：流式文字直接追加到这里，用户一发送就能看到文字在长。
    const assistantId = `msg-${crypto.randomUUID()}`;
    streamingReplies.current.set(taskId, assistantId);
    if (workspaceAtRequest) {
      pushMessageTo(workspaceAtRequest, { id: assistantId, role: "assistant", text: "" });
    }
    /**
     * 终态写回的目标：确认后可能已经换到新的回复气泡，必须以**当前**目标为准。
     */
    const currentReplyId = () => streamingReplies.current.get(taskId) ?? assistantId;
    try {
      /*
       * 走**后端多轮 Agent**：模型自己发命令 → 读结果 → 继续，直到没有工具
       * 调用。循环在 Rust 侧，收起面板 / 切回终端都不会中断；这里只等终态。
       *
       * 卡片先落一条空的（同一张 taskId），后面每个 `agent-event` 都往这张卡
       * 上增步骤 —— 不会"每执行一条命令就多一张卡"。
       */
      const cwd = agentCwdRef.current ?? preflight?.home ?? "/";
      // 右栏从这里开始：第一次任务不该先落到 "/" 再跳。
      agentCwdRef.current = cwd;
      const startedCard = cardFromAgent({
        taskId,
        server: scopeAtRequest.server,
        sessionId: sessionAtRequest,
        // 归属：这条卡片属于发起它的那条对话。
        workspaceId: workspaceAtRequest,
        serverId: scopeAtRequest.serverId,
        // 重试挂在**「重试」这句话**下面，而不是把原提问再挂一次。
        originMessageId: (retry?.bubble ?? userMessage).id,
        goal: retry?.of?.goal || text,
        steps: agentStepsRef.current.get(taskId) ?? [],
        status: "running",
        cwd,
        t,
      });
      /*
       * 重试受理：卡片一出现就说清"在重试哪一步"，别让人以为又是从零开始。
       */
      if (retry) {
        const failedStep = [...(retry.of?.steps ?? [])]
          .reverse()
          .find((step) => step.state === "failed");
        startedCard.result = t("正在重试：{{step}}", {
          step: failedStep?.title ?? retry.of?.result ?? text,
        });
      }
      upsertTask(startedCard);
      patchMessageIn(workspaceAtRequest, (retry?.bubble ?? userMessage).id, { taskId });
      saveAgentTask(startedCard, true);

      /*
       * 先挂等待再启动：事件可能比 `agent_start` 的返回更早到。
       *
       * `since` 挡住**上一轮**留在同一个 taskId 下的终态快照（续跑复用 id），
       * 否则第一次轮询就会读到"已完成"，本轮刚开始就被判结束。
       */
      const startedAt = Date.now();
      const finished = waitForAgentRun(taskId, {
        since: startedAt,
        // 每轮裁剪后的用量随快照回来：界面不必等到结束才显示。
        onSnapshot: (snap) => {
          // 按 taskId 归账：即使已经切到别的会话，这条任务的用量也不会丢。
          if (snap.context) setTaskUsage(snap.taskId, snap.context);
        },
      });
      /*
       * 重试：请求体仍是**原来那句**（目标/上下文不变），只额外带一条说明，
       * 让模型先核对远端状态、再从失败处继续。气泡上不会重复出现原提问。
       */
      const promptMessage = retry
        ? { ...userMessage, retryNote: retryNoteFor(retry.of) }
        : userMessage;
      /*
       * 真实终端的最近输出：**只属于「当前会话」范围**。
       *
       * 「仅本条 / 自选」不再自动附带 —— 用户只问一句话时，模型不该凭空
       * 知道他刚才在终端里跑了什么；要带就由他自己「加入本次对话」（那份
       * 材料在 `buildMessages` 里走同一条路径）。
       */
      const terminalTail =
        shouldAttachTerminalTail(scopeAtRequest.prefs.context, scopeAtRequest.prefs.picked) &&
        workspaceAtRequest
          ? await manualShellTail(workspaceAtRequest, 120)
          : "";
      const messages = buildMessages(promptMessage, scopeAtRequest, ownerMessages, {
        locale: i18n.resolvedLanguage ?? i18n.language,
      });
      const tailBlock = terminalTailBlock(terminalTail);
      if (tailBlock) messages.unshift({ role: "system", content: tailBlock });
      /*
       * 模型 / 强度 / 预算**全部来自点击发送时的快照**：这里已经经过了
       * 终端输出等 await，绝不能再读 store（那时可能已经切到 B 或改了模型）。
       * 后端整轮沿用这份选择；MAX 已由菜单收敛成模型支持的最高档。
       */
      const activeProvider = effectiveProvider(providers, selectionAtRequest.providerId);
      const requestBudget =
        selectionAtRequest.contextBudget &&
        (activeProvider?.budgets ?? []).includes(selectionAtRequest.contextBudget)
          ? selectionAtRequest.contextBudget
          : null;

      await opsApi.aiAgentRun({
        taskId,
        sessionId: sessionAtRequest,
        server: scopeAtRequest.server,
        // 文件变更按**发起它的对话 / 服务器**归属：切换对话时不会串。
        serverId: scopeAtRequest.serverId ?? null,
        workspaceId: scopeAtRequest.workspaceId,
        cwd,
        messages,
        /*
         * 界面语言跟着请求一起发：英文界面下后端系统提示词也得是英文，
         * 否则模型会顺着中文的"工具协议 / 操作范围"继续用中文回答。
         */
        locale: i18n.resolvedLanguage ?? i18n.language,
        // 锁定界面显示的提供方，确保档位和上下文预算发给该模型。
        providerId: activeProvider?.id ?? selectionAtRequest.providerId,
        // 模型不支持的档位发 null（不猜、不硬塞）。
        reasoningEffort: effortParam(
          selectionAtRequest.effort,
          activeProvider?.efforts ?? [],
        ),
        contextBudget: requestBudget,
        allowSudo: scopeAtRequest.permission === "full",
        // 完全权限 = 修改范围内不再确认；只查询范围由后端拦下写操作。
        autoApproveWrites: scopeAtRequest.permission === "full",
        // 续跑同一个 taskId：后端从已知累计继续加，不把之前几轮清零。
        carryUsage: useExtremeStore.getState().taskUsage[taskId]?.cumulative ?? null,
      });
      const snapshot = await finished;
      if (!snapshot) {
        /*
         * 快照超时 / 事件丢失：**不能**当成失败或完成 —— 后端可能还在跑。
         * 标成"状态待核对"，让用户能重新核对或停止。
         */
        setStaleTask(taskId);
        return true;
      }
      // 终态快照里带着最终用量：这是这条任务最后一次归账。
      setTaskUsage(taskId, snapshot.context ?? null);
      if (!snapshot.context && !useExtremeStore.getState().taskUsage[taskId]) {
        // 兼容没有附带用量的终态事件。复用任务 ID 时只接收这一轮的快照。
        void opsApi.aiAgentSnapshot(taskId)
          .then((latest) => {
            if (
              latest?.context &&
              latest.status === snapshot.status &&
              latest.updatedAt >= startedAt &&
              latest.updatedAt <= snapshot.updatedAt &&
              !useExtremeStore.getState().taskUsage[taskId]
            ) {
              setTaskUsage(taskId, latest.context);
            }
          })
          .catch(() => undefined);
      }
      const currentTask = useExtremeStore.getState().tasks[taskId];
      if (currentTask?.status === "running" || currentTask?.status === "confirming") {
        // 这次是真跑完（事件可能晚到）：允许在窗口收起时提醒一次。
        applyTerminalSnapshot(snapshot, true);
      }

      const visibleReply = stripPanelAction(parseActions(snapshot.content).clean);
      if (snapshot.status === "cancelled") {
        // 停止是用户主动的：保留已生成的正文，不当作错误。
        patchMessageIn(workspaceAtRequest, currentReplyId(), {
          text: visibleReply || t("已停止。"),
          model: snapshot.model || undefined,
          local: !visibleReply,
          // 已经流出一半正文：标清"停止前的内容"，回来时不会以为回复完整。
          interrupted: visibleReply ? "cancelled" : null,
          interruptReason: visibleReply ? t("已停止：上面是停止前已经生成的内容。") : null,
        });
        return true;
      }
      if (snapshot.status === "failed") {
        throw new Error(snapshot.error?.trim() || t("执行失败"));
      }
      /*
       * 期间换了对话：结论仍写回它自己那条，**后续动作也照常推进**。
       *
       * 动作链只认 `scopeAtRequest`：附件、连接、计划都是发起那一刻的，
       * 只有"动界面"的部分才按前台判断。
       */
      const visibleHere = belongsHere();
      const reply = { content: snapshot.content, model: snapshot.model, tools: [] };
      /*
       * **解析动作标记**：模型不再让用户"去点某个按钮"，而是在回复里说明
       * 打算做什么，并用 `[[upload]]` / `[[plan:x]]` / `[[start]]` 请求执行。
       * 标记从正文里删掉，用户只看到人话。
       */
      const { clean, actions } = parseActions(reply.content);
      /*
       * 服务器命令面板：模型用 `[[panel:…]]` 请求打开右栏。
       * 先探测目标是否真实存在，再把这句话从气泡里剥掉（只留人话）。
       */
      const panelRequest = parsePanelAction(reply.content);
      if (panelRequest && stillCurrent()) {
        // 归属：这次运行的对话与连接。切走了就记在它自己名下，回来再开。
        const notice = await openPanelFromAction(panelRequest, workspaceAtRequest, sessionAtRequest);
        if (notice) {
          pushMessageTo(workspaceAtRequest, {
            id: `msg-${crypto.randomUUID()}`,
            role: "assistant",
            local: true,
            text: notice,
          });
        }
      } else if (
        stillCurrent() &&
        isNew &&
        depth === 0 &&
        !text.startsWith("【") &&
        isLogIntent(text)
      ) {
        /*
         * 模型没给面板动作，但用户的话明确是在要日志：**自己去服务器上找**，
         * 找到唯一来源就打开，多个就只问一句。
         */
        const resolved = await openLogFromIntent(text, workspaceAtRequest, sessionAtRequest);
        if (resolved.question) {
          pushMessageTo(workspaceAtRequest, {
            id: `msg-${crypto.randomUUID()}`,
            role: "assistant",
            local: true,
            text: resolved.question,
          });
        } else if (resolved.opened) {
          pushMessageTo(workspaceAtRequest, {
            id: `msg-${crypto.randomUUID()}`,
            role: "assistant",
            local: true,
            text: t("已打开日志面板，聊天不受影响。"),
          });
        }
      }
      patchMessageIn(workspaceAtRequest, currentReplyId(), {
        text: stripPanelAction(clean),
        model: reply.model,
        tools: reply.tools,
      });
      if (visibleHere) setModel(reply.model);

      /*
       * 动作链最多两跳：执行 → 把**真实回执**交给模型 → 它继续说明或收尾。
       *
       * 回执走 `feedToolReport`，而不是 `ask("...")`：后者是"用户又发了一句"，
       * 会 push 一条用户气泡、清空草稿、把会话标题改成回执 —— 那正是之前的
       * bug（工具结果被渲染成蓝色气泡）。
       *
       * 执行器只认 `scopeAtRequest`（附件 / 连接 / 计划都是发起时的）：
       * A 切到后台也继续跑，不会拿 B 的状态去替 A 上传。
       */
      if (actions.length > 0 && depth < 2) {
        const receipts: string[] = [];
        for (const action of actions) {
          const runner = execRef.current;
          if (!runner) break;
          let result: ActionResult;
          if (action.kind === "upload") {
            result = await runner.upload(scopeAtRequest, taskId);
          } else if (action.kind === "plan") {
            // 用这条回复的 id 当来源：任务卡就挂在这段答复下面。
            result = await runner.plan(scopeAtRequest, action.service, currentReplyId());
          } else if (action.kind === "start") {
            result = await runner.start(scopeAtRequest, taskId);
          } else {
            result = await runner.terminal(scopeAtRequest, action.command);
          }
          receipts.push(result.receipt);
          // 归属失效：这一步已暂停并把原因写回原对话，后面的动作不能抢跑。
          if (result.paused) break;
        }
        const real = receipts.filter((line) => line.trim().length > 0);
        if (real.length > 0) {
          // 用**实际返回**作为下一轮输入，模型据此继续或收尾。
          await feedToolReport(scopeAtRequest, userMessage, real.join("\n"), depth + 1, taskId);
        }
      }
      return true;
    } catch (cause) {
      const error = toAppError(cause);
      /*
       * 启动就失败（没有模型 / 会话断开 / 等确认超时）时，卡片不能停在
       * "执行中" —— 那会让人以为命令还在服务器上跑。落成失败并写明原因。
       */
      const current = useExtremeStore.getState().tasks[taskId];
      if (current && (current.status === "running" || current.status === "confirming")) {
        const failed: TaskCardModel = {
          ...current,
          status: "failed",
          result: error.message,
          updatedAt: Date.now(),
        };
        upsertTask(failed);
        saveAgentTask(failed, true);
      }
      const reason = error.detail ? `${error.message} · ${error.detail}` : error.message;
      /*
       * **只移除空占位**。
       *
       * 用户可能已经看到一半正文：把它删掉等于"回答凭空消失"。保留正文、
       * 标成「回复中断」，并给出重试入口；切走再回来仍然是这个状态。
       */
      const replyId = currentReplyId();
      const latest = useExtremeStore.getState();
      const ownerMessages =
        latest.workspaceId === workspaceAtRequest
          ? latest.messages
          : latest.workspaces.find((entry) => entry.id === workspaceAtRequest)?.messages ?? [];
      const reply = ownerMessages.find((message) => message.id === replyId);
      if (reply && reply.text.trim()) {
        patchMessageIn(workspaceAtRequest, replyId, {
          interrupted: "failed",
          interruptReason: reason,
        });
      } else {
        removeMessageIn(workspaceAtRequest, replyId);
        // 后台失败：把原因写回原对话，切回来能看见发生了什么。
        if (!belongsHere()) {
          pushMessageTo(workspaceAtRequest, {
            id: `msg-${crypto.randomUUID()}`,
            role: "assistant",
            local: true,
            text: t("这次没有开始：{{reason}}", { reason }),
          });
        }
      }
      if (belongsHere()) {
        setAskError(reason);
        setRetryMessage(userMessage);
      }
      // 用户消息已经发出去、失败原因也已落库：队列项不需要再重投。
      return true;
    } finally {
      /*
       * **只清自己那一条**。
       *
       * A 被停止后立刻发 B 时，A 的 `finally` 会在 B 启动之后才跑到这里；
       * 无条件置 null 会把 B 的流式目标抹掉。加一层归属判断。
       */
      // 只清**这一条任务**的流式目标：确认后可能换过气泡，不能按旧 id 判断。
      streamingReplies.current.delete(taskId);
      // 这一轮的增量过滤器到此为止（含还没定稿的尾巴）。
      streamFilters.current.delete(taskId);
      textBuffers.current.delete(taskId);
      // 请求已结束（失败 / 取消 / 已收尾）：不再留着轮询快照的定时器。
      forgetAgentWait(taskId);
      if (depth === 0) {
        inFlightRef.current.delete(workspaceAtRequest);
        // 唤醒「完成后发送」：这条对话的队列现在可以继续了。
        setRunEpoch((value) => value + 1);
      }
      if (belongsHere() && taskIdRef.current === taskId) {
        setAsking(false);
        taskIdRef.current = null;
      }
    }
  };

  /**
   * 「完成后发送」的派发。
   *
   * 放在 effect 里而不是终态事件里：事件只更新 store，等 React 把 `tasks` /
   * `asking` 渲染成空闲态再发，新任务才不会立刻被判成"仍在执行"。
   *
   * **按对话各自判断**：A 在跑时 B 的队列照样能发；用户切到别处也继续。
   */
  const askRef = useRef<typeof ask | null>(null);
  askRef.current = ask;
  /** 已经派发出去、还在走的队列项：effect 重跑也不能重复提交。 */
  const dispatchingRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!active) return;
    const state = useExtremeStore.getState();
    const owners = [...new Set(state.queuedSends.map((item) => item.workspaceId))];
    for (const owner of owners) {
      const item = nextSend(state.queuedSends, owner);
      if (!item || dispatchingRef.current.has(item.id)) continue;
      const busy = Object.values(state.tasks).some(
        (task) =>
          task.workspaceId === owner &&
          (task.status === "running" ||
            task.status === "confirming" ||
            task.status === "waiting"),
      );
      // 跑着的对话先等它自己结束；`inFlightRef` 覆盖"ask 在飞但卡片还没落"的窗口。
      if (busy || inFlightRef.current.has(owner)) continue;
      if (state.workspaceId === owner && asking) continue;
      dispatchingRef.current.add(item.id);
      void (async () => {
        try {
          const accepted = await askRef.current?.(item.text, 0, undefined, {
            queued: item,
            // 一受理就出队：之后的等待属于任务本身，不再是"待发送"。
            onAccepted: () => dropSend(item.id),
          });
          if (accepted) return;
          /*
           * 没受理（断连 / 这条对话已经不可用）：**保留**队列项并写明原因。
           * 静默丢掉等于用户排的那句话凭空消失。
           */
          failSend(item.id, t("这条消息没有发出：检查连接后可以重试。"));
        } finally {
          dispatchingRef.current.delete(item.id);
        }
      })();
    }
  }, [active, asking, queuedSends, runEpoch, tasks, connections, dropSend, failSend, t]);

  /**
   * **工具执行结果 → 模型**（独立入口，和"用户发消息"分开）。
   *
   * 只把回执接在同一轮请求后面，让模型继续处理：不 push 用户气泡、不动草稿、
   * 不改会话标题、不跑意图路由。传**消息对象**而不是字符串，`ask` 里"新消息"
   * 分支（push / 清草稿 / 标题）自然不会命中。
   *
   * `scope` 保证续跑仍然落在**发起它的那条对话与连接**上（A 在后台也一样）。
   */
  const feedToolReport = async (
    scope: ActionScope,
    source: ExtremeMessage,
    report: string,
    depth: number,
    taskId: string,
  ): Promise<void> => {
    if (!report.trim()) return;
    // 复用同一个 taskId：回执、卡片、操作链都还是那一件事。
    await ask({ ...source, toolReport: report }, depth, undefined, {
      taskId,
      workspaceId: scope.workspaceId,
    });
  };

  /**
   * 停止：**通知后端中断**，不只是让界面结束等待。
   *
   * 后端拿到取消令牌后会断开与模型的连接；迟到的回复即使回来也会被
   * `askSeqRef` 丢弃。取消后草稿与已发出的消息都保留。
   */
  /**
   * 后端已经没有这条运行（应用重启 / 记录清理 / 循环异常退出）。
   *
   * 不会再有终态事件到达，界面**必须自己收敛**，否则会永远停在"执行中"或
   * "正在停止"：发不出去，也停不下来。
   */
  const settleStoppedLocally = useCallback(
    (taskId: string, reason?: string) => {
      setStoppingIds((current) => {
        if (!current.has(taskId)) return current;
        const next = new Set(current);
        next.delete(taskId);
        return next;
      });
      setStopOverdueId((current) => (current === taskId ? null : current));
      applyTerminalSnapshot(
        {
          taskId,
          status: "cancelled",
          model: "",
          content: "",
          error: reason ?? null,
          cwd: "",
          server: "",
          sessionId: "",
          steps: [],
          updatedAt: Date.now(),
        },
        false,
      );
    },
    [applyTerminalSnapshot],
  );

  /**
   * 停止（协作式，两阶段）。
   *
   * 第一阶段只发取消请示；界面显示"正在停止"，**等后端终态事件**才变"已停止"。
   * 停止请求是幂等的，重复点击只会再问一次后端 —— 以前这里用 `stopping` 拦，
   * 用户看到的是"点了没反应"。
   */
  const cancelAsk = async () => {
    const state = useExtremeStore.getState();
    const taskId = staleTask ?? taskIdRef.current ?? getActiveTaskId();
    const task = taskId ? state.tasks[taskId] : undefined;
    if (!taskId) return;
    // 归属别的对话 / 已经结束：没有可停的运行，把界面残留收干净即可。
    if (!task) {
      settleStoppedLocally(taskId);
      return;
    }
    if (task.workspaceId !== state.workspaceId) return;
    if (task.status !== "running" && task.status !== "confirming") {
      settleStoppedLocally(taskId);
      return;
    }
    taskIdRef.current = taskId;
    setStoppingIds((current) => new Set(current).add(taskId));
    setStopOverdueId(null);
    setAskError(null);
    setNotice(null);
    try {
      /*
       * 先走与后端共用的取消令牌（`ai_chat_cancel`）：**它返回成功才是"已送达"**。
       * 没送达就不能进入"正在停止"，否则又是一个停不下来的状态。
       */
      const accepted = await opsApi.aiChatCancel(taskId);
      if (!accepted) {
        // 没有令牌时再看是否还有 Agent 句柄：两条路都关掉才算真的没有。
        const agentAccepted = await opsApi.aiAgentCancel(taskId).catch(() => false);
        if (!agentAccepted) {
          settleStoppedLocally(taskId, t("后端已经没有这条运行。"));
          setNotice(t("这次运行已经不在后端：已按「已停止」收尾。"));
          return;
        }
      }
    } catch {
      // 没送达：撤回"正在停止"，保留任务状态，允许用户重新点。
      setStoppingIds((current) => {
        const next = new Set(current);
        next.delete(taskId);
        return next;
      });
      setNotice(t("停止请求未能确认，任务可能仍在运行。可以再次尝试停止。"));
      return;
    }
    /*
     * 送达了：先查一次快照。后端已经没有这条运行（应用重启 / 记录清理）时
     * 不会再有终态事件，必须当场收敛，不能等一个永远不来的事件。
     */
    try {
      const snapshot = await opsApi.aiAgentSnapshot(taskId);
      if (!snapshot) {
        settleStoppedLocally(taskId, t("后端已经没有这条运行。"));
        setNotice(t("这次运行已经不在后端：已按「已停止」收尾。"));
        return;
      }
      if (applyTerminalSnapshot(snapshot, true)) return;
    } catch {
      // 查询失败不影响等待：事件仍是主通道，后台仍会推终态。
    }
    // 还在跑（例如一条命令要跑完才停）：保持"正在停止"，超时后由界面给出
    // 「强制结束」（见 `stoppingSinceRef` 的定时检查）。
  };

  return { ask, cancelAsk, settleStoppedLocally };
}
