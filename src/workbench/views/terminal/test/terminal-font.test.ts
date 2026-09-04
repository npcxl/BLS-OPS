import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_FONT_ID,
  TERMINAL_FONTS,
  TERMINAL_FONT_KEY,
  applyTerminalFont,
  readTerminalFontId,
  resolveFontStack,
} from "../terminal-font";

describe("terminal-font", () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty("--font-terminal");
    document.documentElement.style.removeProperty("--font-command-output");
    window.localStorage.removeItem(TERMINAL_FONT_KEY);
  });
  afterEach(() => {
    document.documentElement.style.removeProperty("--font-terminal");
    document.documentElement.style.removeProperty("--font-command-output");
  });

  it("每个选项的字体栈都以 monospace 兜底（没装就回退，不会变比例字体）", () => {
    for (const option of TERMINAL_FONTS) {
      expect(option.stack.endsWith("monospace")).toBe(true);
    }
  });

  it("默认字体存在且可解析", () => {
    expect(TERMINAL_FONTS.some((option) => option.id === DEFAULT_TERMINAL_FONT_ID)).toBe(true);
    expect(resolveFontStack(DEFAULT_TERMINAL_FONT_ID)).toContain("Cascadia Mono");
  });

  it("未知 id → 默认栈（脏 localStorage 也不会渲染空字体）", () => {
    expect(resolveFontStack("not-a-font")).toBe(resolveFontStack(DEFAULT_TERMINAL_FONT_ID));
  });

  it("applyTerminalFont 同时改终端与命令输出两个变量（两边永远同一套栈）", () => {
    const stack = applyTerminalFont("consolas");
    expect(stack).toContain("Consolas");
    expect(document.documentElement.style.getPropertyValue("--font-terminal")).toBe(stack);
    expect(document.documentElement.style.getPropertyValue("--font-command-output")).toBe(stack);
  });

  it("持久化：存进去能读出来，脏值回退默认", () => {
    window.localStorage.setItem(TERMINAL_FONT_KEY, "sarasa");
    expect(readTerminalFontId()).toBe("sarasa");
    window.localStorage.setItem(TERMINAL_FONT_KEY, "bogus");
    expect(readTerminalFontId()).toBe(DEFAULT_TERMINAL_FONT_ID);
  });
});
