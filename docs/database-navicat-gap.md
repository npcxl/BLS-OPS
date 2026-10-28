# BLS-OPS 数据库工作台 — Navicat 能力差距审计

> 审计日期：2026-10-28  
> 审计方式：静态追踪 前端入口 → store → `databaseApi` → Tauri command → Rust service → 数据库驱动；同时检查现有 Rust/前端测试。  
> 本轮没有连接真实数据库做端到端验收；所有“已完成”均指代码链路存在真实数据库操作，不等同于真实环境验收通过。

## 0. 结论摘要

BLS-OPS 的数据库工作台不是空壳：连接、会话、流式查询、取消、事务写入、CSV 导出都有真实 Rust 实现。但它是 Navicat 的一个窄子集，当前最大风险不在“菜单少”，而在以下几个方面：

1. **P0 数据正确性**：任何工作区标签变化都可能误销毁全部 SQL 工作项并删除草稿；表格提交成功后不刷新，界面会继续显示旧数据。
2. **P0 数据库归属**：多个查询页共用连接会话，页面挂载/会话更新时会互相抢占 `current_database`，SQL 可能落到错误数据库。
3. **P0 安全/挂死**：SQL 文件读写命令接受任意路径；`db_read_cell` 和 CSV 导出缺少超时；查询生产端在阻塞发送时可能无法取消。
4. **能力缺口**：表设计、导入、备份/恢复、结构同步、ER 图、EXPLAIN、用户权限、函数/存储过程/触发器/事件、外键均未实现；现有“函数/备份”分类只是固定占位。
5. **测试假绿**：Rust MySQL 集成测试在 CI 没有 MySQL 服务时会直接 `return` 跳过；前端数据库核心链路没有组件/store 测试。

## 1. 代码结构与调用链

### 前端

| 层 | 文件 |
|---|---|
| 工作区标签与资源清理 | `src/workbench/Workbench.tsx` |
| 单连接工作区 / 右侧面板 / 关闭协调 | `src/workbench/views/database/DatabaseView.tsx` |
| 工作项宿主 | `src/workbench/views/database/WorkItemHost.tsx` |
| 资产树、右键、连接信息 | `DatabaseAssetSidebar.tsx`、`ConnectionInfoPanel.tsx`、`object-menu.ts` |
| 表数据编辑 | `TableBrowser.tsx`、`VirtualDataGrid.tsx`、`EditRowDialog.tsx` |
| 表结构 / DDL / 字段卡 | `TableStructure.tsx`、`DdlPanel.tsx`、`FieldCard.tsx` |
| SQL 工作台 / 结果 / 导出 / 历史 | `SqlWorkspace.tsx`、`ResultsPanel.tsx`、`ExportDialog.tsx`、`HistoryDialog.tsx` |
| 对象列表 | `DatabaseObjects.tsx` |
| 状态 | `src/stores/database-store.ts`、`database-workbench-store.ts`、`database-workspace-store.ts` |
| IPC 封装 | `src/api/ops-api.ts` 的 `databaseApi` |

### Rust

| 层 | 文件 |
|---|---|
| Tauri command 注册 | `src-tauri/src/lib.rs:424-460` |
| 命令适配 | `src-tauri/src/commands/database.rs` |
| 连接/池/会话/运行时 | `src-tauri/src/database/driver.rs`、`manager.rs`、`session.rs`、`runtime.rs`、`tunnel.rs` |
| 元数据 | `src-tauri/src/database/metadata.rs` |
| 查询流 | `src-tauri/src/database/query.rs` |
| 表浏览/单元格 | `src-tauri/src/database/table.rs` |
| 写入事务 | `src-tauri/src/database/mutate.rs` |
| CSV 导出 | `src-tauri/src/database/export.rs`、`codec.rs` |
| 真实 MySQL 集成测试 | `src-tauri/tests/database_mysql.rs` |

## 2. 状态定义

- **完成**：前端入口、IPC、Rust 实现、真实数据库操作、错误路径齐全；仍不等于已真实环境验收。
- **部分**：主链路存在，但缺关键分支、保护、类型/场景覆盖。
- **仅 UI**：有按钮/菜单/占位，但没有后端闭环或只有前端状态。
- **未实现**：前端和 Rust 均无真实实现。
- **缺陷**：已有链路存在会导致错误结果、数据丢失、挂死或安全问题。

