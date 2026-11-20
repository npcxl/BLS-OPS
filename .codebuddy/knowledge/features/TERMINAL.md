# 终端实现与不变式

> 状态：**现行**，对照代码日期 2026-11-20。
> 终端是产品的主界面，也是踩坑最多的地方。这篇只写"现在怎么工作"和"哪些东西不能改回去"。

---

## 1. 组成

| 文件 | 职责 |
|---|---|
| `TerminalView.tsx` | 容器：xterm 实例、布局、工具栏、搜索、右键菜单、文件面板联动 |
| `use-terminal-session.ts` | 连接生命周期、事件订阅、输出写入、断线落地、keepalive 触发 |
| `use-ssh-keepalive.ts` | 周期 `ssh_keepalive`，失联走统一的重连路径 |
| `TerminalCommandCoordinator.ts` | 命令边界状态机：风险识别、stdout/stderr 累积、结果组装（**不解析文本**） |
| `command-boundary.ts` | OSC 133 标记解析，把标记回显从流里剔除 |
| `command-plan.ts` | 提交决策：哪些命令注入标记、哪些留给原生终端 |
| `use-terminal-results.ts` | 唯一提交入口 `execute` + 命令块状态 |
| `terminal-command-blocks.ts` / `TerminalCommandBlocks.tsx` | 命令块的 marker 模型与悬浮复制 UI |
| `remote-cwd.ts` | cwd 追踪（OSC 7 / 成功 cd / 受控 pwd / unknown） |
| `terminal-suggest.ts` / `terminal-ghost.tsx` / `use-terminal-completion.ts` | 内联补全的定位、状态机与数据源 |
| `completion/` | Provider 注册制：命令、路径、服务、Docker、进程、环境变量 |
| `TerminalComposer.tsx` / `use-composer-completion.ts` | 对话式输入条（底部），交互程序运行时把键盘还给终端 |
| `terminal-prompt.ts` | 会话级提示符精简 + OSC 7 上报 |
| `terminal-font.ts` / `use-terminal-font.ts` | 字体（持久化 + CSS 变量 + 广播） |
| `theme.ts` | xterm 主题（ANSI 色与 App 令牌分开） |
| `terminal-output-clean.ts` / `terminal-output-pipeline.ts` | 输出清洗、ANSI 处理、写终端的分片策略 |
| `extract-terminal-snapshot.ts` | 从 xterm 渲染缓冲取快照（marker + `translateToString` + 换行合并） |

后端：`commands/ssh.rs` → `ssh/{manager,handshake,session,shell,decoder,utf8_stream}`。

---

## 2. 连接生命周期

```text
点击服务器 / 快捷连接
  → opsApi.sshConnect（密码/私钥/口令只在这条 IPC 里传一次）
  → Rust：握手 → Host Key 判定 → 需要确认则弹 HostKeyDialog
  → 建立 PTY shell
  → 前端 phase: connecting → connected（状态来自 session-store，不是本地布尔）
  → 连接成功瞬间注入提示符精简（仅一次）
  → 订阅 ssh-output-{id} / ssh-stderr-{id} / ssh-closed-{id}
```

- **不使用 `React.StrictMode`**：开发期 effect 双执行会真实连接两次（`src/main.tsx` 注释写明了原因）。
- 传输断开（`ssh-closed`）由视图决定落地：已连接 → "断开"；握手期 → 错误 + 可重试。不要在 hook 里写死状态，否则握手期中断会永远停在"连接中"。
- 同一切签重复点击只切换、不重建；`reconnectNonce` 只用于"会话已关闭/出错时再点一次"触发重连。
- 编码：`ssh_set_encoding` / `ssh_get_encoding`；UTF-8 跨块由 `ssh/utf8_stream.rs` 解码，GB18030/Big5 不做假支持。
- 每条命令有超时（`DEFAULT_COMMAND_TIMEOUT`），会话断开即取消。

---

## 3. 输出链路

```text
Rust：PTY 原始字节
  → stdout / stderr 两条独立流（各自的流式解码器）
  → emit ssh-output-{id} / ssh-stderr-{id}
  → 前端 parser 剔除 OSC 标记与注入行回显
  → writeOutputParts 分片写 xterm（保持事件与文本的先后顺序）
  → xterm 渲染（用户看到什么，快照就抓什么）
```

约束：

