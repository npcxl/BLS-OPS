import { beforeEach, describe, expect, it } from "vitest";
import { useWorkbenchStore } from "./workbench-store";
import type { WorkbenchPane } from "@/workbench/types";

/**
 * These cover the module ⇄ tab routing that the workbench relies on:
 * `activeModule` drives the left sidebar and the rail highlight, while the
 * right side renders `activeTabId`. The two must stay in step, or the sidebar
 * changes while the content does not.
 */

const initial = () => useWorkbenchStore.getState();

function activeTabType(): string | undefined {
  const state = initial();
  const leaf = findActiveLeaf(state.rootPane);
  return leaf?.tabs.find((tab) => tab.id === leaf.activeTabId)?.type;
}

/** The focused leaf pane holding the active tab. */
function findActiveLeaf(pane: WorkbenchPane): WorkbenchPane {
  if (!pane.children || pane.children.length === 0) return pane;
  for (const child of pane.children) {
    const found = findActiveLeaf(child);
    if (found.tabs.some((tab) => tab.id === found.activeTabId)) return found;
  }
  return pane.children[0];
}

const SERVER = "srv-1";

describe("workbench module ⇄ tab routing", () => {
  beforeEach(() => {
    useWorkbenchStore.setState({
      activeModule: "ssh",
      rootPane: { id: "pane-1", tabs: [{ id: "home", type: "home", title: "首页" }], activeTabId: "home" },
      focusedPaneId: "pane-1",
    });
  });

  it("opening a server-list module focuses that module's tab", () => {
    initial().openModuleTab("projects");
    expect(initial().activeModule).toBe("projects");
    expect(activeTabType()).toBe("project");
  });

  /**
   * Regression: switching to 终端 only set `activeModule`, leaving
   * `activeTabId` on the previously active tab — the right pane kept showing
   * 项目 while the sidebar switched to the server list.
   */
  it("switching back to 终端 surfaces a terminal tab, not the project one", () => {
    initial().openModuleTab("projects");
    initial().openModuleTabForServer("projects", SERVER);
    expect(activeTabType()).toBe("project");

    initial().openModuleTab("ssh");
    expect(initial().activeModule).toBe("ssh");
    // No terminal tab exists yet, so nothing is focused — but the project tab
    // must not stay on screen either.
    const state = initial();
    const leaf = findActiveLeaf(state.rootPane);
    const active = leaf.tabs.find((tab) => tab.id === leaf.activeTabId);
    expect(active?.type).not.toBe("project");
  });

  /**
   * Regression: `findLeafWithServer` matched on `serverId` alone, so picking a
   * server under 终端 reused the `project` tab bound to the same server and the
   * user got the project view back.
   */
  it("picking a server under 终端 opens a terminal tab even when a project tab uses that server", () => {
    // A project tab bound to the server already exists.
    initial().openModuleTab("projects");
    initial().openModuleTabForServer("projects", SERVER);
    expect(activeTabType()).toBe("project");

    // Now switch to 终端 and pick the *same* server.
    initial().openModuleTab("ssh");
    initial().openOrFocusServerTab({
      id: "term-1",
      type: "terminal",
      title: "web",
      serverId: SERVER,
      sessionId: "sess-1",
    });

    expect(activeTabType()).toBe("terminal");
    expect(initial().activeModule).toBe("ssh");
  });

  it("reuses the terminal tab for a server instead of opening a second one", () => {
    initial().openOrFocusServerTab({
      id: "term-1",
      type: "terminal",
      title: "web",
      serverId: SERVER,
      sessionId: "sess-1",
    });
    const leaf0 = findActiveLeaf(initial().rootPane);
    const countBefore = leaf0.tabs.filter((t) => t.type === "terminal").length;

    initial().openOrFocusServerTab({
      id: "term-2",
      type: "terminal",
      title: "web",
      serverId: SERVER,
      sessionId: "sess-2",
    });

    const leaf = findActiveLeaf(initial().rootPane);
    const countAfter = leaf.tabs.filter((t) => t.type === "terminal").length;
    expect(countAfter).toBe(countBefore);
    expect(activeTabType()).toBe("terminal");
  });

  it("keeps project and terminal tabs for one server independent", () => {
    initial().openModuleTabForServer("projects", SERVER);
    initial().openOrFocusServerTab({
      id: "term-1",
      type: "terminal",
      title: "web",
      serverId: SERVER,
      sessionId: "sess-1",
    });

    const leaf = findActiveLeaf(initial().rootPane);
    const forServer = leaf.tabs.filter((t) => t.serverId === SERVER);
    expect(forServer.map((t) => t.type).sort()).toEqual(["project", "terminal"]);
  });

  it("activating a tab moves the rail highlight to its module", () => {
    initial().openModuleTab("projects");
    initial().openModuleTabForServer("projects", SERVER);
    const leaf = findActiveLeaf(initial().rootPane);
    const projectTab = leaf.tabs.find((t) => t.type === "project");
    if (!projectTab) throw new Error("expected a project tab");

    // Focus the terminal tab, then the project one again.
    initial().setActiveTab(leaf.id, projectTab.id);
    expect(initial().activeModule).toBe("projects");
  });
});
