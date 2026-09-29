# BLS-OPS 长期记忆

> 事故过程、复现步骤、逐轮验证记录一律写在 `.codebuddy/memory/YYYY-MM-DD.md`。
> 本文件只保留**跨会话仍然成立的规则**，保持精简。

## 项目定位
Tauri 2 + React 19 + Rust 桌面 SSH 运维工具（Windows 为主）。P0 真 SSH ✓ / P2 监控 ✓ / P3 项目发现 ✓ / P4 命令中心+终端（收口中）/ P5 部署中心：P5.0 底座 ✓、P5.1 制品导入 ✓、P5.2 方案生成（规则引擎+知识库+可选 AI）✓。仓库 github.com/npcxl/BLS-OPS。

## 硬性约定（勿回退）
- `src/main.tsx` 禁 React.StrictMode（双挂载拆 SSH）。禁 Mock 伪装真实状态；未实现显示"未实现"；连接状态一律从 session-store 读。
- domain 模型唯一：DB 类型在 `src/api/ops-api.ts`。Rust→前端 payload camelCase，DB/IPC 载荷 snake_case；枚举值 snake_case 与前端联合类型逐字一致；**"接口正常但不渲染"先 diff 载荷字段名**（dirsize 事故根因）。
- 密码/私钥永不回传前端：只提交 credential_id；Host Key 必须人工确认（首连+指纹变更弹窗）。
- 破坏性操作统一 `components/ui/confirm-dialog.tsx`（禁 window.confirm）；Nginx 先 nginx -t 再 reload。
- 输出适配铁律：raw 永久保留、空输出有效不回落、解析失败必须可见。远程命令字符串只能在 `safe.rs` Capability 枚举拼；校验在网络 I/O 前；前端只传结构化标识。
- **"不弹结果面板" ≠ "不注入标记"**：`cd` 家族 stdout 恒空、不该有结果面板，但**必须**注入 `MARKER_D_LINE` 拿退出码——那是 tracked cwd 唯一硬依据；混成一件事会让 `onCommandEnd` 永不触发、cwd 永久停在登录目录。见 `command-plan.ts::CD_FAMILY`。`fg`/`bg`/`eval`/`source` 绝不注入（会变成前台作业的输入）。
- **SFTP 报错一律经 `sftp_error(path, error)` 翻人话**：禁把协议错误码名原样透给用户；必须带出错路径（确实无路径传 `""`）。
- **交互铁律**：浮层/横幅不得遮挡命令行与输入区；"不能自动填"降级为填入+提示，绝不让回车吞成死胡同（占位符三态 filled|noop|blocked，`hasUnresolvedPlaceholder` 是 SSH 前最后拦截）。
- **统一补全状态机**（终端+命令中心同一套）：默认只有行内 ghost（灰字+Tab 徽标，pointer-events-none，绝不弹面板）；Tab/↓=接受第一条并展开（面板唯一出现方式）；**collapsed Enter=原样提交用户输入**（补全是建议非强制，绝不许"回车跑第一条候选"）；expanded：↑↓ 移动、Enter 执行当前项、Tab/→ 填入、**Esc/← 只收起面板、绝不动已填入内容**；collapsed 无面板时 Esc=清空整行。核心 `terminal-suggest.ts`+`terminal-ghost.tsx`；**程序性写行先设 `programmaticDraftRef` 再 setDraft**。命令中心是**启动器**、collapsed Enter 固定 hits[0]（与终端语义不同，别一起改）。cd 补全：裸 cd 由 Provider 接管（insertText 带前导空格）；只提示 directory+symlink。

## 模块化分层（skill: bls-ops-modular）
- 新 Tauri 命令 → `src-tauri/src/commands/<域>.rs`；新监控指标 → `monitor/`（model→parse 纯函数→collect）。
- Rust 文件超 ~600 行拆 `foo.rs`+`foo/`（不可与 foo/mod.rs 并存），父模块 re-export 保旧路径；子模块 `use super::model::*` 禁 `use super::*`（成环）。
- 前端：领域类型 `src/api/types/<域>.ts`；事件名唯一来源 `src/lib/events.ts`；新视图 `src/workbench/views/<域>/`（~400 行拆目录）；列表行 memo+稳定回调。
- 验证：pnpm build、pnpm test、cargo fmt --check、cargo check/test --all-targets。纯解析函数→固定样本断言（空/超长/缺字段）。
- 改前端后必须 pnpm build + cargo build（generate_context! 编译期嵌 dist）。用户报"没生效"先 diff dist vs exe 时间。构建产物永不入库。

