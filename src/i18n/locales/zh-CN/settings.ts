/** zh-CN · 设置（外观/凭据/已知主机/语言）。 */
export default {
  // -- 外观 --
  Appearance: "外观",
  Theme: "主题",
  Language: "语言",
  "Follow system": "跟随系统",
  // 主题分段控件上的**短标签**（THEME_OPTIONS.shortKey）；少一个就会出现
  // "跟随系统 / System / 深色"这种中英混排。
  System: "系统",
  Light: "浅色",
  Dark: "深色",

  // -- 终端 --
  Terminal: "终端",
  "The font is shared by the terminal and the command output panel.":
    "终端与命令输出面板共用同一套字体。",
  "Compact prompt": "精简提示符",
  "Shows only the current path instead of user@host (e.g. ~#, /opt#, /opt/app#). One command is sent to the remote shell after connecting — session only, no server config file is touched.":
    "提示符只保留当前路径、去掉 user@host（如 ~#、/opt#、/opt/app#）。连接成功后向远程 shell 发送一条命令生效：仅本次会话有效，不修改服务器上的任何配置文件。",

  // -- 凭据 --
  Credentials: "凭据",
  "Add credential": "新增凭据",
  "No credentials yet": "暂无凭据",
  "Private key": "私钥",
  "Key saved": "密钥已保存",
  "Key missing": "缺少密钥",
  "Delete credential {{name}}": "删除凭据 {{name}}",
  "Edit credential — {{name}}": "编辑凭据 — {{name}}",
  "Keys are only written to the system credential manager; the database keeps a reference only.":
    "密钥只写入系统凭据管理器，数据库仅保存引用，保存后无法在界面再次查看。",
  "The private key and its passphrase are one configuration; an empty passphrase means an unencrypted key.":
    "私钥与私钥口令是一组配置：口令为空时按未加密私钥处理。",
  "The password is written to the system credential manager and cannot be viewed again later.":
    "密码会写入系统凭据管理器，保存后无法在界面上再次查看。",
  "Private key content": "私钥内容",
  "Key passphrase": "私钥口令",
  "Only needed when the private key itself is encrypted; leave empty for no passphrase":
    "私钥本身加密时才需要；留空表示无口令或保持原口令",
  "Login password (required)": "登录密码（必填）",
  "Leave unchanged": "留空保持不变",
  "Leave empty to keep the saved private key": "留空表示保留已保存的私钥",
  "Leave empty to keep the saved password": "留空表示保留已保存的密码",
  "e.g. production root": "例如 生产环境 root",
  "Paste the private key content when creating a key credential.": "创建私钥凭据时必须粘贴私钥内容。",
  "Select a private key file": "选择私钥文件",
  "Import from file": "从文件导入",
  "Reading file": "读取中",
  "Loaded {{name}}": "已读取 {{name}}",
  "Loaded {{name}} — it is encrypted, enter its passphrase below":
    "已读取 {{name}} — 该私钥已加密，请在下方填写口令",
  "Clear the saved passphrase": "清除已保存的口令",
  "Fill in the password when creating a password credential.": "创建密码凭据时必须填写密码。",
  "Delete credential “{{name}}”? The key in the system credential manager is removed too.":
    "确定删除凭据“{{name}}”吗？此操作会同时清除系统凭据管理器中的密钥。",
  "{{count}} servers are using credential “{{name}}”.\nAfter deletion they become “no credential” and must be re-selected before connecting.\n\nDelete anyway?":
    "有 {{count}} 台服务器正在使用凭据“{{name}}”。\n删除后这些服务器会变为“未绑定凭据”，需要重新选择才能连接。\n\n确定继续删除吗？",

  // -- 已知主机 / 数据 --
  "Known hosts": "已知主机",
  "Fingerprints you confirmed on first connect are listed here.": "首次连接时确认过的服务器指纹会记录在这里。",
  Data: "数据",
  "Command history": "命令历史",
  "Commands you run in the terminal will appear here.": "在终端中执行命令后会出现在这里。",
  "No server": "未关联服务器",
  "Audit log": "审计日志",
  "No audit records yet.": "还没有审计记录。",

  // -- 运行环境 --
  Runtime: "运行环境",
  Version: "版本",
  Platform: "平台",
  Database: "数据库",

  // -- 配置备份与恢复（settings-backup） --
  "Backup & restore": "备份与恢复",
  "Move servers, groups, tags, jump hosts, projects and preferences to another machine. Secrets are never exported — rebind credentials after importing.":
    "把服务器、分组、标签、跳板、项目与偏好迁移到另一台机器。密钥不会被导出，导入后需要重新绑定凭据。",
  "Export configuration": "导出配置",
  "Writes a JSON file. Passwords and private keys stay in the system credential manager.":
    "写出一份 JSON 文件。密码与私钥仍留在系统凭据管理器里。",
  "Import configuration": "导入配置",
  "Preview first":
    "先预览再导入",
  "Export…": "导出…",
  "Import…": "导入…",
  "Exporting…": "正在导出…",
  "Reading…": "正在读取…",
  "Importing…": "正在导入…",
  "Exported {{servers}} servers, {{groups}} groups, {{credentials}} credentials and {{projects}} projects to {{path}}":
    "已导出 {{servers}} 台服务器、{{groups}} 个分组、{{credentials}} 个凭据、{{projects}} 个项目到 {{path}}",
  "Imported: {{added}} added, {{overwritten}} overwritten, {{skipped}} skipped. Rebind credentials before connecting.":
    "导入完成：新增 {{added}} 项，覆盖 {{overwritten}} 项，跳过 {{skipped}} 项。连接前请重新绑定凭据。",
  "{{count}} preferences restored.": "已恢复 {{count}} 项偏好设置。",
  "From {{path}} · exported by version {{version}}": "来源：{{path}} · 由版本 {{version}} 导出",
  "{{total}} total": "共 {{total}} 项",
  "{{count}} conflicts": "{{count}} 项冲突",
  "Conflicts (already on this machine)": "冲突项（本机已存在）",
  "Overwrite existing entries (off = import new entries only, keep this machine's version)":
    "覆盖已存在的条目（关闭时只导入新增，本机版本保持不变）",
  "Import {{count}} entries": "导入 {{count}} 项",
  "Project reviews": "项目复核结论",
  "Project merges": "项目合并关系",
  "Credentials are exported without secrets — rebind them after importing":
    "凭据导出时不带密钥 —— 导入后需要重新绑定。",
  "This backup was written by an older format version": "这份备份由较旧的格式版本写出。",

  // -- 生产环境保护（巡检模式 / 环境标记）--
  Safety: "安全",
  "Client-side guard rails only: they stop accidental clicks, not a determined operator. A read-only shell still needs a restricted account on the server.":
    "只是客户端的防误操作：能挡住误点，挡不住执意执行的人。真正的只读终端需要服务器上配受限账号。",
  "Inspection mode (read-only)": "巡检模式（只读）",
  "Blocks uploads, edits, deletes and service changes in this app. It cannot make a free shell read-only.":
    "在本应用内禁用上传、编辑、删除与服务变更。它无法把自由终端变成只读。",
  "Not specified": "未标记",
  Production: "生产",
  Staging: "预发",
  Development: "开发",
  "Server environment: {{environment}}": "服务器环境：{{environment}}",
  Environment: "环境",
  "Production servers are highlighted everywhere and are the first thing a confirmation dialog names.":
    "生产服务器会在各处高亮；确认框也会先说明目标服务器。「未标记」表示这台机器还没分类。",
} as const;
