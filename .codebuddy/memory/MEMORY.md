# BLS-OPS 长期记忆

## 项目定位
Tauri 2 + React 19 + Rust 桌面 SSH 运维工具（Windows 为主）。P0 真 SSH ✓ / P2 监控 ✓ / P3 项目发现 ✓ / P4 命令中心+终端（收口中）/ P5 起：系统基础部署流程 → 删除治理（软删除）→ AI 最后。仓库 github.com/npcxl/BLS-OPS。

## 硬性约定（勿回退）
- `src/main.tsx` 禁 React.StrictMode（双挂载拆 SSH 连接）。禁 Mock 伪装真实状态；未实现显示"未实现"；连接状态一律从 session-store 读。
- domain 模型唯一：DB 类型在 `src/api/ops-api.ts`（snake_case 与 Rust 一致）。Rust→前端 payload camelCase；枚举值 snake_case 与前端联合类型逐字一致；**"接口正常但不渲染"先 diff 载荷字段名**（dirsize 事故根因）。
- 密码/私钥永不回传前端：只提交 credential_id；Host Key 必须人工确认（首连+指纹变更弹窗）。
- 破坏性操作统一 `components/ui/confirm-dialog.tsx`（禁 window.confirm）；Nginx 先 nginx -t 再 reload。
- 输出适配铁律：raw 永久保留、空输出有效不回落、解析失败必须可见。远程命令字符串只能在 `safe.rs` Capability 枚举拼；校验在网络 I/O 前；前端只传结构化标识。
- **交互铁律**：浮层/横幅不得遮挡命令行与输入区；"不能自动填"降级为填入+提示，绝不让回车吞成死胡同（占位符三态 filled|noop|blocked，`hasUnresolvedPlaceholder` 是 SSH 前最后拦截）。
- **统一补全状态机（2026-09-08 终端+命令中心同一套，勿回退）**：默认只有行内 ghost（灰字+Tab 徽标，pointer-events-none，绝不弹面板）；Tab/↓=接受第一条并展开（面板唯一出现方式）；collapsed Enter=直接执行第一条（参数/风险流程照走）；expanded：↑↓ 移动、Enter 执行当前项、Tab/→ 填入（filled 保持展开→多级目录）；任何状态 Esc=清空整行；展开后非程序性 draft 变化→回 collapsed。核心 `terminal-suggest.ts`+`terminal-ghost.tsx`；**程序性写行必须先设 `programmaticDraftRef` 再 setDraft**。命令中心 collapsed Enter 固定 hits[0]（expanded 改字后 activeIndex 残留不可当执行目标）。cd 补全：裸 cd 由 Provider 接管（insertText 带前导空格，不能用 parsed.prefix 当路径）；只提示 directory+symlink；集成测试 `terminal/test/terminal-cd-completion.integration.test.tsx`。

## 模块化分层（skill: bls-ops-modular）
- 新 Tauri 命令 → `src-tauri/src/commands/<域>.rs`；新监控指标 → `monitor/`（model→parse 纯函数→collect）。
- Rust 文件超 ~600 行拆 `foo.rs`+`foo/`（不可与 foo/mod.rs 并存），父模块 re-export 保旧路径；子模块 `use super::model::*` 禁 `use super::*`（成环）。
- 前端：领域类型 `src/api/types/<域>.ts`；事件名唯一来源 `src/lib/events.ts`；新视图 `src/workbench/views/<域>/`（~400 行拆目录）；列表行 memo+稳定回调。
- 验证：pnpm build、pnpm test、cargo fmt --check、cargo check/test --all-targets。纯解析函数→固定样本断言（空/超长/缺字段）。
- **改前端后必须 pnpm build + cargo build**（generate_context! 编译期嵌 dist；改 dist 后 touch build.rs 重嵌）。用户报"没生效"先 diff dist vs exe 时间。构建产物永不入库。

## i18n（natural keys）
- i18next 26：key=英文文案本身，en 空、zh-CN 全量、其余 8 语言尽力（仅 common+workbench），fallbackLng: en、returnEmptyString: false。见 docs/i18n.md。
- 三禁手：①禁 parseMissingKeyHandler；②禁 keySeparator/嵌套；③通用词只进 common.ts，模块文件不重复（同文件同 key 重复=TS1117；zh-CN/index.ts 合并顺序 common 最前）。
- 模式：模块常量存英文 key、渲染处 t()；插值句子在生成点 i18n.t()。不翻：Rust 错误消息、catalog title、远程输出/结果快照、注释/console/it 名。**前端自绘连接状态行走 i18n**（TerminalView 绿 t("Connected") / 红 t("Connection failed: {{message}}")，用户裁决：简短一行，不带 host/fingerprint）。
- 复查：正则扫 t("...") 与语言文件 diff；测试跑 en（断言英文 key；渲染类测试顶部 `import "@/i18n"`）。

