/**
 * 对话正文的数据库读写。
 *
 * localStorage 只保留为启动兜底与旧版本迁移来源；数据库（SQLite
 * `extreme_workspaces`）才是长期保存的位置。后端只存整份 JSON，字段演进
 * 不需要每次迁移表结构。
 */
import { opsApi } from "@/api/ops-api";
import type { ExtremeWorkspace } from "./workspace-history";

/** 读取全部对话；返回 `null` = 后端不可用（非 Tauri / 调用失败），保留本地兜底。 */
export async function loadWorkspacesFromDb(): Promise<ExtremeWorkspace[] | null> {
  try {
    const rows = await opsApi.extremeWorkspaceList();
    if (!Array.isArray(rows)) return null;
    return rows.filter(
      (row) =>
        Boolean(row) &&
        typeof row === "object" &&
        typeof (row as { id?: unknown }).id === "string" &&
        Array.isArray((row as { messages?: unknown }).messages),
    ) as unknown as ExtremeWorkspace[];
  } catch {
    return null;
  }
}

/** 覆盖写入全部对话；失败时保留 localStorage，不阻断当前会话。 */
export async function saveWorkspacesToDb(entries: ExtremeWorkspace[]): Promise<boolean> {
  try {
    /*
     * 只存可恢复的持久字段：`context` 是当前镜像（计划 / executing 等运行时
     * 状态），存下来会在重启后把"执行中"错误地恢复；消息里的 `tools` 也不进
     * 历史，和 localStorage 的格式保持一致。
     */
    const payload = entries.map((entry) => {
      const { context: _context, ...rest } = entry;
      return {
        ...rest,
        messages: entry.messages
          // 只要还有正文或有序片段就保留（纯工具轮次也有顺序信息）。
          .filter((message) => message.text || message.parts?.length)
          .map(({ tools: _tools, ...message }) => message),
      };
    });
    await opsApi.extremeWorkspaceSync(payload as unknown as Record<string, unknown>[]);
    return true;
  } catch {
    return false;
  }
}
