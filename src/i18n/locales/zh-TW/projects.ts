/**
 * zh-TW · 專案發現與專案檢視。
 *
 * 覆蓋 `src/workbench/views/project/**`：候選卡、判定依據、能力畫像、
 * 執行時/基礎設施 Tab、掃描進度、徽標。
 */
export default {
  // -- 掃描與列表 --
  "Discover projects on the server": "在伺服器上發現專案",
  "Scanning server projects": "正在掃描伺服器專案",
  "Candidate projects": "候選專案",
  "No projects found": "未發現專案",
  "No directories to review": "沒有需要複核的目錄",
  "Loaded the last discovery; re-checking in the background…":
    "已载入上次的发现结果，正在后台复核…",
  "Scan warnings: {{warnings}}": "掃描告警：{{warnings}}",
  Warnings: "告警",
  Progress: "進度",

  // -- 候選卡操作 --
  "Confirm project": "確認為專案",
  "Ignore directory": "忽略該目錄",
  "Undo decision": "撤銷判定",
  "Merge into another project…": "合併到另一個專案…",
  "Pick the parent project to merge into:": "选择要合并到的父项目：",
  "Open project folder": "展開專案目錄",
  "Close project folder": "收起專案目錄",
  "View project files": "檢視專案檔案",
  "Open {{path}}": "開啟 {{path}}",
  "Open {{path}} in the file panel": "在檔案面板中開啟 {{path}}",
  "Merged into {{path}}": "已合併到 {{path}}",
  "{{count}} subdirectories merged in": "已合併 {{count}} 個子目錄",
  "Subdirectories merged in (manual merge)": "已合併子目錄（手動合併）",
  Split: "拆分",

  // -- 候選卡徽標與摘要 --
  "Detected as {{service}} ({{group}})": "識別為 {{service}}（{{group}}）",
  "{{type}} · {{count}} modules · readiness {{score}}":
    "{{type}} · {{count}} 个模块 · 就绪度 {{score}}",
  "Verdict: {{status}} (score {{score}})": "判定：{{status}}（得分 {{score}}）",
  "Port {{port}}": "埠 {{port}}",
  " · ports {{ports}}": " · 埠 {{ports}}",
  "{{port}} — {{hint}}": "{{port}} — {{hint}}",
  "Modules: {{count}}": "模組：{{count}} 個",
  "Project type: {{type}}": "專案型別：{{type}}",
  "Details changed": "資訊有變化",
  Deployed: "已部署",
  "Deployment readiness": "部署就緒度",
  "Environment variable names": "環境變數名",
  "Blocker: {{item}}": "阻塞項：{{item}}",
  "Warning: {{item}}": "警告：{{item}}",
  "Penalties & risks": "扣分與風險",

  // -- 依據 --
  "Decision evidence": "判定依據",
  "Evidence details": "依據詳情",
  "Hide evidence details": "隱藏依據詳情",
  "Classification evidence: {{evidence}}": "分類依據：{{evidence}}",
  "Directories checked": "已檢查目錄",
  "Not found this scan": "本次掃描未發現",

  // -- 伺服器能力畫像 --
  "Server capability profile": "伺服器能力畫像",
  "System profile": "系統畫像",
  "No server capability info": "暫無伺服器能力資訊",
  "Enabled capability collectors": "已啟用的能力採集器",
  "Identify the server first, then decide which collectors to enable":
    "先识别服务器，再决定启用哪些采集器",
  "Not installed (collectors disabled to avoid pointless errors): {{tools}}":
    "未安装（已关闭相关采集器以避免无意义的报错）：{{tools}}",
  "OS: {{value}}": "作業系統：{{value}}",
  "Arch: {{value}}": "架構：{{value}}",
  "Init system: {{value}}": "init 系統：{{value}}",
  "Package manager: {{value}}": "包管理器：{{value}}",
  "Security module: {{value}}": "安全模組：{{value}}",
  "Current user: {{value}}": "當前使用者：{{value}}",
  "sudo: {{value}}": "sudo：{{value}}",
  "cgroup: {{value}}": "cgroup：{{value}}",
  Available: "可用",
  Unavailable: "不可用",
  Undetermined: "待定",

  // -- 執行時 / 基礎設施 --
  Runtimes: "執行時",
  "Runtime links": "執行例項關聯",
  "Source linked": "原始碼已關聯",
  "Source only": "僅原始碼",
  "Source only — not linked to a running instance": "僅原始碼 —— 未關聯執行例項",
  "Source unknown": "來源未知",
  "Linked to {{count}} projects": "關聯 {{count}} 個專案",
  "{{count}} instances": "{{count}} 個例項",
  "No infrastructure instances found": "未發現基礎設施例項",
  "No instances match this filter.": "沒有符合該篩選條件的例項。",
  "No app services": "沒有應用服務",
  "No config files available": "沒有可用的配置檔案",
  "Runs from an image — no config files on the host":
    "由镜像运行 —— 宿主机上没有配置文件",
  "Instance ownership: shared by multiple projects, or serving a single one":
    "实例归属：被多个项目共用，或只服务于单个项目",
  "Access entries (Nginx gateway)": "訪問入口（Nginx 閘道器）",
  Unclassified: "未分類",
  "Version managers": "版本管理器",
  "Build tools": "構建工具",
  Deploy: "部署",
  "Deploy files": "部署檔案",
  "(none)": "（無）",
  "All candidates are confirmed or ignored.": "所有候選都已確認或忽略。",
} as const;
