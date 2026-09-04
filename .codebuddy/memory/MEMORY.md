# BLS-OPS 长期记忆

## 项目定位
Tauri 2 + React 19 + Rust 桌面 SSH 运维工具（Windows 为主）。P0 真 SSH 工具；P2 监控完成；P3 项目发现完成；P4 命令中心/终端进行中。

## 硬性约定（验收标准，勿回退）
- `src/main.tsx` 禁 React.StrictMode（双挂载拆 SSH 连接）。
- 禁 Mock 伪装真实状态；未实现显示"未实现"；禁假状态字段；连接状态一律从 session-store 读。
- 只保留一套 domain 模型：DB 类型在 `src/api/ops-api.ts`（snake_case 与 Rust 一致）。
- 密码/私钥永不回传前端：只提交 `credential_id`；凭据"私钥+口令"是一组配置。
- Host Key 必须人工确认（首连+指纹变更弹窗）。
- Rust→前端 payload 字段 camelCase（`#[serde(rename_all="camelCase")]`）；枚举值 snake_case 与前端联合类型逐字一致；事件与命令共用同一结构。排查"接口正常但不渲染"先 diff 载荷字段名。
- 破坏性操作统一 `components/ui/confirm-dialog.tsx`（禁 window.confirm）；改服务端状态必须 ConfirmDialog；Nginx 先 `nginx -t` 再 reload。
- 输出适配铁律：raw 永久保留、空输出有效不回落、解析失败必须可见。

## 模块化分层（skill: bls-ops-modular）
- 远程命令字符串只能在 `safe.rs` Capability 枚举拼；校验在网络 I/O 前；前端只传结构化标识（session_id/路径/id）。
- 新 Tauri 命令 → `src-tauri/src/commands/<域>.rs`；新监控指标 → `monitor/`（model→parse 纯函数→collect）；Rust 文件超 ~600 行拆目录：`foo.rs` 父模块 + `foo/` 子模块（不可与 `foo/mod.rs` 并存），父模块 re-export 保持旧路径不变。
- 前端：领域类型 `src/api/types/<域>.ts`；Tauri 事件名唯一来源 `src/lib/events.ts`；新视图 `src/workbench/views/<域>/`；视图超 ~400 行拆目录；列表行 memo+稳定回调。
- 验证：`pnpm build`、`pnpm test`、`cargo fmt --all -- --check`、`cd src-tauri && cargo check --all-targets && cargo test --all-targets`（期望 168 单元 + 17 + 25 + 27 e2e 全绿）。
- 新增纯解析函数 → tests.rs 固定样本断言（含空输入/超长/缺失字段/非 Linux）。

