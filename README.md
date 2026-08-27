# 运维工作台 (BLS-OPS)

> **BLS-OPS** — 基于 Tauri + React + Rust 的现代桌面 SSH 运维工具。

---

## 📌 项目概述

**产品定位**：面向运维/开发人员的本地 SSH 会话管理工具，以“SSH First”为核心设计理念，后续扩展 Docker、Nginx、部署、AI 等模块。

**技术栈**：

| 层级 | 技术 | 说明 |
|------|------|------|
| 前端 | React 19 + TypeScript + Tailwind CSS v4 | UI 工作台外壳 |
| 后端 | Rust + Tauri 2 | 桌面应用框架 |
| 数据库 | rusqlite + SQLite | 本地数据存储 |
| SSH | russh | SSH 协议实现 |
| 终端 | xterm.js (计划中) | Web 终端模拟器 |

**当前版本**：`v0.1.0`（UI 外壳完成，IPC + SSH 正在开发中）

---

## 🚀 快速开始

### 前置要求

| 环境 | 版本 | 说明 |
|------|------|------|
| 操作系统 | Windows 10/11 | 主要开发环境 |
| Node.js | ≥ 18 | pnpm 推荐 |
| Rust | ≥ 1.70 | MSVC 工具链（Visual Studio Build Tools）|
| WebView2 | 自动安装 | Tauri 依赖 |

### 安装依赖

```bash
# 前端依赖
pnpm install

# Rust 依赖（如已安装，跳过）
# 通过 rustup 安装：https://rustup.rs
rustup default stable
```

### 运行开发模式

```bash
# 方式 1：直接启动（首次可能需要 2-5 分钟编译 Rust 依赖）
pnpm tauri dev

# 方式 2：分步验证
pnpm build          # 前端构建
cd src-tauri
cargo check         # Rust 代码检查
cd ..
pnpm tauri dev    # 启动应用
```

### 构建发布版本

```bash
pnpm tauri build
# 输出：src-tauri/target/release/bundle/msi/
```

---

## 🏗️ 实现进度

| 模块 | 状态 | 说明 |
|------|------|------|
| **UI 工作台外壳** | ✅ 已完成 | 导航栏、侧边栏、Tab、分屏、状态栏、命令面板、主题 |
| **SQLite Schema** | ✅ 已完成 | 服务器、凭据、known_hosts、会话、命令历史、审计日志等表 |
| **Server CRUD (Rust)** | ✅ 已完成 | db.rs 有完整 CRUD 函数，但未通过 IPC 暴露 |
| **Tauri IPC** | 🚧 开发中 | 正在实现 `#[tauri::command]` 与前端 `invoke()` |
| **真实 SSH 连接** | ❌ 未开始 | russh 已安装，Session Manager 待实现 |
| **xterm.js 终端** | ❌ 未开始 | 依赖待安装，流式输出待实现 |
| **凭据安全 (Keyring)** | ❌ 未开始 | SQLite 只存 secret_ref，密码/私钥需接入系统 Keyring |
| **Docker/Nginx/部署/AI** | ❌ 未开始 | 类型定义与占位页面已完成 |
| **测试/CI** | ❌ 未开始 | 无单元测试、无 GitHub Actions |

### 当前分支状态

```
pnpm build     ✅ 通过
cargo check    ✅ 通过（27 个 dead_code 警告，IPC 未接入导致）
pnpm tauri dev ⚠️ 可能报 0xc0000139（WebView2/依赖问题，待调试）
```

---

## 📁 项目结构

