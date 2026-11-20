# 代码地图与落点规则

> 状态：**现行**，对照代码日期 2026-11-20。
> 用途：动手前判断"这段代码该放哪"；评审时判断"有没有放错层"。
> 配套规范：`.codebuddy/skills/bls-ops-modular/SKILL.md`（新增功能必读）。

---

## 1. 顶层目录

```text
BLS-OPS/
├─ src/                         前端（React 19 + TS + Vite）
│  ├─ api/                      IPC 封装与领域类型
│  ├─ app/                      仅 app-meta.ts（应用名/版本常量）
│  ├─ components/               通用组件（ui/ 基础件、icons/、ErrorBoundary）
│  ├─ desktop-menu/             屏幕级右键菜单渲染端（独立窗口）
│  ├─ desktop-notification/     右下角通知渲染端（独立窗口）
│  ├─ hooks/                    可复用 hook
│  ├─ i18n/                     国际化（en / zh-CN）
│  ├─ lib/                      纯工具（事件名、格式化、剪贴板、文件类型…）
│  ├─ stores/                   Zustand store
│  ├─ styles/                   设计令牌与全局 CSS
│  ├─ test/                     vitest 环境准备（剪贴板替身）
│  └─ workbench/                工作台外壳 + 所有业务视图
├─ src-tauri/                   Rust / Tauri
│  ├─ src/commands/             按域拆分的 Tauri 命令层
│  ├─ src/<领域模块>/            ssh、monitor、database、deployment、agent…
│  ├─ src/safe/                 远程命令的唯一生成点
│  ├─ src/db/                   SQLite schema / 迁移 / 各表访问
│  ├─ tests/                    真实集成测试（进程内 SSH 服务器、真实数据库）
│  └─ capabilities/             每个窗口的权限清单
├─ scripts/                     版本、发布、图标、数据库测试脚本
├─ .github/workflows/           ci.yml（三 job）/ release.yml（tag → draft）
├─ releases/                    发布说明
├─ docs/                        本目录（本地文档，`.gitignore` 排除）
└─ public/                      静态资源（Logo 唯一来源 public/logo.png）
```

---

## 2. 前端模块地图

### 2.1 外壳（`src/workbench/`）

| 文件 | 职责 |
|---|---|
| `Workbench.tsx` | 应用外壳：顶栏 / Rail / 侧栏 / 工作区 / 命令面板 / HostKey 弹窗 / 更新通知 / Toast |
| `AppTopBar.tsx` | 自绘标题栏（macOS 走原生，Windows 自绘窗口按钮） |
| `NavigationRail.tsx` | 52px 一级导航；`HIDDEN_MODULES` 只隐藏入口 |
| `ContextSidebar.tsx` | 左侧上下文栏（服务器树 / 数据库资产树 / 设置导航） |
| `Workspace.tsx` / `WorkbenchPane.tsx` / `WorkspaceTabs.tsx` | 递归分屏与标签 |
| `TabContent.tsx` | **视图路由表**：`switch (tab.type)` + `React.lazy` 分包 |
| `types.ts` | `WorkspaceTabType` / `WorkspacePane` / `NavModule` |
| `page-layout.tsx` | `PageSurface / PageHeader / PageScroll / PageSection` 语义布局 |
| `settings-*.tsx` | 设置页（通用、终端、AI、备份、快捷键） |
| `server-list/` | 服务器列表与表单（唯一实现） |
| `updater/` | 更新 UI（唯一状态入口是 `stores/updater-store.ts`） |

一级导航当前顺序：终端 / 服务 / 日志 / 数据库 / 项目 / AI / 设置。
`deploy`、`tasks` 在 `HIDDEN_MODULES` 里（只隐藏入口，类型与视图保留）；`commands` 没有 Rail 入口。

### 2.2 业务视图（`src/workbench/views/`）

