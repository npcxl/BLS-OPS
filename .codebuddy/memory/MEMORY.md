# BLS-OPS 长期记忆

## 项目定位
Tauri 2 + React 19 + Rust 桌面 SSH 运维工具（Windows 为主）。P0 真 SSH ✓ / P2 监控 ✓ / P3 项目发现 ✓ / P4 命令中心+终端（收口中）/ P5 起：系统基础部署流程 → 删除治理（软删除，已从 P4 移出）→ AI 最后。

## 硬性约定（验收标准，勿回退）
- `src/main.tsx` 禁 React.StrictMode（双挂载拆 SSH 连接）。
- 禁 Mock 伪装真实状态；未实现显示"未实现"；禁假状态字段；连接状态一律从 session-store 读。
- 只保留一套 domain 模型：DB 类型在 `src/api/ops-api.ts`（snake_case 与 Rust 一致）。
- 密码/私钥永不回传前端：只提交 `credential_id`；凭据"私钥+口令"是一组配置。
- Host Key 必须人工确认（首连+指纹变更弹窗）。
- Rust→前端 payload camelCase（`#[serde(rename_all="camelCase")`）；枚举值 snake_case 与前端联合类型逐字一致；事件与命令共用同一结构。**"接口正常但不渲染"先 diff 载荷字段名**（dirsize 事故根因）。
- 破坏性操作统一 `components/ui/confirm-dialog.tsx`（禁 window.confirm）；Nginx 先 `nginx -t` 再 reload。
- 输出适配铁律：raw 永久保留、空输出有效不回落、解析失败必须可见。
- 远程命令字符串只能在 `safe.rs` Capability 枚举拼；校验在网络 I/O 前；前端只传结构化标识。

## 模块化分层（skill: bls-ops-modular）
- 新 Tauri 命令 → `src-tauri/src/commands/<域>.rs`；新监控指标 → `monitor/`（model→parse 纯函数→collect）。
- Rust 文件超 ~600 行拆目录：`foo.rs` 父模块 + `foo/` 子模块（不可与 `foo/mod.rs` 并存），父模块 re-export 保持旧路径不变。
- 前端：领域类型 `src/api/types/<域>.ts`；事件名唯一来源 `src/lib/events.ts`；新视图 `src/workbench/views/<域>/`；视图超 ~400 行拆目录；列表行 memo+稳定回调。
- 验证：`pnpm build`、`pnpm test`、`cargo fmt --all -- --check`、`cd src-tauri && cargo check --all-targets && cargo test --all-targets`。新增纯解析函数 → tests.rs 固定样本断言（空输入/超长/缺失字段/非 Linux）。
- **改前端后必须 `pnpm build` + `cargo build`**：`generate_context!` 编译期把 dist 嵌进 exe，只跑 tsc 不生效；`pnpm tauri dev` 才实时。

## i18n（natural keys）
- i18next 26 + react-i18next 17。key=英文文案本身，`en` 资源为空（缺 key 原样返回且仍插值），`zh-CN` 全量，其余 8 语言尽力，`fallbackLng: en`。默认语言 en。
- 结构：`src/i18n/index.ts`（同步 init + `changeLocale` + `localStorage["bls-ops.locale"]`）+ `locales.ts` + `locales/<code>/<模块>.ts`（zh-CN 12 模块）。规范见 `docs/i18n.md`。
- **三个禁手**：① 禁配 `parseMissingKeyHandler`（会覆盖已插值结果，en 下显示 `{{host}}`）；② 禁配 `keySeparator`／改嵌套结构（含 `.`/`:` 的 key 依赖 `ignoreJSONStructure` 扁平命中）；③ 通用词只进 common.ts。
- 模式：模块常量（MODULE_LABELS/RISK_META/NGINX_KIND_LABELS/fileKind label/hex MAGIC…）**存英文 key、渲染处 t()**；含插值句子在**生成点** `i18n.t()`；纯 TS 用 `import { i18n } from "@/i18n"`。
- 不翻：Rust 错误消息（透传）、知识库 Rust catalog 的 title、xterm `write` 内容、远程输出、注释/console/it 名。
- 测试跑 en：断言写英文 key 字面量；mock 后端错误保持中文；渲染类测试顶部加 `import "@/i18n"`。

