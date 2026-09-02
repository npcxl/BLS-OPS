# BLS-OPS 长期记忆

## 项目定位
Tauri 2 + React 19 + Rust 的桌面 SSH 运维工具（Windows 为主）。当前阶段：**P0 = 做成真正的 SSH 工具**。

## 硬性约定（验收标准）
- **`src/main.tsx` 禁止 React.StrictMode**：双挂载会让 SSH 建连后被 `ssh_disconnect` 拆掉再重连（提交 ef4c9fe 修过一次，复发即移除）。
- **禁止 Mock 数据伪装真实状态**：未实现就显示"未实现"，不给假连接状态/假指标/假进度。
- **禁止"假状态字段"**：如已删除的 `WorkspaceTab.connected`（只写 false 从不写 true）。连接状态一律从 `session-store` 读。
- **只保留一套 domain 模型**：DB 记录类型在 `src/api/ops-api.ts`（snake_case，与 Rust 一致）；旧 `src/stores/domain/`（camelCase）已删，勿加回。
- **密码/私钥永不回传前端**：前端只提交 `credential_id`，Rust 从系统 Keyring 读密钥直连；不存在 `credential_get_secret` 命令。凭据的"私钥+私钥口令"是一组配置，非互斥类型。
- **Host Key 必须人工确认**：首次连接与指纹变更都弹窗，未确认连接不成立。

## 监控模块（P2 已完成）
- 命令是 `monitor.rs` 固定常量表；Tauri 命令只收 `sessionId`，前端传不了 shell 字符串。
- 监控**绝不走 PTY**：每条命令独立 exec channel，读完 exit-status+eof 即 close；`SshSession.writer` 为 `Mutex<Option<SessionWriter>>`，`None`=非交互会话，`ssh_input`/`ssh_resize` 对 None 报错。
- 会话取消：`SshSession.closed: watch::Sender<bool>`，`shutdown()` send(true) 使在途命令经 `timed()` 的 select! 立即失败。
- 存活双信号：`dead: Arc<AtomicBool>`（disconnected 回调置位）+ `handle.is_closed()`。exec channel_open 失败只在 `SendError|Disconnect|HUP`（或 handle 已关）时算断开；`ChannelOpenFailure`/预算超时/解析错误都不算。
- 死会话在 `get()`/`is_connected()`/`active_count()` 查表时即时移除；`connect_with` 重连前 remove+shutdown 旧会话；`ssh_connect_monitor` 开头 `monitor.forget(sessionId)`。
- 速率（CPU%、网速）必须是两次采样差值；首次采集隔 200ms 再读一次，禁止 0 占位。重连必须 forget 基线。
- 历史窗口 `maxSamplesFor = ceil(30min / intervalMs)`（2s→900/5s→360/30s→60）。
- 不支持的 OS：`monitor_snapshot` 返回 `supported:false`+原因+空指标；禁止零值指标。

## UI 组件约定
- 右键菜单统一 `components/ui/context-menu.tsx` 的 `useContextMenu()`；`pointerdown` 不关菜单（防闪），`contextmenu` bubble 阶段靠 `defaultPrevented` 判断新菜单。
- 破坏性操作统一 `components/ui/confirm-dialog.tsx`，不用 `window.confirm`/手拼 Modal。
- 长列表行必须 memo + 稳定回调；Tauri 拖拽 `over` 高频事件用 ref 短路再 setState。
- lucide-react v1.x：`AlertTriangle`→`TriangleAlert`，`Loader`→`LoaderCircle`。
- 上传必须同时有点击入口（`tauri-plugin-dialog` 的 `open()`）和拖拽入口。
- P3 模块框架 `ModuleFrame`（`module-frame.tsx`）：顶部工具栏**不放常驻连接状态角标**（已连接/未连接等已在 2026-09-02 按用户要求删除）；连接异常/断开用横幅（connecting/error/closed）提示。模块页用 `useCommandSession(tab)`（非交互，无 PTY）+ tab 类型在 `workbench-store` 的 `MODULE_TAB_TYPES` 注册。
- Workbench 布局：终端/服务器模块走左侧 `ContextSidebar`（`openModuleTab` 对 `ssh`/`servers` 只切 `activeModule` 不开页签）；其他模块走 `ModulePage` 居中页签。

