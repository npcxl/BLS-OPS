# 数据库工作台（现状）

> 状态：**现行**，对照代码日期 2026-11-20。
> 历史审计与计划见 `../history/database-navicat-gap.md`（2026-10-28 快照）、`../history/database-implementation-plan.md`、`../history/database-performance-benchmark.md`；那些文档里"非 MySQL 引擎禁用"的说法已经过时。

---

## 1. 支持范围

新建连接列表**只列 5 个产品**（`EntryPolicy::Listed`）：

| 引擎 | 驱动 | 传输 | 备注 |
|---|---|---|---|
| MySQL | `mysql_async`（原生协议） | TCP / TLS / SSH 隧道 | 支持服务端取消、事务、DDL |
| MariaDB | 复用 MySQL 驱动 | 同上 | 认证插件与部分 DDL 按版本验证；JSON 物理类型是 LONGTEXT |
| PostgreSQL | `tokio-postgres`（simple query 文本协议） | TCP / SSH 隧道 | bigint/numeric 以字符串传输；**TLS 未接入**，非 disabled 直接拒绝 |
| SQLite | `rusqlite`（bundled，专用阻塞线程） | 本地文件 | 只打开已存在文件，绝不自动创建；只读用 `SQLITE_OPEN_READ_ONLY` |
| Redis | `redis` 0.27（tokio + rustls + cluster/sentinel） | TCP / TLS / SSH 隧道 | 与 SQL 管线平行的键值管线，不走 session/query/事务 |

注册表里还有一批 **Hidden** 项（不在新建列表，但旧配置仍可识别）：

- `Implemented + Hidden`：TiDB、OceanBase（MySQL 模式）、Doris、StarRocks、Aurora MySQL —— 有驱动，未实机验证（`VerifiedLevel::DriverOnly`）。
- `ConfigOnly + Hidden`：CockroachDB、Aurora PostgreSQL、SQL Server、MongoDB、Oracle、ClickHouse —— 没有驱动，配置能保存但连接会明确拒绝。

**"注册了"不等于"支持了"**。三组状态是正交的，界面必须分别表达：

| 维度 | 取值 | 含义 |
|---|---|---|
| `Implementation` | `Implemented` / `ConfigOnly` | 有没有真实驱动 |
| `EntryPolicy` | `Listed` / `Hidden { reason }` | 给不给新建入口 |
| `VerifiedLevel` | `ConfigOnly` → `DriverOnly` → `Connect` → `Query` → `Manage` | 在真实实例上验到哪一步 |

单一事实来源：`src-tauri/src/database/engine_registry.rs`（+ `capability.rs`）。

---

## 2. 能力矩阵（以能力位为准）

每项是 `Supported / Limited { reason } / Unsupported { reason }`。界面按原因禁用入口，而不是让用户点进去撞一条 unsupported。

| 能力 | MySQL / MariaDB | PostgreSQL | SQLite | Redis |
|---|---|---|---|---|
| SQL 执行 / 多结果集 | Supported | Supported | Supported（多语句逐条执行） | Unsupported |
| 取消 | Supported（KILL） | Supported（CancelToken） | Supported（InterruptHandle） | Unsupported（断开即中断） |
| 事务 | Supported | Supported | Supported | Unsupported（MULTI/EXEC 未接界面） |
| 只读保障 | Supported | Supported（`default_transaction_read_only`） | Supported（文件只读打开） | Limited（仅界面提示） |
| 表/键浏览 | Supported | Supported | Supported | Supported（键扫描） |
| keyset 分页 | Supported | Supported | Supported | Supported |
| 单行编辑 | Supported | Limited（二进制列只读） | Limited（二进制列只读） | Supported（写键/字段） |
| 结构编辑 | Supported | Limited（建表/删表；改表实现见 §5） | Limited（加列/改名/删列/索引；改类型需重建表） | Unsupported |
| 视图 | Supported | Limited（`CREATE OR REPLACE VIEW`） | Limited（先删后建） | Unsupported |
| 按表 CSV 导出 | Supported | Limited（重新查询，数据可能已变） | Limited（同上） | Unsupported |
| 导出自定义 SQL | Supported | Unsupported | Unsupported | Unsupported |

MySQL 协议兼容产品（TiDB/OceanBase/Doris/StarRocks）另有收窄：Doris/StarRocks 无跨语句事务、无只读事务、行编辑仅 INSERT、取消受限。

---

## 3. 分层

### 前端（`src/workbench/views/database/`）

| 文件 | 职责 |
|---|---|
| `DatabaseView.tsx` | 一个标签 = 一个连接；工作项宿主、右侧面板、关闭协调 |
| `DatabaseAssetSidebar.tsx` | 连接 / 库 / 表 / 视图四级树与右键菜单 |
| `SqlWorkspace.tsx` + `ResultsPanel.tsx` | SQL 编辑器、结果集、取消、导出、历史 |
| `TableBrowser.tsx` + `VirtualDataGrid.tsx` + `grid/` + `EditRowDialog.tsx` | 表数据浏览与行编辑 |
| `TableStructure.tsx` + `DdlPanel.tsx` + `FieldCard.tsx` | 字段 / 索引 / DDL |
| `CreateTableDialog.tsx` / `SchemaChangeDialog.tsx` / `TableOperationDialog.tsx` | 结构变更与预览 |
| `redis/`（`RedisBrowser.tsx`） | 键浏览器、各类型值编辑、发布订阅 |
| `detached-sql.ts` + `DetachedSqlWindow.tsx` | 在独立窗口打开 SQL |