## i18n 国际化（2026-09-04 基础设施定稿）
- **技术栈**：i18next 26 + react-i18next 17（`pnpm add -w` 装的）。**natural keys**：key=英文文案本身，`en` 资源为空（缺 key 原样返回），`zh-CN` 必须全量，其余 8 语言尽力覆盖、`fallbackLng: "en"` 兜底。
- **结构**（用户要求"语言文件单独做"）：`src/i18n/index.ts`（同步 init + `changeLocale` + 持久化 `localStorage["bls-ops.locale"]`）+ `locales.ts`（10 语言：en/zh-CN/zh-TW/ja/ko/es/fr/de/ru/pt-BR，默认 **en**）+ `use-locale.ts` + `locales/<code>/`（**每语言一目录**；zh-CN 内 12 个模块文件 common/workbench/terminal/servers/commandCenter/files/projects/monitor/docker/nginx/settings/errors，index.ts 只做合并）。
- **动态刷新**：`changeLocale()` → localStorage + `i18next.changeLanguage()` → 所有 `useTranslation()` 组件自动重渲染。`main.tsx` 顶层 `import "@/i18n"`（副作用导入，init 先于任何组件）。
- **纯 TS 模块**（无 hook）用 `import { i18n } from "@/i18n"; i18n.t("...")`。**规范落盘 `docs/i18n.md`**（给代理/贡献者）：抽 JSX/title/aria/placeholder/Error/confirm；不抽注释/console/it 名/`terminal.write` 内容/正则；插值只许 `{{name}}`；模块常量存 key 渲染处 t()；测试断言中文→英文 key。
- **并行代理写语言包的防冲突约定**：每代理只许写**自己模块**的 zh-CN 文件（common.ts 只许追加、`zh-CN/index.ts` 禁碰）。`TFunction` 在 react-i18next 17 不再导出（从 i18next 导入或不用类型）。
- **含标点 key 依赖 `ignoreJSONStructure` 默认 true**（i18next v21+：先按扁平 key 整体查找，未命中才按分隔符解析嵌套）——natural keys 大量含 `.`/`:`/`;`（如 "Copy failed. Please check clipboard permission"、"File is {{total}}; …"），扁平命中没问题；**禁配 `keySeparator` / 禁改嵌套语言包结构**，否则含句点 key 会查找失败。
- **`parseMissingKeyHandler: (key) => key` 是禁手**（2026-09-04 修复）：i18next 对 missing key 会先做插值（extendTranslation，源码 L718），handler 的返回值再**覆盖**插值结果（L722）→ 英文默认语言下 `t("...{{host}}", {host})` 显示占位符字面量。i18next 默认行为本身就是"缺 key 原样返回 key 且仍插值"，无需配置 handler（`src/i18n/index.ts` 注释已警示）。
- **范围分配结果**（lib/hooks/stores/api + components 均已完成）：lib/api 层约 130 条进 `zh-CN/errors.ts`；模块级常量（MODULE_LABELS/tab title/MONITOR_INTERVALS/TERMINAL_ENCODINGS/NGINX_KIND_LABELS/RISK_META/MUTABILITY_LABELS/JOURNAL_PRIORITIES/DEPLOY_STATUSES/fileKind label/hex MAGIC）一律**存英文 key、渲染处 t()**（t() 未命中自动回原文，动态文案如 server.name 可安全包装）；priorityLabel/deployStatusLabel 与 preview 的 reason/hint/错误消息在**生成点** `i18n.t()`，消费方无需再包。
- **边界（本轮不做）**：Rust 错误消息仍中文（透传）；知识库命令 title 来自 Rust catalog 数据不翻；发往 xterm 的内容不翻。
- 设置页语言选择器：`settings-context-sidebar.tsx` 外观组 select（native 名展示），该文件是完整 i18n 范本；THEME_OPTIONS/CREDENTIAL_TYPES 常量存 key 渲染处 t()。

## UI 组件约定
- 右键菜单统一 `useContextMenu()`，支持一层子菜单；**右键 = 顶部功能**（面板右键 = 顶部工具栏镜像/超集）。
- **ContextMenu 全局单例**：模块级 `activeMenuClose` 槽 + 打开前 `closeActiveContextMenu()`；服务器列表勿回退成"每实例自治"。
- 复制一律 `src/lib/clipboard.ts` `copyText()`；点击复制共用 `src/components/ui/copy-feedback.tsx`（useCopyFeedback/CopyNotice/clickCopyProps），各视图不许自写计时器；测试断言用 `data-line`。
- 终端选区菜单 `terminal-selection-menu.tsx`：锚点=选区末端，必须 `clampMenuPosition` 钳制容器内。
- 侧栏收起唯一展开入口在 AppTopBar（`hasContextSidebar()`），按钮 `data-tauri-drag-region="false"`。
- 窗口按钮：**macOS 原生**（`tauri.macos.conf.json`，前端不画，顶栏留 `pl-[76px]`）；**Win/Linux 自绘三键** `src/workbench/window-controls.tsx`。平台判定 `src/lib/platform.ts::isMacOS()`（函数非常量，便于测试改 UA）。**Tauri 平台配置按 JSON Merge Patch 合并、数组整体替换**。
- lucide-react v1.x：`AlertTriangle→TriangleAlert`、`Loader→LoaderCircle`；`arr.at(-1)` 不可用（lib<es2022），用 `arr[len-1]`。
- 浮层纯白实色（`.glass-panel`）；限高 calc(vh)；CSS 禁写死十六进制背景色，用 `--surface-*/--app` 令牌。
- ModuleFrame 顶部不放常驻连接角标（用户裁决），异常用横幅；模块页 `useCommandSession(tab)` + workbench-store `MODULE_TAB_TYPES` 注册。
- xterm：测量容器禁 padding（FitAddon 裁行）；`globals.css` 禁给 `.xterm` user-select（破坏 IME）；WorkbenchPane 非活动 tab `inert={!active}`。
- Tauri 拖拽 over 高频事件 ref 短路再 setState。

