# P5 智能部署中心设计（P5.0 底座 / P5.1 制品导入）

> 这份文档是 P5 的**设计记录**：代码里凡是写着"见 docs/P5_DEPLOYMENT_CENTER_DESIGN.md"
> 的地方都指这里。实现永远以代码为准，这里说明"为什么这样切"。

## 0. 一条主线：把"部署"从命令字符串变成结构化事实

P0–P4 这台工具管的是"在服务器上跑一条命令"。P5 要管的是一件更复杂、也更容易
出事的事：**把一个应用部署上去**。如果继续用命令字符串表达部署，
所有既有的安全边界（`safe::Capability`、输出适配、风险确认）都会被绕过 ——
一条 `bash -c "…"` 就能把前面所有努力作废。

所以 P5 的全部设计都围绕一个约束：

> **模型里不存在任何字段能装下一条自由命令。**

- 服务的启动方式是**带类型的枚举** `ServiceRuntime`
  （`StaticNginx` / `SystemdUnit` / `DockerImage` / `DockerCompose` / `NativeProcess` / `External`）；
- 计划节点的参数是 `params_json`，保存前必须过
  `deployment::validate::validate_params_json`：禁 `command` / `cmd` / `shell` /
  `script` / `exec` 这类**键名**，且递归拒绝任何含 shell 元字符的字符串**值**；
- 识别结果里的"构建/启动建议"只到**工具 + 脚本名 + 入口路径**这一层，
  绝不记录脚本体（`package.json` 的 `"build": "vite build --mode prod"` 里，
  只有键名 `build` 进模型，值是命令片段，不进）。

最终把结构化事实**编译**成动作、再拼成命令，是后续阶段（Workflow Engine）的事，
而且必须**只能**经 `safe::Capability` 拼 —— 与 P4 命令中心同一条翻译路径。

## 1. 分层

```text
src-tauri/src/deployment/
  model.rs        P5.0 领域类型（应用 / 环境 / 服务 / 容量 / 域名 / 配置 / 密钥引用 /
                  制品 / 计划图 / 运行 / 版本）—— 全部 snake_case 跨 IPC
  validate.rs     机械保障：文本白名单、路径围栏、图合法性
  artifact/       P5.1 制品导入与多服务识别
    model.rs        导入任务 / 指纹 / 安全报告 / 识别结果 / 多服务候选
    limits.rs       所有读取上限的唯一来源
    source.rs       安全入口：清点 + 按需读取（ZIP / TAR / 目录 / 单文件）
    secrets.rs      敏感内容扫描（只留存在性 + 掩码证据）
    fingerprint.rs  SHA-256 指纹（文件字节 / 目录清单 / 引用字符串）
    inspect.rs      技术栈 / 构建 / 启动 / 端口 / 健康 / 环境变量名 / 依赖 / 候选
    tasks.rs        任务注册表 + 流水线（进度 / 取消 / 重试）
    remote.rs       服务器目录只读清单 + 上传（.part → 校验 → 原子改名）
  proposal/        P5.2 部署方案生成（详见 docs/p5.2-proposal-engine.md）
    model.rs        方案 / 证据等级 / 假设 / 未知 / 拓扑 / 风险 / 审批 / 回滚 / 指纹
    knowledge.rs    内置知识库（带版本、声明式冲突、事实优先裁定）
    capacity.rs     容量评估（带假设的估算，逐条写明"若不成立会怎样"）
    rules.rs        拓扑评分 / 服务 / 依赖 / 域名 / 风险 / 审批 / 回滚
    workflow.rs     由拓扑推导工作流图（确定性 id、回滚是独立汇点）
    checks.rs       JSON Schema + 无 shell + 能力 / 路径 / 密钥 / 权限 / 风险校验
    ai.rs           可选 AI 增强（只加不改；不合格批注留痕）
    engine.rs       主流程 + 输入/输出哈希（可复现审计）

src-tauri/src/db/
  deployment.rs          P5.0 十五张表（migration v9）
  deployment_import.rs   P5.1 导入任务表（migration v10，只存最终态）
  deployment_proposal.rs P5.2 方案与安全策略（migration v11）

src-tauri/src/commands/deployment_center.rs   P5.0 / P5.1 IPC
src-tauri/src/commands/deployment_proposal.rs P5.2 IPC（生成 / 确认 / 策略）
src/api/types/deployment.ts                  与 Rust 一一对应的 TS 类型
src/workbench/views/deploy/                  基础页面 + 制品导入 + 方案（7 个 Tab）
```

## 2. 安全模型（P5.0）

| 风险 | 拦法 |
| --- | --- |
| 命令注入 | 模型无命令字段；`params_json` 递归拒绝 shell 元字符 |
| 越界写文件 | 服务目录必须落在环境的 `deploy_root` 内（`validate_under_root`） |
| 密钥泄漏 | `SecretRef` 只有引用（Keyring 账户 / 运行时临时文件路径模板），**没有 value 字段**，前端永远读不到明文 |
| 图死循环 | 计划必须是有向无环图（节点 key 唯一 / 无自环 / 无重复边 / 无环） |
| 风险被下调 | `validate_plan_graph` 拒绝把风险或审批要求改低；数据库迁移永远是独立节点且默认需审批 |
| 误删 | 删除一律走 `ConfirmDialog`，级联删除返回**计数**给用户看 |

## 3. 安全模型（P5.1 制品导入）

