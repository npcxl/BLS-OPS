# BLS-OPS 长期记忆

## 项目定位
Tauri 2 + React 19 + Rust 桌面 SSH 运维工具（Windows 为主）。P0 真 SSH ✓ / P2 监控 ✓ / P3 项目发现 ✓ / P4 命令中心+终端（收口中）/ P5 起：系统基础部署流程 → 删除治理（软删除，已从 P4 移出）→ AI 最后。

## 硬性约定（勿回退）
- `src/main.tsx` 禁 React.StrictMode（双挂载拆 SSH 连接）。
- 禁 Mock 伪装真实状态；未实现显示"未实现"；禁假状态字段；连接状态一律从 session-store 读。
- 只保留一套 domain 模型：DB 类型在 `src/api/ops-api.ts`（snake_case 与 Rust 一致）。
- 密码/私钥永不回传前端：只提交 `credential_id`；凭据"私钥+口令"是一组配置。Host Key 必须人工确认（首连+指纹变更弹窗）。
- Rust→前端 payload camelCase（`#[serde(rename_all="camelCase")`）；枚举值 snake_case 与前端联合类型逐字一致；事件与命令共用同一结构。**"接口正常但不渲染"先 diff 载荷字段名**（dirsize 事故根因）。
- 破坏性操作统一 `components/ui/confirm-dialog.tsx`（禁 window.confirm）；Nginx 先 `nginx -t` 再 reload。
- 输出适配铁律：raw 永久保留、空输出有效不回落、解析失败必须可见。
- 远程命令字符串只能在 `safe.rs` Capability 枚举拼；校验在网络 I/O 前；前端只传结构化标识。
- **交互铁律**：浮层/横幅不得遮挡命令行与输入区（paramHint 钉终端顶部+pointer-events-none）；"不能选/不能自动填"降级为填入+提示，绝不让回车吞成死胡同（占位符三态 `filled|noop|blocked`，`hasUnresolvedPlaceholder` 是 SSH 前最后拦截）。
- **命令面板轻提示**：空输入无建议（`enabled` 门控）；有输入只给行内 ghost+Tab 徽标，Tab/↓ 才展开下拉，Enter 恒执行高亮项。ghost 纯函数 `complete.ts::inlineGhost`。
- **统一补全状态机（2026-09-08 终端+命令中心同一套，勿回退）**：默认**只有行内 ghost**（灰字+Tab 徽标，pointer-events-none，绝不弹面板）；**Tab/↓=接受第一条并展开**（面板唯一出现方式）；collapsed Enter=**直接执行第一条**（参数/风险流程照走，无候选穿透）；expanded：↑↓ 移动、Enter 执行当前项、Tab/→ 填入当前项（filled 保持展开→多级目录）；**任何状态 Esc=清空整行**；**展开后非程序性 draft 变化→回 collapsed**。终端核心 `terminal-suggest.ts::resolveTerminalCompleteKey`+`ghostTextFor`+`terminal-ghost.tsx`；**程序性写行必须先设 `programmaticDraftRef` 再 setDraft**（否则刚展开的面板被自己收回）；`dismissedDraft` 已退役。命令中心：删 "x hits"，collapsed Enter 固定 `hits[0]`（expanded 改字后 activeIndex 残留，不能当执行目标）。cd 补全：裸 `cd` 由 Provider 接管（insertText 带前导空格，不能用 parsed.prefix 当路径）；只提示 directory+symlink；集成测试在 `terminal/test/terminal-cd-completion.integration.test.tsx`。

## 模块化分层（skill: bls-ops-modular）
- 新 Tauri 命令 → `src-tauri/src/commands/<域>.rs`；新监控指标 → `monitor/`（model→parse 纯函数→collect）。
- Rust 文件超 ~600 行拆 `foo.rs`+`foo/`（不可与 foo/mod.rs 并存），父模块 re-export 保持旧路径；机械拆分用 PowerShell 按行区间切（UTF8 无 BOM），子模块 `use super::model::*` **禁 `use super::*`（成环）**。
- 前端：领域类型 `src/api/types/<域>.ts`；事件名唯一来源 `src/lib/events.ts`；新视图 `src/workbench/views/<域>/`（~400 行拆目录）；列表行 memo+稳定回调。
- 验证：`pnpm build`、`pnpm test`、`cargo fmt --all -- --check`、`cd src-tauri && cargo check --all-targets && cargo test --all-targets`。纯解析函数 → 固定样本断言（空/超长/缺字段）。
- **改前端后必须 `pnpm build` + `cargo build`**（`generate_context!` 编译期嵌 dist；改 dist 后 touch `src-tauri/build.rs` 重新嵌）。**用户报"没生效"先 diff dist 时间 vs exe 时间**。
- **构建产物永不入库**：`.gitignore` 用 `src-tauri/target*/`（通配）+ 根 `dist`。

