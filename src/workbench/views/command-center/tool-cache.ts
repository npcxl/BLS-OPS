/**
 * 远程工具存在性探测的**会话级缓存**。
 *
 * # 为什么需要它
 *
 * 命令中心每次"命中项需要的工具集合"变化都会重新探测整组工具。用户改一个
 * 关键词，可能从 `[docker, nginx]` 变成 `[docker, nginx, systemctl]` ——
 * 于是整组重探。而旧请求只是**丢弃结果**，远程的 `command -v` 仍在跑。
 *
 * # 规则
 *
 * - **三态**：`installed` / `missing` / `unknown`。请求失败时**不写缓存**
 *   （保持 unknown），绝不把"连接失败"当成"未安装"；
 * - **只探未知项**：已经确定的工具不再重复探测；
 * - **同会话串行合并**：并发的调用排在同一条链上，后一个执行时前一个已把
 *   结果写进缓存，因此不会重复探测同一批工具；
 * - **失效**：缓存按 `sessionId` 分开，重连换新 sessionId 即天然失效；
 *   手动刷新可调 [`forgetSessionTools`]。
 */

import { opsApi } from "@/api/ops-api";

export type ToolState = "installed" | "missing" | "unknown";

/** sessionId -> (tool -> state)。 */
const cache = new Map<string, Map<string, ToolState>>();

/** sessionId -> 该会话上最后一次探测链（用于串行合并）。 */
const chains = new Map<string, Promise<Map<string, ToolState>>>();

function ledger(sessionId: string): Map<string, ToolState> {
  const existing = cache.get(sessionId);
  if (existing) return existing;
  const created = new Map<string, ToolState>();
  cache.set(sessionId, created);
  return created;
}

/**
 * 确保这些工具的存在性已知，返回该会话的完整状态表。
 *
 * 不会 reject：探测失败时返回**已有**状态（缺的仍是 unknown），
 * 由调用方按"未知"处理，而不是按"未安装"处理。
 */
export function ensureToolsProbed(
  sessionId: string,
  tools: readonly string[],
): Promise<Map<string, ToolState>> {
  const previous = chains.get(sessionId) ?? Promise.resolve(ledger(sessionId));
  const next = previous
    .then(async () => {
      const known = ledger(sessionId);
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
      return ledger(sessionId);
    });
  chains.set(sessionId, next);
  return next;
}

/** 手动刷新 / 重连时清掉一个会话的探测结果。 */
export function forgetSessionTools(sessionId: string): void {
  cache.delete(sessionId);
  chains.delete(sessionId);
}
