/**
 * zh-CN · 服务器监控 / 服务管家（systemd）/ 日志中心（journald）。
 *
 * 覆盖 `src/workbench/views/server-monitor/**` 与 `ServiceManagerView`、
 * `LogCenterView`。
 */
export default {
  // -- 顶部与连接 --
  "Pick a server to start monitoring": "选择一台服务器开始监控",
  "No servers yet — add one under Servers in the sidebar first.":
    "还没有服务器 —— 请先在左侧「服务器」里添加一台。",
  "Establishing monitoring connection (no interactive terminal allocated)…":
    "正在建立监控连接（不分配交互式终端）…",
  "SSH connection closed; monitoring stopped": "SSH 连接已关闭，监控已停止",
  "Connection closed": "连接已关闭",
  "First connection to {{host}} — confirm the host fingerprint":
    "首次连接 {{host}} —— 请确认主机指纹",
  "Host fingerprint of {{host}} changed — confirm before connecting":
    "{{host}} 的主机指纹已变化 —— 请先确认再连接",
  "Host fingerprint rejected; monitoring canceled": "主机指纹被拒绝，监控已取消",
  "via jump host": "经由跳板机",
  "Unsupported OS": "不支持的操作系统",
  Interval: "采集间隔",

  // -- 指标卡 --
  CPU: "CPU",
  "CPU usage": "CPU 使用率",
  Memory: "内存",
  "Memory usage": "内存使用率",
  "Load average": "平均负载",
  "{{count}} logical cores": "{{count}} 个逻辑核心",
  "{{used}} / {{total}}": "{{used}} / {{total}}",
  "{{size}} available": "可用 {{size}}",
  " · swap {{size}}": " · swap {{size}}",
  "Up {{time}}": "已运行 {{time}}",
  "5m {{five}} · 15m {{fifteen}} · {{count}} cores":
    "5 分钟 {{five}} · 15 分钟 {{fifteen}} · {{count}} 核",

  // -- 趋势图 --
  "Last 30 minutes": "最近 30 分钟",
  "{{count}}s": "{{count}} 秒",
  "1 min": "1 分钟",
  "{{count}} samples": "{{count}} 个样本",
  "Waiting for data": "等待数据",
  "Waiting for the second sample…": "等待第二次采样…",
  "No data collected yet. The first collection starts right after connecting.":
    "还没有采集到数据，连接成功后立即开始第一次采集。",
  "Pause collection": "暂停采集",
  "Resume collection": "恢复采集",
  Collecting: "采集中",
  "Not collected yet": "尚未采集",
  "Collection failed": "采集失败",

  // -- 磁盘 / 网络 / 进程 表头 --
  "Disk usage": "磁盘占用",
  Device: "设备",
  "Mount point": "挂载点",
  Usage: "使用率",
  Used: "已用",
  Avail: "可用",
  "Highest: {{mount}} · {{count}} filesystems": "最高：{{mount}} · {{count}} 个文件系统",
  "No filesystems detected": "未检测到文件系统",
  "No filesystems reported (the host may be unsupported, or a command failed).":
    "没有上报文件系统（可能是宿主机不受支持，或命令执行失败）。",
  Interface: "网卡",
  "All non-loopback interfaces": "所有非回环网卡",
  "Total sent": "累计发送",
  "Total received": "累计接收",
  "No network interfaces reported (loopback lo excluded).":
    "没有上报网卡信息（已排除回环网卡 lo）。",
  PID: "PID",
  Command: "命令",
  User: "用户",
  Started: "启动时间",
  Closed: "已关闭",
  "No process list reported.": "没有上报进程列表。",

  // -- 服务管家（systemd）--
  "Restart \"{{unit}}\"? The service will be briefly interrupted.":
    "重启「{{unit}}」？该服务会短暂中断。",
  "Stop \"{{unit}}\"? The service will be unavailable until started again.":
    "停止「{{unit}}」？在重新启动之前该服务将不可用。",

  // -- 日志中心（journald）--
  "Show \"{{level}}\" and above": "显示「{{level}}」及以上级别",
} as const;