## 3. 功能矩阵

### A. 连接管理

| Navicat 能力 | 当前状态 | 证据 | 缺口 / Bug | 优先级 |
|---|---|---|---|---|
| 新建/编辑/测试连接 | 完成 | `ConnectionDialog.tsx` → `databaseApi.saveProfile/testConnection` → `commands/database.rs:77,110` | 非 MySQL 引擎禁用是明确的边界，不是假实现 | — |
| 删除连接 | 部分 | `DatabaseAssetSidebar.tsx:456` → `deleteProfile` | 悬停垃圾桶一键删除，无二次确认；会关标签、删钥匙串密码/工作项 | P0 |
| 复制连接 | 未实现 | 无命令/入口 | 需要明确是否复制密码（建议不复制密码） | P2 |
| 多连接 | 完成 | `DatabaseProfile` + 每连接标签/会话 | 右侧“已打开”跨连接可见 | — |
| SSH / TLS | 完成 | `tunnel.rs`、`driver.rs:181-226` | `verify_ca` 因 rustls 限制实际也做域名校验，文档已有说明 | P2 |
| 连接池/会话 | 完成 | 交互池 4、导出池 1、独占会话 | 池连接未继承只读事务设置；无自动重连（有意） | P1 |
| 自动重连 | 未实现 | `session.rs:7-10,138-149` | 协议错误/取消未确认后只能手动重连 | P2 |
| 分组/收藏/搜索 | 完成（连接搜索） | `DatabaseAssetSidebar` 过滤、`DatabaseProfile` 无 group 字段 | 无连接分组/收藏；搜索已有 | P3 |
| 密码安全 | 完成 | `keyring.rs`、`profiles.rs` | 无明文日志；需持续回归 | — |

### B. 对象树与右键

| 对象/能力 | 当前状态 | 证据 | 缺口 / Bug | 优先级 |
|---|---|---|---|---|
| 连接/库/表/视图四级树 | 完成 | `DatabaseAssetSidebar.tsx` | 函数/备份分类固定为 0，只是占位 | P1 |
| 连接右键 | 部分 | `connectionMenu` | 打开/刷新/编辑/复制/断开已有；无复制配置、删除确认 | P1 |
| 数据库右键 | 部分 | `databaseMenu` | 打开对象/新建查询/刷新/开关已有；无新建表/属性/导入导出 | P1 |
| 表/视图右键 | 部分 | `object-menu.ts` | 打开数据/结构/DDL/复制 SELECT/刷新；无重命名/删除/清空/截断/生成 SQL | P1 |
| 函数/存储过程/触发器/事件 | 未实现 | Rust 无 `ROUTINES`/`TRIGGERS`/`EVENTS` 查询 | 分类占位；无后端 | P2 |
| 外键 | 未实现 | 无引用约束元数据 | 表设计、外键跳转无法做 | P2 |
| 批量对象操作 | 未实现 | 无选择模型 | 需要统一动作层和预览确认 | P3 |
| 危险操作确认 | 部分 | 断开连接有确认；删除连接没有 | 删除/清空/截断/DDL 必须统一确认 | P0/P1 |

### C. 表结构设计

| Navicat 能力 | 当前状态 | 证据 | 缺口 | 优先级 |
|---|---|---|---|---|
| 字段/索引/DDL 查看 | 完成（只读） | `TableStructure.tsx`、`DdlPanel.tsx` | 无编辑 | — |
| 建表/改字段/索引/外键 | 未实现 | 无 `db_ddl_*`/`db_alter_*` command | 需要 DDL 生成、差异预览、事务/失败处理 | P1 |
| 默认值/注释/字符集/排序规则 | 未实现编辑 | 元数据能读列属性，部分 collations 函数死代码 | 无修改入口 | P1 |
| 修改前 DDL 差异预览 | 未实现 | 无 diff/预检 | 高风险，必须与 DDL 执行一起做 | P1 |
| 迁移失败重新读取 | 未实现 | 无 DDL 执行 | 需要失败恢复和元数据失效 | P1 |

### D. 数据编辑

