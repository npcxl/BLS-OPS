# BLS-OPS 长期记忆

## 项目定位
Tauri 2 + React 19 + Rust 的桌面 SSH 运维工具（Windows 为主）。当前阶段：**P0 = 做成真正的 SSH 工具**。

## 硬性约定（验收标准）
1. **禁止 Mock 数据伪装成真实状态**。未实现的功能必须显示“未实现”，不能展示假的连接状态、假的指标、假的进度。
2. **密码/私钥永不回传前端**。前端只提交 `credential_id`；Rust 从系统 Keyring 读取密钥后直接建立 SSH。因此不存在 `credential_get_secret` 命令。
3. **Host Key 必须人工确认**。首次连接与指纹变更都要弹窗，且未确认时连接不成立（不能返回“已连接”）。
4. 在 P0 验收通过前**暂停**：Docker、Nginx、部署、项目、文件、AI 模块。
5. 凭据的“私钥 + 私钥口令”是一组配置，不是互斥类型。

## 技术要点
- SSH 用 `russh 0.63`，默认 `check_server_key` 拒绝所有键，必须实现。
- KeepAlive 用 `client::Config.keepalive_interval` + `Handle::send_keepalive`。
- ProxyJump：`Handle::channel_open_direct_tcpip(...)` → `Channel::into_stream()` → `client::connect_stream(...)`；跳板机 handle 必须保活，否则通道被丢弃。
- Tauri 命令参数：Rust 用 snake_case，JS 侧自动对应 lowerCamelCase（tauri-macros 默认 Camel）。返回值字段保持 Rust 的 snake_case。
- SQLite 迁移用 `PRAGMA user_version`，幂等 `ALTER TABLE ADD COLUMN`。

## 开发/验证命令
```bash
pnpm build                                   # tsc + vite build
cd src-tauri && cargo check --all-targets
cd src-tauri && cargo test
cargo build && ./target/debug/ops-workbench.exe   # 冒烟：窗口标题 BLS-OPS
```

## 已知历史问题
- Windows `0xc0000139`：Cargo.lock 中无 openssl-sys / libgit2-sys / libssh2-sys 等需外部 DLL 的依赖（SSH 走 rustls/ring，SQLite 为 bundled），本机构建产物可正常启动。若复现，优先排查 PATH 中第三方 OpenSSL / Git for Windows 的 DLL 冲突。
- `main.tsx` 不启用 StrictMode：双次挂载效应会打断真实 SSH 连接。