```
BLS-OPS/
├── src/                          # 前端 (React + TS)
│   ├── workbench/                # 工作台核心模块
│   │   ├── views/               # 视图：TerminalView、WorkbenchHome、PlaceholderView
│   │   ├── AppTopBar.tsx        # 顶部栏
│   │   ├── NavigationRail.tsx   # 导航栏
│   │   ├── ContextSidebar.tsx   # 上下文侧边栏
│   │   ├── StatusBar.tsx        # 状态栏
│   │   ├── WorkspaceTabs.tsx    # 标签栏
│   │   ├── WorkbenchPane.tsx    # 分屏面板
│   │   └── command-palette.tsx  # 命令面板
│   ├── stores/                   # Zustand 状态管理
│   │   └── workbench-store.ts   # 工作台状态（Tab、Pane、分屏）
│   └── app/
│       └── app-meta.ts          # 应用元信息
│
├── src-tauri/                    # 后端 (Rust + Tauri)
│   ├── src/
│   │   ├── lib.rs              # Tauri 入口
│   │   ├── main.rs             # 应用入口
│   │   ├── db.rs               # SQLite 数据库层（CRUD 函数）
│   │   └── state.rs            # 应用状态（AppState）
│   └── tauri.conf.json         # Tauri 配置
│
├── docs/                        # 文档（计划中）
│   ├── PRODUCT_ARCHITECTURE.md  # 产品与后端架构
│   ├── UI_TECHNICAL_SPEC.md     # UI 与交互规范
│   ├── IMPLEMENTATION_STATUS.md # 实施进度追踪
│   ├── IPC_CONTRACT.md          # IPC 接口契约
│   ├── DEVELOPMENT.md           # 开发指南
│   └── archive/                 # 归档文档
│       └── rust-react-devops-architecture-v2.md
│
├── modern-ssh-devops-architecture-v3.md    # 产品/后端主架构文档
├── modern-ssh-ui-rust-full-solution.md     # UI/交互/前后端规范
└── rust-react-devops-architecture-v2.md     # 旧版 DevOps 方案（待归档）
```

---

## 📖 核心文档

| 文档 | 定位 | 状态 |
|------|------|------|
| [PRODUCT_ARCHITECTURE.md](./docs/PRODUCT_ARCHITECTURE.md) | 产品与后端领域架构 | 📝 待创建 |
| [UI_TECHNICAL_SPEC.md](./docs/UI_TECHNICAL_SPEC.md) | UI、交互与前后端实现规范 | 📝 待创建 |
| [IMPLEMENTATION_STATUS.md](./docs/IMPLEMENTATION_STATUS.md) | 模块实施进度追踪 | 📝 待创建 |
| [IPC_CONTRACT.md](./docs/IPC_CONTRACT.md) | 前后端通信接口契约 | 📝 待创建 |
| [DEVELOPMENT.md](./docs/DEVELOPMENT.md) | 本地开发、调试指南 | 📝 待创建 |
| [modern-ssh-devops-architecture-v3.md](./modern-ssh-devops-architecture-v3.md) | **当前主架构文档** | ✅ 已存在 |
| [modern-ssh-ui-rust-full-solution.md](./modern-ssh-ui-rust-full-solution.md) | **UI/交互规范** | ✅ 已存在 |

---

## 🔌 IPC 接口契约（开发中）

| Command | 描述 | 状态 |
|---------|------|------|
| `server_list` | 获取服务器列表 | 🚧 开发中 |
| `server_get` | 获取单个服务器 | 🚧 开发中 |
| `server_save` | 保存/更新服务器 | 🚧 开发中 |
| `server_delete` | 删除服务器 | 🚧 开发中 |
| `credential_list` | 获取凭据列表 | 🚧 开发中 |
| `credential_save` | 保存/更新凭据 | 🚧 开发中 |
| `credential_delete` | 删除凭据 | 🚧 开发中 |
| `known_host_list` | 获取已知主机列表 | 🚧 开发中 |
| `ssh_connect` | 建立 SSH 连接 | ❌ 未开始 |
| `ssh_disconnect` | 断开 SSH 连接 | ❌ 未开始 |
| `ssh_send_command` | 发送命令 | ❌ 未开始 |

---

## 🤝 贡献指南

### 提交 PR 前

1. 确保 `pnpm build` 通过
2. 确保 `cargo check` 通过
3. 确保 `pnpm lint` 通过（如配置）
4. 提交前运行 `git cl` 或类似工具检查代码格式

### Commit 规范

```
feat: 新功能
fix: Bug 修复
refactor: 代码重构
chore: 构建/依赖/配置变更
docs: 文档更新
style: 代码格式（不影响逻辑）
test: 测试相关
```

---

## 📄 许可证

MIT License

---

## 📞 联系方式

- GitHub: [npcxl/BLS-OPS](https://github.com/npcxl/BLS-OPS)
