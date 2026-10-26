/**
 * 远程工具存在性探测的**会话代次缓存**。
 *
 * # 为什么按"代次"而不是只按 sessionId
 *
 * `sessionId` 在重连时**不会变**（tab 复用同一个 id）。只按它缓存的话，
 * 用户装好 docker 再重连，缓存仍会回答"未安装"，命令继续被置灰。
 * 所以 key 是 `sessionId@epoch`，`epoch` 由 `useCommandSession` 在每次
 * 发起连接时 +1。
 *
 * # 规则
 *
 * - **三态**：`installed` / `missing` / `unknown`。请求失败时**不写缓存**
 *   （保持 unknown），绝不把"连接失败"当成"未安装"；
 * - **只探未知项**：已经确定的工具不再重复探测；
 * - **同代次串行合并**：并发调用排在同一条链上，后一个执行时前一个已写好
 *   缓存，因此不会重复探测同一批工具；
 * - **旧代次的在途响应写不进新代次**：它们的 key 不同。
 */

import { opsApi } from "@/api/ops-api";

export type ToolState = "installed" | "missing" | "unknown";

/** `sessionId@epoch` -> (tool -> state)。 */
const cache = new Map<string, Map<string, ToolState>>();

/** `sessionId@epoch` -> 该代次上最后一次探测链（用于串行合并）。 */
const chains = new Map<string, Promise<Map<string, ToolState>>>();

const keyOf = (sessionId: string, epoch: number) => `${sessionId}@${epoch}`;

function ledger(key: string): Map<string, ToolState> {
  const existing = cache.get(key);
  if (existing) return existing;
  const created = new Map<string, ToolState>();
  cache.set(key, created);
  return created;
}

/**
 * 确保这些工具在当前**连接代次**上的存在性已知。
 *
 * 不会 reject：探测失败时返回已有状态（缺的仍是 unknown），
 * 由调用方按"未知"处理，而不是按"未安装"处理。
 */
export function ensureToolsProbed(
  sessionId: string,
  epoch: number,
  tools: readonly string[],
): Promise<Map<string, ToolState>> {
  const key = keyOf(sessionId, epoch);
  const previous = chains.get(key) ?? Promise.resolve(ledger(key));
  const next = previous
    .then(async () => {
      // 代次可能在等待期间又变了：此时不要再用旧代次的结论。
      const known = ledger(key);
      const unknown = [...new Set(tools)].filter((tool) => !known.has(tool));
      if (unknown.length === 0) return known;
      const installed = await opsApi.commandProbeTools(sessionId, unknown);
      for (const tool of unknown) {
        known.set(tool, installed.includes(tool) ? "installed" : "missing");
      }
      return known;
    })
    .catch(() => {
      // 失败：不写缓存（下一次会重试），也不把缺的标成 missing。
      return ledger(key);
    });
  chains.set(key, next);
  return next;
}

/** 手动刷新 / 重连时清掉一个会话**所有代次**的探测结果。 */
export function forgetSessionTools(sessionId: string): void {
  const prefix = `${sessionId}@`;
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
  for (const key of Array.from(chains.keys())) {
    if (key.startsWith(prefix)) chains.delete(key);
  }
}