| 目录 | 视图 | 说明 |
|---|---|---|
| `terminal/` | `TerminalView` + `extreme-core/` | 终端、补全、命令块、极核覆盖层 |
| `server-monitor/` | `ServerMonitorView` | 监控指标与趋势 |
| `remote-file/` | `RemoteFilePanel` | SFTP 文件面板、上传下载、目录大小 |
| `database/` | `DatabaseView` | SQL 工作台、表数据、结构、Redis、独立窗口 |
| `deploy/` | `DeployView` | P5 部署中心（入口被 Rail 隐藏） |
| `project/` | `ProjectView` | P3 项目发现 |
| `command-center/` | `CommandCenterView` | P4 命令中心（无 Rail 入口） |
| `command-result/` | 结果渲染器 | 只按 `view` 分发，不写业务判断 |
| `ai/` | `AiPlaceholder` | 占位 |
| `home/` | `WorkbenchHome` | 工作台首页 |
| 平铺 | `ServiceManagerView` / `LogCenterView` | 系统服务与日志 |

### 2.3 API 与类型（`src/api/`）

- `ops-api.ts`：唯一 IPC 出口，导出 `opsApi` 对象与全部领域类型（re-export `types/*`）。
- `types/<域>.ts`：servers / sessions / ssh / sftp / monitor / services / containers / gateway / project / deployment / database / command / agent / backup / extreme / transfer / trash / updater / editor-sync / environment / panel / vscode。
- 新增类型必须两边同步：`types/<域>.ts` 定义 + `ops-api.ts` re-export。

### 2.4 状态（`src/stores/`）

| store | 职责 |
|---|---|
| `workbench-store.ts` | 布局核心：模块、分屏树、标签增删、焦点、侧栏 |
| `domain-store.ts` | 服务器 / 分组 / 凭据 / 主机指纹 / 会话（全部来自 SQLite） |
| `session-store.ts` | 活跃 SSH 会话与 Host Key 质询（"连了几个"的唯一真相） |
| `monitor-store.ts` | 按标签隔离的监控状态与 30 分钟趋势 |
| `database-store.ts` / `database-workbench-store.ts` / `database-workspace-store.ts` | 连接资产 / SQL 编辑器与结果集 / 标签内工作项 |
| `extreme-store.ts` | 极核全量状态（server/session/workspace/task 四标识、对话、右栏） |
| `activity-store.ts` | 重启会被打断的工作票据（命令/传输/编辑/长任务） |
| `inspection-store.ts` | 巡检（只读）模式开关 |
| `shortcut-store.ts` | 可自定义的全局快捷键 |
| `updater-store.ts` | 更新状态唯一持有者 |
| `dir-size-store.ts` | 目录大小结果缓存（消费 Rust 推送） |

规则：SSH 输出不进 Zustand（由 xterm 直接消费事件）；"连接状态"只能从 `session-store` 读。

### 2.5 通用层

| 位置 | 放什么 |
|---|---|
| `src/lib/events.ts` | **所有** Tauri 事件名 |
| `src/lib/format.ts` | `formatBytes/formatSpeed/formatUptime`（监控）与 `formatSize/formatTime/formatCount`（文件） |
| `src/lib/clipboard.ts` | 复制/粘贴（走 Rust 插件，禁 `navigator.clipboard`） |
| `src/lib/platform.ts` | 仅 `isMacOS()` |
| `src/lib/cn.ts` | clsx + tailwind-merge |
| `src/lib/file-kind.ts` + `vscode-file-icons.ts` | 文件图标（`pnpm icons:regen` 生成） |
| `src/components/ui/` | Button / Input / Select / Modal / ConfirmDialog / ContextMenu / Toast / EmptyState… |
| `src/styles/tokens.css` | **唯一设计令牌源**（`--app`、`--surface-*`、`--fg*`、`--accent*`、`--line*`） |

---

## 3. 后端模块地图

### 3.1 命令层（`src-tauri/src/commands/`）

