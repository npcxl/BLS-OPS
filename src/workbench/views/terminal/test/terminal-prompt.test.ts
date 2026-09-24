import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  COMPACT_PROMPT_COMMAND,
  COMPACT_PROMPT_KEY,
  readCompactPrompt,
  saveCompactPrompt,
} from "../terminal-prompt";

afterEach(() => {
  window.localStorage.removeItem(COMPACT_PROMPT_KEY);
});

describe("compact prompt preference", () => {
  beforeEach(() => {
    window.localStorage.removeItem(COMPACT_PROMPT_KEY);
  });

  it("默认关 —— 读不到 / 脏值都按关闭处理（不擅自改远程会话）", () => {
    expect(readCompactPrompt()).toBe(false);
    window.localStorage.setItem(COMPACT_PROMPT_KEY, "yes");
    expect(readCompactPrompt()).toBe(false);
    window.localStorage.setItem(COMPACT_PROMPT_KEY, "0");
    expect(readCompactPrompt()).toBe(false);
  });

  it("开关能存能读", () => {
    saveCompactPrompt(true);
    expect(window.localStorage.getItem(COMPACT_PROMPT_KEY)).toBe("1");
    expect(readCompactPrompt()).toBe(true);
    saveCompactPrompt(false);
    expect(readCompactPrompt()).toBe(false);
  });
});

describe("injected command", () => {
  it("用 $BASH_VERSION 门控 —— zsh / dash / fish 下一个字都不会写进去", () => {
    expect(COMPACT_PROMPT_COMMAND).toContain('[ -n "$BASH_VERSION" ]');
    expect(COMPACT_PROMPT_COMMAND).toContain("&&");
  });

  it("前导空格：HISTCONTROL=ignorespace 下不进 shell 历史", () => {
    expect(COMPACT_PROMPT_COMMAND.startsWith(" ")).toBe(true);
  });

  it("提示符只留当前目录 + root 标记（\\W / \\$）", () => {
    expect(COMPACT_PROMPT_COMMAND).toContain("\\W");
    expect(COMPACT_PROMPT_COMMAND).toContain("\\$");
    // `\w`（完整路径）绝不能出现在里面 —— 那正是用户要去掉的东西。
    expect(COMPACT_PROMPT_COMMAND).not.toMatch(/\\w/);
  });

  it("顺带上报 OSC 7（拿权威 cwd），且非打印序列用 \\[ \\] 包住", () => {
    expect(COMPACT_PROMPT_COMMAND).toContain("\\e]7;file://");
    expect(COMPACT_PROMPT_COMMAND).toContain("$PWD");
    // 没有 \[ \] 包裹时 readline 会按宽度算错光标，退格 / 换行全乱。
    expect(COMPACT_PROMPT_COMMAND).toContain("\\[");
    expect(COMPACT_PROMPT_COMMAND).toContain("\\]");
  });

  it("整条命令里没有单引号 —— 否则 PS1='…' 会被提前闭合", () => {
    // 去掉包裹 PS1 值的那对单引号后，不应该再有单引号。
    const withoutWrapping = COMPACT_PROMPT_COMMAND.replace(/PS1='.*'$/, "PS1=");
    expect(withoutWrapping).not.toContain("'");
  });
});