## 文件图标
`src/lib/file-kind.ts`：`fileKind()→FileIconKey`，EntryIcon 经 `src/lib/icons/vscode-file-icons.ts`（生成文件）+@iconify/react 离线渲染，禁联网。默认 folder 用 fluent-emoji-flat `file-folder`（Windows 黄，用户裁决）。`pnpm icons:regen` 重新生成。

## 监控 P2 / 发现 P3
- 监控命令固定常量表、绝不经 PTY；取消靠 `closed: watch`；死会话即时移除；速率=两次采样差值禁 0 占位；不支持的 OS 返回 `supported:false`+原因。
- 服务判定唯一写表点 `service_catalog.rs`；`DeploymentAdapter` 注册制；未知服务"暂无匹配适配器"。
- 项目发现=部署实例优先；`source_known=false` 绝不伪造路径；已确认项目持久化软删。
- 安全边界：`safe/` 是唯一"动作→命令"翻译点；docker_prune 禁用。

## 测试文件布局（前端）
- 测试放被测代码目录的 `test/` 子目录（`src/lib/test/` 等）；tsconfig include:["src"] 与 vitest glob 自动覆盖。
- 移动测试改写：`from "./X"`→`"../X"`；易漏：目录索引 `from "."`→`".."`、跨行动态 import。
- Windows 写文件保无 BOM：`[System.IO.File]::WriteAllText($p,$c,(New-Object System.Text.UTF8Encoding($false)))`。
- `git mv` 迁移保留历史。Rust 测试布局不动：`module/tests.rs` + `src-tauri/tests/`。

## 服务器列表
唯一实现 `src/workbench/server-list/`：sections.ts（纯逻辑）、use-server-list.ts（乐观+回滚）、ServerListTree 等；两侧栏只是壳。分组同名唯一（db 查重+命令层 validate）。

## 终端智能提示（勿回退）
- 统一 Provider 注册制 `src/workbench/views/terminal/completion/`（types/path-input/registry/scheduler/remote-listing）。加补全=加 Provider，禁在 TerminalSuggest/TerminalView 里 if/else。
- 按光标参数位路由（parseLine→provider.matches）；cd 目录补全只走 `sftpListDir`（禁读本地 FS/解析 ls）；写回用 `quotePathSegment`。
- cwd 四源优先级：OSC7 > 跟踪 cd（退出码 0 才更新）> 受控 pwd 探测（只在空命令行发）> 登录目录。绝不用 `root@host:~#` 猜提示符。
- 环境探测 Rust `env_probe.rs` + `probe_nginx_environment`；多容器必须先选（CompletionItem.container）；reload/restart 走 ConfirmDialog，删除类不生成。
- 焦点归还：`refocusTerminal()` 只在 activeElement≠textarea 时 focus；**commit 后 effect 里捞焦点**；每个浮层独立追踪开关，禁合并成一个布尔量。
- 缓存纪律：目录 10s/Docker 15s/服务 20s/环境 60s；写命令后目录缓存失效；"再按 Enter 执行"用 `filledDraftRef` 判定。

