/**
 * 数据库工作台的用例断言的是**中文文案**（`getByText("消息")`、`aria-label="文件格式"` 等）。
 *
 * i18n 的默认语言在测试环境固定为英文（见 `src/i18n/index.ts` 的 detectLocale），
 * 而这些用例是在验证中文界面，所以显式切到 zh-CN。
 *
 * 这里**同步**切一次而不是等 `beforeEach`：`i18n.changeLanguage` 对内存 resources
 * 是同步生效的，早切一步能让渲染时读到的就是中文。
 */
import { i18n } from "@/i18n";

void i18n.changeLanguage("zh-CN");

// 再兜一层：同一次 vitest 进程里别的用例可能把语言切回去。
import { beforeEach } from "vitest";

beforeEach(async () => {
  if (i18n.language !== "zh-CN") {
    await i18n.changeLanguage("zh-CN");
  }
  if (i18n.language !== "zh-CN") {
    throw new Error(`zh-setup failed to switch language, got ${i18n.language}`);
  }
});
