/**
 * zh-CN —— 终端模块（TerminalView / 建议面板 / ParamPicker / 结果抽屉 / 快照视图 /
 * 补全 providers / 命令历史 / 选区菜单 / 终端字体）。
 *
 * 注意：
 * - 发给 xterm 的字符串（terminal.write / writeln）不属于 UI 文案，不在这里翻译。
 * - 结果快照中的文本是远程服务器输出，不翻译。
 * - 知识库建议的 title/detail 来自 Rust catalog（数据驱动），前端不翻译。
 * - 通用词（Copy / Close / Retry / Search / Copied / Enabled / Running 等）复用 common。
 */
export default {
  // —— TerminalView：右键菜单 / 工具栏 ——
  "Expanded": "已展开",
  "Split Vertically": "垂直分栏",
  "Split Horizontally": "水平分栏",
  "Clear Screen": "清空屏幕",
  "Command History": "命令历史",
  "Remote Files": "远程文件",
  "Refresh Environment": "刷新环境",
  "Re-probe Docker / Nginx": "重新探测 Docker / Nginx",
  "Enhanced Terminal": "增强终端",
  "Disconnect": "断开连接",
  "Reconnect": "重新连接",
  "Font": "字体",
  "Search in scrollback": "在回滚缓冲中查找",
  "No matches": "无匹配",
  "Copy error message": "复制错误信息",
  "Got it": "知道了",

  // —— TerminalView：参数提示 / 连接状态 ——
  "The command still has unfilled parameters ({{command}}); please select values for them first":
    "命令里还有未替换的参数（{{command}}），请先选择具体值",
  "This command has parameters that must be filled manually; the command body has been filled in, please complete the rest":
    "该命令含需要手填的参数，已为你填入命令主体，请自行补全",
  "The host fingerprint of {{host}} has changed; please confirm before connecting":
    "{{host}} 的主机指纹已变化，请确认后再连接",
  "First connection to {{host}}; please confirm the host fingerprint":
    "首次连接 {{host}}，请确认主机指纹",
  "Waiting for host key confirmation": "等待主机指纹确认",
  "Connection lost: {{message}}": "连接已断开：{{message}}",

  // —— TerminalView：风险确认弹窗 ——
  "Rerun this command?": "重新运行该命令？",
  "This command will modify the server state ({{risk}}):\n{{command}}":
    "该命令会修改服务器状态（{{risk}}）：\n{{command}}",
  "Run this command?": "执行该命令？",
  "This command will modify the server run state ({{risk}}):\n{{command}}":
    "该命令会修改服务器运行状态（{{risk}}）：\n{{command}}",
  "Run": "执行",
  "Unknown risk": "风险未知",

  // —— TerminalSuggest：建议面板 ——
  "Run {{command}}": "执行 {{command}}",
  "Complete and run": "补全并立即执行",
  "↑↓ select · → or Enter to fill · ← to close · Enter again to run":
    "↑↓ 选择 · → 或 Enter 填入 · ← 关闭 · 再按 Enter 执行",
  "↑↓ select · → or Enter to fill · ← to close · Enter again to run · ▶ / Ctrl+Enter to run directly":
    "↑↓ 选择 · → 或 Enter 填入 · ← 关闭 · 再按 Enter 执行 · ▶ / Ctrl+Enter 直接执行",

  // —— ParamPicker：参数取值选择器 ——
  "Select service unit": "选择服务单元",
  "Select container": "选择容器",
  "Select directory": "选择目录",
  "Filter…": "筛选…",
  "Loading services on the server…": "正在读取服务器上的服务…",
  "Loading containers on the server…": "正在读取服务器上的容器…",
  "Loading directories on the server…": "正在读取服务器上的目录…",
  "No values available": "没有可用的取值",
  "↑↓ select · Enter to fill · Esc to cancel": "↑↓ 选择 · Enter 填入 · Esc 取消",

  // —— TerminalPicker：空态 / 会话标签 ——
  "Select a server to start an SSH session": "选择一个服务器以开始 SSH 会话",
  "No servers yet. Add one under \"Servers\" on the left first.":
    "左侧“服务器”中还没有任何条目，请先新增服务器。",
  "Close this tab": "关闭此标签",

  // —— TerminalResultDrawer：结果抽屉 ——
  "View": "查看",
  "Rerun": "重新运行",
  "Copy command": "复制命令",
  "Close others": "关闭其他",
  "Close all": "关闭全部",
  "Expand results panel": "展开结果面板",
  "Collapse results panel": "折叠结果面板",
  "Close result for {{command}}": "关闭 {{command}} 的结果",
  "Close results panel (results are kept in history)": "关闭结果面板（结果保留在历史中）",

  // —— TerminalSnapshotView：快照视图 ——
  "Exit code {{code}}": "退出码 {{code}}",
  "Ended by marker": "受控标记收尾",
  "Ended by fallback (no marker)": "无标记兜底收尾",
  "Terminal output": "终端输出",
  "Raw stream": "原始流",
  "Rendered snapshot unavailable (start line evicted or no-marker fallback); degraded from raw output — soft line wraps cannot be restored":
    "渲染快照不可用（起始行被回滚淘汰或无标记兜底），已从原始输出降级 —— 长行软换行无法还原",
  "Copy rendered output": "复制渲染输出",
  "Click to copy this line": "点击复制该行",

  // —— CommandHistoryPanel：命令历史 ——
  "Commands run in this terminal are recorded here": "在此终端执行的命令会记录下来",

  // —— terminal-selection-menu：终端选区菜单 ——
  "{{count}} characters selected": "已选择 {{count}} 个字符",

  // —— terminal-font：终端字体（专有名词保持原样，未命中 key 原样显示）——
  "Sarasa Mono SC (CJK)": "更纱黑体（中文等宽）",
  "System default mono": "系统默认等宽",

  // —— command-plan：命令来源标签 ——
  "Manual input": "手动输入",
  "History": "历史命令",
  "Suggestion": "命令建议",

  // —— completion/providers：补全提示（notice 显示在建议面板底部）——
  "Remote working directory is unknown; cannot complete (waiting for Shell Integration or run a cd first)":
    "还不知道当前远程目录，无法补全（等 Shell Integration 上报或执行一次 cd 后即可）",
  "Remote home directory is unknown; cannot complete ~": "还不知道远程家目录，无法补全 ~",
  "Failed to read remote directory: {{message}}": "读取远程目录失败：{{message}}",
  "No matching remote directories": "没有匹配的远程目录",
  "Probing server environment…": "正在探测服务器运行环境…",
  "No Nginx detected on this server": "这台服务器上没有检测到 Nginx",
  "Previously selected container has stopped or no longer exists; please select again":
    "之前选择的容器已停止或不存在，请重新选择",
  "Multiple Nginx containers detected; select one first": "检测到多个 Nginx 容器，请先选择要操作的容器",
  "No matching Nginx commands ({{kind}})": "没有匹配的 Nginx 命令（{{kind}}）",
  "Container {{name}}": "容器 {{name}}",
  "Image {{image}}": "镜像 {{image}}",
  "Ports {{ports}}": "端口 {{ports}}",
  "Config {{source}} → {{destination}}": "配置 {{source}} → {{destination}}",
  "Failed to read Docker {{kind}} list: {{message}}": "读取 Docker {{kind}} 列表失败：{{message}}",
  "No matching Docker {{kind}}": "没有匹配的 Docker {{kind}}",
  "Container": "容器",
  "Image": "镜像",
  "Network": "网络",
  "Failed to read process list: {{message}}": "读取进程列表失败：{{message}}",
  "No matching processes": "没有匹配的进程",
  "Process name": "进程名",
  "Failed to read service unit list: {{message}}": "读取服务列表失败：{{message}}",
  "No matching service units": "没有匹配的服务单元",
  "systemd service unit": "systemd 服务单元",

  // —— completion/providers/environment：Nginx 命令建议标题 ——
  "View Compose service status": "查看 Compose 服务状态",
  "View last 200 log lines": "查看最近 200 行日志",
  "Validate config (nginx -t)": "校验配置（nginx -t）",
  "Gracefully reload config": "平滑重载配置",
  "Restart service": "重启服务",
  "View version": "查看版本",
  "Validate config": "校验配置",
  "View full config": "查看完整配置",
  "Graceful reload": "平滑重载",
  "View logs (last 200 lines)": "查看日志（最近 200 行）",
  "Follow logs": "实时跟踪日志",
  "View container details": "查看容器详情",
  "Enter container": "进入容器",
  "View port mapping": "查看端口映射",
  "View config mounts": "查看配置挂载",
  "View run status": "查看运行状态",
} as const;