## P4 命令中心/终端（2026-09 重构）
- 安全模型：前端只传 knowledgeId+结构化 params；`ExecKind`→`build_exec`→`capability()` 唯一翻译点；风险 readonly/medium(ConfirmDialog)/high 不入第一批。
- **终端与模块两条独立链路（用户裁决）**：终端结果=xterm 快照方案（CapturedResult 无 rawOutput 别名；OSC 133 边界；400ms 静默 fallback 标 boundaryReliable=false；交互程序不出快照；禁 ANSI 清洗/自动表格化/adapt_auto）。
- 严格 JSON：`detect-json.ts` 整段合法才出 Tab，JSONL 坏行整体 null；`stripTrailingPrompt()` 不猜 PS1（首行剥命令后剩 PS1，末行以它开头即剥）。
- 增强终端=唯一开关（默认关，localStorage `bls-ops.terminal.enhanced`，不设第二个按钮）；字体可选 `terminal-font.ts`（`bls-ops.terminal.font`，不打包字体）。
- 输出流水线 `terminal-output-pipeline.ts`：before→渲染完→抓快照→after；stderr 同队列；快照只信 `write(data,callback)`。
- 链路：TerminalView→TerminalCommandCoordinator（render rendezvous，缺 session.done 守卫会提前 emit）→TerminalResultDrawer→TerminalSnapshotView。
- 建议面板：applySuggestion 返回 AcceptOutcome；候选与输入一致时 completionKeys 返回空串，accept 必须走 submitCurrentLine()，否则回车被吞。
- 已删除勿加回：commandAdaptOutput/ContainerTable/StructuredTables/ReadableOutputView。

## i18n（2026-09-04 全量抽取完成）
- natural keys：key=英文文案；en 资源为空；`src/i18n/index.ts` **禁 parseMissingKeyHandler**（会把已插值结果覆盖回 `{{name}}` 字面量，en 下插值 key 全坏，勿加回）。
- 模块语言文件在 `src/i18n/locales/<code>/<模块>.ts`；通用词只进 common.ts（Confirm/Cancel/Save/Delete/Loading…），模块文件不重复。
- 纯 TS 模块 `import { i18n } from "@/i18n"` + `i18n.t()`；常量存英文 key、渲染处 t()；占位符用 `{{name}}`/`{{count}}`（host 类有文档先例）。
- 测试跑 en：断言写英文 key 字面量；mock 后端错误消息（模拟 Rust）保持中文不翻；渲染类测试文件顶部加 `import "@/i18n"` 防未初始化。

## 品牌资产
唯一 Logo 源 = `public/logo.png`，`pnpm tauri icon public/logo.png` 生成全套到 `src-tauri/icons/`；favicon=`/logo.png`；AppTopBar 左上 `<img src="/logo.png">`（18px，pointer-events-none 可拖窗）。

## 技术要点
- russh 0.63：`check_server_key` 必须实现；ProxyJump into_stream→connect_stream。
- `pnpm tauri dev` 才实时；改前端后必须 pnpm build+cargo build 重嵌 dist。
- React 19 测试：`IS_REACT_ACT_ENVIRONMENT=true`；受控 input 用 native setter；ConfirmDialog 查 document.body；shell/TextPreview 不得导入 CM 符号（破坏代码分割）。
- 并行会话改代码时 tsc/cargo 失败先判归属（对方中间态文件别代改）；编辑前重读文件。
- Windows `0xc0000139`：查 PATH 第三方 OpenSSL/Git DLL 冲突。
- i18n（natural keys，2026-09 起）：`src/i18n/index.ts` **勿配 `parseMissingKeyHandler`**（覆盖已插值结果，英文下显示 `{{host}}` 占位符）；未命中时 i18next 默认返回 key 且仍插值。模块级常量存英文 key、渲染处 t()；测试断言写 key 字面量，**别断言 `{{xxx}}`**；测试勿 import "@/i18n"（未初始化时 t 透传 key= en 行为，且避免耦合并行编辑的语言包）。
