/**
 * Super Mode (超能模式) — English overrides.
 *
 * The feature's `t()` calls use Chinese keys, so without this file the English
 * UI would fall back to Chinese. Keys must match the source strings exactly
 * (including punctuation and `{{placeholders}}`).
 */
export default {
  "能力来源":
    "Capability source",
  "按内置能力表识别；认不出的模型沿用供应商默认设置，不写任何覆盖值。":
    "Resolved from the built-in capability table; unknown models keep provider defaults with no overrides.",
  "不写可调档位：请求不传思考强度与上下文预算，由供应商决定。":
    "No tunable tiers are written: requests omit reasoning effort and context budget, leaving it to the provider.",
  "只把下面勾选的档位写进配置，请求按这份声明发送。":
    "Only the tiers ticked below are written to the config, and requests follow that declaration.",
  "勾选该模型支持的档位，输入区的菜单只列出这些":
    "Tick the tiers this model supports; the composer menu lists only these",
  "只勾这个模型真实支持的档位；勾了超出窗口的档位，请求会被服务端拒绝。":
    "Only tick tiers the model really supports; tiers beyond its window are rejected by the server.",
  "AI 模型":
    "AI models",
  "模型只审阅部署方案，不会执行任何操作。":
    "Models only review deployment proposals; they never execute anything.",
  "添加模型":
    "Add model",
  "加载中":
    "Loading",
  "还没有模型":
    "No models yet",
  "已停用":
    "Disabled",
  "密钥已保存":
    "Key saved",
  "密钥未保存":
    "Key missing",
  "测试连接":
    "Test connection",
  "设为默认":
    "Set as default",
  "删除模型提供方":
    "Delete model provider",
  "连接成功（{{ms}} 毫秒，{{attempts}} 次尝试）":
    "Connection OK ({{ms}} ms, {{attempts}} attempt(s))",
  "同时从系统凭据管理器中删除 API Key":
    "Also delete the API key from the system credential manager",
  "编辑模型":
    "Edit model",
  "快速添加":
    "Quick add",
  "选一个预设，只需要填 API Key；预设用的是各家的最新别名而不是固定版本，模型 ID 仍然可以改。":
    "Pick a preset and fill in only the API Key; presets use each provider's latest alias rather than a fixed version, and the model ID is still editable.",
  "自定义":
    "Custom",
  "自己填写 Base URL 和模型":
    "Enter your own base URL and model",
  "预设已填好，只差 API Key；保存后仍可在列表里修改。":
    "Preset filled in — only the API Key is needed. You can still edit it from the list after saving.",
  "名称":
    "Name",
  "提供方类型":
    "Provider type",
  "OpenAI 兼容":
    "OpenAI compatible",
  "留空表示沿用已保存的密钥；密钥只写进系统凭据管理器。":
    "Leave empty to keep the saved key. Keys are only written to the system credential manager.",
  "密钥只写进系统凭据管理器，数据库里只保存引用。":
    "The key is written to the system credential manager only; the database keeps a reference.",
  "留空表示沿用已保存的密钥":
    "Leave empty to keep the saved key",
  "超时（秒）":
    "Timeout (seconds)",
  "最大输出 Token":
    "Max output tokens",
  "设为默认模型":
    "Use as default",
  "允许非本机地址使用明文 HTTP":
    "Allow plain HTTP for non-local hosts",
  "仅在完全信任的自建网关上开启。":
    "Only enable this for a trusted self-hosted gateway on your own network.",
  "先填好 Base URL、模型和 API Key":
    "Fill in the base URL, model and API key first",
  "测试中…":
    "Testing…",
  "保存中":
    "Saving",
  "保存":
    "Save",
  "上下文档位":
    "Context tiers",
  "自动识别":
    "Auto detect",
  "手动覆盖":
    "Manual override",
  "由供应商决定":
    "Provider decides",
  "首页":
    "Home",
  "MCP 服务":
    "MCP servers",
  "超能模式": "Super Mode",
  // 能力 / 检查项 / 自选材料类型（数据文件里的 label 用中文当 key）
  "Kubernetes 工作负载": "Kubernetes workload",
  "Docker Compose 服务": "Docker Compose service",
  "静态站点（Nginx 托管）": "Static site (Nginx-hosted)",
  "systemd 服务": "systemd service",
  "普通 Linux 项目": "Plain Linux project",
  "没有明显的技术栈约定": "No clear stack convention",
  "域名解析": "DNS resolution",
  "目录可写": "Directory writable",
  "磁盘余量": "Disk headroom",
  "HTTPS 证书": "HTTPS certificate",
  "上游可达": "Upstream reachable",
  "远程路径": "Remote path",
  "计划步骤": "Plan step",
  "退出全屏": "Exit full screen",
  "退出全屏，回到分栏": "Exit full screen and return to split view",
  "只读：查询直接执行；只有命令确实会写文件、改配置、改服务或删数据时，才请你确认一次。sudo 禁用。":
    "Read-only: queries run directly; you are asked to confirm only when a command really writes files, changes config or services, or deletes data. sudo is disabled.",
  "完全权限：你明确要求的写入、修改与删除（含 sudo、服务重启）直接执行，不再逐条确认；写文件前仍会在同目录留一份带 .bls-bak- 标记的备份。你只要求查询时，执行器会拦下所有写操作，模型只做只读查询。":
    "Full permissions: writes, edits and deletes you explicitly ask for (including sudo and service restarts) run directly without per-step confirmation; before writing a file, a backup carrying the .bls-bak- marker is still kept in the same directory. When you only ask to query, the executor blocks every write and the model stays read-only.",
  "任务": "Task",
  "新任务": "New task",
  "新建任务": "New task",
  "任务历史": "Task history",
  "任务名称": "Task name",
  "给这个任务起个名字": "Name this task",
  "保存名称": "Save name",
  "删除": "Delete",
  "删除这条记录": "Delete this record",
  "关闭": "Close",
  "取消": "Cancel",
  "取消关注": "Stop focusing",
  "取消选择": "Cancel selection",
  "移除": "Remove",
  "复制": "Copy",
  "复制代码": "Copy code",

  "未绑定服务器": "No server bound",
  "服务器": "Server",
  "服务器详情": "Server details",
  "全部服务器": "All servers",
  "返回普通终端，会话与任务都保留": "Back to the terminal — chat and tasks are kept",
  "远程文件": "Remote files",
  "远程工作区": "Remote workspace",
  "收起远程工作区": "Collapse remote workspace",
  "返回远程文件": "Back to remote files",
  "服务预览": "Service preview",
  "打开浏览器失败": "Opening the browser failed",
  "请重新连接任务所属的服务器以浏览此目录。":
    "Reconnect the server this task belongs to in order to browse this folder.",

  "附件": "Attachments",
  "添加到对话": "Add to chat",
  "上传到服务器": "Upload to server",
  "上传中…": "Uploading…",
  "上传失败": "Upload failed",
  "已上传": "Uploaded",
  "会话工作区": "Conversation workspace",
  "简单查询：结果已回到对话，完整过程在「终端 → 执行输出」。":
    "Simple query — the answer is in the chat; raw output lives under Terminal → Execution output.",
  "已完成的步骤与证据都保留：可以让我从失败处继续，不必从头再来。":
    "Finished steps and evidence are kept — I can continue from the failure instead of starting over.",
  "默认模型（{{name}}）": "Default model ({{name}})",
  "下一条使用": "Next message:",
  "当前运行继续用启动时的模型；改选对下一条生效":
    "The running task keeps the model it started with; your choice applies to the next message.",
  "会话工作区标签": "Workspace tabs",
  "拖动调整右栏宽度": "Drag to resize the panel",
  "展开": "Expand",
  "返回分栏": "Back to split",
  "终端内容": "Terminal content",
  "执行输出": "Execution output",
  "手动终端": "Manual terminal",
  "上下文": "Context",
  "上下文范围": "Context scope",
  "当前会话": "This conversation",
  "仅本条": "Only this message",
  "自选": "Selected",
  "输出": "Output",
  "输出形态": "Output style",
  "自动": "Auto",
  "简洁结论": "Short answer",
  "详细说明": "Detailed",
  "结构化结果": "Structured",
  "打开终端": "Open terminal",
  "已选 {{n}} 个": "{{n}} selected",
  "加入上下文": "Add to context",
  "选择 {{name}}": "Select {{name}}",
  "这次会话还没有附件：从输入框的 ＋ 或直接拖进来。":
    "No attachments in this conversation yet — use the + in the composer or drag files in.",
  "这次运行还没有步骤：简单查询不会展开计划，结果直接回到对话。":
    "No steps in this run — simple queries skip the plan and answer in the chat.",
  "建议目录": "Suggested directory",
  "手动终端：命令只在这条 SSH 连接上执行，不会进入 AI 的任务记录。":
    "Manual terminal: commands run on this SSH connection only and never enter the AI task record.",
  "手动终端命令": "Manual terminal command",
  "输入命令，回车执行": "Type a command, press Enter",
  "执行": "Run",
  "（没有输出）": "(no output)",
  "服务器运行面板": "Server runtime panel",
  "运行状态": "Status",
  "服务与容器": "Services & containers",
  "容器": "Containers",
  "没有运行中的容器": "No running containers",
  "运行中的服务": "Running services",
  "没有运行中的 systemd 服务": "No running systemd services",
  "服务器未连接：重新连接后才能看到实时数据。":
    "The server is not connected — reconnect to see live data.",
  "这台系统不支持指标采集": "This system does not expose metrics",
  "CPU": "CPU",
  "负载": "Load",
  "内存": "Memory",
  "磁盘": "Disk",
  "网络 ↓": "Network ↓",
  "网络 ↑": "Network ↑",
  "占用最高的进程": "Top processes",
  "正在分析…": "Analyzing…",
  "等待你确认": "Waiting for your confirmation",
  "正在停止…": "Stopping…",
  "状态待核对": "Needs verification",
  "已停止": "Stopped",
  "状态待核对：这次运行的进度没有拿到，可能仍在服务器上执行。":
    "Needs verification: the progress of this run was lost; it may still be running on the server.",
  "重新核对": "Re-check",
  "关闭提示": "Dismiss",
  "服务器命令面板": "Server command panel",
  "实时日志": "Live logs",
  "命令输出": "Command output",
  "收起面板": "Hide panel",
  "继续跟随": "Resume following",
  "暂停滚动": "Pause scrolling",
  "停止监听": "Stop tailing",
  "过滤日志": "Filter logs",
  "过滤日志…": "Filter logs…",
  "已暂停，新增 {{n}} 行": "Paused — {{n}} new lines",
  "日志连接已中断": "Log connection lost",
  "关闭这条日志": "Close this log",
  "正在连接日志…": "Connecting to the log…",
  "还没有日志": "No log lines yet",
  "已停止监听（服务器上的进程已释放）":
    "Stopped tailing — the remote process has been released",
  "还没有正在看的日志：让我「实时看看某个服务的日志」。":
    "No log is open yet — ask me to watch a service's log.",
  "还没有命令输出": "No command output yet",
  "这条对话没有可用连接，先重新连接服务器。":
    "This conversation has no live connection — reconnect the server first.",
  "这台服务器上没有找到 {{what}}：换个来源再试，或者先让我查一下它怎么跑的。":
    "{{what}} was not found on this server. Try another source, or let me check how it runs first.",
  "已打开 {{what}}": "Opened {{what}}",
  "已打开日志面板，聊天不受影响。":
    "Log panel opened — the conversation keeps working.",
  "本次附带的文件": "Attached in this message",
  "重命名": "Rename",
  "删除对话": "Delete conversation",
  "对话": "Conversation",
  "对话名称": "Conversation name",
  "收起会话列表": "Collapse conversation list",
  "展开会话列表": "Expand conversation list",
  "会话操作": "Conversation actions",
  "运行中": "Running",
  "删除「{{title}}」？（{{server}}）": "Delete \"{{title}}\" ({{server}})?",
  "这条对话里还有任务在运行或等确认：先处理它（或点停止），再删除对话。":
    "This conversation still has a running or pending task — finish or stop it before deleting the conversation.",
  "展开附件文件夹": "Open the attachment folder",
  "附件 · {{n}} 份": "Attachments · {{n}} files",
  "文件操作": "File actions",
  "预览内容": "Preview",
  "详情": "Details",
  "删除附件": "Delete attachment",
  "仅本机": "Local only",
  "正在上传文件：等上传结束后再清空对话。":
    "Uploading files — wait for it to finish before clearing the conversation.",
  "后端没有这次运行的记录：它可能已经结束并被清理。":
    "The backend has no record of this run; it may have finished and been cleaned up.",
  "正在停止当前任务：停止完成后这条消息才能发送。":
    "Stopping the current task — this message can be sent once it finishes stopping.",
  "确认没有送达服务器：{{reason}}。这一步仍在等待你确认。":
    "The confirmation did not reach the server: {{reason}}. This step is still waiting for your decision.",
  "输入框里还有未发送的草稿：先发送或清空，再编辑这条消息。":
    "There is an unsent draft in the composer; send or clear it before editing this message.",
  "按你说的改": "Apply it",
  "按服务器筛选": "Filter by server",
  "未关联服务器": "Unlinked server",
  "这条对话所属的服务器当前未连接：可以查看历史，重新连接后才能继续执行。":
    "The server for this conversation is not connected. You can read the history, but reconnecting is required to continue.",
  "任务仍在执行：等它结束或点「停止」后再重试。":
    "Still running — wait for it to finish or press Stop, then retry.",
  "任务仍在执行：等它结束或点「停止」后再发送。":
    "Still running — wait for it to finish or press Stop, then send.",
  "这条任务已经结束：请重新发送。":
    "This task has already finished — send the message again.",
  "执行中发送": "Send while running",
  "更新当前任务": "Update the current task",
  "完成后发送": "Send after it finishes",
  "已更新当前任务：下一步开始前生效。":
    "Task updated — it takes effect before the next step.",
  "已更新当前任务：下一步开始前生效。当前正在执行：{{step}}":
    "Task updated — it takes effect before the next step. Now running: {{step}}",
  "已收到补充要求：撤回待确认操作，按新要求重新评估。":
    "Received the extra requirement — the pending action is withdrawn and will be re-evaluated.",
  "已收到新的要求，撤回了这条待确认操作。":
    "Received the new requirement; the pending action was withdrawn.",
  "已排队：当前任务结束后自动发送。":
    "Queued — it will be sent automatically when the current task finishes.",
  "已排队：任务结束后发送「{{text}}」":
    "Queued for after the task: “{{text}}”",
  "结论": "Result",
  "结论依据": "Evidence",
  "已验证": "Verified",
  "部分完成": "Partially done",
  "需要补充信息": "Needs more information",
  "继续执行": "Resume",
  "已中断": "Interrupted",
  "从检查点继续：先只读核对已完成的步骤，再继续未完成的部分。":
    "Resuming from the checkpoint: verify the completed steps with read-only checks, then continue.",
  "服务器未连接：重新连接后才能恢复任务。":
    "The server is not connected; reconnect to resume the task.",
  "任务仍在执行：等它结束或点「停止」后再恢复。":
    "Still running — wait for it to finish or press Stop, then resume.",
  "拟改动": "Planned changes",
  "改动前备份": "Backup before change",
  "建议：先 nginx -t 通过，再 reload 并确认站点返回 200":
    "Suggested check: pass nginx -t, reload, then confirm the site returns 200",
  "建议：用 systemctl status 与端口 / 健康检查核对服务":
    "Suggested check: systemctl status plus a port / health check",
  "建议：用 docker ps 与容器健康状态核对":
    "Suggested check: docker ps and container health",
  "建议：重新读取文件核对内容，并检查引用它的服务":
    "Suggested check: re-read the file and inspect the services that use it",
  "建议：执行后用只读命令核对结果（状态 / 端口 / 文件内容）":
    "Suggested check: verify the result with read-only commands (status / port / file content)",
  "没有可重试的失败任务。": "There is no failed task to retry.",
  "正在重试：{{step}}": "Retrying: {{step}}",
  "上一次停在「{{step}}」。如果这一步涉及写文件、改配置或重启服务，先用只读命令核对远端当前状态，确认没有已经生效后再继续；不要盲目重复执行。":
    "The previous attempt stopped at \"{{step}}\". If that step writes files, changes config or restarts a service, first verify the remote state with read-only commands; only continue once you know it did not already take effect. Do not blindly repeat it.",
  "已上传到服务器": "Uploaded to server",
  "已上传到临时目录": "Uploaded to the temp folder",
  "已部署": "Deployed",
  "拖入文件或文件夹": "Drop files or folders",
  "选择文件夹": "Choose a folder",
  "描述你的目标，或拖入文件 / 文件夹": "Describe your goal, or drop files / folders",
  "上传项目文件，或描述你想在这台服务器上完成的任务。":
    "Upload project files, or describe what you want to get done on this server.",
  "下一步，交给超能。": "Next step — leave it to Super Mode.",
  "{{n}} 个文件已就绪，先上传到服务器或直接生成计划。":
    "{{n}} files ready — upload them, or generate a plan right away.",
  "{{n}} 个文件已上传到临时目录，可以直接生成部署计划。":
    "{{n}} files are in the temp folder — you can generate the deployment plan now.",
  "没有可上传的附件。": "No attachments to upload.",
  "部分文件上传失败，见对话里的明细。": "Some files failed to upload — see the details in the chat.",
  "部分文件已跳过": "Some files were skipped",
  "复用 {{n}} 个已存在的文件": "Reused {{n}} existing files",
  "仅本机，确认部署后上传": "Local only — uploaded after you confirm the deployment",
  "只在本机读取，确认部署后才上传": "Read locally only; uploaded after confirmation",
  "超过 {{size}}，只显示元信息": "Over {{size}} — showing metadata only",
  "二进制文件超过 {{size}}，无法上传": "Binary file exceeds {{size}} and cannot be uploaded",
  "输出被截断，只保留前 8 MiB": "Output truncated to the first 8 MiB",

  "清空对话与附件": "Clear chat and attachments",
  "清空这个会话的对话与附件": "Clear this session's chat and attachments",
  "任务执行中，先收起（不会中断）": "A task is running — collapse instead (it keeps running)",
  "正在讨论": "Focusing on",
  "这条消息会重点分析它": "This message will focus on this file",
  "你": "You",
  "模型": "Model",
  "本机提示": "Local note",
  "正在回答…": "Answering…",
  "思考中": "Thinking",
  "仍在执行…": "Still running…",

  "模型与思考强度": "Model & reasoning",
  "默认模型": "Default model",
  "上下文长度": "Context length",
  "思考强度": "Reasoning effort",
  "默认": "Default",
  "低": "Low",
  "中": "Medium",
  "高": "High",
  "按会话记住": "Remembered per conversation",
  "自动（由模型决定）": "Auto (model decides)",
  "预算 {{budget}} · 上限 {{window}}": "Budget {{budget}} · limit {{window}}",
  "模型上限 {{window}}": "Model limit {{window}}",
  "返回模型列表": "Back to model list",
  "使用默认模型": "Use default model",
  "窗口未知：按自动预算裁剪": "Window unknown — trimmed by the automatic budget",
  "MAX = 这个模型的最高档": "MAX = this model's highest level",
  "这个模型不支持设置思考强度": "This model has no reasoning-effort setting",
  "下一条消息生效；正在跑的任务沿用启动时的模型与设置。":
    "Applies to the next message; a running task keeps the settings it started with.",
  "只影响下一次发送。": "Applies to the next message only.",
  "编辑 {{name}} 的设置": "Edit {{name}} settings",
  "上下文长度与思考强度": "Context length and reasoning effort",
  "还没有可用的模型配置：在「设置 → AI」里添加后再来切换。":
    "No model configured yet — add one in Settings → AI, then switch here.",
  "权限": "Permission",
  "查询直接执行；写 / 改 / 删确认一次，sudo 禁用":
    "Queries run directly; writes / changes / deletes ask once, sudo disabled",
  "写入 / 修改 / 删除直接执行，不再逐条确认":
    "Writes, changes and deletes run directly, no per-action approval",
  "描述要做什么，或把文件拖到这里": "Describe what to do, or drop files here",
  "当前上下文约 {{used}} / 输入预算 {{total}}":
    "Context ≈ {{used}} / input budget {{total}}",
  "本任务上下文与用量": "Context & usage for this task",
  "上下文用量": "Context usage",
  "约 {{percent}}% · {{used}} / {{budget}} token": "About {{percent}}% · {{used}} / {{budget}} tokens",
  "任务对话 {{used}} / {{budget}} token（已占 {{percent}}%）":
    "Task conversation {{used}} / {{budget}} tokens ({{percent}}% used)",
  "任务对话 {{used}} / {{budget}} token（已占 {{percent}}%）；本轮实际发送 {{sent}}":
    "Task conversation {{used}} / {{budget}} tokens ({{percent}}% used); sending {{sent}} this round",
  "正在计算上下文用量…": "Calculating context usage…",
  "暂无上下文用量": "No context usage yet",
  "用户目标": "User goal",
  "未记录": "Not recorded",
  "本次材料": "Materials in this request",
  "系统提示 {{tokens}}": "System prompt {{tokens}}",
  "会话历史 {{tokens}}": "Conversation history {{tokens}}",
  "工具调用与结果 {{tokens}}": "Tool calls & results {{tokens}}",
  "附件 {{n}} 个（内容已计入历史）": "{{n}} attachment(s), content counted in history",
  "计划步骤 {{n}} 步": "{{n}} plan step(s)",
  "工具调用 {{n}} 次": "{{n}} tool call(s)",
  "上下文裁剪": "Context pruning",
  "L1 瘦身 {{slimmed}} 条 · L2 折叠 {{folded}} 单元 · L3 丢弃 {{dropped}} 单元":
    "L1 slimmed {{slimmed}} · L2 folded {{folded}} unit(s) · L3 dropped {{dropped}} unit(s)",
  "任务对话 {{before}} → 本轮实际发送 {{after}}":
    "Task conversation {{before}} → sending {{after}} this round",
  "本任务累计": "Task totals",
  "{{requests}} 次请求 · 输入 {{input}} · 输出 {{output}}":
    "{{requests}} request(s) · input {{input}} · output {{output}}",
  "同一段历史会在多次请求里重复计入，所以累计与「当前上下文」不是一回事。":
    "The same history is sent again on later requests, so totals differ from the current context.",
  "消息时间轴": "Message timeline",
  "跳到第 {{n}} 轮：{{question}}": "Jump to turn {{n}}: {{question}}",
  "回复中": "Replying…",
  "风险：{{risk}}": "Risk: {{risk}}",
  "打开原对话": "Open original conversation",
  "原对话已删除": "The original conversation was deleted",
  "暂无结果": "No result yet",
  "任务仍在执行，停止后才能删除。": "The task is still running; stop it before deleting.",
  "任务仍在执行，停止后才能删除": "The task is still running; stop it before deleting",
  "服务器终端": "Server terminal",
  "浏览器": "Browser",
  "向外拖宽右栏": "Drag outward to widen the pane",
  "向右拖动：窗口和右栏一起变宽，聊天区保持宽度；最大化时在窗口内加宽":
    "Drag right: the window and pane grow together while the chat keeps its width; when maximized, the pane grows inside the window",
  "网页区域太小或不可用": "The page area is too small or unavailable",
  "网页区域超出窗口客户区": "The page area exceeds the window client area",
  "网页区域太小或坐标无效": "The page area is too small or its position is invalid",
  "后退": "Back",
  "前进": "Forward",
  "刷新": "Reload",
  "加载中…": "Loading…",
  "在 Chrome 中打开": "Open in Chrome",
  "输入网址，回车打开": "Enter a URL and press Enter",
  "浏览器地址": "Browser address",
  "网址会在这里打开；也可以直接输入地址。":
    "Pages open here; you can also type an address.",
  "只支持 http / https 网址": "Only http / https URLs are supported",
  "文件已不存在：{{path}}": "The file no longer exists: {{path}}",
  "容器日志": "Container logs",
  "服务日志": "Service logs",
  "筛选日志来源": "Filter log sources",
  "切换日志来源": "Change log source",
  "筛选服务 / 容器": "Filter services / containers",
  "没有运行中的服务": "No running services",
  "重新开始监听": "Restart listening",
  "服务器未连接：重新连接后才能查看实时日志。":
    "Server not connected: reconnect to view live logs.",
  "服务器未连接：重新连接后才能打开这个文件。":
    "Server not connected: reconnect to open this file.",
  "这是桌面客户端的本机地址；要访问服务器自己的 127.0.0.1，请先建立端口转发或改用可访问的地址。":
    "This is the desktop client's loopback address; to reach the server's own 127.0.0.1, set up port forwarding or use an address reachable from here.",
  "有新结果": "New result",
  "在右栏「附件」里勾选文件": "Tick files under Attachments on the right",
  "巡检这台服务器，给出结论": "Inspect this server and report back",
  "CPU、内存、磁盘与关键服务": "CPU, memory, disk and key services",
  "排查最近的错误日志": "Check the latest error logs",
  "定位报错并说明原因": "Locate the error and explain it",
  "生成更新部署计划": "Generate an update plan",
  "只生成计划，不执行": "Plan only — nothing runs",
  "输出偏好": "Output style",
  "清空对话": "Clear conversation",
  "清空": "Clear",
  "清空「{{title}}」的消息与附件？服务器上的临时副本也会被清理，无法恢复。":
    "Clear messages and attachments in \"{{title}}\"? Temporary files on the server are removed too; this cannot be undone.",

  "生成部署计划": "Generate deployment plan",
  "部署计划": "Deployment plan",
  "查看步骤": "View steps",
  "收起详情": "Collapse details",
  "步骤": "Steps",
  "日志": "Logs",
  "预检": "Preflight",
  "待确认": "Pending confirmation",
  "待处理": "Needs attention",
  "已完成": "Done",
  "已完成 {{n}}/{{total}} 步": "{{n}}/{{total}} steps done",
  "执行中": "Running",
  "执行中…": "Running…",
  "执行失败": "Failed",
  "失败": "Failed",
  "通过": "Passed",
  "未通过": "Not passed",
  "尚未检查": "Not checked yet",
  "未执行验证": "No verification run",
  "验证结果": "Verification result",
  "全部步骤通过": "All steps passed",
  "第 {{n}} 步失败：{{detail}}": "Step {{n}} failed: {{detail}}",
  "回滚": "Rollback",
  "回滚命令已复制。": "Rollback command copied.",
  "任务已中止": "Task stopped",
  "任务已中止：服务器上的临时文件已清理。":
    "Task stopped — temporary files on the server were cleaned up.",
  "正在停止。当前步骤结束后不会运行后续步骤。":
    "Stopping — remaining steps won't run once the current one finishes.",
  "等待确认后执行": "Waiting for your confirmation",
  "等待补充信息：{{reason}}": "Waiting for more information: {{reason}}",
  "还没有部署步骤": "No deployment steps yet",
  "还没有输出": "No output yet",
  "无输出": "No output",
  "这条记录没有保存步骤": "This record has no saved steps",
  "目标": "Goal",
  "当前": "Now",
  "异常项": "Findings",
  "读取中…": "Loading…",
  "正在检查…": "Checking…",
  "读取失败": "Read failed",
  "探测失败": "Probe failed",
  "预检失败": "Preflight failed",
  "还没有任务记录": "No tasks yet",
  "选一条任务查看详情": "Select a task to see its details",
  "发起一次部署或检测后，这里会留下每一步的真实输出。":
    "Run a deployment or a probe — every step's real output will be kept here.",
  "部署、查询、检测、构建与传输的每一步与真实输出都保存在这里。":
    "Every step and its real output — deploy, query, probe, build and transfer — is kept here.",
  "左侧按类型、状态与服务器筛选；执行中和等待用户的任务会排在前面。":
    "Filter by type, status and server on the left; running and waiting tasks are pinned first.",
  "没有端口映射": "No port mapping",
  "未知镜像": "Unknown image",
  "完全权限": "Full access",
  "只读": "Read-only",
  "尚未取到家目录，先等待预检完成。":
    "Home directory not resolved yet — wait for the preflight to finish.",
  "这台机器上没有正在运行的容器。": "No containers are running on this machine.",
  "没有在服务器上定位到静态站点": "No static site was located on the server",
  "服务器上还没有 ZIP": "No ZIP on the server yet",
  "静态站点更新：{{root}}（不重启共享 Nginx）":
    "Static site update: {{root}} (shared Nginx is not restarted)",
  "可删改，删除前自动备份": "Edit or delete — backed up automatically before writing",
  "可读写，不再逐条确认": "Read & write — no per-step confirmation",

  // ---- Agent 工具步骤与写操作确认 ----
  "危险操作，需要你确认": "This dangerous action needs your confirmation",
  "写入操作，需要你确认": "This write needs your confirmation",
  "影响": "Impact",
  "确认之前，服务器上不会发生任何变化。":
    "Nothing changes on the server until you confirm.",
  "拒绝": "Deny",
  "允许执行": "Allow",
  "读取 {{path}}": "Read {{path}}",
  "列出目录 {{path}}": "List {{path}}",
  "写入 {{path}}": "Write {{path}}",
  "执行命令": "Run command",
  "工具调用": "Tool call",
  "正在分析请求": "Analyzing request",
  "正在使用工具": "Using tools",
  "正在整理结果": "Putting results together…",
  "处理过程": "Activity",
  "工具调用 · {{n}} 次": "Tool calls · {{n}}",
  "已跳过": "Skipped",
  "待执行": "Pending",
  "错误输出": "Error output",
  "在右侧终端查看": "View in terminal pane",
  "{{n}} 个操作": "{{n}} actions",
  "正在执行 {{n}} 个操作": "Running {{n}} actions",
  "{{n}} 个操作 · 等待你的确认": "{{n}} actions · waiting for you",
  "{{n}} 个操作 · {{failed}} 个失败": "{{n}} actions · {{failed}} failed",
  "{{n}} 个操作 · 未执行": "{{n}} actions · not run",
  "{{n}} 个操作 · 已完成": "{{n}} actions · done",
  "危险": "Dangerous",
  "写入": "Write",
  "风险": "Risk",
  "备份": "Backup",
  "等待你的确认": "Waiting for your confirmation",
  "等待你确认：{{command}}": "Waiting for your confirmation: {{command}}",
  "已完成 {{n}} 步": "{{n}} steps done",
  "已停止（停在「{{step}}」）": "Stopped at \"{{step}}\"",
  "正在执行：{{command}}": "Running: {{command}}",
  "正在停止。当前命令执行完后不会再继续。":
    "Stopping — nothing else runs after the current command.",
  "已拒绝这一步，AI 会换一个做法。": "Denied — the AI will try a different approach.",
  "已拒绝这一步。": "This operation was denied.",
  "这一步正在等待确认。要修改要求，可以先拒绝当前操作，再发送这条消息。":
    "This operation is awaiting confirmation. To change the instructions, deny it first and then send your message.",
  "停止请求未能确认，任务可能仍在运行。可以再次尝试停止。":
    "The stop request could not be confirmed. The task may still be running. You can try stopping it again.",
  "这一步已经结束或超时，确认没有生效。":
    "This step already finished or timed out; the confirmation had no effect.",
  "任务状态丢失，请重新发送。": "The task state was lost — please send the message again.",
  "已停止。": "Stopped.",
  "这个文件已经在对话里了。": "This file is already in the conversation.",
  "选择本机文件夹（可选）": "Choose a local folder (optional)",
  "无法读取所选文件夹": "Could not read the selected folder",
  "输出过长，已截断（只保留前 8 MiB）":
    "Output too long — truncated to the first 8 MiB",
  "查看详情": "Show details",
  "文件": "File",
  "命令": "Command",
  "复制回滚命令": "Copy rollback command",
  "实际执行脚本（含 cd 包装与退出码）":
    "Actual script (cd wrapper, exit code, internal markers)",
  "在下方确认后才会执行": "runs only after you confirm below",
  "需要你确认的写入操作": "Write operation awaiting your confirmation",
  "修改 {{path}}": "Modify {{path}}",
  "影响未知：这一步会改动服务器上的内容，具体范围见详情。":
    "Impact unknown — this changes something on the server; see details for scope.",
  "影响未知：无法判断它会改什么，展开详情可以看到完整命令。":
    "Impact unknown — cannot tell what it changes; open details for the full command.",
  "影响未知：无法判断这条命令会改什么，请展开详情核对后再确认":
    "Impact unknown — cannot tell what this command changes; check the details before confirming",
  "这一步要做：{{summary}}": "This step will: {{summary}}",
  "影响：{{impact}}": "Impact: {{impact}}",
  "涉及文件：{{path}}": "File: {{path}}",
  "会先备份到：{{path}}": "Backed up to: {{path}}",
  "要回滚就用：{{command}}": "To roll back: {{command}}",
  "确认继续吗？回复「按你说的改」执行，「先别动」取消。":
    "Continue? Reply \"按你说的改\" to allow, or \"先别动\" to cancel.",
  "已拒绝这一步：服务器上不会有任何变化。":
    "Denied — nothing on the server will change.",
  "今天 {{time}}": "Today {{time}}",
  "昨天 {{time}}": "Yesterday {{time}}",
  "剩余 {{time}}": "Time left {{time}}",
  "超时后任务将停止": "The task stops if this times out",
  "5 分钟内未确认，任务将自动停止。":
    "Without confirmation within 5 minutes, the task stops automatically.",
  "等待当前命令结束：{{title}}": "Waiting for the current command to finish: {{title}}",
  "等待模型连接断开…": "Waiting for the model connection to close…",
  "服务器未连接，重新连接后才能发送": "Server not connected — reconnect to send",
  "服务器未连接：重新连接后才能发送。": "Server not connected: reconnect to send.",
  // —— 首页 / 服务器右键进入超能，以及停止的兜底路径 ——
  "最近的对话": "Recent conversations",
  "还没有超能对话。进入超能模式问第一个问题，这里会出现记录。":
    "No conversations yet. Ask the first question in Super Mode and it shows up here.",
  "未命名对话": "Untitled conversation",
  "还没有可用的服务器：先在服务器列表里添加一台，再进入超能模式。":
    "No server available yet — add one in the server list, then open Super Mode.",
  "这条对话已经不存在，可能已被删除。":
    "This conversation no longer exists; it may have been deleted.",
  "等待确认主机指纹": "Waiting for host fingerprint confirmation",
  "无法连接到 {{name}}，超能模式打不开":
    "Could not connect to {{name}} — Super Mode cannot open",
  "这台服务器已经不在服务器列表里：无法自动重连，请从服务器列表重新进入。":
    "This server is no longer in the server list — reconnect from there.",
  "服务器未连接：发送与执行都不可用。":
    "Server not connected — sending and execution are unavailable.",
  "重新连接": "Reconnect",
  "停止还没有被后端确认：可以再点一次停止，或强制结束这次运行。":
    "The stop has not been confirmed — click stop again, or force-end this run.",
  "强制结束": "Force end",
  "后端已经没有这条运行。": "The backend no longer has this run.",
  "这次运行已经不在后端：已按「已停止」收尾。":
    "This run is no longer in the backend — marked as stopped.",
  "停止请求已发出，但后端还没有确认。可以再点一次停止，或强制结束这次运行。":
    "Stop was sent but the backend has not confirmed. Click stop again, or force-end this run.",
  "已强制结束这次运行：后端不再跟踪它。已经发到服务器上的命令可能仍在执行，请先核对。":
    "This run was force-ended: the backend no longer tracks it. Commands already sent to the server may still be running — verify first.",
  "上一条运行已经结束：这句话按新任务发送。":
    "The previous run has already ended — sending this as a new task.",
  "上次运行已中断：后端没有这次运行的记录。":
    "The last run was interrupted: the backend has no record of it.",
  "连接已经更换，这次运行不会继续；需要时可「继续执行」。":
    "The connection has changed, so this run will not continue; use Resume if needed.",
  // -- 归属 / 队列 / 失败回执 -------------------------------------------------
  "这一步没有继续：{{reason}}": "This step did not continue: {{reason}}",
  "这一步已暂停：{{reason}}": "This step is paused: {{reason}}",
  "这条对话已经不在了，这一步没有执行。":
    "This conversation no longer exists, so the step was not executed.",
  "这条对话没有关联服务器，这一步没有执行。":
    "This conversation is not bound to a server, so the step was not executed.",
  "这条对话的服务器连接已经重建，这一步停在原地：回到原对话重新确认后再继续。":
    "The server connection was rebuilt. This step is parked — go back to the original conversation and confirm before continuing.",
  "这条对话的服务器连接已断开，这一步停在原地：重新连接后再继续。":
    "The server connection is gone. This step is parked — reconnect before continuing.",
  "回复中断": "Reply interrupted",
  "没有送达": "Not delivered",
  "重发": "Resend",
  "重试": "Retry",
  "正在加载变更…": "Loading changes…",
  "编辑器保存": "Editor saves",
  "文件在服务器上已不存在：历史 Diff 与路径仍保留。":
    "The file no longer exists on the server: the historical diff and path are kept.",
  "知道了": "Got it",
  "加载失败": "Failed to load",
  "变更列表加载失败": "Failed to load the change list",
  "这次对话还没有文件变更：AI 写入、编辑器保存或计划上传后，这里会显示预览与实际差异。":
    "This conversation has no file changes yet: AI writes, editor saves and plan uploads show up here with a preview and the actual diff.",
  "能确定目标、读得到前后内容的改动生成逐行 Diff；其余操作只标注路径。":
    "Changes with a known target and readable before/after content get a line-by-line diff; other operations are listed by path only.",
  "已停止：上面是停止前已经生成的内容。":
    "Stopped: the text above is what was generated before stopping.",
  "这次没有开始：{{reason}}": "This run did not start: {{reason}}",
  "补充给当前任务": "Add to the current task",
  "待发送队列": "Send queue",
  "{{n}} 个附件": "{{n}} attachment(s)",
  "这条消息没有发出：检查连接后可以重试。":
    "This message was not sent. Check the connection and retry.",
  "这条对话的服务器未连接：重新连接后才能发送。":
    "This conversation's server is not connected. Reconnect to send.",

  /* ---- 文件变更审阅 ---- */
  "文件变更": "File changes",
  "查看变更": "View changes",
  "查看实际变更": "View actual changes",
  "打开右栏的文件变更：服务器实际回读的差异":
    "Open file changes in the right pane: the diff read back from the server",
  "拟修改": "Proposed",
  "已写入": "Written",
  "无变化": "No change",
  "写入失败": "Write failed",
  "回读失败": "Read-back failed",
  "已拒绝": "Rejected",
  "已撤回": "Withdrawn",
  "已作废": "Superseded",
  "未采集差异": "Diff not captured",
  "无法对比": "Cannot compare",
  "部分成功": "Partially applied",
  "未执行": "Not applied",
  "暂无变更": "No changes",
  "待确认的变更": "Pending changes",
  "本次运行": "This run",
  "上一轮": "Previous turn",
  "运行 {{id}}": "Run {{id}}",
  "选择运行": "Choose a run",
  "筛选文件…": "Filter files…",
  "按路径筛选文件": "Filter files by path",
  "文件变更视图": "File change views",
  "已更改的文件": "Changed files",
  "选择文件": "Choose a file",
  "{{n}} 个文件": "{{n}} file(s)",
  "多台服务器": "Multiple servers",
  "新文件": "New file",
  "修改已有文件": "Modified file",
  "拟修改：还没有执行": "Proposed — not executed yet",
  "实际变更": "Actual changes",
  "无差异可展示": "No diff to show",
  "复制路径": "Copy path",
  "复制备份路径": "Copy backup path",
  "已复制": "Copied",
  "已备份：{{path}}": "Backed up: {{path}}",
  "计划备份：{{path}}": "Planned backup: {{path}}",
  "在远程文件中打开": "Open in remote files",
  "（无文件路径）": "(no file path)",
  "正在加载差异…": "Loading diff…",
  "没有逐行差异。": "No line-by-line diff.",
  "没有差异。": "No differences.",
  "写入完成，但回读内容与写入前完全一致：没有差异。":
    "The write completed, but the file read back identical to before: no differences.",
  "这次操作没有采集到可比对的正文。": "No comparable content was captured for this operation.",
  "敏感内容已脱敏：Diff 里的 *** 是真实值的替代，不是原文。":
    "Secrets are masked: *** in the diff replaces the real value, it is not the original text.",
  "{{n}} 行未修改": "{{n}} unmodified lines",
  "收起未修改的 {{n}} 行": "Collapse {{n}} unmodified lines",
  "共 {{add}} 行新增、{{del}} 行删除": "{{add}} added, {{del}} removed",
  "改动段": "Diff hunk",
  "未采集": "Not captured",
  "无 Diff": "No diff",
  "没有匹配「{{filter}}」的文件。": "No files match \"{{filter}}\".",
  "没有待确认的变更。": "No pending changes.",
  "这次运行没有可展示的文件变更。": "This run has no file changes to show.",
  "已删除": "Deleted",
  "无净变化": "No net change",
  "本轮无文件净变化": "No net file changes in this run",
  "{{n}} 条未确认": "{{n}} unconfirmed",
  "{{n}} 个无净变化": "{{n}} without net change",
  "另有 {{n}} 个文件原样保存或改回原样，已从列表隐藏；需要核对过程请在步骤历史里查看。":
    "{{n}} more file(s) ended up identical to how they started, so they are hidden here — check the step history to audit them.",
  "这次运行没有产生可确认的文件变化。": "This run produced no confirmable file changes.",
  /* 后端算出来的零行变化原因（没有逐行差异时顶替 +0 -0）。 */
  "新增空文件": "New empty file",
  "删除空文件": "Deleted empty file",
  "二进制已修改（只记录指纹与大小）": "Binary file changed (fingerprint and size only)",
  "敏感内容已变化，差异已隐藏": "Sensitive content changed — the diff is hidden",
  "内容已变化，但没有逐行差异": "Content changed, but there is no line-by-line diff",
  "文件超过 256 KB：只确认了大小，未逐行比较":
    "File exceeds 256 KB: only the size was confirmed, no line-by-line diff",
  "目标是目录：只记录存在状态": "Target is a directory: only its existence is recorded",
  "还没有对话：文件变更按对话归属，先开始一条任务。":
    "No conversation yet: file changes belong to a conversation — start a task first.",
  "这次对话还没有文件变更：上传、AI 写入或 shell 改写文件后，这里会显示预览与实际差异。":
    "This conversation has no file changes yet: uploads, AI writes and shell edits show up here with a preview and the actual diff.",
  "能确定目标、读得到前后内容的改动会生成逐行 Diff；其余操作只标注路径。":
    "Changes with a known target and readable before/after content get a line-by-line diff; other operations are listed by path only.",
  "二进制文件：只记录路径，不做逐行比较":
    "Binary file: recorded by path only, no line-by-line diff",
  "服务器未连接：这里展示的是历史快照，可以查看但不能执行。":
    "Server not connected: this is a historical snapshot — readable, but nothing can be executed.",
  "变更内容加载失败（可能已超出保留范围）":
    "Failed to load the change — it may be outside the retention window",
  "文件过大：没有逐行比较，改动的规模见上方状态。":
    "File too large: it was not compared line by line — see the status above for the scale of the change.",
  "原文件在确认前被外部修改：旧预览已作废，已按当前内容生成新的预览，请重新确认。":
    "The original file changed before you confirmed: the old preview is void, a new preview was generated from the current content — please confirm again.",

  /* ---- 审批卡 ---- */
  "已允许 · 已完成": "Allowed · Completed",
  "已允许 · 执行失败": "Allowed · Failed",
  "已允许 · 已跳过": "Allowed · Skipped",
  "已允许 · 正在执行": "Allowed · Running",
  "查看输出": "View output",
  "已拒绝 · 此步骤未执行": "Denied · Step not executed",
  "没有送达服务器：{{reason}}。可以再试一次。":
    "Not delivered to the server: {{reason}}. You can try again.",
  "连接中断": "Connection lost",
  "查看命令与影响": "View command and impact",
  "拒绝执行": "Deny",
  "提交中…": "Submitting…",
  "允许本次": "Allow this time",
  "复制命令": "Copy command",
  "工作目录": "Working directory",
  "实际执行脚本（调试）": "Actual script (debug)",

  /* ---- 输入条 / 模型能力 ---- */
  "该模型未登记上下文档位：请到设置里填上下文窗口":
    "This model has no context budget registered — set its context window in Settings",
  "移除 {{name}}": "Remove {{name}}",
  "该模型未登记能力：请到设置里填上下文窗口与思考强度档位":
    "This model has no capabilities registered — set its context window and reasoning levels in Settings",
  "能力未登记": "Capabilities not registered",

  /* ---- 执行回执 ---- */
  "已请求": "Requested",
  "已成功": "Succeeded",
  "已请求上传 {{n}} 个文件到服务器临时目录":
    "Requested upload of {{n}} files to the server temp directory",
  "上传失败：{{n}} 个文件都没有写成功":
    "Upload failed: none of the {{n}} files were written",
  "已上传 {{n}} 个文件，{{failed}} 个失败":
    "Uploaded {{n}} files, {{failed}} failed",
  "已复用 {{n}} 个文件，{{failed}} 个失败":
    "Reused {{n}} files, {{failed}} failed",
  "已上传 {{n}} 个文件（复用 {{reused}} 个）到服务器临时目录":
    "Uploaded {{n}} files ({{reused}} reused) to the server temp directory",
  "已上传 {{n}} 个文件到服务器临时目录":
    "Uploaded {{n}} files to the server temp directory",
  "已上传 {{n}} 个文件到 {{root}}": "Uploaded {{n}} files to {{root}}",
  "失败 {{n}} 个：{{detail}}": "{{n}} failed: {{detail}}",
  "失败的文件仍只在用户本机，需要的话先修权限/路径再重试。":
    "Failed files remain only on your machine; fix permissions or paths and retry if needed.",
  "文件已按原目录结构落盘，部署时可直接复制，不必重传。":
    "Files are stored with their original directory structure, so deployments can copy them directly instead of re-uploading.",
  "已生成计划": "Plan generated",
  "计划缺少执行所需的信息": "The plan is missing information required to execute",
  "没有可执行的步骤": "No executable steps",
  "{{n}} 个步骤全部通过": "All {{n}} steps passed",
  "{{ok}} 个步骤通过，{{failed}} 个失败":
    "{{ok}} steps passed, {{failed}} failed",
  "{{failed}} 个步骤失败": "{{failed}} steps failed",

  /* ---- 计划 / 部署 / 右栏 ---- */
  "有 {{n}} 个任务可以继续：{{list}}。请指明要继续哪一个。":
    "{{n}} tasks can be resumed: {{list}}. Tell me which one to continue.",
  "已允许执行": "Execution allowed",
  "已拒绝执行": "Execution denied",
  "正在执行": "Running",
  "此步骤未执行": "This step was not executed",
  "按附件生成部署计划": "Generate a deployment plan from the attachments",
  "已生成 {{n}} 个步骤，确认前不会改动服务器。":
    "Generated {{n}} steps; nothing changes on the server before you confirm.",
  "目标目录": "Target directory",
  "会话已断开": "Session disconnected",
  "拿不到家目录，无法写入文件":
    "Cannot resolve the home directory, so the file cannot be written",
  "这一步没有可写入的内容（text / data / sourcePath 都为空）":
    "This step has no content to write (text / data / sourcePath are all empty)",
  "创建目录失败": "Failed to create the directory",
  "备份失败，已取消覆盖：{{detail}}":
    "Backup failed, overwrite cancelled: {{detail}}",
  "从临时目录复制失败": "Failed to copy from the temp directory",
  "临时目录里没有这个文件，本地也没有可写入的内容":
    "The file is not in the temp directory and there is no local content to write",
  "已写入 {{path}}": "Written to {{path}}",
  "步骤缺少命令": "The step has no command",
  "这一步还没得到你的确认：回复「开始吧」我再执行。":
    "This step is not confirmed yet — reply with the go-ahead and I will run it.",
  "会话已变化，计划已失效。请重新生成计划。":
    "The session changed and the plan is stale. Please regenerate it.",
  "还没有取到家目录，先等待预检完成。":
    "The home directory is not known yet; wait for the preflight to finish.",
  "这条任务属于上一次计划，请重新生成计划后再执行。":
    "This task belongs to the previous plan — regenerate the plan before running it.",
  "部署完成：全部步骤通过。": "Deployment complete: all steps passed.",
  "正在停止…当前步骤结束后不会再继续。":
    "Stopping… nothing else runs after the current step.",
  "正在执行部署计划：已完成 {{n}}/{{total}} 步":
    "Running the deployment plan: {{n}}/{{total}} steps done",
  "正在执行部署计划…": "Running the deployment plan…",
  "影响未知：这一步会改动服务器上的内容。":
    "Impact unknown — this step changes something on the server.",
  "这个附件没有可预览的内容（读取失败或已被清理）。":
    "This attachment has no preview (read failed or it was cleaned up).",
  "右侧真实终端还没有输出可以加入。":
    "The real terminal on the right has no output to add yet.",
  "真实终端最近 {{n}} 行": "Last {{n}} lines of the real terminal",
  "已加入本次对话：{{n}} 行终端输出。":
    "Added to this conversation: {{n}} lines of terminal output.",
  "没有需要上传的附件：已经在服务器上了。":
    "Nothing to upload — the attachments are already on the server.",
  "创建临时目录失败": "Failed to create the temp directory",
  "没有可写入的内容": "No content to write",
  "上传失败：{{reason}}": "Upload failed: {{reason}}",
  "docker ps 失败": "docker ps failed",
  "更新现有服务：{{name}}": "Update the existing service: {{name}}",
  "这个容器没有可写的挂载目录":
    "This container has no writable mounted directory",
  "更新 {{name}}：备份 {{dir}} → 解压 → 替换 → 重启 → 验证":
    "Update {{name}}: back up {{dir}} → extract → replace → restart → verify",
  "先拖入 compose.yaml 或项目文件，再生成计划。":
    "Drop compose.yaml or project files in first, then generate a plan.",
  "用这些附件生成部署计划": "Generate a deployment plan from these attachments",
  "没有找到容器 {{name}}：先说清要更新哪个服务，我再列一遍在跑的容器。":
    "No container named {{name}} — tell me which service to update and I will list the running containers again.",
  "已生成 {{name}} 的更新计划（备份 → 解压 → 替换 → 重启 → 验证）。":
    "Generated an update plan for {{name}} (backup → extract → replace → restart → verify).",
  "已按你的要求生成部署计划。":
    "Generated the deployment plan as requested.",
  "已生成部署计划。": "Deployment plan generated.",
  "右侧真实终端打不开：这条会话的终端通道没有起来，重连服务器再试。":
    "The real terminal on the right cannot open: its channel did not come up. Reconnect the server and try again.",
  "已在右侧真实终端开始监听：{{command}}\n最近输出：\n{{tail}}":
    "Started watching in the real terminal on the right: {{command}}\nRecent output:\n{{tail}}",
  "（暂时没有输出，日志一有内容就会出现在终端里）":
    "(No output yet — it will appear in the terminal as soon as the log has content)",
  "还没有可执行的计划，先说明要做什么。":
    "There is no executable plan yet — describe what you want to do first.",
  "计划还没有得到用户确认：请用一句话请用户回复「开始吧」，不要假设已经执行。":
    "The plan is not confirmed yet: ask the user to reply with the go-ahead in one sentence, and do not assume it ran.",
  "在左栏「设置」里配置默认模型与 API Key。":
    "Configure the default model and API key in Settings in the left rail.",
  "回复「重试」重新执行。": "Reply with retry to run it again.",
  "服务器未连接：重新连接后才能使用手动终端。":
    "Server not connected — reconnect to use the manual terminal.",
  "编辑": "Edit",
  "引用": "Quote",
  "在浏览器打开": "Open in browser",
  "选择要更新的服务（{{n}} 个候选）":
    "Choose the service to update ({{n}} candidates)",
  "无端口映射": "No port mappings",
  "等待执行": "Waiting to run",
  "终端": "Terminal",
  "计划": "Plan",
  "执行计划": "Execution plan",
  "收起计划": "Collapse plan",
  "步骤 {{n}}": "{{n}} steps",
  "已全部完成": "All steps done",
  "需要确认的前提": "Premises to confirm",
  "已完成 {{done}} / {{total}} 步": "{{done}} / {{total}} steps done",
  "拖动调整宽度；聚焦后可用左右方向键（Shift 加大步长）":
    "Drag to resize; once focused, use the left/right arrows (Shift for bigger steps)",
  "展开视图": "Expand view",
  "收起右栏": "Collapse the sidebar",
  "服务器未连接：可以查看历史，重新连接后才能继续执行。":
    "Server not connected — history is readable, but reconnect to continue running.",
  "真实终端": "Real terminal",
  "把真实终端的最近输出加进这次发送":
    "Add the real terminal's recent output to this send",
  "加入本次对话": "Add to this conversation",
  "读取失败 · 按路径使用": "Read failed · use by path",
  "二进制 · 按路径使用": "Binary · use by path",
  "已读取 · 在服务器上": "Loaded · on the server",
  "待上传": "Pending upload",
  "已选 {{n}} 个，用于本次发送": "{{n}} selected for this send",

  /* ---- 任务状态 / 历史筛选（值在 t() 里） ---- */
  "、": ", ",
  "检查中": "Checking",
  "等待补充信息": "Waiting for more information",
  "验证中": "Verifying",
  "完成": "Done",
  "全部": "All",
  "部署": "Deploy",
  "检测": "Probe",
  "自动化": "Automation",
  "等待用户": "Waiting for you",

  /* ---- 部署计划步骤标题 ---- */
  "上传 Compose 文件": "Upload the Compose file",
  "准备部署目录": "Prepare the deployment directory",
  "拉取镜像": "Pull images",
  "构建镜像": "Build images",
  "启动服务": "Start services",
  "验证容器状态": "Verify container status",
  "检查 ZIP 布局与站点目录": "Check the ZIP layout and site directory",
  "备份当前站点": "Back up the current site",
  "解压并替换静态文件": "Extract and replace the static files",
  "验证站点响应": "Verify the site responds",
  "校验 ZIP 完整性": "Verify ZIP integrity",
  "备份线上目录": "Back up the live directory",
  "解压到暂存目录": "Extract to the staging directory",
  "替换线上目录内容": "Replace the live directory contents",
  "检查容器状态": "Check container status",
  "验证页面": "Verify the page",
  "清理暂存目录": "Clean up the staging directory",
  "上传 {{name}}": "Upload {{name}}",
  "重启服务 {{name}}": "Restart service {{name}}",
  "没有找到 compose.yaml / docker-compose.yml。请先把它拖进来，或告诉我用别的方式部署。":
    "No compose.yaml / docker-compose.yml found. Drop one in first, or tell me to deploy another way.",
  "compose 文件里没有解析到 services，请检查缩进或内容是否完整。":
    "No services were parsed from the compose file — check the indentation and content.",

  /* ---- 文件改动面板（历史快照） ---- */
  "复制差异": "Copy diff",
  "更改所在运行": "Changed in run",
  "清除筛选": "Clear filter",
  "服务器未连接：只展示历史快照":
    "Server not connected — showing a historical snapshot only",
  "这次写入与写入前一致：没有产生改动。若文件此前已被改过，差异在更早那次运行里。":
    "This write matched the file as it already was — nothing changed. If it was edited earlier, the diff is in that earlier run.",

  /* ---- 执行耗时 / 队列 / 确认后收口 ---- */
  "用时 {{duration}}": "Took {{duration}}",
  "{{n}} 秒": "{{n}}s",
  "{{m}} 分 {{s}} 秒": "{{m}}m {{s}}s",
  "{{m}} 分钟": "{{m}} min",
  "{{h}} 小时 {{m}} 分": "{{h}}h {{m}}m",
  "{{h}} 小时": "{{h}}h",
  "待发送 {{n}} 条": "{{n}} queued",
  "已拒绝 · 未执行": "Rejected — not executed",
  "执行中发送方式": "Sending while running",
  "执行中：补充给当前任务": "While running: steer the current task",
  "执行中：任务完成后发送": "While running: queue after this task",
  "任务执行中，新消息怎么处理": "While a task is running, how should new messages be handled?",
  "下一步开始前生效": "Applies before the next step",
  "当前任务结束后按顺序发送": "Sent in order after the current task finishes",
  "Shell 写入（未采集 Diff）": "Shell write (diff not captured)",
  "命令已经执行，但没有采集到逐行差异（shell 直接改写）。":
    "The command ran, but no line-by-line diff was captured (shell edited the file directly).",
  "收起侧栏": "Collapse sidebar",
  "展开任务列表": "Expand task list",
  "收起任务列表": "Collapse task list",
  "任务列表已收起": "Task list collapsed",
  "任务列表已收起，还有 {{n}} 个任务在后台":
    "Task list collapsed — {{n}} more task(s) running in the background",
  "管理": "Manage",
  "设置": "Settings",
  "返回对话": "Back to chat",
  "模型、上下文能力与对话偏好": "Models, context capabilities and chat preferences",
  "上下文窗口上限（Token）": "Context window limit (tokens)",
  "模型真实支持的窗口上限；下面的预算档位不应超过它。":
    "The model's real context window; keep the budgets below within this limit.",
  "可选上下文预算": "Context budgets",
  "输入区「上下文」菜单里可选的预算；应不超过上面的窗口上限":
    "Budgets offered in the composer; keep them within the context window above.",
  "停用": "Disable",
  "启用": "Enable",
  "该模型未登记上下文档位：请到左栏「设置」里填上下文窗口":
    "This model has no declared context budgets — set the context window in Settings in the left rail.",
  "该模型未登记能力：请到左栏「设置」里填上下文窗口与思考强度档位":
    "This model has no declared capabilities — set the context window and reasoning efforts in Settings in the left rail.",

  /* ---- 超能：审批与权限 ---- */
  "已批准": "Approved",
  "{{n}} 个操作 · 已批准，等待执行": "{{n}} actions · approved, waiting to run",
  "只执行查询；写入 / 删除会被拒绝，提权禁用":
    "Queries only; writes / deletes are rejected and sudo is disabled",
  "按需确认": "Ask before changes",
  "查询直接执行；写 / 改 / 删逐条确认":
    "Queries run directly; every write / edit / delete needs confirmation",
  "完全访问": "Full access",
  "写入 / 修改 / 删除直接执行；严重操作仍确认":
    "Writes / edits / deletes run directly; severe operations still ask",
  "管理权限": "Manage permissions",
  "默认值、提权、备份与外部工具": "Defaults, sudo, backups and external tools",
  "执行权限": "Execution permissions",
  "只读直接拒绝写入；按需确认逐条询问；完全访问只对严重操作二次确认。仅作用于超能 Agent 的工具调用。":
    "Read-only rejects writes; Ask confirms each one; Full access only double-checks severe operations. Applies to Extreme Agent tool calls only.",
  "新任务默认值": "Defaults for new tasks",
  "当前任务覆盖": "This task's override",
  "跟随默认": "Follow default",
  "这条对话使用上面的覆盖值；新任务仍使用默认值。":
    "This conversation uses the override above; new tasks keep the defaults.",
  "这条对话当前跟随默认值；改这里会为它单独记住。":
    "This conversation follows the defaults; changing this remembers a value just for it.",
  "外部工具": "External tools",
  "当前会话已启用、已连接且绑定到这台服务器 / 工作区的 MCP 连接。调用仍受上面的权限与审批约束。":
    "MCP connections enabled in this session, connected, and bound to this server / workspace. Calls still follow the permissions and approvals above.",
  "可调用范围：{{mode}}。只读模式下写入型工具会被拦截。":
    "Callable scope: {{mode}}. In read-only mode, write tools are blocked.",
  "管理 MCP": "Manage MCP",
  "当前会话没有可用的外部 MCP 连接。": "No external MCP connections are available in this session.",
  "{{n}} 个工具（{{read}} 只读）": "{{n}} tools ({{read}} read-only)",
  "备份与恢复": "Backups and restore",
  "覆盖超能 Agent 的文件修改与删除；新建文件无需备份。备份失败会取消本次改动并在步骤里说明原因。":
    "Covers the Extreme Agent's file edits and deletions; new files need no backup. A failed backup cancels the change and explains why in the step.",
  "备份保留期限": "Backup retention",
  "当前生效：{{n}} 天，下次备份时清理同目录下过期的本应用备份。":
    "Active: {{n}} days; the next backup prunes expired backups of this app in the same directory.",
  "当前生效：永久保留，不会自动清理。": "Active: kept forever, never pruned automatically.",
  "永久": "Forever",
  "{{n}} 天": "{{n}} days",
  "查看已有备份": "View existing backups",
  "{{n}} 份已验证": "{{n}} verified",
  "只列出当前会话里已确认存在的备份；还原会走 Agent 的权限、审批与变更登记。":
    "Lists only backups confirmed in this session; restoring goes through the Agent's permissions, approvals and change log.",
  "当前会话还没有已登记的备份。": "No backups have been registered in this session yet.",
  "备份：{{path}}": "Backup: {{path}}",
  "应用范围": "Coverage",
  "这一页的权限与备份由 Rust 执行器裁决；未接入的入口保留各自原有确认。":
    "Permissions and backups here are enforced by the Rust executor; entries not wired in keep their own confirmations.",
  "Agent 工具 / 写文件 / 删除 / 服务重启":
    "Agent tools / write file / delete / service restart",
  "已覆盖": "Covered",
  "MCP 工具调用": "MCP tool calls",
  "右栏远程编辑保存 / 删除": "Right-pane remote edit save / delete",
  "保留原有确认": "Keeps its own confirmation",
  "标准模式手工文件操作": "Manual file operations in standard mode",
  "保留原有确认与备份": "Keeps its own confirmation and backup",
  "部署执行器": "Deploy executor",
  "使用部署自己的确认": "Uses the deploy's own confirmation",
  "权限只决定要不要确认，不改变“只查询”任务的只读边界；列出计划本身不授予执行权限。":
    "Permissions only decide whether to ask; they never widen a read-only task. Listing a plan does not grant execution rights.",
  "还原备份": "Restore backup",
  "将用备份覆盖 {{target}}：\n{{backup}}\n\n执行前会按当前权限重新核对版本与目标，成功后记为一条真实文件变更。":
    "The backup will overwrite {{target}}:\n{{backup}}\n\nBefore running, the version and target are re-checked against current permissions; a success is recorded as a real file change.",
  "打开备份文件": "Open backup file",
  "二进制已修改": "Binary file changed",
  "允许提权": "Allow sudo",
  "允许 Agent 执行 sudo；只读模式仍禁用。需要提权的操作按实际影响确认。":
    "Let the Agent run sudo; still disabled in read-only mode. Operations that need elevation are confirmed by their actual impact.",
  "修改或覆盖前备份": "Back up before modify / overwrite",
  "只保护本次会被覆盖 / 修改的文件，在同目录留旧版本（.bls-bak. 标记）；新建文件显示「无需备份」。":
    "Only the files overwritten / modified this time are protected, keeping the old version in the same directory (.bls-bak. marker); new files show “no backup needed”.",
  "删除前备份": "Back up before delete",
  "删除文件时保护该文件，删除目录时保护整个目标目录；目录同步只保护本次会被覆盖 / 删除的具体文件。":
    "Deleting a file protects that file; deleting a directory protects the whole target directory; directory sync protects only the specific files overwritten / deleted this time.",
  "操作权限与备份策略": "Operation permissions and backup policy",

  /* ---- 超能：MCP 菜单 / 市场 / 连接 ---- */
  "MCP 能力": "MCP capabilities",
  "已启用但暂不可用": "Enabled but currently unavailable",
  "{{n}} 个工具": "{{n}} tools",
  "可用": "Available",
  "当前服务器不可用": "Unavailable on this server",
  "未测试": "Not tested",
  "未绑定当前服务器": "Not bound to this server",
  "没有启用的工具": "No enabled tools",
  "已启用 {{n}} 项": "{{n}} enabled",
  "内置运维技能": "Built-in ops skills",
  "检查环境…": "Checking environment…",
  "重新检测": "Re-detect",
  "已连接 MCP": "MCP connected",
  "还没有连接。先从市场添加一个，或自定义远程 / 本地服务。":
    "Nothing connected yet — add one from the marketplace, or define a custom remote / local server.",
  "打开 MCP 市场": "Open MCP marketplace",
  "管理连接": "Manage connections",
  "支持": "Supported",
  "客户端测试中": "Being tested",
  "暂不支持": "Not supported yet",
  "编辑 MCP 连接": "Edit MCP connection",
  "添加 {{name}}": "Add {{name}}",
  "自定义 MCP 连接": "Custom MCP connection",
  "官方文档": "Official docs",
  "上游来源": "Upstream source",
  "同一服务可以配多个实例，例如「Grafana · 生产」。":
    "One service can have several instances, e.g. “Grafana · Production”.",
  "必填": "Required",
  "可选": "Optional",
  "服务地址（可修改）": "Server URL (editable)",
  "已按模板预填；实例地址不同或模板变更时以这里为准。":
    "Prefilled from the template; if the instance URL differs or the template changed, this value wins.",
  "启动命令（可修改）": "Launch command (editable)",
  "默认使用目录模板。": "Defaults to the catalog template.",
  "当前目标：{{url}}": "Current target: {{url}}",
  "远程 HTTP": "Remote HTTP",
  "本地进程": "Local process",
  "本地进程（stdio）": "Local process (stdio)",
  "服务地址": "Server URL",
  "Streamable HTTP 的 MCP 端点（http/https）。": "Streamable HTTP MCP endpoint (http/https).",
  "请求 Header": "Request headers",
  "一行一个 KEY=VALUE；令牌写入系统钥匙串，值留空表示保留原值。":
    "One KEY=VALUE per line; tokens go to the system keychain — leave the value empty to keep the current one.",
  "启动命令": "Launch command",
  "例如 npx、uvx 或服务自己的可执行文件。":
    "e.g. npx, uvx or the service's own executable.",
  "参数": "Arguments",
  "一行一个参数。": "One argument per line.",
  "一行一个 KEY=VALUE；值写入系统钥匙串，留空表示保留原值。":
    "One KEY=VALUE per line; values go to the system keychain — leave empty to keep the current value.",
  "绑定范围": "Binding",
  "当前工作区": "This workspace",
  "当前服务器": "This server",
  "全局": "Global",
  "工作区": "Workspace",
  "启用这个连接": "Enable this connection",
  "连接成功后默认勾选": "Enabled by default once connected",
  "已连接 · 发现 {{n}} 个工具（{{ms}} ms）":
    "Connected · {{n}} tools discovered ({{ms}} ms)",
  "连接失败：{{error}}": "Connection failed: {{error}}",
  "请填写 {{label}}": "Please fill in {{label}}",
  "导入 JSON": "Import JSON",
  "自定义添加": "Add custom",
  "市场": "Marketplace",
  "我的连接": "My connections",
  "搜索服务、发布者或用途": "Search services, publishers or use cases",
  "运维精选": "Ops picks",
  "本地维护的清单": "Locally maintained list",
  "没有匹配的服务": "No matching services",
  "添加": "Add",
  "需要授权": "Authorization required",
  "搜索更多": "Search more",
  "官方 MCP Registry": "Official MCP Registry",
  "关键词，例如 postgres、github": "Keywords, e.g. postgres, github",
  "搜索中…": "Searching…",
  "搜索": "Search",
  "由 BLS-OPS 现有能力提供": "Provided by BLS-OPS's existing capabilities",
  "当前服务器：{{name}}。勾选后会出现在输入框下栏的 MCP 菜单里。":
    "Current server: {{name}}. Enabled tools appear in the MCP menu under the composer.",
  "可用 · 经由 {{server}}": "Available · via {{server}}",
  "当前连接": "Current connection",
  "需要先连接服务器": "Connect the server first",
  "{{n}} 个实例": "{{n}} instances",
  "正在加载…": "Loading…",
  "还没有 MCP 连接": "No MCP connections yet",
  "从市场添加，或自定义远程 / 本地服务。":
    "Add one from the marketplace, or define a custom remote / local server.",
  "默认勾选": "Enabled by default",
  "绑定：{{scope}}": "Binding: {{scope}}",
  "停用服务": "Disable service",
  "启用服务": "Enable service",
  "测试 / 刷新": "Test / refresh",
  "可用能力": "Available capabilities",
  "{{tools}} 个工具": "{{tools}} tools",
  "{{n}} 个资源": "{{n}} resources",
  "{{n}} 个提示": "{{n}} prompts",
  "资源": "Resources",
  "提示模板": "Prompt templates",
  "配置与能力缓存存本地 SQLite；env / Header 的值存系统钥匙串，界面只显示是否已保存。":
    "Configuration and capability cache live in local SQLite; env / header values live in the system keychain — the UI only shows whether they are saved.",
  "添加连接": "Add connection",
  "连接方式：{{transport}} · 授权：{{auth}}": "Transport: {{transport}} · Auth: {{auth}}",
  "无": "None",
  "当前客户端不支持这个传输方式。": "This client does not support that transport.",
  "已配置的实例": "Configured instances",
  "已添加 · 未验证": "Added · Unverified",
  "正在连接服务…": "Connecting…",
  "已连接但无可用工具": "Connected · No tools",
  "工具发现失败": "Tool discovery failed",
  "导入 MCP JSON": "Import MCP JSON",
  "确认添加 {{n}} 个": "Add {{n}}",
  "解析预览": "Preview",
  "将添加这些连接：": "These connections will be added:",
  "粘贴 mcpServers / servers 配置": "Paste a mcpServers / servers config",
  "识别常见的 mcpServers、servers 对象；先预览再确认。":
    "Recognizes common mcpServers / servers objects; preview first, then confirm.",
  "删除 MCP 连接": "Delete MCP connection",
  "删除「{{name}}」？它的工具会从后续任务中移除。":
    "Delete “{{name}}”? Its tools will be removed from future tasks.",
  "未找到 mcpServers / servers 配置": "No mcpServers / servers config found",
  "没有可导入的服务": "No importable services",
  "市场、连接与可用能力": "Marketplace, connections and available capabilities",
  "监控与日志": "Monitoring and logs",
  "容器与集群": "Containers and clusters",
  "云服务与 DNS": "Cloud services and DNS",
  "该服务只提供旧版 SSE 传输，当前客户端暂不支持。":
    "This service only offers the legacy SSE transport, which this client does not support yet.",
  "目录没有提供可用的远程地址或 stdio 启动信息，暂不支持。":
    "The catalog entry has no usable remote URL or stdio launch info, so it is not supported yet.",
  "官方 Registry": "Official Registry",
  "来自官方 MCP Registry": "From the official MCP Registry",
  "访问令牌（如服务要求）": "Access token (if the service requires one)",
  "BLS-OPS 内置": "Built into BLS-OPS",
  "服务器巡检": "Server inspection",
  "查看系统状态、进程、端口与资源": "Inspect system status, processes, ports and resources",
  "通过当前 SSH 连接执行只读命令，适合先了解机器现状。":
    "Runs read-only commands over the current SSH connection — good for a first look at the machine.",
  "读取服务日志与 journal / 容器输出": "Read service logs plus journal / container output",
  "沿用现有日志通道；连接断开时不可用。":
    "Reuses the existing log channel; unavailable while disconnected.",
  "读取、修改、上传与解压文件": "Read, edit, upload and extract files",
  "受任务权限与备份策略约束；只读档会拒绝写入。":
    "Governed by task permissions and the backup policy; read-only rejects writes.",
  "解析域名、检查证书与 HTTP 响应": "Resolve DNS, check certificates and HTTP responses",
  "需要当前服务器能执行 dig / curl 等只读命令。":
    "Requires the server to run read-only commands such as dig / curl.",
  "查看容器、Compose 服务与镜像": "Inspect containers, Compose services and images",
  "检测到 docker 后默认启用；未安装时不可用。":
    "Enabled by default once docker is detected; unavailable when not installed.",
  "Nginx / 站点排查": "Nginx / site troubleshooting",
  "检查站点配置、语法与容器内 Nginx": "Check site config, syntax and Nginx inside containers",
  "检测到 nginx 或 /etc/nginx 后默认启用。":
    "Enabled by default once nginx or /etc/nginx is detected.",
  "查看与操作 systemd 服务": "Inspect and control systemd services",
  "检测到 systemctl 后默认启用；重启关键服务仍按严重操作确认。":
    "Enabled by default once systemctl is detected; restarting key services is still confirmed as a severe action.",
  "数据库排查": "Database troubleshooting",
  "连接 MySQL / PostgreSQL / Redis 排查": "Investigate through MySQL / PostgreSQL / Redis",
  "检测到数据库客户端或已绑定连接后启用。":
    "Enabled once a database client or a bound connection is detected.",

  /* ---- 超能：检查项 / 部署计划 / 环境提示 ---- */
  "条件未满足": "Precondition not met",
  "无权限": "No permission",
  "无法验证": "Cannot verify",
  "不适用": "Not applicable",
  "已在监听": "Already listening",
  "未被占用": "Free",
  "读不到 df 输出": "Could not read df output",
  "没有可读取的证书（可能还没配 HTTPS）":
    "No readable certificate (HTTPS probably not configured yet)",
  "请求没有返回": "The request returned nothing",
  "续签证书": "Renew the certificate",
  "把 A 记录改为本机地址，或确认应部署到记录指向的那台机器":
    "Point the A record at this machine, or confirm you should deploy to the host it resolves to",
  "为这个域名添加 A 记录": "Add an A record for this domain",
  "确认占用它的服务是否可以停止，或改用其他端口":
    "Check whether the service holding it can stop, or use another port",
  "换一个有写权限的目录，或用提权账号执行":
    "Use a writable directory, or run with an elevated account",
  "清理磁盘或更换部署目录": "Free up disk space or choose another deploy directory",
  "为这个域名重新签发证书，或改用已覆盖的域名":
    "Reissue a certificate for this domain, or use a covered domain",
  "确认上游服务是否在运行、监听端口与路径是否正确":
    "Check whether the upstream service runs and whether its port and path are correct",
  "compose 里有 build 段，需要在服务器上构建（会下载依赖，耗时较长）":
    "The compose file has a build section, so it must build on the server (downloads dependencies, takes a while)",
  "读取 compose 项目里每个容器的实际状态，非 running 即视为失败":
    "Read the real state of every container in the compose project; anything not running counts as failure",
  "没有读到任何容器状态": "No container state was read",
  "正在分析": "Analyzing",
  "上次运行已中断：最后一步是否生效需要先在服务器上核对。":
    "The previous run was interrupted: check on the server whether the last step took effect.",
  "未找到上游": "Upstream not found",
  "未找到目录": "Directory not found",
  "上传附件到服务器临时目录": "Upload attachments to a temporary directory on the server",
  "域名已指向本机，可以在本机验证公网入口":
    "The domain already points at this machine — the public entry can be verified locally",
  "域名指向别的主机 —— 改动前先确认目标机器，否则改完也访问不到":
    "The domain points at another host — confirm the target machine first, or the change will not be reachable",
  "域名当前解析不到，部署完成后也无法通过域名访问":
    "The domain does not resolve right now, so it will not be reachable after deployment either",
  "缺少本机对外地址，无法判断域名是否指向本机":
    "No public address for this machine, so we cannot tell whether the domain points here",
  "实测可用工具：（未探测到，或探测未执行）":
    "Available tools (measured): (none detected, or the probe did not run)",
  "无记录": "No record",
  "已运行": "Uptime",
  "新任务继承；MAX 仍会触发强制计划。切换模型时按模型实际支持的档位校验。":
    "New tasks inherit these; MAX still forces a plan. When switching models, the tier is validated against what the model actually supports.",
  "管理 MCP 连接": "Manage MCP connections",
  "待确认通知可以直接允许或拒绝，与聊天审批卡共用同一个审批 ID。":
    "Approval notifications can allow or deny directly, sharing the same approval ID as the chat approval card.",

  /* ---- 超能：设置页 ---- */
  "模型与供应商": "Models and providers",
  "这里是超能模式的模型默认与能力来源；普通模式不再单独提供入口，但仍读取同一份配置。":
    "This is where Extreme mode gets its model defaults and capabilities; standard mode no longer has its own entry but reads the same configuration.",
  "对话与上下文": "Conversation and context",
  "默认值用于新任务；当前会话可在输入框底栏覆盖，下面会显示实际生效值。":
    "Defaults apply to new tasks; the current conversation can override them from the composer, and the effective value is shown below.",
  "默认上下文范围": "Default context scope",
  "当前会话含本任务历史、工具结果与已纳入的附件；仅本条只带这句话；自选只带勾选材料。":
    "Conversation includes this task's history, tool results and included attachments; This message sends only the sentence itself; Picked sends only the selected material.",
  "发送前自选": "Pick before sending",
  "默认回复详略": "Default reply detail",
  "只影响回答的写法；命令、路径、日志与错误原文保持可复制。":
    "Affects wording only; commands, paths, logs and raw errors stay copyable.",
  "默认回复语言": "Default reply language",
  "跟随输入使用界面语言；固定语言会覆盖界面语言，仅影响回答正文。":
    "Follow input uses the UI language; a fixed language overrides it for reply bodies only.",
  "跟随输入": "Follow input",
  "中文": "Chinese",
  "英文": "English",
  "模型、对话、执行、通知与界面偏好":
    "Model, conversation, execution, notifications and interface preferences",
  "默认思考强度": "Default reasoning effort",
  "默认上下文预算": "Default context budget",
  "只影响本轮带入多少内容；模型窗口与最大输出仍由后端按模型能力校验。":
    "Only controls how much content is included this round; the model window and max output are still validated by the backend against model capabilities.",
  "当前会话覆盖": "This conversation's override",
  "输入框底栏与此处共用": "Shared with the composer",
  "当前没有打开的对话": "No conversation open",
  "回复详略": "Reply detail",
  "思考 / 预算": "Reasoning / budget",
  "未配置": "Not configured",
  "恢复默认": "Reset to default",
  "点击输入框的上下文用量可查看历史、附件、工具结果与裁剪情况；当前上下文和任务累计分别统计。":
    "Click the context usage in the composer to see history, attachments, tool results and trimming; current context and task totals are counted separately.",
  "执行与计划": "Execution and plan",
  "计划卡显隐与工具详情默认展开只影响界面；权限与审批仍在「权限」页。":
    "Plan-card visibility and tool-detail expansion are display-only; permissions and approvals live on the Permissions page.",
  "计划卡": "Plan card",
  "「生成后展开」只在第一份计划出现时展开一次；手动收起后进度更新不再抢焦点。":
    "“Expand on generation” expands once when the first plan appears; after you collapse it, progress updates no longer steal focus.",
  "生成后展开": "Expand on generation",
  "默认收起": "Collapsed by default",
  "工具详情": "Tool details",
  "普通命令行的默认展开状态；当前对话里手动展开优先，失败原因和待确认操作始终可见。":
    "Default expansion for ordinary command rows; manual expansion in the current conversation wins, and failure reasons plus pending approvals are always visible.",
  "默认折叠": "Collapsed by default",
  "默认展开": "Expanded by default",
  "执行前说明": "Note before running",
  "每组操作开始前保留一句简短说明；相同目的连续命令共用一次，目的改变时再补。":
    "Keep one short note before each group of operations; consecutive commands with the same goal share it, and a new one appears when the goal changes.",
  "始终开启": "Always on",
  "管理权限与备份": "Manage permissions and backups",
  "通知": "Notifications",
  "只在主窗口最小化、隐藏或收进托盘时发桌面通知；主窗口可见时只在会话里显示状态。重进与历史恢复不补发。":
    "Desktop notifications fire only while the main window is minimized, hidden or in the tray; when it is visible, status stays in the conversation. Re-entering or restoring history does not resend them.",
  "后台通知": "Background notifications",
  "总开关；关闭后三类通知都不发。":
    "Master switch; turning it off disables all three notification types.",
  "等待确认": "Waiting for approval",
  "任务完成": "Task finished",
  "点击通知回到对应任务。": "Clicking the notification returns to that task.",
  "任务失败": "Task failed",
  "点击通知回到失败的任务与真实错误。":
    "Clicking the notification returns to the failed task and the real error.",
  "界面与动效": "Interface and motion",
  "跟随最新回复": "Follow the latest reply",
  "在底部时平滑跟随；向上阅读时暂停，点「回到底部」恢复。":
    "Smoothly follows while at the bottom; pauses when you scroll up, resumes with “Back to bottom”.",
  "新任务右侧工作区": "Right pane for new tasks",
  "只决定新建任务的默认展开；已有会话仍保留自己的标签、宽度与展开状态。":
    "Only sets the default for new tasks; existing conversations keep their own tabs, width and expansion state.",
  "动效": "Motion",
  "跟随系统会尊重系统的减弱动效偏好；减弱后只压缩时长，不改变结果。":
    "Follow system respects the OS reduced-motion preference; reduced only shortens durations, never changes results.",
  "跟随系统": "Follow system",
  "减弱动效": "Reduced motion",
  "默认值只影响之后新建的任务；当前会话可用上面的「恢复默认」逐项切换。模型与连接测试仍需保存成功后才生效。":
    "Defaults only affect tasks created afterwards; use “Reset to default” above to switch individual items for the current conversation. Models and connection tests take effect only after a successful save.",
  "实际请求：{{endpoint}}": "Actual request: {{endpoint}}",
  "上下文与输出": "Context and output",
  "思考能力": "Reasoning capabilities",
  "上下文 {{window}} · 输出上限 {{output}}": "Context {{window}} · output limit {{output}}",

  /* ---- 超能：桌面通知 / 预览里仍会漏中文的 key ---- */
  "正在提交…": "Submitting…",
  "确认没有送达": "The approval did not reach the app",
  "超能模式 · 已处理": "Extreme mode · Handled",
  "超能模式 · 需要确认": "Extreme mode · Needs approval",
  "本地文件（未上传）": "Local file (not uploaded)",
  "没有可预览的来源": "Nothing to preview",
  "后续计划：补齐该引擎的真实驱动后，这张表会逐项变为「支持」，届时才开放连接与查询。":
    "Next: once this engine has a real driver, the table below turns “Supported” item by item — only then are connections and queries enabled.",
  "删除不可撤销。这不是事务：多个键会逐条删除，中途失败的部分不会回滚。":
    "Deletion cannot be undone. This is not a transaction: keys are deleted one by one and a mid-way failure is not rolled back.",

  /* ---- 超能：权限模式的整段说明（权限页三张卡片直接展示） ---- */
  "只读：只执行查询；写入、修改、删除会被直接拒绝，不产生确认。sudo 禁用。":
    "Read-only: queries only. Writes, edits and deletes are rejected outright with no confirmation, and sudo is disabled.",
  "按需确认：查询直接执行；命令确实要写文件、改配置、改服务或删数据时，逐条请你确认。sudo 需确认。":
    "Ask before changes: queries run directly; when a command really writes files, changes config or services, or deletes data, you are asked one by one. sudo needs confirmation.",
  "完全访问：你明确要求的写入、修改与删除（含 sudo、服务重启）直接执行；严重操作（改 SSH / 防火墙 / 磁盘 / 删系统目录等）仍会确认。备份按权限页的策略执行，备份文件带 .bls-bak. 标记。":
    "Full access: writes, edits and deletes you explicitly asked for (including sudo and service restarts) run directly; severe operations (SSH / firewall / disk / deleting system directories) still ask. Backups follow the policy on the Permissions page and carry the .bls-bak. marker.",
} as const;