## 版本·发布·自动更新（勿回退）
- `package.json` 唯一版本输入；只走 `pnpm version:bump` + `check:versions` 校验。改依赖必须 `pnpm install --lockfile-only`（CI --frozen-lockfile）。
- 发布只走 `.github/workflows/release.yml`（tag 触发 draft，人工 Publish 后进 latest.json）。自动更新只用官方 tauri-plugin-updater；状态机唯一入口 `src/stores/updater-store.ts`（组件禁自调 check()）；重启前过 update-guard.ts。
- **更新失败必须可诊断**：UpdateError 带 stage（check/download/verify/install/relaunch）+at；UI 三行=阶段标题+code 文案+脱敏 Details+Error code，配复制错误/诊断/重试/GitHub 手动下载；诊断包 `lib/updater/diagnostics.ts`（二次 sanitize，禁含私钥-token-路径-sig）。发布验收 `scripts/verify-release.mjs`。
- **第二守卫只许跑在下载路径（死结事故，勿回退）**：install() 的 blockingActivity 复查只在 download 完成后跑一次；downloaded→install 绝不再拦——那一步的点击就是用户确认，再拦=静默吞点击="点了没反应"。
- **tauri-action 的 latest.json URL 必须重写（勿删 workflow 步骤）**：它写 api.github.com/.../assets/<id>（匿名 401）→ updater 必失败报 unknown；workflow 用 `scripts/rewrite-updater-urls.mjs` 重写为 releases/download 直链。
- **GitHub REST `GET /releases/tags/{tag}` 不返回 draft**：release 查询/轮询一律用 `GET /releases` 列表+过滤；资产下载 `gh api .../assets/<id> -H "Accept: application/octet-stream"`；`gh api` 失败仍会写 HTTP body 进重定向文件——用 jq -e 验语义别只看大小。draft 的 manifest 在 Publish 前对应用不可见。

## UI 组件约定
- 右键菜单统一 useContextMenu()；复制一律 `lib/clipboard.ts::copyText()`+copy-feedback.tsx（禁自写计时器）；测试断言用 data-line。
- 窗口按钮：macOS 原生（顶栏 pl-[76px]）；Win/Linux 自绘 window-controls.tsx；平台判定 `lib/platform.ts::isMacOS()`。Tauri 平台配置 JSON Merge Patch、数组整体替换。
- 浮层纯白实色（.glass-panel）；限高 calc(vh)；CSS 禁写死十六进制背景色，用 --surface-*/--app 令牌。**嵌套 flex 里 height 百分比脆弱：preview 根全链 flex+min-h-0 弃 h-full；面板高度三件套必须全走 style**。
- lucide v1.x：AlertTriangle→TriangleAlert、Loader→LoaderCircle；arr.at(-1) 不可用（lib<es2022），用 arr[len-1]。
- xterm：测量容器禁 padding（FitAddon 裁行）；.xterm 禁 user-select（破坏 IME）；非活动 tab inert。
- 文件图标：file-kind.ts+vscode-file-icons.ts（pnpm icons:regen）+ @iconify/react 离线，禁联网。
- 服务器列表唯一实现 `src/workbench/server-list/`；测试放被测代码 test/ 子目录；Windows 写文件保无 BOM。
- 托盘（勿回退）：点 X=隐藏不退出（SSH 保持）；左键恢复、右键仅"显示主窗口/退出"（只有 quit 才 app.exit(0)）；菜单文案前端 use-tray-labels.ts 经 tray_set_labels 下发随 languageChanged 重发；macOS 靠 RunEvent::Reopen。
- 品牌：唯一 Logo 源=public/logo.png；favicon 与 AppTopBar 18px 均用 /logo.png。

