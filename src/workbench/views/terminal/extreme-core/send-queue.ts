/**
 * 「完成后发送」的**对话队列**（纯函数，不碰 React / store）。
 *
 * # 为什么按对话分桶
 *
 * 以前只有一个全局槽位：A 排一条、B 排一条就把 A 覆盖掉；同一条对话连排两条
 * 也只留最后一条。队列必须按 `workspaceId` 分开，每条对话各自 FIFO —— 这是
 * "切到别的对话也能继续发"的前提。
 *
 * # 入队即快照
 *
 * 排队时把**文字、选中的附件、模型、思考强度、上下文范围、预算**一起定下来。
 * 出队时不再读当前界面的选择：用户在等的时候换了模型 / 取消勾选附件，
 * 已排队的那条仍然是提交时的样子。
 */
import type { ContextMode, OutputStyle, PickedContext } from "./chat-context";
import type { ModelSelection } from "./model-choice";

/** 附件在队列里的**快照**：正文仍按 id 回会话取，取不到就只报路径。 */
export interface QueueAttachment {
  id: string;
  name: string;
  size: number;
  path?: string;
  remotePath?: string;
  /** 入队时的暂存副本路径（清理 / 核验都按它，而不是部署后的线上目标）。 */
  stagedPath?: string;
  /** 入队时的暂存状态：派发时据此判断"已被清理 / 需要重新上传"。 */
  staged?: boolean;
  uploadState?: string;
  /** 暂存副本所属服务器（serverId）。 */
  serverId?: string | null;
  /**
   * 文本正文快照。
   *
   * 队列只在内存里活着，不会落盘；带上它，用户入队后把附件从会话里删掉，
   * 这条消息仍能按**入队时的那份材料**暂存与发送。
   */
  text?: string;
  /** 二进制标记（大文件内容仍走 payload 缓存，不复制进队列）。 */
  binary?: boolean;
}

export interface QueuedSend {
  /** 队列项自己的 id：取消 / 定位都按它，不用下标。 */
  id: string;
  workspaceId: string;
  /** 入队时这条对话绑定的服务器（serverId）：派发前要确认没被换绑。 */
  serverId?: string | null;
  text: string;
  /** 入队那一刻选中的附件（顺序即用户勾选顺序）。 */
  attachments: QueueAttachment[];
  /** 入队那一刻锁定的模型 / 强度 / 预算。 */
  selection: ModelSelection;
  /** 入队那一刻的上下文范围、输出形态与自选材料。 */
  context: ContextMode;
  output: OutputStyle;
  picked: PickedContext[];
  createdAt: number;
  /**
   * 断连 / 发送失败的原因。
   *
   * 非空时**不会被自动派发**：消息留在队列里等用户重试，而不是静默丢掉或
   * 每帧重投一次。
   */
  error: string | null;
}

/** 一条新队列项（补默认 id / 时间 / 错误位）。 */
export function queuedSend(
  input: Omit<QueuedSend, "id" | "createdAt" | "error"> & {
    id?: string;
    createdAt?: number;
    error?: string | null;
  },
): QueuedSend {
  return {
    id: input.id ?? `queue-${crypto.randomUUID()}`,
    workspaceId: input.workspaceId,
    serverId: input.serverId,
    text: input.text,
    attachments: input.attachments,
    selection: input.selection,
    context: input.context,
    output: input.output,
    picked: input.picked,
    createdAt: input.createdAt ?? Date.now(),
    error: input.error ?? null,
  };
}

/** 追加到队尾：同一对话连续排队时保持提交顺序。 */
export function enqueueSend(queue: QueuedSend[], item: QueuedSend): QueuedSend[] {
  return [...queue, item];
}

/** 这条对话的队列项（按入队顺序）。 */
export function sendsFor(queue: QueuedSend[], workspaceId: string | null): QueuedSend[] {
  if (!workspaceId) return [];
  return queue.filter((item) => item.workspaceId === workspaceId);
}

/**
 * 下一条可以派发的项。
 *
 * 只取**队首且没有错误**的那一条：前一条失败时不能跳过它去发后一条，
 * 否则用户排的顺序就乱了。
 */
export function nextSend(queue: QueuedSend[], workspaceId: string | null): QueuedSend | null {
  if (!workspaceId) return null;
  for (const item of queue) {
    if (item.workspaceId !== workspaceId) continue;
    return item.error ? null : item;
  }
  return null;
}

export function removeSend(queue: QueuedSend[], id: string): QueuedSend[] {
  return queue.filter((item) => item.id !== id);
}

/**
 * 上移一位：只和**同一对话**的前一项交换，不能跨对话抖队列。
 * 已经在队首时原样返回。
 */
export function moveSendUp(queue: QueuedSend[], id: string): QueuedSend[] {
  const index = queue.findIndex((item) => item.id === id);
  if (index <= 0) return queue;
  const owner = queue[index].workspaceId;
  let previous = -1;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (queue[cursor].workspaceId === owner) {
      previous = cursor;
      break;
    }
  }
  if (previous < 0) return queue;
  const next = [...queue];
  [next[previous], next[index]] = [next[index], next[previous]];
  return next;
}

export function markSendError(queue: QueuedSend[], id: string, error: string): QueuedSend[] {
  return queue.map((item) => (item.id === id ? { ...item, error } : item));
}

export function clearSendError(queue: QueuedSend[], id: string): QueuedSend[] {
  return queue.map((item) => (item.id === id ? { ...item, error: null } : item));
}

/** 一条对话被删除：它的队列项一并清掉（没有对话就没有"在原对话发送"）。 */
export function forgetSends(queue: QueuedSend[], workspaceId: string): QueuedSend[] {
  return queue.filter((item) => item.workspaceId !== workspaceId);
}
