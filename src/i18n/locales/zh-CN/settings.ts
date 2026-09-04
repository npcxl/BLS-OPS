/** zh-CN · 设置（外观/凭据/已知主机/语言）。 */
export default {
  // -- 外观 --
  Appearance: "外观",
  Theme: "主题",
  Language: "语言",
  "Follow system": "跟随系统",
  Light: "浅色",
  Dark: "深色",

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
} as const;