| 能力 | 当前状态 | 证据 | 缺口 / Bug | 优先级 |
|---|---|---|---|---|
| 分页/排序/筛选/搜索 | 部分 | `TableBrowser.tsx`、`table.rs` | 仅单列排序；总数翻页后可能过期 | P2 |
| 暂存/提交/回滚 | 完成（真实事务） | `TableBrowser.submit` → `db_mutate_apply` → `mutate.rs` | 提交后 `load()` 被去重吞掉，界面旧数据 | P0 |
| 新增/修改/删除行 | 完成 | `mutate.rs` 单行影响数校验 | 非事务表覆盖按钮不可达，MyISAM 无法从 UI 绕过 | P1 |
| 单元格复制/粘贴/多选 | 部分 | 右键复制；`VirtualDataGrid` 单选 | 无 Shift/Ctrl/矩形选区、无多单元格粘贴、无批量编辑 | P1 |
| NULL/空串/DEFAULT | 完成 | 三态菜单/表单 | 需补测试防回归 | — |
| 主键/乐观并发 | 完成 | reliable key + `<=>` + affected=1 | 截断/binary 列跳过并发比较 | P1 |
| JSON/BLOB/长文本 | 部分 | 大字段读完整才允许编辑；BLOB 禁止 | BIT 可编辑但按字节串绑定，存在写坏风险 | P0/P1 |
| 外键选择器 | 未实现 | — | 无外键元数据 | P2 |
| 批量粘贴 | 未实现 | — | 需要解析/校验/预览 | P2 |

### E. SQL 工作台

| 能力 | 当前状态 | 证据 | 缺口 / Bug | 优先级 |
|---|---|---|---|---|
| 多查询工作项/Tab | 完成 | `database-workspace-store` + `WorkItemHost` | 工作区标签变化会误销毁 SQL 工作项/草稿 | P0 |
| 语法高亮/补全 | 完成 | CodeMirror + schema 补全 | — | — |
| 格式化/收藏/片段 | 未实现 | 无入口 | 仅历史 | P2 |
| 选区/全文执行 | 完成 | `SqlWorkspace.execute` | 无“执行当前语句”入口（`statementAtCursor` 只有测试） | P2 |
| 多结果集 | 完成 | `database-workbench-store.drainQuery` | 最多 8 个结果集/4000 行，超出丢旧结果 | P2 |
| 结果导出 | 部分 | `ExportDialog` 重新执行全文 SQL | 不是当前结果集；编辑后导出可能与屏幕结果不一致 | P1 |
| 事务/自动提交 | 部分 | 后端拒绝隐式 COMMIT；SQL 可手写 COMMIT | 无就地事务控制条 | P2 |
| 取消/超时 | 完成 | `query.rs` + `queryCancel` | 生产端阻塞 send 时取消失效；`try_send` 可能丢错误批次 | P0/P1 |
| EXPLAIN | 未实现 | Rust/前端无实现 | 需要普通 EXPLAIN，不与分析模式混用 | P2 |
| 跨页数据库归属 | 缺陷 | `SqlWorkspace` 的 switchDatabase effect | 多页不同库会互相抢占 `USE`，SQL 可能落错库 | P0 |
| 独立窗口 | 部分 | `detached-sql.ts` / `DetachedSqlWindow` | 实际是独立会话，却文案写“共享会话”；结果不回传主窗口 | P1 |

### F. 导入导出

| 能力 | 当前状态 | 证据 | 缺口 | 优先级 |
|---|---|---|---|---|
| CSV 导出 | 完成 | `export.rs` 流式、临时文件、取消 | 仅 CSV；导出是重查全文 SQL，不是屏幕结果 | P1 |
| SQL/JSON/Excel 导出 | 未实现 | — | 无 dump/多格式 | P2 |
| CSV 导入 | 未实现 | 无命令 | 需列映射/预览/批次/失败行 | P1 |
| SQL 文件执行 | 部分 | 打开文件只塞编辑器 | 不是导入执行 | P2 |
| 大文件流式/取消/恢复 | 导出部分完成；导入无 | `export.rs` | 导出无超时；导入全缺 | P0/P1 |

### G. 专业工具

| 能力 | 状态 |
|---|---|
| 备份/恢复 | 未实现（现有 backup 是整机配置备份，非数据库 dump） |
| 结构对比/同步 | 未实现 |
| 数据传输/同步 | 未实现 |
| ER 图 | 未实现 |
| 用户/权限管理 | 未实现 |
| 服务器监控（数据库） | 未实现 |
| 数据字典 | 未实现 |
| 模拟数据 | 未实现 |

### H. 工作区与交互