P5.1 面对的是**不可信输入**（用户上传的压缩包），所以另有一层：

| 攻击 | 拦法 | 结论类型 |
| --- | --- | --- |
| ZIP Slip（`../../etc/cron.d/x`） | 逐段规范化，出现 `..` 直接拒 | `parent_traversal`（Critical） |
| 绝对路径 / 盘符 / UNC | 一律拒 | `absolute_path`（Critical） |
| 符号链接逃逸 | 归档内出现链接即 Critical（不落地、不解引用）；目录来源不跟随软链 | `symlink` / `hardlink` |
| 设备 / FIFO / socket | 拒 | `device_entry` |
| 加密条目 | 拒（读不了内容就无从校验） | `encrypted_entry` |
| 压缩炸弹 | 条目数 / 单文件 / 展开总量 / 压缩比四道上限 | `*_limit` |
| 路径爆炸 | 深度与长度上限 | `depth_limit` / `path_length_limit` |
| 密钥随制品分发 | 私钥 / Token / `.env` / 云凭据 / 包仓库令牌扫描 | `private_key` / `access_token` / … |
| 执行上传内容 | 结构上不可能：不解压落盘、无 `dlopen`、无 `Command`、不反序列化 | — |

三条硬约束：

1. **明文永不离开扫描函数**。命中后立刻生成 `RedactedEvidence`
   （前 4 字符 + 长度 + 模式名），原文随后丢弃；库里、事件里、前端都拿不到。
2. **超限即停，且可见**。任何上限触发都停止读取并置 `truncated`，
   UI 绝不说"已扫完"。
3. **未知就说未知**。检查项三态 `ready` / `unknown` / `blocked`，
   证据不足一律落 `unknown`，绝不默认通过（沿用 `project_readiness` 的伦理）。

## 4. 制品与内容哈希绑定

`ArtifactFingerprint` 如实标注"哈希的是什么"（`basis`）：

| 来源 | 哈希对象 | 为什么 |
| --- | --- | --- |
| 单个文件（ZIP / JAR / 二进制 / Dockerfile） | 文件字节 | 最强：变一点就不同 |
| 目录 | 排序后的清单（路径 + 大小 + 每个文件的 SHA-256） | 目录没有单一字节流；mtime 不参与（重新 checkout 不该让分析失效） |
| 镜像引用 | 引用字符串本身 | 本工具不查 registry，只能对引用负责 |
| 服务器已有目录 | 只读清单（路径 + 大小） | 不下载内容，所以是**弱绑定**，UI 必须标注 |

确认导入与上传前都**重新算一遍指纹**：对不上就直接判"识别结果已失效"，
不写库、不改名、不留下"看起来对其实坏了"的制品。

## 5. 多服务：一个应用，多个服务，每个服务独立制品

识别阶段按"**直接含项目标记的目录**"切根（`package.json` / `pom.xml` /
`Dockerfile` / `docker-compose.yml` / `*.jar` / `index.html` …），
因此 monorepo（`apps/web` + `apps/api`）会得到两个候选而不是一个。

确认时：

- 每个被勾选的候选 → 一个 `ServiceUnit` + 一个 `ArtifactRecord`
  （制品记 `service_unit_id`，各自独立）；
- 候选里的**相对占位路径**（`/dist`、`/api.jar`）在确认时用环境的
  `deploy_root` 补成绝对路径，并过 `validate_under_root` 再落库；
- `external` 候选（数据库 / Redis 这类外部托管）默认**不勾选**：
  本工具只声明依赖与健康检查，不部署它。

## 6. 上传：复用既有 SFTP，只补事务语义

不另起第二套上传通道。`SshSessionManager::sftp_upload_file_atomic`：

```text
本地文件 ──流式分块──▶ <name>.part ──关闭──▶ 比对 SHA-256 ──同目录原子改名──▶ <name>
                                       └─ 不一致：删掉 .part / 已传文件并报错
```

文件夹制品走既有的递归上传（`sftp_upload`），逐个文件**没有**事务语义，
因此 `checksum_verified` 如实置 `false` —— 不谎称校验过。

## 7. 与旧 "P5 foundation" 的关系

P3 的 `projects` / `deployments`（`commands_json` 那套）**保留但标记 legacy**，
不做扩展。新模型与它没有数据往来，唯一交集是
`deployment_service_unit_link_project`：把 P3.8 的已确认项目挂到服务上，
用来回答"这个服务对应服务器上哪个目录"。

## 8. 已知缺口（交给后续阶段）

1. **没有执行**：`deployment_runs` / `release_records` 只有仓储层与只读 IPC，
   没有 Workflow Engine；页面顶部对此有明确说明。
2. **不解析 compose 的完整 YAML**：只读 `services:` 下的服务名 / 镜像 / 端口 /
   `depends_on` / 环境变量名；缩进歧义一律跳过而不是猜。
3. **不做 Docker 镜像 digest 校验**：只对引用字符串负责。
4. **`.tar.bz2` / `.tar.xz` 明确不支持**（没编解码器，报"不支持"而不是静默失败）。
5. **服务器目录来源不读内容**：密钥扫描只覆盖文件名，UI 里如实标注。
6. **性能**：目录指纹逐个文件读一遍（带上限），超大源码目录会命中条目上限并标
   `truncated`；正确做法是指向构建产物（`dist`）或压缩包。
