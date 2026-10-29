/**
 * 自定义快捷键：组合规范化、冲突检测、关闭与恢复默认。
 *
 * 这几条是"用户自己改键"能不能用的地基 —— 冲突放过去，按一下触发两个动作
 * 比不能改更糟。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BINDINGS,
  comboFromEvent,
  resetShortcuts,
  setShortcut,
  shortcutBindings,
} from "../shortcut-store";

function press(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

beforeEach(() => {
  window.localStorage.clear();
  resetShortcuts();
});

describe("comboFromEvent", () => {
  it("normalises modifiers in a stable order", () => {
    expect(comboFromEvent(press({ key: "p", ctrlKey: true, shiftKey: true }))).toBe(
      "ctrl+shift+p",
    );
    // 顺序与按下顺序无关，只与固定顺序有关。
    expect(comboFromEvent(press({ key: "P", shiftKey: true, ctrlKey: true }))).toBe(
      "ctrl+shift+p",
    );
  });

  it("ignores a lone modifier key", () => {
    expect(comboFromEvent(press({ key: "Control", ctrlKey: true }))).toBeNull();
    expect(comboFromEvent(press({ key: "Shift", shiftKey: true }))).toBeNull();
  });

  it("refuses plain letters so typing is never stolen", () => {
    // 单字母做全局快捷键会让用户打不了字。
    expect(comboFromEvent(press({ key: "a" }))).toBeNull();
    // 功能键例外：F5 之类的按键没有文本输入语义。
    expect(comboFromEvent(press({ key: "F5" }))).toBe("f5");
  });

  it("keeps punctuation and space usable", () => {
    expect(comboFromEvent(press({ key: "\\", ctrlKey: true }))).toBe("ctrl+\\");
    expect(comboFromEvent(press({ key: "`", ctrlKey: true }))).toBe("ctrl+`");
    expect(comboFromEvent(press({ key: " ", ctrlKey: true }))).toBe("ctrl+space");
  });
});

describe("setShortcut", () => {
  it("rebinds an action and persists it", () => {
    expect(setShortcut("close_tab", "ctrl+shift+w")).toEqual({ ok: true });
    expect(shortcutBindings().close_tab).toBe("ctrl+shift+w");
    expect(window.localStorage.getItem("blsops.shortcuts")).toContain("ctrl+shift+w");
  });

  it("refuses a combination that is already taken", () => {
    // ctrl+k 是命令面板的默认键，不能同时给关标签。
    const result = setShortcut("close_tab", "ctrl+k");
    expect(result).toEqual({ ok: false, conflict: "command_palette" });
    // 冲突时原绑定保持不变。
    expect(shortcutBindings().close_tab).toBe(DEFAULT_BINDINGS.close_tab);
  });

  it("allows turning an action off", () => {
    setShortcut("ai_panel", null);
    expect(shortcutBindings().ai_panel).toBeNull();
  });

  it("keeps only the actions that differ from the defaults", () => {
    setShortcut("ai_panel", null);
    // 没动过的动作不写进存储：以后调整默认键位时，这些用户会跟着更新。
    const stored = JSON.parse(window.localStorage.getItem("blsops.shortcuts") ?? "{}");
    expect(Object.keys(stored)).toEqual(["ai_panel"]);
  });

  it("restores defaults and clears storage", () => {
    setShortcut("ai_panel", null);
    resetShortcuts();
    expect(shortcutBindings()).toEqual(DEFAULT_BINDINGS);
    expect(window.localStorage.getItem("blsops.shortcuts")).toBeNull();
  });
});
