/** zh-CN · 服务器列表（分组/收藏/表单/凭据/主机指纹） —— 由对应模块的 i18n 代理维护。 */
export default {
  // -- 模块标题（module-server-sidebar 的 MODULE_TITLE 存 key，渲染处 t()） --
  "Server list": "服务器列表",
  Servers: "服务器",
  Services: "服务",
  Logs: "日志",
  Projects: "项目",
  Commands: "命令",
  Deploy: "部署",
  Tasks: "任务",
  "AI assistant": "智能助手",
  Settings: "设置",

  // -- 分组 / 列表 --
  Ungrouped: "未分组",
  "Group {{name}} does not exist, {{count}} servers moved to Ungrouped":
    "分组 {{name}} 不存在，{{count}} 台服务器已归入未分组",
  Favorites: "收藏",
  "No servers": "暂无服务器",
  "No servers yet — click + to add one": "暂无服务器，点击 + 新增",

  // -- 侧栏头部动作（图标行 = 空白区右键菜单，同一组 key） --
  "Refresh servers": "刷新服务器",
  "Add server": "新增服务器",
  "New group": "新增分组",
  "Collapse sidebar": "收起侧边栏",

  // -- 服务器行右键菜单 --
  "Open terminal": "打开终端",
  "Open monitor": "打开监控",
  "Service manager": "服务管家",
  "Log center": "日志中心",
  Favorite: "收藏",
  Unfavorite: "取消收藏",
  "Favorite {{name}}": "收藏 {{name}}",
  "Unfavorite {{name}}": "取消收藏 {{name}}",
  "Move to group": "移动到分组",
  Current: "当前",
  "Edit server": "编辑服务器",
  "Delete server": "删除服务器",
  Jump: "跳板",

  // -- 分组重命名 / 新建分组 --
  "Rename group {{name}}": "重命名分组 {{name}}",
  "Delete group {{name}}": "删除分组 {{name}}",
  "Group name {{name}}": "分组名称 {{name}}",
  "Save group name": "保存分组名称",
  "Cancel rename": "取消重命名",
  "New group name": "新分组名称",
  "Group name, press Enter to save": "分组名称，回车保存",
  "Save group": "保存分组",
  "Cancel new group": "取消新增分组",

  // -- 删除确认（ConfirmDialog） --
  "Delete group": "删除分组",
  'Deleting "{{name}}" also deletes its sessions and command history. This cannot be undone.':
    "删除“{{name}}”会同时删除它的会话与命令历史。此操作不可撤销。",
  'Group "{{name}}" contains {{count}} servers.\nAfter deleting the group they become "Ungrouped"; the servers themselves are not deleted.\n\nDelete this group?':
    "分组“{{name}}”中有 {{count}} 台服务器。\n删除分组后这些服务器会变为“未分组”，服务器本身不会被删除。\n\n确定删除分组吗？",
  'Delete group "{{name}}"?': "确定删除分组“{{name}}”吗？",

  // -- 服务器表单 --
  Saved: "已保存",
  "Edit server — {{name}}": "编辑服务器 — {{name}}",
  "Credentials are stored in the system keychain; the database only keeps a reference.":
    "凭据密钥保存在系统凭据管理器中，数据库只保存引用。",
  "Save Ctrl+S": "保存 Ctrl+S",
  "e.g. API-01": "例如 API-01",
  "10.0.0.11 or example.com": "10.0.0.11 或 example.com",
  Credential: "凭据",
  "No credentials yet. Create one in Settings → Credentials": "还没有凭据，请在“设置 → 凭据”中创建",
  "No credential": "未绑定凭据",
  "Private key": "私钥",
  Group: "分组",
  Tags: "标签",
  "Separate with commas": "用逗号分隔",
  "Jump host (ProxyJump)": "跳板机 (ProxyJump)",
  "Leave empty for direct connection; the jump host itself also needs a credential":
    "留空表示直连；跳板机自身也需要绑定凭据",
  "Direct connection": "直连",
  "Test connection": "测试连接",
  "Testing…": "测试中…",
  "Save the server before testing the connection": "请先保存服务器后再测试连接",
  "Connected ({{name}})": "连接成功（{{name}}）",
  "Waiting for host key confirmation…": "等待主机指纹确认…",
  "Host key rejected": "已拒绝该主机指纹",

  // -- 主机指纹确认（安全关键文案，措辞必须精确） --
  "Host key has changed": "主机指纹已变化",
  "First connection — confirm the host key": "首次连接，请确认主机指纹",
  "{{host}} returned a host key that does not match the saved one. If you did not expect this change, it could be a man-in-the-middle attack — refuse and verify with the server administrator.":
    "{{host}} 返回的主机密钥与已保存的不一致。如果这不是你预期中的变更，可能是中间人攻击——请拒绝并向服务器管理员核实。",
  "The host key of {{host}} is not trusted yet. Verify the fingerprint before continuing.":
    "{{host}} 的主机密钥尚未被信任。请核对指纹后再继续。",
  Refuse: "拒绝",
  "Trust and connect": "信任并连接",
  "Trust new key and reconnect": "信任新指纹并重连",
  "This is the fingerprint of the jump host, not of the target server {{host}}. The jump host is recorded first; the target server's fingerprint is asked next.":
    "这是跳板机的指纹，不是目标服务器 {{host}} 的。信任后会先记录跳板机，随后再询问目标服务器的指纹。",
  "Previously trusted fingerprint": "此前已信任的指纹",
  "After accepting, the fingerprint is stored in Known Hosts. View or remove it in Settings → Known Hosts.":
    "接受后指纹会写入 Known Hosts，可在“设置 → 已知主机”中查看或删除。",
  "No trusted host keys yet. You will be asked on first connection.":
    "还没有信任任何主机密钥，首次连接时会自动询问。",
  "Delete fingerprint for {{name}}": "删除 {{name}} 的指纹",
} as const;
