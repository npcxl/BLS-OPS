/**
 * 一轮回复里**正文与工具步骤的真实顺序**（纯函数，便于单测）。
 *
 * 以前正文写在气泡上、工具卡挂在"第一条引用 taskId 的消息"下面，两样东西各有
 * 各的渲染位置：模型先解释一句再跑命令，界面上命令卡会跑到解释上方。这里把
 * 一轮回复拆成有序的片段（`text` / `step`），谁先发生谁在前：
 *
 *   text("我先检查 Nginx 配置") → step(0) → text("发现端口没监听") → step(1) → text(结论)
 *
 * 约束：
 * * `message.text` 始终等于所有 text 片段拼接的结果（复制 / 引用 / 请求历史都读它）；
 * * 步骤片段只记 `taskId + stepIndex`，命令与输出仍来自任务卡（同一份真相）；
 * * 合并是幂等的 —— 重复的 `tool_started` / `tool_finished` 不会多出一行。
 */

import type {
  AgentPlan,
  AgentQuestion,
  AgentQuestionAnswer,
} from "@/api/types/agent";

export interface MessageTextPart {
  kind: "text";
  id: string;
  text: string;
}

/**
 * 后端补的执行前说明（模型直接调工具、没写正文时）。
 *
 * 与工具步骤共享 `groupId`：同一个目的连续几条命令只显示一次；回放历史时
 * 顺序与当时一致。
 */
export interface MessageNotePart {
  kind: "note";
  id: string;
  groupId: string;
  text: string;
}

export interface MessageStepPart {
  kind: "step";
  id: string;
  /** 这条步骤属于哪次运行（一轮里可能续跑同一个 taskId）。 */
  taskId: string;
  /** 后端步骤序号（`agent-${stepIndex}` 对应任务卡里的那一步）。 */
  stepIndex: number;
  /**
   * 步骤首次出现时的一句话操作名（「检查 Nginx 配置」）。
   *
   * 任务卡还没从历史里装回来时也至少能显示这一行；之后**不跟着**状态文案改写
   * （跳过 / 拒绝会把 summary 换成原因，那不是操作名）。
   */
  label?: string;
  /**
   * 这一步是**用户拒绝**的（不是执行失败）：状态显示「未执行」。
   *
   * 审批条目在用户下一句话后会收起，这个标记要留在顺序记录里，
   * 重开会话仍然是「未执行」。
   */
  denied?: boolean;
  /**
   * 平台内部纠错（命令没有执行）：默认收纳成一条「内部调整」，不刷失败卡。
   *
   * 与任务卡上的 `category` 是同一个事实；记在消息上是为了任务卡还没装回来
   * （历史恢复 / 切换对话）时也能按分类渲染。旧记录没有这个字段 = 真实执行。
   */
  internal?: boolean;
  /** 计划里的哪一步（MAX 强制计划）：点击计划卡时据此定位。 */
  planStepId?: string;
  /** 操作组：说明与工具事件共享，连续命令只显示一次说明。 */
  groupId?: string;
}

/** 本轮的完整计划（MAX）：跟着消息落盘，重开会话仍是同一条。 */
export interface MessagePlanPart {
  kind: "plan";
  id: string;
  taskId: string;
  plan: AgentPlan;
}

/** AI 向用户提问：问题、选项与未提交/已回答状态都跟着消息落盘。 */
export interface MessageQuestionPart {
  kind: "question";
  id: string;
  taskId: string;
  question: AgentQuestion;
  status: "pending" | "submitting" | "answered" | "failed" | "expired";
  answer?: AgentQuestionAnswer | null;
  /** 未提交的选择：切换会话 / 重开会话后恢复。 */
  draftSelected: string[];
  draftCustom: string;
  draftCustomActive: boolean;
  error?: string | null;
}

export type MessagePart =
  | MessageTextPart
  | MessageStepPart
  | MessageNotePart
  | MessagePlanPart
  | MessageQuestionPart;

export interface MessageWithParts {
  id: string;
  text: string;
  parts?: MessagePart[];
}

let partSeq = 0;

