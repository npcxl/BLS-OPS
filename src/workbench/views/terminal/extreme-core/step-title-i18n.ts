/**
 * 步骤标题的英文兜底。
 *
 * 执行步骤的标题是 **Rust 侧拼出来的**（`tools.rs` 的 summary）：`解压归档`、
 * `重启服务 nginx`、`更新文件 /etc/x`…… 这些不是前端字典里的静态 key，
 * `t()` 查不到就原样显示中文，英文界面就露馅。
 *
 * 这里按"动词 + 目标"的模式做一层本地化：命中规则才替换，没命中的保持原样
 * （宁可显示原文，也不猜一个错的动词）。
 */
import { useTranslation } from "react-i18next";

const RULES: [RegExp, string][] = [
  [/^重载 Nginx$/, "Reload Nginx"],
  [/^停止 Compose 项目$/, "Stop Compose project"],
  [/^重启 Compose 项目$/, "Restart Compose project"],
  [/^更新 Compose 项目$/, "Update Compose project"],
  [/^删除文件$/, "Delete files"],
  [/^修改文件权限$/, "Change file permissions"],
  [/^解压归档$/, "Extract archive"],
  [/^处理归档$/, "Inspect archive operation"],
  [/^查看归档清单$/, "List archive contents"],
  [/^校验归档$/, "Validate archive"],
  [/^读取归档内容$/, "Read archive contents"],
  [/^解压归档，同名文件会被覆盖$/, "Extract archive (existing files are overwritten)"],
  [/^查看归档清单 (.+)$/, "List archive $1"],
  [/^校验归档 (.+)$/, "Verify archive $1"],
  [/^读取归档内容 (.+)$/, "Read archive contents $1"],
  [/^验证发布结果$/, "Verify the published result"],
  [/^将 (.+) 解压到当前目录$/, "Extract $1 into the current directory"],
  [/^将 (.+) 解压到 (.+)$/, "Extract $1 to $2"],
  [/^创建目录$/, "Create directory"],
  [/^复制或移动文件$/, "Copy or move files"],
  [/^重启服务 (.+)$/, "Restart service $1"],
  [/^重载服务 (.+)$/, "Reload service $1"],
  [/^启动服务 (.+)$/, "Start service $1"],
  [/^停止服务 (.+)$/, "Stop service $1"],
  [/^更新文件 (.+)$/, "Update file $1"],
  [/^更新 Compose 配置 (.+)$/, "Update Compose config $1"],
  [/^更新定时任务 (.+)$/, "Update cron job $1"],
  [/^执行 (.+)$/, "Run $1"],
  [/^正在执行 (.+)$/, "Running $1"],
];

/** 只有英文界面 + 标题里确实有中文时才改写。 */
export function localizeStepTitle(title: string, language: string): string {
  if (!language.toLowerCase().startsWith("en")) return title;
  if (!/[\u4e00-\u9fa5]/.test(title)) return title;
  for (const [pattern, template] of RULES) {
    if (pattern.test(title)) return title.replace(pattern, template);
  }
  return title;
}

/** 组件里用：拿到当前语言再改写标题。 */
export function useStepTitle(): (title: string) => string {
  const { i18n } = useTranslation();
  return (title: string) => localizeStepTitle(title, i18n.language ?? "zh");
}
