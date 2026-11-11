/**
 * 表数据页 / SQL 工作区 / 结果区的剩余英文文案。
 * key 是代码里的中文原文，未列到的仍旧回退成中文。
 */
export default {
  // -- 表数据页状态 --
  "连接已断开，查询与修改已暂停": "Connection lost; queries and edits are paused",
  "该连接被设为只读": "This connection is read-only",
  "该引擎暂不支持编辑表数据": "This engine does not support editing table data",
  "视图不可直接写": "Views can't be written directly",
  "没有主键或唯一键，无法安全定位要修改的行":
    "No primary or unique key, so rows can't be located safely",
  "正在读取表结构…": "Loading columns…",
  "该引擎暂不支持浏览表数据：{{reason}}": "This engine does not support browsing table data: {{reason}}",
  "读取表结构失败": "Failed to load the column information",
  "结构编辑不可用：{{reason}}": "Structure editing is unavailable: {{reason}}",

  // -- 复制 / 生成语句 --
  "选中内容超过复制上限，请改用「导出」按整表导出。":
    "The selection exceeds the copy limit; use Export to dump the whole table.",
  "选中内容超过复制上限，请改用导出。": "The selection exceeds the copy limit; use Export.",
  "当前结果没有可靠的表名与字段信息，无法生成 INSERT。":
    "This result has no reliable table or column identity, so an INSERT can't be generated.",
  "SQL 结果没有可靠的表名与字段信息，无法生成 INSERT。":
    "The SQL result has no reliable table or column identity, so an INSERT can't be generated.",
  "选中数据包含截断或二进制字段，无法生成完整的 INSERT。":
    "The selection contains truncated or binary values, so a complete INSERT can't be generated.",

  // -- 粘贴 --
  "该表没有可靠主键或是只读连接，无法粘贴":
    "No reliable primary key, or the connection is read-only; pasting is disabled",
  "粘贴内容没有可写入的单元格（只读列 / 类型不符）":
    "The paste has no writable cells (read-only columns or type mismatches)",
  "已加入待提交队列：{{count}} 个单元格": "Queued {{count}} cells as pending changes",
  "按行选择时请用右键「删除选中行」；Delete 只清空单元格":
    "To delete rows use “Delete selected rows” from the context menu; Delete only clears cells",
  "选择范围过大（{{count}} 格），请缩小范围后再清空":
    "The selection is too large ({{count}} cells); narrow it before clearing",
  "已清空 {{count}} 个单元格（未提交）": "Cleared {{count}} cells (not committed)",
  "请先在表格里选择一个单元格": "Select a cell in the grid first",
  "{{failed}} 处未写入，{{applied}} 处已提交": "{{failed}} not written, {{applied}} committed",
  "粘贴": "Paste",
  "粘贴预览": "Paste preview",
  "写入待提交队列": "Add to pending changes",
  "{{count}} 个单元格被跳过：": "{{count}} cells were skipped: ",
  "只读列（二进制/位/几何）": "Read-only columns (binary/bit/geometry)",
  "类型不符": "Type mismatch",
  "该行没有可靠唯一键": "The row has no reliable unique key",
  "…等 {{count}} 项": "…and {{count}} more",
  "{{count}} 个单元格超出当前已加载范围，已丢弃（不会扩展查询）。":
    "{{count}} cells fall outside the loaded range and were dropped (the query is not extended).",
  "粘贴只写入待提交队列，仍需点「应用修改」才会在事务里提交。":
    "Pasting only stages changes; they are committed in the transaction after you apply.",

  // -- 行操作 --
  "删除这一行？": "Delete this row?",
  "行 {{label}} 会被标记为删除，点「应用修改」后才会真正写入数据库。":
    "Row {{label}} is marked for deletion; it is written only after you apply.",
  "提交后无法撤销；提交前可以在待提交列表里撤回。":
    "A commit can't be undone; before committing you can revert from the pending list.",
  "新增一行": "Insert a row",
  "应用 {{count}} 项修改": "Apply {{count}} changes",
  "撤销未提交修改（Ctrl+Z）": "Undo uncommitted changes (Ctrl+Z)",
  "重做（Ctrl+Shift+Z）": "Redo (Ctrl+Shift+Z)",
  "放弃全部未提交修改（不写数据库）": "Discard all uncommitted changes (nothing is written)",
  "筛选条件": "Filter",
  "数据网格": "Data grid",
  "全选（Ctrl+A）": "Select all (Ctrl+A)",
  "排序": "Sort",
  "编辑单元格": "Edit cell",
  "固定到最左": "Pin to the left",
  "固定项不参与预览替换": "Pinned items are not replaced by previews",

  // -- 分页 / 估算 --
  "键集分页：按可靠唯一键定位，翻页不会随页码变慢":
    "Keyset pagination: located by a reliable unique key, so deep pages stay fast",
  "偏移分页：排序或唯一键不满足键集条件，跨页可能重复/漏行":
    "Offset pagination: the sort or key doesn't fit keyset paging, so pages may repeat or skip rows",
  "本页 {{count}} 行": "{{count}} rows on this page",
  "第 {{from}}–{{to}} 行": "Rows {{from}}–{{to}}",
  "已截断": "Truncated",
  "来自 information_schema 的估算值，不是精确 COUNT":
    "An estimate from information_schema, not an exact COUNT",
  "约 {{count}} 行（估算）": "about {{count}} rows (estimated)",
  "本次查询耗时": "Query time",
  "每页行数": "Rows per page",
  "跳过并发校验，仍然应用": "Skip the concurrency check and apply anyway",
  "放弃并刷新": "Discard and refresh",

  // -- SQL 工作区 --
  "左侧双击表打开数据页；或新建一份独立 SQL 查询。":
    "Double-click a table on the left, or start a standalone SQL query.",
  "双击左侧表打开数据页，或新建查询。": "Double-click a table on the left, or start a new query.",
  "新建一份独立的 SQL 查询": "Start a standalone SQL query",
  "执行结果": "Execution result",
  "截断": "Truncated",
  "{{action}}已完成": "{{action}} finished",
  "请先应用或还原结果修改，再重新运行查询":
    "Apply or revert the result edits before running the query again",
  "请先应用或还原结果修改，再清空结果": "Apply or revert the result edits before clearing",
  "提交事务": "Commit transaction",
  "回滚事务": "Roll back transaction",
  "开启事务": "Begin transaction",
  "开启后，本会话的语句要显式提交才生效":
    "Once enabled, statements in this session only take effect after an explicit commit",
  "手动事务（只读）": "Manual transaction (read-only)",
  "手动事务：未提交": "Manual transaction: uncommitted",
  "自动提交": "Auto-commit",
  "本标签的语句已在事务里，关闭标签前必须选择提交或回滚。":
    "Statements in this tab are inside a transaction; choose commit or rollback before closing.",
  "每条语句单独提交。需要多条语句一起生效时，开启事务。":
    "Each statement commits on its own. Begin a transaction when several must apply together.",
  "该引擎不支持取消查询": "This engine does not support cancelling queries",
  "停止": "Stop",
  "该引擎暂不支持导出": "This engine does not support export",
  "导出会重新执行这条只读 SQL（{{reason}}）": "Export re-runs this read-only statement ({{reason}})",
  "确定执行这些删除语句？": "Run these DELETE statements?",
  "语句会直接删除数据库里的数据，执行后无法撤销。":
    "They delete data immediately and can't be undone.",
  "还有 {{count}} 条语句未展开": "{{count}} more statements not expanded",

  // -- 部署 / 日志中心 --
  "目标服务器": "Target server",
  "协议": "Protocol",
  "分类": "Category",
  "适用范围": "Scope",
  "来源类型": "Source type",
  "优先级": "Priority",
} as const;