## i18n（natural keys）
- i18next 26：key=英文文案本身，`en` 空、zh-CN 全量、其余 8 语言尽力（仅 common+workbench），`fallbackLng: en`、`returnEmptyString: false`、`escapeValue: false`。默认 en。见 `docs/i18n.md`。
- **三个禁手**：① 禁 `parseMissingKeyHandler`（覆盖已插值结果）；② 禁 `keySeparator`/嵌套（靠扁平命中）；③ 通用词只进 common.ts，模块文件不重复（zh-CN/index.ts 合并顺序 common 最前、后模块可覆盖同名 key）。
- 模式：模块常量存英文 key、渲染处 t()；插值句子在生成点 `i18n.t()`；纯 TS `import { i18n } from "@/i18n"`。不翻：Rust 错误消息、catalog title、xterm write、远程输出、注释/console/it 名。后端结构化 UI 标签发英文 key、渲染处 t()。
- **2026-09-08 监控域补齐**：zh-CN/monitor.ts 补 Disk/Processes/Size/Starting/Stopping/Autostart/Logs/Level/Unit/Message/Lines/Following/Current + journald 优先级 Emergency…Other；`formatUptime` 去硬编码"天/小时/分"→ common.ts 时长 key（`{{days}}d {{hours}}h` / `{{hours}}h {{minutes}}m` / `{{minutes}}m`）；zh-TW 同步并修 6 处简体残留。
- **体检遗留硬编码（未抽取）**：`AiPlaceholder.tsx`、`settings-context-sidebar.tsx"正在加载…"`、`environment.ts` note。
- 复查手段：PowerShell 正则扫 `t("...")` 与语言文件集合 diff；测试跑 en（断言英文 key；渲染类测试顶部 `import "@/i18n"`）。

## 版本·发布·自动更新（勿回退）
- `package.json` 唯一版本输入；只走 `pnpm version:bump`（禁手改四处）；`pnpm check:versions` 校验。pnpm 固定 9.15.9 只写 `packageManager`；`pnpm/action-setup@v4` 不带 `with: version:`；改依赖必须 `pnpm install --lockfile-only`（CI `--frozen-lockfile`）。
- 发布只走 `.github/workflows/release.yml`（bump→提交→tag→构建；tag 触发 draft，人工 Publish 后进 `latest.json`）。见 `docs/p5.1-updater.md`。
- 自动更新只用官方 `tauri-plugin-updater`（禁前端 fetch 安装包/shell 拉起 exe）；状态机唯一入口 `src/stores/updater-store.ts`（组件禁自调 check()）；重启前过 `update-guard.ts`（取消保持 `restart_required`）。
- **更新失败必须可诊断（2026-09-08，勿回退）**：`UpdateError` 带 `stage`（check/download/verify/install/relaunch，verify 由 signature_* 推断）+ `at`；UI 三行 = 阶段标题（`UPDATE_STAGE_MESSAGES`）+ code 文案 + 脱敏 `Details:` + `Error code:`，配复制错误详情/复制诊断/重试/GitHub 手动下载；诊断包 `lib/updater/diagnostics.ts`（版本/OS/架构/阶段/错误码/脱敏详情/manifest URL/时间，二次 sanitize，禁含私钥-token-路径-sig）。install_failed 规则含 extract/spawn/ShellExecute/access denied/elevation/os error 2|5|740 等。发布验收 `scripts/verify-release.mjs`（MZ 头/SHA256 vs GitHub digest/minisign 公钥验签；VM 全链路为人工清单）。
- **tauri-action 的 latest.json URL 必须重写（2026-09-08 事故，勿删 workflow 步骤）**：它写 `api.github.com/.../releases/assets/<id>`（匿名 401/元数据，非二进制）→ updater 下载必失败报 unknown；workflow 已加 `scripts/rewrite-updater-urls.mjs` 重写步骤（→ `releases/download/<tag>/<file>` 直链 --clobber）。重跑已有 tag 时 git 步骤有 `|| echo` 容错。unknown 类更新错误先看 console `[updater] … failed (unknown)` 后的 detail。

