/** zh-TW · 設定（外觀/憑據/已知主機/語言）。 */
export default {
  // -- 外觀 --
  Appearance: "外觀",
  Theme: "主題",
  Language: "語言",
  "Follow system": "跟隨系統",
  Light: "淺色",
  Dark: "深色",

  // -- 憑據 --
  Credentials: "憑據",
  "Add credential": "新增憑據",
  "No credentials yet": "暫無憑據",
  "Private key": "私鑰",
  "Key saved": "金鑰已儲存",
  "Key missing": "缺少金鑰",
  "Delete credential {{name}}": "刪除憑據 {{name}}",
  "Edit credential — {{name}}": "編輯憑據 — {{name}}",
  "Keys are only written to the system credential manager; the database keeps a reference only.":
    "密钥只写入系统凭据管理器，数据库仅保存引用，保存后无法在界面再次查看。",
  "The private key and its passphrase are one configuration; an empty passphrase means an unencrypted key.":
    "私钥与私钥口令是一组配置：口令为空时按未加密私钥处理。",
  "The password is written to the system credential manager and cannot be viewed again later.":
    "密码会写入系统凭据管理器，保存后无法在界面上再次查看。",
  "Private key content": "私鑰內容",
  "Key passphrase": "私鑰口令",
  "Only needed when the private key itself is encrypted; leave empty for no passphrase":
    "私钥本身加密时才需要；留空表示无口令或保持原口令",
  "Login password (required)": "登入密碼（必填）",
  "Leave unchanged": "留空保持不變",
  "Leave empty to keep the saved private key": "留空表示保留已儲存的私鑰",
  "Leave empty to keep the saved password": "留空表示保留已儲存的密碼",
  "e.g. production root": "例如 生產環境 root",
  "Paste the private key content when creating a key credential.": "建立私鑰憑據時必須貼上私鑰內容。",
  "Fill in the password when creating a password credential.": "建立密碼憑據時必須填寫密碼。",
  "Delete credential “{{name}}”? The key in the system credential manager is removed too.":
    "确定删除凭据“{{name}}”吗？此操作会同时清除系统凭据管理器中的密钥。",
  "{{count}} servers are using credential “{{name}}”.\nAfter deletion they become “no credential” and must be re-selected before connecting.\n\nDelete anyway?":
    "有 {{count}} 台服务器正在使用凭据“{{name}}”。\n删除后这些服务器会变为“未绑定凭据”，需要重新选择才能连接。\n\n确定继续删除吗？",

  // -- 已知主機 / 資料 --
  "Known hosts": "已知主機",
  "Fingerprints you confirmed on first connect are listed here.": "首次連線時確認過的伺服器指紋會記錄在這裡。",
  Data: "資料",
  "Command history": "命令歷史",
  "Commands you run in the terminal will appear here.": "在終端中執行命令後會出現在這裡。",
  "No server": "未關聯伺服器",
  "Audit log": "審計日誌",
  "No audit records yet.": "還沒有審計記錄。",

  // -- 執行環境 --
  Runtime: "執行環境",
  Version: "版本",
  Platform: "平臺",
  Database: "資料庫",
} as const;
