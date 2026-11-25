/**
 * MCP 工具暴露名：必须与后端 `crate::mcp::bindings_for` 完全一致。
 *
 * 规则：`mcp__<serverId>__<tool>`，非字母数字 / `_` / `-` 的字符换成 `_`；
 * 同名冲突时追加 `_2` / `_3`。前端只把**启用工具**的名字随任务带给后端。
 */
import type { McpServerView } from "@/api/types/mcp";

function sanitize(value: string): string {
  const out = Array.from(value)
    .map((ch) => (/[A-Za-z0-9_-]/.test(ch) ? ch : "_"))
    .join("");
  return out || "tool";
}

/** 与后端 `bindings_for` 同一遍历顺序：启用服务 → 启用工具。 */
export function enabledMcpToolNames(
  servers: McpServerView[],
  onlyServerIds?: Set<string>,
): string[] {
  const used = new Set<string>();
  const out: string[] = [];
  // 运行时防御：旧 mock / IPC 未配置时可能拿到 undefined。
  const list = Array.isArray(servers) ? servers : [];
  for (const server of list) {
    if (!server.enabled || server.status !== "connected") continue;
    for (const tool of server.tools) {
      if (!tool.enabled) continue;
      const base = `mcp__${sanitize(server.id)}__${sanitize(tool.name)}`;
      let exposed = base;
      let index = 2;
      while (used.has(exposed)) {
        exposed = `${base}_${index}`;
        index += 1;
      }
      used.add(exposed);
      // 冲突编号必须按**全部**启用工具算；只收集被选中连接的名字。
      if (!onlyServerIds || onlyServerIds.has(server.id)) out.push(exposed);
    }
  }
  return out;
}
