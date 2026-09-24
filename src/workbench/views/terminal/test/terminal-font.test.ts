import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TERMINAL_FONT_ID,
  TERMINAL_FONTS,
  TERMINAL_FONT_KEY,
  applyTerminalFont,
  getTerminalFontId,
  readTerminalFontId,
  resolveFontStack,
  setTerminalFontId,
  subscribeTerminalFont,
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

/**
 * 字体从终端工具栏搬到设置页后，两边必须**共享同一份状态**：
 * 设置页改一下，已经开着的终端要跟着重排（xterm 的 fontFamily 是创建时读的）。
 */
describe("shared font state (settings ↔ terminal)", () => {
  it("setTerminalFontId 三件事一起做：应用 CSS 变量 + 持久化 + 通知订阅者", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTerminalFont(listener);

    setTerminalFontId("consolas");

    expect(document.documentElement.style.getPropertyValue("--font-terminal")).toContain("Consolas");
    expect(window.localStorage.getItem(TERMINAL_FONT_KEY)).toBe("consolas");
    expect(getTerminalFontId()).toBe("consolas");
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setTerminalFontId("sarasa");
    // 退订之后不再收到通知（终端卸载后不该被回调）。
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("脏 id 规范化成默认字体 —— 绝不把无效值写进存储", () => {
    setTerminalFontId("not-a-real-font");
    expect(getTerminalFontId()).toBe(DEFAULT_TERMINAL_FONT_ID);
    expect(window.localStorage.getItem(TERMINAL_FONT_KEY)).toBe(DEFAULT_TERMINAL_FONT_ID);
  });
});
