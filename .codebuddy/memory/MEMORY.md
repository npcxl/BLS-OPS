# BLS-OPS 长期记忆

## 项目定位
Tauri 2 + React 19 + Rust 桌面 SSH 运维工具（Windows 为主）。P0 真 SSH ✓ / P2 监控 ✓ / P3 项目发现 ✓ / P4 命令中心+终端（收口中）/ P5 起：系统基础部署流程 → 删除治理（软删除，已从 P4 移出）→ AI 最后。

## 硬性约定（勿回退）
- `src/main.tsx` 禁 React.StrictMode（双挂载拆 SSH 连接）。
- 禁 Mock 伪装真实状态；未实现显示"未实现"；禁假状态字段；连接状态一律从 session-store 读。
- 只保留一套 domain 模型：DB 类型在 `src/api/ops-api.ts`（snake_case 与 Rust 一致）。
- 密码/私钥永不回传前端：只提交 `credential_id`；凭据"私钥+口令"是一组配置。
- Host Key 必须人工确认（首连+指纹变更弹窗）。
- Rust→前端 payload camelCase（`#[serde(rename_all="camelCase")`）；枚举值 snake_case 与前端联合类型逐字一致；事件与命令共用同一结构。**"接口正常但不渲染"先 diff 载荷字段名**（dirsize 事故根因）。
- 破坏性操作统一 `components/ui/confirm-dialog.tsx`（禁 window.confirm）；Nginx 先 `nginx -t` 再 reload。
- 输出适配铁律：raw 永久保留、空输出有效不回落、解析失败必须可见。
- 远程命令字符串只能在 `safe.rs` Capability 枚举拼；校验在网络 I/O 前；前端只传结构化标识。
- **交互铁律（用户裁决 2026-09-07）**：浮层/横幅提示不得遮挡命令行与输入区（paramHint 钉终端顶部 + pointer-events-none，仅关闭键可点）；"不能选择/不能自动填"的功能宁降级为**填入+提示**，绝不让回车被吞成死胡同。

## 模块化分层（skill: bls-ops-modular）
- 新 Tauri 命令 → `src-tauri/src/commands/<域>.rs`；新监控指标 → `monitor/`（model→parse 纯函数→collect）。
- Rust 文件超 ~600 行拆目录：`foo.rs` 父模块 + `foo/` 子模块（不可与 `foo/mod.rs` 并存），父模块 re-export 保持旧路径不变。
- 前端：领域类型 `src/api/types/<域>.ts`；事件名唯一来源 `src/lib/events.ts`；新视图 `src/workbench/views/<域>/`；视图超 ~400 行拆目录；列表行 memo+稳定回调。
- 验证：`pnpm build`、`pnpm test`、`cargo fmt --all -- --check`、`cd src-tauri && cargo check --all-targets && cargo test --all-targets`。新增纯解析函数 → 固定样本断言（空输入/超长/缺失字段）。
- **改前端后必须 `pnpm build` + `cargo build`**（`generate_context!` 编译期嵌 dist，只跑 tsc 不生效；`tauri dev` 才实时；debug exe 不加载内嵌 dist）。改 dist 后要 touch `src-tauri/build.rs` 才重新嵌入。

## i18n（natural keys）
- i18next 26 + react-i18next 17。key=英文文案本身，`en` 空、`zh-CN` 全量、其余 8 语言尽力（目前仅 common+workbench，覆盖率 ~13%），`fallbackLng: en`。默认 en。结构见 `docs/i18n.md`（同步 init + `localStorage["bls-ops.locale"]`）。
- **三个禁手**：① 禁 `parseMissingKeyHandler`（覆盖已插值结果）；② 禁 `keySeparator`／嵌套结构（依赖 `ignoreJSONStructure` 扁平命中）；③ 通用词只进 common.ts。
- 模式：模块常量**存英文 key、渲染处 t()**；含插值句子在**生成点** `i18n.t()`；纯 TS 用 `import { i18n } from "@/i18n"`。不翻：Rust 错误消息、catalog title、xterm write、远程输出、注释/console/it 名。
- **2026-09-07 体检**：`locales/zh-CN/{commandCenter,docker,monitor,nginx,projects}.ts` 是**空壳**，197 个 `t()` key 无中文（project 82 / server-monitor 54 / command-result 34 / command-center 13 / 其它 14）。硬编码中文未抽取：`AiPlaceholder.tsx`、`settings-context-sidebar.tsx`"正在加载…"、`lib/format.ts` 时长、`environment.ts` note。
- 复查手段：PowerShell 正则扫 `t("...")` key 与语言文件做集合 diff；扫硬编码中文跳过 `//`、`console.*`、`{/* */}`。测试跑 en：断言写英文 key；渲染类测试顶部 `import "@/i18n"`。