| 能力 | 状态 | 缺口 / Bug | 优先级 |
|---|---|---|---|
| 多连接/多库/多 Tab | 完成 | 工作项常驻不卸载 | — |
| Tab 固定/恢复/批量关闭 | 部分 | 固定、关闭其他已有；无恢复会话；“关闭其他”已走确认 | P2 |
| 左树/中央/右面板 | 完成 | 右面板 DDL/连接信息/字段卡互斥 | — |
| 统一右键 | 部分 | 表/视图共用；连接/库有菜单；函数/备份空 | P1 |
| 未保存提醒 | 完成（关闭保护） | dirty/pending/running/transaction 汇总 | — |
| 后台任务/进度中心 | 部分 | 导出进度；无统一任务中心 | P2 |
| 标签切换资源清理 | 缺陷 | `Workbench.tsx:78-83` 用工作区 tab id 对比工作项 id，误 dispose 全部 SQL | P0 |

## 4. P0/P1 缺陷清单（必须先修）

### P0

1. **SQL 工作项与草稿被误清理**
   - 位置：`src/workbench/Workbench.tsx:78-83`；`database-workbench-store.ts:385-397`。
   - 原因：工作区 tab id 与 `database-workbench-store.tabs` 的工作项 id 不是同一命名空间。
   - 后果：开关任意标签/分屏/打开第二个连接标签，所有 SQL 工作项被 `dispose`，草稿被 `clearDraft` 删除，运行中查询被 release。
   - 修复：按 `WorkItem.profileId` 与活动数据库标签 profile 清理；`dispose` 不再默认清草稿；显式关闭工作项时才清。

2. **表格提交成功后界面不刷新**
   - 位置：`TableBrowser.tsx:930,1544,1557`。
   - 原因：`load()` 的 `force=false` 被 `lastLoadKeyRef` 去重直接 return。
   - 后果：修改/删除已提交，表格仍显示旧行/旧值；“我已核对刷新”“冲突后刷新”实际无效。
   - 修复：三条路径改 `load(true)`；补提交/冲突/结果未知回归测试。

3. **多查询页互相切换当前数据库**
   - 位置：`SqlWorkspace.tsx:227-258`。
   - 原因：`switchDatabase` 依赖整个 `session`，session 更新后 effect 重跑；每个挂载页都把自己的 `contextDatabase` 写回共享会话。
   - 后果：同时打开库 A/B 查询页时，执行 SQL 可能落在另一库。
   - 修复：初始上下文只应用一次（ref）；执行前显式确保当前库；避免会话更新触发来回 `USE`。

4. **删除连接无确认**
   - 位置：`DatabaseAssetSidebar.tsx:456,665`。
   - 后果：一键关闭该连接全部标签、删配置和钥匙串密码、丢工作项。
   - 修复：统一 `ConfirmDialog`，明确将关闭 N 个标签/删除密码/保留 SQL 草稿。

5. **SQL 文件/导出路径 IPC 任意读写（已修复）**
   - 原位置：`commands/database.rs` 旧 `db_read_sql_file`/`db_write_sql_file`、`export.rs` 的 `target_path`。
   - 修复：SQL 打开/保存改由 Rust 系统对话框 + 读写一体命令；导出增加 `db_pick_export_path` 授权集合，`db_export_start` 只接受授权路径；文件名只取 basename 并强制扩展名。
   - 证据：`commands/database.rs` 的 `db_open_sql_file`/`db_save_sql_file`/`db_pick_export_path`；`commands::database::tests` 2 项通过。
   - 剩余：TLS CA 路径仍由前端选择，但只用于 TLS 初始化，不返回内容。

6. **`db_read_cell`/导出无超时（已修复）**
   - 修复：`table.rs` 连接获取 10s、查询按 `query_timeout_ms`；`export.rs` 查询启动/逐行读取超时，超时断开连接不回池。

7. **查询任务阻塞 send 时无法取消（已修复）**
   - 修复：`query.rs` 的 `flush_batch`/`ResultSetEnd` 支持取消 `select!`；任务 panic 使用 `catch_unwind` + `SessionEntry::mark_lost` 释放会话。

### P1

