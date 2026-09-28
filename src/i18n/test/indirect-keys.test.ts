import { describe, expect, it } from "vitest";

import zhCN from "../locales/zh-CN";

/**
 * 间接 key 的**机械化复查**。
 *
 * # 为什么需要它
 *
 * 项目里的约定是"模块级常量存英文 key，渲染处 `t(...)`"：
 *
 * ```ts
 * const TABS = [{ id: "basic_info", labelKey: "Basic info" }];  // 常量
 * ...
 * {t(item.labelKey)}                                           // 渲染
 * ```
 *
 * 这类 key **不写在 `t("...")` 里**，所以"正则扫 `t(\"...\")` 与语言文件 diff"
 * 的复查方式**永远看不到它们** —— 结果就是语言文件里整批缺失，界面中英混排
 * （真实事故：项目视图 4 个 Tab、候选卡状态徽标、服务分组徽标、角色标签全部
 * 没中文，用户报"我选择中文语言，还显示英文"）。
 *
 * 这个文件把"带 `*Key:` 后缀的字面量必须是真 key"变成断言，新增常量时漏翻会
 * 直接挂测试。
 *
 * # 已知覆盖不到的地方（故意写明白，别以为它会兜住一切）
 *
 * - `Record<枚举, string>` 值表（如 `classify.ts` 的分组标签）与函数返回的
 *   文案 —— 形状和普通数据完全一样，无法机械区分，新增时仍需手工补；
 * - 跨行书写的 key（`t(` 换行再写字符串）。
 */
const INDIRECT_KEY =
  /\b(?:labelKey|shortKey|hintKey|emptyKey|titleKey)\s*:\s*"([^"]+)"|\bempty\s*=\s*"([^"]+)"/g;

/**
 * 故意不翻译的 key —— 专有名词按原文显示才是对的
 * （`t("Kubernetes")` 返回 "Kubernetes"）。
 */
const INTENTIONAL_UNTRANSLATED = new Set(["Kubernetes"]);

/**
 * 源码全文。用 Vite 的 `?raw` 而不是 `node:fs` —— 应用侧 `tsc` 不含 node
 * 类型（`tsconfig.json` 没引 `@types/node`），用 node API 会让 `pnpm build`
 * 直接编译失败。
 */
const SOURCES: Record<string, string> = import.meta.glob("../../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * 只要业务源码。
 *
 * glob 的 key 是**相对本文件**的路径：语言文件自己是 `../locales/…`、
 * 同目录的测试是 `./…`，业务代码则是 `../../…` —— 所以"必须以 `../../`
 * 开头"就一次性排掉了 `src/i18n/` 整个目录。
 */
function isSource(path: string): boolean {
  if (!path.startsWith("../../")) return false;
  return !path.includes("/test/") && !path.endsWith(".test.ts") && !path.endsWith(".test.tsx");
}

function indirectKeysInSource(): { key: string; file: string }[] {
  const found: { key: string; file: string }[] = [];
  for (const [path, text] of Object.entries(SOURCES)) {
    if (!isSource(path)) continue;
    for (const match of text.matchAll(INDIRECT_KEY)) {
      const key = match[1] ?? match[2];
      if (key) found.push({ key, file: path });
    }
  }
  return found;
}

describe("间接 key（模块级常量里的 i18n key）", () => {
  const entries = indirectKeysInSource();

  it("扫描本身有效：src 里确实存在这类 key", () => {
    // 防"正则/glob 失效导致用例静默通过"——扫不到东西说明扫描坏了，不是没问题。
    expect(entries.length).toBeGreaterThan(20);
  });

  it("每一个都有 zh-CN 译文（否则界面中英混排）", () => {
    const missing = entries
      .filter(({ key }) => !(key in zhCN) && !INTENTIONAL_UNTRANSLATED.has(key))
      .map(({ key, file }) => `${key}  ←  ${file}`);

    expect(
      missing,
      `以下 key 只存在于模块级常量中，zh-CN 语言文件里没有对应译文：\n${missing.join("\n")}`,
    ).toEqual([]);
  });
});
