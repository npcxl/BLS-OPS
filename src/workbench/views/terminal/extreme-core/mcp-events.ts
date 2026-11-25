/**
 * MCP 数据变更广播：MCP 页保存/测试/启停后，输入区的能力菜单要立刻刷新，
 * 而输入区这时可能只是被 `hidden` 挂着（不会重新挂载）。
 */
import { useSyncExternalStore } from "react";

let version = 0;
const listeners = new Set<() => void>();

export function bumpMcpData() {
  version += 1;
  for (const listener of listeners) listener();
}

export function useMcpDataVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
    () => version,
  );
}