function nextPartId(prefix: string): string {
  partSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${partSeq}`;
}

export function stepPartId(taskId: string, stepIndex: number): string {
  return `step-${taskId}-${stepIndex}`;
}

export function isStepPart(part: MessagePart): part is MessageStepPart {
  return part.kind === "step";
}

export function isTextPart(part: MessagePart): part is MessageTextPart {
  return part.kind === "text";
}

/**
 * 消息的片段列表（旧记录没有 `parts` 时按整段正文兜底）。
 *
 * 返回的数组可能是**新建的**，调用方不要拿它做引用比较；判断"有没有变化"要看
 * 合并函数的返回值是否与入参同一个引用。
 */
export function partsOf(message: MessageWithParts): MessagePart[] {
  if (message.parts?.length) return message.parts;
  if (!message.text) return [];
  return [{ kind: "text", id: `text-${message.id}`, text: message.text }];
}

/** 所有正文片段拼起来 = `message.text`（写回时用它保持一致）。 */
export function partsText(parts: MessagePart[]): string {
  let text = "";
  for (const part of parts) if (part.kind === "text") text += part.text;
  return text;
}

/** 末尾那段正文（没有就是空串）：流式过滤器的续接状态只属于它。 */
export function trailingText(parts: MessagePart[]): string {
  const last = parts[parts.length - 1];
  return last?.kind === "text" ? last.text : "";
}

/** 这批片段里有没有工具步骤（有 = 走内联时间线，不再画整块折叠卡）。 */
export function hasStepParts(parts: MessagePart[]): boolean {
  return parts.some((part) => part.kind === "step");
}

/**
 * 追加正文。
 *
 * 末尾已经是正文片段就接着写；否则（上一段是命令）**另起一段** —— 这就是
 * 「命令结束后，后续正文接在命令行下面」。
 */
export function appendText(parts: MessagePart[], delta: string): MessagePart[] {
  if (!delta) return parts;
  const last = parts[parts.length - 1];
  if (last?.kind === "text") {
    const copy = parts.slice();
    copy[copy.length - 1] = { ...last, text: last.text + delta };
    return copy;
  }
  return [...parts, { kind: "text", id: nextPartId("text"), text: delta }];
}

/**
 * 覆盖**最后一段**正文（终态权威全文 / 重进回填）。
 *
 * 前面几轮的正文与命令顺序保持不变，只把正在长的那一段补全 —— 整条回复覆盖
 * 会把「我先检查配置」这类过程说明抹掉。
 */
export function replaceTrailingText(parts: MessagePart[], text: string): MessagePart[] {
  const last = parts[parts.length - 1];
  if (last?.kind === "text") {
    if (last.text === text) return parts;
    const copy = parts.slice();
    copy[copy.length - 1] = { ...last, text };
    return copy;
  }
  if (!text) return parts;
  return [...parts, { kind: "text", id: nextPartId("text"), text }];
}

/**
 * 登记一条步骤（幂等）。
 *
 * 已存在时只补空的操作名，不覆盖第一次记下的名字：`tool_finished` 可能把
 * summary 换成「用户拒绝执行这条命令」，那是状态说明，不是操作名。
 */
export function upsertStep(
  parts: MessagePart[],
  input: {
    taskId: string;
    stepIndex: number;
    label?: string | null;
    denied?: boolean;
    internal?: boolean;
    planStepId?: string | null;
    groupId?: string | null;
  },
): MessagePart[] {
  const position = parts.findIndex(
    (part) =>
      part.kind === "step" &&
      part.taskId === input.taskId &&
      part.stepIndex === input.stepIndex,
  );
  const label = input.label?.trim() || undefined;
  const planStepId = input.planStepId?.trim() || undefined;
  const groupId = input.groupId?.trim() || undefined;
  if (position >= 0) {
    const current = parts[position] as MessageStepPart;
    const nextLabel = current.label || label;
    const denied = current.denied || input.denied || undefined;
    const internal = current.internal || input.internal || undefined;
    const nextPlanStepId = current.planStepId || planStepId;
    const nextGroupId = current.groupId || groupId;
    if (
      (current.label ?? "") === (nextLabel ?? "") &&
      current.denied === denied &&
      current.internal === internal &&
      (current.planStepId ?? "") === (nextPlanStepId ?? "") &&
      (current.groupId ?? "") === (nextGroupId ?? "")
    ) {
      return parts;
    }
    const copy = parts.slice();
    copy[position] = {
      ...current,
      label: nextLabel,
      ...(denied ? { denied } : {}),
      ...(internal ? { internal } : {}),
      ...(nextPlanStepId ? { planStepId: nextPlanStepId } : {}),
      ...(nextGroupId ? { groupId: nextGroupId } : {}),
    };
    return copy;
  }
  return [
    ...parts,
    {
      kind: "step",
      id: stepPartId(input.taskId, input.stepIndex),
      taskId: input.taskId,
      stepIndex: input.stepIndex,
      ...(label ? { label } : {}),
      ...(input.denied ? { denied: true } : {}),
      ...(input.internal ? { internal: true } : {}),
      ...(planStepId ? { planStepId } : {}),
      ...(groupId ? { groupId } : {}),
    },
  ];
}

/**
 * 登记执行前说明（按 `groupId` 幂等）。
 *
 * 说明必须在**该组第一条命令**上方：重复事件不会多出一行，重进后回填也不会
 * 跑到命令下方。
 */
export function upsertNote(
  parts: MessagePart[],
  input: { groupId: string; text: string },
): MessagePart[] {
  const groupId = input.groupId.trim();
  const text = input.text.trim();
  if (!groupId || !text) return parts;
  const existing = parts.findIndex(
    (part) => part.kind === "note" && part.groupId === groupId,
  );
  if (existing >= 0) {
    const current = parts[existing] as MessageNotePart;
    if (current.text === text) return parts;
    const copy = parts.slice();
    copy[existing] = { ...current, text };
    return copy;
  }
  const note: MessageNotePart = {
    kind: "note",
    id: `note-${groupId}`,
    groupId,
    text,
  };
  // 放在这一组第一条命令之前（正常路径本来就是追加在末尾）。
  const firstStep = parts.findIndex(
    (part) => part.kind === "step" && part.groupId === groupId,
  );
  if (firstStep < 0) return [...parts, note];
  return [...parts.slice(0, firstStep), note, ...parts.slice(firstStep)];
}

/** 最新一版计划写到消息上（同一轮只保留一条，原地替换）。 */
export function upsertPlanPart(
  parts: MessagePart[],
  input: { taskId: string; plan: AgentPlan },
): MessagePart[] {
  const position = parts.findIndex((part) => part.kind === "plan");
  if (position >= 0) {
    const current = parts[position] as MessagePlanPart;
    if (JSON.stringify(current.plan) === JSON.stringify(input.plan)) return parts;
    const copy = parts.slice();
    copy[position] = { ...current, plan: input.plan };
    return copy;
  }
  return [
    ...parts,
    {
      kind: "plan",
      id: `plan-${input.taskId}`,
      taskId: input.taskId,
      plan: input.plan,
    },
  ];
}

/** 同一轮只保留一个问题卡；重复事件不覆盖未提交的选择或已回答结果。 */
export function upsertQuestion(
  parts: MessagePart[],
  question: AgentQuestion,
): MessagePart[] {
  const position = parts.findIndex(
    (part) =>
      part.kind === "question" &&
      part.question.questionId === question.questionId,
  );
  if (position >= 0) {
    const current = parts[position] as MessageQuestionPart;
    // 已回答 / 已失效是终态：事件重放不能把卡片挂回待回答。
    if (current.status === "answered" || current.status === "expired") return parts;
    if (JSON.stringify(current.question) === JSON.stringify(question)) return parts;
    const copy = parts.slice();
    copy[position] = { ...current, question };
    return copy;
  }
  return [
    ...parts,
    {
      kind: "question",
      id: `question-${question.questionId}`,
      taskId: question.taskId,
      question,
      status: "pending",
      draftSelected: [],
      draftCustom: "",
      draftCustomActive: false,
      answer: null,
      error: null,
    },
  ];
}

/** 更新问题卡的本地状态（选择、提交中、失败原因、已回答）。 */
export function updateQuestionPart(
  parts: MessagePart[],
  questionId: string,
  patch: Partial<
    Pick<
      MessageQuestionPart,
      | "status"
      | "answer"
      | "draftSelected"
      | "draftCustom"
      | "draftCustomActive"
      | "error"
    >
  >,
): MessagePart[] {
  const position = parts.findIndex(
    (part) => part.kind === "question" && part.question.questionId === questionId,
  );
  if (position < 0) return parts;
  const current = parts[position] as MessageQuestionPart;
  const copy = parts.slice();
  copy[position] = { ...current, ...patch };
  return copy;
}

/** 任务结束时把仍未回答的卡片收成「已失效」，已回答的历史保持原样。 */
export function expireQuestions(parts: MessagePart[]): MessagePart[] {
  let changed = false;
  const copy = parts.map((part) => {
    if (
      part.kind === "question" &&
      (part.status === "pending" || part.status === "submitting" || part.status === "failed")
    ) {
      changed = true;
      return { ...part, status: "expired" as const };
    }
    return part;
  });
  return changed ? copy : parts;
}

/** 消息上保存的计划（没有就是 `undefined`）。 */
export function planOf(message: { parts?: MessagePart[] }): MessagePlanPart | undefined {
  return [...(message.parts ?? [])].reverse().find(
    (part): part is MessagePlanPart => part.kind === "plan",
  );
}

/** 某个 taskId 的计划（续跑 / 恢复时带回后端）。 */
export function planForTask(
  messages: { parts?: MessagePart[] }[],
  taskId: string,
): AgentPlan | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const part = planOf(messages[index]);
    if (part?.taskId === taskId) return part.plan;
  }
  return null;
}

/** 当前会话最近一版计划（右上角计划卡只显示它）。 */
export function latestPlan(
  messages: { parts?: MessagePart[] }[],
): { taskId: string; plan: AgentPlan } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const part = planOf(messages[index]);
    if (part) return { taskId: part.taskId, plan: part.plan };
  }
  return null;
}

/**
 * 审批锚点：这些 `<taskId>:<stepIndex>` 已经在时间线里，确认条就画在步骤上，
 * 不再另外占用输入框上方的一条（避免同一件事要求确认两遍）。
 */
export function anchoredSteps(
  messages: { parts?: MessagePart[] }[],
): Set<string> {
  const keys = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.kind === "step") keys.add(`${part.taskId}:${part.stepIndex}`);
    }
  }
  return keys;
}
