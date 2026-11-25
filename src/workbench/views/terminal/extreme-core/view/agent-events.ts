/**
 * 订阅 `AGENT_EVENT`，并保证**卸载后绝不会再有回调进来**。
 *
 * 这里曾经有个只会在大压力下暴露的泄漏：
 *
 * ```ts
 * let unlisten;
 * void listen(EVENT, cb).then((fn) => { unlisten = fn; });
 * return () => unlisten?.();          // ← 注册还没完成时，这里是 undefined
 * ```
 *
 * 注册是异步的。如果组件在 `listen()` 返回之前就卸载（切会话、切语言、
 * 严格模式下的一次性卸载都可能），cleanup 什么也没做；随后注册完成，监听
 * 就永久留在了事件总线上。重挂载再注册一条 —— 同一个增量被处理两次，
 * 正文就出现「按按方案方案」这种按字/按词重复。
 *
 * 修法：卸载时先置 `disposed`，注册完成后如果已经失效就**立刻注销**；
 * 回调也会检查这个标记，避免"刚卸载、回调还在队列里"的那一次。
 */
import { listen } from "@tauri-apps/api/event";
import { AGENT_EVENT } from "@/lib/events";
import type { AgentEvent } from "@/api/types/agent";

type ListenFn = (
  channel: string,
  handler: (event: { payload: AgentEvent }) => void,
) => Promise<() => void>;

/** 返回 detach；调用后不会再触发 `onEvent`，也不会遗留监听。 */
export function attachAgentEvents(
  onEvent: (payload: AgentEvent) => void,
  listenFn: ListenFn = listen as unknown as ListenFn,
): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;

  const promise = listenFn(AGENT_EVENT, (event) => {
    if (disposed) return;
    onEvent(event.payload);
  });

  void promise
    .then((fn) => {
      if (disposed) {
        // 订阅在卸载之后才注册成功：立刻注销，别让它活下来。
        fn();
        return;
      }
      unlisten = fn;
    })
    .catch(() => undefined);

  return () => {
    disposed = true;
    unlisten?.();
    unlisten = undefined;
  };
}
