import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { ComposerMcpMenu } from "../view/ComposerMcpMenu";
import type { McpCapabilityState } from "../view/use-mcp-capabilities";

function state(overrides: Partial<McpCapabilityState> = {}): McpCapabilityState {
  return {
    ready: true,
    probing: false,
    serversLoading: false,
    serversError: null,
    ensureSelection: vi.fn().mockResolvedValue({
      status: "ready",
      builtins: [],
      tools: [],
    }),
    rows: [
      {
        id: "builtin:docker",
        kind: "builtin",
        name: "Docker / Compose",
        source: "BLS-OPS 内置",
        detail: "",
        available: true,
        enabled: true,
        status: "ready",
      },
      {
        id: "mcp:grafana",
        kind: "mcp",
        name: "Grafana · 生产",
        source: "远程 HTTP",
        detail: "https://grafana.example/api/mcp",
        available: true,
        enabled: false,
        status: "ready",
        toolCount: 6,
      },
      {
        id: "builtin:nginx",
        kind: "builtin",
        name: "Nginx / 站点排查",
        source: "BLS-OPS 内置",
        detail: "",
        available: false,
        enabled: false,
        status: "unavailable",
      },
    ],
    selectedBuiltins: ["docker"],
    selectedToolNames: [],
    toggle: vi.fn(),
    refresh: vi.fn(),
    enabledCount: 1,
    ...overrides,
  };
}

describe("输入区 MCP 菜单", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("连接列表读取失败时说明原因并提供重试", async () => {
    const refresh = vi.fn();
    const data = state({
      ready: false,
      serversError: "IPC 断开",
      refresh,
    });
    const holder = document.body.appendChild(document.createElement("div"));
    const root = createRoot(holder);
    await act(async () =>
      root.render(
        <ComposerMcpMenu
          state={data}
          onOpenMarket={() => undefined}
          onManage={() => undefined}
        />,
      ),
    );
    try {
      await act(async () =>
        holder.querySelector<HTMLButtonElement>('[data-testid="composer-mcp"]')!.click(),
      );
      expect(document.body.textContent).toContain("MCP 连接读取失败：IPC 断开");
      const retry = Array.from(
        document.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.trim() === "重试")!;
      await act(async () => retry.click());
      expect(refresh).toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      holder.remove();
    }
  });

  it("连接失效时在入口显示异常并允许单独重新检测", async () => {
    const checkMcp = vi.fn().mockResolvedValue(undefined);
    const data = state({
      checkMcp,
      rows: [{ id: "mcp:k8s", kind: "mcp", name: "Kubernetes", source: "本地进程",
        detail: "启动失败", available: false, enabled: true, status: "error" }],
      enabledCount: 0,
    });
    const holder = document.body.appendChild(document.createElement("div"));
    const root = createRoot(holder);
    try {
      await act(async () => root.render(<ComposerMcpMenu state={data} onOpenMarket={() => undefined} onManage={() => undefined} />));
      const menu = holder.querySelector<HTMLButtonElement>('[data-testid="composer-mcp"]')!;
      expect(menu.textContent).toContain("1 项异常");
      await act(async () => menu.click());
      expect(document.body.textContent).toContain("启动失败");
      const retry = Array.from(document.querySelectorAll("button")).find((button) =>
        button.textContent?.trim() === "重新检测" && button.closest("div")?.textContent?.includes("连接失败"));
      expect(retry).toBeDefined();
      await act(async () => retry?.click());
      expect(checkMcp).toHaveBeenCalledWith("k8s");
    } finally {
      await act(async () => root.unmount());
      holder.remove();
    }
  });

  it("显示已启用数量，按来源分组并回传勾选", async () => {
    const data = state();
    const openMarket = vi.fn();
    const manage = vi.fn();
    const holder = document.body.appendChild(document.createElement("div"));
    const root = createRoot(holder);
    await act(async () => {
      root.render(
        <ComposerMcpMenu state={data} onOpenMarket={openMarket} onManage={manage} />,
      );
    });

    try {
      const button = holder.querySelector<HTMLButtonElement>('[data-testid="composer-mcp"]')!;
      expect(button.textContent).toContain("已启用 1 项");
      await act(async () => button.click());
      expect(document.body.textContent).toContain("内置运维技能");
      expect(document.body.textContent).toContain("已连接 MCP");
      expect(document.body.textContent).toContain("Grafana · 生产");
      expect(document.body.textContent).toContain("6 个工具");
      expect(document.body.textContent).toContain("当前服务器不可用");

      const grafana = document.querySelector<HTMLInputElement>(
        '[data-testid="mcp-cap-mcp:grafana"]',
      )!;
      await act(async () => grafana.click());
      expect(data.toggle).toHaveBeenCalledWith("mcp:grafana", true);

      const market = document.querySelector<HTMLButtonElement>(
        '[data-testid="mcp-open-market"]',
      )!;
      await act(async () => market.click());
      expect(openMarket).toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      holder.remove();
    }
  });

  it("已勾选但不可用时给出明确状态", async () => {
    const data = state({
      rows: [
        {
          id: "builtin:nginx",
          kind: "builtin",
          name: "Nginx / 站点排查",
          source: "BLS-OPS 内置",
          detail: "",
          available: false,
          enabled: true,
          status: "unavailable",
        },
      ],
      enabledCount: 1,
    });
    const holder = document.body.appendChild(document.createElement("div"));
    const root = createRoot(holder);
    await act(async () => {
      root.render(<ComposerMcpMenu state={data} onOpenMarket={vi.fn()} onManage={vi.fn()} />);
    });
    try {
      await act(async () =>
        holder.querySelector<HTMLButtonElement>('[data-testid="composer-mcp"]')!.click(),
      );
      expect(document.body.textContent).toContain("已启用但暂不可用");
    } finally {
      await act(async () => root.unmount());
      holder.remove();
    }
  });
});
