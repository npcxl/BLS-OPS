# BLS-OPS 长期记忆

## 项目定位
Tauri 2 + React 19 + Rust 的桌面 SSH 运维工具（Windows 为主）。阶段：P0=真 SSH 工具；P2 监控完成；P3 项目发现完成；P4 命令中心/终端接线进行中。

## 硬性约定（验收标准）
- `src/main.tsx` 禁止 React.StrictMode（双挂载会把 SSH 建连拆掉重连；ef4c9fe 修过，复发即移除）。
- 禁止 Mock 数据伪装真实状态；未实现就显示"未实现"。禁止假状态字段（如已删的 `WorkspaceTab.connected`）；连接状态一律从 session-store 读。
- 只保留一套 domain 模型：DB 类型在 `src/api/ops-api.ts`（snake_case 与 Rust 一致）；旧 `src/stores/domain/` 已删勿加回。
- 密码/私钥永不回传前端：前端只提交 `credential_id`，Rust 从 Keyring 读密钥直连；不存在 `credential_get_secret`。凭据"私钥+口令"是一组配置，非互斥类型。
- Host Key 必须人工确认（首连+指纹变更弹窗），未确认连接不成立。
- Rust→前端的 payload/返回值字段必须 camelCase（`#[serde(rename_all = "camelCase")]`）；枚举值保持 snake_case 与前端联合类型逐字一致；事件与命令共用同一结构。排查"接口正常但不渲染"先 diff 载荷字段名（教训：DirectorySizeResult 曾因此全落 `undefined::path` 坏 key）。
- 破坏性操作统一 `components/ui/confirm-dialog.tsx`（禁 window.confirm/手拼 Modal）；改服务端状态必须 ConfirmDialog；Nginx 先 `nginx -t` 再 reload。

## 监控（P2 完成）
- 命令=monitor.rs 固定常量表，Tauri 命令只收 sessionId。监控绝不走 PTY：每条命令独立 exec channel；`SshSession.writer=Mutex<Option<SessionWriter>>`（None=非交互，ssh_input/ssh_resize 对 None 报错）。
- 取消：`SshSession.closed: watch::Sender<bool>`，shutdown() send(true) 使在途 timed() select! 立即失败。存活双信号 `dead:AtomicBool` + `handle.is_closed()`；exec channel_open 失败只在 SendError|Disconnect|HUP（或 handle 已关）算断开。
- 死会话查表即时移除；connect_with 重连前 remove+shutdown；ssh_connect_monitor 开头 forget。速率=两次采样差值，首次隔 200ms 再采，禁止 0 占位；重连必须 forget 基线。历史窗口 `maxSamplesFor=ceil(30min/intervalMs)`。不支持的 OS 返回 `supported:false`+原因+空指标，禁零值。
- 全局事件监听器：共享 Promise 防重复注册、成功才置就绪、失败可重试；配低频批量只读兜底查询防事件丢失。

## UI 组件约定
- 右键菜单统一 `useContextMenu()`（pointerdown 不关菜单防闪；contextmenu bubble 阶段靠 defaultPrevented 判新菜单）。
- 长列表行 memo+稳定回调；Tauri 拖拽 over 高频事件 ref 短路再 setState。
- lucide-react v1.x：`AlertTriangle→TriangleAlert`、`Loader→LoaderCircle`。
- P3 模块框架 ModuleFrame：顶部工具栏不放常驻连接状态角标（2026-09-02 用户要求删除）；异常用横幅（connecting/error/closed）。模块页 `useCommandSession(tab)`（非交互无 PTY）+ workbench-store `MODULE_TAB_TYPES` 注册。
- Workbench 布局：终端/服务器走左侧 ContextSidebar（`openModuleTab` 对 ssh/servers 只切 activeModule 不开页签）；其他模块走 ModulePage 居中页签。
- 页签=类型图标+服务器名（无"· 监控"类后缀，5 处入口都要查，含 workbench-store 的 `openModuleTabForServer`）；图标用 `@/components/its-hover` 同套。
- 浮层一律纯白实色（`.glass-panel` 已统一），禁玻璃拟态；浮层限高用 `calc(vh)` 相对视口，禁 max-h-full+容器 padding 组合；浮层列表禁固定 px 上限。
- xterm：测量容器（open() 的元素）禁止 padding（FitAddon 会多算一行裁最后一行）；`globals.css` 禁给 `.xterm`/`.xterm *` 加 user-select（破坏 IME，中文直接上屏）。WorkbenchPane 非活动 tab 加 `inert={!active}`（禁 `inert=""`）。
- CSS 禁写死十六进制背景色，一律 `--surface-*/--app` 令牌。
- lucide 文件图标语义图标保留在内容区（空状态/行首）不算噪音；ModuleFrame header 的 icon prop 可选。

