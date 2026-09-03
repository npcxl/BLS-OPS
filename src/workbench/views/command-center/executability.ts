import type { CommandSearchHit } from "@/api/ops-api";

/**
 * 执行可行性判定：把"能否检索"与"能否执行"彻底分开。
 *
 * 知识库是本地编目，检索永远可用；服务器连接与工具是否安装只影响执行。
 * 四种状态：
 *
 * - 可检索 + 未连接 → 暂不可执行
 * - 可检索 + 已连接 + 已安装 → 可执行
 * - 可检索 + 已连接 + 未安装 → 不可执行（说明缺什么）
 * - 仅知识展示（`can_execute=false`）→ 永不执行
 */
export type Executability = { ok: true } | { ok: false; reason: string };

export function executability(
  hit: CommandSearchHit,
  connected: boolean,
  /** `null` = 探测失败/未完成，此时不拦截（后端仍有硬校验兜底）。 */
  installedTools: Set<string> | null,
): Executability {
  if (!hit.can_execute) {
    return { ok: false, reason: "仅知识展示" };
  }
  if (!connected) {
    return { ok: false, reason: "未连接服务器" };
  }
  if (installedTools !== null) {
    const missing = hit.requires.filter((tool) => !installedTools.has(tool));
    if (missing.length > 0) {
      return { ok: false, reason: `服务器未安装 ${missing.join("、")}` };
    }
  }
  return { ok: true };
}
