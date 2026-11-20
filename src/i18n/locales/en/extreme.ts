/**
 * Super Mode (超能模式) — English overrides.
 *
 * The feature's `t()` calls use Chinese keys, so without this file the English
 * UI would fall back to Chinese. Keys must match the source strings exactly
 * (including punctuation and `{{placeholders}}`).
 */
export default {
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
  "处理过程": "Activity",
  "工具调用 · {{n}} 次": "Tool calls · {{n}}",
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
  "还没有对话：文件变更按对话归属，先开始一条任务。":
    "No conversation yet: file changes belong to a conversation — start a task first.",
  "这次对话还没有文件变更：AI 用 write_file 改文件时，这里会显示预览与实际差异。":
    "This conversation has no file changes yet: when the AI uses write_file, the preview and the actual diff show up here.",
  "普通 shell 命令（sed / tee / 脚本）拿不到明确目标与前后快照，不会生成 Diff。":
    "Plain shell commands (sed / tee / scripts) have no clear target or before/after snapshot, so no diff is generated.",
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
  "在 设置 → AI providers 里配置默认模型与 API Key。":
    "Configure the default model and API key in Settings → AI providers.",
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
} as const;
