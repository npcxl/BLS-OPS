/**
 * AI 模块 feature flag。
 *
 * 菜单入口**保留**（占位），但所有能力由这个开关控制；当前恒为 `false`
 * —— 未接模型、无 Prompt、无聊天界面、不会自动执行任何命令。
 *
 * 之所以用常量而不是环境变量：这个仓库有一条硬约定 —— **未实现就显示
 * "未实现"**，绝不靠配置伪装成可用。开关打开也不等于实现，实现必须伴随
 * 真实代码与验收测试。
 */
export const AI_MODULE_ENABLED = false;

/** 运行期读取（留一个函数，方便将来接设置项，现在就是常量）。 */
export function isAiModuleEnabled(): boolean {
  return AI_MODULE_ENABLED;
}