## 版本与发布（勿回退）
- `package.json` 是版本唯一输入；改版本只走 `pnpm version:bump patch|minor|major|X.Y.Z`（`scripts/bump-version.mjs`），禁止手改四处。
- pnpm 版本**只**写在 `package.json` 的 `packageManager` 字段；`pnpm/action-setup@v4` 一律不带 `with: version:`（写了会与 packageManager 冲突直接报错）。
- `pnpm check:versions`（`scripts/check-versions.mjs`）同时校验四处版本一致 + 前后端插件版本同号。
- pnpm 固定 9.15.9（`packageManager` 字段）；改依赖后必须 `pnpm install --lockfile-only`，否则 CI `--frozen-lockfile` 会失败。
- 发布只能走 `.github/workflows/release.yml`：**单工作流**完成 bump→提交→tag→构建（GITHUB_TOKEN 推送不触发其它工作流）；draft release 人工 Publish 后才进 `latest.json`。

## P5.1 自动更新（勿回退）
- 只用官方 `tauri-plugin-updater`；前端禁止 fetch 安装包 / shell 拉起 exe；签名校验无关闭开关，无"仍然安装"。
- 状态机唯一入口 `src/stores/updater-store.ts`；组件不得自己调 `check()`；客户端接口 `src/lib/updater/updater-client.ts`（可注入假实现做测试）。
- 更新签名（minisign，私钥只在 GitHub Secrets）≠ Windows Authenticode 代码签名（未做）。
- 重启前必须过 `src/workbench/updater/update-guard.ts`：活动 SSH / 命令 / 传输 / 未保存文件 / 长任务任一存在即弹确认；取消后保持 `restart_required`，不重复下载。
- 版本四处一致由 `scripts/check-versions.mjs`（`pnpm check:versions`）把关；JS 与 Rust 插件版本号同号并用 `=` 钉死。
- 发布走 `.github/workflows/release.yml`：tag 触发 → 校验 → draft release（`latest.json` 只在 publish 后生效）。详见 `docs/p5.1-updater.md`。

## UI 组件约定
- 右键菜单统一 `useContextMenu()`（一层子菜单）；**右键 = 顶部功能镜像**；全局单例（`closeActiveContextMenu()`）。
- 复制一律 `src/lib/clipboard.ts::copyText()`；点击复制共用 `components/ui/copy-feedback.tsx`（禁自写计时器）；测试断言用 `data-line`。
- 窗口按钮：macOS 原生（`tauri.macos.conf.json`，顶栏留 `pl-[76px]`）；Win/Linux 自绘 `src/workbench/window-controls.tsx`；平台判定 `src/lib/platform.ts::isMacOS()`（函数非常量）。Tauri 平台配置按 JSON Merge Patch 合并、数组整体替换。
- 浮层纯白实色（`.glass-panel`）；**浮层限高用 `calc(vh)`**（max-h-full+padding 百分比链在 WebView2 不生效）；CSS 禁写死十六进制背景色，用 `--surface-*/--app` 令牌。
- lucide v1.x：`AlertTriangle→TriangleAlert`、`Loader→LoaderCircle`；`arr.at(-1)` 不可用（lib<es2022），用 `arr[len-1]`。
- xterm：测量容器禁 padding（FitAddon 裁行）；`globals.css` 禁给 `.xterm` user-select（破坏 IME）；非活动 tab `inert`。
- 文件图标：`src/lib/file-kind.ts`（`fileKind({name,kind,path?})`→iconKey）+ `src/lib/icons/vscode-file-icons.ts`（生成文件，`pnpm icons:regen`）+ @iconify/react 离线渲染，禁联网。
- 服务器列表唯一实现 `src/workbench/server-list/`；分组同名唯一。
- 测试放被测代码目录的 `test/` 子目录；移动测试改写 `"./X"→"../X"`（含目录索引 `"."→".."`）。Rust 测试布局不动（`foo/tests.rs` + `src-tauri/tests/`）。Windows 写文件保无 BOM。
- 拆 1000+ 行大文件：PowerShell 按行区间机械切分（`Get-Content` + `[System.IO.File]::WriteAllText` UTF8 无 BOM）再补 import 表头 + `cargo fmt` 收尾，比手抄安全；子模块用 `use super::model::*`，**不要 `use super::*`（与父模块 `pub use` 成环）**。

