import { it } from "vitest";
import { i18n } from "../index";

/** 临时：直接打印若干 key 在 en / zh-CN 下的真实输出（跑完即删）。 */
const KEYS = [
  "低",
  "中",
  "高",
  "MAX",
  "只读",
  "按需确认",
  "完全访问",
  "执行权限",
  "备份与恢复",
  "允许提权",
  "跟随默认",
  "新任务默认值",
  "当前任务覆盖",
  "外部工具",
  "管理 MCP",
  "备份保留期限",
  "查看已有备份",
  "应用范围",
  "覆盖超能 Agent 的文件修改与删除；新建文件无需备份。备份失败会取消本次改动并在步骤里说明原因。",
  "只读直接拒绝写入；按需确认逐条询问；完全访问只对严重操作二次确认。仅作用于超能 Agent 的工具调用。",
  "思考强度",
  "可选上下文预算",
  "能力来源",
  "手动覆盖",
  "实际请求：{{endpoint}}",
];

it("tmp values", async () => {
  for (const lng of ["en", "zh-CN"]) {
    await i18n.changeLanguage(lng);
    const t = i18n.getFixedT(lng);
    console.log(`\n=== ${lng} ===`);
    for (const key of KEYS) console.log(`${key}  =>  ${t(key)}`);
  }
  await i18n.changeLanguage("zh-CN");
});
