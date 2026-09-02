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
4. **P3 已按修订方案重做**（用户 2026-09-01 明确"按照这个重做"）：P3 不再从 Docker/Nginx 固设开始，改为"能力识别前置 + 适配器按需启用"。P0 仍是最高优先级；Docker/Nginx 的**写操作**仍属 P4（未实现，前端为只读/占位）。其余（文件、AI 模块）仍暂停。
5. 凭据的“私钥 + 私钥口令”是一组配置，不是互斥类型。

## 监控模块约定（阶段：服务器状态监控——**P2 正式完成**）
- 监控命令是 `monitor.rs` 里的**固定常量表**；Tauri 命令只收 `sessionId`，前端无法传 shell 字符串。
- 监控**绝不走 PTY**：每条命令开自己的 exec channel，读完 exit-status+eof 就 `channel.close()`，超时/取消也关。
- `SshSession.writer` 是 `Mutex<Option<SessionWriter>>`：`Some` = 交互终端，`None` = 监控等非交互会话（`connect_command` 用 0×0 建立）。`ssh_input` / `ssh_resize` 对 `None` 明确报错。
- 会话级取消信号：`SshSession.closed: watch::Sender<bool>`，`shutdown()` 里 `send(true)`，在途命令通过 `timed()` 的 `select!` 立即失败。
- **存活状态是双信号**：`SshSession.dead: Arc<AtomicBool>`（与该 hop 的 ClientHandler 共享，`disconnected` 回调置位）+ `handle.is_closed()`；`is_alive()` 两者都查。exec 的 channel_open 失败只在 `SendError|Disconnect|HUP`（或 handle 已关）时标记——`ChannelOpenFailure` 与预算超时都不算断开，普通命令解析错误永远不算。
- 死会话由 `get()` / `is_connected()` / `active_count()` 在查表时即时移除；`connect_with` 重连前先 remove+shutdown 旧会话；`ssh_connect_monitor` 开头 `monitor.forget(sessionId)`。
- 速率（CPU%、网速）必须是两次采样的差值；首次采集额外隔 200ms 再读一次，禁止用 0 占位。同 sessionId 重连必须 forget 基线。
- 历史窗口样本上限按间隔动态算 `maxSamplesFor = ceil(30min / intervalMs)`（2s→900 / 5s→360 / 30s→60），时间过滤同时保留。
- 不支持的操作系统：`monitor_snapshot` 返回 `supported:false` + 原因且指标列表为空；单个 collector 返回 Err。禁止返回「零值指标」。

## UI 组件约定
- **右键菜单统一用 `components/ui/context-menu.tsx` 的 `useContextMenu()`**，不要手写浮动菜单。用法：`const menu = useContextMenu(); <div onContextMenu={menu.onContextMenu(() => items)} /><ContextMenu {...menu.props} />`
  - 关键：右键的 `pointerdown` 不能关闭菜单（否则 `contextmenu` 重开时会闪），`contextmenu` 用 bubble 阶段靠 `defaultPrevented` 判断是否有新菜单。
- 删除等破坏性操作统一走 `components/ui/confirm-dialog.tsx`，不用 `window.confirm`，也不要自己拼 `Modal`。
- 长列表（文件列表）的行必须 `memo` 化且回调引用稳定；高频事件（Tauri 拖拽 `over`）要用 ref 短路后再 setState。
- lucide-react v1.x：`AlertTriangle` 已改名 `TriangleAlert`，`Loader` 改名 `LoaderCircle`。
- 上传这类操作必须同时提供**点击入口**（`tauri-plugin-dialog` 的 `open()`）和拖拽入口，拖拽不能是唯一路径。

## P3 管理模块约定 —— 已修订架构（2026-09-01 用户确认）
**核心修订**：P3 **不是从 Docker/Nginx 开始**，而是「先识别服务器系统和能力，再按需启用可选适配器」。Docker、Nginx、systemd、Caddy、Podman、K8s 等都只是**检测到安装后才启用的可选能力适配器**，不再是「服务器一定用 Docker/Nginx」的固定预设。

### P3 五层流程（修订后）
1. **P3.1 识别操作系统/权限/磁盘/安全**：Linux/Win/macOS、发行版与版本、架构、内核、init 系统、当前用户、sudo、文件系统/挂载、SELinux/AppArmor、cgroup 版本、磁盘/内存、网络与端口。
2. **P3.2 识别运行时/构建工具/包管理器**：Java/Node/Python/Go/Rust/PHP/.NET/Ruby + 版本管理器(nvm/fnm/pyenv/uv/SDKMAN/rustup)；Maven/Gradle/npm/pnpm/Cargo/pip/Composer 等。
3. **P3.3 识别部署方式与服务能力**：包管理(apt/dnf/yum/apk/pacman/zypper/brew/winget/choco)、进程服务(systemd/OpenRC/Supervisor/PM2/runit/WinSvc)、容器编排(Docker/Compose/Podman/containerd/K8s/k3s/Helm/Nomad)、网关(Nginx/Apache/Caddy/Traefik/HAProxy/IIS)、数据中间件(MySQL/PG/Redis/Mongo/ES/RabbitMQ/Kafka)。
4. **P3.4 按真实能力启用收集器**：未安装的组件**绝不执行其探测命令**（不跑 `docker ps`/`nginx -T`），避免无意义报错。输出能力图谱 JSON（os/packageManager/initSystem/runtimes/deploymentCapabilities）。
5. **P3.5~P3.7 服务端口反向发现 → 受控文件系统扫描 → 证据合并评分**：扫描优先级由 P3.3 的能力决定（如识别到 Java+Maven+systemd 则提高 pom.xml/systemd WorkingDirectory/端口证据权重）。
6. **P3.8 部署准备度与能力差距**：项目要求 vs 服务器能力 → 可直接部署 / 需安装 / 冲突 / 无法确认。
7. **P3.9 用户确认项目，输出给 P4**。

