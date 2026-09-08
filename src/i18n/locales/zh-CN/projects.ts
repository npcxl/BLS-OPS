/**
 * zh-CN · 项目发现与项目视图。
 *
 * 覆盖 `src/workbench/views/project/**`：候选卡、判定依据、能力画像、
 * 运行时/基础设施 Tab、扫描进度、徽标。
 */
export default {
  // -- 扫描与列表 --
  "Discover projects on the server": "在服务器上发现项目",
  "Scanning server projects": "正在扫描服务器项目",
  "Candidate projects": "候选项目",
  "No projects found": "未发现项目",
  "No directories to review": "没有需要复核的目录",
  "Loaded the last discovery; re-checking in the background…":
    "已载入上次的发现结果，正在后台复核…",

  // -- 扫描进度 phase（后端下发的英文 key，en 原样显示）--
  "Candidate discovery": "候选发现",
  "Capability probe": "能力识别",
  "Enumerating deployment instances": "部署实例枚举",
  "Targeted scan of instance paths": "部署实例路径定向扫描",
  "Supplementary source scan": "补充源码扫描",
  "Scoring candidates": "候选评分",
  "Linking runtime services": "运行服务关联",
  "Done": "完成",
  "Scan warnings: {{warnings}}": "扫描告警：{{warnings}}",
  Warnings: "告警",
  Progress: "进度",

  // -- 候选卡操作 --
  "Confirm project": "确认为项目",
  "Ignore directory": "忽略该目录",
  "Undo decision": "撤销判定",
  "Merge into another project…": "合并到另一个项目…",
  "Pick the parent project to merge into:": "选择要合并到的父项目：",
  "Open project folder": "展开项目目录",
  "Close project folder": "收起项目目录",
  "View project files": "查看项目文件",
  "Open {{path}}": "打开 {{path}}",
  "Open {{path}} in the file panel": "在文件面板中打开 {{path}}",
  "Merged into {{path}}": "已合并到 {{path}}",
  "{{count}} subdirectories merged in": "已合并 {{count}} 个子目录",
  "Subdirectories merged in (manual merge)": "已合并子目录（手动合并）",
  Split: "拆分",

  // -- 候选卡徽标与摘要 --
  "Detected as {{service}} ({{group}})": "识别为 {{service}}（{{group}}）",
  "{{type}} · {{count}} modules · readiness {{score}}":
    "{{type}} · {{count}} 个模块 · 就绪度 {{score}}",
  "Verdict: {{status}} (score {{score}})": "判定：{{status}}（得分 {{score}}）",
  "Port {{port}}": "端口 {{port}}",
  " · ports {{ports}}": " · 端口 {{ports}}",
  "{{port}} — {{hint}}": "{{port}} — {{hint}}",
  "Modules: {{count}}": "模块：{{count}} 个",
  "Project type: {{type}}": "项目类型：{{type}}",
  "Details changed": "信息有变化",
  Deployed: "已部署",
  "Deployment readiness": "部署就绪度",
  "Environment variable names": "环境变量名",
  "Blocker: {{item}}": "阻塞项：{{item}}",
  "Warning: {{item}}": "警告：{{item}}",
  "Penalties & risks": "扣分与风险",

  // -- 依据 --
  "Decision evidence": "判定依据",
  "Evidence details": "依据详情",
  "Hide evidence details": "隐藏依据详情",
  "Classification evidence: {{evidence}}": "分类依据：{{evidence}}",
  "Directories checked": "已检查目录",
  "Not found this scan": "本次扫描未发现",

  // -- 服务器能力画像 --
  "Server capability profile": "服务器能力画像",
  "System profile": "系统画像",
  "No server capability info": "暂无服务器能力信息",
  "Enabled capability collectors": "已启用的能力采集器",
  "Identify the server first, then decide which collectors to enable":
    "先识别服务器，再决定启用哪些采集器",
  "Not installed (collectors disabled to avoid pointless errors): {{tools}}":
    "未安装（已关闭相关采集器以避免无意义的报错）：{{tools}}",
  "OS: {{value}}": "操作系统：{{value}}",
  "Arch: {{value}}": "架构：{{value}}",
  "Init system: {{value}}": "init 系统：{{value}}",
  "Package manager: {{value}}": "包管理器：{{value}}",
  "Security module: {{value}}": "安全模块：{{value}}",
  "Current user: {{value}}": "当前用户：{{value}}",
  "sudo: {{value}}": "sudo：{{value}}",
  "cgroup: {{value}}": "cgroup：{{value}}",
  Available: "可用",
  Unavailable: "不可用",
  Undetermined: "待定",

  // -- 运行时 / 基础设施 --
  Runtimes: "运行时",
  "Runtime links": "运行实例关联",
  "Source linked": "源码已关联",
  "Source only": "仅源码",
  "Source only — not linked to a running instance": "仅源码 —— 未关联运行实例",
  "Source unknown": "来源未知",
  "Linked to {{count}} projects": "关联 {{count}} 个项目",
  "{{count}} instances": "{{count}} 个实例",
  "No infrastructure instances found": "未发现基础设施实例",
  "No instances match this filter.": "没有符合该筛选条件的实例。",
  "No app services": "没有应用服务",
  "No config files available": "没有可用的配置文件",
  "Runs from an image — no config files on the host":
    "由镜像运行 —— 宿主机上没有配置文件",
  "Instance ownership: shared by multiple projects, or serving a single one":
    "实例归属：被多个项目共用，或只服务于单个项目",
  "Access entries (Nginx gateway)": "访问入口（Nginx 网关）",
  Unclassified: "未分类",
  "Version managers": "版本管理器",
  "Build tools": "构建工具",
  Deploy: "部署",
  "Deploy files": "部署文件",
  "(none)": "（无）",
  "All candidates are confirmed or ignored.": "所有候选都已确认或忽略。",
} as const;
