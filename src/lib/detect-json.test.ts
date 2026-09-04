import { describe, expect, it } from "vitest";
import { detectJson, detectJsonOutput, MAX_JSON_DETECT_CHARS } from "./detect-json";

describe("detectJson — 严格 JSON / JSONL（数据完整）", () => {
  it("整段合法 JSON 对象 → json", () => {
    const out = detectJson('{"a":1,"b":"x"}');
    expect(out).toEqual({ kind: "json", value: { a: 1, b: "x" } });
  });

  it("多行格式化 JSON 对象/数组 → json（整体解析）", () => {
    const pretty = '{\n  "status": "ok",\n  "items": [1, 2]\n}';
    const out = detectJson(pretty);
    expect(out?.kind).toBe("json");
    expect((out as { value: unknown }).value).toEqual({
      status: "ok",
      items: [1, 2],
    });
  });

  it("每行都是合法 JSON 的 JSONL → jsonl，保留全部行", () => {
    const out = detectJson('{"a":1}\n{"a":2}\n{"a":3}');
    expect(out?.kind).toBe("jsonl");
    expect((out as { value: unknown[] }).value).toHaveLength(3);
  });

  it("JSONL 允许空行（结构空行不算坏行）", () => {
    const out = detectJson('{"a":1}\n\n{"a":2}\n');
    expect(out?.kind).toBe("jsonl");
    expect((out as { value: unknown[] }).value).toHaveLength(2);
  });

  it("JSONL 只要有一行解析失败 → 整体 null，绝无部分解析", () => {
    // “正在连接……”与末尾 warning 都不能被悄悄丢掉
    expect(detectJson('正在连接……\n{"status":"ok"}')).toBeNull();
    expect(detectJson('{"a":1}\n{"a":2}\nbroken\n')).toBeNull();
    expect(detectJson('{"ok":true}\nwarning: timeout\n')).toBeNull();
  });

  it("单行但非法 → null", () => {
    expect(detectJson("this is not json")).toBeNull();
    expect(detectJson("[1, 2")).toBeNull();
  });

  it("空 / 纯空白 → null", () => {
    expect(detectJson("")).toBeNull();
    expect(detectJson("   \n  ")).toBeNull();
  });

  it("超长文本不做解析 → null", () => {
    const huge = `"${"a".repeat(MAX_JSON_DETECT_CHARS)}"`;
    expect(detectJson(huge)).toBeNull();
  });

  it("jsonl 值本身是数组/对象均可（docker --format json 形态）", () => {
    const out = detectJson('{"Image":"nginx","State":"running"}\n{"Image":"redis","State":"exited"}');
    expect(out?.kind).toBe("jsonl");
  });
});

describe("detectJsonOutput — 剥离 prompt+命令回显行后检测", () => {
  it("快照首行为 prompt + 命令回显 → 剥离后识别出 JSON", () => {
    const text = "user@host:~$ cat app.json\n{\"a\":1}\n";
    const out = detectJsonOutput(text, "cat app.json");
    expect(out).toEqual({ kind: "json", value: { a: 1 } });
  });

  it("首行不是该命令回显 → 按整段文本严格检测", () => {
    const text = "{\n  \"a\": 1\n}";
    const out = detectJsonOutput(text, "cat app.json");
    expect(out?.kind).toBe("json");
  });

  it("输出带非 JSON 行（即使回显行剥掉）→ null", () => {
    const text = "user@host:~$ docker ps\n{\"a\":1}\nwarning: timeout\n";
    expect(detectJsonOutput(text, "docker ps")).toBeNull();
  });

  it("空命令 / 无命令信息 → 直接按整段检测", () => {
    expect(detectJsonOutput('{"a":1}', "")).toEqual({ kind: "json", value: { a: 1 } });
  });
});
