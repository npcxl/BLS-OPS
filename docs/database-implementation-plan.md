# BLS-OPS 数据库工作台 — 实施计划

> 依据：`docs/database-navicat-gap.md` 的静态审计。  
> 原则：先修数据正确性和安全，再扩对象操作；每批只做一个可独立验收的功能组，批次结束提交并更新矩阵证据。

## 1. 依赖关系与执行顺序

```
P0-A 数据不丢 / 提交可见
  ├── P0-B SQL 数据库归属
  ├── P0-C 后端超时/取消/panic 释放
  └── P0-D 危险文件与连接删除护栏
        ↓
P1-A 写入类型安全与非事务覆盖
P1-B 对象树/对象列表动作层扩展（重命名/删除/清空/截断/生成 SQL）
P1-C 表结构设计（DDL 生成/差异预览/执行）
P1-D CSV 导入与结果集导出
P1-E 测试基线 + 真实 MySQL CI
        ↓
P2-A EXPLAIN / 执行当前语句 / SQL 格式化
P2-B 外键元数据与跳转
P2-C 独立查询会话 / 事务控制条
P2-D 批量粘贴 / 多选 / 外键选择器
        ↓
P3 备份恢复/结构同步/数据传输/ER 图/权限/数据字典
```

## 2. 第一批：P0-A 数据不丢与提交可见（先做）

### TASK-01 修复工作区标签清理误杀 SQL 工作项

**目标**：任何标签开关、分屏、连接标签切换都不销毁 SQL 工作项/草稿。

**改动**
- `src/workbench/Workbench.tsx`
  - 不再用工作区 tab id 对比 `database-workbench-store.tabs` 的 key。
  - 按 `WorkItem.profileId` 与本窗口仍存在的 database 标签 profile 集合判断；只清理真正失去所属连接的查询工作项。
- `src/stores/database-workbench-store.ts`
  - `dispose` 默认不 `clearDraft`；新增显式 `clearDraft` 选项或独立方法，仅在用户确认关闭查询工作项时清草稿。
  - 保留 `queryRelease` 清理运行中查询。

**测试**
- 新增 `src/workbench/views/database/test/workspace-cleanup.test.ts`：模拟工作区 tab 与工作项 id 不一致，切换标签不 dispose。
- 模拟关闭最后一个连接标签：只 dispose 该 profile 的查询。
- 模拟显式关闭工作项：草稿才删除。

**验收**
- 输入 SQL → 打开终端标签 → 切回：SQL 文本、结果、草稿仍在。
- 运行中查询不因切换标签被 release。
- 关闭连接标签后，重新打开连接仍能恢复草稿。

### TASK-02 修复表格提交后的刷新与冲突回执

**目标**：暂存修改成功后界面与数据库一致；冲突/结果未知的刷新按钮真正发请求。

**改动**
- `src/workbench/views/database/TableBrowser.tsx`
  - `submit` 成功提交后 `await load(true)`。
  - “我已核对，刷新数据”“发生冲突：放弃暂存并刷新”改 `load(true)`。
  - 提交/冲突后清空选择，重新拉总数。
- 非事务覆盖按钮从 `mutation` 条件块里移出，改为 `mutationError` 包含“不支持事务”时可见、可点击。

**测试**
- 组件级测试（mock `databaseApi.mutate/browse`）：
  - 提交成功必须再调用一次 `browse` 且 `exact_count=true`。
  - 冲突提示按钮必须触发新请求。
  - 非事务错误时按钮可见，点击以 `allowNonTransactional=true` 重试。
- 真实 MySQL 集成测试（`database_mysql.rs` 新增）：更新一行后重新 browse，断言新值；删除一行后行数减少。

**验收**
- 改单元格→提交→表格立即显示新值。
- 删除行→提交→行消失。
- 制造冲突→提示→点刷新→数据更新。
- MyISAM 表出现“仍要执行”并可成功（测试环境允许时）。

### TASK-03 删除连接二次确认

**改动**
- `DatabaseAssetSidebar.tsx` 增加 `deleteTarget` 与 `ConfirmDialog`。
- 悬停垃圾桶和连接右键都走确认。
- 文案列明：将关闭该连接 N 个标签、删除钥匙串密码；SQL 草稿保留。

**测试**
- 组件测试：点击删除不立即调用 `deleteProfile`；取消不删除；确认才关闭标签并删除。

**验收**
- 一键删除不再发生；取消后配置/会话/标签不变。

## 3. 第二批：P0-B SQL 数据库归属

### TASK-04 消除跨查询页 `USE` 抢占

**改动**
- `SqlWorkspace.tsx`
  - 初始 `contextDatabase` 只应用一次：用 `appliedSessionRef/appliedContextRef` 防重复。
  - 移除“session 变化就重新 switch”的 effect 依赖循环。
  - `execute` 改为 async：执行前确保会话当前库等于本页 `contextDatabase`；失败则中止并提示。
  - 数据库下拉切换仍显式 `USE`，并更新当前页上下文。
- 共享会话提示保持；独立会话能力另列 P2。

