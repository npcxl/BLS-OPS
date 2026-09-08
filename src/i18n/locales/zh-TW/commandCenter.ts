/**
 * zh-TW · 命令智慧中心（`src/workbench/views/command-center/**`）。
 *
 * 注意：知識庫條目本身的 `title` 來自 Rust catalog，**不走這裡**（見
 * `docs/i18n.md` 的"不翻"清單）。
 */
export default {
  "Search by command prefix or scenario, e.g. docker p":
    "按命令前缀或场景搜索，例如 docker p",
  "{{count}} hits": "{{count}} 條命中",
  "{{count}} favorites": "{{count}} 條收藏",
  "↑↓ select · Enter run · Esc clear": "↑↓ 選擇 · Enter 執行 · Esc 清空",
  "Tab to complete": "按 Tab 補全並展開列表",
  "No results yet": "暫無結果",

  // -- 可執行性 --
  "Not connected to a server — commands are searchable but not executable":
    "未连接服务器 —— 命令可搜索，但不可执行",
  "Server not connected": "伺服器未連線",
  "Connecting to the server… (knowledge search is unaffected)":
    "正在连接服务器…（知识库搜索不受影响）",
  "Connection unavailable: {{reason}} (knowledge search is unaffected)":
    "连接不可用：{{reason}}（知识库搜索不受影响）",
  "Not installed on server: {{tools}}": "伺服器上未安裝：{{tools}}",
  "Knowledge only": "僅知識庫",
  "Confirm execution": "確認執行",
  "Running {{id}}…": "正在執行 {{id}}…",
} as const;
