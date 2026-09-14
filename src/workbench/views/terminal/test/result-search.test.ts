import { describe, expect, it } from "vitest";
import {
  countHits,
  findRanges,
  normalizeQuery,
  segmentLine,
} from "../result-search";

describe("normalizeQuery", () => {
  it("去空白 + 转小写", () => {
    expect(normalizeQuery("  Nginx  ")).toBe("nginx");
    expect(normalizeQuery("")).toBe("");
    expect(normalizeQuery("   ")).toBe("");
  });
});

describe("findRanges", () => {
  it("空查询/空行不命中", () => {
    expect(findRanges("anything", "")).toEqual([]);
    expect(findRanges("anything", "   ")).toEqual([]);
    expect(findRanges("", "a")).toEqual([]);
  });

  it("大小写不敏感，返回非重叠区间", () => {
    expect(findRanges("Nginx nginx NGINX", "nginx")).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 12, end: 17 },
    ]);
  });

  it("needle 自身重叠时不漏配（aa 在 aaaa 里是两处）", () => {
    // indexOf 按 needle 长度步进会只找到一处，逐字符推进才对。
    expect(findRanges("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it("无命中返回空数组；中文正常处理", () => {
    expect(findRanges("nginx", "zzz")).toEqual([]);
    expect(findRanges("生产环境服务器", "环境")).toEqual([{ start: 2, end: 4 }]);
  });
});

describe("segmentLine", () => {
  it("无命中时整行一段（hit=false，原文不改）", () => {
    expect(segmentLine("nginx is running", "zzz")).toEqual([
      { text: "nginx is running", hit: false },
    ]);
  });

  it("空查询时整行一段", () => {
    expect(segmentLine("docker ps", "")).toEqual([{ text: "docker ps", hit: false }]);
  });

  it("命中在行首/行中/行尾都正确切片，顺序与原文一致", () => {
    expect(segmentLine("abcNginxdefgnginxhi", "nginx")).toEqual([
      { text: "abc", hit: false },
      { text: "Nginx", hit: true },
      { text: "defg", hit: false },
      { text: "nginx", hit: true },
      { text: "hi", hit: false },
    ]);
  });

  it("整行命中时只有一段 hit", () => {
    expect(segmentLine("nginx", "NGINX")).toEqual([{ text: "nginx", hit: true }]);
  });

  it("相邻命中不留空段", () => {
    expect(segmentLine("nginxnginx", "nginx")).toEqual([
      { text: "nginx", hit: true },
      { text: "nginx", hit: true },
    ]);
  });

  it("拼接所有片段恒等于原文（绝不篡改内容）", () => {
    const line = "  CONTAINER ID   IMAGE   nginx:latest  ";
    for (const query of ["nginx", "id", "  ", "zzz"]) {
      const joined = segmentLine(line, query)
        .map((segment) => segment.text)
        .join("");
      expect(joined).toBe(line);
    }
  });
});

describe("countHits", () => {
  it("统计所有行的命中总数（不是命中行数）", () => {
    const lines = ["nginx nginx", "no match here", "NGINX", ""];
    expect(countHits(lines, "nginx")).toBe(3);
  });

  it("空查询为 0，不把所有行都算命中", () => {
    expect(countHits(["a", "b"], "")).toBe(0);
    expect(countHits(["a", "b"], "  ")).toBe(0);
  });

  it("无命中为 0", () => {
    expect(countHits(["a", "b"], "zzz")).toBe(0);
  });
});
