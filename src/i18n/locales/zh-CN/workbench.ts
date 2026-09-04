/**
 * zh-CN · 工作台（模块名 / 导航 / 标签页 / 窗口控制 / 命令面板 / P3 视图）。
 *
 * 规则：key 与 `t("...")` 逐字一致（natural keys）；通用词不重复这里
 * （Confirm/Cancel/Save/Close/Running/… 在 common.ts）。
 */
export default {
  // -- 左侧导航模块 --
  "Module: Terminal": "终端",
  "Module: Servers": "服务器",
  "Module: Services": "服务",
  "Module: Logs": "日志",
  "Module: Projects": "项目",
  "Module: Commands": "命令",
  "Module: Deploy": "部署",
  "Module: Tasks": "任务",
  "Module: AI": "智能助手",
  "Module: Settings": "设置",

  // 模块短名（workbench-store MODULE_LABELS / 命令面板 category / 日志菜单标题）
  Terminal: "终端",
  Servers: "服务器",
  Services: "服务",
  Logs: "日志",
  Projects: "项目",
  Commands: "命令",
  Deploy: "部署",
  Tasks: "任务",
  "AI Assistant": "智能助手",
  Monitor: "监控",
  Settings: "设置",
  Workspace: "工作区",

  // -- 顶栏 --
  "Expand sidebar": "展开侧边栏",
  "Collapse sidebar": "收起侧边栏",
  Minimize: "最小化",
  Maximize: "最大化",
  Restore: "还原",
  "Close window": "关闭窗口",

  // -- 标签页 --
  "New tab": "新建标签页",
  "Close tab": "关闭标签页",
  "Close other tabs": "关闭其他标签页",
  "Close all tabs": "关闭所有标签页",
  "Close tabs to the right": "关闭右侧标签页",
  "Split right": "向右分屏",
  "Split down": "向下分屏",
  "New terminal tab": "新建终端标签",
  "New Terminal": "新建终端",
  Home: "首页",
  "Close {{title}}": "关闭 {{title}}",

  // -- 命令面板 --
  "Search actions, servers, tasks…": "搜索操作、服务器、任务…",
  "No matching commands.": "未找到匹配的命令。",
  "Connect to {{name}}": "连接 {{name}}",
  "Monitor {{name}}": "监控 {{name}}",
  "{{label}} {{name}}": "{{label}} {{name}}",
  "Reconnect {{name}}": "重新连接 {{name}}",
  "Recent sessions": "最近会话",
  "Manage credentials": "管理凭据",
  "Open credentials and known hosts": "打开凭据与已知主机",
  "Back to home": "回到首页",
  "Open the workbench home": "打开工作台首页",
  "systemd services: start, stop, restart, enable": "systemd 服务：启动、停止、重启、自启",
  "journalctl log query and filtering": "journalctl 日志查询与过滤",
  "Read-only metrics: CPU, memory, disk, network, processes": "只读指标：CPU、内存、磁盘、网络、进程",

  // -- 状态栏 --
  "Terminals {{count}}": "终端 {{count}}",
  "({{count}} connecting)": "（连接中 {{count}}）",
  "Servers {{count}}": "服务器 {{count}}",
  "Credentials {{count}}": "凭据 {{count}}",
  "Known hosts {{count}}": "已知主机 {{count}}",

  // -- 侧栏 --
  "{{module}} server list": "{{module}} 服务器列表",

  // -- 工作台首页 --
  Workbench: "工作台",
  "Local SSH operations console": "本地 SSH 运维控制台",
  "All servers →": "全部服务器 →",
  "No connection history yet. Sessions appear here after you connect.":
    "还没有连接记录。连接一次后会出现在这里。",
  Favorites: "收藏",
  "Manage →": "管理 →",
  "Click the star in the server list to favorite a server.": "在服务器列表中点击星标即可收藏。",
  "Add server": "新增服务器",
  "Never connected": "从未连接",
  "No servers yet": "还没有服务器",
  "Add a server to start connecting and managing.": "新增一台服务器即可开始连接与管理。",
  "Delete server": "删除服务器",
  "Confirm delete": "确认删除",
  "Deleting \"{{name}}\" will also delete its sessions and command history. This action cannot be undone.":
    "删除“{{name}}”会同时删除它的会话与命令历史。此操作不可撤销。",
  "Open terminal": "打开终端",
  Favorite: "收藏",
  Unfavorite: "取消收藏",
  "Edit server": "编辑服务器",
  "Copy connection address": "复制连接地址",

  // -- 快速连接 --
  "Connect to host": "连接到主机",
  "Please enter a password": "请输入密码",
  Connect: "连接",
  "Saved credentials": "已保存凭据",
  "Select \"one-time password\" to connect without any saved credentials":
    "选择“一次性密码”可不依赖任何已保存凭据",
  "Use one-time password (not saved)": "使用一次性密码（不保存）",
  "One-time password": "一次性密码",
  "No credentials yet. You can connect with a password directly; it will not be saved.":
    "还没有凭据，可先直接用密码连接。密钥不会保存。",
  "Used for this connection only; not written to the system credential manager.":
    "仅用于本次连接，不会写入系统凭据管理器。",
  "Login password": "登录密码",
  "Save as server (connect directly from the list next time)": "保存为服务器（下次可从列表直接连接）",
  "The server entry is saved without credentials — pick a credential or type the password again next time.":
    "服务器条目会被保存，但不含凭据——下次连接仍需选择凭据或再次输入密码。",

  // -- 模块页（占位） --
  "Projects and group management": "项目与分组管理",
  "Linux command intelligence center": "Linux 命令智能中心",
  "Deployment targets and workflows": "部署目标与工作流",
  "Build and upload tasks": "构建与上传任务",
  "AI-assisted operations": "AI 辅助运维",
  "Recent projects": "最近项目",
  Groups: "分组",
  Relations: "关联关系",
  "Command knowledge base": "命令知识库",
  "Structured results": "结构化结果",
  "Raw output": "原始输出",
  "Target environments": "目标环境",
  Workflows: "工作流",
  History: "历史",
  Build: "构建",
  Upload: "上传",
  Context: "上下文",
  "Model providers": "模型提供方",
  "This module is not implemented yet. Development starts after P0 (real SSH terminal, host key verification and credential binding) passes acceptance.":
    "本模块尚未实现。在 P0（真实 SSH 终端、Host Key 校验、凭据绑定）验收通过之前不进入开发。",

  // -- 占位视图 --
  "Phase 1": "阶段 1",
  "Phase 2": "阶段 2",
  "Phase 3": "阶段 3",
  "Phase 4": "阶段 4",
  "Phase 6": "阶段 6",
  "In progress": "进行中",
  "This view is not implemented yet. Files, containers, gateways, projects and deployment features are on hold until P0 (real SSH terminal and host key verification) passes acceptance.":
    "该视图尚未实现。文件、容器、网关、项目、部署类功能在 P0（真实 SSH 终端与主机密钥校验）验收通过前暂停开发。",

  // -- 空面板 --
  "No open editors": "暂无打开的编辑器",
  "Open home": "打开首页",

  // -- 模块公共框架（module-frame） --
  "Select a server to start": "选择一个服务器以开始",
  "No entries under \"Servers\" on the left yet — add a server first.":
    "左侧“服务器”中还没有任何条目，请先新增服务器。",
  "Search servers…": "搜索服务器…",
  "No matching servers": "没有匹配的服务器",
  "Close this tab": "关闭此标签",
  "Pick a server from the left sidebar": "从左侧选择一台服务器",
  "Logs, containers, gateways and other modules run on a specific server. Pick one from the left list to view its content here.":
    "日志、容器、网关等模块都运行在具体的服务器上。在左侧列表点选一台，即可在此查看它的内容。",
  Reconnect: "重新连接",
  "Establishing connection (no interactive terminal allocated)…": "正在建立连接（不分配交互式终端）…",
  "Connection failed": "连接失败",
  "SSH connection closed": "SSH 连接已断开",

  // -- 服务管家 --
  "Not running": "未运行",
  "Enabled on boot": "开机自启",
  "Not enabled on boot": "不自启",
  "Failed to start": "启动失败",
  Starting: "启动中",
  Stopping: "停止中",
  "View details": "查看详情",
  "Reload configuration": "重载配置",
  "Disable on boot": "取消开机自启",
  "Enable on boot": "设为开机自启",
  "Search services…": "搜索服务…",
  "{{visible}} / {{total}} services": "{{visible}} / {{total}} 个服务",
  "Copy error message": "复制错误信息",
  "No services found": "没有读取到任何服务",
  "This machine may not be a systemd system, or the current user cannot list units.":
    "这台机器可能不是 systemd 系统，或者当前用户无权列出单元。",
  "No matching services": "没有匹配的服务",
  "Try different filters or clear the search.": "换个筛选条件或清空搜索试试。",
  "Restart service {{unit}}": "重启服务 {{unit}}",
  "Stop service {{unit}}": "停止服务 {{unit}}",
  "Restart \"{{unit}}\"? The service will be briefly interrupted.": "确定重启“{{unit}}”？服务会短暂中断。",
  "Stop \"{{unit}}\"? The service will be unavailable until started again.":
    "确定停止“{{unit}}”？服务将不再可用，直到再次启动。",
  "Service unit": "服务单元",
  "Run state": "运行状态",
  Autostart: "自启",
  "Copy details": "复制信息",
  "Refresh list": "刷新列表",
  "(no output)": "（没有输出）",

  // -- 日志中心 --
  "Copy this line": "复制该行",
  "Copy all ({{count}})": "复制全部（{{count}} 条）",
  "Show \"{{level}}\" and above": "只看「{{level}}」及以上",
  Current: "当前",
  "Show unit {{unit}}": "只看单元 {{unit}}",
  "Search this message in results": "在结果中搜索该消息",
  "Clear filters": "清除筛选",
  "Stop following latest": "停止跟随最新",
  "Follow latest": "跟随最新",
  Following: "跟随中",
  "Not following": "已停止跟随",
  "{{count}} errors and above": "{{count}} 条错误及以上",
  "Disk usage {{usage}}": "占用 {{usage}}",
  "{{count}} rows": "{{count}} 条",
  "Unit name, e.g. nginx.service": "单元名，如 nginx.service",
  Lines: "行数",
  "Search in results…": "在结果中搜索…",
  "No logs read": "没有读取到日志",
  "Unit {{unit}} has no matching records, or the current user cannot read the journal.":
    "单元 {{unit}} 没有匹配的记录，或当前用户无权读取 journal。",
  "This machine may not have journald, or the current user is not in the systemd-journal group.":
    "这台机器可能没有 journald，或者当前用户不在 systemd-journal 组中。",
  "Time (UTC)": "时间 (UTC)",
  Level: "级别",
  Unit: "单元",
  Message: "消息",
  "(no message body)": "（无消息正文）",
  "Reading…": "读取中…",
  "No records matching \"{{query}}\"": "没有匹配“{{query}}”的记录",
  "Read again": "重新读取",

  // -- 远程文件编辑器 --
  "This is a binary file and cannot be opened as text.": "这是二进制文件，无法以文本方式打开。",
  "There are unsaved changes. Close anyway?": "有未保存的修改，确定关闭吗？",
  Unsaved: "未保存",
  "Save (Ctrl+S)": "保存 (Ctrl+S)",
  "Reading file…": "正在读取…",
} as const;
