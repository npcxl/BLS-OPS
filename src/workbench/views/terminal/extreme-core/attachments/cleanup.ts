/**
 * 部署成功后的**暂存清理请求**。
 *
 * # 为什么按 taskId 存、还要落盘
 *
 * 用户可能在 A 任务结束的瞬间切到 B 继续干活，或者直接关掉应用。以前这份
 * "删还是留"的询问放在组件的 state 里：切会话就没了、第二个任务还会把第一个
 * 覆盖掉，重启后更是完全找不到 —— 结果是服务器的暂存目录一直留着。
 *
 * 这里按 `taskId` 一条记录，多个任务互不覆盖；localStorage 持久化，重启后
 * 仍能在「附件」里找到并重试。
 */
import { create } from "zustand";
import { i18n } from "@/i18n";
import { useExtremeStore, type ExtremeAttachment } from "@/stores/extreme-store";
import type { QueuedSend } from "../send-queue";
import { removeStagedAttachment, stagingDir } from "./staging";
import { toAppError } from "@/lib/app-error";

export interface CleanupItem {
  id: string;
  name: string;
  /** 暂存副本的绝对路径（必须是平台目录下的那一份）。 */
  remotePath: string;
  /** 文件夹上传时的相对路径。 */
  path?: string;
}

export interface CleanupRequest {
  taskId: string;
  workspaceId: string;
  serverId: string | null;
  createdAt: number;
  items: CleanupItem[];
  /** 上次删除失败的原因：保留请求与路径，允许重试。 */
  error?: string;
}

const KEY = "bls-ops.extreme-cleanup.v1";

function readRequests(): CleanupRequest[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is CleanupRequest => {
      if (!item || typeof item !== "object") return false;
      const entry = item as Partial<CleanupRequest>;
      return (
        typeof entry.taskId === "string" &&
        typeof entry.workspaceId === "string" &&
        Array.isArray(entry.items)
      );
    });
  } catch {
    return [];
  }
}

function writeRequests(requests: CleanupRequest[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(requests));
  } catch {
    // 存不了只影响重启后能不能找到；当前会话仍可处理。
  }
}

/**
 * 这条附件是否仍被**运行中的任务或排队消息**引用。
 *
 * 清理只能删"没人还会读"的副本：任务在跑时模型可能还在按路径读它；排队消息
 * 的附件快照也指向同一份路径。引用时保留，不是失败。
 */
export function isCleanupBlocked(
  request: Pick<CleanupRequest, "workspaceId">,
  item: Pick<CleanupItem, "id" | "remotePath">,
  sources: {
    tasks: Record<string, { workspaceId?: string | null; status?: string | null }>;
    queuedSends: QueuedSend[];
  },
): boolean {
  const running = Object.values(sources.tasks).some(
    (task) =>
      task.workspaceId === request.workspaceId &&
      (task.status === "running" || task.status === "confirming" || task.status === "waiting"),
  );
  if (running) return true;
  return sources.queuedSends.some(
    (send) =>
      send.workspaceId === request.workspaceId &&
      send.attachments.some(
        (attachment) =>
          attachment.id === item.id ||
          (attachment.remotePath !== undefined && attachment.remotePath === item.remotePath),
      ),
  );
}

/** 只接受平台暂存目录下的路径：线上文件 / 站点备份永远不在清理范围。 */
export function isPlatformStagedPath(
  workspaceId: string,
  item: Pick<CleanupItem, "id" | "remotePath">,
): boolean {
  const dir = `/.bls-ops/staging/${workspaceId}/${item.id}/`;
  // 绝对路径（`/<HOME>/.bls-ops/...`）必须**包含完整的附件目录段**：
  // 只比名字会让 `dist.zip` 命中站点目录里的同名文件。
  return item.remotePath.includes(dir);
}

interface CleanupState {
  requests: CleanupRequest[];
  /** 记录一次新的清理询问（同一个 taskId 只更新，不追加）。 */
  offer: (request: CleanupRequest) => void;
  /** 用户选择保留：移除这条询问（不再打扰）。 */
  dismiss: (taskId: string) => void;
  /** 删除失败：保留请求与路径，写入原因。 */
  fail: (taskId: string, error: string) => void;
  /** 删除成功一部分：把删掉的条目移出请求；全部完成时移除请求。 */
  settle: (taskId: string, removedIds: string[]) => void;
}

export const useCleanupStore = create<CleanupState>((set) => {
  const commit = (requests: CleanupRequest[]) => {
    writeRequests(requests);
    return { requests };
  };
  return {
    requests: readRequests(),
    offer: (request) =>
      set((state) => {
        const exists = state.requests.some((item) => item.taskId === request.taskId);
        const next = exists
          ? state.requests.map((item) =>
              item.taskId === request.taskId ? { ...item, ...request, error: undefined } : item,
            )
          : [...state.requests, request];
        return commit(next);
      }),
    dismiss: (taskId) => set((state) => commit(state.requests.filter((item) => item.taskId !== taskId))),
    fail: (taskId, error) =>
      set((state) =>
        commit(state.requests.map((item) => (item.taskId === taskId ? { ...item, error } : item))),
      ),
    settle: (taskId, removedIds) =>
      set((state) =>
        commit(
          state.requests.flatMap((item) => {
            if (item.taskId !== taskId) return [item];
            const remaining = item.items.filter((entry) => !removedIds.includes(entry.id));
            return remaining.length > 0 ? [{ ...item, items: remaining, error: undefined }] : [];
          }),
        ),
      ),
  };
});

