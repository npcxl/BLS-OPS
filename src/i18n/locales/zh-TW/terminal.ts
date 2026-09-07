/**
 * zh-TW —— 終端模組（TerminalView / 建議面板 / ParamPicker / 結果抽屜 / 快照檢視 /
 * 補全 providers / 命令歷史 / 選區選單 / 終端字型）。
 *
 * 注意：
 * - 發給 xterm 的字串（terminal.write / writeln）不屬於 UI 文案，不在這裡翻譯。
 * - 結果快照中的文本是遠端伺服器輸出，不翻譯。
 * - 知識庫建議的 title/detail 來自 Rust catalog（資料驅動），前端不翻譯。
 * - 通用詞（Copy / Close / Retry / Search / Copied / Enabled / Running 等）複用 common。
 */
export default {
  // —— TerminalView：右鍵選單 / 工具欄 ——
  "Expanded": "已展開",
  "Split Vertically": "垂直分欄",
  "Split Horizontally": "水平分欄",
  "Clear Screen": "清空螢幕",
  "Command History": "命令歷史",
  "Remote Files": "遠端檔案",
  "Refresh Environment": "重新整理環境",
  "Re-probe Docker / Nginx": "重新探測 Docker / Nginx",
  "Enhanced Terminal": "增強終端",
  "Disconnect": "斷開連線",
  "Reconnect": "重新連線",
  "Font": "字型",
  "Search in scrollback": "在回滾緩衝中查詢",
  "No matches": "無匹配",
  "Copy error message": "複製錯誤資訊",
  "Got it": "知道了",

  // —— TerminalView：引數提示 / 連線狀態 ——
  "The command still has unfilled parameters ({{command}}); please select values for them first":
    "命令里还有未替换的参数（{{command}}），请先选择具体值",
  "This command has parameters that must be filled manually; the command body has been filled in, please complete the rest":
    "该命令含需要手填的参数，已为你填入命令主体，请自行补全",
  "The host fingerprint of {{host}} has changed; please confirm before connecting":
    "{{host}} 的主机指纹已变化，请确认后再连接",
  "First connection to {{host}}; please confirm the host fingerprint":
    "首次连接 {{host}}，请确认主机指纹",
  "Waiting for host key confirmation": "等待主機指紋確認",
  "Connection lost: {{message}}": "連線已斷開：{{message}}",

  // —— TerminalView：風險確認彈窗 ——
  "Rerun this command?": "重新執行該命令？",
  "This command will modify the server state ({{risk}}):\n{{command}}":
    "该命令会修改服务器状态（{{risk}}）：\n{{command}}",
  "Run this command?": "執行該命令？",
  "This command will modify the server run state ({{risk}}):\n{{command}}":
    "该命令会修改服务器运行状态（{{risk}}）：\n{{command}}",
  "Run": "執行",
  "Unknown risk": "風險未知",

  // —— TerminalSuggest：建議面板 ——
  "Run {{command}}": "執行 {{command}}",
  "Complete and run": "補全並立即執行",
  "↑↓ select · → or Enter to fill · ← to close · Enter again to run":
    "↑↓ 选择 · → 或 Enter 填入 · ← 关闭 · 再按 Enter 执行",
  "↑↓ select · → or Enter to fill · ← to close · Enter again to run · ▶ / Ctrl+Enter to run directly":
    "↑↓ 选择 · → 或 Enter 填入 · ← 关闭 · 再按 Enter 执行 · ▶ / Ctrl+Enter 直接执行",

  // —— ParamPicker：引數取值選擇器 ——
  "Select service unit": "選擇服務單元",
  "Select container": "選擇容器",
  "Select directory": "選擇目錄",
  "Filter…": "篩選…",
  "Loading services on the server…": "正在讀取伺服器上的服務…",
  "Loading containers on the server…": "正在讀取伺服器上的容器…",
  "Loading directories on the server…": "正在讀取伺服器上的目錄…",
  "No values available": "沒有可用的取值",
  "↑↓ select · Enter to fill · Esc to cancel": "↑↓ 選擇 · Enter 填入 · Esc 取消",

  // —— TerminalPicker：空態 / 會話標籤 ——
  "Select a server to start an SSH session": "選擇一個伺服器以開始 SSH 會話",
  "No servers yet. Add one under \"Servers\" on the left first.":
    "左侧“服务器”中还没有任何条目，请先新增服务器。",
  "Close this tab": "關閉此標籤",

  // —— TerminalResultDrawer：結果抽屜 ——
  "View": "檢視",
  "Rerun": "重新執行",
  "Copy command": "複製命令",
  "Close others": "關閉其他",
  "Close all": "關閉全部",
  "Expand results panel": "展開結果面板",
  "Collapse results panel": "摺疊結果面板",
  "Drag to resize the results panel (double-click to reset)": "拖曳調整結果面板高度（雙擊恢復預設）",
  "Close result for {{command}}": "關閉 {{command}} 的結果",
  "Close results panel (results are kept in history)": "關閉結果面板（結果保留在歷史中）",

  // —— TerminalSnapshotView：快照檢視 ——
  "Exit code {{code}}": "退出碼 {{code}}",
  "Ended by marker": "受控標記收尾",
  "Ended by fallback (no marker)": "無標記兜底收尾",
  "Terminal output": "終端輸出",
  "Raw stream": "原始流",
  "Rendered snapshot unavailable (start line evicted or no-marker fallback); degraded from raw output — soft line wraps cannot be restored":
    "渲染快照不可用（起始行被回滚淘汰或无标记兜底），已从原始输出降级 —— 长行软换行无法还原",
  "Copy rendered output": "複製渲染輸出",
  "Click to copy this line": "點選複製該行",

  // —— CommandHistoryPanel：命令歷史 ——
  "Commands run in this terminal are recorded here": "在此終端執行的命令會記錄下來",

  // —— terminal-selection-menu：終端選區選單 ——
  "{{count}} characters selected": "已選擇 {{count}} 個字元",

  // —— terminal-font：終端字型（專有名詞保持原樣，未命中 key 原樣顯示）——
  "Sarasa Mono SC (CJK)": "更紗黑體（中文等寬）",
  "System default mono": "系統預設等寬",

  // —— command-plan：命令來源標籤 ——
  "Manual input": "手動輸入",
  "History": "歷史命令",
  "Suggestion": "命令建議",

  // —— completion/providers：補全提示（notice 顯示在建議面板底部）——
  "Remote working directory is unknown; cannot complete (waiting for Shell Integration or run a cd first)":
    "还不知道当前远程目录，无法补全（等 Shell Integration 上报或执行一次 cd 后即可）",
  "Remote home directory is unknown; cannot complete ~": "還不知道遠端家目錄，無法補全 ~",
  "Failed to read remote directory: {{message}}": "讀取遠端目錄失敗：{{message}}",
  "No matching remote directories": "沒有匹配的遠端目錄",
  "Probing server environment…": "正在探測伺服器執行環境…",
  "No Nginx detected on this server": "這臺伺服器上沒有檢測到 Nginx",
  "Previously selected container has stopped or no longer exists; please select again":
    "之前选择的容器已停止或不存在，请重新选择",
  "Multiple Nginx containers detected; select one first": "檢測到多個 Nginx 容器，請先選擇要操作的容器",
  "No matching Nginx commands ({{kind}})": "沒有匹配的 Nginx 命令（{{kind}}）",
  "Container {{name}}": "容器 {{name}}",
  "Image {{image}}": "映象 {{image}}",
  "Ports {{ports}}": "埠 {{ports}}",
  "Config {{source}} → {{destination}}": "配置 {{source}} → {{destination}}",
  "Failed to read Docker {{kind}} list: {{message}}": "讀取 Docker {{kind}} 列表失敗：{{message}}",
  "No matching Docker {{kind}}": "沒有匹配的 Docker {{kind}}",
  "Container": "容器",
  "Image": "映象",
  "Network": "網路",
  "Failed to read process list: {{message}}": "讀取程序列表失敗：{{message}}",
  "No matching processes": "沒有匹配的程序",
  "Process name": "程序名",
  "Failed to read service unit list: {{message}}": "讀取服務列表失敗：{{message}}",
  "No matching service units": "沒有匹配的服務單元",
  "systemd service unit": "systemd 服務單元",

  // —— completion/providers/environment：Nginx 命令建議標題 ——
  "View Compose service status": "檢視 Compose 服務狀態",
  "View last 200 log lines": "檢視最近 200 行日誌",
  "Validate config (nginx -t)": "校驗配置（nginx -t）",
  "Gracefully reload config": "平滑過載配置",
  "Restart service": "重啟服務",
  "View version": "檢視版本",
  "Validate config": "校驗配置",
  "View full config": "檢視完整配置",
  "Graceful reload": "平滑過載",
  "View logs (last 200 lines)": "檢視日誌（最近 200 行）",
  "Follow logs": "即時跟蹤日誌",
  "View container details": "檢視容器詳情",
  "Enter container": "進入容器",
  "View port mapping": "檢視埠對映",
  "View config mounts": "檢視配置掛載",
  "View run status": "檢視執行狀態",

  // —— completion/providers/environment：容器歸屬標籤 ——
  "Compose {{project}}/{{service}}": "Compose {{project}}/{{service}}",
} as const;
