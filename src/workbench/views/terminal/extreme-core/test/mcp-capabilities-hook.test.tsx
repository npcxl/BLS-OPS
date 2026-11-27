import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { opsApi } from "@/api/ops-api";
import type { McpServerView } from "@/api/types/mcp";
import { useExtremeMcpSelection } from "@/stores/extreme-mcp-selection";
import {
  useMcpCapabilities,
  type McpCapabilityState,
  type McpSelectionResult,
} from "../view/use-mcp-capabilities";

function server(): McpServerView {
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
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("MCP 勾选加载", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useExtremeMcpSelection.setState({ bySession: {} });
    document.body.innerHTML = "";
  });

  it("连接列表延迟返回时等待，而不是静默发送空工具", async () => {
    const pending = deferred<McpServerView[]>();
    vi.spyOn(opsApi, "mcpServerList").mockReturnValue(pending.promise);
    let api: McpCapabilityState | null = null;
    function Harness() {
      api = useMcpCapabilities({
        workspaceId: "w",
        serverId: "A",
        sessionId: "s",
        connected: true,
      });
      return null;
    }
    const holder = document.body.appendChild(document.createElement("div"));
    const root = createRoot(holder);
    await act(async () => root.render(<Harness />));
    try {
      let result: McpSelectionResult | null = null;
      const selection = api!.ensureSelection("task-2", "A").then((value) => {
        result = value;
      });
      await act(async () => {
        pending.resolve([server()]);
        await selection;
      });
      expect(result).toMatchObject({
        status: "ready",
        tools: ["mcp__a__read"],
      });
    } finally {
      await act(async () => root.unmount());
      holder.remove();
    }
  });

  it("连接列表读取失败时返回错误，后续仍可重试", async () => {
    const list = vi
      .spyOn(opsApi, "mcpServerList")
      .mockRejectedValueOnce(new Error("IPC 断开"))
      .mockResolvedValueOnce([server()]);
    let api: McpCapabilityState | null = null;
    function Harness() {
      api = useMcpCapabilities({
        workspaceId: "w",
        serverId: "A",
        sessionId: "s",
        connected: true,
      });
      return null;
    }
    const holder = document.body.appendChild(document.createElement("div"));
    const root = createRoot(holder);
    await act(async () => root.render(<Harness />));
    try {
      await act(async () => {
        await Promise.resolve();
      });
      const failed = await api!.ensureSelection("task-2", "A");
      expect(failed.status).toBe("error");
      if (failed.status !== "error") return;
      expect(failed.message).toContain("IPC 断开");

      await act(async () => {
        api!.refresh();
        await Promise.resolve();
      });
      const retried = await api!.ensureSelection("task-2", "A");
      expect(list).toHaveBeenCalled();
      expect(retried.status).toBe("ready");
      if (retried.status !== "ready") return;
      expect(retried.tools).toEqual(["mcp__a__read"]);
    } finally {
      await act(async () => root.unmount());
      holder.remove();
    }
  });
});
