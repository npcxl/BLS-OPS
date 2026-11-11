/**
 * 数据库引擎注册表里的说明文案（英文）。
 *
 * 这些字符串由 Rust 后端 `engine_registry.rs` 生成并随目录一起下发，
 * 前端只做展示（`EngineSelect` / `EngineImplementationPanel` 用 `t()` 包了一层）。
 * 中文界面命中不到 key 时 i18next 原样返回中文原文 —— 所以这里只需补英文。
 */
export default {
  // -- 连接表单里按引擎变化的字段名与占位符 --
  "数据库文件路径": "Database file path",
  "服务名 / SID": "Service name / SID",
  "数据库名": "Database name",
  "例如 postgres": "e.g. postgres",
  "例如 ORCLPDB1": "e.g. ORCLPDB1",
  "例如 master": "e.g. master",
  "留空 = db 0；cluster 模式忽略": "Empty = db 0; ignored in cluster mode",
  "未知的数据库类型：请重新选择": "Unknown database type; pick another one",

  // -- 新建连接里可见的引擎（note）--
  "原生协议（mysql_async），支持 TLS、服务端取消、事务与 DDL":
    "Native protocol (mysql_async) with TLS, server-side cancel, transactions and DDL",
  "复用 MySQL 协议驱动；认证插件与部分 DDL 语法需按版本验证":
    "Reuses the MySQL protocol driver; auth plugins and some DDL vary by version",
  "simple query 文本协议（bigint/numeric 保持字符串精度）；TLS 未接入；改表/改索引与自定义 SQL 导出未接入":
    "Simple-query text protocol (bigint/numeric stay strings); no TLS yet; ALTER and custom-SQL export not wired yet",
  "本地文件数据库：不需要 host/port/用户名/TLS/SSH；打开已有文件，不会自动创建":
    "Local file database: no host/port/user/TLS/SSH; opens an existing file, never creates one",
  "独立的键值管线（键浏览器 + 类型化读写 + 发布订阅），不使用 SQL 工作区":
    "Separate key-value pipeline (key browser, typed read/write, pub/sub); not the SQL workspace",

  // -- 不在新建列表里的引擎（note）--
  "MySQL 协议，默认端口 4000；复用 mysql_async，事务与 DDL 差异按版本验证":
    "MySQL protocol, default port 4000; reuses mysql_async, transaction and DDL differences vary by version",
  "MySQL 模式默认端口 2881，系统库含 oceanbase；跨版本兼容性未验证":
    "MySQL mode, default port 2881, system schema includes oceanbase; cross-version compatibility unverified",
  "MySQL 协议入口默认 9030；无跨语句事务、无只读事务；行编辑仅 INSERT":
    "MySQL protocol endpoint on 9030; no cross-statement transactions or read-only transactions; row editing is INSERT-only",
  "MySQL 8.0 兼容；差异在托管端点、TLS 证书与只读副本":
    "MySQL 8.0 compatible; differences are managed endpoints, TLS certificates and read replicas",
  "复用 PostgreSQL 协议驱动；系统表、事务重试与 DDL 差异未适配":
    "Reuses the PostgreSQL protocol driver; system catalogs, transaction retries and DDL are not adapted",
  "复用 PostgreSQL 协议驱动；托管端点的 TLS 与故障转移未验证":
    "Reuses the PostgreSQL protocol driver; managed-endpoint TLS and failover are unverified",
  "开发计划：独立 TDS 驱动；取消与 TLS 需单独评估":
    "Planned: a dedicated TDS driver; cancel and TLS need separate evaluation",
  "开发计划：文档模型，独立工作区；不接入 SQL 编辑器与表结构编辑":
    "Planned: document model in its own workspace; not wired into the SQL editor or schema editing",
  "先比较 OCI/Instant Client 与纯 Rust 路线（认证/TLS/LOB/取消/部署成本）":
    "First weigh OCI/Instant Client against a pure-Rust driver (auth, TLS, LOB, cancel, deployment cost)",
  "优先 HTTP 接口（含 query_id 取消），原生 TCP 后续评估":
    "HTTP interface first (with query_id cancel); native TCP evaluated later",

  // -- 不在新建列表里的原因（reason）--
  "暂不作为新建连接的一级入口；MySQL 协议驱动保留，已有连接可继续使用与编辑":
    "Not a primary entry for new connections yet; the MySQL driver stays, so existing connections keep working",
  "暂不作为一级入口：没有跨语句事务、行编辑仅 INSERT，差异化适配未完成":
    "Not a primary entry yet: no cross-statement transactions, INSERT-only row editing, adaptation incomplete",
  "取消独立一级入口；后续作为 MySQL 连接预设（托管端点/TLS）处理":
    "Standalone entry removed; will come back as a MySQL preset (managed endpoint / TLS)",
  "不在当前支持范围：PostgreSQL 协议可复用，但系统表/事务重试差异未适配":
    "Out of scope for now: the PostgreSQL protocol is reusable, but system catalogs and retry behaviour are not adapted",
  "取消独立一级入口；后续作为 PostgreSQL 连接预设（托管端点/TLS）处理":
    "Standalone entry removed; will come back as a PostgreSQL preset (managed endpoint / TLS)",
  "开发计划中：TDS 驱动尚未接入，暂不提供新建入口":
    "Planned: the TDS driver is not wired up, so there is no new-connection entry yet",
  "开发计划中：文档型驱动尚未接入，暂不提供新建入口":
    "Planned: the document driver is not wired up, so there is no new-connection entry yet",
  "暂不在支持范围：驱动未接入，后续单独评估 OCI 与纯 Rust 路线":
    "Out of scope for now: no driver yet; OCI and pure-Rust options will be evaluated separately",
  "暂不在支持范围：驱动未接入":
    "Out of scope for now: no driver yet",

  // -- 能力矩阵里的原因（capability reason）--
  "按 query id 取消，当前版本未接入":
    "Cancel by query id is not wired up in this build",
  "没有跨语句事务，DML/DDL 自动提交":
    "No cross-statement transactions; DML/DDL auto-commit",
  "没有只读事务：只读连接仅由客户端拦截":
    "No read-only transaction: read-only is enforced client-side only",
  "仅 INSERT 可用；UPDATE/DELETE 依赖 Unique Key 表模型，未实机验证":
    "INSERT only; UPDATE/DELETE need the Unique Key model and are unverified on real hardware",
  "DDL 子集：不支持 CHANGE COLUMN/AFTER，索引语法不同":
    "DDL subset: no CHANGE COLUMN/AFTER, and index syntax differs",
  "单行增删改已接入（事务 + IS NOT DISTINCT FROM 乐观并发）；二进制列仍只读":
    "Single-row insert/update/delete wired up (transactions + IS NOT DISTINCT FROM optimistic concurrency); binary columns stay read-only",
  "支持建表（IDENTITY 自增）与删表；改表/改索引不支持":
    "Create (IDENTITY) and drop tables; ALTER table/index not supported",
  "支持创建/替换/删除视图（CREATE OR REPLACE VIEW）":
    "Create, replace and drop views (CREATE OR REPLACE VIEW)",
  "按表导出已接入；导出会重新查询，数据可能已变化":
    "Table export wired up; it re-runs the query, so data may have changed",
  "PostgreSQL 的自定义 SQL 导出尚未接入：请按表导出":
    "Custom-SQL export for PostgreSQL is not wired up; export by table instead",
  "PostgreSQL 的改列/改索引尚未接入：请用 SQL 工作区手动执行":
    "ALTER COLUMN / ALTER INDEX for PostgreSQL is not wired up; run it from the SQL workspace",
  "多语句逐条执行、每条一个结果集；没有协议层多结果集流":
    "Statements run one by one, each with one result set; no protocol-level multi-result stream",
  "单行增删改已接入（事务 + 乐观并发）；二进制列仍只读":
    "Single-row insert/update/delete wired up (transactions + optimistic concurrency); binary columns stay read-only",
  "支持建表/删表、加列、改列名、删列、索引增删；改类型/约束与索引改名需要重建表，建库/删库不支持":
    "Create/drop tables, add/rename/drop columns, add/drop indexes; type changes, constraint changes and index renames need a table rebuild, and create/drop database is unsupported",
  "支持创建/替换/删除视图；OR REPLACE 用先删后建实现":
    "Create, replace and drop views; OR REPLACE is implemented as drop-then-create",
  "SQLite 的自定义 SQL 导出尚未接入：请按表导出":
    "Custom-SQL export for SQLite is not wired up; export by table instead",
} as const;