- 非事务表覆盖按钮不可达（`TableBrowser.tsx:1529/1563` vs `mutate.rs:112-121`）。
- 独立窗口文案“共享会话”错误（实际独立会话）。
- 导出使用当前全文 SQL 重查，不导出屏幕结果。
- `mutate` 所有值按字符串绑定，BIT/BINARY 类型不安全。
- 池连接未继承只读设置。
- 长 CJK 标识符按字节数判断 64 上限。
- 保存的查询不可删除/重命名。
- `query.rs` 错误/终态批次 `try_send` 可能丢失。
- 数据库前端核心链路零组件测试（已补工作项清理/草稿保留，TableBrowser 组件仍缺）。

## 5. 测试现状

- 前端数据库测试：`sql-split.test.ts` 8 个纯函数用例；新增 `workspace-cleanup.test.ts` 4 项、`database-workbench-dispose.test.ts` 2 项；TableBrowser/关闭协调/虚拟网格仍无组件测试。
- Rust 单元：`driver.rs`、`codec.rs`、文件名校验等；共 722 项。
- Rust MySQL 集成：`src-tauri/tests/database_mysql.rs` 有类型/多结果/取消、分页/写入/导出、TLS、百万行 keyset、profile 往返；本地 DB 不可达时 skip。
- CI：`.github/workflows/ci.yml` 使用 `shogo82148/actions-setup-mysql` 启动 MySQL 8.0，并设置 `BLS_TEST_MYSQL_REQUIRED=1`；数据库不可达时测试直接 panic，不允许 skip 成假绿。TLS 用例在 CA 文件缺失时仍会 skip，需要后续在 CI 生成/提供 CA。

## 6. 本轮已落地的 P0 修复（2026-10-28）

| 问题 | 修复 | 测试证据 |
|---|---|---|
| 工作区 tab 变化误销毁 SQL 工作项/草稿 | `Workbench.tsx` 按 `WorkItem.profileId` 清理；`dispose` 默认保留草稿，显式关闭才清 | `workspace-cleanup.test.ts` 4 项、`database-workbench-dispose.test.ts` 2 项通过 |
| 提交成功后不刷新 | `TableBrowser` 提交/冲突/结果未知回执改 `load(true)`；刷新前清 mutation 提示 | 仍需补组件级 mock 测试 |
| 非事务表覆盖按钮不可达 | 按钮移出 `mutation` 条件块，按 `mutationError` 展示 | 待补真实 MySQL MyISAM 验收 |
| 删除连接无确认 | 悬停/右键删除统一 `ConfirmDialog` | 待补组件测试 |
| 多查询页抢占 `current_database` | 初始上下文只应用一次；执行前显式切回本页库 | 待补双查询页回归测试 |
| `db_read_cell` 无超时 | 连接获取 10s、查询按 query_timeout，超时断开连接不回池 | `cargo check`/`cargo test --lib` |
| CSV 导出流无超时/不可取消 | 查询启动和逐行读取增加超时，`select!` 观察取消；取消/超时断开连接 | `cargo test --test database_mysql`（无 DB 时明确 skip） |
| 查询阻塞 send 时取消无效 | `flush_batch`/ResultSetEnd 的 send 增加取消 `select!`，取消时回退 in-flight 计数 | `cargo test --lib` |
| 查询任务 panic 会让会话永久 busy | `catch_unwind` + `SessionEntry::mark_lost`，panic 后标记失败并释放查询计数 | `cargo test --lib` |
| CI 真实 MySQL 未执行 | GitHub Actions 启动 MySQL 8.0；`BLS_TEST_MYSQL_REQUIRED=1` 禁止 skip | `.github/workflows/ci.yml`（待 PR 实跑确认） |
| SQL 文件任意路径读写 | Rust 侧系统对话框 + 读写一体化命令，移除前端传路径；文件名净化 | `commands::database::tests` 2 项通过 |
| 导出任意路径写入 | `db_pick_export_path` 授权 + `db_export_start` 校验授权集合；前端路径只读 | `commands::database::tests` |

## 7. 验收原则

- 每个 P0 修复必须有“修复前失败、修复后通过”的回归测试；涉及写入的必须有真实 MySQL 集成测试。
- 不以“有按钮”判定完成；必须验证前端入口→IPC→Rust→驱动→数据库结果。
- 危险操作必须预览/确认、失败可恢复、成功刷新元数据。
- 大结果集、导入、导出不得一次性跨 IPC 传输或阻塞 UI。
- 保留现有 BLS-OPS 设计语言，不复制 Navicat 视觉。
