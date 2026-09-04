import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { NavModule } from "@/workbench/types";

/**
 * The top bar owns the *only* way back once the rail is collapsed — the rail's
 * own 收起 button disappears with it. These guard both halves: the button must
 * appear when there is something to expand, and must stay away for modules
 * that never had a sidebar (设置 / 命令 / 部署 …), where it would be dead UI.
 */
const win = vi.hoisted(() => ({
  close: vi.fn(),
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));

import { useWorkbenchStore } from "@/stores/workbench-store";
import { AppTopBar } from "./AppTopBar";
import { CONTEXT_SIDEBAR_MODULES } from "./module-server-sidebar";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let holder: HTMLDivElement;
let root: Root;

const expandButton = () =>
  document.body.querySelector<HTMLElement>('[aria-label="展开侧边栏"]');

async function render(module: NavModule, collapsed: boolean) {
  useWorkbenchStore.setState({ activeModule: module, sidebarCollapsed: collapsed });
  await act(async () => {
    root.render(<AppTopBar />);
  });
}

beforeEach(() => {
  holder = document.createElement("div");
  document.body.appendChild(holder);
  root = createRoot(holder);
});

afterEach(() => {
  act(() => root.unmount());
  holder.remove();
});

describe("AppTopBar 侧边栏展开入口", () => {
  it("shows the expand button when a collapsed module has a rail", async () => {
    await render("ssh", true);
    expect(expandButton()).not.toBeNull();
  });

  it("offers it for every rail module, not just the terminal", async () => {
    for (const module of CONTEXT_SIDEBAR_MODULES) {
      await render(module, true);
      expect(expandButton(), `${module} 应有展开按钮`).not.toBeNull();
    }
  });

  it("hides it for modules that have no sidebar at all", async () => {
    const railLess: NavModule[] = ["settings", "commands", "deploy", "tasks", "ai", "servers"];

    for (const module of railLess) {
      await render(module, true);
      // Collapsing is a no-op there, so there is nothing to expand back.
      expect(expandButton(), `${module} 不应显示展开按钮`).toBeNull();
    }
  });

  it("stays hidden while the rail is already open — it has its own 收起 button", async () => {
    await render("ssh", false);
    expect(expandButton()).toBeNull();
  });

  it("expands the rail when clicked", async () => {
    await render("ssh", true);
    await act(async () => {
      expandButton()!.click();
    });
    expect(useWorkbenchStore.getState().sidebarCollapsed).toBe(false);
  });

  it("keeps the button clickable rather than swallowed by the window drag region", async () => {
    await render("ssh", true);
    expect(expandButton()?.getAttribute("data-tauri-drag-region")).toBe("false");
  });

  it("keeps the collapse/expand state across module switches", async () => {
    await render("ssh", true);
    await render("settings", true);
    expect(expandButton()).toBeNull();

    // Back to a rail module: the state is global, so the way back is there.
    await render("ssh", true);
    expect(expandButton()).not.toBeNull();
  });
});