## UI 组件约定
- 右键菜单统一 `useContextMenu()`（右键=顶部功能镜像；全局单例 `closeActiveContextMenu()`）。
- 复制一律 `src/lib/clipboard.ts::copyText()`；点击复制共用 `copy-feedback.tsx`（禁自写计时器）；测试断言用 `data-line`。
- 窗口按钮：macOS 原生（顶栏 `pl-[76px]`）；Win/Linux 自绘 `window-controls.tsx`；平台判定 `src/lib/platform.ts::isMacOS()`。Tauri 平台配置 JSON Merge Patch、数组整体替换。
- 浮层纯白实色（`.glass-panel`）；限高用 `calc(vh)`；CSS 禁写死十六进制背景色，用 `--surface-*/--app` 令牌。
- 面板拖拽统一模式：mousedown→window move/up；**内联 height 会被 Tailwind min-h 压过，高度三件套必须全走 style**。
- lucide v1.x：`AlertTriangle→TriangleAlert`、`Loader→LoaderCircle`；`arr.at(-1)` 不可用（lib<es2022），用 `arr[len-1]`。
- xterm：测量容器禁 padding（FitAddon 裁行）；`.xterm` 禁 user-select（破坏 IME）；非活动 tab `inert`。
- 文件图标：`file-kind.ts` + `vscode-file-icons.ts`（`pnpm icons:regen`）+ @iconify/react 离线，禁联网。
- 服务器列表唯一实现 `src/workbench/server-list/`；测试放被测代码 `test/` 子目录；Windows 写文件保无 BOM。
- **托盘（勿回退）**：点 X=隐藏不退出（`lib.rs` CloseRequested→prevent_close+hide，SSH 会话保持）；左键恢复、右键仅"显示主窗口/退出"（只有 quit 才 `app.exit(0)`）；菜单文案由前端 `use-tray-labels.ts` 经 `tray_set_labels` 下发并随 languageChanged 重发；macOS 靠 `RunEvent::Reopen`；tauri 开 `tray-icon` feature。
- **品牌**：唯一 Logo 源=`public/logo.png`（`pnpm tauri icon public/logo.png`）；favicon 与 AppTopBar 18px 均用 `/logo.png`。

## 终端（勿回退）
- 智能提示 Provider 注册制 `views/terminal/completion/`，禁在 TerminalSuggest/TerminalView 里 if/else；cd 补全只走 `sftpListDir`；写回用 `quotePathSegment`。
- cwd 五源：OSC7 > 成功 cd（exitCode 0）> 受控 pwd 探测（只在空命令行发）> 登录目录；**cd 后无任何标记→`uncertain`**（path 保留旧值+needsProbe=true，下次补全前探测刷新；cd 失败是确定态不标 uncertain）。绝不用提示符猜 cwd。
- 焦点归还：`refocusTerminal()` 只在 activeElement≠textarea 时 focus；commit 后 effect 里捞焦点；每个浮层独立开关，禁合并布尔量。
- 缓存纪律：目录 10s / Docker 15s / 服务 20s / 环境 60s；写命令后目录缓存失效。
- 结果链路：TerminalView→TerminalCommandCoordinator（render rendezvous，缺 session.done 守卫会提前 emit）→TerminalResultDrawer→TerminalSnapshotView（400ms 静默 fallback 标 boundaryReliable=false）。抽屉高度可拖拽（`use-terminal-results.ts` 的 drawerHeight，≤40px 自动收起不持久化；**收起态把手不渲染，只能点按钮恢复，不能拖拽展开**——用户裁决）。
- **手填参数**：`canAutoFill=false` 占位符→`applyKnowledgeHit` 用 `complete.ts::commandBody()` 填命令主体+顶部提示，返回 `noop`（主体已在行上）；paramHint 横幅钉终端**顶部**（实底 `bg-surface-1`、pointer-events-none、**无关闭按钮**，右侧倒计时 5s 自动关，`execute()` 清掉）。
- 增强终端唯一开关 `bls-ops.terminal.enhanced`（**默认开**，仅用户主动关过存 "0" 才关）；字体 `bls-ops.terminal.font`。
- `TerminalView.tsx`（~1100 行）已拆：terminal-preferences/phase、use-terminal-session、use-ssh-keepalive、use-terminal-search、use-terminal-results（唯一提交入口 execute）、terminal-toolbar、terminal-error-banner、use-terminal-menu（右键=工具栏镜像）。改交互先定 hook。

