import { beforeEach, describe, expect, it } from "vitest";
import {
  ENHANCED_TERMINAL_KEY,
  readEnhancedTerminal,
  saveEnhancedTerminal,
} from "../terminal-preferences";

describe("terminal-preferences", () => {
  beforeEach(() => {
    window.localStorage.removeItem(ENHANCED_TERMINAL_KEY);
  });

  it("首次启动（没存过）→ 开启：否则新用户看不到结果 Tab / JSON Tab", () => {
    expect(readEnhancedTerminal()).toBe(true);
  });

  it("用户主动关过 → 保持关闭（只记忆主动关闭，不记忆没选过）", () => {
    saveEnhancedTerminal(false);
    expect(readEnhancedTerminal()).toBe(false);
  });

  it("关过再打开 → 开启（开关双向可恢复）", () => {
    saveEnhancedTerminal(false);
    saveEnhancedTerminal(true);
    expect(readEnhancedTerminal()).toBe(true);
  });

  it("脏值（既不是 0 也不是 1）→ 开启：宁可多给功能，也不能让功能凭空消失", () => {
    window.localStorage.setItem(ENHANCED_TERMINAL_KEY, "yes");
    expect(readEnhancedTerminal()).toBe(true);
  });
});
