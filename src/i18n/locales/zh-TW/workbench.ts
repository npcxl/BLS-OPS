/**
 * zh-TW · 工作臺（模組名 / 導航 / 標籤頁 / 視窗控制 / 命令面板 / P3 檢視）。
 *
 * 規則：key 與 `t("...")` 逐字一致（natural keys）；通用詞不重複這裡
 * （Confirm/Cancel/Save/Close/Running/… 在 common.ts）。
 */
export default {
  // -- 左側導航模組 --
  "Module: Terminal": "終端",
  "Module: Servers": "伺服器",
  "Module: Services": "服務",
  "Module: Logs": "日誌",
  "Module: Projects": "專案",
  "Module: Commands": "命令",
  "Module: Deploy": "部署",
  "Module: Tasks": "任務",
  "Module: AI": "智慧助手",
  "Module: Settings": "設定",

  // 模組短名（workbench-store MODULE_LABELS / 命令面板 category / 日誌選單標題）
  Terminal: "終端",
  Servers: "伺服器",
  Services: "服務",
  Logs: "日誌",
  Projects: "專案",
  Commands: "命令",
  Deploy: "部署",
  Tasks: "任務",
  "AI Assistant": "智慧助手",
  Monitor: "監控",
  Settings: "設定",
  Workspace: "工作區",

  // -- 頂欄 --
  "Expand sidebar": "展開側邊欄",
  "Collapse sidebar": "收起側邊欄",
  Minimize: "最小化",
  Maximize: "最大化",
  Restore: "還原",
  "Close window": "關閉視窗",

  // -- 標籤頁 --
  "New tab": "新建標籤頁",
  "Close tab": "關閉標籤頁",
  "Close other tabs": "關閉其他標籤頁",
  "Close all tabs": "關閉所有標籤頁",
  "Close tabs to the right": "關閉右側標籤頁",
  "Split right": "向右分屏",
  "Split down": "向下分屏",
  "New terminal tab": "新建終端標籤",
  "New Terminal": "新建終端",
  Home: "首頁",
  "Close {{title}}": "關閉 {{title}}",

  // -- 命令面板 --
  "Search actions, servers, tasks…": "搜尋操作、伺服器、任務…",
  "No matching commands.": "未找到匹配的命令。",
  "Connect to {{name}}": "連線 {{name}}",
  "Monitor {{name}}": "監控 {{name}}",
  "{{label}} {{name}}": "{{label}} {{name}}",
  "Reconnect {{name}}": "重新連線 {{name}}",
  "Recent sessions": "最近會話",
  "Manage credentials": "管理憑據",
  "Open credentials and known hosts": "開啟憑據與已知主機",
  "Back to home": "回到首頁",
  "Open the workbench home": "開啟工作臺首頁",
  "systemd services: start, stop, restart, enable": "systemd 服務：啟動、停止、重啟、自啟",
  "journalctl log query and filtering": "journalctl 日誌查詢與過濾",
  "Read-only metrics: CPU, memory, disk, network, processes": "只讀指標：CPU、記憶體、磁碟、網路、程序",

  // -- 狀態列 --
  "Terminals {{count}}": "終端 {{count}}",
  "({{count}} connecting)": "（連線中 {{count}}）",
  "Servers {{count}}": "伺服器 {{count}}",
  "Credentials {{count}}": "憑據 {{count}}",
  "Known hosts {{count}}": "已知主機 {{count}}",

  // -- 側欄 --
  "{{module}} server list": "{{module}} 伺服器列表",

  // -- 工作臺首頁 --
  Workbench: "工作臺",
  "Local SSH operations console": "本地 SSH 運維控制台",
  "All servers →": "全部伺服器 →",
  "No connection history yet. Sessions appear here after you connect.":
    "还没有连接记录。连接一次后会出现在这里。",
  Favorites: "收藏",
  "Manage →": "管理 →",
  "Click the star in the server list to favorite a server.": "在伺服器列表中點選星標即可收藏。",
  "Add server": "新增伺服器",
  "Never connected": "從未連線",
  "No servers yet": "還沒有伺服器",
  "Add a server to start connecting and managing.": "新增一臺伺服器即可開始連線與管理。",
  "Delete server": "刪除伺服器",
  "Confirm delete": "確認刪除",
  "Deleting \"{{name}}\" will also delete its sessions and command history. This action cannot be undone.":
    "删除“{{name}}”会同时删除它的会话与命令历史。此操作不可撤销。",
  "Open terminal": "開啟終端",
  Favorite: "收藏",
  Unfavorite: "取消收藏",
  "Edit server": "編輯伺服器",
  "Copy connection address": "複製連線地址",

  // -- 快速連線 --
  "Connect to host": "連線到主機",
  "Please enter a password": "請輸入密碼",
  Connect: "連線",
  "Saved credentials": "已儲存憑據",
  "Select \"one-time password\" to connect without any saved credentials":
    "选择“一次性密码”可不依赖任何已保存凭据",
  "Use one-time password (not saved)": "使用一次性密碼（不儲存）",
  "One-time password": "一次性密碼",
  "No credentials yet. You can connect with a password directly; it will not be saved.":
    "还没有凭据，可先直接用密码连接。密钥不会保存。",
  "Used for this connection only; not written to the system credential manager.":
    "仅用于本次连接，不会写入系统凭据管理器。",
  "Login password": "登入密碼",
  "Save as server (connect directly from the list next time)": "儲存為伺服器（下次可從列表直接連線）",
  "The server entry is saved without credentials — pick a credential or type the password again next time.":
    "服务器条目会被保存，但不含凭据——下次连接仍需选择凭据或再次输入密码。",

  // -- 模組頁（佔位） --
  "Projects and group management": "專案與分組管理",
  "Linux command intelligence center": "Linux 命令智慧中心",
  "Deployment targets and workflows": "部署目標與工作流",
  "Build and upload tasks": "構建與上傳任務",
  "AI-assisted operations": "AI 輔助運維",
  "Recent projects": "最近專案",
  Groups: "分組",
  Relations: "關聯關係",
  "Command knowledge base": "命令知識庫",
  "Structured results": "結構化結果",
  "Raw output": "原始輸出",
  "Target environments": "目標環境",
  Workflows: "工作流",
  History: "歷史",
  Build: "構建",
  Upload: "上傳",
  Context: "上下文",
  "Model providers": "模型提供方",
  "This module is not implemented yet.": "本模組尚未實現。",

  // -- 佔位檢視 --
  "Phase 1": "階段 1",
  "Phase 2": "階段 2",
  "Phase 3": "階段 3",
  "Phase 4": "階段 4",
  "Phase 6": "階段 6",
  "In progress": "進行中",
  "This view is not implemented yet. Files, containers, gateways, projects and deployment features are on hold until P0 (real SSH terminal and host key verification) passes acceptance.":
    "该视图尚未实现。文件、容器、网关、项目、部署类功能在 P0（真实 SSH 终端与主机密钥校验）验收通过前暂停开发。",

  // -- 空面板 --
  "No open editors": "暫無開啟的編輯器",
  "Open home": "開啟首頁",

  // -- 模組公共框架（module-frame） --
  "Select a server to start": "選擇一個伺服器以開始",
  "No entries under \"Servers\" on the left yet — add a server first.":
    "左侧“服务器”中还没有任何条目，请先新增服务器。",
  "Search servers…": "搜尋伺服器…",
  "No matching servers": "沒有匹配的伺服器",
  "Close this tab": "關閉此標籤",
  "Pick a server from the left sidebar": "從左側選擇一臺伺服器",
  "Logs, containers, gateways and other modules run on a specific server. Pick one from the left list to view its content here.":
    "日志、容器、网关等模块都运行在具体的服务器上。在左侧列表点选一台，即可在此查看它的内容。",
  Reconnect: "重新連線",
  "Establishing connection (no interactive terminal allocated)…": "正在建立連線（不分配互動式終端）…",
  "Connection failed": "連線失敗",
  "SSH connection closed": "SSH 連線已斷開",

  // -- 服務管家 --
  "Not running": "未執行",
  "Enabled on boot": "開機自啟",
  "Not enabled on boot": "不自啟",
  "Failed to start": "啟動失敗",
  Starting: "啟動中",
  Stopping: "停止中",
  "View details": "檢視詳情",
  "Reload configuration": "過載配置",
  "Disable on boot": "取消開機自啟",
  "Enable on boot": "設為開機自啟",
  "Search services…": "搜尋服務…",
  "{{visible}} / {{total}} services": "{{visible}} / {{total}} 個服務",
  "Copy error message": "複製錯誤資訊",
  "No services found": "沒有讀取到任何服務",
  "This machine may not be a systemd system, or the current user cannot list units.":
    "这台机器可能不是 systemd 系统，或者当前用户无权列出单元。",
  "No matching services": "沒有匹配的服務",
  "Try different filters or clear the search.": "換個篩選條件或清空搜尋試試。",
  "Restart service {{unit}}": "重啟服務 {{unit}}",
  "Stop service {{unit}}": "停止服務 {{unit}}",
  "Restart \"{{unit}}\"? The service will be briefly interrupted.": "確定重啟“{{unit}}”？服務會短暫中斷。",
  "Stop \"{{unit}}\"? The service will be unavailable until started again.":
    "确定停止“{{unit}}”？服务将不再可用，直到再次启动。",
  "Service unit": "服務單元",
  "Run state": "執行狀態",
  Autostart: "自啟",
  "Copy details": "複製資訊",
  "Refresh list": "重新整理列表",
  "(no output)": "（沒有輸出）",

  // -- 日誌中心 --
  "Copy this line": "複製該行",
  "Copy all ({{count}})": "複製全部（{{count}} 條）",
  "Show \"{{level}}\" and above": "只看「{{level}}」及以上",
  Current: "當前",
  "Show unit {{unit}}": "只看單元 {{unit}}",
  "Search this message in results": "在結果中搜索該訊息",
  "Clear filters": "清除篩選",
  "Stop following latest": "停止跟隨最新",
  "Follow latest": "跟隨最新",
  Following: "跟隨中",
  "Not following": "已停止跟隨",
  "{{count}} errors and above": "{{count}} 條錯誤及以上",
  "Disk usage {{usage}}": "佔用 {{usage}}",
  "{{count}} rows": "{{count}} 條",
  "Unit name, e.g. nginx.service": "單元名，如 nginx.service",
  Lines: "行數",
  "Search in results…": "在結果中搜索…",
  "No logs read": "沒有讀取到日誌",
  "Unit {{unit}} has no matching records, or the current user cannot read the journal.":
    "单元 {{unit}} 没有匹配的记录，或当前用户无权读取 journal。",
  "This machine may not have journald, or the current user is not in the systemd-journal group.":
    "这台机器可能没有 journald，或者当前用户不在 systemd-journal 组中。",
  "Time (UTC)": "時間 (UTC)",
  Level: "級別",
  Unit: "單元",
  Message: "訊息",
  "(no message body)": "（無訊息正文）",
  "Reading…": "讀取中…",
  "No records matching \"{{query}}\"": "沒有匹配“{{query}}”的記錄",
  "Read again": "重新讀取",

  // -- 遠端檔案編輯器 --
  "This is a binary file and cannot be opened as text.": "這是二進位制檔案，無法以文本方式開啟。",
  "There are unsaved changes. Close anyway?": "有未儲存的修改，確定關閉嗎？",
  Unsaved: "未儲存",
  "Save (Ctrl+S)": "儲存 (Ctrl+S)",
  "Reading file…": "正在讀取…",
} as const;
