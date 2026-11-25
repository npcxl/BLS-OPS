import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { opsApi } from "@/api/ops-api";
import type { McpServerView } from "@/api/types/mcp";
import { ExtremeMcpPage } from "../view/ExtremeMcpPage";

function server(): McpServerView {
  return {
    id: "demo",
    name: "Demo MCP",
    binding: { scope: "workspace", workspaceId: "w", serverId: null },
    defaultEnabled: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "demo-mcp"],
    env: [],
    url: "",
    headers: [],
    enabled: true,
    tools: [
      {
        name: "read_file",
        description: "读取一个文件",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
        enabled: true,
      },
    ],
    resources: [],
    prompts: [],
    status: "unknown",
    error: null,
    updatedAt: 1,
  };
}

describe("MCP 页", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("列出服务，测试连接后显示真实工具，并能停用工具", async () => {
    const list = vi.spyOn(opsApi, "mcpServerList").mockResolvedValue([server()]);
    const test = vi.spyOn(opsApi, "mcpServerTest").mockResolvedValue({
      ok: true,
      latencyMs: 12,
      status: "connected",
      error: null,
      tools: server().tools,
      resources: [],
      prompts: [],
    });
    const toggle = vi.spyOn(opsApi, "mcpToolSetEnabled").mockResolvedValue();

    const holder = document.body.appendChild(document.createElement("div"));
    const root = createRoot(holder);
    await act(async () => {
      root.render(
        <ExtremeMcpPage
          workspaceId="w"
          serverId="s"
          serverName="demo"
          connected
          onBack={() => undefined}
        />,
      );
    });

    try {
      expect(list).toHaveBeenCalled();
      const connections = holder.querySelector<HTMLButtonElement>(
        '[data-testid="mcp-tab-connections"]',
      )!;
      await act(async () => connections.click());
      expect(holder.textContent).toContain("Demo MCP");
      expect(holder.textContent).toContain("未验证");

      const testButton = holder.querySelector<HTMLButtonElement>(
        '[data-testid="mcp-test-demo"]',
      )!;
      await act(async () => testButton.click());
      expect(test).toHaveBeenCalledWith("demo");
      expect(holder.textContent).toContain("已连接");
      expect(holder.textContent).toContain("read_file");

      const checkbox = holder.querySelector<HTMLInputElement>(
        '[data-testid="mcp-tool-demo-read_file"]',
      )!;
      await act(async () => checkbox.click());
      expect(toggle).toHaveBeenCalledWith("demo", "read_file", false);
    } finally {
      await act(async () => root.unmount());
      holder.remove();
    }
  });

  it("从市场直接添加 Kubernetes 并自动发现工具", async () => {
    const kubernetes = { ...server(), id: "k8s", name: "Kubernetes", catalogId: "kubernetes" };
    vi.spyOn(opsApi, "mcpServerList").mockResolvedValue([]);
    const save = vi.spyOn(opsApi, "mcpServerSave").mockResolvedValue(kubernetes);
    const test = vi.spyOn(opsApi, "mcpServerTest").mockResolvedValue({
      ok: true,
      latencyMs: 12,
      status: "connected",
      tools: kubernetes.tools,
      resources: [],
      prompts: [],
    });
    const holder = document.body.appendChild(document.createElement("div"));
    const root = createRoot(holder);
    try {
      await act(async () => root.render(
        <ExtremeMcpPage workspaceId="w" serverId="s" serverName="demo" connected onBack={() => undefined} />,
      ));
      const card = holder.querySelector('[data-testid="mcp-market-kubernetes"]');
      const add = Array.from(card?.querySelectorAll("button") ?? []).find(
        (button) => button.textContent?.trim() === "添加",
      );
      expect(add).toBeDefined();
      await act(async () => add?.click());
      expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        catalogId: "kubernetes",
        command: "npx",
      }));
      expect(test).toHaveBeenCalledExactlyOnceWith("k8s");
      expect(card?.textContent).toContain("已连接");
      expect(card?.textContent).toContain("管理");
      expect(document.body.textContent).not.toContain("安装本地运行环境");

      const manage = Array.from(card?.querySelectorAll("button") ?? []).find(
        (button) => button.textContent === "管理",
      );
      await act(async () => manage?.click());
      const edit = holder.querySelector<HTMLButtonElement>(
        '[data-testid="mcp-server-k8s"] button[aria-label="编辑"]',
      )!;
      await act(async () => edit.click());
      const submit = Array.from(document.querySelectorAll("[role=dialog] button")).find(
        (button): button is HTMLButtonElement => button.textContent?.trim() === "保存",
      );
      expect(submit).toBeDefined();
      await act(async () => submit?.click());
      expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ id: "k8s", catalogId: "kubernetes" }));
    } finally {
      await act(async () => root.unmount());
      holder.remove();
    }
  });

  it("官方 Registry 会识别通过相同端点导入的已有连接", async () => {
    const url = "https://example.com/mcp";
    vi.spyOn(opsApi, "mcpServerList").mockResolvedValue([
      { ...server(), catalogId: null, transport: "http", url, status: "connected" },
    ]);
    vi.spyOn(opsApi, "mcpRegistrySearch").mockResolvedValue({
      servers: [{
        id: "registry:demo",
        name: "Registry MCP",
        description: "Example service",
        publisher: "Demo",
        version: "1.0.0",
        repositoryUrl: "",
        websiteUrl: "",
        remotes: [{ type: "streamable-http", url }],
        packages: [],
      }],
    });
    const holder = document.body.appendChild(document.createElement("div"));
    const root = createRoot(holder);
    try {
      await act(async () => root.render(
        <ExtremeMcpPage workspaceId="w" serverId="s" serverName="demo" connected onBack={() => undefined} />,
      ));
      const search = holder.querySelector<HTMLInputElement>('[data-testid="mcp-registry-search"]')!;
      await act(async () => search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
      const row = holder.querySelector('[data-testid="mcp-market-registry:demo"]');
      expect(row?.querySelector('[role="status"]')?.textContent).toBe("已连接");
      const manage = Array.from(row?.querySelectorAll("button") ?? []).find(
        (button) => button.textContent === "管理",
      );
      expect(manage).toBeDefined();
      await act(async () => manage?.click());
      expect(holder.querySelector('[data-testid="mcp-server-demo"]')).toBeTruthy();
    } finally {
      await act(async () => root.unmount());
      holder.remove();
    }
  });

  it("空工具列表与工具发现失败使用不同状态", async () => {
    vi.spyOn(opsApi, "mcpServerList").mockResolvedValue([
      { ...server(), id: "empty", name: "Empty MCP", status: "connected", tools: [] },
      {
        ...server(),
        id: "failed",
        name: "Failed MCP",
        status: "tools_error",
        error: "tools/list 返回 500",
        tools: [],
      },
    ]);
    const holder = document.body.appendChild(document.createElement("div"));
    const root = createRoot(holder);
    await act(async () => {
      root.render(
        <ExtremeMcpPage
          workspaceId="w"
          serverId="s"
          serverName="demo"
          connected
          onBack={() => undefined}
        />,
      );
    });
    try {
      const connections = holder.querySelector<HTMLButtonElement>(
        '[data-testid="mcp-tab-connections"]',
      )!;
      await act(async () => connections.click());
      expect(holder.textContent).toContain("已连接但无可用工具");
      expect(holder.textContent).toContain("工具发现失败");
      expect(holder.textContent).toContain("tools/list 返回 500");
    } finally {
      await act(async () => root.unmount());
      holder.remove();
    }
  });

  it("添加服务会按 stdio 字段保存", async () => {
    vi.spyOn(opsApi, "mcpServerList").mockResolvedValue([]);
    const save = vi.spyOn(opsApi, "mcpServerSave").mockImplementation(async (input) => ({
      ...server(),
      ...input,
      id: input.id ?? "new-id",
      status: "unknown",
      error: null,
      updatedAt: 2,
    }));

    const holder = document.body.appendChild(document.createElement("div"));
    const root = createRoot(holder);
    const test = vi.spyOn(opsApi, "mcpServerTest").mockResolvedValue({
      ok: true,
      latencyMs: 1,
      status: "connected",
      error: null,
      tools: [],
      resources: [],
      prompts: [],
    });

    await act(async () => {
      root.render(
        <ExtremeMcpPage
          workspaceId="w"
          serverId="s"
          serverName="demo"
          connected
          onBack={() => undefined}
        />,
      );
    });

    try {
      const add = holder.querySelector<HTMLButtonElement>('[data-testid="mcp-custom-add"]')!;
      await act(async () => add.click());
      const stdio = Array.from(document.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("本地进程"),
      )!;
      await act(async () => stdio.click());

      const name = document.querySelector<HTMLInputElement>('[data-testid="mcp-name"]')!;
      const command = document.querySelector<HTMLInputElement>(
        '[data-testid="mcp-command"]',
      )!;
      const setValue = (input: HTMLInputElement, value: string) => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      await act(async () => {
        setValue(name, "New MCP");
        setValue(command, "npx");
      });

      const submit = Array.from(document.querySelectorAll("button")).find((button) =>
        button.textContent?.trim() === "添加连接",
      )!;
      await act(async () => submit.click());
      expect(save).toHaveBeenCalled();
      expect(save.mock.calls[0][0]).toMatchObject({
        name: "New MCP",
        transport: "stdio",
        command: "npx",
        enabled: true,
      });
      // 保存后自动握手：用户不需要再点一次「测试连接」。
      expect(test).toHaveBeenCalledWith("new-id");
    } finally {
      await act(async () => root.unmount());
      holder.remove();
    }
  });
});