## i18n（natural keys）
- i18next 26：key=英文文案本身，en 空、zh-CN 全量、其余 8 语言尽力（仅 common+workbench），fallbackLng: en、returnEmptyString: false。见 docs/i18n.md。
- 三禁手：①禁 parseMissingKeyHandler；②禁 keySeparator/嵌套；③通用词只进 common.ts，模块文件不重复（同文件同 key 重复=TS1117；zh-CN/index.ts 合并顺序 common 最前）。
- 模式：模块常量存英文 key、渲染处 t()；插值句子在生成点 i18n.t()。不翻：Rust 错误消息、catalog title、远程输出/快照、注释/console/it 名。前端自绘连接状态行走 i18n。
- **复查**：①`t(...)` 扫描必须带词边界 `(?<![A-Za-z])t\("`（否则 `import("@/x")`、`.split(",")` 被误判为 key）；②**间接 key 扫不到**——模块级常量里的 `labelKey:` / `empty=` 绕过正则，已加机械断言 `src/i18n/test/indirect-keys.test.ts`（glob `?raw` 读源码；**禁用 node:fs**，否则 pnpm build 编译失败）；③覆盖不到：`Record<枚举,string>` 值表与函数返回文案，需手工补。渲染类测试顶部 `import "@/i18n"`。

## 版本·发布·自动更新（勿回退）
- `package.json` 唯一版本输入；只走 `pnpm version:bump` + `check:versions`。改依赖必须 `pnpm install --lockfile-only`（CI --frozen-lockfile）。
- 发布只走 `.github/workflows/release.yml`（tag 触发 draft，人工 Publish 后进 latest.json）。自动更新只用官方 tauri-plugin-updater；状态机唯一入口 `src/stores/updater-store.ts`（组件禁自调 check()）；重启前过 update-guard.ts。
- **更新失败必须可诊断**：UpdateError 带 stage(check/download/verify/install/relaunch)+at；UI 三行=阶段标题+code 文案+脱敏 Details+Error code；诊断包 `lib/updater/diagnostics.ts` 二次 sanitize。
- **第二守卫只许跑在下载路径**：install() 的 blockingActivity 复查只在 download 完成后跑一次；downloaded→install 绝不再拦（再拦=静默吞点击="点了没反应"）。
- **tauri-action 的 latest.json URL 必须重写**（它写 api.github.com/.../assets/<id> 匿名 401）：workflow 用 `scripts/rewrite-updater-urls.mjs` 改为 releases/download 直链。
- GitHub REST `GET /releases/tags/{tag}` **不返回 draft**：一律 `GET /releases` 列表+过滤；资产下载用 `gh api .../assets/<id> -H "Accept: application/octet-stream"`；用 jq -e 验语义别只看文件大小。

## UI 组件约定
- 右键菜单统一 useContextMenu()；复制/粘贴一律走 `lib/clipboard.ts`（`copyText`/`readText`）+copy-feedback.tsx，断言用 data-line。
- **禁裸 `navigator.clipboard`**：WebView2 读剪贴板会弹原生权限窗 → 走 `tauri-plugin-clipboard-manager`（Rust 读写）。测试替身 `src/test/setup-clipboard.ts`（vite `test.setupFiles`）mock 插件并转发到 `navigator.clipboard`，保既有 spy 用例有效。
- 窗口按钮：macOS 原生（顶栏 pl-[76px]）；Win/Linux 自绘 window-controls.tsx；平台判定 `lib/platform.ts::isMacOS()`。Tauri 平台配置 JSON Merge Patch、数组整体替换。
- 浮层纯白实色（.glass-panel）；限高 calc(vh)；CSS 禁写死十六进制背景色，用 --surface-*/--app 令牌。**嵌套 flex 里 height 百分比脆弱：面板高度必须全走 style**。
- lucide v1.x：AlertTriangle→TriangleAlert、Loader→LoaderCircle；arr.at(-1) 不可用（lib<es2022）。
- xterm：测量容器禁 padding（FitAddon 裁行）；.xterm 禁 user-select（破坏 IME）；非活动 tab inert。
- 文件图标：file-kind.ts+vscode-file-icons.ts（pnpm icons:regen）+ @iconify/react 离线，禁联网。
- 服务器列表唯一实现 `src/workbench/server-list/`；测试放被测代码 test/ 子目录；Windows 写文件保无 BOM。
- 托盘（勿回退）：点 X=隐藏不退出（SSH 保持）；左键恢复、右键仅"显示主窗口/退出"（只有 quit 才 app.exit(0)）；菜单文案经 tray_set_labels 下发、随 languageChanged 重发；macOS 靠 RunEvent::Reopen。
- 品牌：唯一 Logo 源=public/logo.png。