## 版本·发布·自动更新（勿回退）
- `package.json` 是版本唯一输入；改版本只走 `pnpm version:bump`（禁手改四处）；`pnpm check:versions` 校验四处一致 + 前后端插件版本同号（`=` 钉死）。
- pnpm 固定 9.15.9，只写在 `packageManager` 字段；`pnpm/action-setup@v4` 不带 `with: version:`（冲突报错）；改依赖后必须 `pnpm install --lockfile-only`（CI `--frozen-lockfile`）。
- 发布只能走 `.github/workflows/release.yml`：单工作流 bump→提交→tag→构建；tag 触发→draft release，人工 Publish 后才进 `latest.json`。详见 `docs/p5.1-updater.md`。
- 自动更新只用官方 `tauri-plugin-updater`（禁前端 fetch 安装包/shell 拉起 exe；minisign 签名≠Authenticode 未做）；状态机唯一入口 `src/stores/updater-store.ts`，组件禁自调 `check()`；重启前过 `update-guard.ts`（活动 SSH/命令/传输/未保存文件/长任务任一即弹确认，取消保持 `restart_required`）。

## UI 组件约定
- 右键菜单统一 `useContextMenu()`（一层子菜单）；**右键 = 顶部功能镜像**；全局单例（`closeActiveContextMenu()`）。
- 复制一律 `src/lib/clipboard.ts::copyText()`；点击复制共用 `copy-feedback.tsx`（禁自写计时器）；测试断言用 `data-line`。
- 窗口按钮：macOS 原生（顶栏留 `pl-[76px]`）；Win/Linux 自绘 `window-controls.tsx`；平台判定 `src/lib/platform.ts::isMacOS()`（函数非常量）。Tauri 平台配置 JSON Merge Patch、数组整体替换。
- 浮层纯白实色（`.glass-panel`）；**浮层限高用 `calc(vh)`**；CSS 禁写死十六进制背景色，用 `--surface-*/--app` 令牌。
- 面板拖拽统一模式（侧栏+结果抽屉）：mousedown→window move/up，hover/drag 高亮 `bg-accent/15|25`，双击恢复默认；**内联 height 会被 Tailwind min-h 压过，高度三件套必须全走 style**。
- lucide v1.x：`AlertTriangle→TriangleAlert`、`Loader→LoaderCircle`；`arr.at(-1)` 不可用（lib<es2022），用 `arr[len-1]`。
- xterm：测量容器禁 padding（FitAddon 裁行）；`.xterm` 禁 user-select（破坏 IME）；非活动 tab `inert`。
- 文件图标：`src/lib/file-kind.ts` + `src/lib/icons/vscode-file-icons.ts`（`pnpm icons:regen`）+ @iconify/react 离线渲染，禁联网。
- 服务器列表唯一实现 `src/workbench/server-list/`；分组同名唯一。
- 测试放被测代码目录 `test/` 子目录；移动测试改写相对路径。Windows 写文件保无 BOM。
- 拆 1000+ 行大文件：PowerShell 按行区间机械切分（UTF8 无 BOM）再补 import 表头 + `cargo fmt`；子模块用 `use super::model::*`，**不要 `use super::*`（成环）**。
- **托盘（勿回退，2026-09-07）**：点 X = 隐藏不退出（`lib.rs::on_window_event` CloseRequested→prevent_close+hide，**SSH 会话保持**）；托盘左键单击恢复、右键菜单仅"显示主窗口/退出"（`src-tauri/src/tray.rs`，只有 quit 才 `app.exit(0)`）；菜单文案由前端 `hooks/use-tray-labels.ts` 经 `tray_set_labels` 下发并随 `languageChanged` 重发（Rust 侧无 i18n）；macOS 靠 `RunEvent::Reopen` 恢复；tauri 开 `tray-icon` feature。
- **构建产物永不入库（用户指令）**：`.gitignore` 用 `src-tauri/target*/`（通配，连临时 CARGO_TARGET_DIR 也覆盖）+ 根 `dist`。

