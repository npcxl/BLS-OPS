/**
 * Agent 运行的**事件管线**：把后端推来的 agent-event 落成任务卡、回复正文与
 * 审批卡，并负责重开 WebView 后的快照接回。
 *
 * 从视图容器里拆出来，是为了让「流式合帧 / 归属定位 / 历史落库」只有一处实现。
 * 视图只提供 store 动作与少量跨模块 ref —— 管线内部不读渲染闭包里的业务状态。
 */
import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";

import { opsApi } from "@/api/ops-api";
import type {
  AgentApproval,
  AgentEvent,
  AgentSnapshot,
  AgentStep,
} from "@/api/types/agent";
import { useExtremeStore, type ExtremeMessage } from "@/stores/extreme-store";
import { notifyTaskOutcome } from "@/desktop-notification/task";
import { cardFromAgent, mergeAgentStep, stepTitle } from "../agent-steps";
import { interruptedChildSteps } from "../task-view";
import { attachAgentEvents } from "./agent-events";
import { notifyAgentFinished, snapshotFromEvent } from "../agent-run";
import {
  appendText,
  expireQuestions,
  partsOf,
  partsText,
  replaceTrailingText,
  trailingText,
  updateQuestionPart,
  upsertNote,
  upsertPlanPart,
  upsertQuestion,
  upsertStep,
  type MessagePart,
} from "../message-parts";
import { shouldBackfillPrefix, terminalReplyText } from "../reply-authority";
import {
  createStreamFilter,
  parseActions,
  visibleStream,
  type StreamFilter,
} from "../chat-actions";
import { cardFromRecord, riskOfSteps, statusForRecord, type TaskCardModel } from "../task-view";
import { stripPanelAction } from "../panel-target";
import type { TFn } from "./helpers";
import { approvalKeyOf, type ApprovalEntry } from "./types";

type Store = ReturnType<typeof useExtremeStore.getState>;

export interface AgentStreamDeps {
  active: boolean;
  workspaceId: string | null;
  sessionId: string | null;
  t: TFn;
  /** 原始 Agent 步骤（卡片渲染模型由它派生，跨轮合并要用）。 */
  agentStepsRef: MutableRefObject<Map<string, AgentStep[]>>;
  /** 下一次请求从哪个目录开始。 */
  agentCwdRef: MutableRefObject<string | null>;
  /** 前台正在跑的那条任务。 */
  taskIdRef: MutableRefObject<string | null>;
  /** 按对话记录「有请求在飞」。 */
  inFlightRef: MutableRefObject<Set<string>>;
  approvalEntriesRef: MutableRefObject<Record<string, ApprovalEntry>>;
  setAsking: Dispatch<SetStateAction<boolean>>;
  setStoppingIds: Dispatch<SetStateAction<Set<string>>>;
  setStopOverdueId: Dispatch<SetStateAction<string | null>>;
  setStaleTask: Dispatch<SetStateAction<string | null>>;
  setFollowNonce: Dispatch<SetStateAction<number>>;
  setNotice: Store["setNotice"];
  setTaskUsage: Store["setTaskUsage"];
  upsertTask: Store["upsertTask"];
  patchMessage: Store["patchMessage"];
  patchMessageIn: Store["patchMessageIn"];
  mergeFileChange: Store["mergeFileChange"];
  dropApprovals: (match: (entry: ApprovalEntry) => boolean) => void;
  setApprovalEntry: (approval: AgentApproval) => void;
}

/** 指定对话的消息列表（当前对话读镜像，后台对话读它自己的记录）。 */
function messagesOf(state: Store, ownerId: string) {
  return state.workspaceId === ownerId
    ? state.messages
    : state.workspaces.find((entry) => entry.id === ownerId)?.messages ?? [];
}

/** 按对话 + 消息 ID 精确定位（后台任务也只改它自己那条）。 */
function messageOf(state: Store, ownerId: string, messageId: string) {
  return messagesOf(state, ownerId).find((message) => message.id === messageId);
}

/**
 * 重进接回时，流式目标 = 发起消息之后**最后一条** assistant。
 *
 * 续跑 / 平台动作会往同一个 taskId 上再写一条回复，取紧接着的那条会把
 * 结论写进已经结束的旧气泡。
 */
function replyAfter(
  messages: ExtremeMessage[],
  ownerIndex: number,
): ExtremeMessage | undefined {
  if (ownerIndex < 0) return undefined;
  const tail = messages
    .slice(ownerIndex + 1)
    .filter((message) => message.role === "assistant");
  return tail.length > 0 ? tail[tail.length - 1] : messages[ownerIndex + 1];
}

