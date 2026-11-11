import { describe, expect, it } from "vitest";

import "@/i18n";

import { parseLine } from "../completion/path-input";
import type { CompletionContext, ParsedLine } from "../completion/types";
import { createCommandProvider } from "../completion/providers/command";
import { resolveTerminalCompleteKey } from "../terminal-suggest";

/**
 * 输入法式补全：面板可见时按 1-9 直接选第 N 条，以及缩写（子序列）匹配。
 *
 * 这两条是用户明确要的交互（"敲 doc 立刻列出候选，选 1 就把 doc 换成 docker"），
 * 与旧的"只在 Tab 后出现面板"是两套语义，单独成文件防止被旧的断言带走。
 */

const provider = createCommandProvider();

function ctx(line: string): CompletionContext {
  return { line, cursor: line.length, sessionId: "s1", cwd: "/root", home: "/root" };
}

function parsed(context: CompletionContext): ParsedLine {
  return parseLine(context.line, context.cursor);
}

async function labels(line: string): Promise<string[]> {
  const context = ctx(line);
  const result = await provider.complete(context, parsed(context));
  return result.items.map((item) => item.label);
}

describe("数字键选择（输入法式）", () => {
  it("面板展开时 1-9 选中对应序号", () => {
    const base = { expanded: true, hasItems: true, itemCount: 5 };
    expect(resolveTerminalCompleteKey({ key: "1" }, base)).toEqual({
      type: "accept-index",
      index: 0,
    });
    expect(resolveTerminalCompleteKey({ key: "3" }, base)).toEqual({
      type: "accept-index",
      index: 2,
    });
  });

  it("序号超出候选数时不接管（数字照常发给 shell）", () => {
    const base = { expanded: true, hasItems: true, itemCount: 2 };
    expect(resolveTerminalCompleteKey({ key: "5" }, base)).toEqual({ type: "none" });
    expect(resolveTerminalCompleteKey({ key: "0" }, base)).toEqual({ type: "none" });
  });

  it("面板收起时不接管数字：`docker logs 1` 里的 1 不能被吃掉", () => {
    expect(
      resolveTerminalCompleteKey({ key: "1" }, { expanded: false, hasItems: true, itemCount: 5 }),
    ).toEqual({ type: "none" });
  });

  it("输入法组合中（IME）不抢数字", () => {
    expect(
      resolveTerminalCompleteKey(
        { key: "1", isComposing: true },
        { expanded: true, hasItems: true, itemCount: 5 },
      ),
    ).toEqual({ type: "none" });
  });
});

describe("缩写匹配（子序列）", () => {
  it("`dc` 能补出 docker 这类长命令", async () => {
    // d…c 是 docker 的子序列；首字符相同才允许，所以不会放进来一堆噪音。
    expect(await labels("dc")).toContain("docker");
  });

  it("`dkr` 同样命中 docker（跳字缩写）", async () => {
    // d…k…r 都在 docker 里按序出现，中间跳过的字符不影响。
    expect(await labels("dkr")).toContain("docker");
  });

  it("首字符不同就不做缩写匹配（`kc` 不该冒出 docker）", async () => {
    expect(await labels("kc")).not.toContain("docker");
  });

  it("前缀命中仍然排在最前面", async () => {
    // `doc` 既是 docker 的前缀，也是它的子序列：前缀优先级更高。
    expect((await labels("doc"))[0]).toBe("docker");
  });
});
