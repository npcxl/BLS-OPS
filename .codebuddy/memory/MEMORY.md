# BLS-OPS 长期记忆

## 项目定位
Tauri 2 + React 19 + Rust 的桌面 SSH 运维工具（Windows 为主）。当前阶段：**P0 = 做成真正的 SSH 工具**。

## 硬性约定（验收标准）
0. **`src/main.tsx` 不能用 React.StrictMode**。双次挂载 effect 会让 SSH 建连后立刻被 `ssh_disconnect` 拆掉再重连。此改动已被提交 ef4c9fe 覆盖过一次，若再次发现 StrictMode 请移除。
1. **禁止 Mock 数据伪装成真实状态**。未实现的功能必须显示“未实现”，不能展示假的连接状态、假的指标、假的进度。
2. **禁止“假状态字段”**。例如已删除的 `WorkspaceTab.connected`：只被写成 `false`、从不被写 `true`，会让 UI 出现假的已连接指示。连接状态一律从 `session-store` 读。
3. **只保留一套 domain 模型**。DB 记录类型在 `src/api/ops-api.ts`（snake_case，与 Rust 一致）。旧的 `src/stores/domain/`（camelCase，含暂停模块类型）已删除——不要再加回来。
2. **密码/私钥永不回传前端**。前端只提交 `credential_id`；Rust 从系统 Keyring 读取密钥后直接建立 SSH。因此不存在 `credential_get_secret` 命令。
3. **Host Key 必须人工确认**。首次连接与指纹变更都要弹窗，且未确认时连接不成立（不能返回“已连接”）。
4. 在 P0 验收通过前**暂停**：Docker、Nginx、部署、项目、文件、AI 模块。
5. 凭据的“私钥 + 私钥口令”是一组配置，不是互斥类型。

## 监控模块约定（阶段：服务器状态监控）
- 监控命令是 `monitor.rs` 里的**固定常量表**；Tauri 命令只收 `sessionId`，前端无法传 shell 字符串。
- 监控**绝不走 PTY**：每条命令开自己的 exec channel，读完 exit-status+eof 就 `channel.close()`，超时/取消也关。
- `SshSession.writer` 是 `Mutex<Option<SessionWriter>>`：`Some` = 交互终端，`None` = 监控等非交互会话（`connect_command` 用 0×0 建立）。`ssh_input` / `ssh_resize` 对 `None` 明确报错。
- 会话级取消信号：`SshSession.closed: watch::Sender<bool>`，`shutdown()` 里 `send(true)`，在途命令通过 `timed()` 的 `select!` 立即失败。
- 速率（CPU%、网速）必须是两次采样的差值；首次采集额外隔 200ms 再读一次，禁止用 0 占位。
- 不支持的操作系统：`monitor_snapshot` 返回 `supported:false` + 原因且指标列表为空；单个 collector 返回 Err。禁止返回「零值指标」。

## 技术要点
- Workbench 布局约定：终端/服务器模块走左侧 `ContextSidebar`（服务器列表，`openModuleTab` 对 `ssh`/`servers` 只切换 `activeModule`，不开页签）；设置等其他模块走 `ModulePage` 居中页签。
- SSH 用 `russh 0.63`，默认 `check_server_key` 拒绝所有键，必须实现。
- KeepAlive 用 `client::Config.keepalive_interval` + `Handle::send_keepalive`。
- ProxyJump：`Handle::channel_open_direct_tcpip(...)` → `Channel::into_stream()` → `client::connect_stream(...)`；跳板机 handle 必须保活，否则通道被丢弃。
- Tauri 命令参数：Rust 用 snake_case，JS 侧自动对应 lowerCamelCase（tauri-macros 默认 Camel）。返回值字段保持 Rust 的 snake_case。
- SQLite 迁移用 `PRAGMA user_version`，幂等 `ALTER TABLE ADD COLUMN`。

## 开发/验证命令
```bash
pnpm build                                   # tsc + vite build
cd src-tauri && cargo fmt --all -- --check   # CI 有门禁
cd src-tauri && cargo check --all-targets
cd src-tauri && cargo test --all-targets     # 26 单元 + 10 端到端
cargo build && ./target/debug/ops-workbench.exe   # 冒烟：窗口标题 BLS-OPS
```

## CI 无状态检查的排查
`.github/workflows/ci.yml` 已在版本控制中。若提交右侧没有状态检查，**先查该 commit 是否已 push 到 origin**（`git status -sb`）。GitHub 只对已推送的 commit 运行 workflow——ef4c9fe 就是因为未推送而"没有任何 CI 记录"。

## 端到端测试要点
`src-tauri/tests/ssh_e2e.rs` 用 russh server 起进程内真实 SSH 服务端（`src-tauri/src/lib.rs` 的 `ssh` 模块为此 `pub`）。
测试服务端易踩的坑：`Handler::data` 对 **direct-tcpip 隧道通道也会触发**，必须用 `HashSet<ChannelId>` 记录隧道通道并跳过回显，否则会往隧道注入数据污染内层 SSH 流。

## 已知历史问题
- Windows `0xc0000139`：Cargo.lock 中无 openssl-sys / libgit2-sys / libssh2-sys 等需外部 DLL 的依赖（SSH 走 rustls/ring，SQLite 为 bundled），本机构建产物可正常启动。若复现，优先排查 PATH 中第三方 OpenSSL / Git for Windows 的 DLL 冲突。
- `main.tsx` 不启用 StrictMode：双次挂载效应会打断真实 SSH 连接。