## 文件图标体系（2026-09-03 重构）
- `src/lib/file-kind.ts`：识别与图标解耦。`fileKind({name, kind, path?})` → `FileKindInfo{iconKey, category, label, language?}`（无 color 字段——图标集是多色 fill）；iconKey 是稳定标识（FileIconKey），EntryIcon/预览弹窗经 `src/lib/icons/vscode-file-icons.ts`（**生成文件**）+ `@iconify/react` 离线渲染。**禁止运行时联网取图标**（服务器离线图标不能消失）。
- 识别顺序（文件）：精确文件名表 `EXACT_KINDS`（含 `.ssh` **文件**、authorized_keys、package.json 等）→ 正则规则（`*.ssh`、dockerfile*、compose*.yml、id_*、.env*）→ 扩展名表 → 通用兜底；**kind 分流先行**：`kind==="directory"` 走特殊文件夹表，**目录 .ssh 显示普通文件夹图标**（用户裁决）。`.ssh` 内容文件按精确名匹配、不做路径扫描。
- 图标数据由 `scripts/generate-file-icons.mjs`（`pnpm icons:regen`）从本地 `@iconify-json/vscode-icons` 提取（只打包用到的 71 个，全集 1589 个不进包）；该集合是 kebab-case（`default-file`/`folder-type-*`/`file-type-*`）且**无 ssh/terminal/lock/settings 图标**——ssh/ssh-config/lock 用 `material:` 前缀回退到 material-icon-theme。**默认 `folder` 用 fluent-emoji-flat 的 `file-folder`**（Windows 黄 #ffb02e/#fcd53f，用户裁决：vscode-icons 暗蓝灰文件夹太暗；特殊文件夹仍保留 vscode-icons 徽章）。候选链末端必有通用兜底；`Record<FileIconKey, IconifyIcon>` 由 tsc 强制全覆盖。

## P3 管理模块（用户确认修订版）
- 先识别系统/能力，再按需启用适配器；Docker/Nginx/systemd 是检测到才启用的适配器不是固定预设。Docker/Nginx **写操作**属 P4（前端只读占位）；文件、AI 模块暂停。流程 P3.1→P3.9；适配器注册制 `DeploymentAdapter`；未知服务显示"暂无匹配适配器"，禁止猜测。
- 评分（2026-09-02 定稿勿回退）：marker 全小写；`.sln/.csproj/.fsproj` 按后缀识别；过滤=证据驱动三条（①无标志且无实例关联丢弃 ②有标志就保留 ③实例关联不过滤），不是 score<35。运行时关联权重 25（进程/systemd）/20（容器、网关）。
- `service_catalog.rs` 是服务判定唯一写表点（镜像/单元/端口/配置路径→服务），识别不出返回 None 绝不猜。`ServiceGroup` 非 application 的是基础设施，用 ProjectKind 分开。系统目录（SYSTEM_PREFIXES）与依赖目录（RUNTIME_DIR_NAMES）不是项目根。
- k8s：容器名 `k8s_<container>_<pod>_<ns>_…` 是唯一判据（`k8s_POD_`=pause 沙箱）；Pod `source_known=false` 是真实形态；kubectl 存在≠连上集群，收集前先 `kubectl get nodes`。
- 项目发现=部署实例优先（`deployment_collector.rs` 枚举真实实例→实例路径定向 marker 扫描→固定根补充扫描）；实例无宿主线索 `source_known=false` 绝不伪造路径；category=deployed/source_only。
- 安全边界：`safe/` 的 Capability 枚举是唯一"动作→命令字符串"翻译点，禁别处拼命令；校验在网络 I/O 之前；部署步骤三重校验（白名单+禁 shell 操作符+路径在 deploy_path 内）；docker_prune 禁用。e2e `tests/p3_e2e.rs` 断言被拒参数一条都没发出。
- 已确认项目持久化：`confirmed_projects` 表（唯一索引 (server_id, canonical_path)，软删 deleted_at）存 candidate_payload 快照+scan_state（active/missing/inaccessible/changed）；扫描完成按 found_paths 重算状态**绝不删行**；路径走 `canonicalize_project_path`。前端 `merge-applications.ts` 合并（已确认优先，即使被重分类也保留并标 kindChanged）；useScanTask 刷新不 setResult(null)。
- 项目卡片不显示"基础设施"性质徽标（用户裁决：数据层 project_kind 保留用于过滤，UI 不渲染）。

