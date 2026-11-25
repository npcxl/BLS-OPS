/**
 * 传输任务中心的**唯一**前端状态源。
 *
 * 为什么不是每个面板各拉一份：
 * - 面板可以随时关掉，任务在后端继续跑；再打开时要能立刻看到真实进度。
 * - 进度事件、列表快照、操作回执三条通道会**乱序**到达（点开面板的瞬间最
 *   明显：列表请求还没回来，进度事件已经到了）。这里按
 *   `(taskId, attempt, revision)` 合并：旧快照不覆盖新事件、旧事件不改回
 *   终态；重试（attempt +1）则允许从 0 重新开始。
 *
 * 读法：
 * - `useTransferStore(state => state.tasks)` —— 引用稳定，只在有变化时换新对象；
 * - 过滤 / 排序 / 速度展示在组件里用 `useMemo` 派生，避免选择器每次返回新数组。
 */
import { useEffect } from "react";
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { opsApi, TRANSFER_EVENT, type TransferTask, type TransferState } from "@/api/ops-api";

/** 面板默认只看当前服务器；切到全部时才把别的服务器也列出来。 */
export type TransferScope = "session" | "all";


/** 实时速度的采样点：来自相邻两条进度事件。 */
export interface TransferSample {
  bytes: number;
  at: number;
  /** 平滑后的字节/秒；0 表示暂时算不出来（刚开始或停住了）。 */
  speed: number;
}

interface TransferStoreState {
  tasks: Record<string, TransferTask>;
  samples: Record<string, TransferSample>;
  /** 正在提交的操作（任务 id，清理用 `clear`）：按钮据此禁用，防重复提交。 */
  pending: Record<string, true>;
  /** 本地已请求取消、后端回执还没到：立刻显示「正在取消」。 */
  cancelRequested: Record<string, true>;
  /** 单项操作失败：挂在对应行下面，不进全局 toast。 */
  actionErrors: Record<string, unknown>;
  /** 至少成功拿到过一次全量快照。 */
  loaded: boolean;
  loading: boolean;
  /** 全量快照加载失败；已显示的任务**不清空**。 */
  error: unknown | null;

