/**
 * zh-CN · 命令智能中心（`src/workbench/views/command-center/**`）。
 *
 * 注意：知识库条目本身的 `title` 来自 Rust catalog，**不走这里**（见
 * `docs/i18n.md` 的"不翻"清单）。
 */
export default {
  "Search by command prefix or scenario, e.g. docker p":
    "按命令前缀或场景搜索，例如 docker p",
  "{{count}} hits": "{{count}} 条命中",
  "{{count}} favorites": "{{count}} 条收藏",
  "↑↓ select · Enter run · Esc clear": "↑↓ 选择 · Enter 执行 · Esc 清空",
  "Tab to complete": "按 Tab 补全并展开列表",
  "No results yet": "暂无结果",

  // -- 可执行性 --
  "Not connected to a server — commands are searchable but not executable":
    "未连接服务器 —— 命令可搜索，但不可执行",
  "Server not connected": "服务器未连接",
  "Connecting to the server… (knowledge search is unaffected)":
    "正在连接服务器…（知识库搜索不受影响）",
  "Connection unavailable: {{reason}} (knowledge search is unaffected)":
    "连接不可用：{{reason}}（知识库搜索不受影响）",
  "Not installed on server: {{tools}}": "服务器上未安装：{{tools}}",
  "Knowledge only": "仅知识库",
  "Confirm execution": "确认执行",
  "Running {{id}}…": "正在执行 {{id}}…",
} as const;
