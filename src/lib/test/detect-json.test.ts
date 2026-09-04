import { describe, expect, it } from "vitest";
import { detectJson, detectJsonOutput, MAX_JSON_DETECT_CHARS } from "../detect-json";

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

/**
 * 快照的结束边界是 buffer 末尾 —— 命令跑完后 shell **立刻**打印的下一个
 * 提示符也在里面。严格检测是整段 parse，多这一行就整体失败，
 * `docker inspect` / `docker ps --format json` 的 JSON Tab 于是不出现。
 */
describe("detectJsonOutput — 剥离尾部的下一个提示符", () => {
  const PROMPT = "root@lavm-er0ycrgnld:~#";

  it("尾部提示符会让整段 JSON 检测失败（修复前的真实症状）", () => {
    const body = '[\n    {\n        "Id": "31ea",\n        "Name": "/bls-server"\n    }\n]';
    // 不剥提示符 → 整段 parse 必然失败 → JSON Tab 不出现。
    expect(detectJson(`${body}\n${PROMPT} `)).toBeNull();
  });

  it("剥掉尾部提示符后，`docker inspect` 的多行 JSON 能被识别", () => {
    const body = '[\n    {\n        "Id": "31ea",\n        "Name": "/bls-server"\n    }\n]';
    const text = `${PROMPT} docker inspect bls-server\n${body}\n${PROMPT} `;
    const out = detectJsonOutput(text, "docker inspect bls-server");
    expect(out?.kind).toBe("json");
    expect(out?.value).toEqual([{ Id: "31ea", Name: "/bls-server" }]);
  });

  it("提示符后已经输入了下一条命令，也照样剥掉", () => {
    const text = `${PROMPT} docker ps --format json\n{"Image":"nginx"}\n${PROMPT} ls -l`;
    const out = detectJsonOutput(text, "docker ps --format json");
    expect(out?.kind).toBe("json");
  });

  it("只剥最后一行 —— 输出中间的内容一个字节都不动", () => {
    // JSON 里含有与提示符同形的字符串？不可能，但输出里的普通行绝不能被剥。
    const body = '{\n  "note": "keep me",\n  "tail": 2\n}';
    const text = `${PROMPT} cat a.json\n${body}\n${PROMPT} `;
    const out = detectJsonOutput(text, "cat a.json") as { value: Record<string, unknown> };
    expect(out.value.note).toBe("keep me");
    expect(out.value.tail).toBe(2);
  });

  it("最后一行的确是输出时（不是提示符）→ 不剥，该失败就失败", () => {
    const text = `${PROMPT} docker ps\n{"a":1}\nwarning: timeout`;
    expect(detectJsonOutput(text, "docker ps")).toBeNull();
  });

  it("PS1 为空（裸命令，首行就是命令本身）→ 不剥，行为不变", () => {
    const text = 'docker ps\n{"a":1}\n{"a":2}';
    // 首行以命令结尾 → 剥掉首行；PS1 为空 → 尾部不剥。
    const out = detectJsonOutput(text, "docker ps");
    expect(out?.kind).toBe("jsonl");
  });

  it("JSONL 输出后面跟着提示符也能识别", () => {
    const text =
      `${PROMPT} docker ps --format json\n` +
      '{"Image":"nginx","State":"running"}\n{"Image":"redis","State":"exited"}\n' +
      `${PROMPT} `;
    const out = detectJsonOutput(text, "docker ps --format json");
    expect(out?.kind).toBe("jsonl");
    expect((out as { value: unknown[] }).value).toHaveLength(2);
  });

  it("末尾有多个空行时仍能剥到提示符", () => {
    const text = `${PROMPT} cat a.json\n{"a":1}\n\n\n${PROMPT} `;
    const out = detectJsonOutput(text, "cat a.json");
    expect(out).toEqual({ kind: "json", value: { a: 1 } });
  });
});
