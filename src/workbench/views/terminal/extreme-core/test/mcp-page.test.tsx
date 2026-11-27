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
      const connections = Array.from(holder.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((tab) => tab.textContent?.includes("我的连接"))!;
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

  it("市场不显示运维精选，已有连接仍可管理", async () => {
    const kubernetes = { ...server(), id: "k8s", name: "Kubernetes", catalogId: "kubernetes" };
    vi.spyOn(opsApi, "mcpServerList").mockResolvedValue([kubernetes]);
    const holder = document.body.appendChild(document.createElement("div"));
    const root = createRoot(holder);
    try {
      await act(async () => root.render(
        <ExtremeMcpPage workspaceId="w" serverId="s" serverName="demo" connected onBack={() => undefined} />,
      ));
      expect(holder.textContent).not.toContain("运维精选");
      expect(holder.querySelector('[data-testid="mcp-market-kubernetes"]')).toBeNull();
      expect(holder.querySelector('[data-testid="mcp-registry-search"]')).toBeTruthy();
      await act(async () => Array.from(holder.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((tab) => tab.textContent?.includes("我的连接"))!.click());
      expect(holder.querySelector('[data-testid="mcp-server-k8s"]')).toBeTruthy();
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
      const connections = Array.from(holder.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((tab) => tab.textContent?.includes("我的连接"))!;
      await act(async () => connections.click());
      expect(holder.textContent).toContain("已连接但无可用工具");
      expect(holder.textContent).toContain("工具发现失败");
      expect(holder.textContent).toContain("tools/list 返回 500");
    } finally {
      await act(async () => root.unmount());
      holder.remove();
    }
  });

  it("运行环境缺失时阻止添加，重新检测后保留搜索结果并解锁", async () => {
    vi.spyOn(opsApi, "mcpServerList").mockResolvedValue([]);
    const search = vi.spyOn(opsApi, "mcpRegistrySearch").mockResolvedValue({
      servers: [
        {
          id: "registry:uvx-demo",
          name: "UVX Demo",
          description: "需要 uvx 的服务",
          publisher: "Demo",
          version: "1.0.0",
          repositoryUrl: "",
          websiteUrl: "",
          remotes: [],
          packages: [
            {
              registryType: "pypi",
              identifier: "demo-mcp",
              version: "1.0.0",
              transport: "stdio",
            },
          ],
        },
      ],
      runtimes: { uvx: "missing", npx: "ready", docker: "ready" },
      runtimeDetails: [
        {
          id: "uvx",
          label: "uvx",
          status: "missing",
          message: "未安装 uvx",
          detail: "查找范围：应用 PATH 12 个目录，用户 PATH 4 个",
          durationMs: 4,
        },
      ],
    });
    const runtime = vi.spyOn(opsApi, "mcpRuntimeStatus").mockResolvedValue({
      checkedAt: 2,
      statuses: { uvx: "ready", npx: "ready", docker: "ready" },
      runtimes: [
        {
          id: "uvx",
          label: "uvx",
          status: "ready",
          path: "~\\.local\\bin\\uvx.EXE",
          version: "uvx 0.13.10",
          source: "user-path",
          message: "已安装 uvx（uvx 0.13.10）",
          detail: "路径：~\\.local\\bin\\uvx.EXE；退出码 0",
          durationMs: 30,
        },
      ],
    });
    const save = vi.spyOn(opsApi, "mcpServerSave").mockImplementation(async (input) => ({
      ...server(),
      ...input,
      id: "uvx-instance",
      status: "connected",
      error: null,
      updatedAt: 2,
    }));
    const test = vi.spyOn(opsApi, "mcpServerTest").mockResolvedValue({
      ok: true,
      latencyMs: 3,
      status: "connected",
      error: null,
      tools: [],
      resources: [],
      prompts: [],
    });

    const holder = document.body.appendChild(document.createElement("div"));
    const root = createRoot(holder);
    try {
      await act(async () => root.render(
        <ExtremeMcpPage workspaceId="w" serverId="s" serverName="demo" connected onBack={() => undefined} />,
      ));
      const input = holder.querySelector<HTMLInputElement>('[data-testid="mcp-registry-search"]')!;
      await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
      expect(search).toHaveBeenCalled();

      // 运行环境缺失：卡片仍在市场里，但"添加"按钮被禁用。
      const row = holder.querySelector('[data-testid="mcp-market-registry:uvx-demo"]')!;
      expect(row).toBeTruthy();
      const addButton = () =>
        Array.from(row.querySelectorAll<HTMLButtonElement>("button")).find(
          (button) => button.textContent?.trim() === "添加",
        )!;
      expect(addButton().disabled).toBe(true);
      expect(row.textContent).toContain("未安装");

      // 重新检测：只刷新运行环境，不清空搜索结果。
      const recheck = holder.querySelector<HTMLButtonElement>('[data-testid="mcp-runtime-recheck"]')!;
      await act(async () => recheck.click());
      expect(runtime).toHaveBeenCalled();
      expect(holder.querySelector('[data-testid="mcp-market-registry:uvx-demo"]')).toBeTruthy();
      expect(holder.querySelector('[data-testid="mcp-runtime-uvx"]')?.textContent).toContain("已就绪");
      expect(addButton().disabled).toBe(false);

      await act(async () => addButton().click());
      expect(save).toHaveBeenCalledTimes(1);
      expect(test).toHaveBeenCalledWith("uvx-instance");

      // 再检测一次不应再保存（不会产生重复连接）。
      const recheckAgain = holder.querySelector<HTMLButtonElement>('[data-testid="mcp-runtime-recheck"]')!;
      await act(async () => recheckAgain.click());
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      holder.remove();
    }
  });

  it("修复弹窗重新检测后直接重试，不重复保存连接", async () => {
    vi.spyOn(opsApi, "mcpServerList").mockResolvedValue([
      {
        ...server(),
        id: "broken",
        command: "uvx",
        args: ["demo-mcp"],
        error: "找不到可执行文件：uvx",
        status: "error",
      },
    ]);
    const runtime = vi.spyOn(opsApi, "mcpRuntimeStatus").mockResolvedValue({
      checkedAt: 3,
      statuses: { uvx: "ready" },
      runtimes: [
        {
          id: "uvx",
          label: "uvx",
          status: "ready",
          path: "~\\.local\\bin\\uvx.EXE",
          version: "uvx 0.13.10",
          source: "user-path",
          message: "已安装 uvx（uvx 0.13.10）",
          durationMs: 20,
        },
      ],
      command: {
        command: "uvx",
        resolved: true,
        status: "ready",
        path: "~\\.local\\bin\\uvx.EXE",
        version: "uvx 0.13.10",
        message: "已找到并确认可运行：uvx",
        detail: "路径：~\\.local\\bin\\uvx.EXE；退出码 0",
        durationMs: 20,
      },
    });
    const save = vi.spyOn(opsApi, "mcpServerSave");
    const test = vi.spyOn(opsApi, "mcpServerTest").mockResolvedValue({
      ok: true,
      latencyMs: 2,
      status: "connected",
      error: null,
      tools: server().tools,
      resources: [],
      prompts: [],
    });

    const holder = document.body.appendChild(document.createElement("div"));
    const root = createRoot(holder);
    try {
      await act(async () => root.render(
        <ExtremeMcpPage workspaceId="w" serverId="s" serverName="demo" connected onBack={() => undefined} />,
      ));
      const connections = Array.from(holder.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
        (tab) => tab.textContent?.includes("我的连接"),
      )!;
      await act(async () => connections.click());
      const install = Array.from(holder.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent === "安装运行环境",
      )!;
      await act(async () => install.click());
      expect(runtime).toHaveBeenCalledWith("uvx");
      expect(document.body.textContent).toContain("已找到并确认可运行：uvx");
      expect(document.body.textContent).toContain("不需要重启应用");

      const retry = document.querySelector<HTMLButtonElement>('[data-testid="mcp-repair-retry"]')!;
      await act(async () => retry.click());
      // 重试只走连接测试，不会再保存一条新连接。
      expect(test).toHaveBeenCalledWith("broken");
      expect(save).not.toHaveBeenCalled();
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
        binding: { scope: "global" },
      });
      // 保存后自动握手：用户不需要再点一次「测试连接」。
      expect(test).toHaveBeenCalledWith("new-id");
    } finally {
      await act(async () => root.unmount());
      holder.remove();
    }
  });
});
