# 运维工作台 (BLS-OPS)

> **BLS-OPS** — 基于 Tauri + React + Rust 的桌面 SSH 运维工具。

---

## 📌 项目概述

**产品定位**：面向运维/开发人员的本地 SSH 会话管理工具，以“SSH First”为核心设计理念。

**技术栈**：

| 层级 | 技术 | 说明 |
|------|------|------|
| 前端 | React 19 + TypeScript + Tailwind CSS v4 | 工作台 UI |
| 终端 | xterm.js + FitAddon | 真实交互式终端 |
| 后端 | Rust + Tauri 2 | 桌面应用框架 |
| SSH | russh 0.63 | 密码 / 私钥 / 私钥+口令 / ProxyJump |
| 数据库 | rusqlite + SQLite（含迁移） | 服务器、凭据、Known Hosts、会话、历史 |
| 密钥 | keyring | 密码与私钥只写入系统凭据管理器 |

**当前版本**：`v0.1.0`

---

## 🚀 快速开始

### 前置要求

| 环境 | 版本 | 说明 |
|------|------|------|
| 操作系统 | Windows 10/11 | 主要开发与验证环境 |
| Node.js | ≥ 20 | pnpm 9 推荐 |
| Rust | ≥ 1.77 | MSVC 工具链（Visual Studio Build Tools）|
| WebView2 | 自动安装 | Tauri 依赖 |

### 安装与运行

```bash
pnpm install
pnpm tauri dev          # 开发模式
pnpm tauri build        # 发布构建，输出 src-tauri/target/release/bundle/
```

分步验证：

```bash
pnpm build              # 前端类型检查 + 构建
cd src-tauri
cargo check --all-targets
cargo test              # Rust 单元测试
```

---

## 🏗️ 实现进度