## P4 命令中心 / 终端
- 安全模型：前端只传 knowledgeId+结构化 params；`ExecKind` 编译期→`build_exec`→`KnowledgeExec::capability()`（唯一翻译点）→命令串只在 safe.rs。风险分级：readonly 直接执行/medium 需 ConfirmDialog/第一批不收录 high。知识库=编译期常量不进 SQLite；检索内存打分（id>别名>前缀>场景>标题>描述>子序列+收藏/使用加权）。
- 命令参数占位符绝不进 shell：complete.ts 的 `completionKeys` 遇未解析占位符返回 null；ParamPicker 逐个填写；后端 `command_param_values` 不拼 shell 文本。medium 无参数命令也要 ConfirmDialog。
- 统一输出适配：`src-tauri/src/output_adapter/`（model/registry/generic/domain 三层）+ 前端 `command-result/` 渲染器只按 view 分发；铁律：raw 永久保留、空输出有效不回落、解析失败必须可见。终端接线：TerminalCommandCoordinator+ResultDrawer；输出边界=静默 400ms+10s 兜底，**不猜 shell 提示符**；`command_adapt_output` 纯解析零 I/O；`command_match_text` 确定性匹配不做模糊。
- 服务器上下文：`command_probe_tools` 白名单探测（Capability::Probe），前端置灰+execute 硬校验两层防线。
- 终端建议：原位补全（光标锚点+requestAnimationFrame）；dismissedDraft 状态是"二次 Enter 穿透执行"的关键；alternate screen（vim/top）禁用提示。

## 技术要点
- SSH 用 russh 0.63：`check_server_key` 必须实现（默认拒所有键）；KeepAlive=Config.keepalive_interval+Handle::send_keepalive。ProxyJump：`channel_open_direct_tcpip→into_stream→connect_stream`，跳板 handle 必须保活。tests/ssh_e2e.rs 进程内 russh 服务端；`Handler::data` 会触发隧道通道，用 HashSet<ChannelId> 跳过回显。
- Tauri 命令参数 Rust snake_case↔JS camelCase 自动映射；SQLite 迁移 PRAGMA user_version 幂等 ALTER TABLE。
- React 19 测试坑：`globalThis.IS_REACT_ACT_ENVIRONMENT=true`；受控 input 用 native setter 再 dispatch；ConfirmDialog 走 portal 查 document.body。CM search：SearchQuery 只有 valid/search 无 spec；getCursor 返回裸 Iterator 不能 for...of；@codemirror/view 非直接依赖，类型从 @uiw/react-codemirror re-export；**shell（TextPreview）不得导入 CM 符号**否则破坏代码分割。
- 改前端后必须 `pnpm build`+`cargo build` 再启动 exe（`generate_context!` 编译期嵌 dist）；`pnpm tauri dev` 才实时。判断跑的哪版 UI：找只在新版存在的特征。
- 多会话并行改代码时，tsc/cargo 失败先判归属（对方中间态文件别代改）；编辑前必须重读文件。
- Windows `0xc0000139`：Cargo.lock 无外部 DLL 依赖（rustls/ring+bundled SQLite）；复现先查 PATH 第三方 OpenSSL/Git DLL 冲突。

## 开发/验证命令
- `pnpm build`（tsc+vite build）；`pnpm test`（vitest run）
- `cd src-tauri`：`cargo fmt --all -- --check`（CI 门禁）/ `cargo check --all-targets` / `cargo test --all-targets`（lib+db 单元+19/25/27 三个 e2e 套件）
- `cargo build && ./target/debug/ops-workbench.exe`（冒烟：窗口标题 BLS-OPS）
- CI 无状态检查先查 commit 是否已 push（GitHub 只对已推送 commit 跑 workflow）。
