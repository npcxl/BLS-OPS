# 安全模型

> 状态：**现行**，对照代码日期 2026-11-20。
> 这篇是"为什么这样设计才安全"的说明，不是合规声明。改动任何涉及命令、路径、凭据、上传、执行的代码前先读它。

---

## 1. 威胁模型

桌面运维工具的安全目标很具体：**即使 WebView 被完全控制，也不应该等于拿到所有服务器的 shell**。

| 威胁 | 可能的入口 | 现有对策 |
|---|---|---|
| XSS / 恶意渲染内容 | 终端输出、日志、文件名、Markdown、AI 消息 | CSP 无 `unsafe-eval`；渲染层不拼命令；命令只能由 `Capability` 生成 |
| 恶意服务器 | SSH banner、命令输出、SFTP 响应、主机密钥 | Host Key 人工确认；输出按文本处理；超时与取消；UTF-8 跨块解码 |
| 恶意制品 | zip / tar / tar.gz 路径穿越、压缩炸弹、超大文件 | 只读不落盘、上限即停、路径规范化、指纹绑定 |
| 恶意/被污染的 AI 输出 | 提示注入、伪造工具调用、建议改决策 | Agent 工具白名单 + 风险分级 + 逐条审批；部署 AI 只能批注 |
| 本地其他进程 | 读取配置、IPC 调用 | 凭据在系统钥匙串；IPC 只接受本进程 WebView；导出路径需用户经系统对话框选择 |
| 误操作 | 删库、停生产服务、覆盖文件 | `ConfirmDialog`；回收站；写前备份；环境锁；生产审批 |

明确**不在**范围内的：物理访问、已被管理员权限控制的本地机器、用户主动粘贴恶意命令。

---

## 2. 远程命令：唯一生成点

**规则**：前端只传结构化标识（`session_id`、unit 名、容器名、站点名、绝对路径、项目 id），永不传 shell 字符串。

```text
opsApi.sshExec(...) / serviceAction(...) / dockerContainerAction(...)
   ↓  invoke（结构化参数）
commands/<域>.rs                     参数类型校验（serde）
   ↓
safe::Capability::command()            全仓库唯一把「动作」翻译成命令文本的 match
   ↓  内部先 validate_*，再套写死的模板，插值一律 shell_quote + `--`
remote::run_capability / run_on_linux  先 command()?（校验在网络 I/O 之前），再执行
```

落地细节（`src-tauri/src/safe/`）：

- `capability.rs`：`Capability` 枚举 + 穷尽 `match`；新动作必须加变体、写死模板、声明超时。
- `validate.rs`：`validate_abs_path`、`validate_unit`、`validate_container`、`validate_site_name`、`validate_port`、`validate_lines`、`validate_remote_paths`、`validate_repo_url`、`validate_hostname`、`validate_http_url`、`shell_quote`、`is_within` 等。
- `deploy.rs`：部署步骤白名单校验。
- 三条防御叠加：字符白名单 → 单引号包裹 → 位置参数前加 `--`（防止值被当成选项）。
- 所有命令有超时（`DEFAULT_COMMAND_TIMEOUT` 5s，长任务单独声明），会话断开即取消。

**禁止**：在 `commands/*.rs`、领域模块或前端里用 `format!("…{}…", 用户输入)` 拼命令。

唯一受控例外：超能 Agent（见第 8 节），命令文本只在 `agent/tools.rs` 生成。

---

## 3. 凭据

| 数据 | 位置 | 约束 |
|---|---|---|
| 密码 | 系统钥匙串 | SQLite 只有 `secret_ref`（账户名） |
| 私钥 / 私钥口令 | 系统钥匙串 | 私钥导入只做大小 + 格式校验，只返回内容给 Rust 使用，不落库 |
| AI API Key | 系统钥匙串 | 账户名 `ai-provider:<id>`；SQLite 只有 `api_key_ref`；前端只有 `has_api_key`，**没有读取 IPC** |
| 一次性密码 | 前端标签状态 | 只用于打开会话，Rust 用完即弃，不持久化 |

钥匙串统一走 `src-tauri/src/keyring.rs`：service = `ops-workbench`，account = `secret_ref`。

硬约束：

