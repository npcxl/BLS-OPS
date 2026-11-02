import { describe, expect, it } from "vitest";

import { buildTerminalMenuItems, type TerminalMenuActions } from "../use-terminal-menu";

/**
 * 右键菜单里的「复制」只看**右键那一刻**的选区。
 *
 * 回归背景：`hasSelection` 曾经是渲染期算出来的布尔值，而在终端里选中文字
 * 不会触发 React 重渲染 —— 于是用户明明选了一段，右键菜单里却只有「粘贴」，
 * 时好时坏完全取决于上次渲染发生在选中之前还是之后。
 */

/** 只关心 key，不需要真的翻译。 */
const t = ((key: string) => key) as unknown as Parameters<typeof buildTerminalMenuItems>[0];

function actions(overrides: Partial<TerminalMenuActions> = {}): TerminalMenuActions {
  return {
    historyOpen: false,
    filesOpen: false,
    phase: "connected",
    hasSelection: () => false,
    onCopySelection: () => undefined,
    onPaste: () => undefined,
    onSplit: () => undefined,
    onClear: () => undefined,
    onToggleHistory: () => undefined,
    onToggleFiles: () => undefined,
    onRefreshEnvironment: () => undefined,
    onDisconnect: () => undefined,
    onReconnect: () => undefined,
    ...overrides,
  };
}

const labels = (list: ReturnType<typeof buildTerminalMenuItems>) =>
  list.map((item) => item.label ?? "");

describe("终端右键菜单", () => {
  it("无选区时不给「复制」，只给「粘贴」", () => {
    const items = labels(buildTerminalMenuItems(t, actions()));

    expect(items).not.toContain("Copy");
    expect(items).toContain("Paste");
  });

  it("有选区时每次构建都重新取值，不受上一次渲染影响", () => {
    let selected = false;
    const base = actions({ hasSelection: () => selected });

    expect(labels(buildTerminalMenuItems(t, base))).not.toContain("Copy");

    // 用户随后选中文字（没有触发任何 React 渲染）→ 同一个 actions 也要给「复制」。
    selected = true;
    expect(labels(buildTerminalMenuItems(t, base))).toContain("Copy");

    selected = false;
    expect(labels(buildTerminalMenuItems(t, base))).not.toContain("Copy");
  });
});