## 终端（勿回退）
- 智能提示 Provider 注册制 `views/terminal/completion/`，禁在 TerminalSuggest/TerminalView 里 if/else；cd 补全只走 `sftpListDir`；写回用 `quotePathSegment`。
- cwd 四源优先级：OSC7 > 跟踪 cd（退出码 0 才更新）> 受控 pwd 探测（只在空命令行发）> 登录目录。绝不用 `root@host:~#` 猜提示符。
- 焦点归还：`refocusTerminal()` 只在 activeElement≠textarea 时 focus；**commit 后 effect 里捞焦点**；每个浮层独立开关，禁合并布尔量。
- 缓存纪律：目录 10s / Docker 15s / 服务 20s / 环境 60s；写命令后目录缓存失效。
- 结果链路：TerminalView→TerminalCommandCoordinator（render rendezvous，缺 session.done 守卫会提前 emit）→TerminalResultDrawer→TerminalSnapshotView（xterm 快照方案；400ms 静默 fallback 标 boundaryReliable=false）。
- 增强终端唯一开关：`bls-ops.terminal.enhanced`（**默认开**，只有用户主动关过存 `"0"` 才关；读写在 `terminal-preferences.ts`）；字体 `bls-ops.terminal.font`。
- `TerminalView.tsx`（1084 行）已拆出同目录模块：`terminal-preferences.ts`、`terminal-phase.ts`、`use-terminal-session.ts`（xterm 生命周期大 effect，依赖只留 hasTarget/sessionId，其余走 hostRef）、`use-ssh-keepalive.ts`、`use-terminal-search.ts`、`use-terminal-results.ts`（结果面板状态 + **唯一提交入口** `execute`）、`terminal-toolbar.tsx`、`terminal-error-banner.tsx`、`use-terminal-menu.ts`（右键 = 工具栏镜像）。改交互逻辑先确定落在哪个 hook。

## P4 命令中心/终端
- 安全模型：前端只传 knowledgeId+结构化 params；`ExecKind`→`build_exec`→`capability()` 唯一翻译点；readonly 直接执行、medium 走 ConfirmDialog、high/destructive 不入库。
- 终端与模块两条独立链路（用户裁决）：`CapturedResult` 无 rawOutput 别名；禁 ANSI 清洗/自动表格化/adapt_auto。
- 输出适配引擎 `src-tauri/src/output_adapter/`（model/registry/generic/domain）+ 前端渲染器 `views/command-result/`（只按 view 分发，不认命令来源）。
- 严格 JSON：`detect-json.ts` 整段合法才出 Tab；`stripTrailingPrompt()` 不猜 PS1。
- 已删除勿加回：commandAdaptOutput/ContainerTable/StructuredTables/ReadableOutputView。
- **P4.4 软删除（软删执行/删除记录/可恢复列表/永久删除/回滚）已明确移出 P4**，列入后续"删除治理"阶段（见 `docs/p4-acceptance.md`）。

## 技术要点
- russh 0.63：`check_server_key` 必须实现；ProxyJump into_stream→connect_stream。
- UTF-8 跨块：`ssh/utf8_stream.rs::Utf8StreamDecoder`（禁逐块 from_utf8_lossy）；GB18030/Big5 不做假支持。
- React 19 测试：`IS_REACT_ACT_ENVIRONMENT=true`；受控 input 用 native setter；ConfirmDialog 查 document.body；shell/TextPreview 不得导入 CM 符号（破坏代码分割）。
- 并行会话改代码时 tsc/cargo 失败先判归属（对方中间态别代改）；编辑前重读文件。
- Windows `0xc0000139`：查 PATH 第三方 OpenSSL/Git DLL 冲突。Cargo.lock 无 openssl-sys/libgit2-sys。

## 品牌资产
唯一 Logo 源 = `public/logo.png`（`pnpm tauri icon public/logo.png`）；favicon=`/logo.png`；AppTopBar 左上 `<img src="/logo.png">` 18px。