### 部署适配器注册系统（替代硬编码无限列表）
`DeploymentAdapter { id, displayName, supportedSystems, detect(), collectEvidence(), assessReadiness(), supportedOperations(), rollbackCapabilities() }`。
第一批：静态文件、原生二进制、Java JAR/WAR、Node.js、Python venv、systemd、PM2、Supervisor、Docker、Docker Compose、Podman、Nginx、Apache、Caddy、K8s/Helm。新增部署方式只加适配器，**不改动项目发现核心**。无法识别的服务显示「检测到未知运行服务，暂无匹配适配器，可看证据或手动指定」，**禁止为声称全支持而猜测**。

### P3 三张输出图谱
1. 服务器能力图谱（系统→包管理器→运行时→构建→服务管理→容器→网关→数据）。
2. 项目证据图谱（项目→文件→Git→进程→端口→服务→容器→网关）。
3. 部署可行性图谱（项目要求 ∩ 服务器能力 → 结论）。

### P3 现有代码处置（不删除，分级）
- **保留只读部分**（P3）：Docker/Nginx 的「是否安装/版本/容器列表/Compose/挂载/端口/配置/静态目录/代理端口/项目证据」等只读探测。
- **移入 P4（操作部分）**：docker build/up/stop/restart、systemd start/stop/restart、nginx 配置保存+reload、项目部署、文件修改、回滚。
- **禁止/重做**：`docker_prune` 不符合软删除原则（Volume/数据库/镜像不能被 AI 直接永久清理），应禁用。
- 现有 `src-tauri/src/project_discovery.rs` 已是「证据 + 确定性评分 + 只读」方向，需补的只是【能力识别前置 + 收集器按需启用】这两块，不必推倒重来。

### 仍适用的安全边界（保留）
- **安全边界是 `src-tauri/src/safe.rs` 的 `Capability` 枚举**：唯一把「动作」翻译成命令字符串的地方，新增动作必须在此加变体+写死模板，**禁止别处拼接命令**。
- 前端**永不传命令字符串**：只传结构化标识（单元名、容器名、路径、项目 id）。
- **校验必须在网络 I/O 之前**（用 `remote::run_on_linux`，先 `capability.command()?` 再 OS 探测）。
- 部署步骤三重校验：命令白名单 + 禁 shell 操作符 + 绝对路径须在项目 `deploy_path` 内；`deployment_execute` 只收 `projectId`，步骤从 DB 读出后**重新校验**。
- 会改服务端状态的操作必须有 `ConfirmDialog`；Nginx「先 `nginx -t` 再 reload」，失败明确告知未重载。
- 「不可用」≠「空」：Docker 没装、Nginx 无站点、journal 读不到，都要给原因。
- 新模块用 `useCommandSession(tab)`（非交互会话，无 PTY 无 shell）+ `ModuleFrame`；tab 类型需在 `workbench-store` 的 `MODULE_TAB_TYPES` 注册。
- e2e：`tests/p3_e2e.rs` 测试服务端记录每条命令，外部断言命令字符串，证明被拒参数「一条都没发出去」。

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
- **xterm 终端 IME（中文输入法）被破坏的根因（2026-09-01 定位）**：`86be7a8`（Update package dependencies and enhance UI components）这批 UI 重构在 `src/styles/globals.css` 误加了 `.xterm, .xterm *, .xterm-helper-textarea { user-select: text !important }`。其中 `.xterm *` 会**破坏 xterm 内部的 IME composition 层级**，导致中文候选词直接上屏（onData 收到形如 `都觉得` 的中文），命令内容错乱、服务器回显"都不对/不返回"。好版本 `bfbe7f7` 完全没有这段 CSS——因为 `body { user-select: none }` 之下，xterm 的 helper textarea 已被原始的 `input, textarea { user-select: text }` 覆盖，IME 本就正常。**结论：`src/styles/globals.css` 里禁止再给 `.xterm` / `.xterm *` 加任何 `user-select` 规则**；若需保护 textarea，最多只精确写 `.xterm-helper-textarea`（且通常不需要）。终端输入路径（term.open→xterm textarea→onData→sshInput）未被改动，键盘问题一律先查 CSS 的 user-select / pointer-events / inert，而非 TerminalView 逻辑。
- **终端"输入不了/完全没反应"的元凶 = 焦点被锁在非活动 tab 的隐藏按钮上（2026-09-01 确诊）**：`WorkbenchPane` 的多个 tab 都用 `absolute inset-0`（非活动的 `hidden`+`aria-hidden`）。切换 tab 后，前活动 tab 里的可聚焦元素（按钮、xterm textarea）若仍持有焦点，浏览器会把键盘锁在那个 `aria-hidden` 容器里，活动终端拿不到焦点 → 表现就是"点进去没反应/输不了"。`document.activeElement` 实测验证为 `xterm-helper-textarea` 即正常，否则是被锁的 button。**修复：`WorkbenchPane` 给非活动 tab div 加 `inert={!active}`（React 19 原生 boolean 写法）。严禁用 `inert=""` 空字符串——React 会当 false 忽略并报 "Received an empty string for a boolean attribute inert" 警告，导致 inert 完全不生效。终端/按钮聚焦问题优先查 `inert` 与焦点残留，而非重排 TerminalView 输入逻辑。**