| 模块 | 状态 | 说明 |
|------|------|------|
| **UI 工作台外壳** | ✅ | 导航、侧边栏、Tab、分屏、命令面板、状态栏 |
| **SQLite Schema + 迁移** | ✅ | `user_version` 驱动的幂等迁移（`db::migrate`），含 v1→v2→v3 升级 |
| **服务器 CRUD** | ✅ | 新增 / 列表 / **编辑** / 删除（级联清理会话与命令历史） |
| **服务器分组** | ✅ | `server_groups` 表 + 侧边栏分组树：新增、**重命名**、**删除**（解除服务器引用）、折叠 |
| **标签 / 收藏** | ✅ | 服务器标签与收藏开关，首页与侧边栏同步 |
| **凭据 CRUD + 编辑** | ✅ | 密码、私钥、**私钥+口令**；密钥存系统 Keyring |
| **凭据 ↔ 服务器绑定** | ✅ | 服务器表单选择凭据；删除凭据前统计引用并解除绑定 |
| **Known Hosts** | ✅ | 列表、删除、首次连接确认、指纹变更拦截 |
| **真实 SSH 会话** | ✅ | `SshSessionManager`：密码 / 私钥 / 私钥口令 / ProxyJump |
| **终端** | ✅ | xterm.js 输入输出、Resize、断开、重连、KeepAlive、查找 |
| **服务管家（systemd）** | ✅ **P3** | `systemd.rs` + `ServiceManagerView`：服务列表与自启状态合并、搜索与五种筛选、启动/停止/重启/重载/自启开关（停止与重启有确认弹窗）、`systemctl status` 详情 |
| **日志中心（journald）** | ✅ **P3** | `journal.rs` + `LogCenterView`：按单元与优先级查询（`journalctl -o json` 解析）、行数选择、结果内搜索、跟随最新、磁盘占用 |
| **Docker 管家** | ✅ **P3** | `docker.rs` + `DockerManagerView`：容器 / 镜像 / 资源占用三个 Tab、容器日志、启停重启删除（含确认）、删除镜像与清理（含确认）；**Docker 不可用时给出原因而不是空列表** |
| **Nginx 管家** | ✅ **P3** | `nginx.rs` + `NginxManagerView`：站点列表（兼容 `sites-available` 与 `conf.d` 两种布局）、配置编辑、**保存即校验、校验通过才重载**、失败时明确告知并给出备份路径 |
| **项目与部署** | ✅ **P3** | `projects` / `deployments` 表 + `ProjectView`：项目 CRUD（部署步骤后端白名单校验）、一键部署、**实时日志流**、部署历史与回看 |
| **安全执行层** | ✅ **P3** | `safe.rs`：所有管理命令由常量模板 + 参数白名单生成，前端永不传命令字符串；部署步骤限制在项目目录内 |
| **服务器状态监控（只读）** | ✅ **P2 正式完成** | `monitor.rs`：固定命令表 + exec 通道（不经 PTY）/ 5 秒超时 / 断连取消 / **意外断网检测**（远端主动断开、transport 错误、exec 无法建通道时标记会话失效，`ssh_status` 立即返回 false）/ **重连即新基线**（同 sessionId 重连前关闭并移除旧会话、清除采样基线）/ **进程命令用 `comm` 不回传启动参数**（`--password`、token、数据库连接串等敏感信息永不进入响应；即使服务端误回 `args` 风格输出，解析也只保留可执行名）；`ServerMonitorView`：4 张指标卡、**30 分钟趋势（样本上限按采集间隔动态计算：2s→900 / 5s→360 / 30s→60）**、磁盘/网络/进程三个详情 Tab |
| **远程文件浏览器** | ✅ | 独立 SFTP subsystem 通道（复用最终目标连接，兼容 ProxyJump）；面包屑/后退/前进/上一级/刷新；**重命名、副本、删除（递归，带确认弹窗）、新建文件夹/文件**；**上传支持两种入口**：工具栏“上传”按钮（系统文件选择器，可多选）与本地拖拽（文件与文件夹递归，落在当前目录）；**跟随终端 `cd` 联动**；右侧面板默认展开、可拖宽、可折叠 |
| **通用右键菜单组件** | ✅ | `components/ui/context-menu.tsx` + `useContextMenu()`：左键/Escape/失焦/尺寸变化即关闭，**右键别处直接移动而非关闭重开**（不闪烁），键盘 ↑↓/Home/End/Enter 导航（跳过分隔符与禁用项），越界自动吸附视口内，`memo` 化不随父组件重渲染 |
| **文件类型识别与图标** | ✅ | 按扩展名区分 SQL / HTML / JS / TS / Java / Python / JSON / YAML / PDF / Excel / Word / 图片 / 压缩包 / 视频音频等，各类独立彩色图标 |
| **文本文件预览编辑** | ✅ | 双击文本/代码文件打开内置编辑器（CodeMirror，语法高亮：SQL、HTML、JS/TS/JSX、Java、JSON、CSS、Python、Markdown），Ctrl+S 保存回写；二进制与大文件（>2MB）明确拒绝；编辑器代码分包懒加载 |
| **表单弹窗** | ✅ | 新建文件/文件夹、重命名均为带校验的 Modal 弹窗（禁空名、禁 `/`），不再使用 window.prompt |
| **命令历史解析** | ✅ | 方向键、Ctrl+C/Ctrl+U/Ctrl+W、括号粘贴（多行）、`\` 续行与未闭合引号均正确处理 |
| **连接状态指示** | ✅ | Tab 上的状态点来自 `session-store`（连接中/已连接/失败/断开），不依赖任何本地假标记 |
| **命令历史** | ✅ | 终端侧栏按会话+服务器过滤并可回放；设置页提供全局历史列表 |
| **审计日志** | ✅ | 设置页查看 `audit_logs`（连接、断开、增删改、主机指纹决策） |
| **Host Key 校验** | ✅ | 未信任 / 变更均弹窗拦截，拒绝则连接不成立 |
| **ProxyJump 指纹信任** | ✅ | 挑战返回 `challenge_host` / `challenge_port`，依次信任跳板机与目标机 |
| **优雅断开** | ✅ | channel EOF → channel close → SSH `Disconnect::ByApplication` → 清理会话与数据库 |
| **并发安全** | ✅ | 会话注册表只在查表时持锁；每个会话独立锁，慢会话不阻塞其他会话 |
| **安全边界** | ✅ | Rust 侧读 Keyring 并建立连接，密码永不回传 WebView；已移除 `credential_get_secret`；CSP 已启用 |
| **Rust 单元测试** | ✅ | 153 个（目标解析、主机密钥信任矩阵、POSIX 路径、自然排序、迁移、级联删除、Known Hosts、服务器校验、会话记录、**exec 超时与断连取消**、`/proc` 与 `df`/`ps`/`os-release` 解析、**进程列表不携带命令行机密**等） |
| **SSH 端到端测试** | ✅ | 27 个，进程内真实 SSH 服务端：握手、信任、密码认证、双跳 ProxyJump、优雅断开、SFTP 浏览、文件管理（删除/重命名/副本/mkdir/上传）、编辑器读写往返、二进制识别 |
| **监控端到端测试** | ✅ | 15 个，进程内真实 SSH 服务端 + 会“走字”的 `/proc/stat` 夹具：全量快照解析、连续两次采集求差、**ProxyJump 采集最终服务器**、不支持的操作系统、命令超时、**断开后采集停止**、**断开取消进行中的采集**、**服务端主动断开被识别**、**断开后同 sessionId 重连、首次采集使用新基线**、**服务端误回 args 风格进程列表时密码/token/连接串不进入响应**、exec 与 PTY 同时使用、无 shell 的监控会话 |
| **前端测试** | ✅ | 52 个（vitest + happy-dom）：Modal 退出动画遮罩回收、中途重开取消卸载、文件类型识别、**监控 store 的按 Tab 隔离 / 暂停 / 30 分钟窗口（2s/5s/30s 三个间隔的样本上限）/ 断连停止 / 不重叠采集**、**右键菜单的打开 / 外部点击关闭 / Escape 关闭 / 失焦关闭 / 右键别处不闪烁 / 无 handler 区域右键关闭 / 键盘跳过分隔符与禁用项 / 视口吸附** |
| **CI** | ✅ | Windows：`fmt` / `check --all-targets` / `test --all-targets` / `build` + **桌面程序启动冒烟** + `pnpm build` + `pnpm test` |
| **Docker / Nginx / 部署 / 项目 / AI** | ⏸ 暂停 | 仅保留占位说明，验收通过前不开发。**文件模块第一阶段（SFTP 只读浏览）已上线**，上传/下载/删除/重命名/在线编辑留待后续 |

### 关于 Windows `0xc0000139`

历史记录里出现过启动崩溃（`STATUS_ENTRYPOINT_NOT_FOUND`）。当前状态：

- `Cargo.lock` 中**不存在** `openssl-sys` / `libgit2-sys` / `libssh2-sys` 等需要外部 DLL 的原生依赖；SSH 走 rustls/ring（纯 Rust），SQLite 为 `bundled` 静态编译。
- **CI 每次提交都会在干净的 `windows-latest` 上运行启动冒烟测试**：构建后拉起 `ops-workbench.exe`，等待 20 秒，断言进程存活且创建了窗口（标题 `BLS-OPS`）。这是对 `0xc0000139` 的持续回归防线，不再依赖人工确认。
- 本机同样验证过：`src-tauri/target/debug/ops-workbench.exe` 正常启动并保持运行。

如在特定机器上仍遇到该错误，优先排查 PATH 中的第三方 OpenSSL / Git for Windows DLL 冲突。

### 关于 CI 状态

`.github/workflows/ci.yml` 已在版本控制中。若某次提交右侧没有状态检查，通常是**该提交尚未推送到 `origin`**——GitHub 只对已推送的 commit 运行 workflow。可用 `git status -sb` 确认分支是否领先于 origin。

---

## 📁 项目结构

```
BLS-OPS/
├── src/                          # 前端 (React + TS)
│   ├── api/ops-api.ts            # IPC 客户端 + 类型（无 getCredentialSecret）
│   ├── stores/
│   │   ├── workbench-store.ts    # Tab / 分屏 UI 状态
│   │   ├── domain-store.ts       # 服务器 / 凭据 / 分组 / Known Hosts / 会话
│   │   ├── session-store.ts      # 实时会话状态与 Host Key 挑战
│   │   └── monitor-store.ts      # 监控状态：按 Tab 隔离、暂停、30 分钟趋势窗口
│   ├── workbench/
│   │   ├── views/               # WorkbenchHome、TerminalView、ServerMonitorView、PlaceholderView
│   │   ├── host-key-dialog.tsx  # Host Key 确认弹窗 + 已知主机面板
│   │   ├── ssh-context-sidebar.tsx      # 服务器列表 / 编辑表单
│   │   ├── settings-context-sidebar.tsx # 凭据 / 已知主机 / 运行环境
│   │   └── StatusBar.tsx         # 真实会话数与实体计数
│   └── hooks/                    # 全局快捷键、窗口边缘拖拽、表单提交守卫
│
├── src-tauri/src/
│   ├── lib.rs              # Tauri 入口与命令注册
│   ├── db.rs               # Schema、迁移、CRUD、单元测试
│   ├── ssh.rs              # SshSessionManager：认证、Host Key、KeepAlive、ProxyJump、exec 通道
│   ├── monitor.rs          # 只读监控：固定命令表 / /proc·df·ps 解析 / 速率基线 / 断连取消
│   ├── commands.rs         # IPC 命令层（密钥只在此读取）
│   ├── keyring.rs          # 系统凭据管理器封装
│   └── state.rs            # AppState
│
└── .github/workflows/ci.yml
```

---

## 🔌 IPC 接口契约

### 服务器与分组

| Command | 说明 |
|---------|------|
| `server_list` / `server_get` | 列表 / 单个 |
| `server_save` | 新增或更新（校验凭据、分组、跳板机与循环引用） |
| `server_delete` | 删除并级联清理会话、命令历史、跳板机引用，返回清理数量 |
| `server_set_favorite` | 收藏开关 |
| `server_test_connection` | 建连后立即断开，用于“测试连接” |
| `group_list` / `group_save` / `group_delete` | 分组管理（删除时解除服务器引用） |

### 凭据

| Command | 说明 |
|---------|------|
| `credential_list` | 列表（**不含任何密钥内容**） |
| `credential_save` | 新增或更新；`secret` 为密码或私钥，`passphrase` 仅用于私钥 |
| `credential_delete` | 未传 `force` 且被引用时返回 `references` 而不删除 |

> 安全约束：**没有** `credential_get_secret`。密钥只由 Rust 从 Keyring 读出并直接用于 SSH，永不回传 WebView。

### Known Hosts

| Command | 说明 |
|---------|------|
| `known_host_list` / `known_host_get` | 查询 |
| `known_host_trust` | 写入（或拒绝）主机指纹，来自 Host Key 弹窗 |
| `known_host_delete` | 撤销信任 |

### 服务器监控（只读）

| Command | 说明 |
|---------|------|
| `monitor_snapshot` | **优先使用**：一次返回主机信息 + CPU / 内存 / 磁盘 / 网络 / 进程 |
| `monitor_system_info` | 主机名、发行版、内核、架构、运行时长 |
| `monitor_cpu` | 使用率（两次 `/proc/stat` 采样求差）、1/5/15 分钟负载、逻辑核心数 |
| `monitor_memory` | 物理内存与交换分区（字节）、使用率 |
| `monitor_disks` | `df -B1 -P -T`，已剔除 tmpfs / devtmpfs |
| `monitor_network` | 每接口累计收发字节 + 相对上一次采集的速率（B/s），已剔除 `lo` |
| `monitor_processes` | Top N 进程（按 CPU 排序，上限 100） |

> 这些命令**只接受 `sessionId`**。要执行的命令是 `monitor.rs` 里的固定表，WebView 无法传入任意 shell 字符串。

### 服务 / 日志 / 容器 / 网关（P3）

| Command | 说明 |
|---------|------|
| `service_list` | `systemctl list-units` + `list-unit-files`，并发读取后合并自启状态 |
| `service_action` | 启动 / 停止 / 重启 / 重载 / 自启开关。只传固定动词 + 校验过的单元名 |
| `service_status` | `systemctl status` 详情 |
| `journal_query` | journald 查询，可按单元与优先级（`-p`）过滤 |
| `journal_disk_usage` | 日志占用空间 |
| `docker_snapshot` | 一次返回容器、镜像、资源占用；Docker 缺失时给出原因 |
| `docker_logs` / `docker_container_action` / `docker_image_remove` / `docker_prune` | 容器与镜像操作 |
| `nginx_sites` | 站点列表（同时支持 `sites-available` 与 `conf.d` 两种布局） |
| `nginx_config` / `nginx_save_config` / `nginx_test` / `nginx_reload` / `nginx_set_site_enabled` | 配置编辑与校验 |
| `project_list` / `project_get` / `project_save` / `project_delete` | 项目 CRUD |
| `deployment_list` / `deployment_get` / `deployment_execute` | 部署历史与执行 |

> 这些命令**不接受任何命令字符串**。`deployment_execute` 只收 `projectId` + `sessionId`，步骤从 SQLite 读出后重新校验一遍。

### 前端组件契约

| 组件 | 说明 |
|------|------|
| `components/ui/context-menu.tsx` | 通用右键菜单。用 `useContextMenu()` 拿 `props` 与 `onContextMenu(build)`，`<ContextMenu {...menu.props} />` 挂在组件末尾即可。菜单项支持 `icon` / `danger` / `disabled` / `separator` / `hint`，可选 `title` 作为分组标题 |
| `components/ui/confirm-dialog.tsx` | 危险操作确认弹窗。所有删除类操作统一走它，不使用 `window.confirm` |

### 会话与 SSH

| Command | 说明 |
|---------|------|
| `ssh_connect` | 建立会话；支持 `serverId` 或 `target`（`user@host:port`）+ `credentialId`，或 `password`（一次性密码，仅本次使用，不落盘） |
| `ssh_connect_monitor` | 同上，但**不请求 PTY、不打开 shell**，专供监控使用 |
| `ssh_input` / `ssh_resize` / `ssh_keepalive` / `ssh_status` / `ssh_disconnect` | 会话控制 |
| `sftp_open` | 打开 SFTP，返回远程 Home 的规范路径 |
| `sftp_list_dir` | 列目录：返回规范路径 + 条目（文件夹优先、名称自然排序） |
| `sftp_realpath` / `sftp_stat` / `sftp_close` | 路径规范化 / 单条目详情（lstat 语义）/ 关闭 SFTP |
| `session_list` / `session_stats` | 历史会话与实时会话数 |
| `history_record` / `history_list` | 命令历史 |
| `audit_log_list` | 审计日志 |
| `app_info` | 版本、数据库路径、Schema 版本、KeepAlive 间隔 |

**事件**：`ssh-output-{sessionId}`（输出流）、`ssh-closed-{sessionId}`（断开）。

**`ssh_connect` 返回值**：

```ts
type SshConnectResult =
  | { status: "connected"; session_id; host; port; fingerprint; fingerprint_type }
  | {
      status: "host_key_unknown";
      session_id;
      challenge_host;
      challenge_port; // ← 必须把指纹存到这个端点
      host;
      port; // 最终目标，仅用于展示
      fingerprint;
      fingerprint_type;
    }
  | { status: "host_key_changed"; ... challenge_host; challenge_port; known_fingerprint }