状态：`stores/database-store.ts`（资产与元数据缓存）、`database-workbench-store.ts`（SQL 编辑器与结果集，带行数上限与串行拉取）、`database-workspace-store.ts`（标签内工作项）。

### 后端（`src-tauri/src/database/`）

```text
engine_registry  产品 → 驱动系列/方言/字段/能力（唯一清单）
capability       三态能力 + 验证等级 + 方言事实
profiles         连接配置 SQLite CRUD + 钥匙串
tunnel           SSH 回环转发（复用 ssh 握手与主机指纹校验）
runtime          一条配置的运行时：隧道 + 交互池 + 导出池 + 取消通道
session          逻辑会话 = 固定物理连接（事务/临时表/当前库）
protocol         连接身份、取消令牌、事务状态（协议无关）
driver.rs        + driver/{mysql,postgres,sqlite}.rs 三个协议实现
query            查询任务、分批、拉取式背压、真实取消
adapter/         SqlDialect + AdapterSet + CatalogQueries + ParamBinder（纯逻辑，可单测）
metadata         库/表/字段/索引（目录 SQL 来自 CatalogQueries，按列名解析）
table            表数据浏览（keyset/OFFSET、过滤、大字段投影预算）
mutate           单表增删改（事务、影响行数、乐观并发）
export           CSV 流式导出（独立连接、原子发布、进度）
schema_ops       DDL 生成与执行（MySQL / PG / SQLite 分支）
redis_driver     Redis 管线（键扫描 / 值读写 / 发布订阅）
```

命令层：`commands/database.rs`（`db_*`，只做同步读库 + 交给 `DatabaseManager`，不拼 SQL）。
全局状态：`AppState.database`（`DatabaseManager`）、`AppState.redis`、`AppState.export_paths`。

---

## 4. 安全与数据正确性

- **密码只在钥匙串**：连接配置里只有引用；`db_test_connection` 的一次性密码不落库。
- **SSH 隧道复用 `ssh::connect_hop`**：ProxyJump 与主机指纹校验与终端走同一条路径，不另写客户端。
- **导出路径白名单**：只能来自系统"另存为"对话框（`db_pick_export_path` 写入 `export_paths`），`db_export_start` 会复核；前端传任意路径直接拒绝。
- **SQL 文件读写走系统对话框**：`db_open_sql_file` / `db_save_sql_file` 不允许前端传路径（2026-10-28 审计里的 P0 已修）。
- **不自动重试写 SQL / 提交事务**；取消必须走真实服务端取消（KILL / CancelToken / interrupt），不把"取消前端 Promise"当取消。
- 失败必须可诊断：`DbErrorInfo` 带 `kind`（auth / database / permission / cancelled / conflict / config / unsupported…）与原文，界面按 kind 给动作。
- 乐观并发：单行编辑带期望值，影响行数 ≠ 1 立即回滚；COMMIT 失败标 `outcome_unknown` 且不重试。

---

## 5. 已知缺口 / 待统一

| 项 | 说明 |
|---|---|
| `postgres_caps().schema_edit` 文案 | 仍写"改表/改索引不支持"，但 `schema_ops.rs::pg_alter_table_sql` 已实现 ALTER 分支。改界面前先确认命令链是否已放行，然后把能力位文案与实现对齐 |
| PostgreSQL TLS | 只支持 `tls_mode = disabled`；其它模式明确拒绝，不静默降级明文 |
| PostgreSQL 自定义 SQL 导出 | 未接入；只支持按表导出 |
| SQLite 改类型/约束 | 需要重建表，当前明确拒绝；索引改名也不支持 |
| 列类型预设 | `column-types.ts` 仍是 MySQL 一套，PG/SQLite 的方言建议未做 |
| 结构同步 / ER 图 / 导入 / 备份恢复 / 函数与触发器 | 未实现（见 `../history/database-navicat-gap.md`，部分结论可能已过时） |
| Redis 只读模式 | 未在服务端强制 |
| SQL Server / MongoDB / Oracle / ClickHouse | 无驱动，只有配置模型 |

---

## 6. 新增一个引擎

1. `engine_registry.rs` 注册：`DriverFamily`、`Dialect`、必填字段、默认端口、`CapabilitySet`、`Implementation`、`VerifiedScope`、`EntryPolicy`。
2. `driver/` 实现协议（连接、会话初始化、取消、错误映射、类型解码）。
3. `adapter/catalog.rs` 补目录查询；`adapter/engine.rs` 补 DDL/表操作模板；`adapter/mod.rs` 补方言原语。
4. `runtime` 分派连接、`query` 分派执行、`metadata`/`table` 分派读取、`mutate`/`export`/`schema_ops` 分派写入。
5. 集成测试放 `src-tauri/tests/database_<engine>.rs`，用 `BLS_TEST_*_REQUIRED=1` 保证实例不可达时红。
6. 前端只读 `db_engines_catalog` 的 `entry.state` 与能力，不写死引擎数组。

---

## 7. 测试

```bash
pnpm test:db                              # MySQL 8.0 + PostgreSQL（默认端口 33306 / 55432）
pnpm test:db -- -Distribution mariadb     # MariaDB（33070）
cd src-tauri && cargo test --test database_sqlite
cd src-tauri && cargo test --test database_redis   # 需要本地 Redis
cd src-tauri && cargo test --lib database::
```

夹具坑：`ops_test` 残留数据会让后续用例报 1062 或 `reliable_key` 变 `None`；先 `DROP DATABASE ops_test` 再跑。数据库套件共用 schema，必须串行（`--test-threads=1`）。