## 终端（勿回退）
- 智能提示 Provider 注册制 `views/terminal/completion/`，禁在 TerminalSuggest/TerminalView 里 if/else；cd 补全只走 sftpListDir；写回用 quotePathSegment。
- cwd 五源：OSC7 > 成功 cd（exitCode 0）> 受控 pwd 探测（只在空命令行发）> 登录目录；cd 后无标记→uncertain。绝不用提示符猜 cwd。
- **文件面板跟随：只有"目录确实变了"才跳**。主=OSC 7 上报值变化（`RemoteCwdTracker.setFromOsc7` 返回 changed）；备=无 OSC 7 时 `onCommandEnd` 确认成功（exitCode 0）。三禁：①禁面板用命令原文拼自己的 cwd 相对路径；②**禁提交时乐观跟随**（cd 打错字会跳进不存在目录）；③**禁在 `setFromOsc7` 里无条件作废 `pending`**（一次 cd 的输出顺序是 OSC 7 先到→D 标记后到，作废会让面板再也不跟随）。
- 焦点归还 refocusTerminal() 只在 activeElement≠textarea 时 focus；每个浮层独立开关，禁合并布尔量。缓存：目录 10s/Docker 15s/服务 20s/环境 60s；写命令后目录缓存失效。
- **结果抽屉已移除（2026-09-28 裁决，勿加回）**：终端下方不再有命令结果面板、不再累积 CapturedResult；连同删掉 TerminalResultDrawer / TerminalSnapshotView / ResultSearchBar 与"重运行"。`result-search.ts` **是共享模块**（命令中心 RawStreamView 用），别跟着删。捕获链路整体保留（标记注入+快照+知识库），只消费 `boundary.exitCode` 与 `renderedText`。
- 手填参数：canAutoFill=false 占位符→填命令主体+paramHint 横幅钉终端顶部（实底、pointer-events-none、右侧 5s 倒计时），返回 noop。
- **增强终端开关已移除（勿加回）**：是否捕获只由命令本身决定（`command-plan.ts`：交互式/读 stdin/无输出内建命令不捕获），无 `bls-ops.terminal.enhanced`。字体只能从设置页改：`terminal-font.ts`（setTerminalFontId 一次做完持久化+CSS变量+emit）+`hooks/use-terminal-font.ts`，`initTerminalFont()` 在 main.tsx。
- **提示符精简：会话级、默认开（勿改回默认关）**：`terminal-prompt.ts`。注入行必须用 `COMPACT_PROMPT_INPUT`（= `COMPACT_PROMPT_LINE` + `\r`，**漏回车会与用户输入粘连、静默写进 PS1**）；`printf '\033[2K\r'` 擦掉服务器首行提示符（绝不做上下移动）；`$BASH_VERSION` 门控；用 `\w` 不用 `\W`；注入行 `expect([LINE])` 剔除回显且长度 < `MAX_PARTIAL`(128)；只在连接成功瞬间发一次（绝不监听设置变化即时注入）。
- 终端 ANSI 色必须"前景/背景两用"：禁把 App 正文色令牌当 ANSI 色（浅色主题下深绿当背景=暗底压暗字）；亮色用 VS Code Light+，背景/前景/光标才用 App 令牌；`test/theme.test.ts` 兜底。
- TerminalView 已拆：terminal-preferences/phase、use-terminal-session、use-ssh-keepalive、use-terminal-search、use-terminal-results（唯一提交入口 execute）、terminal-toolbar、terminal-error-banner、use-terminal-menu。
- 命令块悬浮复制：`terminal-command-blocks.ts`（块=start/end 两枚 xterm IMarker，回滚 trim 自动跟随）+`TerminalCommandBlocks.tsx`（pointer-events-none 只按钮可点；alternate screen 不渲染）；切片必须先算 `overflow=length-max` 再切。