**测试**
- Store/组件测试 mock `useDatabase`/`sessionInfo`：两个页面不同库，执行 A 再执行 B 时各调用一次 `USE`，无 ping-pong。
- 真实 MySQL 集成：两个查询工作项分别 `SELECT DATABASE()`，断言各自库名。

**验收**
- 同时打开库 A/B 查询页，执行结果各自正确；无持续 `db_use_database` 调用。

## 4. 第三批：P0-C 后端稳定性与安全

### TASK-05 文件 IPC 路径约束

- SQL 读写与导出目标路径改为 Rust 侧系统文件对话框返回的授权路径，或使用 Tauri fs scope/一次性 token。
- 禁止前端任意传绝对路径。
- 测试：未授权路径必须拒绝；授权路径可读写；超大文件拒绝。

### TASK-06 `read_cell` / export 超时

- `table.rs` 的 `get_conn`/`exec` 包 `tokio::time::timeout`，超时分类为 query/timeout，释放连接。
- `export.rs` 的 `exec_iter` 与 `try_next` 用 deadline + select；取消/超时都关闭连接，不归还。
- 测试：真实 MySQL `SLEEP()`/阻塞流下超时在预算内返回，连接池可继续使用。

### TASK-07 查询启动/取消的生命周期保护

- `query.rs` 的 `send().await` 改为 `select!` 观察 cancel token；`try_send` 终态改为可靠发送/状态兜底。
- `session.rs` 增加 RAII guard，任务 panic/drop 时释放会话连接并置 failed/unknown，不永久 busy。
- 测试：客户端停止拉取 + cancel；任务在可接受时间内结束；会话可继续执行下一条查询。

### TASK-08 写入类型安全

- `mutate.rs` 复用 `table::bind_value`，支持 BIT/BINARY/日期/数字类型；前端禁止或明确“替换整个二进制字段”。
- 测试：真实 MySQL 更新 BIT/BINARY/NULL/空串/DEFAULT；并发冲突回滚。

## 5. 第四批：P1 对象操作与表设计

### TASK-09 统一对象动作层扩展

- 在 `object-menu.ts` 增加：重命名表、删除表、清空、截断、复制结构/数据、生成 SELECT/INSERT。
- 每项必须：危险预览、确认、执行后失效元数据、刷新工作项。
- 资产树与对象列表共用同一动作定义；禁用项说明原因。

**验收**：同一张表在资产树/对象列表/网格菜单行为一致；删除/清空/截断有确认；失败保留现场。

### TASK-10 表结构设计器（MVP）

- 后端新增 `db_table_create` / `db_table_alter_preview` / `db_table_alter_apply`。
- 前端新增设计器工作项：字段、类型、NULL、默认值、注释、索引、主键；生成 DDL 差异预览。
- 外键/字符集/排序规则第二批。
- 失败：不自动重试，保留编辑内容，重新读取元数据。

### TASK-11 CSV 导入

- 后端流式解析、列映射、类型校验、批次插入、失败行报告、取消。
- 前端映射/预览/进度/错误报告；大文件不一次性进前端内存。

## 6. 第五批：P1 测试与 CI 基线

### TASK-12 前端核心链路测试

- `database-workbench-store`：多结果、截断、取消、缓存淘汰、遇错即停。
- `TableBrowser`：暂存/提交/冲突/非事务/截断防护。
- `Workbench` 清理逻辑、关闭协调。
- `ExportDialog` 轮询/取消、`detached-sql` 事件。

### TASK-13 真实 MySQL CI

- `.github/workflows/ci.yml` 增加 MySQL service + 环境变量，运行 `cargo test --test database_mysql -- --nocapture`。
- 禁止“DB 不可达直接 skip”在 CI 中算通过；CI 必须显式设置测试库。
- 测试迁移/清理使用独立 schema，避免污染。

**验收**：PR 必须显示 MySQL 集成测试真实执行；失败可见。

## 7. 第六批：P2 效率与专业工具

- SQL：EXPLAIN（普通模式）、执行当前语句、格式化、片段、结果集导出。
- 数据网格：Shift/Ctrl/矩形多选、批量粘贴、批量编辑。
- 外键元数据、跳转、外键选择器。
- 独立查询会话与显式事务控制条。
- 备份/恢复、结构同步、数据传输、ER 图、权限管理、数据字典、模拟数据。

## 8. 单项任务完成定义

一项任务只有同时满足以下条件才能从“部分/未实现”改成“完成”：

1. 前端入口可操作；
2. IPC/命令存在且返回类型明确；
3. Rust 真实执行数据库操作；
4. 正常、失败、取消、断连至少各有路径；
5. 危险操作有预览/确认；
6. 有自动化测试（写入必须有真实 MySQL 集成测试）；
7. 更新 `database-navicat-gap.md` 状态和测试证据；
8. CI 能真实执行对应测试，不依赖 skip。

## 9. 当前立即执行项

本轮先完成 **TASK-01 + TASK-02 + TASK-03（P0-A）**，然后进入 TASK-04（P0-B）。不先做菜单数量扩展。