## 终端（勿回退）
- 智能提示 Provider 注册制 `views/terminal/completion/`，禁在 TerminalSuggest/TerminalView 里 if/else；cd 补全只走 `sftpListDir`；写回用 `quotePathSegment`。
- cwd 四源优先级：OSC7 > 跟踪 cd（退出码 0 才更新）> 受控 pwd 探测（只在空命令行发）> 登录目录。绝不用提示符猜 cwd。
- 焦点归还：`refocusTerminal()` 只在 activeElement≠textarea 时 focus；**commit 后 effect 里捞焦点**；每个浮层独立开关，禁合并布尔量。
- 缓存纪律：目录 10s / Docker 15s / 服务 20s / 环境 60s；写命令后目录缓存失效。
- 结果链路：TerminalView→TerminalCommandCoordinator（render rendezvous，缺 session.done 守卫会提前 emit）→TerminalResultDrawer→TerminalSnapshotView（400ms 静默 fallback 标 boundaryReliable=false）。抽屉高度可拖拽（`use-terminal-results.ts` 的 `drawerHeight`，≤40px 自动收起，不持久化；**收起态把手不渲染、只能点展开按钮恢复，不能拖拽展开**——用户裁决）。
- **占位符绝不进 shell**（`hasUnresolvedPlaceholder` 是 SSH 前最后一道拦截）；候选接受结果三态 `filled|noop|blocked`，`noop`=回车必须执行（防吞回车死胡同）。
- **手填参数（2026-09-07）**：占位符无数据源（`canAutoFill=false`，如 unzip `<包名.zip>`）→ `applyKnowledgeHit` 用 `complete.ts::commandBody()`（第一个 `<` 前字面前缀）填入命令主体 + 顶部提示；主体已在行上返回 `noop`。paramHint 横幅钉终端**顶部**（top-0.5、实底 `bg-surface-1` 不透穿、pointer-events-none）；**无关闭按钮**，右侧显示倒计时 `"Closes in {{seconds}}s"`，5 秒后自动关闭；命令真正执行时 `execute()` 清掉。
- 增强终端唯一开关：`bls-ops.terminal.enhanced`（**默认开**，仅用户主动关过存 `"0"` 才关）；字体 `bls-ops.terminal.font`。
- `TerminalView.tsx`（~1100 行）已拆出：`terminal-preferences/phase`、`use-terminal-session`（xterm 大 effect，依赖只留 hasTarget/sessionId）、`use-ssh-keepalive`、`use-terminal-search`、`use-terminal-results`（**唯一提交入口** `execute`）、`terminal-toolbar`、`terminal-error-banner`、`use-terminal-menu`（右键=工具栏镜像）。改交互先确定落在哪个 hook。

## P4 命令中心/终端
- 安全模型：前端只传 knowledgeId+结构化 params；`ExecKind`→`build_exec`→`capability()` 唯一翻译点；readonly 直接执行、medium 走 ConfirmDialog、high/destructive 不入库。
- 终端与模块两条独立链路（用户裁决）：`CapturedResult` 无 rawOutput 别名；禁 ANSI 清洗/自动表格化/adapt_auto。
- 输出适配引擎 `src-tauri/src/output_adapter/` + 前端渲染器 `views/command-result/`（只按 view 分发，不认命令来源）。
- 严格 JSON：`detect-json.ts` 整段合法才出 Tab；`stripTrailingPrompt()` 不猜 PS1。
- 已删除勿加回：commandAdaptOutput/ContainerTable/StructuredTables/ReadableOutputView。
- P4.4 软删除已移出 P4，列入"删除治理"阶段（见 `docs/p4-acceptance.md`）。

## 技术要点
- **vite 禁 manualChunks 强拆 node_modules**（2026-09 白屏事故）：chunk 成环，生产包抛 `Cannot set properties of undefined (setting 'Activity')`；`tauri dev` 正常、只有安装版暴露。分包靠动态 import 边界。
- WebView2 排查：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--enable-logging`，看 `%LOCALAPPDATA%\com.bls.ops\EBWebView\chrome_debug.log`；`Tauri v2 Windows 绝对路径 /assets 正常`。CI smoke 只查进程+窗口标题，查不出渲染。
- russh 0.63：`check_server_key` 必须实现；ProxyJump into_stream→connect_stream。UTF-8 跨块：`ssh/utf8_stream.rs::Utf8StreamDecoder`（禁逐块 lossy）；GB18030/Big5 不做假支持。
- React 19 测试：`IS_REACT_ACT_ENVIRONMENT=true`；受控 input 用 native setter；ConfirmDialog 查 document.body；shell/TextPreview 不得导入 CM 符号（破坏代码分割）。
- 并行会话改代码时 tsc/cargo 失败先判归属（对方中间态别代改）；编辑前重读文件。
- **运行中的 app 锁 `target/debug/ops-workbench.exe`**（os error 5）：`cargo test --all-targets`/`--tests`/`cargo build` 链接 bin 会失败；改用 `cargo test --lib --test <目标名>`，或等应用关闭再跑。
- Windows `0xc0000139`：查 PATH 第三方 OpenSSL/Git DLL 冲突。

## 品牌资产
唯一 Logo 源 = `public/logo.png`（`pnpm tauri icon public/logo.png`）；favicon=`/logo.png`；AppTopBar 左上 `<img src="/logo.png">` 18px。
