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
| **SQLite Schema + 迁移** | ✅ | `user_version` 驱动的幂等迁移（`db::migrate`），含 v1→v2 升级 |
| **服务器 CRUD** | ✅ | 新增 / 列表 / **编辑** / 删除（级联清理会话与命令历史） |
| **服务器分组** | ✅ | `server_groups` 表 + 侧边栏分组树：新增、**重命名**、**删除**（解除服务器引用）、折叠 |
| **标签 / 收藏** | ✅ | 服务器标签与收藏开关，首页与侧边栏同步 |
| **凭据 CRUD + 编辑** | ✅ | 密码、私钥、**私钥+口令**；密钥存系统 Keyring |
| **凭据 ↔ 服务器绑定** | ✅ | 服务器表单选择凭据；删除凭据前统计引用并解除绑定 |
| **Known Hosts** | ✅ | 列表、删除、首次连接确认、指纹变更拦截 |
| **真实 SSH 会话** | ✅ | `SshSessionManager`：密码 / 私钥 / 私钥口令 / ProxyJump |
| **终端** | ✅ | xterm.js 输入输出、Resize、断开、重连、KeepAlive、查找 |
| **远程文件浏览器** | ✅ | 独立 SFTP subsystem 通道（复用最终目标连接，兼容 ProxyJump）；面包屑/后退/前进/上一级/刷新；**重命名、副本、删除（递归）、新建文件夹/文件**；**本地拖拽上传**（文件与文件夹递归，落在当前目录）；**跟随终端 `cd` 联动**；右侧面板默认展开、可拖宽、可折叠 |
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
| **Rust 单元测试** | ✅ | 31 个（目标解析、主机密钥信任矩阵、POSIX 路径、自然排序、迁移、级联删除、Known Hosts、服务器校验、会话记录） |
| **SSH 端到端测试** | ✅ | 24 个，进程内真实 SSH 服务端：握手、信任、密码认证、双跳 ProxyJump、优雅断开、SFTP 浏览、文件管理（删除/重命名/副本/mkdir/上传）、编辑器读写往返、二进制识别 |
| **前端测试** | ✅ | vitest + happy-dom：Modal 退出动画遮罩回收、中途重开取消卸载、文件类型识别（扩展名/点文件/大小写/未知类型） |
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
│   │   └── session-store.ts      # 实时会话状态与 Host Key 挑战
│   ├── workbench/
│   │   ├── views/               # WorkbenchHome、TerminalView、PlaceholderView
│   │   ├── host-key-dialog.tsx  # Host Key 确认弹窗 + 已知主机面板
│   │   ├── ssh-context-sidebar.tsx      # 服务器列表 / 编辑表单
│   │   ├── settings-context-sidebar.tsx # 凭据 / 已知主机 / 运行环境
│   │   └── StatusBar.tsx         # 真实会话数与实体计数
│   └── hooks/                    # 全局快捷键、窗口边缘拖拽、表单提交守卫
│
├── src-tauri/src/
│   ├── lib.rs              # Tauri 入口与命令注册
│   ├── db.rs               # Schema、迁移、CRUD、单元测试
│   ├── ssh.rs              # SshSessionManager：认证、Host Key、KeepAlive、ProxyJump
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

### 会话与 SSH

| Command | 说明 |
|---------|------|
| `ssh_connect` | 建立会话；支持 `serverId` 或 `target`（`user@host:port`）+ `credentialId`，或 `password`（一次性密码，仅本次使用，不落盘） |
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
pnpm test                  # 前端测试（vitest + happy-dom）
cd src-tauri
cargo test                 # 31 单元测试 + 17 端到端测试
cargo test --test ssh_e2e  # 只跑端到端
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

### 人工验收步骤（真实环境）

1. `pnpm tauri dev` 启动，确认无 `0xc0000139`；
2. 新建密码凭据 + 服务器，首次连接：先点**拒绝**（连接应失败），再连接并**信任**；
3. 执行 `pwd`、`ls`、`echo test`，检查输出正常；
4. 缩放窗口，确认终端跟随 Resize；断开 → 重连；
5. 重启应用，确认服务器、凭据、历史仍在；
6. 私钥与带口令私钥各测一次；
7. 手动改动服务器指纹（如重新生成主机密钥），确认出现强警告；
8. **文件浏览**：连接后右侧面板默认展开，显示 Home 目录；双击文件夹进入、点面包屑跳转、`Backspace` 上一级、`Enter` 打开选中项、拖动左边缘调整宽度、折叠后从工具栏恢复；找一个无权限目录（如 `/root` 普通用户），确认显示“权限不足”且应用不崩；
9. **文件操作**：单击文件 → 顶部出现操作条（打开/重命名/副本/删除）；或右键同名菜单。新建文件夹/文件弹出 Modal（输入空名或带 `/` 会被拦截）；删除有确认；
10. **文本编辑**：双击 `.sql`/`.conf`/`.js`/`.java` 等文件 → 弹出带语法高亮的编辑器，修改后 Ctrl+S 保存，列表大小刷新；双击 `.pdf`/`.xlsx`/`.png` 显示“暂不支持打开”的提示条；`.bin`（含 NUL）拒绝编辑并说明是二进制；
11. **拖拽上传**：从资源管理器拖文件/文件夹到面板 → 显示高亮提示，松手后上传到当前目录，完成后列表自动刷新；
12. **cd 联动**：在终端执行 `cd /var/log`，右侧面板自动跳到该目录；`cd`、`cd ~`、`cd ..`、`cd -` 均生效；
13. **ProxyJump**：经跳板机连接后打开文件面板，确认看到的是**目标服务器**的目录（对照 `ls /home` 输出）；
14. 断开连接后文件面板应显示“连接已断开”。

---

## 🔐 安全模型

1. React 只提交 `credential_id`（如需创建才提交一次明文，随后即丢弃）。
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
- 未实现的模块（文件、容器、网关、项目、部署、AI）在 UI 中明确显示“未实现”，不展示占位假数据。
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
