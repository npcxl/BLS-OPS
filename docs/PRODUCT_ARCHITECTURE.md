# 产品与后端架构

## 定位

BLS-OPS 是 Windows 优先的本地 SSH 运维工作台，路线遵循 SSH First。桌面 UI 使用 React，原生能力使用 Tauri 2 + Rust，持久化使用 SQLite。

## 分层

- **React UI**：导航、服务器列表、标签页、终端呈现和交互状态。
- **前端 API**：集中封装 Tauri `invoke`，组件不直接调用 IPC。
- **Tauri Commands**：参数校验、状态访问和错误转换。
- **领域服务**：Server、Credential、Known Host、SSH Session Manager、Monitor（只读 Linux 指标：固定命令表 + exec 通道 + 速率基线）。
- **SQLite**：保存服务器元数据、引用和历史；绝不保存凭据明文。
- **系统安全存储**：保存密码、私钥和私钥口令，后续接入 Windows Credential Manager。

## 实施原则

1. 先完成 Windows 启动基线和 Server CRUD 闭环。
2. SSH 连接、Host Key 校验和终端流式输出优先于 Docker、Nginx、部署和 AI。
3. UI 的 Mock 数据只能用于占位，不得伪装成真实连接状态。
4. 所有跨层数据结构必须在 `docs/IPC_CONTRACT.md` 中登记。

## 当前主文档

根目录的 `modern-ssh-devops-architecture-v3.md` 是产品/后端主架构；`modern-ssh-ui-rust-full-solution.md` 是 UI 和交互规范。旧 v2 方案已归档。
