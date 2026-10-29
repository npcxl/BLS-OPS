/**
 * 选择状态的极简外部 store。
 *
 * 为什么不用 `useState`：选择在拖动时每帧都变。如果它落在网格组件的 state 里，
 * 整个网格（可见行 × 可见列）都要重新 diff；放在这里以后，只有订阅者
 * （`SelectionOverlay`）重渲染，行内容引用不变 → 不重渲染。
 *
 * 只依赖 `useSyncExternalStore`，没有引入状态库。
 */
import { useSyncExternalStore } from "react";
import {
  EMPTY_SELECTION,
  clampSelection,
  isSelectionEmpty,
  type GridBounds,
  type SelectionState,
} from "./selection";

export interface SelectionStore {
  getBounds(): GridBounds;
  /** 数据规模变化（翻页、结果集切换）：夹回范围，必要时清空。 */
  setBounds(bounds: GridBounds): void;
  getSnapshot(): SelectionState;
  subscribe(listener: () => void): () => void;
  /** 整体替换（来自选择模型的纯函数）。 */
  set(next: SelectionState): void;
  /** 用当前状态和范围计算下一个状态。 */
  update(resolve: (state: SelectionState, bounds: GridBounds) => SelectionState): SelectionState;
  reset(): void;
  isEmpty(): boolean;
}

export function createSelectionStore(initialBounds: GridBounds = { rows: 0, cols: 0 }): SelectionStore {
  let bounds: GridBounds = initialBounds;
  let state: SelectionState = EMPTY_SELECTION;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const set = (next: SelectionState) => {
    if (next === state) return;
    state = next;
    notify();
  };

  return {
    getBounds: () => bounds,
    setBounds(next) {
      bounds = next;
      const clamped = clampSelection(state, next);
      if (clamped !== state) set(clamped);
    },
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set,
    update(resolve) {
      const next = resolve(state, bounds);
      set(next);
      return next;
    },
    reset() {
      set(EMPTY_SELECTION);
    },
    isEmpty: () => isSelectionEmpty(state),
  };
}

/** 订阅选择状态；只有选择变化时重渲染。 */
export function useSelectionSnapshot(store: SelectionStore): SelectionState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
