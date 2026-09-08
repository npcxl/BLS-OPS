/**
 * zh-TW · 伺服器監控 / 服務管家（systemd）/ 日誌中心（journald）。
 *
 * 覆蓋 `src/workbench/views/server-monitor/**` 與 `ServiceManagerView`、
 * `LogCenterView`。
 */
export default {
  // -- 頂部與連線 --
  "Pick a server to start monitoring": "選擇一臺伺服器開始監控",
  "No servers yet — add one under Servers in the sidebar first.":
    "還沒有伺服器 —— 請先在左側「伺服器」裡新增一台。",
  "Establishing monitoring connection (no interactive terminal allocated)…":
    "正在建立監控連線（不配置互動式終端機）…",
  "SSH connection closed; monitoring stopped": "SSH 連線已關閉，監控已停止",
  "Connection closed": "連線已關閉",
  "First connection to {{host}} — confirm the host fingerprint":
    "首次連線 {{host}} —— 請確認主機指紋",
  "Host fingerprint of {{host}} changed — confirm before connecting":
    "{{host}} 的主機指紋已變更 —— 請先確認再連線",
  "Host fingerprint rejected; monitoring canceled": "主機指紋被拒絕，監控已取消",
  "via jump host": "經由跳板機",
  "Unsupported OS": "不支援的作業系統",
  Interval: "採集間隔",

  // -- 指標卡 --
  CPU: "CPU",
  "CPU usage": "CPU 使用率",
  Memory: "記憶體",
  "Memory usage": "記憶體使用率",
  "Load average": "平均負載",
  "{{count}} logical cores": "{{count}} 個邏輯核心",
  "{{used}} / {{total}}": "{{used}} / {{total}}",
  "{{size}} available": "可用 {{size}}",
  " · swap {{size}}": " · swap {{size}}",
  "Up {{time}}": "已運行 {{time}}",
  "5m {{five}} · 15m {{fifteen}} · {{count}} cores":
    "5 分鐘 {{five}} · 15 分鐘 {{fifteen}} · {{count}} 核",

  // -- 趨勢圖 --
  "Last 30 minutes": "最近 30 分鐘",
  "{{count}}s": "{{count}} 秒",
  "1 min": "1 分鐘",
  "{{count}} samples": "{{count}} 個樣本",
  "Waiting for data": "等待資料",
  "Waiting for the second sample…": "等待第二次取樣…",
  "No data collected yet. The first collection starts right after connecting.":
    "還沒有採集到資料，連線成功後立即開始第一次採集。",
  "Pause collection": "暫停採集",
  "Resume collection": "恢復採集",
  Collecting: "採集中",
  "Not collected yet": "尚未採集",
  "Collection failed": "採集失敗",

  // -- 磁碟 / 網路 / 程序 表頭 --
  "Disk usage": "磁碟佔用",
  Device: "裝置",
  "Mount point": "掛載點",
  Type: "類型",
  Size: "大小",
  Usage: "使用率",
  Used: "已用",
  Avail: "可用",
  "Highest: {{mount}} · {{count}} filesystems": "最高：{{mount}} · {{count}} 個檔案系統",
  "No filesystems detected": "未偵測到檔案系統",
  "No filesystems reported (the host may be unsupported, or a command failed).":
    "沒有回報檔案系統（可能是主機不受支援，或命令執行失敗）。",
  Interface: "網路卡",
  "All non-loopback interfaces": "所有非迴環網路卡",
  "Total sent": "累計傳送",
  "Total received": "累計接收",
  "No network interfaces reported (loopback lo excluded).":
    "沒有回報網路卡資訊（已排除迴環網路卡 lo）。",
  PID: "PID",
  Command: "命令",
  User: "使用者",
  Started: "啟動時間",
  Closed: "已關閉",
  "No process list reported.": "沒有回報程序列表。",

  // -- 明細 tab --
  Disk: "磁碟",
  Network: "網路",
  Processes: "程序",

  // -- 服務管家（systemd）--
  Starting: "啟動中",
  Stopping: "停止中",
  Autostart: "自動啟動",
  "Restart \"{{unit}}\"? The service will be briefly interrupted.":
    "重新啟動「{{unit}}」？該服務會短暫中斷。",
  "Stop \"{{unit}}\"? The service will be unavailable until started again.":
    "停止「{{unit}}」？在重新啟動之前該服務將不可用。",

  // -- 日誌中心（journald）--
  Logs: "日誌",
  Level: "級別",
  Unit: "單元",
  Message: "訊息",
  Lines: "行數",
  Following: "跟隨中",
  Current: "目前",
  Emergency: "緊急",
  Alert: "警報",
  Critical: "嚴重",
  Error: "錯誤",
  Warning: "警告",
  Notice: "通知",
  Info: "資訊",
  Debug: "除錯",
  Other: "其它",
  "Show \"{{level}}\" and above": "顯示「{{level}}」及以上級別",
} as const;
