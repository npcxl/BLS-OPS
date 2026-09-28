import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  COMPACT_PROMPT_INPUT,
  COMPACT_PROMPT_KEY,
  COMPACT_PROMPT_LINE,
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

  it("默认开 —— 读不到 / 脏值一律按开启处理（只有主动关过才关）", () => {
    // 老用户 localStorage 里根本没有这个键：升级后必须**直接**是短提示符，
    // 否则"连上就该是短的"这条需求等于没做（用户为此提过多次）。
    expect(readCompactPrompt()).toBe(true);
    // 脏值同样按开处理（宁可精简，也不要因为脏数据退回长提示符）。
    window.localStorage.setItem(COMPACT_PROMPT_KEY, "yes");
    expect(readCompactPrompt()).toBe(true);
    // 只有用户明确关过才关。
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
    expect(COMPACT_PROMPT_LINE).toContain('[ -n "$BASH_VERSION" ]');
    expect(COMPACT_PROMPT_LINE).toContain("&&");
  });

  it("前导空格：HISTCONTROL=ignorespace 下不进 shell 历史", () => {
    expect(COMPACT_PROMPT_LINE.startsWith(" ")).toBe(true);
  });

  it("提示符只留当前路径 + root 标记（\\w / \\$）", () => {
    expect(COMPACT_PROMPT_LINE).toContain("\\w");
    expect(COMPACT_PROMPT_LINE).toContain("\\$");
    // `\W`（只给末级目录名：`/opt` → `opt`）绝不能出现 —— 用户看不出自己在
    // 哪一层，只会当成乱码。
    expect(COMPACT_PROMPT_LINE).not.toMatch(/\\W/);
  });

  it("顺带上报 OSC 7（拿权威 cwd），且非打印序列用 \\[ \\] 包住", () => {
    expect(COMPACT_PROMPT_LINE).toContain("\\e]7;file://");
    expect(COMPACT_PROMPT_LINE).toContain("$PWD");
    // 没有 \[ \] 包裹时 readline 会按宽度算错光标，退格 / 换行全乱。
    expect(COMPACT_PROMPT_LINE).toContain("\\[");
    expect(COMPACT_PROMPT_LINE).toContain("\\]");
  });

  it("PS1 值本身没有单引号 —— 否则 PS1='…' 会被提前闭合", () => {
    // 非贪婪：后面 `printf '…'` 还有一对单引号，贪婪会把它们一起吞进来。
    const value = /PS1='(.*?)'/.exec(COMPACT_PROMPT_LINE)?.[1] ?? "";
    // 抽出来的是真正会被 bash 赋给 PS1 的那段值。
    expect(value).toContain("\\w");
    expect(value).not.toContain("'");
  });

  it("顺手擦掉服务器自己画的那行默认提示符（否则连上第一眼还是长提示符）", () => {
    // 回显连同它的换行都会被边界解析器吃掉 → 光标正停在服务器那行提示符的
    // 末尾；所以"擦整行 + 回行首"就够，**不做任何上下移动**，绝不吃掉上方的
    // 欢迎 / Last login 信息。
    expect(COMPACT_PROMPT_LINE).toContain("printf '\\033[2K\\r'");
    expect(COMPACT_PROMPT_LINE).not.toMatch(/\\033\[[0-9]*[AB]/);
    // 必须先改好 PS1 再擦（`&&` 链天然保证顺序，这里锁住它）。
    expect(COMPACT_PROMPT_LINE.indexOf("PS1='")).toBeLessThan(
      COMPACT_PROMPT_LINE.indexOf("printf"),
    );
  });

  it("长度小于边界解析器的 MAX_PARTIAL（128）—— 否则回显会在分块边界漏出来", () => {
    expect(COMPACT_PROMPT_LINE.length).toBeLessThan(128);
  });

  /**
   * 回归用例（真实事故）：只发 `LINE`（不带回车）时这行字不会被提交，而是赖在
   * 用户当前的输入行里，跟他敲的第一条命令粘成 `…PS1='…'ll` —— bash 把 `ll`
   * 拼进 PS1 字符串，于是命令没执行、提示符却变成 `opt# ll`。用户报的正是
   * "提示符自己多出两个字母，乱七八糟"。
   */
  it("发给终端的必须是带回车的 INPUT（少了回车会污染用户输入行）", () => {
    expect(COMPACT_PROMPT_INPUT.endsWith("\r")).toBe(true);
    expect(COMPACT_PROMPT_INPUT).toBe(`${COMPACT_PROMPT_LINE}\r`);
    // 剔除回显用的必须是不带回车的原行（终端回显里没有这一行的换行）。
    expect(COMPACT_PROMPT_LINE).not.toContain("\r");
  });
});
