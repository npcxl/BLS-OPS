# BLS-OPS 长期记忆

## 项目定位
Tauri 2 + React 19 + Rust 桌面 SSH 运维工具（Windows 为主）。P0 真 SSH 工具；P2 监控完成；P3 项目发现完成；P4 命令中心/终端进行中。

## 硬性约定（验收标准，勿回退）
- `src/main.tsx` 禁 React.StrictMode（双挂载拆 SSH 连接；复发即移除）。
- 禁 Mock 伪装真实状态；未实现显示"未实现"；禁假状态字段（如已删的 `WorkspaceTab.connected`）；连接状态一律从 session-store 读。
- 只保留一套 domain 模型：DB 类型在 `src/api/ops-api.ts`（snake_case 与 Rust 一致）；旧 `src/stores/domain/` 已删勿加回。
- 密码/私钥永不回传前端：只提交 `credential_id`，Rust 从 Keyring 读密钥直连；无 `credential_get_secret`。凭据"私钥+口令"是一组配置。
- Host Key 必须人工确认（首连+指纹变更弹窗）。
- Rust→前端 payload 字段 camelCase（`#[serde(rename_all="camelCase")]`）；枚举值 snake_case 与前端联合类型逐字一致；事件与命令共用同一结构。排查"接口正常但不渲染"先 diff 载荷字段名。
- 破坏性操作统一 `components/ui/confirm-dialog.tsx`（禁 window.confirm/手拼 Modal）；改服务端状态必须 ConfirmDialog；Nginx 先 `nginx -t` 再 reload。
- 输出适配铁律：raw 永久保留、空输出有效不回落、解析失败必须可见。

## UI 组件约定
- 右键菜单统一 `useContextMenu()`；**菜单支持一层子菜单**（children）。**右键 = 顶部功能**：面板右键菜单 = 顶部工具栏镜像/超集，同一份数组渲染两处；右键可达被滚动/折叠藏起的顶部功能。
- **ContextMenu 全局单例**（2026-09-04）：同一时刻只允许一个右键菜单——模块级 `activeMenuClose` 槽 + 打开前 `closeActiveContextMenu()`。服务器列表（每行独立实例 + 空白背景实例）若各开各的会双菜单并存，勿回退成"每实例自治"。
- 复制一律走 `src/lib/clipboard.ts` `copyText()`，禁散落 `navigator.clipboard`。
- 侧栏收起后唯一展开入口在 AppTopBar（`hasContextSidebar()`），按钮必须 `data-tauri-drag-region="false"`。
- lucide-react v1.x：`AlertTriangle→TriangleAlert`、`Loader→LoaderCircle`；`arr.at(-1)` 不可用（lib<es2022），用 `arr[len-1]`。
- 浮层纯白实色（`.glass-panel`）；限高 `calc(vh)`；列表禁固定 px 上限。
- CSS 禁写死十六进制背景色，用 `--surface-*/--app` 令牌。
- ModuleFrame 顶部不放常驻连接角标（用户裁决），异常用横幅。模块页 `useCommandSession(tab)` + workbench-store `MODULE_TAB_TYPES` 注册。
- xterm：测量容器禁 padding（FitAddon 裁行）；`globals.css` 禁给 `.xterm`/`.xterm *` user-select（破坏 IME）；WorkbenchPane 非活动 tab 用 `inert={!active}`（禁 `inert=""`）。
- 长列表行 memo+稳定回调；Tauri 拖拽 over 高频事件 ref 短路再 setState。

## 文件图标（2026-09-03 定稿）
`src/lib/file-kind.ts`：`fileKind({name,kind,path?})→FileIconKey`（无 color），EntryIcon 经 `src/lib/icons/vscode-file-icons.ts`（生成文件）+@iconify/react 离线渲染，**禁运行时联网**。识别顺序：精确名表→正则→扩展名→兜底；kind==="directory" 先行分流。**默认 folder 用 fluent-emoji-flat `file-folder`**（Windows 黄 #ffb02e/#fcd53f，用户裁决）；特殊文件夹（git/node/docker）保留 vscode-icons 徽章。脚本 `scripts/generate-file-icons.mjs`（`pnpm icons:regen`）。

