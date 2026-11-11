/**
 * 数据库工作台的错误原因与导出格式说明。
 * 这些文案之前是硬编码中文（没走 i18n），现在改为 `i18n.t(...)`，这里提供英文。
 */
export default {
  "会话连接已关闭，请重新连接": "The session is closed; reconnect to continue",
  "原事务与临时表无法恢复；重连不会自动重跑 SQL。":
    "The transaction and temporary tables are lost; reconnecting does not re-run SQL.",
  "会话不存在，无法执行事务命令": "The session no longer exists; the transaction command can't run",
  "未知数据库": "Unknown database",

  // -- 导出格式说明 --
  "逗号分隔，适合 Excel 与通用数据交换。NULL 为空字段，空字符串为双引号。":
    "Comma separated, good for Excel and general exchange. NULL becomes an empty field; an empty string is quoted.",
  "制表符分隔，适合表格工具。含制表符、引号或换行的内容会自动转义。":
    "Tab separated for spreadsheet tools; tabs, quotes and newlines are escaped automatically.",
  "导出为对象数组。整数与 DECIMAL 保留为字符串，避免精度丢失；NULL 保留为 null。":
    "An array of objects. Integers and DECIMAL stay strings to preserve precision; NULL stays null.",
  "每行一个 JSON 对象，适合流式处理。整数与 DECIMAL 保留为字符串。":
    "One JSON object per line, suitable for streaming. Integers and DECIMAL stay strings.",
  "按当前数据库方言生成 INSERT 语句，仅导出数据，不包含建表语句。":
    "INSERT statements in the current dialect; data only, no DDL.",
  "导出为可在浏览器查看的表格，字段内容会转义，不执行 HTML。":
    "An HTML table; field contents are escaped and never executed.",
  "按记录与字段组织，保留 NULL 标记。二进制与 XML 不支持的字符使用 Base64。":
    "Organized by record and field with explicit NULLs; unsupported binary/XML characters use Base64.",

  // -- 查询结果编辑的只读原因 --
  "执行型注释的查询结果只读": "Results from executable comments are read-only",
  "无法完整解析查询来源": "The query source can't be fully parsed",
  "含反斜杠转义的查询暂不支持结果编辑":
    "Queries with backslash escapes don't support result editing yet",
  "仅支持单表 SELECT 结果编辑": "Only single-table SELECT results can be edited",
  "联表、去重、聚合或子查询结果只读": "Joins, DISTINCT, aggregates and subqueries are read-only",
  "无法确定查询的原始表": "The underlying table can't be determined",
  "计算列或表达式结果只读": "Computed columns and expressions are read-only",
  "无法确定字段来源": "The column source can't be determined",
  "不支持该表名限定方式": "This table qualifier form is not supported",
  "无法确定表别名": "The table alias can't be resolved",
  "该引擎暂不支持查询结果编辑": "This engine does not support editing query results",
  "结果缺少可验证的来源信息，请重新执行查询":
    "The result lacks verifiable origin; re-run the query",
  "查询表与字段来源不一致，结果只读":
    "Table and column origins disagree; the result is read-only",
  "结果包含来源不明或不同表的字段": "The result contains columns of unknown or mixed origin",
  "结果重复包含同一字段，无法安全回写":
    "The result includes the same column twice; safe write-back is impossible",
  "视图查询结果只读": "Results from a view are read-only",
  "原表没有主键，查询结果只读": "The base table has no primary key, so the result is read-only",
  "查询结果必须包含完整主键（含联合主键全部字段）":
    "The result must include the full primary key (every composite column)",
  "表结构已变化，请重新执行查询": "The table structure changed; re-run the query",
  "主键值不完整或类型不支持，无法安全定位记录":
    "The primary key is incomplete or its type is unsupported, so the row can't be located safely",
  "结果主键重复，无法唯一定位原记录":
    "The result has duplicate primary keys; the original rows can't be identified",
  "结果缺少完整查询信息，请重新执行查询": "The result lacks full query context; re-run the query",
  "连接、权限或事务状态已变化，请重新执行查询":
    "The connection, privileges or transaction changed; re-run the query",
  "原表主键已变化，请重新执行查询": "The base table's primary key changed; re-run the query",
  "查询结果已变化，已停止提交": "The result changed; submitting stopped",
  "记录已变化": "The row changed",
  "字段已变化": "The column changed",
} as const;
