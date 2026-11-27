/**
 * MCP 数据变更广播：MCP 页保存/测试/启停后，输入区的能力菜单要立刻刷新，
 * 而输入区这时可能只是被 `hidden` 挂着（不会重新挂载）。
 */
import { useSyncExternalStore } from "react";
import { opsApi } from "@/api/ops-api";
import type { McpTestResult } from "@/api/types/mcp";

let version = 0;
const listeners = new Set<() => void>();
let healthVersion = 0;
const healthListeners = new Set<() => void>();
const checks = new Map<string, Promise<McpTestResult>>();

/** Share an in-flight check between the marketplace and the conversation. */
export function checkMcpServer(id: string): Promise<McpTestResult> {
  const existing = checks.get(id);
  if (existing) return existing;
  const request = opsApi.mcpServerTest(id).finally(() => {
    checks.delete(id);
  });
  checks.set(id, request);
  return request;
}

export function bumpMcpHealth() {
  healthVersion += 1;
  for (const listener of healthListeners) listener();
  bumpMcpData();
}

export function useMcpHealthVersion(): number {
  return useSyncExternalStore(
    (listener) => { healthListeners.add(listener); return () => healthListeners.delete(listener); },
    () => healthVersion,
    () => healthVersion,
  );
}

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