## P3 管理模块（2026-09-01 用户确认修订版）
- **核心**：先识别服务器系统/能力，再按需启用可选适配器；Docker/Nginx/systemd 等只是检测到才启用的适配器，不是固定预设。P0 最高优先级；Docker/Nginx **写操作**属 P4（未实现，前端只读占位）；文件、AI 模块仍暂停。
- 流程：P3.1 OS/权限/磁盘/安全 → P3.2 运行时/构建/包管理 → P3.3 部署方式与服务能力（包管理/systemd/容器/网关/中间件）→ P3.4 按真实能力启用收集器（未安装的组件绝不跑其探测命令）→ P3.5~7 端口反查→受控文件扫描→证据合并评分 → P3.8 部署准备度 → P3.9 用户确认输出给 P4。
- 适配器注册制：`DeploymentAdapter { id, displayName, supportedSystems, detect(), collectEvidence(), assessReadiness(), supportedOperations(), rollbackCapabilities() }`，第一批含静态文件/二进制/JAR/Node/Python/systemd/PM2/Supervisor/Docker/Compose/Podman/Nginx/Apache/Caddy/K8s。未知服务显示"暂无匹配适配器"，禁止猜测。
- 三张图谱：服务器能力图谱、项目证据图谱、部署可行性图谱。
- 代码处置：只读探测保留在 P3；docker build/stop、systemd 操作、nginx reload、部署/文件修改/回滚移入 P4；`docker_prune` 禁用（违背软删除）。**项目发现已是"部署实例优先"**（2026-09-02 重构）：能力识别 → `deployment_collector.rs` 按能力枚举真实实例（docker inspect 提取 Compose/Mounts/端口；systemctl show 提取 WorkingDirectory/ExecStart；nginx -T + ss→/proc/PID/cwd）→ 实例路径定向 marker 扫描 → 固定根补充扫描（`ProjectMarkerScan`，只搜项目标志不枚举普通文件）。旧的 find 全量 2 万文件命令已删。实例无宿主线索时 `source_known=false`（"源码未知"），绝不伪造路径；`ProjectCandidate.category` = deployed/source_only。
- 安全边界：`src-tauri/src/safe.rs` 的 `Capability` 枚举是唯一"动作→命令字符串"翻译点，禁止别处拼命令；前端只传结构化标识；校验在网络 I/O 之前（`remote::run_on_linux`，先 `capability.command()?` 再 OS 探测）。部署步骤三重校验（白名单+禁 shell 操作符+路径在 deploy_path 内），`deployment_execute` 只收 projectId 且步骤从 DB 读后重校验。改服务端状态必须有 ConfirmDialog；Nginx 先 `nginx -t` 再 reload。「不可用」≠「空」，要给原因。
- e2e：`tests/p3_e2e.rs` 记录每条命令并断言被拒参数一条都没发出。

## 技术要点
- SSH 用 `russh 0.63`，默认 `check_server_key` 拒绝所有键，必须实现；KeepAlive 用 `client::Config.keepalive_interval` + `Handle::send_keepalive`。
- ProxyJump：`Handle::channel_open_direct_tcpip(...)` → `Channel::into_stream()` → `client::connect_stream(...)`；跳板机 handle 必须保活否则通道被丢。
- Tauri 命令参数：Rust snake_case ↔ JS lowerCamelCase 自动映射；返回值保持 Rust snake_case。
- SQLite 迁移用 `PRAGMA user_version`，幂等 `ALTER TABLE ADD COLUMN`。

## 开发/验证命令
```bash
pnpm build                                   # tsc + vite build
cd src-tauri && cargo fmt --all -- --check   # CI 有门禁
cd src-tauri && cargo check --all-targets
cd src-tauri && cargo test --all-targets     # 26 单元 + 10 端到端
cargo build && ./target/debug/ops-workbench.exe   # 冒烟：窗口标题 BLS-OPS
```

## CI / e2e
- CI 无状态检查先查 commit 是否已 push（GitHub 只对已推送 commit 跑 workflow）。
- `tests/ssh_e2e.rs` 用 russh server 起进程内真实 SSH 服务端（`lib.rs` 的 `ssh` 模块为此 `pub`）。坑：`Handler::data` 对 direct-tcpip 隧道通道也触发，必须用 `HashSet<ChannelId>` 跳过隧道通道回显。

## 已知历史问题
- Windows `0xc0000139`：Cargo.lock 无 openssl-sys/libgit2-sys 等外部 DLL 依赖（SSH 走 rustls/ring，SQLite bundled）；复现先查 PATH 第三方 OpenSSL/Git DLL 冲突。
- **xterm IME 被破坏的根因（2026-09-01）**：`globals.css` 里 `.xterm *` 加 `user-select` 会破坏 IME composition 层级（中文直接上屏）。**结论：`globals.css` 禁止给 `.xterm`/`.xterm *` 加任何 user-select 规则**。键盘问题先查 CSS user-select/pointer-events/inert，别改 TerminalView。
- **终端"输不了"的元凶（2026-09-01 确诊）**：非活动 tab 的隐藏按钮锁住焦点（`absolute inset-0` + `aria-hidden` 容器吞键盘）。修复：`WorkbenchPane` 非活动 tab 加 `inert={!active}`（React 19 boolean 写法；**严禁 `inert=""`**，会被当 false 并告警）。诊断：`document.activeElement` 应为 `xterm-helper-textarea`。
