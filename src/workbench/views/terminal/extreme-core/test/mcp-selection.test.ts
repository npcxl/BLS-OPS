import { describe, expect, it } from "vitest";
import type { McpServerView } from "@/api/types/mcp";
import {
  bindingMatches,
  selectionForScope,
} from "../view/use-mcp-capabilities";
import { mcpSessionKey } from "@/stores/extreme-mcp-selection";

function server(overrides: Partial<McpServerView> = {}): McpServerView {
  return {
    id: "a",
    name: "Grafana · 生产",
    binding: { scope: "server", serverId: "A" },
    defaultEnabled: true,
    transport: "http",
    command: "",
    args: [],
    env: [],
    url: "https://example/mcp",
    headers: [],
    enabled: true,
    status: "connected",
    tools: [
      {
        name: "read",
        description: "read",
        inputSchema: { type: "object" },
        readOnly: true,
        enabled: true,
      },
    ],
    resources: [],
    prompts: [],
    updatedAt: 1,
    ...overrides,
  };
}

describe("MCP 新任务默认勾选", () => {
  it("服务器绑定的默认勾选在首条消息就生效，不依赖当前渲染的 workspace", () => {
    const result = selectionForScope({
      workspaceId: "task-2",
      serverId: "A",
      servers: [server()],
      bySession: {},
      probe: null,
      connected: true,
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.tools).toEqual(["mcp__a__read"]);
  });

  it("任务 2 取消勾选不影响任务 1，全局连接在其他服务器仍生效", () => {
    const key2 = mcpSessionKey("task-2", "A");
    const result = selectionForScope({
      workspaceId: "task-2",
      serverId: "A",
      servers: [server()],
      bySession: { [key2]: { "mcp:a": false } },
      probe: null,
      connected: true,
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.tools).toEqual([]);

    const task1 = selectionForScope({
      workspaceId: "task-1",
      serverId: "A",
      servers: [server()],
      bySession: { [key2]: { "mcp:a": false } },
      probe: null,
      connected: true,
    });
    expect(task1.status).toBe("ready");
    if (task1.status !== "ready") return;
    expect(task1.tools).toEqual(["mcp__a__read"]);

    const otherServer = selectionForScope({
      workspaceId: "task-b",
      serverId: "B",
      servers: [server()],
      bySession: {},
      probe: null,
      connected: true,
    });
    expect(otherServer.status).toBe("ready");
    if (otherServer.status !== "ready") return;
    expect(otherServer.tools).toEqual(["mcp__a__read"]);
  });

  it("旧版按任务 / 服务器绑定的连接也按全局生效", () => {
    const oldTask = server({
      binding: { scope: "workspace", workspaceId: "task-1" },
    });
    expect(bindingMatches(oldTask, "A", "task-2")).toBe(true);
    expect(bindingMatches(oldTask, "A", "task-1")).toBe(true);

    const oldServer = server({ binding: { scope: "server", serverId: "A" } });
    const result = selectionForScope({
      workspaceId: "task-b",
      serverId: "B",
      servers: [oldServer],
      bySession: {},
      probe: null,
      connected: true,
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.tools).toEqual(["mcp__a__read"]);
  });

  it("默认勾选关闭时只有显式选择才进入请求", () => {
    const off = server({ defaultEnabled: false });
    const key = mcpSessionKey("task-1", "A");
    const automatic = selectionForScope({
      workspaceId: "task-1",
      serverId: "A",
      servers: [off],
      bySession: {},
      probe: null,
      connected: true,
    });
    if (automatic.status !== "ready") return;
    expect(automatic.tools).toEqual([]);

    const explicit = selectionForScope({
      workspaceId: "task-1",
      serverId: "A",
      servers: [off],
      bySession: { [key]: { "mcp:a": true } },
      probe: null,
      connected: true,
    });
    if (explicit.status !== "ready") return;
    expect(explicit.tools).toEqual(["mcp__a__read"]);
  });
});