/** 当前对话里等待用户决定的清理请求（按时间从早到晚）。 */
export function pendingCleanupFor(workspaceId: string | null): CleanupRequest | null {
  if (!workspaceId) return null;
  return (
    useCleanupStore
      .getState()
      .requests.filter((item) => item.workspaceId === workspaceId && item.items.length > 0)
      .sort((a, b) => a.createdAt - b.createdAt)[0] ?? null
  );
}

/** 把附件上的暂存路径收敛成"可清理条目"（只取平台副本）。 */
export function cleanupItemsOf(
  workspaceId: string,
  attachments: ExtremeAttachment[],
): CleanupItem[] {
  return attachments
    .filter(
      (item): item is ExtremeAttachment & { stagedPath: string } =>
        Boolean(item.staged && item.stagedPath && !item.stagedCleaned) &&
        isPlatformStagedPath(workspaceId, { id: item.id, remotePath: item.stagedPath! }),
    )
    .map((item) => ({
      id: item.id,
      name: item.name,
      // 删的是暂存副本；`remotePath` 部署后可能已经指向线上文件。
      remotePath: item.stagedPath,
      path: item.path,
    }));
}

export interface CleanupOutcome {
  removed: number;
  blocked: number;
  failures: { name: string; reason: string }[];
  /** 当前服务器连接（没有连接时返回 null，调用方应提示重连）。 */
  sessionId: string | null;
}

/**
 * 执行一条清理请求。
 *
 * - 只删平台创建、且路径对得上的暂存副本；
 * - 被运行任务 / 排队消息引用的保留（`blocked`），不算失败；
 * - 单条失败保留路径与原因，请求留在 store 里可重试。
 */
export async function runCleanup(request: CleanupRequest): Promise<CleanupOutcome> {
  const state = useExtremeStore.getState();
  const sessionId = request.serverId ? state.connections[request.serverId]?.sessionId ?? null : null;
  if (!sessionId) {
    // 断线不是"不用清了"：保留请求与路径，重连后可以重试。
    useCleanupStore
      .getState()
      .fail(request.taskId, i18n.t("服务器未连接：重连后可以重试。"));
    return {
      removed: 0,
      blocked: 0,
      failures: request.items.map((item) => ({
        name: item.name,
        reason: i18n.t("服务器未连接"),
      })),
      sessionId: null,
    };
  }
  const workspace = state.workspaces.find((entry) => entry.id === request.workspaceId);
  const live =
    state.workspaceId === request.workspaceId
      ? state.attachments
      : workspace?.context?.attachments ?? [];
  const byId = new Map(live.map((item) => [item.id, item]));
  const removed: string[] = [];
  const failures: { name: string; reason: string }[] = [];
  let blocked = 0;

  for (const entry of request.items) {
    if (!isPlatformStagedPath(request.workspaceId, entry)) {
      failures.push({
        name: entry.name,
        reason: i18n.t("不是平台暂存路径，未删除"),
      });
      continue;
    }
    if (isCleanupBlocked(request, entry, state)) {
      blocked += 1;
      continue;
    }
    const attachment = byId.get(entry.id);
    if (!attachment) {
      // 附件已被用户移除：副本仍是我们建的，按登记信息继续删。
      try {
        await removeStagedAttachment({
          sessionId,
          workspaceId: request.workspaceId,
          serverId: request.serverId,
          item: {
            id: entry.id,
            name: entry.name,
            size: 0,
            state: "ready",
            stagedPath: entry.remotePath,
            staged: true,
            path: entry.path,
          },
        });
        removed.push(entry.id);
      } catch (cause) {
        failures.push({ name: entry.name, reason: toAppError(cause).message });
      }
      continue;
    }
    try {
      await removeStagedAttachment({
        sessionId,
        workspaceId: request.workspaceId,
        serverId: request.serverId,
        item: attachment,
      });
      removed.push(entry.id);
    } catch (cause) {
      failures.push({ name: entry.name, reason: toAppError(cause).message });
    }
  }

  const store = useCleanupStore.getState();
  if (removed.length > 0) store.settle(request.taskId, removed);
  if (failures.length > 0) {
    store.fail(
      request.taskId,
      failures.map((item) => `${item.name}: ${item.reason}`).join("; "),
    );
  }
  return { removed: removed.length, blocked, failures, sessionId };
}

/** 测试 / 切服务器时清掉过期请求里的无效路径。 */
export function dropStaleCleanup(workspaceId: string, attachmentId: string): void {
  const state = useCleanupStore.getState();
  for (const request of state.requests) {
    if (request.workspaceId !== workspaceId) continue;
    if (!request.items.some((item) => item.id === attachmentId)) continue;
    state.settle(request.taskId, [attachmentId]);
  }
}

/** 兼容上传服务的目录形状（测试用来断言清理范围）。 */
export { stagingDir };