- **没有任何命令把密钥读回 WebView**。`credential_list` 只返回元数据（`credential_save` 输入密码、输出引用）。
- 删除凭据时同时删钥匙串条目；改密码时先写新引用再删旧引用。
- 备份（`backup/`）**只导出元数据**：`secret_ref` / `passphrase_ref` 一律清空，导入后需要重新绑定凭据。
- 日志、审计、错误消息都不得包含密钥；错误只到"哪个凭据/哪台服务器"。

---

## 4. Host Key

- 首次连接必须人工确认指纹；指纹变化必须重新确认（不是"信任并继续"的静默路径）。
- ProxyJump 时，挑战要指明是**哪一跳**出示的密钥（跳板机与目标机分别校验）。
- 后端 `ssh/host_key.rs` 只做判定（`evaluate_host_key`），信任记录在 `known_hosts` 表。
- 用 OpenSSH 打开远程文件夹（VSCode Remote-SSH）时**不写 `StrictHostKeyChecking=accept-new`**，由 OpenSSH 默认的 ask 承担确认。

---

## 5. WebView 与窗口

`src-tauri/tauri.conf.json` 的 CSP：

```text
default-src 'self';
connect-src 'self' ipc: http://ipc.localhost ws: wss:;
frame-src http: https:;                    ← 极核内置浏览器
img-src 'self' asset: http://asset.localhost data: blob:;
media-src 'self' blob:; worker-src 'self' blob:;
style-src 'self' 'unsafe-inline';
font-src 'self' data:;
script-src 'self' 'wasm-unsafe-eval'       ← 没有 unsafe-eval
```

- 剪贴板必须走 `tauri-plugin-clipboard-manager`（Rust 读写）。WebView2 的 `navigator.clipboard` 每次粘贴都会弹原生授权框，而且拒绝后没有任何可编程处理。
- `tauri-plugin-opener` 只用于"用系统浏览器打开 URL"，不启动安装器、不执行命令。
- 生产构建全局禁用 WebView 原生右键菜单（`src/main.tsx`），减少误触 Reload 丢失会话。
- 每个窗口有独立 capability 清单（`src-tauri/capabilities/`）：主窗口与 `sql-detached-*` 一组，右键菜单、通知窗口各自最小权限。

---

## 6. 文件与路径

- 所有远程路径参数过 `validate_abs_path` / `validate_remote_paths`；部署路径还要 `is_within(deploy_root)`。
- **破坏性 SFTP 操作不先 canonicalize**：否则会跟随符号链接，删掉链接目标而不是链接本身。
- 删除默认进远程回收站（`trash_move`），恢复与永久删除分开；永久删除必须显式确认。
- CSV 导出目标只能来自用户经系统保存对话框选择的路径（`AppState.export_paths` 白名单）；前端不能传任意路径写文件。
- 写入采用流式 + 原子改名；目录大小、上传、下载都可取消。
- 编辑远程文件保存前把旧内容留成本地历史（`editor_history`），可查看/恢复。

---

## 7. 制品导入（P5.1）

上限集中在 `deployment/artifact/limits.rs`（唯一来源，会下发给前端解释拒绝原因）：

| 项 | 上限 |
|---|---|
| 条目数 | 20,000 |
| 单条目解压后 | 512 MB |
| 展开总体积 | 4 GB |
| 压缩比 | 200 |
| 目录深度 | 24 |
| 归档内路径长度 | 1024 |
| 服务候选 | 32 |
| 密钥扫描 | 最多 400 个文件 / 单文件 256 KB / 累计 64 MB |

铁律：

1. **绝不解压落盘、不 `dlopen`、不执行 `Command`**：zip/tar 只按需流式读条目。
2. **超限即停**并置 `truncated`；UI 不许说"已扫完"。
3. 命中密钥只回 `RedactedEvidence`（前 4 位 + 长度），明文不出扫描函数。
4. 确认与上传前**重算指纹**，对不上直接判失效。
5. 识别只出结构化建议：构建信息只到"工具 + 脚本名"，`package.json` 的脚本体是命令片段，不进模型。
6. 上传走 `sftp_upload_file_atomic`（`.part` → 流式 → 哈希比对 → 同目录原子改名）；目录制品不谎称逐文件校验。

---

## 8. 部署与 AI