```

后两种状态必须由用户确认指纹后重试，绝不会被当作“已连接”。

`host` / `port` 是最终目标（Tab 显示的服务器），`challenge_host` / `challenge_port` 是需要被信任的端点。使用 ProxyJump 时两者**不同**——指纹必须存在 `challenge_*` 下，否则会污染错误主机并陷入无限重试。UI 会在跳板机场景下明确提示这一点。

---

## 🧪 测试

```bash
pnpm test                     # 前端测试（vitest + happy-dom）
cd src-tauri
cargo test                    # 153 单元测试 + 27 SSH + 15 监控 + 25 P3 端到端
cargo test --test ssh_e2e     # 只跑 SSH 端到端
cargo test --test monitor_e2e # 只跑监控端到端
cargo test --test p3_e2e      # 只跑服务/日志/容器/网关端到端
```

`tests/ssh_e2e.rs` 会在进程内启动**真实的 SSH 服务端**（russh server + russh-sftp server，ed25519 主机密钥，监听 127.0.0.1 随机端口），然后驱动生产代码里同一套 `SshSessionManager`。覆盖：

- 首次连接返回未信任指纹，且挑战端点正确；
- 指纹变化时返回 `HostKeyChanged` 并带上旧指纹；
- **信任 → 重连 → 拿到 shell → 输入回显 → Resize** 全链路；
- 密码错误被正常报错；
- **ProxyJump 逐跳信任**：跳板机先挑战（端口是跳板机端口）→ 目标机再挑战（端口是目标机端口）→ 两端都信任后落到目标机 shell；
- 跳板机拒绝隧道时有明确错误；
- 断开后会话被移除，重复断开安全；
- 多会话互不干扰；
- **SFTP**：连接后打开远程 Home 并列出条目（中文名、空格、隐藏文件、符号链接、自然排序）、进入子目录与返回、stat 详情（大小/mtime/链接类型）、无权限目录返回明确错误且会话存活、**SSH 断开后 SFTP 立即失败**、shell 与 SFTP 同时工作、**ProxyJump 后浏览的是最终服务器的文件而非跳板机**。

这套测试替代了“找一台真实服务器手测”的大部分价值，且在 CI 上每次提交都会跑。

`tests/monitor_e2e.rs` 用同样的办法启动**真实的 SSH 服务端**，但让它按命令返回 Linux 夹具输出——其中 `/proc/stat` 与 `/proc/net/dev` 每次读取都会**真的往前走**，所以 CPU 使用率与网速必须是两次采样的差值得出的。覆盖：

- 全量快照解析（主机名 / 发行版 / 内核 / 架构 / 运行时长 / CPU / 内存 / 磁盘 / 网络 / 进程）；
- 连续两次采集：计数器在动，速率是真实差值；
- 两个会话各自持有独立基线；
- **ProxyJump 采集的是最终服务器**（`jump-host` 与 `final-host` 夹具不同，断言看到 `final-host`）；
- 不支持的操作系统（Darwin）：快照返回 `supported: false` 并带上原因，**指标列表为空而不是零**；
- 命令超时：服务端接受 exec 通道后保持沉默，客户端必须在预算内失败；
- **断开后采集停止**（所有 collector 都失败且原因是“会话不存在”）；
- **断开会取消正在进行中的采集**，而不是等满 5 秒；
- **服务端主动断开被识别**：服务端自己关闭连接（客户端从未调用 disconnect），下一次状态检查返回 false、下一次采集失败——registry 里的旧条目不会永远返回“已连接”；
- **断开后同 sessionId 重连**：先 forget 旧基线再重连，第一次采集走“双采样”路径取新基线（若错误地与旧连接共享基线，字节计数会停在旧读数上，测试精确区分这两条路径），且 registry 中恰好只有一个活会话；
- **exec 与 PTY 同时使用**：shell 回显与监控采集互不干扰；
- 监控会话没有 shell（`ssh_input` 明确报错“没有交互式终端”，但 `exec` 正常）。

`tests/p3_e2e.rs` 用同样的办法驱动服务 / 日志 / 容器 / 网关四个模块。它的特殊之处是**服务端会把收到的每一条命令记下来**，于是测试可以从外部断言“真正发出去的命令长什么样”。覆盖：

- 服务列表解析与自启状态合并，失败项排在最前；
- **服务操作发出的是固定模板命令**：断言服务端收到的是 `systemctl restart -- 'nginx.service'`（带引号、带 `--`）；
- **恶意参数完全不会到达服务器**：`nginx.service; cat /etc/shadow`、`-v /:/host`、项目目录之外的 `rm -rf /var/log` 都被拒绝，且服务端命令日志**一条都没增加**——顺带证明了参数校验发生在任何网络 I/O 之前；
- 日志按优先级过滤是在服务端做的（`-p 3`），只把错误级别传回来；
- Docker 快照解析（端口映射里的空格与逗号不被切坏）、**缺少 Docker 时给出原因而不是空列表**、`docker rm` 必须带 `-f`；
- Nginx 两种目录布局合并（`sites-available` + `conf.d`，同名站点只出现一条）、`nginx -t` 的判定从 **stderr** 读出（真实 nginx 就写在 stderr）、备份后缀在引号内；
- **部署步骤**：白名单内的原样执行，越出项目目录的在执行前就被拒；
- 服务端不响应时命令在预算内超时；断开后所有命令失败并说明“会话”问题；
- 所有模块都只走 exec 通道，从不请求 shell（非交互会话的 `ssh_input` 明确报错）。

### 人工验收步骤（真实环境）

1. `pnpm tauri dev` 启动，确认无 `0xc0000139`；
2. 新建密码凭据 + 服务器，首次连接：先点**拒绝**（连接应失败），再连接并**信任**；
3. 执行 `pwd`、`ls`、`echo test`，检查输出正常；
4. 缩放窗口，确认终端跟随 Resize；断开 → 重连；
5. 重启应用，确认服务器、凭据、历史仍在；
6. 私钥与带口令私钥各测一次；
7. 手动改动服务器指纹（如重新生成主机密钥），确认出现强警告；
8. **文件浏览**：连接后右侧面板默认展开，显示 Home 目录；双击文件夹进入、点面包屑跳转、`Backspace` 上一级、`Enter` 打开选中项、拖动左边缘调整宽度、折叠后从工具栏恢复；找一个无权限目录（如 `/root` 普通用户），确认显示“权限不足”且应用不崩；
9. **文件操作**：单击文件 → 顶部出现操作条（打开/重命名/副本/删除）；或右键同名菜单（打开、重命名 F2、创建副本、复制完整路径、复制文件名、删除 Delete）。右键空白处 → 上传文件…、新建文件夹、新建文件、刷新。新建文件夹/文件弹出 Modal（输入空名或带 `/` 会被拦截）；删除弹出 `ConfirmDialog` 确认；
10. **文本编辑**：双击 `.sql`/`.conf`/`.js`/`.java` 等文件 → 弹出带语法高亮的编辑器，修改后 Ctrl+S 保存，列表大小刷新；双击 `.pdf`/`.xlsx`/`.png` 显示“暂不支持打开”的提示条；`.bin`（含 NUL）拒绝编辑并说明是二进制；
11. **上传（两种入口）**：① 点工具栏的上传图标 → 系统文件选择器 → 可多选 → 上传到当前目录；② 从资源管理器拖文件/文件夹到面板区域 → 显示虚线高亮 + 目标路径 → 松手上传。**拖到终端或其他面板区域不会触发上传**（按指针坐标命中测试）。上传中显示进度条，完成后列表自动刷新；
12. **cd 联动**：在终端执行 `cd /var/log`，右侧面板自动跳到该目录；`cd`、`cd ~`、`cd ..`、`cd -` 均生效；
13. **ProxyJump**：经跳板机连接后打开文件面板，确认看到的是**目标服务器**的目录（对照 `ls /home` 输出）；
14. 断开连接后文件面板应显示“连接已断开”。
15. **监控**：服务器右键 → “打开监控”（或命令面板搜“监控”），确认顶部显示主机名 / 发行版 / 内核 / 运行时长，四张指标卡有真实数值，趋势图从第二个采样点开始绘制；
16. **监控对照**：在终端里执行 `top -bn1`、`free -b`、`df -B1 -P -T`、`cat /proc/net/dev`、`ps -eo pid,user,pcpu,pmem,stat,lstart,args --sort=-pcpu | head`，与监控页数字逐一比对；
17. **监控控制**：点“暂停”数字应停止变化，点“继续”恢复；切换采集间隔生效；切到别的 Tab 或最小化窗口后轮询停止（回到该 Tab 立即恢复一次采集）；
18. **监控断连**：断开连接后监控页显示“已断开”且数字不再刷新；
19. **ProxyJump 监控**：经跳板机打开监控，确认主机名是**目标服务器**的（对照 `hostname`）。

---

## ✅ 阶段验收清单：服务器状态监控（只读）

> **状态：正式完成（P2）。** 首版验收通过后，又修复并验收了三个问题：意外断网检测、同 sessionId 重连基线、历史窗口样本上限——每一条都有端到端或单元测试覆盖。

### 后端

- [x] 基于现有 SSH `Handle` 新增 exec 通道（`SshSession::exec`），不依赖任何新依赖
- [x] 监控命令**从不走交互式 PTY**：每条命令开自己的 exec 通道，读完退出码即关闭通道
- [x] exec、PTY、SFTP 可同时使用（e2e：`exec_and_pty_work_at_the_same_time`；SFTP 与 shell 并发由 `sftp_and_shell_work_simultaneously` 覆盖）
- [x] 每次 exec 完成后关闭 channel（成功、超时、取消三条路径都关闭）
- [x] 所有命令 5 秒超时（`DEFAULT_COMMAND_TIMEOUT`，e2e 断言其等于 5 秒并验证超时生效）
- [x] 不在持全局会话注册表锁时 await 网络（注册表只在查表时持锁；监控基线是独立的 `Mutex`，同样只在查表时持锁）
- [x] SSH 断开时取消全部监控任务（会话级 `watch` 取消信号 + 断开时清理基线；e2e 验证“进行中的采集立即返回”）
- [x] 仅执行后端内置固定命令（`monitor.rs` 常量表），前端命令只接受 `sessionId`
- [x] 数据结构齐全：`SystemInfo` / `CpuMetrics` / `MemoryMetrics` / `DiskMetrics` / `NetworkMetrics` / `ProcessInfo`
- [x] 七个 Tauri 命令：`monitor_system_info` / `monitor_cpu` / `monitor_memory` / `monitor_disks` / `monitor_network` / `monitor_processes` / `monitor_snapshot`
- [x] 优先 `monitor_snapshot`：一次 IPC 返回页面主要指标（命令并发执行，8~9 条命令一轮完成）
- [x] 不支持的操作系统返回 `supported: false` + 明确原因，而不是一堆零
- [x] **意外断网检测**：`SshSession` 持有真实存活状态（handler 的 `disconnected` 回调 + russh handle 关闭，双信号）；远端关闭连接、transport 错误或 exec 无法创建通道时标记会话失效；失效会话被立即从 registry 移除，`ssh_status` 返回 false。普通命令解析失败不会被误判：只有 `SendError` / `Disconnect` / `HUP`（或 handle 已关闭）才标记，服务器拒绝单个通道与预算超时都不算断开
- [x] **同 sessionId 重连**：`connect_with` 在新连接开始前关闭并移除旧会话（绝不直接 insert 覆盖）；`ssh_connect_monitor` 开始新连接前调用 `monitor.forget(sessionId)`，新连接不与旧连接共享 CPU / 网络采样基线
- [x] **进程命令脱敏**：采集命令固定为 `ps -eo pid,user,pcpu,pmem,stat,lstart,comm`——只取可执行名，`--password=…`、token、数据库连接串等启动参数永不离开服务器；解析层只复制 `fields[10]` 一个 token，即使服务端误回 `args` 风格输出也不会把机密带进响应结构；后端全程不打印进程输出到日志

### 前端

- [x] 新增 `ServerMonitorView`
- [x] 顶部显示主机信息（主机名 / 发行版 / 内核 / 架构 / 运行时长）与连接状态点
- [x] CPU、内存、磁盘、系统负载四张指标卡
- [x] 最近 30 分钟 CPU、内存、上传、下载趋势（SVG，点数不足时明确提示“等待第二次采集”）
- [x] **历史窗口按刷新间隔动态计算样本上限** `ceil(30min / intervalMs)`：2s→900、5s→360、30s→60，任何间隔都覆盖完整 30 分钟；按时间过滤依旧保留，数组不会无限增长
- [x] 磁盘 / 网络 / 进程三个详情 Tab
- [x] 默认 5 秒采集一次（可切 2 / 5 / 10 / 30 秒）
- [x] 暂停、继续、手动刷新
- [x] 页面隐藏（窗口不可见，或该 Tab 不是当前活动页签）时暂停轮询
- [x] SSH 断开后停止轮询并显示断开状态（`ssh-closed-*` 事件 + `ssh_status` 复核）
- [x] 每个服务器与终端 Tab 独立保存监控状态（`monitor-store` 按 Tab id 分条目）
- [x] 无任何模拟指标或随机数（未采集到的值显示 `—`）
- [x] 不支持的操作系统显示明确提示（顶部黄色横幅 + 说明）

### 测试与质量

- [x] Linux 数据解析使用固定样本做单元测试（`/proc/stat`、`/proc/meminfo`、`df`、`/proc/net/dev`、`ps`、`os-release`、`loadavg`、`uptime`）
- [x] 测试 `/proc/stat` 两次采样计算 CPU 使用率
- [x] 测试内存、磁盘、网络、进程解析
- [x] 测试命令超时（单元级 `timed` + e2e 级“沉默的服务端”）
- [x] 测试 SSH 断开后采集停止、并取消进行中的采集
- [x] 测试**服务端主动断开**（非客户端 disconnect）后，下一次状态检查与采集立即识别
- [x] 测试**采集一次 → 服务端断开 → 同 sessionId 重连 → 第一次指标使用新基线**
- [x] 测试 **2 秒 / 5 秒 / 30 秒三个间隔**的样本上限与时间过滤（前端）
- [x] 测试 ProxyJump 采集最终服务器
- [x] `pnpm test`、`pnpm build`、`cargo fmt --check`、`cargo check --all-targets`、`cargo test --all-targets`、`cargo build` 全部通过
- [x] GitHub CI 保持全绿（未改动 `.github/workflows/ci.yml`，新增测试自动纳入）

### 本阶段明确不做

进程终止、服务重启、Docker、Nginx、项目部署、AI——这些在 P0 验收通过前保持暂停。

---

## ✅ 阶段验收清单：P3 服务 / 日志 / 容器 / 网关 / 部署

> 上一阶段的“明确不做”已在 P3 解禁（进程终止与 AI 除外：本阶段**不提供**进程终止与任何 AI 能力）。

### P3-1 后端管理能力

- [x] **P3-1.1 服务管理**：`systemd.rs` 解析 `systemctl list-units` 与 `list-unit-files` 并合并自启状态；启动 / 停止 / 重启 / 重载 / 自启开关均为固定动词
- [x] **P3-1.2 日志查询**：`journal.rs` 解析 `journalctl -o json`（含字节数组形式的非 UTF-8 消息），支持单元与优先级过滤
- [x] **P3-1.3 Docker 管理**：`docker.rs` 解析容器 / 镜像 / 资源占用（Go 模板 `|` 分隔，端口映射里的空格与逗号不被切坏）；启动 / 停止 / 重启 / 删除容器、删除镜像、清理无用资源
- [x] **P3-1.4 Nginx 管理**：`nginx.rs` 同时支持 Debian（`sites-available` + `sites-enabled`）与 RHEL（`conf.d`）两种布局；站点列表、配置读写、**先校验再重载**、启停站点

### P3-2 数据模型与 IPC

- [x] **P3-2.1 数据结构**：`ServiceUnit` / `JournalEntry` / `ContainerInfo` / `ImageInfo` / `ContainerStats` / `NginxSite` / `NginxTestResult`
- [x] **P3-2.2 项目表**：`projects`（id、name、description、server_id、repo_url、branch、deploy_path、commands JSON、status、时间戳）
- [x] **P3-2.3 部署表**：`deployments`（id、project_id、server_id、status、branch、commit_sha、trigger、started_at、finished_at、duration_ms、log、error_message）
- [x] Schema 从 v2 迁移到 v3，`CREATE TABLE IF NOT EXISTS` 幂等，新旧库结构一致
- [x] **P3-2.4 安全执行层**：`safe.rs` 是唯一把“动作”翻译成命令字符串的地方
  - [x] 只允许后端常量定义的命令（一个穷举 `match` 就是完整的审计面）
  - [x] 前端只传结构化标识，**不传命令字符串**
  - [x] 所有用户参数经白名单 / 字符集校验（单元名、容器名、镜像名、站点名、绝对路径、Git 引用、仓库地址、行数、优先级）
  - [x] 一切插值都单引号包裹，位置参数前加 `--`
  - [x] 部署步骤：命令白名单 + 禁止 shell 操作符 + 路径限制在项目目录内
- [x] **P3-2.5 IPC 与前端 API**：27 个新命令，`src/api/ops-api.ts` 有完整类型
- [x] 审计：服务操作、容器操作、镜像删除、清理、Nginx 保存/重载/启停、项目增删、部署执行全部写 `audit_logs`

### P3-3 前端模块

- [x] **P3-3.1 服务管家** `ServiceManagerView`：列表 + 状态点 + 自启列；搜索与五种筛选；右键菜单（详情 / 启动 / 停止 / 重启 / 重载 / 自启切换）；停止与重启走 `ConfirmDialog`
- [x] **P3-3.2 日志中心** `LogCenterView`：按单元查询、按优先级过滤（服务端过滤）、行数选择、结果内搜索、跟随最新、磁盘占用
- [x] **P3-3.3 Docker 管家** `DockerManagerView`：容器 / 镜像 / 资源占用三个 Tab；容器日志；启动 / 停止 / 重启 / 删除（含确认）；删除镜像、清理无用资源（含确认）；**Docker 不可用时显示原因而不是空列表**
- [x] **P3-3.4 Nginx 管家** `NginxManagerView`：站点列表（域名、端口、来源、是否默认）；编辑配置 → **保存即校验** → 校验通过才重载；校验失败时明确告知“未重载，站点继续使用旧配置”并给出备份路径
- [x] **P3-3.5 项目与部署** `ProjectView`：项目 CRUD（步骤按行编辑，保存时后端校验）；一键部署；**实时日志流**（前端生成 deployment id 后先订阅 `deploy-progress-<id>` 再发起，不丢早期输出）；部署历史与回看

### 会话驱动

- [x] 所有模块都是会话驱动：每个模块 Tab 通过 `useCommandSession` 持有自己的**非交互会话**（无 PTY、无 shell）
- [x] 命令全部走 exec 通道，绝不使用交互式 PTY
- [x] 超时：读取默认 5 秒；重启 / 删除 / 重载 15–60 秒；部署步骤 300 秒
- [x] SSH 断开后所有模块立即显示“已断开”并可重连

### P3-4 测试

- [x] `tests/p3_e2e.rs`：**25 个端到端测试**，真实 SSH 服务端 + 命令日志断言
- [x] Rust 单元测试 **152 个**（systemd / journal / docker / nginx 解析、安全层校验、项目与部署 CRUD、迁移）
- [x] 前端测试 **52 个**（新增 `ops-api.test.ts` 覆盖 `projectSteps` / `priorityLabel` / `deployStatusLabel`）
- [x] `pnpm test`、`pnpm build`、`cargo fmt --check`、`cargo check --all-targets`、`cargo test`、`cargo build` 全部通过

### 本阶段明确不做

进程终止（`kill` 类操作）、AI 能力、镜像拉取 / 容器创建（需要交互式参数与进度，留待后续）、编排（compose / swarm）。

---

## 🔐 安全模型

1. React 只提交 `credential_id`（如需创建才提交一次明文，随后即丢弃）。
1-bis. **React 永远不提交命令字符串**：管理类操作只传结构化标识（单元名、容器名、路径、项目 id），由 `src-tauri/src/safe.rs` 翻译成固定命令。
2. Rust 从 Keyring 读取密码 / 私钥 / 私钥口令。
3. Rust 建立 SSH 连接，前端只接收终端输出。
4. 主机指纹未确认或发生变化时连接被拒绝，需用户显式确认。
5. 在主机指纹被信任之前，**不会发送任何凭据**——握手阶段就中止，避免把密码交给不受信任的主机。
6. `tauri.conf.json` 已启用 CSP，禁止外部脚本与网络访问。

---

## 🚫 数据真实性约定

这个项目有一条硬性规则：**Mock 数据不得伪装成真实状态**。

- `src/` 中不存在任何种子数据、示例数据或硬编码指标。空列表就是“用户还没有创建任何东西”。
- 每个数字都必须能追到来源：状态栏的会话数来自 `session-store`，服务器/凭据/已知主机计数来自 SQLite。
- 未实现的模块（AI 等）在 UI 中明确显示“未实现”，不展示占位假数据。
- P3 模块同样遵守：Docker 不可用时显示原因而不是空列表；日志读不到时说明可能的原因；Nginx 找不到站点时说明查过哪两个目录。空列表只在**确实是空的**时候出现。
- 监控也遵守同一条规则：CPU 使用率与网速是**两次采样的差值**，第一次采集会真的再读一次 `/proc/stat`（间隔 200ms）而不是先填个 0；读不到的值显示 `—`，趋势图点数不足时显示“等待第二次采集”，不支持的系统直接给出原因。
- 曾经存在一套与数据库模型并行的旧 domain 类型（`src/stores/domain/`，含 Docker/Nginx/部署等），已整目录删除——它与 `ServerRecord` 字段命名冲突，且无人引用，留着只会误导后续开发。

---

## 🤝 贡献指南

提交 PR 前：

1. `pnpm build`（含 `tsc` 类型检查）
2. `cd src-tauri && cargo check --all-targets && cargo test`
3. CI 全绿

Commit 规范：`feat` / `fix` / `refactor` / `chore` / `docs` / `style` / `test`。

---

## 📄 许可证

MIT License