## 监控 P2 / 发现 P3（核心）
- 监控命令固定常量表、绝不经 PTY；取消靠 `closed: watch`；死会话即时移除；速率=两次采样差值禁 0 占位；不支持的 OS 返回 `supported:false`+原因，禁零值。
- 服务判定唯一写表点 `service_catalog.rs`；`DeploymentAdapter` 注册制；未知服务"暂无匹配适配器"。评分（勿回退）：marker 小写；`.sln/.csproj/.fsproj` 按后缀；过滤证据驱动三条非 score；运行时关联权重 25/20。Docker/Nginx 写操作属 P4（前端只读占位）。
- 项目发现=部署实例优先；`source_known=false` 绝不伪造路径；已确认项目持久化软删+绝不删行。
- 安全边界：`safe/` Capability 是唯一"动作→命令"翻译点，禁别处拼命令；校验在网络 I/O 前；部署步骤三重校验；docker_prune 禁用。

## 服务器列表（2026-09-04 定稿）
唯一实现在 `src/workbench/server-list/`：`sections.ts`（纯逻辑，groups 为主数据）、`use-server-list.ts`（乐观+回滚）、`ServerListTree/ServerRow/ServerGroupSection/NewGroupInput/ServerForm`。**两侧栏只是壳**（标题+onOpenServer）。星标=行内兄弟按钮；"移动到分组"走子菜单。分组同名唯一（db 查重+命令层 validate，改名跳过自身）。

## P4 命令中心 / 终端（2026-09 重构中）
- 安全模型：前端只传 knowledgeId+结构化 params；`ExecKind`→`build_exec`→`capability()` 唯一翻译点，命令串只在 safe.rs。风险：readonly 直接/medium ConfirmDialog/high 不入第一批。知识库=编译期常量，检索内存打分。
- **终端与模块 = 两条独立链路（2026-09-04 定稿，用户裁决，勿回退）**：
  - **终端结果 = xterm 终端快照方案**（勿回退到 ANSI 清洗/逐命令解析/自动表格化/adapt_auto）：SSH 输出只写主 Terminal，`CapturedResult{stdout, stderr, json, renderedText, renderedDegraded, boundary, risk, ...}`（**无 rawOutput 别名**——曾与 stdout 完全重复），renderedText 从已渲染的 xterm buffer（`extract-terminal-snapshot.ts`）经 marker 行截取、`line.isWrapped` 合并软换行；命令边界用 OSC 133 Shell Integration，400ms 静默仅作不支持服务器的 fallback 且标 `boundaryReliable=false`；`terminal.write(data, callback)` 确认解析完成后才截图，禁 setTimeout 猜渲染；Marker 被 scrollback 淘汰不崩溃→走原始流降级并提示。交互程序（vim/top/htop/less/watch/tmux/screen 等）不生成快照；持续日志标 streaming 等停止后再出快照。
  - **严格 JSON Tab**：`src/lib/detect-json.ts` 数据完整铁律——整段 trim 后整体合法 JSON，否则 JSONL **逐非空行解析、任一行坏即整体 null**（禁“跳过坏行部分成功”）；`detectJsonOutput(text, command)` 剥掉快照首行的 prompt+命令回显再检测（只决定 Tab 出不出，绝不动终端输出）。Tab 固定 `[终端输出](默认)[JSON?][原始流]`。
  - **模块结构化链**：`output_adapter/`（Rust，含 `adapt_auto`/hint 先试失败 auto）+ `command-result/` 渲染器保留给 Docker/服务/项目/日志/command-center。Rust `generic/json.rs::parse_json` 的 JSONL 同样**坏行整体 None**（7efa21e 收紧，删掉死函数 `json_array_to_rows`）；`CommandResultPanel` 只服务 command-center 知识库路径，终端链不再引用。JsonView 是通用 JSON 查看器（折叠树+文本+搜索+复制路径/节点，**绝无数组→表格分支**），终端 JSON Tab 与模块 json 视图共用。
