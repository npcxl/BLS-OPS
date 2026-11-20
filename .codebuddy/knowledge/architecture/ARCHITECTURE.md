# 系统架构（现状）

> 状态：**现行**（as-built），对照代码日期 2026-11-20，应用版本 0.1.30。
> 这篇回答"系统现在是怎么跑的、边界在哪、数据放哪"。
> 目标与分阶段设计（P3 发现 / P5 部署中心）见仓库根目录的早期设计文档与 `design/p5.*`、`design/P5_DEPLOYMENT_CENTER_DESIGN.md`。

---

## 1. 定位与运行形态

Windows 优先的 SSH 桌面运维工作台：一个安装包（<15 MB），不需要目标机器装任何 Agent，原生能力全部在本地进程里完成。

| 层 | 选型 | 位置 |
|---|---|---|
| 桌面壳 | Tauri 2 | `src-tauri/` |
| 前端 | React 19 + TypeScript 5.8 + Vite 7 | `src/` |
| 样式 | Tailwind CSS v4（无 PostCSS，走 Vite 插件） | `src/styles/` |
| 状态 | Zustand 5（只放 UI/领域状态） | `src/stores/` |
| 终端 | xterm.js 6 | `src/workbench/views/terminal/` |
| 原生能力 | Rust：russh 0.63 / russh-sftp 2 / rusqlite（bundled）/ mysql_async / tokio-postgres / redis / reqwest | `src-tauri/src/` |
| 持久化 | SQLite（配置与历史）+ 系统钥匙串（密钥） | `src-tauri/src/db/`、`keyring.rs` |

### 单进程、多窗口

只有一条 Rust 主进程，所有窗口都是同一进程里的 `WebviewWindow`：

| 窗口 | 创建位置 | 用途 |
|---|---|---|
| `main` | `src-tauri/tauri.conf.json` | 主工作台；`decorations:false` + `transparent:true`，毛玻璃由 `window_material.rs` 管 |
| `shortcuts` | `commands::open_shortcuts_window`（`commands/app.rs`） | 快捷键一览 |
| 右键菜单窗口 | `desktop_menu.rs`，启动时预创建、反复复用 | 屏幕级右键菜单（独立透明窗口） |
| 通知窗口池 | `desktop_notification.rs` | 右下角通知，一条通知一个窗口，固定池 + 队列 + 堆叠 |
| `sql-detached-*` | 前端 `views/database/detached-sql.ts` 用 `new WebviewWindow` | 数据库 SQL 独立窗口 |
| 内置浏览器子 WebView | `commands/browser.rs` | 极核右栏网页 |

三条窗口约束（都是踩过坑的，不要"优化"掉）：

1. 窗口视图靠 `window.__BLS_VIEW__` 初始化脚本分发，不靠 query：`WebviewUrl::App("index.html?view=…")` 在部分平台会把 query 当成路径（`src/main.tsx`）。
2. 浮窗（`context-menu` / `desktop-notification`）**不跑** `initTheme()`：同进程窗口主题会互相影响，深色菜单会套上浅色材质。
3. 点 X = 隐藏到托盘，SSH 会话保持；只有托盘 Quit 才 `app.exit(0)`（`lib.rs` / `tray.rs`）。

---

## 2. 启动链

| 顺序 | 位置 | 做什么 |
|---|---|---|
| 1 | `src-tauri/src/lib.rs` | 安装进程级 rustls provider → 注册插件（dialog / opener / clipboard / updater / process） |
| 2 | `lib.rs::setup` | 应用窗口材质 → 打开 `AppDb`（`%LOCALAPPDATA%\ops-workbench\ops-workbench.sqlite3`）→ `AppState::new` → 托盘 |
| 3 | `lib.rs` | `invoke_handler` 注册全部命令（300+）→ `build().run()` |
| 4 | `index.html` → `src/main.tsx` | 按 `__BLS_VIEW__` 分发：快捷键 / 右键菜单 / 通知 / 主应用；主应用才跑 `initTheme`、`initDensity`、`initTerminalFont`、`prepareDesktopMenu` |
| 5 | `src/App.tsx` | 判断是否 `sql-detached-*` → `DetachedSqlWindow`；否则 `MainApp`（Splash + `Workbench` + 极核覆盖层） |
| 6 | `src/workbench/Workbench.tsx` | 外壳：顶栏 / 导航条 / 上下文侧栏 / 分屏工作区；全局快捷键、自动更新检查、`refreshAll()`、通知窗口池预热 |

注意：`src/main.tsx` **禁用 `React.StrictMode`**。开发期 effect 双执行会真实连一次 SSH、立刻断开、再连一次。

---

## 3. 分层与依赖方向