## P4 命令中心/终端
- 安全模型：前端只传 knowledgeId+结构化 params；`ExecKind`→`build_exec`→`capability()` 唯一翻译点；readonly 直接执行、medium 走 ConfirmDialog、high/destructive 不入库。
- 终端与模块两条独立链路：`CapturedResult` 无 rawOutput 别名；禁 ANSI 清洗/自动表格化/adapt_auto。
- 输出适配引擎 `src-tauri/src/output_adapter/` + 渲染器 `views/command-result/`（只按 view 分发，不认命令来源）。严格 JSON：`detect-json.ts` 整段合法才出 Tab；`stripTrailingPrompt()` 不猜 PS1。
- 已删除勿加回：commandAdaptOutput/ContainerTable/StructuredTables/ReadableOutputView。P4.4 软删除移入"删除治理"阶段（见 `docs/p4-acceptance.md`）。

## 远程文件夹 → VSCode（Remote-SSH，2026-09-08）
- 右键远程文件夹 "Open in VSCode"：新域 `commands/vscode.rs`（`vscode_open_remote_folder`）在 `~/.ssh/config` 写标记块 `# bls-ops:begin/end <alias>`（幂等 upsert；alias 冲突时 `<slug>-2` 递增；复用 `editor_sync::find_editor("vscode")` 探测）。key 凭据导出 `~/.ssh/bls-ops/<cred_id>.pem`（unix 0600，Rust 侧不经前端——用户裁决允许）；密码凭据连接时 VSCode 弹框手输。ProxyJump/quickTarget 不显示菜单项。
- Windows `.cmd` 必须经 `cmd /C` + `raw_arg` 显式引号（cmd 解析器不守 MSVCRT 规则）；`Code.exe` 直接 spawn。远程路径复用 `safe::validate_abs_path`（白名单挡引号/空格/&）。不写 `accept-new`——Host key 人工确认铁律由 VSCode/OpenSSH 默认 ask 承担。
- **editor_sync 域后端完整但前端零调用**（远程文件/目录副本→本地编辑器→保存回传 SFTP，locator 支持 VSCode/Cursor/Windsurf/Trae/CodeBuddy）——历史半成品，待接前端做单文件编辑入口。

## 技术要点
- **vite 禁 manualChunks 强拆 node_modules**（2026-09 白屏事故：chunk 成环，生产包 `Cannot set properties of undefined (setting 'Activity')`；分包靠动态 import 边界）。
- WebView2 排查：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--enable-logging`，看 `%LOCALAPPDATA%\com.bls.ops\EBWebView\chrome_debug.log`。CI smoke 只查进程+窗口标题，查不出渲染。
- russh 0.63：`check_server_key` 必须实现；ProxyJump into_stream→connect_stream。UTF-8 跨块：`ssh/utf8_stream.rs::Utf8StreamDecoder`（禁逐块 lossy）；GB18030/Big5 不做假支持。
- React 19 测试：`IS_REACT_ACT_ENVIRONMENT=true`；受控 input 用 native setter；ConfirmDialog 查 document.body；shell/TextPreview 不得导入 CM 符号（破坏代码分割）。
- 并行会话改代码时 tsc/cargo 失败先判归属（对方中间态别代改）；编辑前重读文件。
- **运行中的 app 锁 `target/debug/ops-workbench.exe`**（os error 5）：`cargo test --all-targets`/`cargo build` 链接 bin 会失败；改用 `cargo test --lib --test <目标名>` 或等应用关闭。Windows `0xc0000139`：查 PATH 第三方 OpenSSL/Git DLL 冲突。