`commands.rs` 只做 `mod` + `pub use`，把 36 个域模块扁平重导出，因此 `lib.rs` 的 `invoke_handler` 保持 `commands::server_list` 风格不变。同文件还有 `open_db`、`record_audit`、`require_existing_credential` 三个共享 helper。

| 域文件 | 覆盖 |
|---|---|
| `servers` / `credentials` / `known_hosts` / `sessions` | 服务器、分组、凭据、主机指纹、历史与审计 |
| `ssh` | 连接、输入、exec、cd、resize、编码、keepalive、状态、断开、右栏 shell |
| `sftp` / `transfer` / `trash` / `editor_sync` / `vscode` | 文件读写、传输队列、回收站、编辑器同步、VSCode Remote-SSH |
| `monitor` / `services` / `containers` / `gateway` | 指标、systemd+journald、Docker、Nginx |
| `command_center` | P4 检索 / 执行 / 收藏 / 参数 |
| `project` / `environment` | P3 扫描与能力探测、Nginx 环境探测 |
| `deployment_center` / `deployment`（legacy）/ `deployment_proposal` / `deployment_session` / `deployment_run` / `deployment_knowledge` / `deployment_memory` | P5 模型 CRUD、方案生成、会话、执行、知识库、Memory |
| `database` | 数据库工作台全部 IPC（SQL / 元数据 / 表 / 查询 / 导出 / Redis） |
| `agent` / `ai_agent` / `ai_provider` | 超能 Agent、只读工具循环、AI 提供方 |
| `extreme` / `extreme_log` / `browser` / `window_panel` | 极核任务、实时日志、内置浏览器、右栏扩宽 |
| `app` / `backup` / `system` / `release_notes` | 诊断、整机备份、外链、版本说明 |
| `tests.rs` | 命令层单测 + 内存 SQLite 夹具 |

### 3.2 领域模块（`src-tauri/src/`）

| 模块 | 职责 | 关键约束 |
|---|---|---|
| `ssh/` | 会话、握手、主机指纹、PTY shell、SFTP、编码 | 管理操作不开 PTY；每条命令有超时；注册表锁不跨 await |
| `monitor/` | 只读 Linux 指标 | 固定命令表；`parse` 是纯函数；读不到就报错，不返回 0 |
| `database/` | 多引擎数据库工作台 | 协议驱动，不跑 CLI；密码只在钥匙串；能力三态 |
| `deployment/` | P5 模型 / 方案 / 动作 / 执行 / 运行 | 模型无自由命令字段；动作是类型化枚举 |
| `agent/` | 超能模式 Agent | 命令文本唯一生成点；风险分级；写前备份 |
| `command_center/` | P4 知识库与检索 | `catalog.json` 构建期生成 |
| `output_adapter/` | 输出适配（json/table/log/tree/metrics…） | 解析失败必须回落 raw，不静默丢输出 |
| `db/` | SQLite schema、迁移、各表访问 | 密钥不入库；删除逐表级联 |
| `safe/` | 命令模板 + 参数校验 | 唯一能拼远程命令的地方 |
| `backup/` | 整机配置备份/恢复 | 迁移前自动备份 |
| `transfer.rs` / `trash.rs` / `dirsize.rs` | 传输队列 / 远程回收站 / 目录大小 | 均可取消 |
| `desktop_menu.rs` / `desktop_notification.rs` / `desktop_surface.rs` | 桌面浮窗 | 独立窗口 + 屏幕坐标 |
| `window_material.rs` | Windows Acrylic 与实色回退 | 系统关透明效果时回落 |
| `tray.rs` | 托盘 | 点 X 隐藏；只有 Quit 退出 |

---

## 4. 新功能落点决策