  /** 合并一条后端推送（进度 / 状态 / 操作回执）。 */
  applyRemote: (task: TransferTask) => void;
  /** 拉全量快照并与本地合并。失败时保留已有任务。 */
  refresh: () => Promise<void>;
  cancel: (id: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
  clearFinished: () => Promise<void>;
  dismissError: () => void;
}

export const TERMINAL_STATES: TransferState[] = [
  "completed",
  "failed",
  "cancelled",
  "skipped",
];

export function isActiveState(state: TransferState): boolean {
  return (
    state === "queued" ||
    state === "running" ||
    state === "finalizing" ||
    state === "cancelling"
  );
}

/** 只有失败 / 取消的任务值得再传一次（成功与跳过没有"重试"语义）。 */
export function isRetryableState(state: TransferState): boolean {
  return state === "failed" || state === "cancelled";
}

/** 补齐历史载荷缺失的字段，避免 `undefined` 参与比较。 */
export function normalizeTask(task: TransferTask): TransferTask {
  return {
    ...task,
    size_known: task.size_known ?? task.total > 0,
    batch_id: task.batch_id ?? task.id,
    attempt: task.attempt ?? 0,
    revision: task.revision ?? 0,
  };
}

/**
 * 合并规则（纯函数，可单测）。
 *
 * 1. `revision` 是同一任务内单调递增的写序号 —— 比它旧的来源一律丢弃。
 *    这正是"列表请求先发、响应后到"时进度的防倒退闸门。
 * 2. `attempt` 变大 = 重试开始，整条替换（可以从 0 开始）。
 * 3. 同一轮尝试内**终态不可回退**，字节数只增不减。
 */
export function mergeTask(
  current: TransferTask | undefined,
  incoming: TransferTask,
): TransferTask {
  const next = normalizeTask(incoming);
  if (!current) return next;
  if (next.revision < current.revision) return current;
  if (next.revision === current.revision) return current;
  if (next.attempt < current.attempt) return current;
  if (next.attempt > current.attempt) return next;
  if (TERMINAL_STATES.includes(current.state) && !TERMINAL_STATES.includes(next.state)) {
    return current;
  }
  return { ...next, transferred: Math.max(current.transferred, next.transferred) };
}

/** 速度采样：同一次尝试内按相邻两点的差值算，指数平滑一下。 */
function nextSample(
  previous: TransferTask | undefined,
  next: TransferTask,
  existing: TransferSample | undefined,
  now: number,
): TransferSample | undefined {
  if (!isActiveState(next.state)) return undefined;
  if (!existing || !previous || previous.attempt !== next.attempt) {
    return { bytes: next.transferred, at: now, speed: 0 };
  }
  const elapsed = (now - existing.at) / 1000;
  if (elapsed <= 0) return existing;
  const delta = next.transferred - existing.bytes;
  if (delta <= 0) {
    // 没有新字节（比如正在关闭句柄）：速度往下掉，不要停在一个虚假的高值上。
    return { bytes: next.transferred, at: now, speed: existing.speed * 0.5 };
  }
  const instant = delta / elapsed;
  return {
    bytes: next.transferred,
    at: now,
    speed: existing.speed > 0 ? existing.speed * 0.6 + instant * 0.4 : instant,
  };
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/** 事件监听只注册一次（整个应用共用一个 `transfer-progress` 通道）。 */
let listenerPromise: Promise<void> | null = null;

export const useTransferStore = create<TransferStoreState>()((set, get) => ({
  tasks: {},
  samples: {},
  pending: {},
  cancelRequested: {},
  actionErrors: {},
  loaded: false,
  loading: false,
  error: null,

  applyRemote: (task) => {
    set((state) => {
      const current = state.tasks[task.id];
      const merged = mergeTask(current, task);
      // 被丢弃的旧事件不触发任何渲染。
      if (merged === current) return state;

      const sample = nextSample(current, merged, state.samples[task.id], Date.now());
      const samples = sample
        ? { ...state.samples, [merged.id]: sample }
        : without(state.samples, merged.id);
      // 后端已经确认取消（cancelling）或给出终态：本地标记可以撤了。
      const acknowledged =
        merged.state === "cancelling" || TERMINAL_STATES.includes(merged.state);
      return {
        tasks: { ...state.tasks, [merged.id]: merged },
        samples,
        cancelRequested: acknowledged
          ? without(state.cancelRequested, merged.id)
          : state.cancelRequested,
      };
    });
  },

  refresh: async () => {
    if (get().loading) return;
    const startedAt = Date.now();
    set({ loading: true });
    try {
      const snapshot = await opsApi.transferList();
      set((state) => {
        const now = Date.now();
        const tasks = { ...state.tasks };
        const samples = { ...state.samples };
        const ids = new Set<string>();
        for (const raw of snapshot) {
          const current = tasks[raw.id];
          const merged = mergeTask(current, raw);
          tasks[raw.id] = merged;
          ids.add(raw.id);
          if (merged === current) continue;
          const sample = nextSample(current, merged, samples[raw.id], now);
          if (sample) samples[raw.id] = sample;
          else delete samples[raw.id];
        }
        for (const [id, task] of Object.entries(tasks)) {
          // 快照里没有 = 已被清理。请求期间新入队的任务（created_at 更晚）
          // 只是赶在快照之后，必须留下。
          if (!ids.has(id) && task.created_at < startedAt) delete tasks[id];
        }
        for (const id of Object.keys(samples)) {
          if (!tasks[id]) delete samples[id];
        }
        return { tasks, samples, loaded: true, loading: false, error: null };
      });
    } catch (cause) {
      set({ loading: false, error: cause });
    }
  },

  cancel: async (id) => {
    if (get().pending[id]) return;
    set((state) => ({
      pending: { ...state.pending, [id]: true },
      actionErrors: without(state.actionErrors, id),
      // 点击即显示「正在取消」：不等 IPC 往返。
      cancelRequested: { ...state.cancelRequested, [id]: true },
    }));
    try {
      get().applyRemote(await opsApi.transferCancel(id));
    } catch (cause) {
      set((state) => ({
        actionErrors: { ...state.actionErrors, [id]: cause },
        cancelRequested: without(state.cancelRequested, id),
      }));
    } finally {
      set((state) => ({ pending: without(state.pending, id) }));
    }
  },

  retry: async (id) => {
    if (get().pending[id]) return;
    set((state) => ({
      pending: { ...state.pending, [id]: true },
      actionErrors: without(state.actionErrors, id),
      cancelRequested: without(state.cancelRequested, id),
    }));
    try {
      get().applyRemote(await opsApi.transferRetry(id));
    } catch (cause) {
      set((state) => ({ actionErrors: { ...state.actionErrors, [id]: cause } }));
    } finally {
      set((state) => ({ pending: without(state.pending, id) }));
    }
  },

  clearFinished: async () => {
    if (get().pending.clear) return;
    set((state) => ({ pending: { ...state.pending, clear: true } }));
    try {
      await opsApi.transferClearFinished();
      await get().refresh();
      set({ error: null });
    } catch (cause) {
      set({ error: cause });
    } finally {
      set((state) => ({ pending: without(state.pending, "clear") }));
    }
  },

  dismissError: () => set({ error: null }),
}));

/**
 * 注册全局事件监听（幂等）。
 *
 * 监听器只注册一次、活到应用结束：传输在后端继续跑，界面不该因为面板
 * 关掉就漏掉进度真相 —— 重新打开时还会用全量快照再校对一次。
 */
export function ensureTransferListening(): Promise<void> {
  if (listenerPromise) return listenerPromise;
  listenerPromise = listen<TransferTask>(TRANSFER_EVENT, (event) => {
    const payload = event.payload;
    if (!payload || typeof payload.id !== "string") return;
    useTransferStore.getState().applyRemote(payload);
  })
    .then(() => undefined)
    .catch(() => {
      // 注册失败（非 Tauri 环境 / 通道异常）：允许下次再试。
      listenerPromise = null;
    });
  return listenerPromise;
}

/** 注册监听 + 拉一次快照（幂等，工具栏入口与面板都可以调用）。 */
export function useTransferSync() {
  const refresh = useTransferStore((state) => state.refresh);
  useEffect(() => {
    void ensureTransferListening();
    void refresh();
  }, [refresh]);
}

/** 当前会话里还没结束的任务数（工具栏角标用）。 */
export function activeCountFor(tasks: Record<string, TransferTask>, sessionId: string): number {
  let count = 0;
  for (const task of Object.values(tasks)) {
    if (task.session_id === sessionId && isActiveState(task.state)) count += 1;
  }
  return count;
}

/** 当前会话的活动摘要：「2 · 46%」。没有可汇总的字节时只有数量。 */
export function activityLabel(tasks: Record<string, TransferTask>, sessionId: string): string {
  let count = 0;
  let transferred = 0;
  let total = 0;
  for (const task of Object.values(tasks)) {
    if (task.session_id !== sessionId || !isActiveState(task.state)) continue;
    count += 1;
    if (!task.size_known) continue;
    transferred += task.transferred;
    total += task.total;
  }
  if (count === 0) return "";
  if (total <= 0) return String(count);
  return `${count} · ${Math.min(100, Math.round((transferred / total) * 100))}%`;
}
