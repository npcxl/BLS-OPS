import { expect, it, vi } from "vitest";
import type { AgentEvent } from "@/api/types/agent";
import { attachAgentEvents } from "../view/agent-events";

/**
 * 异步监听的清理：`listen()` 还没返回就卸载，也必须把它注销掉。
 *
 * 这条漏洞会让监听器越积越多 —— 同一个正文增量被处理两次，界面出现
 * 「按按方案方案」。
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

it("unregisters a listener that finished registering after unmount", async () => {
  const gate = deferred<() => void>();
  const unlisten = vi.fn();
  const onEvent = vi.fn();

  const detach = attachAgentEvents(onEvent, () => gate.promise);
  // 注册还没完成就卸载（切会话 / 切语言 / 严格模式都会这样）。
  detach();
  gate.resolve(unlisten);
  await flush();

  expect(unlisten).toHaveBeenCalledTimes(1);
  expect(onEvent).not.toHaveBeenCalled();
});

it("delivers each event once and stops after detach", async () => {
  const unlisten = vi.fn();
  let handler: ((event: { payload: AgentEvent }) => void) | undefined;
  const onEvent = vi.fn();

  const detach = attachAgentEvents(onEvent, async (_channel, next) => {
    handler = next;
    return unlisten;
  });
  await flush();
  expect(handler).toBeTruthy();

  const event = { payload: { taskId: "t1", kind: "delta", content: "按" } } as unknown as {
    payload: AgentEvent;
  };
  handler!(event);
  handler!(event);
  expect(onEvent).toHaveBeenCalledTimes(2);

  detach();
  handler!(event);
  expect(onEvent).toHaveBeenCalledTimes(2);
  expect(unlisten).toHaveBeenCalledTimes(1);
});
