import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { useExtremeStore } from "@/stores/extreme-store";
import { TaskSidebar } from "../TaskSidebar";
import type { ExtremeWorkspace } from "../workspace-history";

function entry(id: string, title: string, serverId: string): ExtremeWorkspace {
  return {
    id,
    serverId,
    server: serverId,
    host: `${serverId}.example`,
    serverKey: serverId,
    sessionId: `ssh-${serverId}`,
    folders: [],
    messages: [],
    draft: "",
    title,
    updatedAt: Date.now(),
  };
}

const entries = [entry("w1", "任务一", "s1"), entry("w2", "任务二", "s2")];

function renderRail(onOpenPage = vi.fn()) {
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  act(() => {
    root.render(
      <TaskSidebar
        entries={entries}
        currentId="w1"
        currentTitle="任务一"
        busy={false}
        onNew={() => undefined}
        onOpen={() => undefined}
        onRename={() => undefined}
        onDelete={() => undefined}
        outputStyle="auto"
        onOutputStyleChange={() => undefined}
        hasContext={false}
        activePage={null}
        onOpenPage={onOpenPage}
      />,
    );
  });
  return { holder, root, onOpenPage };
}

describe("超能左栏", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    // 左栏开合现在记在 store 里：用例之间复位，避免互相影响。
    useExtremeStore.setState({ railCollapsed: false, railByWorkspace: {} });
  });

  it("任务分组可收起，当前对话仍可见，底部入口始终可用", () => {
    const { holder, root, onOpenPage } = renderRail();
    try {
      expect(holder.textContent).toContain("任务一");
      expect(holder.textContent).toContain("任务二");
      expect(holder.textContent).toContain("新建任务");

      const toggle = holder.querySelector<HTMLButtonElement>(
        '[data-testid="task-group-toggle"]',
      )!;
      act(() => toggle.click());
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(holder.textContent).toContain("任务一");
      expect(holder.textContent).not.toContain("任务二");
      expect(holder.textContent).toContain("任务列表已收起");

      // 列表收起后，底部三个入口仍然在，并且可点。
      for (const id of ["settings", "permissions", "mcp"]) {
        const button = holder.querySelector<HTMLButtonElement>(`[data-testid="rail-${id}"]`);
        expect(button, id).toBeTruthy();
      }
      act(() =>
        holder.querySelector<HTMLButtonElement>('[data-testid="rail-permissions"]')!.click(),
      );
      expect(onOpenPage).toHaveBeenCalledWith("permissions");

      act(() => toggle.click());
      expect(holder.textContent).toContain("任务二");
    } finally {
      act(() => root.unmount());
      holder.remove();
    }
  });

  it("记住任务分组折叠状态，重进左栏仍保持", () => {
    const first = renderRail();
    const toggle = first.holder.querySelector<HTMLButtonElement>(
      '[data-testid="task-group-toggle"]',
    )!;
    act(() => toggle.click());
    act(() => first.root.unmount());
    first.holder.remove();

    const second = renderRail();
    try {
      expect(second.holder.textContent).toContain("任务一");
      expect(second.holder.textContent).not.toContain("任务二");
      expect(
        second.holder
          .querySelector('[data-testid="task-group-toggle"]')!
          .getAttribute("aria-expanded"),
      ).toBe("false");
    } finally {
      act(() => second.root.unmount());
      second.holder.remove();
    }
  });

  it("新建任务时左栏收起，只留图标与新建入口", () => {
    // 新任务的默认收起由创建入口写进 store（这里直接模拟那一次初始化）。
    useExtremeStore.setState({ railCollapsed: true, railByWorkspace: { w1: true } });
    const { holder, root } = renderRail();
    try {
      const aside = holder.querySelector("aside")!;
      expect(aside.getAttribute("data-collapsed")).toBe("true");
      // 收起态仍能新建任务、也能展开回列表。
      expect(holder.querySelector('[aria-label="新建任务"]')).toBeTruthy();
      expect(holder.querySelector('[aria-label="展开会话列表"]')).toBeTruthy();
    } finally {
      act(() => root.unmount());
      holder.remove();
    }
  });

  it("收起整栏后底部三个入口变成图标但仍然存在", () => {
    const { holder, root } = renderRail();
    try {
      const collapse = holder.querySelector<HTMLButtonElement>('[aria-label="收起侧栏"]')!;
      act(() => collapse.click());
      const aside = holder.querySelector("aside")!;
      expect(aside.getAttribute("data-collapsed")).toBe("true");
      for (const id of ["settings", "permissions", "mcp"]) {
        expect(
          holder.querySelector(`[data-testid="rail-${id}"]`),
          id,
        ).toBeTruthy();
      }
    } finally {
      act(() => root.unmount());
      holder.remove();
    }
  });
});