- 模型层**没有任何自由文本命令字段**：启动方式是带类型的 `ServiceRuntime`；计划节点参数是 `params_json`，过 `validate::validate_params_json`（拒绝 `command`/`cmd`/`shell`/`script`/`exec` 键与 shell 元字符）。
- 执行层是 `DeploymentAction` 类型化枚举，每个动作有独立输入结构体并 `deny_unknown_fields`；多写一个 `command` 键就是反序列化错误。
- Compose 渲染器的输入是结构化规格，没有 `command` / `entrypoint` 字段；只允许对外网关发布端口。
- Secret 只有 `SecretRef`（无 value 字段），执行时从钥匙串取，取完只写文件，不进日志/快照（`exec::redact`）。
- 环境锁以**环境 id**为键，暂停中也持锁；非幂等动作（签发证书/提升/回滚）永不自动重试；失败不自动回滚，只给"重试节点 / 从节点继续 / 回滚"三个显式出口。
- `DatabaseMigration` 编译成 `RequireManualStep`，不执行任何脚本。
- 生产审批**不可关闭**（`production_requires_approval`、`forbid_secrets_in_artifact`、`min_headroom_percent ≥ 10` 由后端钉回）。
- AI 只能加 `Recommendation` 级批注：改不动拓扑/工作流/审批/容量；被拒内容进 `AiReview.rejected` 留痕；提供方报错也留痕；`output_hash` 会剥掉 AI 层，保证方案可复现。
- 用户知识库只流向提示词，**不进任何决策路径**。
- `base_url` 有校验（`deployment/ai/url.rs`）：这是用户自己填的地址，SSRF 的立场是"不做内网探测"，只允许明确协议与主机。

---

## 9. 超能 Agent

Agent 执行的是**模型提出的任意命令**，因此单独一层边界：

- 命令文本只在 `src-tauri/src/agent/tools.rs` 生成；工具只有 `run_shell` / `read_file` / `list_dir` / `write_file`（+ 前端交互工具），没有"任意 IPC"。
- 风险三级：`read`（直接跑）/ `write`（需确认）/ `danger`（需确认，展示影响说明）；`ToolRisk::needs_approval()` 是唯一判定。
- sudo 默认禁用，只有用户显式打开"完全权限"才允许；当前不允许又确实需要 root 时，让用户自己决定。
- `write_file` 先 `cp -a` 备份，**备份失败即中止**，再用 base64 写入（避免内容里的引号/换行破坏命令）；单文件写入上限 128 KiB。
- 路径拒绝相对路径、控制字符与 `..` 段；拼进命令前一律 `shell_quote`。
- 轮数、单命令时长、总时长、输出长度都有上限（`MAX_ROUNDS` / `MAX_COMMAND_SECONDS` / `MAX_TOTAL_SECONDS` / `STEP_OUTPUT_LIMIT`）。
- 同一条命令一次运行只执行一次；重复提交被拦并记为"已跳过"。
- 文件变更以**服务器真实回读**为准生成 Diff，不信任模型自述。
- 任务跑在 Rust 侧：WebView 收起/刷新不中断，但审批仍要用户点。

---

## 10. 审计与可追溯

| 记录 | 表 | 内容 |
|---|---|---|
| 命令历史 | `command_history` | 用户主动执行的命令（终端侧） |
| 审计 | `audit_logs` | 服务器/项目/凭据等管理动作（`record_audit`） |
| 会话 | `ssh_sessions` | 连接与断开时间 |
| 部署运行 | `deployment_runs` / `run_nodes` | 每个节点的状态、时间、输出摘要 |
| 文件变更 | 内存 `ChangeRegistry` | 写前/写后快照与 Diff（不跨进程持久化） |

原则：能定位"谁在什么时候对哪台机器做了什么"，但不记录密钥与完整敏感输出。

---

## 11. 改动前自查

- [ ] 新命令字符串在 `safe/capability.rs`？校验在 I/O 之前？
- [ ] 用户/服务器提供的路径过了 `validate_abs_path` / `validate_remote_paths` / `is_within`？
- [ ] 有没有把敏感信息序列化出去？（`ps` 必须用 `comm`，绝不能用 `args`——命令行含密码/token/数据库 URL）
- [ ] 不支持/未安装是否返回 `supported:false` + 原因，而不是零值？
- [ ] 会改服务端状态的操作前端有 `ConfirmDialog`？Nginx 先 `nginx -t` 再 reload？
- [ ] 新能力是否标了正确的 `Capability` 三态与验证等级，而不是"注册了就算支持"？
- [ ] 速率类指标（CPU%、网速）是否两次采样差值？
- [ ] 新增上传/导出是否可取消、有界、失败可诊断？
- [ ] 新增 AI 输入是否只影响"建议"，不影响确定性决策？
