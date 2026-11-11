import { describe, expect, it } from "vitest";

// provider 生成 notice 时可能用 i18n.t（未命中 key 原样返回）—— 初始化保证插值可用。
import "@/i18n";

import { parseLine } from "../../path-input";
import type { CompletionContext, ParsedLine } from "../../types";
import { createCommandProvider } from "../command";

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

describe("command name completion", () => {
  it("`unz` 的第一条就是 `unzip`（输入法式前缀补全）", async () => {
    expect((await labels("unz"))[0]).toBe("unzip");
  });

  it("`cd` 也能补出命令名，且插入文本带尾随空格", async () => {
    const context = ctx("cd");
    const result = await provider.complete(context, parsed(context));
    const item = result.items.find((entry) => entry.label === "cd")!;
    expect(item.insertText).toBe("cd ");
  });

  it("拼错一个字符也能纠回来（unizp → unzip）", async () => {
    expect(await labels("unizp")).toContain("unzip");
  });

  it("带 / 的输入（路径）不归它管", () => {
    expect(provider.matches(parsed(ctx("./deploy.sh")))).toBe(false);
    expect(provider.matches(parsed(ctx("/etc/nginx")))).toBe(false);
  });

  it("参数位不归它管：`unzip ` 交给文件补全", () => {
    expect(provider.matches(parsed(ctx("unzip ")))).toBe(false);
    expect(provider.matches(parsed(ctx("tar -xf ")))).toBe(false);
  });

  it("空命令词不接管，避免一上来糊一屏", () => {
    expect(provider.matches(parsed(ctx("")))).toBe(false);
  });
});
