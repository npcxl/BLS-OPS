import { describe, expect, it } from "vitest";

import en from "../locales/en";
import zhCN from "../locales/zh-CN";

/**
 * 直接写在 `t("...")` / `i18n.t("...")` 里的 key 的机械复查。
 *
 * 中文界面缺英文 key 的译文时会回退成英文（截图里的 Reasoning effort /
 * Enabled），所以这里把所有**英文 natural key** 与 `zh-CN` 对照，缺一条就失败。
 * 中文 key 由 i18next 原样返回，不在本检查范围内。
 */
const DIRECT_KEY =
  /\b(?:i18n\.)?t\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g;
const CJK = /[\u3400-\u9fff]/;

/** 源码里的 `\"` / `\n` 是转义写法；i18next 的 key 是转义后的真实字符串。 */
function unescapeKey(value: string): string {
  return value.replace(/\\(["'`\\nrt])/g, (_, code: string) => {
    if (code === "n") return "\n";
    if (code === "r") return "\r";
    if (code === "t") return "\t";
    return code;
  });
}

const SOURCES: Record<string, string> = import.meta.glob("../../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

function isSource(path: string): boolean {
  if (!path.startsWith("../../")) return false;
  return !path.includes("/test/") && !path.endsWith(".test.ts") && !path.endsWith(".test.tsx");
}

function directKeysInSource(): { key: string; file: string }[] {
  const found: { key: string; file: string }[] = [];
  for (const [path, text] of Object.entries(SOURCES)) {
    if (!isSource(path)) continue;
    for (const match of text.matchAll(DIRECT_KEY)) {
      const raw = match[1] ?? match[2] ?? match[3];
      const key = raw ? unescapeKey(raw) : "";
      // 模板插值 / 只含标点的 key 不是可对照的静态文案。
      if (key && !key.includes("${") && /[A-Za-z]/.test(key)) found.push({ key, file: path });
    }
  }
  return found;
}

describe("直接 t() key（英文 key 必须有中文译文）", () => {
  it("扫描本体有效", () => {
    expect(directKeysInSource().length).toBeGreaterThan(100);
  });

  it("每个英文 key 都在 zh-CN 里有译文", () => {
    const missing = directKeysInSource()
      .filter(({ key }) => !CJK.test(key) && !(key in zhCN))
      .map(({ key, file }) => `${key}   →  ${file}`);

    expect(missing, `以下英文 key 缺 zh-CN 译文：\n${[...new Set(missing)].join("\n")}`).toEqual(
      [],
    );
  });

  it("中文 key 在英文界面有覆盖", () => {
    const missing = directKeysInSource()
      .filter(({ key }) => CJK.test(key) && !(key in en))
      .map(({ key, file }) => `${key}   →  ${file}`);

    expect(missing, `以下中文 key 缺英文译文：\n${[...new Set(missing)].join("\n")}`).toEqual([]);
  });
});
