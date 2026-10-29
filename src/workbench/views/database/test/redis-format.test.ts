import { describe, expect, it } from "vitest";
import type { DatabaseProfile, RedisFieldEntry, RedisKeyBrief, RedisPubSubEvent } from "@/api/types/database";
import {
  TTL_PRESETS,
  decodePubsubMessage,
  formatTtl,
  initialDbIndex,
  kindBadgeClass,
  mergeHashFields,
  mergeKeyPage,
} from "../redis-format";

/** 构造一个最小键条目；kind 决定列表徽标颜色。 */
function brief(key: string, kind = "string", ttlMs = -1): RedisKeyBrief {
  return { key, kind, ttl_ms: ttlMs };
}

/** 构造 hash 字段行。 */
function field(name: string, value: string): RedisFieldEntry {
  return { field: name, value };
}

/** 与 Rust 侧 base64 crate 对齐：按 UTF-8 字节编码（btoa 只吃 Latin1）。 */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary);
}

describe("Redis 键列表合并（SCAN 异步竞态防线）", () => {
  it("首页 reset 直接替换旧列表，不残留上一个 db 的键", () => {
    const stale = [brief("old:1"), brief("old:2")];
    const merged = mergeKeyPage(stale, [brief("new:1")], true);
    expect(merged.map((entry) => entry.key)).toEqual(["new:1"]);
  });

  it("续扫 append 保留已有键", () => {
    const first = mergeKeyPage([], [brief("a"), brief("b")], true);
    const merged = mergeKeyPage(first, [brief("c")], false);
    expect(merged.map((entry) => entry.key)).toEqual(["a", "b", "c"]);
  });

  it("同一键重复到达只保留一次——双击继续扫描不产生重复行", () => {
    const first = mergeKeyPage([], [brief("a"), brief("b")], true);
    const merged = mergeKeyPage(first, [brief("b"), brief("c")], false);
    expect(merged.map((entry) => entry.key)).toEqual(["a", "b", "c"]);
  });

  it("整页与已有键完全重叠时列表不增长", () => {
    const first = mergeKeyPage([], [brief("a"), brief("b")], true);
    const merged = mergeKeyPage(first, [brief("a"), brief("b")], false);
    expect(merged).toHaveLength(2);
  });
});

describe("hash 分页合并（HSCAN 续扫防线）", () => {
  it("续扫按字段名去重，同字段的新值不重复入列", () => {
    const first = mergeHashFields([], [field("f1", "v1"), field("f2", "v2")]);
    const merged = mergeHashFields(first, [field("f2", "v2-dup"), field("f3", "v3")]);
    expect(merged.map((entry) => entry.field)).toEqual(["f1", "f2", "f3"]);
  });

  it("空续扫页不改变现有行", () => {
    const first = mergeHashFields([], [field("f1", "v1")]);
    expect(mergeHashFields(first, [])).toEqual(first);
  });
});

describe("TTL 展示", () => {
  it("永久键显示 ∞", () => {
    expect(formatTtl(-1)).toBe("∞");
  });

  it("无 TTL 的负值显示 —", () => {
    expect(formatTtl(-2)).toBe("—");
  });

  it("按量级换算 s/m/h/d", () => {
    expect(formatTtl(30_000)).toBe("30s");
    expect(formatTtl(5 * 60_000)).toBe("5m");
    expect(formatTtl(3 * 3_600_000)).toBe("3h");
    expect(formatTtl(2 * 86_400_000)).toBe("2d");
  });

  it("快捷预设与后端约定一致：毫秒值正确，∞ 表示 PERSIST", () => {
    expect(TTL_PRESETS.map((preset) => preset.label)).toEqual(["1h", "24h", "7d", "∞"]);
    expect(TTL_PRESETS[0].ms).toBe(3_600_000);
    expect(TTL_PRESETS[2].ms).toBe(604_800_000);
    expect(TTL_PRESETS[3].ms).toBeNull();
  });
});

describe("类型徽标", () => {
  it("六种已知类型都有专属配色", () => {
    for (const kind of ["string", "hash", "list", "set", "zset", "stream"]) {
      expect(kindBadgeClass(kind)).not.toBe(kindBadgeClass("unknown-kind"));
    }
  });

  it("未知类型回退到 other 配色而不是崩溃", () => {
    expect(kindBadgeClass("ReJSON-RL")).toBe(kindBadgeClass("whatever"));
    expect(kindBadgeClass("ReJSON-RL")).toContain("bg-surface-hover");
  });
});

describe("db index 解析", () => {
  it("合法配置（0-15 的整数字符串）原样使用", () => {
    expect(initialDbIndex({ default_database: "3" })).toBe(3);
    expect(initialDbIndex({ default_database: "15" })).toBe(15);
  });

  it("未配置回退 db 0", () => {
    expect(initialDbIndex({ default_database: null })).toBe(0);
    expect(initialDbIndex({ default_database: undefined })).toBe(0);
  });

  it("越界或非法值回退 db 0，绝不越界 SELECT", () => {
    expect(initialDbIndex({ default_database: "16" })).toBe(0);
    expect(initialDbIndex({ default_database: "-1" })).toBe(0);
    expect(initialDbIndex({ default_database: "abc" })).toBe(0);
    expect(initialDbIndex({ default_database: "2.5" })).toBe(0);
  });
});

describe("pub/sub 消息解码（Base64 无损还原）", () => {
  it("文本消息经 Base64 还原为原文", () => {
    const event: RedisPubSubEvent = {
      event: "message",
      subId: "s1",
      channel: "ch",
      messageBase64: toBase64("hello 你好"),
    };
    expect(decodePubsubMessage(event)).toBe("hello 你好");
  });

  it("真二进制消息不崩溃，回退显示 Base64 原文供复制还原", () => {
    const event: RedisPubSubEvent = {
      event: "message",
      subId: "s1",
      channel: "ch",
      // 原始字节 [0xFF, 0xFE, 0x00] 的 Base64（"//4A"）：
      // 这三个字节不是合法 UTF-8，严格解码必须抛错并回退。
      messageBase64: "//4A",
    };
    expect(decodePubsubMessage(event)).toBe("base64: //4A");
  });

  it("系统事件（错误/关闭）直接取 message 字段", () => {
    const event: RedisPubSubEvent = {
      event: "error",
      subId: "s1",
      message: "连接已断开",
    };
    expect(decodePubsubMessage(event)).toBe("连接已断开");
  });

  it("两者都缺失时返回空串", () => {
    expect(decodePubsubMessage({ event: "closed", subId: "s1" })).toBe("");
  });
});

describe("db 配置边界（防止误用 SQL 配置跑 Redis）", () => {
  it("profile 的 default_database 允许是空串之外的任意脏值而不抛错", () => {
    const profile = { default_database: "  " } as Pick<DatabaseProfile, "default_database">;
    // 空白串 Number("  ") = 0，属合法 db 0。
    expect(initialDbIndex(profile)).toBe(0);
  });
});