```text
React 视图            src/workbench/views/**            只消费 store 与 opsApi
   ↓
Zustand stores        src/stores/**                      领域/UI 状态，不直接 invoke
   ↓
前端 API              src/api/ops-api.ts                 唯一 IPC 出口（invoke + Channel）
   ↓  Tauri IPC
命令层                src-tauri/src/commands/<域>.rs      参数校验 + 编排，不拼命令文本
   ↓
领域层                ssh/ monitor/ database/ deployment/ agent/ …
   ↓
安全边界              safe::Capability                    唯一生成远程命令文本的地方
   ↓
本地持久化            db/AppDb（SQLite） + keyring.rs（系统钥匙串）
```

### 三条"唯一入口"

| 关注点 | 唯一入口 | 违反后的后果 |
|---|---|---|
| WebView ↔ Rust | `src/api/ops-api.ts` | 组件散落 `invoke`，载荷字段名漂移（"接口正常但不渲染"） |
| 远程命令文本 | `src-tauri/src/safe/capability.rs` 的 `Capability` 枚举 | 一个 XSS 形状的 bug 等于把远程 shell 交给攻击者 |
| Tauri 事件名 | `src/lib/events.ts` | 订阅不到，界面不刷新 |

唯一受控例外是超能 Agent：模型可以提出任意命令，但命令文本只在 `src-tauri/src/agent/tools.rs` 生成，并带风险分级 + 逐条审批 + 写前备份（见 `../guides/SECURITY.md`）。

---

## 4. 数据与状态归属

| 数据 | 存放 | 说明 |
|---|---|---|
| 服务器 / 分组 / 凭据元数据 / 主机指纹 / 会话历史 / 审计 | SQLite | 凭据表只有 `secret_ref` / `passphrase_ref` |
| 项目发现、P5 部署模型、方案、运行记录、知识库、Memory | SQLite | 40+ 张表，schema v26，迁移前自动备份 |
| 数据库连接配置、查询历史、命令中心收藏 | SQLite | 密码只在钥匙串；导出目标路径由用户经系统对话框选择 |
| 密码 / 私钥 / 私钥口令 / AI API Key | 系统钥匙串 | service = `ops-workbench`，account = SQLite 里的 `secret_ref` |
| SSH 会话、监控速率基线、导入任务、部署运行锁、Agent 任务、传输队列 | 进程内存（`AppState`） | 重启即清空 |
| 终端输出、滚动缓冲、命令结果快照 | 前端内存 | 不落库、不进 store 的持久层 |
| 主题 / 语言 / 密度 / 终端字体 / 快捷键 | localStorage | 轻量偏好 |

`AppState`（`src-tauri/src/state.rs`）持有全部全局管理器：`db`、`ssh`、`monitor`、`project_scans`、`dir_sizes`、`editor_syncs`、`artifact_imports`、`runs`、`env_locks`、`ai_reviews`、`agents`、`changes`、`command_search`、`transfers`、`database`、`redis`、`export_paths`。

---

## 5. 核心链路（摘要）

| 能力 | 前端入口 | 后端 | 详细文档 |
|---|---|---|---|
| 终端 | `views/terminal/TerminalView.tsx` | `commands/ssh.rs` → `ssh/{manager,handshake,session,shell}` | `../features/TERMINAL.md` |
| 监控 | `views/server-monitor/` | `monitor/{model,parse,exec,collect}`，固定命令表 + 无 PTY 的 exec 通道 | — |
| 文件 | `views/remote-file/` | `ssh/sftp.rs`、`transfer.rs`、`trash.rs`、`dirsize.rs` | — |
| 服务 / 日志 | `ServiceManagerView` / `LogCenterView` | `systemd.rs`、`journal.rs` → `safe::Capability` | — |
| 命令中心 | `views/command-center/` | `command_center/`（构建期生成 `catalog.json`）+ `safe` | `../history/p4-acceptance.md` |
| 数据库 | `views/database/` | `database/`（adapter / driver / query / metadata / mutate / export / schema_ops） | `../features/database-workbench.md` |
| 部署中心 | `views/deploy/` | `deployment/`（proposal → action → exec → run） | `../design/p5.*` |
| 极核 / Agent | `views/terminal/extreme-core/` | `agent/`（runner 在 Rust 侧跑） | `../features/TERMINAL.md` §10 |
| 更新 | `workbench/updater/` | `tauri-plugin-updater` + `scripts/rewrite-updater-urls.mjs` | `../guides/p5.1-updater.md` |

两条容易混淆的"通道"：

- **终端 PTY**：交互式 shell，输出经 `ssh-output-{id}` / `ssh-stderr-{id}` 事件逐块送到 xterm。
- **管理通道**：监控 / 服务 / 日志 / Docker / Nginx / 部署各开自己的非交互 exec 通道，**不共用 PTY**，避免与用户输入混流。
- **右栏手动终端**：在既有连接上再开一条独立 PTY（`ssh_shell_*`），输出走 `ssh-shell-output-{id}`，绝不混进主终端。

