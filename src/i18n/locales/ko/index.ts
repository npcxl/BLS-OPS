/**
 * ko 汇总 —— 缺失条目回退英文（fallbackLng: en）。
 * 翻译覆盖扩大后按模块拆文件（对齐 zh-CN 的结构）。
 */
import common from "./common";
import workbench from "./workbench";

export default {
  ...common,
  ...workbench,
} as const;
