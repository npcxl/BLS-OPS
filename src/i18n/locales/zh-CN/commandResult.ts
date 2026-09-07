/**
 * zh-CN · 统一输出适配结果面板（`src/workbench/views/command-result/**`）。
 *
 * 只按 `view` 分发的通用渲染层（JSON / 表格 / 树 / 键值 / 日志 / 指标 / 原始），
 * 因此文案也是**通用**的：不提任何具体命令。
 */
export default {
  // -- 视图切换 --
  "Structured view": "结构化视图",
  "Tree view": "树视图",
  "Expand all": "全部展开",
  "Collapse all": "全部折叠",

  // -- 复制提示（title / aria）--
  "Click to copy the value": "点击复制该值",
  "Click to copy full value": "点击复制完整值",
  "Click to copy whole JSON": "点击复制整个 JSON",
  "Copy whole JSON": "复制整个 JSON",
  "Copy node JSON": "复制该节点的 JSON",
  "Click to copy this cell": "点击复制该单元格",
  "Click to copy this node's value": "点击复制该节点的值",
  "Click to copy: label + value + unit": "点击复制：名称 + 数值 + 单位",
  "Copy full result": "复制完整结果",
  "Copy raw output": "复制原始输出",
  "Copy raw output (without escape markers)": "复制原始输出（去掉转义标记）",
  "Copy executed command": "复制已执行的命令",
  "Copy path": "复制路径",
  "Command copied": "命令已复制",
  "Output copied": "输出已复制",

  // -- 元信息 --
  "Command: {{command}}": "命令：{{command}}",
  "Executed: {{command}}": "已执行：{{command}}",
  "Duration: {{ms}} ms": "耗时：{{ms}} 毫秒",

  // -- JSON 折叠占位 --
  "[…] {{count}} items": "[…] {{count}} 项",
  "{…} {{count}} keys": "{…} {{count}} 个键",

  // -- 搜索与空态 --
  "Search keys / values…": "搜索键 / 值…",
  "No data.": "没有数据。",
  "No nodes.": "没有节点。",
  "No properties.": "没有属性。",
  "No metrics.": "没有指标。",
  "No log entries.": "没有日志条目。",
  "No matching records.": "没有匹配的记录。",
  "No errors or warnings.": "没有错误或警告。",
  "Errors & warnings only ({{count}})": "仅错误与警告（{{count}}）",
  "{{count}} entries": "{{count}} 条记录",
} as const;
