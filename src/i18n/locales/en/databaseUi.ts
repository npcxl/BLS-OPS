/**
 * 数据库工作台剩余界面文案的英文（第一批：通用组件、连接、侧栏、标签、导出、结果网格）。
 *
 * 与 `database.ts` / `databaseWorkspace.ts` 同样的写法：key 是代码里的中文原文，
 * value 是英文；没列到的 key 仍旧回退成中文。
 */
export default {
  // -- 通用组件 --
  "右键菜单构建失败": "Failed to build the context menu",
  "清除": "Clear",
  "菜单动作执行失败": "Menu action failed",
  "桌面菜单未能显示，已回退到页面内菜单": "The native menu could not open; fell back to the in-page menu",
  "右键仍然可用；这条提示每次运行只出现一次": "Right-click still works; this notice appears once per run",
  "菜单窗口未在 {{ms}}ms 内确认显示": "The menu window did not confirm visibility within {{ms}}ms",
  "连接失败": "Connection failed",
  "Redis 连接失败": "Redis connection failed",
  "{{combo}} 已被「{{action}}」占用，换一个组合": "{{combo}} is already used by “{{action}}”; pick another",

  // -- 连接对话框（Redis / 校验）--
  "请填写数据库文件路径": "Enter the database file path",
  "请填写主机，或提供连接 URI": "Enter a host, or provide a connection URI",
  "数据库主机不能为空": "Database host is required",
  "用户名不能为空": "Username is required",
  "无法读取数据库引擎目录": "Could not read the engine catalog",
  "重试": "Retry",
  "正在读取数据库引擎目录…": "Loading the engine catalog…",
  "该类型已移出新建连接列表：{{reason}}": "This engine is no longer offered for new connections: {{reason}}",
  "用户名（ACL，可选）": "Username (ACL, optional)",
  "Redis 6+ ACL 才有用户名；留空 = 只用密码": "Only Redis 6+ ACL has a username; leave empty to use just the password",
  "Redis 默认没有密码；只有开了 requirepass / ACL 才需要填":
    "Redis has no password by default; only needed with requirepass / ACL",
  "Redis 连接模式": "Redis connection mode",
  "模式": "Mode",
  "单机（Standalone）": "Standalone",
  "支持 SSH 隧道": "SSH tunnel supported",
  "哨兵（Sentinel）": "Sentinel",
  "直连，不走隧道": "Direct, no tunnel",
  "集群（Cluster）": "Cluster",
  "直连，仅 db 0": "Direct, db 0 only",
  "Master 名称": "Master name",
  "sentinel.conf 里的 mymaster 之类的名字": "The name from sentinel.conf, e.g. mymaster",
  "其余哨兵节点（可选，JSON 数组）": "Other sentinels (optional, JSON array)",
  '例如 ["10.0.0.2:26379","10.0.0.3:26379"]；主机:端口已包含首个哨兵':
    'e.g. ["10.0.0.2:26379","10.0.0.3:26379"]; host:port above already covers the first sentinel',
  '例如 [\\"10.0.0.2:26379\\",\\"10.0.0.3:26379\\"]；主机:端口已包含首个哨兵':
    'e.g. ["10.0.0.2:26379","10.0.0.3:26379"]; host:port above already covers the first sentinel',
  "其余集群节点（可选，JSON 数组）": "Other cluster nodes (optional, JSON array)",
  "至少给出一个可达节点即可，客户端会自动发现其余分片":
    "One reachable node is enough; the client discovers the rest",
  "未加密": "Unencrypted",
  "隧道": "Tunnel",
  "只读": "Read-only",

  // -- 资产侧栏 --
  "关闭": "Close",
  "刷新": "Refresh",
  "编辑连接": "Edit connection",
  "该引擎暂不支持浏览表数据": "This engine does not support browsing table data",
  "{{name}} · 删除失败": "{{name}} · delete failed",
  "新建查询": "New query",
  "未接入": "Not wired up",
  "折叠侧栏": "Collapse sidebar",
  "打开 db {{index}}": "Open db {{index}}",
  "当前库": "Current database",
  "db {{index}} 的全部键": "All keys in db {{index}}",
  "所有数据": "All data",

  // -- 标签栏 --
  "有未保存的修改": "Has unsaved changes",
  "向左滚动标签": "Scroll tabs left",
  "工作区标签": "Workspace tabs",
  "预览标签，双击保留": "Preview tab; double-click to keep it",
  "预览": "Preview",
  "向右滚动标签": "Scroll tabs right",

  // -- 数据库视图 --
  "正在应用结果修改，请等待完成后关闭": "Applying result edits; wait for it to finish before closing",
  "只读事务": "Read-only transaction",
  "关闭详情": "Close details",
  "重连": "Reconnect",
  "调整右侧面板宽度": "Resize the right panel",

  // -- 行编辑 / 引擎面板 --
  "字段值类型": "Value type",
  "{{engine}} 的驱动尚未实现": "The {{engine}} driver is not implemented yet",
  "已保存的配置": "Saved configuration",
  "（文件型 / 无主机）": "(file-based / no host)",
  "未指定": "Not set",
  "实现状态": "Implementation",
  "已实现": "Implemented",
  "仅配置（无驱动）": "Configuration only (no driver)",
  "验证等级": "Verification level",
  "未验证": "Unverified",
  "能力矩阵": "Capability matrix",
  "来自引擎注册表，前端不做引擎判断": "From the engine registry; the UI does not decide capabilities",
  "驱动尚未接入": "Driver not wired up",

  // -- 导出 --
  "最多行数必须是有效的非负整数": "Max rows must be a valid non-negative integer",
  "导出数据": "Export data",
  "查询结果": "Query result",
  "文件格式": "File format",
  "仅表数据": "Table data only",
  "导出选项": "Export options",
  "便于 Excel 识别中文": "Helps Excel detect Chinese text",
  "按当前筛选与排序重新查询导出，数据可能与页面显示不同。二进制字段以 Base64 保存，SQL 使用数据库二进制字面量。":
    "Re-queries with the current filter and sort, so data may differ from the screen. Binary columns use Base64 in CSV/JSON and binary literals in SQL.",
  "行": "Rows",

  // -- 复制菜单 / 历史 / 空状态 / 待提交列表 --
  "复制": "Copy",
  "复制（含列名）": "Copy (with headers)",
  "复制为 CSV": "Copy as CSV",
  "清空全部历史记录？": "Clear the entire history?",
  "这条连接上记录过的 SQL 会被全部删除，无法恢复。":
    "Every recorded statement for this connection is deleted and can't be restored.",
  "共 {{count}} 条记录": "{{count}} records",
  "双击左侧表，或新建查询。": "Double-click a table on the left, or start a new query.",
  "暂无变更": "No changes",
  "修改": "Changes",
  "原值": "Original",
  "新值": "New",

  // -- 查询结果网格 --
  "所选字段包含只读、二进制或截断值，不能修改":
    "The selection includes read-only, binary or truncated values; it can't be edited",
  "所选字段不允许 NULL，已阻止修改": "The selection does not allow NULL; the edit was blocked",
  "提交结果未知，请核对数据库；已停止重复提交":
    "Commit outcome unknown: verify the database. Repeated submits are stopped.",
  "已回滚，暂存修改已保留": "Rolled back; staged edits are kept",
  "修改已写入，但无法重新读取记录。请重新运行查询后继续编辑。":
    "Changes were written, but the rows can't be re-read. Re-run the query to keep editing.",
  "修改已写入；重新运行查询可更新筛选与排序。":
    "Changes were written; re-run the query to refresh filters and sorting.",
  "查看值": "View value",
  "只读：{{reason}}": "Read-only: {{reason}}",
  "可编辑 · {{table}}": "Editable · {{table}}",
  "重做": "Redo",
  "还原": "Restore",
  "查询结果仅支持字段修改；删除记录请从表数据页操作":
    "Ad-hoc results only support field edits; delete rows from the table data page",
  "选择范围过大，请缩小范围后再清空": "The selection is too large; narrow it before clearing",
  "粘贴包含不可写字段、类型不符或超出范围，已阻止修改":
    "The paste includes unwritable columns, type mismatches or out-of-range values; it was blocked",
  "确认粘贴": "Confirm paste",
  "将暂存 {{count}} 个单元格，点击应用后才写入数据库。":
    "{{count}} cells will be staged; nothing is written until you apply.",
} as const;
