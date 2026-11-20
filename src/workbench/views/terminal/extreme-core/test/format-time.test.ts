import { describe, expect, it } from "vitest";
import { chatTime, dayTime, durationText, previewSnippet, validTime } from "../format-time";

/**
 * 时间展示是纯函数：固定 now，断言今天/昨天/更早三档与无效值兜底。
 * t 用"键+参数拼接"的假翻译：只验证走了哪个词条，不依赖 i18n 初始化。
 */
const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key;

// 2026-11-18 14:01（本地时区构造，避免测试机上 UTC 偏移影响"同一天"判断）
const NOW = new Date(2026, 10, 18, 14, 1).getTime();
const TODAY = new Date(2026, 10, 18, 9, 5).getTime();
const YESTERDAY = new Date(2026, 10, 17, 23, 59).getTime();
const OLDER = new Date(2026, 10, 16, 8, 0).getTime();
const LAST_YEAR = new Date(2025, 0, 2, 7, 3).getTime();

describe("chatTime（气泡署名行）", () => {
  it("今天只给时分", () => {
    expect(chatTime(TODAY, t, NOW)).toBe("09:05");
  });
  it("昨天带词条前缀", () => {
    expect(chatTime(YESTERDAY, t, NOW)).toBe('昨天 {{time}}:{"time":"23:59"}');
  });
  it("更早用数字日期，跨年也带年份", () => {
    expect(chatTime(OLDER, t, NOW)).toBe("2026/11/16 08:00");
    expect(chatTime(LAST_YEAR, t, NOW)).toBe("2025/01/02 07:03");
  });
  it("缺失/损坏的时间戳返回空串（界面据此不显示）", () => {
    expect(chatTime(undefined, t, NOW)).toBe("");
    expect(chatTime(0, t, NOW)).toBe("");
    expect(chatTime(Number.NaN, t, NOW)).toBe("");
  });
});

describe("dayTime（左栏预览卡）", () => {
  it("今天用「今天」词条", () => {
    expect(dayTime(TODAY, t, NOW)).toBe('今天 {{time}}:{"time":"09:05"}');
  });
  it("昨天与更早和气泡口径一致", () => {
    expect(dayTime(YESTERDAY, t, NOW)).toBe('昨天 {{time}}:{"time":"23:59"}');
    expect(dayTime(OLDER, t, NOW)).toBe("2026/11/16 08:00");
  });
});

describe("validTime", () => {
  it("只接受正的有限数", () => {
    expect(validTime(1)).toBe(true);
    expect(validTime(undefined)).toBe(false);
    expect(validTime(0)).toBe(false);
    expect(validTime(-5)).toBe(false);
    expect(validTime(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("durationText（执行耗时）", () => {
  it("秒级只给秒，四舍五入且至少 1 秒", () => {
    expect(durationText(400, t)).toBe('{{n}} 秒:{"n":1}');
    expect(durationText(12_400, t)).toBe('{{n}} 秒:{"n":12}');
  });
  it("分钟级带秒；整分钟不带 0 秒", () => {
    expect(durationText(65_000, t)).toBe('{{m}} 分 {{s}} 秒:{"m":1,"s":5}');
    expect(durationText(120_000, t)).toBe('{{m}} 分钟:{"m":2}');
  });
  it("小时级带分钟", () => {
    expect(durationText(3_600_000, t)).toBe('{{h}} 小时:{"h":1}');
    expect(durationText(7_800_000, t)).toBe('{{h}} 小时 {{m}} 分:{"h":2,"m":10}');
  });
  it("无效 / 非正数返回空串（界面不显示）", () => {
    expect(durationText(0, t)).toBe("");
    expect(durationText(-1, t)).toBe("");
    expect(durationText(Number.NaN, t)).toBe("");
  });
});

describe("previewSnippet（预览卡摘要）", () => {
  it("取最后一条有正文的消息", () => {
    const messages = [{ text: "第一问" }, { text: "" }, { text: "最后的回答" }];
    expect(previewSnippet(messages)).toBe("最后的回答");
  });
  it("压掉 Markdown 噪声与换行", () => {
    const messages = [{ text: "# 标题\n\n- **要点** `code`\n```sh\nls -la\n```" }];
    expect(previewSnippet(messages)).toBe("标题 - 要点 code");
  });
  it("超长截断并加省略号", () => {
    const messages = [{ text: "a".repeat(200) }];
    const snippet = previewSnippet(messages, 160);
    expect(snippet.length).toBe(161);
    expect(snippet.endsWith("…")).toBe(true);
  });
  it("全空返回空串（卡片不显示摘要行）", () => {
    expect(previewSnippet([])).toBe("");
    expect(previewSnippet([{ text: "  " }, { text: "###" }])).toBe("");
  });
});