- **stdout / stderr 必须分开**：两条流在 Rust 侧各有解码器，事件混用会让命令结果的 stderr 永远为空。
- 事件顺序不能打乱：`BoundaryPart[]` 里 `text` 与 `event` 交错，必须按顺序写；`output_end` 处要先截快照再写后续（否则 D 标记之后的提示符会混进快照尾部）。
- 解析失败不静默：快照不可用时降级为清洗后的原始流，并标 `renderedDegraded`。
- alternate screen（vim/top/less）不渲染命令块，也不做结构化解析。

---

## 4. 命令提交与边界

唯一入口是 `use-terminal-results.ts::execute`。提交计划由 `command-plan.ts::planCommandSubmission` 决定：

| 命令类型 | 处理 |
|---|---|
| 交互式全屏程序（vim / top / less / watch / man / ssh / mysql…） | 留在原生终端，不注入标记（标记会被当成按键） |
| 会吞 stdin 的程序（无参数 `cat`、REPL、`mysql`、`psql`…） | 不注入标记（标记会被当成输入） |
| `cd` 家族 | stdout 恒空，**必须注入 `MARKER_D_LINE`** 拿退出码（tracked cwd 的唯一硬依据）；但不产生结果面板 |
| 其余命令 | 注入 OSC 133 C/D 标记，捕获输出 |

边界来自 **OSC 133 Shell Integration**，不是"静默 400ms 猜结束"：

```text
printf '\033]133;C\007'          → 输出开始
<用户命令>                        → 命令本身从不改写
printf '\033]133;D;%d\007' $?     → 输出结束 + 退出码
```

因此 command start / output start / output end / exit code / duration 都是测出来的。慢命令不会被截断，密集输出不会被腰斩。

- `NO_MARKER_FAILSAFE_MS` 只是护栏：标记始终不来时兜底收场，并在结果里可见说明。
- 不重复执行：协调器只组装结果，**从不执行命令**。
- 结果抽屉（终端下方结果面板）已按用户要求移除，别再加重；捕获链路与命令块仍需保留。

---

## 5. cwd 与文件面板跟随

cwd 只来自可信来源（`remote-cwd.ts`），**绝不从提示符文本猜**：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | OSC 7 | shell 自己上报，最准；提示符精简会顺带上报 |
| 2 | tracked `cd` | 只有命令退出码 0 才更新 |
| 3 | 受控 `pwd` 探测 | 前两条都没有时，只在空命令行发 |
| 4 | 登录目录 | 连接初始值 |
| — | `unknown` | 补全如实说"不知道当前目录"，不猜、不读本地 |

- `uncertain` 标记：提交了 `cd` 但既没等到 D 也没等到 OSC 7 → 路径保留旧值，但下一次补全前会探测。
- 文件面板跟随（`onCwdConfirmed`）只有两个来源：OSC 7 值**发生变化**；或 `cd` 确认成功（退出码 0）。
- 三条禁止：
  1. 面板不能用命令原文拼自己的 cwd 相对路径；
  2. **禁止提交时乐观跟随**（`cd opt` 打错字会跳进不存在的目录）；
  3. 禁止在 `setFromOsc7` 里无条件作废 `pending`（一次 `cd` 的输出顺序是 OSC 7 先到、D 标记后到，作废会让面板再也不跟随）。

---

## 6. 补全与输入

- 数据源：Provider 注册制（`completion/registry.ts`）。新增补全类型 = 注册新 Provider，**禁止**在 `TerminalSuggest` / `TerminalView` 里写 if/else。
- `cd` 补全由 Provider 接管：只提示 directory + symlink，走 `sftpListDir`，写回用 `quotePathSegment`。
- 统一状态机（终端与命令中心共用一套）：

| 状态 | 行为 |
|---|---|
| collapsed（只有行内 ghost） | 灰字 + Tab 徽标，`pointer-events-none`，绝不弹面板 |
| Tab / ↓ | 接受第一条并展开（面板唯一出现方式） |
| collapsed + Enter | **原样提交用户输入**（补全是建议，不是强制；绝不"回车跑第一条候选"） |
| expanded：↑↓ | 移动候选 |
| expanded：Enter | 执行当前项 |
| expanded：Tab / → | 填入 |
| expanded：Esc / ← | 只收起面板，**不动已填入内容** |
| collapsed 无面板：Esc | 清空整行 |

- 命令中心是**启动器**：collapsed Enter 固定 `hits[0]`，与终端语义不同，不要一起改。
- 程序性写行（历史、重运行、补全填入）先设 `programmaticDraftRef` 再 `setDraft`。
- 对话式输入条：终端默认 `disableStdin`，键盘在底部输入条；只有交互程序运行时才把键盘还给终端。
- 浮层/横幅不得遮挡命令行与输入区；不能自动填的参数降级为"填入 + 提示"，绝不吞成死胡同。