---

## 6. 持久化

- 路径：`%LOCALAPPDATA%\ops-workbench\ops-workbench.sqlite3`（`lib.rs` 用 `dirs::data_local_dir`）。
- 连接：`AppDb::open()` 每次开新连接并 `PRAGMA foreign_keys = ON`；没有全局连接池。
- 迁移：`db/schema.rs` 的 `SCHEMA_VERSION`（当前 26），通过 `PRAGMA user_version` 逐级执行；升级前调用 `backup::backup_before_migration()`。
- 两条铁律：
  1. **密钥永不入 SQLite**：只存钥匙串账户名（`secret_ref` / `passphrase_ref` / `api_key_ref`）。
  2. **删除逐表级联**：不依赖外键残留。

表按域分组（`db/schema.rs` + `db/command_center.rs`）：

| 域 | 代表表 |
|---|---|
| 基线 | `servers`、`server_groups`、`credentials`、`known_hosts`、`ssh_sessions`、`command_history`、`audit_logs` |
| P3 项目发现 | `projects`、`deployments`、`project_reviews`、`project_inventory`、`confirmed_projects`、`project_merges` |
| P5 部署中心 | `deployment_applications`、`deployment_environments`、`service_units`、`deployment_plans`、`plan_nodes`、`plan_edges`、`deployment_runs`、`run_nodes`、`release_records`、`deployment_proposals`、`deployment_security_policies` |
| AI / 知识 | `ai_providers`、`ai_review_tasks`、`knowledge_documents`、`knowledge_document_versions`、`knowledge_usage_records`、`deployment_memory`（P5.6） |
| 数据库工作台 | `database_profiles`、`database_query_history` |
| 命令中心 | `command_favorites`、`command_usage` |
| 极核 | `extreme_tasks` |

---

## 7. 安全边界（摘要）

1. **前端永不传命令字符串**，只传结构化标识（session_id、unit、container、path、project_id）。
2. `Capability::command()` 是唯一拼命令的 `match`，内部先 `validate_*` 再套固定模板；所有插值单引号包裹、位置参数前加 `--`。
3. 校验发生在网络 I/O 之前（`remote::run_capability` 先 `command()?`）。
4. 凭据只从钥匙串读，明文不回传 WebView；Host Key 首连与指纹变更必须人工确认（ProxyJump 时指向跳板机）。
5. CSP 默认开启且无 `unsafe-eval`；剪贴板走 Rust 插件（避开 WebView2 原生授权弹窗）。
6. 制品导入：不解压落盘、不执行、超限即停、命中密钥只回掩码、确认/上传前重算指纹、上传走 `.part` + 原子改名。
7. 部署：模型里没有自由文本命令字段；执行只走类型化动作；生产审批不可关闭；环境锁防止两个部署同时改同一环境。

细节与自查清单见 `../guides/SECURITY.md`。

---

## 8. 扩展点

新增一个能力时按这个顺序落：

1. 远程命令 → `safe/capability.rs` 加 `Capability` 变体 + `command()` 模板（必要时 `timeout()`）。
2. 领域逻辑 → 对应领域模块（`monitor/`、`ssh/`、`database/`…），纯解析与 I/O 分开。
3. IPC → `commands/<域>.rs` 薄封装；`lib.rs` 注册。
4. 前端类型 → `src/api/types/<域>.ts`；`ops-api.ts` re-export + 方法。
5. 事件名 → `src/lib/events.ts`（Rust 侧用同一个字符串）。
6. 视图 → `src/workbench/views/<域>/`。

落点判断与拆分规则见 `MODULE_MAP.md`。

---

## 9. 已知架构债

| 项 | 现状 | 影响 |
|---|---|---|
| `src-tauri/src/agent/runner.rs` | 仍是最长的业务文件（约 2600 行） | 多轮循环与审批耦合，改动风险高 |
| `database/schema_ops.rs`、`database/redis_driver.rs`、`service_catalog.rs` | 均超 1500 行 | 纯数据/大 match，拆分收益中等 |
| 能力位文案与实现可能不同步 | 例：`postgres_caps().schema_edit` 仍写"改表/改索引不支持"，但 `schema_ops.rs` 已有 `pg_alter_table_sql` | 界面可能错误禁用入口；改这里前先读实现，见 `../features/database-workbench.md` |
| 命令中心无一級入口 | `NavModule` 有 `commands`、视图存在，但 `NavigationRail.tsx` 的 `NAV_ITEMS` 不含它 | 只能由代码打开，产品入口待定 |
| `editor_sync` | 后端完整，前端零调用 | 历史半成品，接线前不要当作可用功能 |
| docs 为本地文档 | `.gitignore` 忽略 `docs/` | 新机器上要先从旧机器拷，或重新生成 |
