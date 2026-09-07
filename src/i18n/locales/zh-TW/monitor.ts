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
    "还没有服务器 —— 请先在左侧「服务器」里添加一台。",
  "Establishing monitoring connection (no interactive terminal allocated)…":
    "正在建立监控连接（不分配交互式终端）…",
  "SSH connection closed; monitoring stopped": "SSH 連線已關閉，監控已停止",
  "Connection closed": "連線已關閉",
  "First connection to {{host}} — confirm the host fingerprint":
    "首次连接 {{host}} —— 请确认主机指纹",
  "Host fingerprint of {{host}} changed — confirm before connecting":
    "{{host}} 的主机指纹已变化 —— 请先确认再连接",
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
  "Up {{time}}": "已執行 {{time}}",
  "5m {{five}} · 15m {{fifteen}} · {{count}} cores":
    "5 分钟 {{five}} · 15 分钟 {{fifteen}} · {{count}} 核",

  // -- 趨勢圖 --
  "Last 30 minutes": "最近 30 分鐘",
  "{{count}}s": "{{count}} 秒",
  "1 min": "1 分鐘",
  "{{count}} samples": "{{count}} 個樣本",
  "Waiting for data": "等待資料",
  "Waiting for the second sample…": "等待第二次取樣…",
  "No data collected yet. The first collection starts right after connecting.":
    "还没有采集到数据，连接成功后立即开始第一次采集。",
  "Pause collection": "暫停採集",
  "Resume collection": "恢復採集",
  Collecting: "採集中",
  "Not collected yet": "尚未採集",
  "Collection failed": "採集失敗",

  // -- 磁碟 / 網路 / 程序 表頭 --
  "Disk usage": "磁碟佔用",
  Device: "裝置",
  "Mount point": "掛載點",
  Usage: "使用率",
  Used: "已用",
  Avail: "可用",
  "Highest: {{mount}} · {{count}} filesystems": "最高：{{mount}} · {{count}} 個檔案系統",
  "No filesystems detected": "未檢測到檔案系統",
  "No filesystems reported (the host may be unsupported, or a command failed).":
    "没有上报文件系统（可能是宿主机不受支持，或命令执行失败）。",
  Interface: "網絡卡",
  "All non-loopback interfaces": "所有非迴環網絡卡",
  "Total sent": "累計傳送",
  "Total received": "累計接收",
  "No network interfaces reported (loopback lo excluded).":
    "没有上报网卡信息（已排除回环网卡 lo）。",
  PID: "PID",
  Command: "命令",
  User: "使用者",
  Started: "啟動時間",
  Closed: "已關閉",
  "No process list reported.": "沒有上報程序列表。",

  // -- 服務管家（systemd）--
  "Restart \"{{unit}}\"? The service will be briefly interrupted.":
    "重启「{{unit}}」？该服务会短暂中断。",
  "Stop \"{{unit}}\"? The service will be unavailable until started again.":
    "停止「{{unit}}」？在重新启动之前该服务将不可用。",

  // -- 日誌中心（journald）--
  "Show \"{{level}}\" and above": "顯示「{{level}}」及以上級別",
} as const;