- 参数占位符绝不进 shell（completionKeys 遇未解析返回 null；后端不拼 shell 文本）。
- **增强终端 = 唯一开关**（2026-09-04 用户裁决，默认**关**，**不设第二个"显示结果"按钮**）：工具栏 `ToolbarIcon`（Sparkles，与查找/历史/文件同款 active 高亮，右键画布菜单同步一项）。开 → 结果面板随结果自动出现（`onResult` 置 `drawerClosed=false`）；关 → 纯终端：`planCommandSubmission(cmd, mode, {capture:false})` **不注入任何受控标记**、清空已有结果与面板。四处门禁：提交计划传 `capture`、`onResult` 用 `enhancedRef` 守卫、抽屉渲染 `enhancedTerminal &&`、重新打开时 `drawerClosed=false`。状态持久化 `localStorage` 键 `bls-ops.terminal.enhanced`。面板 × 只是临时收起，下一条结果会重新展开。工具栏**已删除"编码"栏目**（后端会话编码 API 保留、默认 auto 不动）。
- **字体可选**（`terminal-font.ts`）：工具栏"字体" select，6 个栈（Cascadia/更纱黑体/JetBrains/Consolas/Menlo/系统默认，均以 `monospace` 兜底），`localStorage` 键 `bls-ops.terminal.font`。`applyTerminalFont` 同时设 `--font-terminal`（xterm `options.fontFamily`，切换后必须 `fit()`）与 `--font-command-output`（结果快照/JSON 文本）。**不打包字体文件**——只切栈，没装就回退；UI 标题按钮仍用 `--font-ui`(Inter)。
- **终端写出流水线**（`terminal-output-pipeline.ts`，TerminalView 拆分第一步）：`splitAtOutputEnd` + `writeOutputParts(parts, {write, flush, capture})` —— 顺序恒为 `before → 等渲染完 → 抓快照 → after`，**D 之后的提示符绝不进快照**；结束时若本次无可写文本必须先 `flush()` 再抓。stderr 与 stdout 走**同一条** `queueWrite`（晚到的 stderr 也进本次快照）。快照只依赖 `instance.write(data, callback)` 的 promise，禁 setTimeout。
- **已删除的旧残留（2026-09-04，勿加回）**：`commandAdaptOutput` / `command_adapt_output` 命令、`ContainerTable.tsx`、`StructuredTables.tsx`、`ReadableOutputView.tsx` 与 `CommandResultPanel.readable` 分支。终端工具栏/菜单文案统一为**命令结果**（不是"结构化结果"）。字体：`--font-terminal`（xterm）与 `--font-command-output`（结果快照/JSON 文本）同栈，UI 仍用 `--font-ui`。
- **实现链路（勿回退）**：`TerminalView`（marker 注册 + `write` callback FIFO 后抓快照 + captureNow 兜底）→ `TerminalCommandCoordinator`（render rendezvous：`done && !matchPending && !renderPending` 才 `tryEmit` —— **缺 `session.done` 守卫会提前 emit 慢命令的空结果**）→ `TerminalResultDrawer` → `TerminalSnapshotView`（`<pre w-max whitespace-pre>` 不折行横滚；RawStreamView 走 stdout/stderr）。`commandAdaptOutput` API 定义保留但**零调用方**（符合终端不碰适配器）。

## 技术要点
- russh 0.63：`check_server_key` 必须实现；ProxyJump `into_stream→connect_stream`，跳板 handle 保活。`pnpm tauri dev` 才实时；改前端后必须 pnpm build+cargo build 重嵌 dist。
- React 19 测试：`IS_REACT_ACT_ENVIRONMENT=true`；受控 input 用 native setter；ConfirmDialog 查 document.body。shell/TextPreview 不得导入 CM 符号（破坏代码分割）。
- 并行会话改代码时 tsc/cargo 失败先判归属（对方中间态文件别代改）；编辑前重读文件。
- Windows `0xc0000139`：查 PATH 第三方 OpenSSL/Git DLL 冲突（本项目无外部 DLL 依赖）。

## 验证命令
- `pnpm build`（tsc+vite）；`pnpm test`（vitest run）
- `cargo fmt --all -- --check`（CI 门禁）；`cd src-tauri && cargo check --all-targets && cargo test --all-targets`