---

## 7. 命令块

- 起点 = 提交时注册的 xterm `IMarker`；终点 = 结果产出时再注册一个 marker（此时输出已写完、提示符尚未回写）。
- 存 marker 而不是行号：回滚缓冲 trim 后行号会整体前移，marker 由 xterm 跟随 trim，行被淘汰后 `line = -1`，块随之隐藏。
- 单个块只允许一个进行中的命令；新命令作废旧块（置 `finished`，退出码未知）。
- 悬浮按钮是唯一可点区域（块本身 `pointer-events-none`）；alternate screen 不渲染。
- 切片前先算 `overflow = length - max`，再切。

---

## 8. 提示符精简

`terminal-prompt.ts`，**默认开**（用户裁决，勿改回默认关）：

- 会话级：只往当前 shell 发一次赋值，不写 `~/.bashrc`，断开即失效。
- `$BASH_VERSION` 门控：zsh/dash/fish 下什么都不发生。
- 用 `\w` 不用 `\W`（只显示末级目录会让人看不出层级）。
- PS1 里嵌 OSC 7，顺带提供权威 cwd。
- 注入行的 `printf '\033[2K\r'` 擦掉服务器首行提示符，只擦不上下移动。
- 只在连接成功瞬间发一次；设置变更从下一次连接生效。**绝不在用户输入时插字**。
- 注入行必须用 `COMPACT_PROMPT_INPUT`（含 `\r`），漏回车会与用户输入粘连、静默写进 PS1。

---

## 9. 主题、字体、搜索

- ANSI 色必须"前景/背景两用"：亮色主题用 VS Code Light+，背景/前景/光标才用 App 令牌；**禁止**把正文色令牌当 ANSI 色（浅色主题下深绿当背景会压暗文字）。`test/theme.test.ts` 兜底。
- 字体只能从设置页改：`terminal-font.ts` 一次做完持久化 + CSS 变量 + 广播；`initTerminalFont()` 在 `main.tsx`。
- 测量容器禁 padding（FitAddon 会裁行）；`.xterm` 禁 `user-select`（破坏 IME）；非活动标签 `inert`。
- 焦点归还 `refocusTerminal()` 只在 `activeElement ≠ textarea` 时 focus；每个浮层独立开关，禁止合并成一个布尔量。
- 终端没有独立搜索面板；命令历史面板（`CommandHistoryPanel.tsx`）支持按关键字过滤。`result-search.ts` 是命令中心 RawStreamView 的共享搜索模块，别跟着终端一起删。

---

## 10. 极核（超能模式）

- 不是标签页，是 **应用级覆盖层**（`src/App.tsx` 渲染 `ExtremeCoreView`），底层 Workbench 保持挂载 —— SSH 会话、滚动位置、草稿都不丢。
- 入口：`extreme-core/enter-extreme.ts`（首页、文件面板、终端、设置 AI 都能进）。
- 任务跑在 Rust 侧（`agent/runner.rs`）：WebView 收起/刷新不中断；前端只收事件与审批。
- 实时日志是独立 SSH 长连接（`extreme_log_*`），与主终端输出互不混流。
- 术语：代码目录叫 `extreme-core`，中文界面叫"极核 / 超能模式"，文档统一用"极核（超能模式）"。

---

## 11. 测试

`src/workbench/views/terminal/test/` 覆盖：边界解析、命令计划、cwd 追踪、补全状态机、输入法、命令块、快照提取、主题、提示符、输出清洗、极核对话/审批/隔离。

Rust 侧：`src-tauri/tests/ssh_e2e.rs` 用进程内 SSH 服务器跑真实 PTY / exec / SFTP；`ssh/tests.rs` 覆盖主机密钥与路径工具。

改终端后至少跑：

```bash
pnpm test -- src/workbench/views/terminal
pnpm build
cd src-tauri && cargo test --lib ssh:: && cargo test --test ssh_e2e
```

---

## 12. 明确不做 / 已移除

- 不加回结果抽屉、`TerminalResultDrawer`、`TerminalSnapshotView`、"重运行"按钮。
- 不加回"增强终端"开关：是否捕获只由命令本身决定。
- 不用提示符猜 cwd，不用静默计时判断命令结束。
- 不在终端里做通用表格识别：只有整段严格是 JSON / JSON Lines 时才额外给 JSON Tab。
