/**
 * 页签图标映射。
 *
 * 回归点：数据库标签曾显示成终端图标（`>_`）—— `tabIcon` 用 `Partial` 映射，
 * 漏配的类型静默回退到 `TerminalIcon`。现在改成 `Record`，漏配会编译失败；
 * 这里再钉住几个具体映射，防止有人把 `database` 换成别的图标。
 */
import { describe, expect, it } from "vitest";
import { GearIcon, Table2, TerminalIcon } from "@/components/icons";
import { tabIcon } from "../WorkspaceTabs";
import type { WorkspaceTab } from "../types";

function tab(overrides: Partial<WorkspaceTab> & Pick<WorkspaceTab, "type">): WorkspaceTab {
  return { id: "t1", title: "T", ...overrides };
}

describe("tabIcon", () => {
  it("uses the table icon for database tabs, not the terminal icon", () => {
    expect(tabIcon(tab({ type: "database" }))).toBe(Table2);
    expect(tabIcon(tab({ type: "database" }))).not.toBe(TerminalIcon);
  });

  it("keeps distinct icons for terminal and database", () => {
    // 两种标签会并排出现，图标一样就分不出"我点的是哪个"。
    expect(tabIcon(tab({ type: "terminal" }))).not.toBe(tabIcon(tab({ type: "database" })));
  });

  it("follows the module for module tabs", () => {
    expect(tabIcon(tab({ type: "module", module: "database" }))).toBe(Table2);
    // 缺 module 的占位标签给齿轮，而不是随便一个图标。
    expect(tabIcon(tab({ type: "module" }))).toBe(GearIcon);
  });
});
