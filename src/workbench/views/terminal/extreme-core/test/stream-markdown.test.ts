import { describe, expect, it } from "vitest";
import { splitStreamingMarkdown } from "../stream-markdown";

/** 代码围栏是否都成对（切点落在未闭合围栏里就会被判出来）。 */
function fencesBalanced(text: string): boolean {
  const markers = text.match(/^[ \t]{0,3}(?:`{3,}|~{3,})[^\n]*$/gm) ?? [];
  return markers.length % 2 === 0;
}

const SAMPLES: { name: string; text: string }[] = [
  { name: "一句话还没成块", text: "我先看一下这台机器的状态" },
  { name: "两个段落", text: "第一段。\n\n第二段还在写" },
  {
    name: "闭合的代码块后面还有正文",
    text: "先跑一次：\n\n```bash\nuname -a\nls -la\n```\n\n然后看输出",
  },
  { name: "未闭合的代码块", text: "先跑一次：\n\n```bash\nuname -a\nls -l" },
  { name: "没有任何正文的未闭合围栏", text: "```\nuname -a" },
  { name: "代码块内部有空行", text: "```\na\n\nb\n```" },
  { name: "代码块内部有空行、后面接正文", text: "```\na\n\nb\n```\n\n正在写" },
  { name: "开头就是空行", text: "\n\n第一段" },
  { name: "列表块", text: "1. 第一步\n2. 第二步\n\n下一步要做的是" },
  { name: "波浪线围栏", text: "~~~\ncode\n~~~\n\n后面" },
  { name: "围栏里出现语言名不算闭合", text: "```\n正文\n```js\n还在代码块里" },
];

describe("流式 Markdown 切分", () => {
  for (const sample of SAMPLES) {
    it(`${sample.name}：stable + tail 恒等于原文`, () => {
      const { stable, tail } = splitStreamingMarkdown(sample.text);
      expect(stable + tail).toBe(sample.text);
    });

    it(`${sample.name}：切点不落在半个代码块里`, () => {
      const { stable } = splitStreamingMarkdown(sample.text);
      expect(fencesBalanced(stable), `stable:\n${stable}`).toBe(true);
    });

    it(`${sample.name}：stable 以块边界结尾`, () => {
      const { stable } = splitStreamingMarkdown(sample.text);
      if (stable === "") return;
      // 段末空行，或者刚好一个闭合围栏的收尾。
      expect(stable.endsWith("\n\n") || /(?:```|~~~)[ \t]*$/.test(stable)).toBe(true);
    });
  }

  it("没有完整块时 stable 为空", () => {
    expect(splitStreamingMarkdown("半句话")).toEqual({ stable: "", tail: "半句话" });
    expect(splitStreamingMarkdown("")).toEqual({ stable: "", tail: "" });
  });

  it("未闭合的围栏整块留在 tail", () => {
    const text = "结论如下：\n\n```bash\nuname -a";
    const { stable, tail } = splitStreamingMarkdown(text);
    expect(stable).toBe("结论如下：\n\n");
    expect(tail).toBe("```bash\nuname -a");
    expect(stable).not.toContain("```");
  });

  it("闭合围栏之后的正文重新开始累积", () => {
    const text = "```\ncode\n```\n\n新的段落";
    expect(splitStreamingMarkdown(text).stable).toBe("```\ncode\n```\n\n");
  });
});
