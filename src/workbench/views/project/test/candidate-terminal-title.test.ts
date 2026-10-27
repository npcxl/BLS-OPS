import { describe, expect, it } from "vitest";
import type { WorkbenchPane, WorkspaceTab } from "@/workbench/types";
import { collectTerminalTitles, uniqueTerminalTitle } from "../use-candidate-actions";

function tab(id: string, type: WorkspaceTab["type"], title: string): WorkspaceTab {
  return { id, type, title };
}

function leaf(id: string, tabs: WorkspaceTab[]): WorkbenchPane {
  return { id, tabs, activeTabId: tabs[0]?.id ?? null };
}

describe("终端页签标题（项目卡片「在终端中跟踪」）", () => {
  it("收集跨 pane 的终端标题，非终端忽略", () => {
    const root: WorkbenchPane = {
      id: "root",
      tabs: [],
      activeTabId: null,
      direction: "horizontal",
      children: [
        leaf("a", [tab("t1", "terminal", "web"), tab("p1", "project", "web")]),
        leaf("b", [tab("t2", "terminal", "web (2)"), tab("t3", "logs", "logs")]),
      ],
    };

    const titles = new Set<string>();
    collectTerminalTitles(root, titles);

    // 项目页签叫 "web" 不算占用终端标题 —— 否则会凭空多出一个 (2)。
    expect([...titles].sort()).toEqual(["web", "web (2)"]);
  });

  it("没有重名时直接用服务器名", () => {
    expect(uniqueTerminalTitle(new Set(["db"]), "web")).toBe("web");
    expect(uniqueTerminalTitle(new Set(), "web")).toBe("web");
  });

  it("重名时依次编号", () => {
    expect(uniqueTerminalTitle(new Set(["web"]), "web")).toBe("web (2)");
    expect(uniqueTerminalTitle(new Set(["web", "web (2)"]), "web")).toBe("web (3)");
    expect(uniqueTerminalTitle(new Set(["web", "web (2)", "web (3)"]), "web")).toBe("web (4)");
  });

  it("中间空号补空号，不往最大号后面接", () => {
    // 关掉过 (2)：下一个应该补 (2)，否则编号会越排越长。
    expect(uniqueTerminalTitle(new Set(["web", "web (3)"]), "web")).toBe("web (2)");
  });
});