## P4 命令中心 / P5 部署中心
- P4 安全模型：前端只传 knowledgeId+结构化 params；ExecKind→build_exec→capability() 唯一翻译点；readonly 直接执行、medium 走 ConfirmDialog、high/destructive 不入库。
- 终端与模块两条独立链路；输出适配引擎 `src-tauri/src/output_adapter/` + 渲染器 `views/command-result/`（只按 view 分发）。严格 JSON：detect-json.ts 整段合法才出 Tab。
- 已删除勿加回：commandAdaptOutput/ContainerTable/StructuredTables/ReadableOutputView。
- **P5.0 模型里没有任何自由文本命令字段**：启动方式是带类型枚举 `ServiceRuntime`；计划节点参数是 `params_json`，必须过 `validate::validate_params_json`（禁 `command`/`cmd`/`shell`/`script`/`exec` 键 + 递归拒绝 shell 元字符）。Secret 只有引用（`SecretRef`，无 value 字段）。路径必须绝对且落在 `deploy_root` 内。计划图必须 DAG。P3 的 `projects`/`deployments`（commands_json）**保留但标记 legacy**，不扩展；新模型只经 `confirmed_project_id/path` 关联 P3.8 已确认项目。
- **P5.1 制品导入分层（勿另起一套）**：`deployment/artifact/` = `limits`(上限唯一来源) + `source`(清点+按需读，`ContentSource: Send + Sync`) + `secrets`(扫描，只留掩码证据) + `fingerprint`(内容哈希) + `inspect`(识别) + `tasks`(注册表+流水线) + `remote`(远程清单/上传包装)；DB 在 `db/deployment_import.rs`（migration v10 只存最终态）；IPC 全在 `commands/deployment_center.rs`。
- **P5.1 铁律**：①绝不解压落盘、不 `dlopen`、不 `Command`；②超限**即停**并置 `truncated`（UI 不许说"已扫完"）；③命中密钥只回 `RedactedEvidence`（前 4 + 长度），明文不出扫描函数；④确认/上传前**重算指纹**，对不上直接判失效；⑤识别只出结构化建议（构建只到"工具+脚本**名**"，`package.json` 的脚本体是命令片段、不入模型）；⑥上传走 `sftp_upload_file_atomic`（`.part`→流式→哈希比对→同目录原子改名），目录制品不谎称逐文件校验。
- **i18n 标签值陷阱**：`labels.ts` 的值是 i18n key，`labels.test.ts` 断言 zh-CN/zh-TW 下 `t(label) !== label`。专有名词若英文即译文（如 `Dockerfile`、`Path`、`Risk`）会被判漏翻 → 取值要写成可翻译的短语（`"Dockerfile build"`）或补一条 zh 译文。
- **P5.2 铁律（勿回退）**：①**AI 不是决策来源**——`ProposalAdvisor` 只能加 `Recommendation` 级批注，改不动拓扑/工作流/审批/容量；不合格批注进 `AiReview.rejected`，提供方报错也留痕；**当前 `AI_ADVISOR_ENABLED=false`、`ai_review=null`，界面写"AI 未启用"**，禁模板文案假装分析过。②每条关键结论必带 `Evidence.class`（fact/inference/recommendation/unknown）+ 来源；没证据不许写成事实。③知识库冲突**必须同一 topic 才算冲突**，能用**服务器实时事实/安全策略**裁定就裁定并记依据，裁不了进 `open_questions`（`BlocksPlan`）。④**`ready=false` 时 `workflow.nodes` 必为空**（缺关键字段不出可执行计划）。⑤方案确定性：节点 id = node_key（禁 uuid）、输入/输出哈希把 id 与时间戳归零 → 同输入可逐字节复现、可从库里对账。⑥生产审批**不可关闭**（`production_requires_approval`/`forbid_secrets_in_artifact` 后端钉回，`min_headroom_percent ≥ 10`）。
- **P5.2 校验边界**：document 级禁用键**不含 `args`/`argv`**（`NativeProcess.args` 是 P5.0 合法字段），禁 args 归 `params_json`（P5.0 `validate_params_json` 负责）；`$(`/反引号只扫**会进命令的子树**（services/domains/workflow/recommended_topology），散文不扫（假阳性比漏报更伤信任）。只有 `shell`/`schema` 类违规挡**计划**，能力/路径/密钥/权限/风险挡**批准**。
- **P5.5 AI/知识库铁律**：确定性引擎是唯一决策来源 —— `engine::generate` 永远传 `None`、不碰网络；AI 复核是独立命令 `deployment_proposal_ai_review`（后台任务 + `aiReviewEvent` + 轮询兜底）。`AiSuggestion` 用 `deny_unknown_fields` 严格解析，随后 `merge_into` 逐条拒绝（命令 / 超长 / 伪造引用 / 想改决策对象），被拒内容**留痕**不能静默丢。`output_hash` 会剥掉 AI 层（否则可复现会退化成"同一模型问出同一段话"）。API Key 只进钥匙串（`ai-provider:<id>`）、SQLite 只有 `api_key_ref`、前端只有 `has_api_key`、无读取 IPC。用户知识（BM25 本地检索）只流向提示词，**不进任何决策路径**。迁移版本 v13。
- **P5.3/P5.4 执行铁律**：任何新的远程写操作都必须加进 `safe::Capability`（唯一的命令构造点），再在 `deployment/action/{model,spec,validate}.rs` 声明输入类型/执行契约/语义校验，最后在 `deployment/exec/steps.rs` 落地。`DeploymentAction` 有 29 个变体，输入结构体全部 `deny_unknown_fields`（多写一个 `command` 键就是错误）。环境锁以**环境 id** 为键、暂停中也持锁；非幂等动作（签发证书/提升/回滚）永不自动重试；失败不自动回滚，只给"重试节点 / 从节点继续 / 回滚"三个显式出口；`DatabaseMigration` 编译成 `RequireManualStep`（不执行任何脚本）。
- **P5.2 的 ArtifactAnalysis 入口链**：`ServiceUnit.artifact_id → ArtifactRecord.source_ref → ImportSource::source_ref()` 相同的导入任务（多次取最近）`→ task.inspection → name + source_path 对得上的候选`（`source_path` = `deploy_path` 去掉环境 `deploy_root`；名字对不上只按路径回退）。**对不上就给空事实**，方案如实写"端口未定/健康检查待确认"，绝不猜。规则只在 `ImportSource::source_ref()` 一处。
- **新增 Rust 模块后必须确认父模块已 `pub mod`**：未被引用的文件**根本不参与编译**，`cargo check` 的绿是假绿（P5.2 写了 6000 行才发现 `proposal` 没挂上去）。
- **Rust 模块 `foo.rs` 与 `foo/mod.rs` 并存会 E0761**；动手前先 `search_file` 看目录实况，别只信父模块的 `pub mod` 声明（上一轮 P5.1 就是这样被我覆盖过两个文件的）。

