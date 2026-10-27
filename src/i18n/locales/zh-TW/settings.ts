/** zh-TW · 設定（外觀/憑據/已知主機/語言）。 */
export default {
  // -- 外觀 --
  Appearance: "外觀",
  Theme: "主題",
  Language: "語言",
  "Follow system": "跟隨系統",
  // 主題分段控件上的**短標籤**（THEME_OPTIONS.shortKey）。
  System: "系統",
  Light: "淺色",
  Dark: "深色",

  // -- 終端 --
  Terminal: "終端",
  "The font is shared by the terminal and the command output panel.":
    "終端與命令輸出面板共用同一套字型。",
  "Compact prompt": "精簡提示符",
  "Shows only the current path instead of user@host (e.g. ~#, /opt#, /opt/app#). One command is sent to the remote shell after connecting — session only, no server config file is touched.":
    "提示符只保留目前路徑、去掉 user@host（如 ~#、/opt#、/opt/app#）。連線成功後向遠端 shell 傳送一條命令生效：僅本次工作階段有效，不修改伺服器上的任何設定檔。",

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
  "Select a private key file": "選擇私鑰檔案",
  "Import from file": "從檔案匯入",
  "Reading file": "讀取中",
  "Loaded {{name}}": "已讀取 {{name}}",
  "Loaded {{name}} — it is encrypted, enter its passphrase below":
    "已讀取 {{name}} — 該私鑰已加密，請在下方填寫口令",
  "Clear the saved passphrase": "清除已儲存的口令",
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

  // -- 設定備份與還原（settings-backup） --
  "Backup & restore": "備份與還原",
  "Move servers, groups, tags, jump hosts, projects and preferences to another machine. Secrets are never exported — rebind credentials after importing.":
    "把伺服器、群組、標籤、跳板、專案與偏好遷移到另一台機器。金鑰不會被匯出，匯入後需要重新綁定憑證。",
  "Export configuration": "匯出設定",
  "Writes a JSON file. Passwords and private keys stay in the system credential manager.":
    "寫出一份 JSON 檔案。密碼與私鑰仍留在系統憑證管理員裡。",
  "Import configuration": "匯入設定",
  "Preview first: you decide whether existing entries are kept or overwritten.":
    "先預覽再匯入：已存在的項目是保留還是覆蓋，由你決定。",
  "Export…": "匯出…",
  "Import…": "匯入…",
  "Exporting…": "正在匯出…",
  "Reading…": "正在讀取…",
  "Importing…": "正在匯入…",
  "Exported {{servers}} servers, {{groups}} groups, {{credentials}} credentials and {{projects}} projects to {{path}}":
    "已匯出 {{servers}} 台伺服器、{{groups}} 個群組、{{credentials}} 個憑證、{{projects}} 個專案到 {{path}}",
  "Imported: {{added}} added, {{overwritten}} overwritten, {{skipped}} skipped. Rebind credentials before connecting.":
    "匯入完成：新增 {{added}} 項，覆蓋 {{overwritten}} 項，略過 {{skipped}} 項。連線前請重新綁定憑證。",
  "{{count}} preferences restored.": "已還原 {{count}} 項偏好設定。",
  "From {{path}} · exported by version {{version}}": "來源：{{path}} · 由版本 {{version}} 匯出",
  "{{total}} total": "共 {{total}} 項",
  "{{count}} conflicts": "{{count}} 項衝突",
  "Conflicts (already on this machine)": "衝突項（本機已存在）",
  "Overwrite existing entries (off = import new entries only, keep this machine's version)":
    "覆蓋已存在的項目（關閉時只匯入新增，本機版本保持不變）",
  "Import {{count}} entries": "匯入 {{count}} 項",
  "Project reviews": "專案複核結論",
  "Project merges": "專案合併關係",
  "Credentials are exported without secrets — rebind them after importing":
    "憑證匯出時不帶金鑰 —— 匯入後需要重新綁定。",
  "This backup was written by an older format version": "這份備份由較舊的格式版本寫出。",

  // -- 生產環境保護（巡檢模式 / 環境標記）--
  Safety: "安全",
  "Client-side guard rails only: they stop accidental clicks, not a determined operator. A read-only shell still needs a restricted account on the server.":
    "只是客戶端的防誤操作：能擋住誤點，擋不住執意執行的人。真正的唯讀終端需要伺服器上設定受限帳號。",
  "Inspection mode (read-only)": "巡檢模式（唯讀）",
  "Blocks uploads, edits, deletes and service changes in this app. It cannot make a free shell read-only.":
    "在本應用內停用上傳、編輯、刪除與服務變更。它無法把自由終端變成唯讀。",
  "Not specified": "未指定",
  Production: "生產",
  Staging: "預發",
  Development: "開發",
  "Server environment: {{environment}}": "伺服器環境：{{environment}}",
  Environment: "環境",
  "Production servers are highlighted everywhere and are the first thing a confirmation dialog names.":
    "生產伺服器會在各處高亮；確認框也會先說明目標伺服器。",
} as const;
