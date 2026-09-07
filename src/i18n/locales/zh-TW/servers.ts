/** zh-TW · 伺服器列表（分組/收藏/表單/憑據/主機指紋） —— 由對應模組的 i18n 代理維護。 */
export default {
  // -- 模組標題（module-server-sidebar 的 MODULE_TITLE 存 key，渲染處 t()） --
  "Server list": "伺服器列表",
  Servers: "伺服器",
  Services: "服務",
  Logs: "日誌",
  Projects: "專案",
  Commands: "命令",
  Deploy: "部署",
  Tasks: "任務",
  "AI assistant": "智慧助手",
  Settings: "設定",

  // -- 分組 / 列表 --
  Ungrouped: "未分組",
  "Group {{name}} does not exist, {{count}} servers moved to Ungrouped":
    "分组 {{name}} 不存在，{{count}} 台服务器已归入未分组",
  Favorites: "收藏",
  "No servers": "暫無伺服器",
  "No servers yet — click + to add one": "暫無伺服器，點選 + 新增",

  // -- 側欄頭部動作（圖示行 = 空白區右鍵選單，同一組 key） --
  "Refresh servers": "重新整理伺服器",
  "Add server": "新增伺服器",
  "New group": "新增分組",
  "Collapse sidebar": "收起側邊欄",

  // -- 伺服器行右鍵選單 --
  "Open terminal": "開啟終端",
  "Open monitor": "開啟監控",
  "Service manager": "服務管家",
  "Log center": "日誌中心",
  Favorite: "收藏",
  Unfavorite: "取消收藏",
  "Favorite {{name}}": "收藏 {{name}}",
  "Unfavorite {{name}}": "取消收藏 {{name}}",
  "Move to group": "移動到分組",
  Current: "當前",
  "Edit server": "編輯伺服器",
  "Delete server": "刪除伺服器",
  Jump: "跳板",

  // -- 分組重新命名 / 新建分組 --
  "Rename group {{name}}": "重新命名分組 {{name}}",
  "Delete group {{name}}": "刪除分組 {{name}}",
  "Group name {{name}}": "分組名稱 {{name}}",
  "Save group name": "儲存分組名稱",
  "Cancel rename": "取消重新命名",
  "New group name": "新分組名稱",
  "Group name, press Enter to save": "分組名稱，回車儲存",
  "Save group": "儲存分組",
  "Cancel new group": "取消新增分組",

  // -- 刪除確認（ConfirmDialog） --
  "Delete group": "刪除分組",
  'Deleting "{{name}}" also deletes its sessions and command history. This cannot be undone.':
    "删除“{{name}}”会同时删除它的会话与命令历史。此操作不可撤销。",
  'Group "{{name}}" contains {{count}} servers.\nAfter deleting the group they become "Ungrouped"; the servers themselves are not deleted.\n\nDelete this group?':
    "分组“{{name}}”中有 {{count}} 台服务器。\n删除分组后这些服务器会变为“未分组”，服务器本身不会被删除。\n\n确定删除分组吗？",
  'Delete group "{{name}}"?': "確定刪除分組“{{name}}”嗎？",

  // -- 伺服器表單 --
  Saved: "已儲存",
  "Edit server — {{name}}": "編輯伺服器 — {{name}}",
  "Credentials are stored in the system keychain; the database only keeps a reference.":
    "凭据密钥保存在系统凭据管理器中，数据库只保存引用。",
  "Save Ctrl+S": "儲存 Ctrl+S",
  "e.g. API-01": "例如 API-01",
  "10.0.0.11 or example.com": "10.0.0.11 或 example.com",
  Credential: "憑據",
  "No credentials yet. Create one in Settings → Credentials": "還沒有憑據，請在“設定 → 憑據”中建立",
  "No credential": "未繫結憑據",
  "Private key": "私鑰",
  Group: "分組",
  Tags: "標籤",
  "Separate with commas": "用逗號分隔",
  "Jump host (ProxyJump)": "跳板機 (ProxyJump)",
  "Leave empty for direct connection; the jump host itself also needs a credential":
    "留空表示直连；跳板机自身也需要绑定凭据",
  "Direct connection": "直連",
  "Test connection": "測試連線",
  "Testing…": "測試中…",
  "Save the server before testing the connection": "請先儲存伺服器後再測試連線",
  "Connected ({{name}})": "連線成功（{{name}}）",
  "Waiting for host key confirmation…": "等待主機指紋確認…",
  "Host key rejected": "已拒絕該主機指紋",

  // -- 主機指紋確認（安全關鍵文案，措辭必須精確） --
  "Host key has changed": "主機指紋已變化",
  "First connection — confirm the host key": "首次連線，請確認主機指紋",
  "{{host}} returned a host key that does not match the saved one. If you did not expect this change, it could be a man-in-the-middle attack — refuse and verify with the server administrator.":
    "{{host}} 返回的主机密钥与已保存的不一致。如果这不是你预期中的变更，可能是中间人攻击——请拒绝并向服务器管理员核实。",
  "The host key of {{host}} is not trusted yet. Verify the fingerprint before continuing.":
    "{{host}} 的主机密钥尚未被信任。请核对指纹后再继续。",
  Refuse: "拒絕",
  "Trust and connect": "信任並連線",
  "Trust new key and reconnect": "信任新指紋並重連",
  "This is the fingerprint of the jump host, not of the target server {{host}}. The jump host is recorded first; the target server's fingerprint is asked next.":
    "这是跳板机的指纹，不是目标服务器 {{host}} 的。信任后会先记录跳板机，随后再询问目标服务器的指纹。",
  "Previously trusted fingerprint": "此前已信任的指紋",
  "After accepting, the fingerprint is stored in Known Hosts. View or remove it in Settings → Known Hosts.":
    "接受后指纹会写入 Known Hosts，可在“设置 → 已知主机”中查看或删除。",
  "No trusted host keys yet. You will be asked on first connection.":
    "还没有信任任何主机密钥，首次连接时会自动询问。",
  "Delete fingerprint for {{name}}": "刪除 {{name}} 的指紋",
  "No entries under \"Servers\" on the left yet — add a server first.":
    "左侧「服务器」下还没有任何条目 —— 请先添加一台服务器。",
  "Select \"one-time password\" to connect without any saved credentials":
    "选择「一次性密码」即可在不保存任何凭据的情况下连接",
} as const;
