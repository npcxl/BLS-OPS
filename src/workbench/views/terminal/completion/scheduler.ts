/**
 * 补全调度器 —— **防抖 + 丢弃过期响应**，与 React 无关（可单测）。
 *
 * 两个必须解决的问题：
 *
 * 1. **防抖**：远程目录 / Docker 列表都是 SSH 往返，用户每敲一个字符就发一
 *    次请求会拖垮连接。默认 180ms（规格要求 150～250ms）。
 * 2. **乱序**：`cd o` → `cd op` → `cd opt` 三次请求，服务器可能先回第三次。
 *    晚到的旧响应**必须丢弃** —— 否则用户看到的是 `o` 的候选，而输入框里
 *    已经是 `opt`（典型"补全和输入对不上"）。
 *
 * 判据是单调递增的请求序号：响应回来时序号已经不是最新的 → 直接丢。
 */

import type { CompletionContext, CompletionResult } from "./types";

/** 规格要求的防抖区间（ms）。 */
export const DEBOUNCE_MIN_MS = 150;
export const DEBOUNCE_MAX_MS = 250;
export const DEFAULT_DEBOUNCE_MS = 180;

export interface CompletionSchedulerOptions {
  run: (ctx: CompletionContext) => Promise<CompletionResult>;
  onResult: (result: CompletionResult, ctx: CompletionContext) => void;
  debounceMs?: number;
  /** 自定义定时器（测试用）。 */
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

export class CompletionScheduler {
  private seq = 0;
  private timer: number | null = null;
  private pending: CompletionContext | null = null;
  private disposed = false;

  constructor(private readonly options: CompletionSchedulerOptions) {}

  get debounceMs(): number {
    const value = this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    return Math.min(Math.max(value, DEBOUNCE_MIN_MS), DEBOUNCE_MAX_MS);
  }

  /** 请求一次补全（重复调用会取消上一次未发出的请求）。 */
  request(ctx: CompletionContext): void {
    if (this.disposed) return;
    this.pending = ctx;
    this.clear();
    const seq = (this.seq += 1);
    const fire = () => {
      this.timer = null;
      const target = this.pending;
      if (!target) return;
      void this.dispatch(seq, target);
    };
    if (this.options.setTimer) {
      this.timer = this.options.setTimer(fire, this.debounceMs);
    } else {
      this.timer = window.setTimeout(fire, this.debounceMs);
    }
  }

  /** 取消待发请求，并作废在途响应（关闭面板 / 提交命令时调用）。 */
  cancel(): void {
    this.seq += 1;
    this.pending = null;
    this.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private clear(): void {
    if (this.timer === null) return;
    if (this.options.clearTimer) this.options.clearTimer(this.timer);
    else window.clearTimeout(this.timer);
    this.timer = null;
  }

  private async dispatch(seq: number, ctx: CompletionContext): Promise<void> {
    let result: CompletionResult;
    try {
      result = await this.options.run(ctx);
    } catch (cause) {
      result = {
        items: [],
        notice: cause instanceof Error ? cause.message : String(cause),
        requestKey: "error",
      };
    }
    // 过期响应：期间又有新请求（或已被取消）→ 丢弃，绝不覆盖新结果。
    if (this.disposed || seq !== this.seq) return;
    this.options.onResult(result, ctx);
  }
}