| 要做的事 | 落点 |
|---|---|
| 新的远程命令 | `safe/capability.rs`：`Capability` 变体 + `command()` 模板（+ 超时） |
| 新的 Tauri 命令 | `commands/<域>.rs`（只做参数校验 + 调领域层） |
| 新监控指标 | `monitor/model.rs`（命令与结构）→ `monitor/parse.rs`（纯函数）→ `monitor/collect.rs` |
| 新部署动作 | `deployment/action/{model,spec,validate}.rs` → `deployment/exec/steps.rs` |
| 新数据库引擎 | `database/engine_registry.rs` 注册（能力 + 验证等级）→ `driver/` 实现 |
| 新前端视图 | `workbench/views/<域>/`，容器 + 子组件 + `utils.ts` |
| 新领域类型 | `api/types/<域>.ts` + `ops-api.ts` re-export |
| 新事件 | `lib/events.ts`（Rust 侧同名字符串） |
| 新基础组件 | `components/ui/` |
| 纯工具函数 | `lib/<用途>.ts`，不依赖 React |

判定顺序：**先问"这条命令谁生成"**。如果答案不是 `safe::Capability`（或 Agent 工具层），设计就是错的。

---

## 5. 拆分规则

1. **前端视图约 400 行、Rust 文件约 600 行**就目录化，按职责切，不按行数平均切。
2. Rust 统一用 `foo.rs` 作父模块 + `foo/` 存子模块；**`foo.rs` 与 `foo/mod.rs` 不能并存（E0761）**。
3. 父模块只放模块文档、`mod` 声明与 `pub use`，把子模块项 re-export 到模块根，旧路径零修改。
4. 仅测试使用的内部项用 `#[cfg(test)] pub(crate) use`，否则非测试构建报 unused。
5. 子模块互相引用写 `use super::xxx::Yyy`，**不要 `use super::*`**（容易成环）。
6. 新 Rust 模块必须在父模块 `pub mod`，否则文件根本不参与编译（`cargo check` 会假绿）。

已目录化的范例：`commands/`、`monitor/`、`ssh/`、`safe/`、`db/`、`database/`、`deployment/`、`agent/`、`output_adapter/`。

### 仍然超标（改动时优先拆）

- `agent/runner.rs`（多轮循环 + 审批 + 事件）
- `database/schema_ops.rs`、`database/redis_driver.rs`
- `service_catalog.rs`（大常量表，纯数据）
- `ssh/sftp.rs`、`db/schema.rs`、`db/deployment.rs`

---

## 6. 测试放哪

| 层 | 位置 | 约定 |
|---|---|---|
| Rust 单元 | 就近 `#[cfg(test)] mod tests`，或模块下 `tests.rs` | 纯解析函数用固定样本，含空输入/超长/缺字段 |
| Rust 集成 | `src-tauri/tests/*.rs` | 进程内 SSH 服务器；数据库用真实实例（`BLS_TEST_*_REQUIRED=1`） |
| 前端 | 被测目录下 `test/*.test.ts(x)` | happy-dom；`src/test/setup-clipboard.ts` 统一替身 |
| i18n | `src/i18n/test/indirect-keys.test.ts` | 静态扫描源码里的动态 key |

命令与期望值：

```bash
pnpm build            # tsc + vite build
pnpm test             # vitest
cd src-tauri && cargo fmt --all -- --check
cd src-tauri && cargo test --all-targets
pnpm test:db          # MySQL/MariaDB + PostgreSQL（需要本地容器）
```

---

## 7. 反模式

- 在 `commands/*.rs` 里拼命令字符串或写业务逻辑。
- 在组件里直接 `invoke` 或直接调 `plugin-updater`。
- 复制粘贴事件名字符串、格式化函数。
- 用 `window.confirm` 替代 `ConfirmDialog`。
- 新增"看起来能用"的占位：未安装 = 不执行；不支持 = `supported:false` + 原因；读不到 = `null`，绝不返回 0 或空数组冒充成功。
- 让单个文件继续膨胀而不拆。
