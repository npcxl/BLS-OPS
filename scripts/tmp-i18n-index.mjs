// 临时脚本：把各语言 index.ts 改成 common+workbench 合并结构（用完即删）。
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const langs = ["zh-TW", "ja", "ko", "es", "fr", "de", "ru", "pt-BR"];

for (const lang of langs) {
  const p = join(root, "src/i18n/locales", lang, "index.ts");
  const content = `/**
 * ${lang} 汇总 —— 缺失条目回退英文（fallbackLng: en）。
 * 翻译覆盖扩大后按模块拆文件（对齐 zh-CN 的结构）。
 */
import common from "./common";
import workbench from "./workbench";

export default {
  ...common,
  ...workbench,
} as const;
`;
  const skip = existsSync(p) && !/^\/\*\*.*回退英文/m.test(content) && false; // 总是覆写（骨架无内容）
  writeFileSync(p, content, "utf8");
  console.log(`ok ${lang}`);
}
console.log("done");