export function useAgentStream(deps: AgentStreamDeps) {
  const {
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
  } = deps;

  const agentSaveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  /** 快照恢复出来的终态只补卡片：不要当成本次运行"刚刚完成"发通知。 */
  const suppressTerminalNotifyRef = useRef(false);

  // 工具回执会复用 taskId，增量必须写到本轮回复，而不是最早的气泡。
  const streamingReplies = useRef(new Map<string, string>());
  /**
   * 本轮流式正文的**过滤器与缓冲**（按 taskId）。
   *
   * 增量只带"这一片"，过滤内部标记要看上下文（`[[upload]]` 可能被切成两片）。
   * `createStreamFilter` 只保留没定稿的尾巴：已定稿的前缀直接丢掉，不再对整段
   * 累积文本重跑正则（那是 O(n²)，而且跑在 UI 线程的事件回调里）。
   */
  const streamFilters = useRef<Map<string, StreamFilter>>(new Map());
  /** 还没写进 store 的原始增量：一帧最多提交一次。 */
  const textBuffers = useRef<
    Map<string, { ownerId: string; messageId: string; raw: string }>
  >(new Map());
  /** `tool_output` 的累积值（taskId + stepIndex）：一帧最多合并一次。 */
  const toolBuffers = useRef<
    Map<string, { event: AgentEvent; stdout: string; stderr: string }>
  >(new Map());
  /** 合帧句柄：正文与工具输出共用，一帧只提交一次。 */
  const flushFrame = useRef<number | null>(null);
  /** 立即处理分支的实现（rAF 里也要能用最新闭包）。 */
  const applyAgentEventRef = useRef<(payload: AgentEvent, snapshot?: AgentSnapshot) => void>(
    () => undefined,
  );

  /**
   * 落一条 Agent 任务到历史。
   *
   * **唯一写入方**：实时事件与终态都走这里，历史面板读的是同一份 store 卡片
   * （`mergeTask` 版本合并），没有第二条旁路。防抖 350ms：`uname; df; docker ps`
   * 这种快命令会连着来好几步，每步都写库没有意义。
   */
  const saveAgentTask = useCallback((card: TaskCardModel, immediate: boolean) => {
    const pending = agentSaveTimers.current.get(card.id);
    if (pending) clearTimeout(pending);
    const write = () => {
      agentSaveTimers.current.delete(card.id);
      try {
        void opsApi
          .extremeTaskSave({
            id: card.id,
            kind: card.kind,
            server: card.server,
            serverId: card.serverId ?? null,
            workspaceId: card.workspaceId ?? null,
            sessionId: card.sessionId,
            status: statusForRecord(card.status),
            // 类型来自目标；风险单独存，历史里不靠它反推分类。
            goal: card.goal,
            risk: riskOfSteps(card.steps),
            summary: card.result,
            planJson: JSON.stringify(card.steps),
            // 终态结论与当前目录：恢复执行时要用；执行中的保存不能把它们冲掉，
            // 后端用 CASE 保留旧值。
            outcomeJson: card.outcome ? JSON.stringify(card.outcome) : "",
            cwd: card.cwd ?? "",
            createdAt: card.createdAt,
          })
          .catch(() => undefined);
      } catch {
        // 历史是附加信息：写失败（非 Tauri 环境 / 库被锁）不影响任务本身。
      }
    };
    if (immediate) {
      write();
      return;
    }
    agentSaveTimers.current.set(card.id, setTimeout(write, 350));
  }, []);

  /**
   * 把缓冲里的正文增量落到消息上。
   *
   * `done` = 这一轮已经结束：顺手 `finish()` 把压着的尾巴（可能是半个标记）
   * 决定掉，之后这条任务的过滤器销毁 —— 终态仍然只信 `visibleStream`。
   */
  const flushStreamText = useCallback((taskId: string, done: boolean) => {
    const buffer = textBuffers.current.get(taskId);
    if (!buffer) return;
    let filter = streamFilters.current.get(taskId);
    if (!filter) {
      filter = createStreamFilter();
      streamFilters.current.set(taskId, filter);
    }
    const raw = buffer.raw;
    buffer.raw = "";
    let out = raw ? filter.push(raw) : "";
    if (done) {
      out += filter.finish();
      streamFilters.current.delete(taskId);
      textBuffers.current.delete(taskId);
    }
    if (!out) return;
    const state = useExtremeStore.getState();
    const message = messageOf(state, buffer.ownerId, buffer.messageId);
    if (!message) return;
    /*
     * 只追加这一帧新增的可见文本：整段覆盖会把过滤器压住的尾巴冲掉。
     *
     * 已经进入"时间线模式"（出现过命令）时同时维护片段：末尾是正文就接着写，
     * 上一段是命令就另起一段。还没有命令的纯文字回复不写 `parts`，历史存储
     * 不会为每句话多存一份副本。
     */
    if (message.parts?.length) {
      const parts = appendText(message.parts, out);
      state.patchMessageIn(buffer.ownerId, buffer.messageId, {
        text: partsText(parts),
        parts,
      });
      return;
    }
    state.patchMessageIn(buffer.ownerId, buffer.messageId, { text: message.text + out });
  }, []);

  /** 累积的工具输出合并成一条事件：一帧只让任务卡重算一次。 */
  const flushToolOutput = useCallback(() => {
    if (toolBuffers.current.size === 0) return;
    const entries = [...toolBuffers.current.values()];
    toolBuffers.current.clear();
    for (const entry of entries) {
      if (!entry.stdout && !entry.stderr) continue;
      applyAgentEventRef.current({
        ...entry.event,
        kind: "tool_output",
        stdout: entry.stdout,
        stderr: entry.stderr,
      });
    }
  }, []);

  /** 一帧一次：把这一帧攒下的正文与工具输出提交掉。 */
  const flushStreams = useCallback(() => {
    flushFrame.current = null;
    if (textBuffers.current.size > 0) {
      for (const taskId of [...textBuffers.current.keys()]) flushStreamText(taskId, false);
    }
    flushToolOutput();
  }, [flushStreamText, flushToolOutput]);

  const scheduleFlush = useCallback(() => {
    if (flushFrame.current !== null) return;
    flushFrame.current = requestAnimationFrame(flushStreams);
  }, [flushStreams]);

  /**
   * 立即处理某条任务之前，先把它的缓冲落下去。
   *
   * `tool_finished` / `finished` 带的是**完整值**：它要是先落库、增量后到，
   * 界面上就会看到"输出先变全，再退回一半"。
   */
  const flushTaskNow = useCallback(
    (taskId: string, done: boolean) => {
      flushStreamText(taskId, done);
      flushToolOutput();
    },
    [flushStreamText, flushToolOutput],
  );

  /** 一条任务的归属对话与它那条回复气泡（回写一律按它定位）。 */
  const locateTask = (taskId: string) => {
    const state = useExtremeStore.getState();
    const existing = state.tasks[taskId];
    /*
     * **先确定归属，再动界面。**
     *
     * 优先用任务卡上的 `workspaceId`；卡片不在内存里（重进）时，找哪条对话
     * 的消息引用了这个 taskId。两样都没有 = 归属不明：不建卡、不改当前界面，
     * 交给 reattach 用快照确认 —— **绝不**"默认挂到当前服务器"。
     */
    const ownerId =
      existing?.workspaceId ??
      state.workspaces.find((entry) => entry.messages.some((message) => message.taskId === taskId))
        ?.id ??
      null;
    if (!ownerId) return null;
    const owner = state.workspaces.find((entry) => entry.id === ownerId);
    const isCurrent = state.workspaceId === ownerId;
    const messages = isCurrent ? state.messages : owner?.messages ?? [];
    const assistantId = streamingReplies.current.get(taskId);
    const reply = assistantId
      ? messages.find((message) => message.id === assistantId)
      : // 重进 / 刷新后没有映射：认**最后一个**引用这条任务的 assistant
        // （确认后可能已经新开了一条回复，取最早那条会把结论写到回执上方）。
        [...messages]
          .reverse()
          .find((message) => message.taskId === taskId && message.role === "assistant");
    return { state, existing, ownerId, owner, isCurrent, reply };
  };

  /**
   * 正文增量：只进缓冲，按帧合并后写一次消息。
   *
   * 每个 delta 都 `patchMessageIn` 会新建 `messages` / `workspaces` 数组，整棵
   * 订阅树跟着重渲染；一帧一次之后，同样的字数只换来最多 60 次/秒的提交。
   */
  const queueTextDelta = (payload: AgentEvent) => {
    const found = locateTask(payload.taskId);
    if (!found) return;
    const { existing, ownerId, reply } = found;
    if (existing && existing.status !== "running" && existing.status !== "confirming") return;
    if (reply?.role !== "assistant") return;
    let buffer = textBuffers.current.get(payload.taskId);
    if (!buffer) {
      buffer = { ownerId, messageId: reply.id, raw: "" };
      textBuffers.current.set(payload.taskId, buffer);
      const filter = createStreamFilter();
      /*
       * 续接（重进 / 缓冲刚清过）：把**末尾那一段**正文喂进去。
       *
       * 不能喂整条消息：前面的片段属于已经结束的轮次，里面有 `[[upload]]` 之类
       * 的内部标记也不该再参与过滤状态（命令之后的正文是一个新的片段）。
       */
      const known = trailingText(partsOf(reply));
      if (known) filter.push(known);
      streamFilters.current.set(payload.taskId, filter);
    }
    buffer.raw += payload.content ?? "";
    scheduleFlush();
  };

  /** 工具输出：按 taskId + stepIndex 攒着，一帧合并一次。 */
  const queueToolOutput = (payload: AgentEvent) => {
    if (payload.stepIndex === undefined) {
      // 没有步骤编号的事件不参与合并（步骤也落不上去），直接走立即处理。
      flushTaskNow(payload.taskId, false);
      applyAgentEventRef.current(payload);
      return;
    }
    const key = `${payload.taskId}:${payload.stepIndex}`;
    const entry = toolBuffers.current.get(key) ?? { event: payload, stdout: "", stderr: "" };
    entry.event = payload;
    entry.stdout += payload.stdout ?? "";
    entry.stderr += payload.stderr ?? "";
    toolBuffers.current.set(key, entry);
    scheduleFlush();
  };

  /**
   * 立即处理分支：非增量事件（步骤、确认、终态）当场落库。
   *
   * 用 ref 转发最新的闭包，监听器只注册一次 —— 否则每次 `t` / `tasks` 变化都
   * 会重新订阅，执行中的步骤可能漏掉。
   */
  const applyAgentEvent = (payload: AgentEvent, snapshot?: AgentSnapshot) => {
    const done =
      payload.kind === "finished" || payload.kind === "failed" || payload.kind === "cancelled";
    const found = locateTask(payload.taskId);
    if (!found) {
      /*
       * 归属不明（消息被清理 / 卡片已经不在）时**也要收尾**。
       *
       * 「正在停止」与 asking 只认终态事件：以前这里直接 return，事件一丢
       * 界面就永远停在"正在停止"，既发不出去也停不下来。
       */
      if (done) {
        setStoppingIds((current) => {
          if (!current.has(payload.taskId)) return current;
          const next = new Set(current);
          next.delete(payload.taskId);
          return next;
        });
        setStopOverdueId((current) => (current === payload.taskId ? null : current));
        setStaleTask((current) => (current === payload.taskId ? null : current));
        dropApprovals((entry) => entry.approval.taskId === payload.taskId);
        notifyAgentFinished(snapshotFromEvent(payload));
        if (taskIdRef.current === payload.taskId) {
          setAsking(false);
          taskIdRef.current = null;
        }
        const orphan = useExtremeStore.getState().tasks[payload.taskId];
        if (orphan && (orphan.status === "running" || orphan.status === "confirming")) {
          upsertTask({
            ...orphan,
            status:
              payload.kind === "finished" ? "done" : payload.kind === "failed" ? "failed" : "cancelled",
            result: payload.kind === "cancelled" ? t("已停止。") : orphan.result,
            updatedAt: Date.now(),
          });
        }
      }
      return;
    }
    const { existing, ownerId, owner, isCurrent, reply } = found;

    const steps = snapshot?.steps ?? mergeAgentStep(agentStepsRef.current.get(payload.taskId) ?? [], payload);
    agentStepsRef.current.set(payload.taskId, steps);

    /*
     * 步骤事件 → 这一轮回复里的**位置**。
     *
     * 顺序只由事件到达顺序决定：`tool_started` 之前流出的正文属于命令上方；
     * 之后的正文在 `queueTextDelta` 里另起一段。重复事件按 taskId + stepIndex
     * 幂等合并，不会多出一行。
     */
    if (
      payload.stepIndex !== undefined &&
      reply?.role === "assistant" &&
      (payload.kind === "tool_started" ||
        payload.kind === "approval_required" ||
        payload.kind === "tool_finished" ||
        payload.kind === "tool_output")
    ) {
      /*
       * 命令开始前先把正文**定稿**：压着的尾巴（可能是半个内部标记）属于
       * 这条命令上方，不能跟着命令之后的下一轮增量继续长。
       */
      if (payload.kind === "tool_started" || payload.kind === "approval_required") {
        flushStreamText(payload.taskId, true);
      }
      const state = useExtremeStore.getState();
      const message = messageOf(state, ownerId, reply.id);
      const step = steps.find((item) => item.index === payload.stepIndex);
      if (message) {
        // 用户拒绝的步骤要**永久**标成「未执行」：审批条目收起后还得能看出来。
        const denied = Object.values(approvalEntriesRef.current).some(
          (entry) =>
            entry.approval.taskId === payload.taskId &&
            entry.approval.stepIndex === payload.stepIndex &&
            entry.phase === "denied",
        );
        let parts = partsOf(message);
        // 执行前说明：与工具同组，放在这条命令上方；重复事件只更新不追加。
        if (payload.note && payload.groupId) {
          parts = upsertNote(parts, { groupId: payload.groupId, text: payload.note });
        }
        parts = upsertStep(parts, {
          taskId: payload.taskId,
          stepIndex: payload.stepIndex,
          label: step ? stepTitle(step, t) : payload.summary ?? null,
          denied,
          // 内部纠错要跟着消息落盘：重开 / 切换后仍按"内部调整"收纳。
          internal: step?.category === "internal" || payload.category === "internal",
          planStepId: payload.planStepId,
          groupId: payload.groupId,
        });
        if (parts !== message.parts) {
          state.patchMessageIn(ownerId, reply.id, { parts });
        }
      }
    }

    /*
     * 计划提交 / 修订 / 步骤状态：整份计划写到**这一轮回复**上。
     *
     * 卡片据此渲染；消息落盘后重开会话仍是同一版，切换对话也各看各的。
     * 计划本身不改变任务卡状态，不需要重建卡片。
     */
    if (payload.kind === "plan_updated" && payload.plan) {
      if (reply?.role === "assistant") {
        const state = useExtremeStore.getState();
        const message = messageOf(state, ownerId, reply.id);
        if (message) {
          const parts = upsertPlanPart(partsOf(message), {
            taskId: payload.taskId,
            plan: payload.plan,
          });
          if (parts !== message.parts) {
            state.patchMessageIn(ownerId, reply.id, { parts });
          }
        }
      }
      return;
    }

    /*
     * AI 提问：先把上方正文定稿，再把问题卡接到时间线；重复事件只更新问题，
     * 不覆盖用户已经选了一半的草稿。
     */
    if (payload.kind === "question_required" && payload.question) {
      flushStreamText(payload.taskId, true);
      if (reply?.role === "assistant") {
        const state = useExtremeStore.getState();
        const message = messageOf(state, ownerId, reply.id);
        if (message) {
          const parts = upsertQuestion(partsOf(message), payload.question);
          if (parts !== message.parts) {
            state.patchMessageIn(ownerId, reply.id, { parts });
          }
        }
      }
    }
    if (payload.kind === "question_answered" && payload.question) {
      if (reply?.role === "assistant") {
        const state = useExtremeStore.getState();
        const message = messageOf(state, ownerId, reply.id);
        if (message) {
          let parts = upsertQuestion(partsOf(message), payload.question);
          parts = updateQuestionPart(parts, payload.question.questionId, {
            status: "answered",
            answer: payload.answer ?? { selected: [] },
            error: null,
          });
          if (parts !== message.parts) {
            state.patchMessageIn(ownerId, reply.id, { parts });
          }
        }
      }
    }

    if (payload.kind === "approval_required") {
      const next: AgentApproval = {
        taskId: payload.taskId,
        callId: payload.callId ?? "",
        stepIndex: payload.stepIndex ?? 0,
        tool: payload.tool ?? "",
        server: existing?.server ?? owner?.server ?? "",
        path: payload.path ?? null,
        risk: payload.risk ?? "write",
        command: payload.command ?? "",
        script: payload.script ?? null,
        summary: payload.summary ?? null,
        impact: payload.impact ?? null,
        backupPath: payload.backupPath ?? null,
        rollback: payload.rollback ?? null,
        // 拟修改的真实 Diff 在右栏「文件变更」里：卡片只带这个标识。
        changeId: payload.changeId ?? null,
        cwd: payload.cwd ?? existing?.cwd ?? "",
        deadline: payload.deadline,
      };
      /*
       * **逐条**登记：当前对话的卡片与后台对话的卡片并存，后到的不覆盖先到的。
       * 窗口收起时通知由同一个状态派生，所以两处永远一致。
       */
      if (next.callId) {
        const key = approvalKeyOf(next.taskId, next.callId);
        const known = approvalEntriesRef.current[key];
        // 已经处理过 / 已撤回的，重复事件不能把它挂回来。
        if (!known) {
          /*
           * 同一步骤换了 callId = 确认前文件被外部改过，后端按当前内容生成了
           * 新预览：旧卡已经没有等待者，必须撤掉，不能同时给两张"允许"。
           */
          dropApprovals(
            (entry) =>
              entry.approval.taskId === next.taskId &&
              entry.approval.stepIndex === next.stepIndex &&
              entry.approval.callId !== next.callId,
          );
          setApprovalEntry(next);
        }
      }
    }
    if (payload.kind === "approval_withdrawn") {
      const key = approvalKeyOf(payload.taskId, payload.callId ?? "");
      dropApprovals((entry) => approvalKeyOf(entry.approval.taskId, entry.approval.callId) === key);
      if (isCurrent) {
        /*
         * 用户补了一句要求，后台撤回了待确认操作：确认条必须立刻收起，
         * 否则用户还可能点「允许」，而它已经不会再执行。
         */
        setNotice(t("已收到新的要求，撤回了这条待确认操作。"));
      }
    }
    if (payload.kind === "steer_applied" && isCurrent && payload.content) {
      setNotice(t("已更新当前任务：下一步开始前生效。"));
    }
    const terminal = done;
    if (terminal) {
      // 任务结束：它名下还没处理的审批一起收起（不再需要表态）。
      dropApprovals((entry) => entry.approval.taskId === payload.taskId);
      setStaleTask((current) => (current === payload.taskId ? null : current));
      setStopOverdueId((current) => (current === payload.taskId ? null : current));
      notifyAgentFinished(snapshotFromEvent(payload));
      /*
       * 重进后接回来的任务没有 `ask()` 在等它：这里负责收尾。
       * 正常流程 `ask()` 的 finally 也会做同样的事，重复执行无害。
       */
      // 后端确认了终态：这时才把"正在停止"收掉（无论当前看的是哪条对话）。
      setStoppingIds((current) => {
        if (!current.has(payload.taskId)) return current;
        const next = new Set(current);
        next.delete(payload.taskId);
        return next;
      });
      if (isCurrent && taskIdRef.current === payload.taskId) {
        setAsking(false);
        taskIdRef.current = null;
      }
      /*
       * 结论只写回**它自己那条对话**：A 的回答不能出现在 B 的气泡里。
       *
       * **后端终态 content 是权威全文**：流式中途收起/刷新再重进时，气泡里
       * 只有重进后收到的后半段，`!reply.text` 的兜底会把开头永久丢掉。
       * 只要权威值非空就整段覆盖 —— 与 `tool_finished` 用完整值覆盖增量是
       * 同一原则。cancelled / failed 不清掉用户已看到的正文。
       */
      if (reply?.role === "assistant") {
        // **先过滤内部标记再上屏**：`[[upload]]` 这类平台指令不该留在气泡里
        // （重进路径没有 ask() 的主流程来清理，这里必须自己清干净）。
        const authoritative =
          payload.kind === "finished"
            ? stripPanelAction(parseActions(payload.content ?? "").clean)
            : "";
        // `terminal` 分支已保证 kind 就是这三个之一；`AgentEvent.kind` 本身是宽类型。
        const kind =
          payload.kind === "cancelled"
            ? "cancelled"
            : payload.kind === "failed"
              ? "failed"
              : "finished";
        /*
         * 有顺序信息时只校**最后一段**：前面几轮的正文与命令是过程记录，
         * 用终态全文整条覆盖会把「我先检查配置」这类说明抹掉。
         */
        const current = reply.parts?.length ? trailingText(reply.parts) : reply.text;
        const text =
          kind === "cancelled" && reply.text.trim()
            ? null
            : terminalReplyText(kind, authoritative, current, t("已停止。"));
        if (text) {
          /*
           * **失败 / 停止也要在气泡上留痕**：用户已经看到的那半段正文不删，
           * 只标清"回复中断 + 原因"，并给重试入口（切走再回来仍然在）。
           */
          const hadText = Boolean(reply.text.trim());
          const parts = reply.parts?.length
            ? replaceTrailingText(reply.parts, text)
            : undefined;
          patchMessageIn(ownerId, reply.id, {
            ...(parts ? { parts, text: partsText(parts) } : { text }),
            model: payload.model ?? reply.model,
            interrupted:
              kind === "failed"
                ? "failed"
                : kind === "cancelled" && hadText
                  ? "cancelled"
                  : null,
            interruptReason:
              kind === "failed"
                ? payload.message?.trim() || t("执行失败")
                : kind === "cancelled" && hadText
                  ? t("已停止：上面是停止前已经生成的内容。")
                  : null,
          });
        }
        // 终态带完整计划：把最后的状态写回消息（计划卡不会停在旧进度）。
        if (payload.plan) {
          const state = useExtremeStore.getState();
          const message = messageOf(state, ownerId, reply.id);
          if (message) {
            const parts = upsertPlanPart(partsOf(message), {
              taskId: payload.taskId,
              plan: payload.plan,
            });
            if (parts !== message.parts) {
              state.patchMessageIn(ownerId, reply.id, { parts });
            }
          }
        }
        // 任务结束：还挂着的提问不可能再回答，历史里改成「已失效」。
        {
          const state = useExtremeStore.getState();
          const message = messageOf(state, ownerId, reply.id);
          if (message) {
            const parts = expireQuestions(partsOf(message));
            if (parts !== message.parts) {
              state.patchMessageIn(ownerId, reply.id, { parts });
            }
          }
        }
      }
    }

    const status =
      payload.kind === "finished"
        ? "success"
        : payload.kind === "failed"
          ? "failed"
          : payload.kind === "cancelled"
            ? "cancelled"
            : payload.kind === "approval_required" ||
                payload.kind === "question_required"
              ? "waiting"
              : payload.kind === "approval_withdrawn" ||
                  payload.kind === "question_answered"
                ? "running"
                : existing?.status ?? "running";

    const card = cardFromAgent({
      taskId: payload.taskId,
      server: existing?.server ?? owner?.server ?? "",
      sessionId: existing?.sessionId ?? owner?.sessionId ?? "",
      workspaceId: ownerId,
      serverId: existing?.serverId ?? owner?.serverId ?? null,
      originMessageId: existing?.originMessageId,
      goal: existing?.goal ?? "",
      steps,
      status,
      error: payload.kind === "failed" ? payload.message : undefined,
      cwd: payload.cwd ?? existing?.cwd,
      // 终态验证结论：由后端按真实步骤判定，前端只展示。
      outcome: payload.outcome ?? null,
      existing,
      t,
    });
    upsertTask(card);
    /*
     * 只有**实时第一次进入终态**才提醒；历史恢复、快照校对、重复事件都不发。
     * 是否真的弹由 `notifyTaskOutcome` 检查主窗口是否已最小化 / 隐藏到托盘。
     */
    const alreadyTerminal =
      existing?.status === "done" ||
      existing?.status === "failed" ||
      existing?.status === "cancelled";
    if (
      (payload.kind === "finished" || payload.kind === "failed") &&
      !alreadyTerminal &&
      !suppressTerminalNotifyRef.current
    ) {
      void notifyTaskOutcome(card);
    }
    saveAgentTask(
      card,
      terminal || payload.kind === "tool_finished" || payload.kind === "approval_required",
    );
    /*
     * 终态时把这轮的文件变更（摘要 + 脱敏 Diff）落进任务历史：应用重启后
     * 右栏仍能打开当时的结果。只在终态写一次，跑的过程中不碰数据库。
     */
    if (terminal) {
      void opsApi.aiAgentTaskChangesSave(payload.taskId).catch(() => undefined);
    }
    /*
     * 只有**当前这条对话**的目录才驱动右栏，而且**只在任务结束时跟随一次**。
     *
     * 执行中每步都刷新目录面板既打断阅读，也把用户手动翻到的位置冲掉；
     * 用户要的是"跑完带我去最终目录"。
     */
    if (isCurrent && payload.cwd) {
      const moved = agentCwdRef.current !== payload.cwd;
      agentCwdRef.current = payload.cwd;
      if (terminal && moved) setFollowNonce((nonce) => nonce + 1);
    }
  };

  // rAF 里也要能用**最新**的闭包（`t`、页面状态都随渲染变）。
  applyAgentEventRef.current = applyAgentEvent;

  /**
   * 事件入口：只有正文与工具输出进缓冲，其余事件立即处理。
   *
   * 进立即处理之前先把这条任务的缓冲 flush 掉 —— `tool_finished` 带的是完整
   * 输出，它要是先落、增量后到，界面上就会出现"输出回退"。
   */
  const agentEventHandler = useRef<(payload: AgentEvent, snapshot?: AgentSnapshot) => void>(
    () => undefined,
  );
  agentEventHandler.current = (payload, snapshot) => {
    if (!payload?.taskId) return;
    /*
     * 文件变更：**只更新记录**，不抢前台右栏。
     *
     * 摘要按 changeId 存进 store（事件带的是标识与增删行数，不带正文）；
     * 后台对话的变更同样落库，用户切回去时面板自然能看到。
     */
    if (payload.kind === "file_change") {
      const change = payload.change;
      if (change) {
        mergeFileChange(change);
        /*
         * 预览作废只对**当前对话**提示一句：确认卡会换成新的一版，用户得知道
         * 为什么又要确认一次。后台对话不打断当前输入。
         */
        if (
          change.status === "stale" &&
          change.workspaceId &&
          change.workspaceId === useExtremeStore.getState().workspaceId
        ) {
          setNotice(
            t("原文件在确认前被外部修改：旧预览已作废，已按当前内容生成新的预览，请重新确认。"),
          );
        }
      }
      return;
    }
    const context = snapshot?.context ?? payload.context;
    if (context && locateTask(payload.taskId)) setTaskUsage(payload.taskId, context);
    if (payload.kind === "context_usage") return;
    if (payload.kind === "text_delta") {
      queueTextDelta(payload);
      return;
    }
    if (payload.kind === "tool_output") {
      queueToolOutput(payload);
      return;
    }
    const done =
      payload.kind === "finished" || payload.kind === "failed" || payload.kind === "cancelled";
    flushTaskNow(payload.taskId, done);
    applyAgentEvent(payload, snapshot);
  };

  const applyTerminalSnapshot = useCallback((snapshot: AgentSnapshot, notify = false) => {
    const kind =
      snapshot.status === "success" ? "finished" :
      snapshot.status === "failed" ? "failed" :
      snapshot.status === "cancelled" ? "cancelled" : null;
    if (!kind) return false;
    // 恢复 / 校对出来的终态只补卡片与气泡，不当成"刚刚完成"发桌面通知。
    suppressTerminalNotifyRef.current = !notify;
    try {
      agentEventHandler.current({
        taskId: snapshot.taskId,
        kind,
        model: snapshot.model,
        content: snapshot.content,
        message: snapshot.error ?? undefined,
        cwd: snapshot.cwd,
        outcome: snapshot.outcome ?? null,
        plan: snapshot.plan ?? null,
      }, snapshot);
    } finally {
      suppressTerminalNotifyRef.current = false;
    }
    return true;
  }, []);

  /*
   * 订阅**只挂一次**：回调通过 ref 取最新的处理函数。
   *
   * 以前依赖里带着 `t` / `saveAgentTask`，切语言或函数身份变化就会重订阅；
   * 加上 `listen()` 是异步的，注册未完成时卸载会漏掉 unlisten —— 监听越积
   * 越多，同一个增量被处理多次，正文出现「按按方案方案」。
   */
  useEffect(
    () => attachAgentEvents((payload) => agentEventHandler.current(payload)),
    [],
  );

  /**
   * 重开应用后，把**这条对话里被引用过的任务卡**从历史装回来。
   *
   * 任务句柄只在内存里，重启后聊天里就只剩下一句"已完成 / 已停止"的旧回复；
   * 加载检查点卡片（步骤 + 结论 + 已中断状态）之后，「继续执行」才有地方点。
   * 实时任务优先：store 里已有的卡片不覆盖。
   */
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void opsApi
      .extremeTaskList({ workspaceId, limit: 50 })
      .then((records) => {
        if (cancelled || !Array.isArray(records)) return;
        const state = useExtremeStore.getState();
        if (state.workspaceId !== workspaceId) return;
        const referenced = new Set(
          state.messages.map((message) => message.taskId).filter(Boolean) as string[],
        );
        for (const record of records) {
          if (!referenced.has(record.id) || state.tasks[record.id]) continue;
          /*
           * 老记录可能没有 `goal`（早期版本只存摘要）：用发起它的那句用户原话
           * 补上，卡片才不会只显示"服务器 · 自动化"这种用户看不懂的标题。
           */
          const origin = state.messages.find((message) => message.taskId === record.id);
          upsertTask(cardFromRecord(record, origin?.text ?? "", origin?.id));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [upsertTask, workspaceId]);

  /*
   * 增量缓冲的生命周期：切对话 / 卸载时收尾。
   *
   * 先把压在这一帧里的增量落掉再清 —— 写入一律按 `ownerId` 定位，切走不会
   * 写到新对话上；不落而直接丢掉，会让最后几个字永远不出现。之后取消还没
   * 跑的那一帧并清空缓冲，别往已经不在的界面里写。
   */
  useEffect(
    () => () => {
      if (flushFrame.current !== null) {
        cancelAnimationFrame(flushFrame.current);
        flushFrame.current = null;
      }
      flushStreams();
      textBuffers.current.clear();
      streamFilters.current.clear();
      toolBuffers.current.clear();
    },
    [flushStreams, workspaceId],
  );

  /**
   * 重进 / 重开 WebView 后把任务接回来。
   *
   * 循环在 Rust 侧，界面重开时只剩一条空白的助手消息 —— 卡片在 `tasks` 里
   * （内存），刷新就没了。这里按消息上的 `taskId` 问后端要快照：
   * * 还在跑 → 恢复进度、cwd 与「停止」按钮；
   * * 等确认 → 把确认条原样画回来（`callId` 就在快照里）；
   * * 已结束 → 补上结论并写好气泡。
   */
  const reattachRef = useRef<{ workspaceId: string | null; ids: Set<string> }>({
    workspaceId: null,
    ids: new Set(),
  });
  useEffect(() => {
    if (!active || !sessionId) return;
    const state = useExtremeStore.getState();
    const sessionAtFetch = sessionId;
    // 换会话要重新对一遍：上一台接过的任务不在这一台的候选里，也不该被跳过。
    if (reattachRef.current.workspaceId !== state.workspaceId) {
      reattachRef.current = { workspaceId: state.workspaceId, ids: new Set() };
    }
    const reattached = reattachRef.current.ids;
    const taskIds = Array.from(
      new Set(state.messages.map((message) => message.taskId).filter(Boolean) as string[]),
    ).reverse();
    for (const taskId of taskIds.slice(0, 6)) {
      if (reattached.has(taskId)) continue;
      /*
       * **本组件里刚发起的运行不参与收敛。**
       *
       * 启动瞬间的快照可能还没带上这次连接（`sessionId` 为空 / 是旧的），
       * 拿它判"连接已更换"会把正在跑的任务误标成已中断，后续增量全被丢掉。
       */
      if (taskIdRef.current === taskId || inFlightRef.current.has(state.workspaceId ?? "")) {
        reattached.add(taskId);
        continue;
      }
      const known = state.tasks[taskId];
      // 这次会话里已经跑完的卡不必再问；还在跑的要问（可能已推进了）。
      if (known && known.status !== "running" && known.status !== "confirming") {
        reattached.add(taskId);
        continue;
      }
      reattached.add(taskId);
      void (async () => {
        try {
          const snapshot = await opsApi.aiAgentSnapshot(taskId);
          const latest = useExtremeStore.getState();
          if (latest.sessionId !== sessionAtFetch || latest.workspaceId !== state.workspaceId) return;
          const existing = latest.tasks[taskId];
          const owner = latest.messages.find((message) => message.taskId === taskId);
          /**
           * 把还停在"执行中"的卡片收敛成「已中断」。
           *
           * 这是僵尸任务唯一的出口：不收敛的话那张卡会一直占着 `busy`，
           * 用户既发不出去也停不下来，界面上只剩一句"执行中"。
           */
          const markInterrupted = (reason: string) => {
            if (existing && (existing.status === "running" || existing.status === "confirming")) {
              const interrupted = {
                ...existing,
                status: "interrupted" as const,
                result: reason,
                steps: interruptedChildSteps(existing.steps, (key) => t(key)),
                updatedAt: Date.now(),
              };
              upsertTask(interrupted);
              saveAgentTask(interrupted, true);
            }
            if (taskIdRef.current === taskId) {
              setAsking(false);
              taskIdRef.current = null;
            }
          };
          if (!snapshot) {
            // 后端没有这条运行（应用重启 / 记录已清理）：不会再有终态事件。
            markInterrupted(t("上次运行已中断：后端没有这次运行的记录。"));
            reattached.delete(taskId);
            return;
          }
          if (snapshot.sessionId && snapshot.sessionId !== sessionAtFetch) {
            // 运行绑在另一条 SSH 连接上：当前会话不可能继续它。
            markInterrupted(t("连接已经更换，这次运行不会继续；需要时可「继续执行」。"));
            return;
          }
          setTaskUsage(snapshot.taskId, snapshot.context ?? null);

          const steps = snapshot.steps ?? [];
          agentStepsRef.current.set(taskId, steps);
          const card = cardFromAgent({
            taskId,
            server: snapshot.server || latest.server || "",
            sessionId: snapshot.sessionId || sessionAtFetch,
            // 接回来的任务属于**当前这条对话**（消息就在它里面）。
            workspaceId: latest.workspaceId,
            serverId: latest.serverId,
            originMessageId: existing?.originMessageId ?? owner?.id,
            // 卡片标题只有"服务器 · 自动化"时，用户不知道在跑什么：优先用
            // 快照里的目标，其次用发起这条任务的那句原话。
            goal: existing?.goal || snapshot.context?.goal || owner?.text.trim() || "",
            steps,
            status: snapshot.status,
            error: snapshot.status === "failed" ? snapshot.error : undefined,
            cwd: snapshot.cwd,
            outcome: snapshot.outcome ?? null,
            existing,
            t,
          });
          upsertTask(card);
          if (snapshot.cwd) agentCwdRef.current = snapshot.cwd;

          const terminal =
            snapshot.status === "success" ||
            snapshot.status === "failed" ||
            snapshot.status === "cancelled";
          if (terminal) {
            // 重开时气泡可能是空的、也可能只有半截：success 用权威全文覆盖
            // （与实时终态同一原则）；cancelled / failed 只在空时兜底。
            const at = owner ? latest.messages.indexOf(owner) : -1;
            const reply = replyAfter(latest.messages, at);
            const text =
              stripPanelAction(parseActions(snapshot.content).clean) ||
              (snapshot.status === "cancelled" ? t("已停止。") : "");
            if (reply?.role === "assistant" && text) {
              if (reply.parts?.length) {
                // 有顺序信息：只校最后一段正文（前面几轮是过程记录）。
                const current = trailingText(reply.parts);
                const overwrite =
                  snapshot.status === "success" ? current !== text : !reply.text;
                if (overwrite) {
                  const parts = replaceTrailingText(reply.parts, text);
                  patchMessage(reply.id, {
                    parts,
                    text: partsText(parts),
                    model: snapshot.model || reply.model,
                  });
                }
              } else {
                const overwrite =
                  snapshot.status === "success" ? reply.text !== text : !reply.text;
                if (overwrite) {
                  patchMessage(reply.id, { text, model: snapshot.model || reply.model });
                }
              }
            }
            // 计划跟着消息恢复：重开会话后计划卡仍是当时那一版。
            if (reply?.role === "assistant" && snapshot.plan) {
              // 正文可能刚被权威全文覆盖过：从 store 读最新那条，别拿旧片段覆盖回去。
              const latestReply =
                useExtremeStore.getState().messages.find((message) => message.id === reply.id) ??
                reply;
              const parts = upsertPlanPart(partsOf(latestReply), {
                taskId,
                plan: snapshot.plan,
              });
              if (parts !== latestReply.parts) patchMessage(reply.id, { parts });
            }
            return;
          }

          // 还在跑：恢复「停止」按钮；目录只记下来，等结束再跟随。
          setAsking(true);
          taskIdRef.current = taskId;
          /*
           * **流式中途重进**：气泡里只有重进后收到的增量，缺重进前流出的
           * 前半段。snapshot.content 是权威前缀 —— 回填它并丢掉旧过滤器，
           * 后续增量会由 queueTextDelta 重建过滤器接在它后面；终态还会用
           * 全文再覆盖一次兜底。气泡已经比快照更新（竞态）时不动它。
           */
          {
            const at = owner ? latest.messages.indexOf(owner) : -1;
            const reply = replyAfter(latest.messages, at);
            const prefix = visibleStream(snapshot.content ?? "");
            if (reply?.role === "assistant" && reply.parts?.length) {
              /*
               * 已有顺序信息：只回填**最后一段**正文（当前这一轮），
               * 前面几轮的正文与命令保持原位。
               */
              const current = trailingText(reply.parts);
              const withPlan = snapshot.plan
                ? upsertPlanPart(reply.parts, { taskId, plan: snapshot.plan })
                : reply.parts;
              if (shouldBackfillPrefix(prefix, current)) {
                const parts = replaceTrailingText(withPlan, prefix);
                patchMessage(reply.id, {
                  parts,
                  text: partsText(parts),
                  model: snapshot.model || reply.model,
                });
                textBuffers.current.delete(taskId);
                streamFilters.current.delete(taskId);
              } else if (withPlan !== reply.parts) {
                patchMessage(reply.id, { parts: withPlan });
              }
            } else if (reply?.role === "assistant" && shouldBackfillPrefix(prefix, reply.text)) {
              patchMessage(reply.id, { text: prefix, model: snapshot.model || reply.model });
              textBuffers.current.delete(taskId);
              streamFilters.current.delete(taskId);
            } else if (reply?.role === "assistant" && !reply.parts?.length && !reply.text.trim() && steps.length > 0) {
              /*
               * 老气泡没有顺序信息、也还没有任何正文（应用重启后接回正在跑的
               * 任务）：按快照里的步骤顺序重建内联行，后续增量接在它们后面。
               * 已经有正文的旧记录不猜顺序，仍按整块折叠卡呈现。
               */
              let parts: MessagePart[] = [];
              if (snapshot.plan) {
                parts = upsertPlanPart(parts, { taskId, plan: snapshot.plan });
              }
              for (const step of steps) {
                parts = upsertStep(parts, {
                  taskId,
                  stepIndex: step.index,
                  label: stepTitle(step, t),
                  internal: step.category === "internal",
                  planStepId: step.planStepId,
                  groupId: step.groupId,
                });
              }
              /*
               * 顺手把 taskId 挪到回复上：任务卡从此挂在这一轮回复下面，
               * 用户提问那条不再重复一张折叠卡。
               */
              if (parts.length) patchMessage(reply.id, { parts, taskId });
            }
          }
          /*
           * 只恢复**真实仍在等确认**的那一条。
           *
           * 历史里已经处理完 / 已超时的审批 `pendingApproval` 为空，不会在这里
           * 被重新挂回来，也就不会在窗口收起时补发通知。
           */
          const pending = snapshot.pendingApproval;
          if (pending) {
            setApprovalEntry({
              taskId,
              callId: pending.callId,
              stepIndex: pending.stepIndex,
              tool: pending.tool,
              server: snapshot.server || latest.server || "",
              path: pending.path ?? null,
              risk: pending.risk,
              command: pending.command,
              script: pending.script ?? null,
              summary: pending.summary ?? null,
              impact: pending.impact ?? null,
              backupPath: pending.backupPath ?? null,
              rollback: pending.rollback ?? null,
              changeId: pending.changeId ?? null,
              cwd: pending.cwd || snapshot.cwd,
              deadline: pending.deadline,
            });
          }
          // 问题卡也按快照恢复；草稿在选择时已经写进 parts，不会被这里覆盖。
          if (snapshot.pendingQuestion) {
            const at = owner ? latest.messages.indexOf(owner) : -1;
            const target = replyAfter(latest.messages, at);
            if (target?.role === "assistant") {
              const state = useExtremeStore.getState();
              const message = state.messages.find((item) => item.id === target.id);
              if (message) {
                let parts = upsertQuestion(partsOf(message), snapshot.pendingQuestion);
                const card = parts.find(
                  (item) =>
                    item.kind === "question" &&
                    item.question.questionId === snapshot.pendingQuestion!.questionId,
                );
                // 上次停在"提交中"但任务仍在等待：说明提交没送达，恢复成可重试。
                if (card?.kind === "question" && card.status === "submitting") {
                  parts = updateQuestionPart(parts, card.question.questionId, {
                    status: "pending",
                    error: null,
                  });
                }
                if (parts !== message.parts) {
                  state.patchMessage(target.id, { parts });
                }
              }
            }
          }
        } catch {
          /*
           * 查不到（没有这条运行 / 后端重启过）或这次查询失败：从"已接过"里
           * 摘掉，下次收起再进来时再试一次 —— 只失败一次就永远放弃不合适。
           */
          reattached.delete(taskId);
        }
      })();
    }
  }, [active, sessionId, workspaceId, patchMessage, t, upsertTask]);

  return {
    streamingReplies,
    streamFilters,
    textBuffers,
    applyTerminalSnapshot,
    saveAgentTask,
    flushTaskNow,
  };
}