## 终端（勿回退）
- 智能提示 Provider 注册制 `views/terminal/completion/`，禁在 TerminalSuggest/TerminalView 里 if/else；cd 补全只走 sftpListDir；写回用 quotePathSegment。
- cwd 五源：OSC7 > 成功 cd（exitCode 0）> 受控 pwd 探测（只在空命令行发）> 登录目录；cd 后无任何标记→uncertain（path 保留旧值+needsProbe，下次补全前探测刷新）；cd 失败是确定态。绝不用提示符猜 cwd。
- 焦点归还 refocusTerminal() 只在 activeElement≠textarea 时 focus；每个浮层独立开关，禁合并布尔量。缓存：目录 10s/Docker 15s/服务 20s/环境 60s；写命令后目录缓存失效。
- 结果链路：TerminalView→TerminalCommandCoordinator（render rendezvous，缺 session.done 守卫会提前 emit）→TerminalResultDrawer→TerminalSnapshotView（400ms 静默 fallback 标 boundaryReliable=false）。抽屉高度可拖拽（≤40px 自动收起不持久化；收起态把手不渲染只能点按钮恢复——用户裁决）。
- 手填参数：canAutoFill=false 占位符→commandBody() 填命令主体+paramHint 横幅钉终端顶部（实底、pointer-events-none、无关闭按钮、右侧 5s 倒计时、execute() 清掉），返回 noop。
- 增强终端唯一开关 bls-ops.terminal.enhanced（默认开，仅用户主动关过存 "0" 才关）；字体 bls-ops.terminal.font。
- TerminalView 已拆：terminal-preferences/phase、use-terminal-session、use-ssh-keepalive、use-terminal-search、use-terminal-results（唯一提交入口 execute）、terminal-toolbar、terminal-error-banner、use-terminal-menu（右键=工具栏镜像）。
- 命令块悬浮复制（2026-09-08）：`terminal-command-blocks.ts`（块=start/end 两枚 xterm IMarker，存 marker 不存行号，回滚 trim 自动跟随）+ use-terminal-results 接线（execute 时 beginBlock、onResult 封口）+ `TerminalCommandBlocks.tsx` 悬浮层（pointer-events-none 只按钮可点；alternate screen 不渲染）。切片挤出必须先算 `overflow=length-max` 再切（负索引截尾丢块 bug）。

## P4 命令中心/终端
- 安全模型：前端只传 knowledgeId+结构化 params；ExecKind→build_exec→capability() 唯一翻译点；readonly 直接执行、medium 走 ConfirmDialog、high/destructive 不入库。
- 终端与模块两条独立链路（CapturedResult 无 rawOutput 别名；禁 ANSI 清洗/自动表格化/adapt_auto）。输出适配引擎 src-tauri/src/output_adapter/ + 渲染器 views/command-result/（只按 view 分发不认命令来源）。严格 JSON：detect-json.ts 整段合法才出 Tab；stripTrailingPrompt() 不猜 PS1。
- 已删除勿加回：commandAdaptOutput/ContainerTable/StructuredTables/ReadableOutputView。软删除移入"删除治理"阶段。

## 远程文件夹 → VSCode（Remote-SSH，2026-09-08）
- 右键 "Open in VSCode"：`commands/vscode.rs` 在 ~/.ssh/config 写标记块 `# bls-ops:begin/end <alias>`（幂等 upsert，冲突 `<slug>-2` 递增）；key 凭据导出 ~/.ssh/bls-ops/<cred_id>.pem（unix 0600，Rust 侧不经前端——用户裁决允许）；密码凭据连接时 VSCode 弹框手输。ProxyJump/quickTarget 不显示菜单项。
- Windows .cmd 必须经 cmd /C + raw_arg 显式引号；Code.exe 直接 spawn；远程路径复用 safe::validate_abs_path。不写 accept-new——Host key 人工确认铁律由 VSCode/OpenSSH 默认 ask 承担。
- **editor_sync 域后端完整但前端零调用**（远程文件副本→本地编辑器→保存回传 SFTP，locator 支持 VSCode/Cursor/Windsurf/Trae/CodeBuddy）——历史半成品，待接前端做单文件编辑入口。

## 技术要点
- **vite 禁 manualChunks 强拆 node_modules**（chunk 成环白屏事故）；分包靠动态 import 边界。
- WebView2 排查：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--enable-logging，看 %LOCALAPPDATA%\com.bls.ops\EBWebView\chrome_debug.log。russh 0.63：check_server_key 必须实现；UTF-8 跨块用 `ssh/utf8_stream.rs::Utf8StreamDecoder`（禁逐块 lossy）；GB18030/Big5 不做假支持。
- React 19 测试：IS_REACT_ACT_ENVIRONMENT=true；受控 input 用 native setter；ConfirmDialog 查 document.body；shell/TextPreview 不得导入 CM 符号（破坏代码分割）。
- @uiw/react-codemirror 的 height="100%" 只打到 .cm-editor，外层 div 无高度 → 想用 100% 必须自己保证外层定高（h-full 或 absolute inset-0），库不补。
- 并行会话改代码时 tsc/cargo 失败先判归属（对方中间态别代改）；编辑前重读文件。
- **运行中的 app 锁 target/debug/ops-workbench.exe**（os error 5）：cargo test --all-targets/cargo build 链接失败；改用 `cargo test --lib --test <目标>` 或等应用关闭。Windows 0xc0000139：查 PATH 第三方 OpenSSL/Git DLL 冲突。
