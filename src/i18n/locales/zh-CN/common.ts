/**
 * zh-CN · 通用词 —— **跨模块复用的高频词统一放这里**（确认/取消/保存…）。
 *
 * 规则：模块文件里不再重复这些 key；新通用词加到这里后其它模块直接用。
 * key 与英文文案逐字一致（natural keys），见 `src/i18n/locales.ts`。
 */
export default {
  // -- 动作 --
  Confirm: "确认",
  Cancel: "取消",
  Save: "保存",
  Delete: "删除",
  Remove: "移除",
  Edit: "编辑",
  Create: "新建",
  Add: "添加",
  Rename: "重命名",
  Refresh: "刷新",
  Reload: "重新加载",
  Close: "关闭",
  Open: "打开",
  Retry: "重试",
  Apply: "应用",
  Reset: "重置",
  Copy: "复制",
  Copied: "已复制",
  Search: "搜索",
  Filter: "筛选",
  Clear: "清除",
  Expand: "展开",
  Collapse: "收起",
  Back: "返回",
  Next: "下一步",
  Previous: "上一步",
  Finish: "完成",
  Start: "启动",
  Stop: "停止",
  Restart: "重启",
  Pause: "暂停",
  Resume: "继续",
  Download: "下载",
  Upload: "上传",
  Preview: "预览",
  Details: "详情",
  More: "更多",

  // -- 状态 --
  Loading: "加载中…",
  Saving: "保存中…",
  Processing: "处理中…",
  Deleting: "删除中…",
  Connecting: "连接中…",
  "Connecting to server": "正在连接服务器",
  Connected: "已连接",
  Disconnected: "未连接",
  Reconnecting: "重连中…",
  Running: "运行中",
  Stopped: "已停止",
  Failed: "失败",
  Success: "成功",
  Pending: "等待中",
  Enabled: "已启用",
  Disabled: "已禁用",
  None: "暂无",
  Unknown: "未知",
  Yes: "是",
  No: "否",
  All: "全部",
  Total: "共 {{count}} 项",
  Empty: "暂无数据",

  // -- 表单 --
  Name: "名称",
  Type: "类型",
  Status: "状态",
  Host: "主机",
  Port: "端口",
  Username: "用户名",
  Password: "密码",
  Description: "描述",
  Optional: "可选",
  Required: "必填",
  RequiredField: "此项为必填项",

  // -- 时间 --
  JustNow: "刚刚",
  MinutesAgo: "{{count}} 分钟前",
  HoursAgo: "{{count}} 小时前",
  DaysAgo: "{{count}} 天前",
  // formatUptime（lib/format.ts）的时长段
  "{{days}}d {{hours}}h": "{{days}} 天 {{hours}} 小时",
  "{{hours}}h {{minutes}}m": "{{hours}} 小时 {{minutes}} 分",
  "{{minutes}}m": "{{minutes}} 分钟",

  // -- 基础组件（src/components）--
  "Unknown error": "未知错误",
  "Something went wrong": "界面出错了",
  "A component crashed at runtime. You can retry, or copy the error details to report it.":
    "某个组件在运行时崩溃。你可以重试，或复制错误信息反馈给开发者。",
  "Copy error details": "复制错误信息",
  "Copy failed": "复制失败",
  "Copy failed. Please check clipboard permission": "复制失败，请检查剪贴板权限",
  "No results": "无结果",
  "No content": "暂无内容",
  Find: "查找",
  Replace: "替换",
  "Collapse replace": "收起替换",
  "Expand replace (Ctrl+H)": "展开替换（Ctrl+H）",
  "Match case": "区分大小写",
  "Previous (Shift+Enter)": "上一个（Shift+Enter）",
  "Next (Enter)": "下一个（Enter）",
  "Close (Esc)": "关闭（Esc）",
  "Replace (Enter replaces the current match)": "替换（Enter 后替换当前匹配）",
  "Replace all (Alt+Enter)": "全部替换（Alt+Enter）",
  "Close window": "关闭窗口",
  "Show window": "显示主窗口",
  "Checking for updates failed": "检查更新失败",
  "Downloading the update failed": "下载更新失败",
  "Signature verification failed": "签名验证失败",
  "Starting the installer failed": "启动安装程序失败",
  "Restarting the app failed": "重启应用失败",
  "Details: {{detail}}": "具体原因：{{detail}}",
  "Error code: {{code}}": "错误代码：{{code}}",
  "Copy diagnostics": "复制诊断信息",
  "Diagnostics copied": "诊断信息已复制",
  "Download manually from GitHub": "前往 GitHub 手动下载",
  "Opening the browser failed": "打开浏览器失败",
  Quit: "退出",
  "Minimize window": "最小化窗口",
  "Maximize window": "最大化窗口",
  "Clear search": "清除搜索",
  "Context menu": "上下文菜单",
  Submenu: "子菜单",
  "No records matching \"{{query}}\"": "没有匹配「{{query}}」的记录",

  // -- 错误阶段（lib/app-error.ts）--
  Configuration: "配置",
  "SSH tunnel": "SSH 隧道",
  Network: "网络连接",
  Authentication: "身份认证",
  Database: "数据库",
  Query: "查询",
  Permission: "权限",
  Cancelled: "已取消",
  Timeout: "超时",
  "Outcome unknown": "结果未知",
  Unsupported: "不支持",
  Budget: "预算限制",
  "SSH session": "SSH 会话",
  "File transfer": "文件传输",
  Service: "服务",
  Logs: "日志",
  Containers: "容器",
  Gateway: "网关",
  Discovery: "项目发现",
  Deployment: "部署",
  "Local files": "本地文件",
  Monitoring: "监控采集",
  Server: "服务器",
  "Local action": "本地操作",

  // -- 恢复建议（lib/app-error.ts）--
  "Fill in the required fields: check the host, port range and database path.":
    "补全必填字段：检查主机、端口范围与数据库路径。",
  "Check that the SSH server is reachable and that the account is allowed to open a tunnel.":
    "确认 SSH 服务器可达，且该账号允许建立隧道。",
  "Check the host and port, the firewall, and that the service is listening.":
    "检查主机与端口、防火墙规则，以及服务是否在监听。",
  "Check the CA file, the TLS mode, and whether the host name matches the certificate.":
    "检查 CA 证书文件、TLS 模式，以及主机名是否与证书匹配。",
  "Check the username and password (or ACL), and whether this host is allowed to connect.":
    "检查用户名与密码（或 ACL），以及该主机是否被允许连接。",
  "Check that the database exists and that the account can see it.":
    "确认数据库存在，且该账号有权限看到它。",
  "Check the SQL syntax, blocking locks, and the statement timeout.":
    "检查 SQL 语法、锁等待与语句超时设置。",
  "This account lacks the privilege. Use an account with the required grants.":
    "该账号权限不足，请换用具备相应授权的账号。",
  "Raise the timeout, or check the network path between here and the server.":
    "适当放宽超时，或检查本机到服务器之间的网络。",
  "Do not retry blindly: verify the actual state (rows, file, service) before running it again.":
    "不要盲目重试：先核对实际状态（数据、文件、服务），再决定是否重新执行。",
  "This engine or feature is not supported yet.": "该引擎或功能尚未适配。",
  "The operation was cancelled before it changed anything.": "操作已取消，未做任何改动。",
  "Check that the session is still connected; reconnect if the server restarted or the network dropped.":
    "确认会话仍在连接中；服务器重启或网络中断后需要重新连接。",
  "Check the path and the account's permissions on it, then retry — nothing was half-written.":
    "检查路径与该账号的权限后重试：没有只写一半的文件。",
  "Check that the unit name is right and that the account may manage services (polkit / sudo).":
    "确认单元名正确，且该账号有权管理服务（polkit / sudo）。",
  "Check that the journal is readable: the account may need the adm or systemd-journal group.":
    "确认日志可读：该账号可能需要加入 adm 或 systemd-journal 组。",
  "Check that Docker is running and that the account is in the docker group.":
    "确认 Docker 正在运行，且该账号在 docker 组中。",
  "Run a syntax test first; a config that fails `nginx -t` is never reloaded.":
    "先做语法检查：未通过 `nginx -t` 的配置不会被重载。",
  "Check that the project directory is readable and on a local disk, not a network mount.":
    "确认项目目录可读，且位于本地磁盘而非网络挂载。",
  "Check the target environment, the artifact, and whether the previous run is still in progress.":
    "检查目标环境、制品，以及上一次执行是否仍在进行中。",
  "Check whether the file exists and whether this app may read or write it.":
    "确认文件是否存在，以及本应用是否有读写权限。",
  "Metrics are read over the SSH session: check that the session is still connected, then refresh.":
    "指标是通过 SSH 会话读取的：确认会话仍在连接中，然后刷新。",
  "Check the host, port and credential, and whether the same name already exists.":
    "检查主机、端口与凭据，以及是否已有同名条目。",
  "This is a local action: check that the program exists and that no other copy of the app is holding the file.":
    "这是本地操作：确认相关程序存在，且没有被另一个本应用实例占用。",

  // -- 错误通知与页面级错误（components/ui）--
  "Show details": "查看详情",
  "Hide details": "收起详情",

  // -- 确认与表单关闭保护（components/ui）--
  "This action cannot be undone.": "该操作不可撤销。",
  "This action changes data. Please check the target before continuing.":
    "该操作会修改数据，请先确认目标是否正确。",
  "Type {{phrase}} to confirm": "输入 {{phrase}} 以确认",
  "Discard unsaved changes?": "放弃未保存的修改？",
  "Your input has not been saved. Closing now discards it.":
    "你填写的内容还没有保存，关闭后将会丢失。",
  "Discard and close": "放弃并关闭",
} as const;
