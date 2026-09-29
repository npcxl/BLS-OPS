/**
 * P5.3 / P5.4 部署执行页与类型化动作的文案。
 *
 * 与 `deployments.ts` 同一套约定：**flat key、key 就是英文原文**。
 * 动作标签的 key 与 Rust `ActionKind::as_str()` 一一对应，`labels.test.ts`
 * 会把两边都钉住 —— 少一个动作就会红。
 */
export default {
  // -- 页面骨架 --
  "Deploy run": "部署执行",
  "Run history": "运行历史",
  "No plans yet": "还没有计划",
  "SSH session ready": "SSH 会话已就绪",
  "No connected SSH session: connect a terminal first": "没有已连接的 SSH 会话：请先连接终端",

  // -- 预检 --
  Preflight: "预检",
  "Ready to run": "可以执行",
  Blocked: "被阻断",
  "Check passed": "检查通过",
  "Cannot be checked locally": "本地无法判定",
  "Check blocked": "检查未通过",

  // -- 执行 --
  "Approve high-risk steps up front": "预先批准高风险节点",
  "Start deployment": "开始部署",
  Cancel: "取消",
  Loading: "加载中",
  "No deployment run yet": "还没有部署运行",
  "Pick a plan and run the preflight to begin.": "选择一份计划并执行预检即可开始。",
  Attempt: "第几次尝试",
  "Confirm and continue": "确认并继续",
  "Retry this step": "重试本节点",
  "Current step": "当前节点",
  "All steps finished": "所有节点已完成",
  "Not started": "尚未开始",
  "Waiting for confirmation": "等待确认",
  "Failed step": "失败节点",

  // -- 右侧摘要 --
  "Failure reason": "失败原因",
  "AI diagnosis (not enabled)": "AI 诊断（未启用）",
  "The AI advisor is off in this build: the decision stays with you and a human review is required.":
    "这个版本里 AI 顾问是关闭的：决定权在你手上，且必须人工复核。",
  "Plan and risks": "方案与风险",
  Approvals: "审批",
  "Whole plan": "整份方案",
  "History and rollback": "历史与回滚",
  "Domains and certificates": "域名与证书",
  "No runs yet": "还没有运行记录",
  "Roll back": "回滚",
  Releases: "版本",
  "No releases yet": "还没有版本记录",
  "DNS records to add": "需要添加的 DNS 记录",
  "This provider can be automated.": "这个服务商可以自动写入。",
  "No DNS provider API is called in this version: add the records yourself, then verify the resolution.":
    "当前版本不调用任何 DNS 服务商 API：请手动添加记录，再由工具验证解析。",
  "Certificate plan": "证书签发计划",

  // -- 动作标签（key 与 Rust ActionKind 逐字一致）--
  "Check server dependencies": "检查服务器依赖",
  "Create directory": "创建目录",
  "Prepare release directory": "准备发布目录",
  "Upload artifact": "上传制品",
  "Verify artifact checksum": "校验制品哈希",
  "Extract archive": "解包归档",
  "Build image": "构建镜像",
  "Pull image": "拉取镜像",
  "Write runtime config": "写入运行时配置",
  "Generate compose file": "生成 Compose 文件",
  "Start compose stack": "启动 Compose 栈",
  "Stop compose stack": "停止 Compose 栈",
  "Wait for container health": "等待容器健康",
  "Restart service unit": "重启服务单元",
  "Back up nginx config": "备份 Nginx 配置",
  "Write nginx config": "写入 Nginx 配置",
  "Restore nginx backup": "还原 Nginx 备份",
  "Test nginx config": "测试 Nginx 配置",
  "Reload nginx": "重载 Nginx",
  "Verify DNS resolution": "验证 DNS 解析",
  "Issue certificate": "签发证书",
  "Renew certificate": "续期证书",
  "HTTP health check": "HTTP 健康检查",
  "TCP health check": "TCP 健康检查",
  "Switch release symlink": "切换版本软链",
  "Promote release": "提升版本",
  "Stop previous release": "停止旧版本",
  "Roll back release": "回滚版本",
  "Manual confirmation step": "人工确认步骤",

  // -- 阶段标签 --
  "Prepare artifacts": "准备制品",
  "Write configuration": "写入配置",
  "Start services": "启动服务",
  Gateway: "网关",
  "Health checks": "健康检查",
  Promote: "提升",
  Rollback: "回滚",
} as const;