## 远程文件夹 → VSCode（Remote-SSH）
- 右键 "Open in VSCode"：`commands/vscode.rs` 在 ~/.ssh/config 写标记块 `# bls-ops:begin/end <alias>`（幂等 upsert，冲突 `<slug>-2` 递增）；key 凭据导出 ~/.ssh/bls-ops/<cred_id>.pem（unix 0600，Rust 侧不经前端）；密码凭据由 VSCode 弹框手输。ProxyJump/quickTarget 不显示菜单项。
- Windows .cmd 必须经 cmd /C + raw_arg 显式引号；Code.exe 直接 spawn；远程路径复用 safe::validate_abs_path。不写 accept-new——Host key 人工确认由 OpenSSH 默认 ask 承担。
- **editor_sync 域后端完整但前端零调用**（远程副本→本地编辑器→保存回传 SFTP，locator 支持 VSCode/Cursor/Windsurf/Trae/CodeBuddy）——历史半成品，待接前端。

## 技术要点
- **vite 禁 manualChunks 强拆 node_modules**（chunk 成环白屏事故）；分包靠动态 import 边界。
- WebView2 排查：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--enable-logging`，看 %LOCALAPPDATA%\com.bls.ops\EBWebView\chrome_debug.log。russh 0.63：check_server_key 必须实现；UTF-8 跨块用 `ssh/utf8_stream.rs::Utf8StreamDecoder`；GB18030/Big5 不做假支持。
- React 19 测试：IS_REACT_ACT_ENVIRONMENT=true；受控 input 用 native setter；ConfirmDialog 查 document.body；shell/TextPreview 不得导入 CM 符号。
- @uiw/react-codemirror `height="100%"` 只打到 .cm-editor，外层 div 需自己保证定高。
- 并行会话改代码时 tsc/cargo 失败先判归属（对方中间态别代改）；编辑前重读文件。
- **运行中的 app 锁 target/debug/ops-workbench.exe**（os error 5）：cargo test --all-targets/build 链接失败；改用 `cargo test --lib --test <目标>` 或等应用关闭。Windows 0xc0000139：查 PATH 第三方 OpenSSL/Git DLL 冲突。
- 本地调试只用 `pnpm tauri dev`（beforeDevCommand 已含 pnpm dev），别再手工起 Vite（strictPort 会撞 4200）。前端改动走 HMR。
