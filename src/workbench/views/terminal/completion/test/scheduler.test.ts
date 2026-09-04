import { beforeEach, describe, expect, it, vi } from "vitest";

import { CompletionScheduler, DEBOUNCE_MAX_MS, DEBOUNCE_MIN_MS } from "../scheduler";
import type { CompletionContext, CompletionResult } from "../types";

/**
 * 调度器是"补全和输入对不上"的防线：
 * - 防抖：连续输入只发一次请求；
 * - 乱序：晚到的旧响应必须丢弃（否则 `cd opt` 的输入配 `cd o` 的候选）。
 */

function ctx(line: string): CompletionContext {
  return { line, cursor: line.length, sessionId: "s1", cwd: "/root", home: "/root" };
}

function result(items: string[], requestKey: string): CompletionResult {
  return {
    items: items.map((label) => ({
      label,
      insertText: label,
      detail: "",
      icon: "directory",
      type: "directory",
      replaceRange: { start: 0, end: 0 },
      priority: 0,
      source: "remote-directory",
    })),
    requestKey,
  };
}

/** 手动控制的定时器：不依赖真实时间，测试稳定。 */
function manualTimers() {
  const timers = new Map<number, () => void>();
  let nextId = 1;
  return {
    setTimer: (fn: () => void, _ms: number) => {
      const id = nextId++;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (id: number) => {
      timers.delete(id);
    },
    fire: () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const fn of pending) fn();
    },
    pending: () => timers.size,
  };
}

describe("CompletionScheduler", () => {
  let timers: ReturnType<typeof manualTimers>;

  beforeEach(() => {
    timers = manualTimers();
  });

  it("debounces within the required 150–250ms window", () => {
    const scheduler = new CompletionScheduler({
      run: async () => result([], "x"),
      onResult: () => undefined,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    expect(scheduler.debounceMs).toBeGreaterThanOrEqual(DEBOUNCE_MIN_MS);
    expect(scheduler.debounceMs).toBeLessThanOrEqual(DEBOUNCE_MAX_MS);
    scheduler.dispose();
  });

  it("runs only the last request when the user keeps typing", async () => {
    const run = vi.fn(async (target: CompletionContext) => result([target.line], target.line));
    const onResult = vi.fn();
    const scheduler = new CompletionScheduler({
      run,
      onResult,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    scheduler.request(ctx("cd o"));
    scheduler.request(ctx("cd op"));
    scheduler.request(ctx("cd opt"));
    timers.fire();
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(run).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0][0].items[0].label).toBe("cd opt");
    scheduler.dispose();
  });

  it("drops a slow older response that arrives after a newer one", async () => {
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;

    const run = async (): Promise<CompletionResult> => {
      calls += 1;
      // 第一次（慢）请求：等第二次跑完才返回 —— 经典乱序场景。
      if (calls === 1) {
        await firstGate;
        return result(["旧结果"], "stale");
      }
      return result(["新结果"], "fresh");
    };
    const onResult = vi.fn();
    const scheduler = new CompletionScheduler({
      run,
      onResult,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    scheduler.request(ctx("cd o"));
    timers.fire();
    // 第二次输入：会让第一次的响应过期。
    scheduler.request(ctx("cd opt"));
    timers.fire();
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    // 现在放掉那个慢的旧请求：它的结果必须被丢弃。
    releaseFirst();
    await firstGate;
    await Promise.resolve();
    await Promise.resolve();

    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0][0].requestKey).toBe("fresh");
    scheduler.dispose();
  });

  it("cancel() voids in-flight responses so they cannot repopulate a closed panel", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onResult = vi.fn();
    const scheduler = new CompletionScheduler({
      run: async () => {
        await gate;
        return result(["迟到的结果"], "late");
      },
      onResult,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    scheduler.request(ctx("cd o"));
    timers.fire();
    scheduler.cancel(); // 用户按了 Esc / 提交了命令
    release();
    await gate;
    await Promise.resolve();

    expect(onResult).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it("reports provider failures as a notice instead of throwing", async () => {
    const onResult = vi.fn();
    const scheduler = new CompletionScheduler({
      run: async () => {
        throw new Error("连接已断开");
      },
      onResult,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    scheduler.request(ctx("cd o"));
    timers.fire();
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(onResult.mock.calls[0][0].notice).toBe("连接已断开");
    scheduler.dispose();
  });
});
