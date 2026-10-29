/**
 * 未提交修改的撤销/重做历史。
 *
 * 只覆盖**待提交队列**（`Pending[]`），不碰数据库：提交成功后队列被清空，
 * 历史也一起重置。把快照保存在 reducer 里（而不是 ref），是为了在
 * StrictMode 双执行下也不会重复入栈。
 */

export interface HistoryState<T> {
  present: T;
  past: T[];
  future: T[];
}

export const DEFAULT_HISTORY_LIMIT = 50;

export function createHistory<T>(present: T): HistoryState<T> {
  return { present, past: [], future: [] };
}

/** 推入一个新快照；引用没变时不产生历史（避免无意义的撤销点）。 */
export function commitHistory<T>(
  state: HistoryState<T>,
  next: T,
  limit: number = DEFAULT_HISTORY_LIMIT,
): HistoryState<T> {
  if (next === state.present) return state;
  const past = [...state.past, state.present];
  while (past.length > limit) past.shift();
  return { present: next, past, future: [] };
}

export function undoHistory<T>(state: HistoryState<T>): HistoryState<T> {
  if (state.past.length === 0) return state;
  const past = [...state.past];
  const present = past.pop() as T;
  return { present, past, future: [state.present, ...state.future] };
}

export function redoHistory<T>(state: HistoryState<T>): HistoryState<T> {
  if (state.future.length === 0) return state;
  const [present, ...future] = state.future;
  return { present, past: [...state.past, state.present], future };
}

/** 提交/放弃后重置：历史不能跨过一次真正的数据库写入。 */
export function resetHistory<T>(state: HistoryState<T>, present: T): HistoryState<T> {
  if (state.present === present && state.past.length === 0 && state.future.length === 0) {
    return state;
  }
  return createHistory(present);
}

export function canUndo<T>(state: HistoryState<T>): boolean {
  return state.past.length > 0;
}

export function canRedo<T>(state: HistoryState<T>): boolean {
  return state.future.length > 0;
}
