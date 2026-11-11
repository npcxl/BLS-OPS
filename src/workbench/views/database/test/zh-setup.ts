/**
 * 数据库工作台的用例断言的是**中文文案**（`getByText("消息")` 等）。
 *
 * i18n 的默认语言在测试环境固定为英文（见 `src/i18n/index.ts` 的 detectLocale），
 * 而这些用例是在验证中文界面，所以显式切到 zh-CN —— 不依赖开发机的系统语言，
 * 也不受后续给 `en` 补翻译的影响。
 */
import { beforeAll } from "vitest";
import { i18n } from "@/i18n";

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});
