/**
 * P5.3 / P5.4 部署執行頁與型別化動作的文案（繁體）。
 *
 * 與 `deployments.ts` 同一套約定：**flat key、key 就是英文原文**。
 */
export default {
  // -- 頁面骨架 --
  "Deploy run": "部署執行",
  "Run history": "執行歷史",
  "No plans yet": "還沒有計畫",
  "SSH session ready": "SSH 工作階段已就緒",
  "No connected SSH session: connect a terminal first": "沒有已連線的 SSH 工作階段：請先連線終端機",

  // -- 預檢 --
  Preflight: "預檢",
  "Ready to run": "可以執行",
  Blocked: "被阻擋",
  "Check passed": "檢查通過",
  "Cannot be checked locally": "本機無法判定",
  "Check blocked": "檢查未通過",

  // -- 執行 --
  "Approve high-risk steps up front": "預先核准高風險節點",
  "Start deployment": "開始部署",
  Cancel: "取消",
  Loading: "載入中",
  "No deployment run yet": "還沒有部署執行",
  "Pick a plan and run the preflight to begin.": "選擇一份計畫並執行預檢即可開始。",
  Attempt: "第幾次嘗試",
  "Confirm and continue": "確認並繼續",
  "Retry this step": "重試本節點",
  "Current step": "目前節點",
  "All steps finished": "所有節點已完成",
  "Not started": "尚未開始",
  "Waiting for confirmation": "等待確認",
  "Failed step": "失敗節點",

  // -- 右側摘要 --
  "Failure reason": "失敗原因",
  "AI diagnosis (not enabled)": "AI 診斷（未啟用）",
  "The AI advisor is off in this build: the decision stays with you and a human review is required.":
    "這個版本裡 AI 顧問是關閉的：決定權在你手上，且必須人工複核。",
  "Plan and risks": "方案與風險",
  Approvals: "核准",
  "Whole plan": "整份方案",
  "History and rollback": "歷史與回復",
  "Domains and certificates": "網域與憑證",
  "No runs yet": "還沒有執行記錄",
  "Roll back": "回復",
  Releases: "版本",
  "No releases yet": "還沒有版本記錄",
  "DNS records to add": "需要新增的 DNS 記錄",
  "This provider can be automated.": "這個服務商可以自動寫入。",
  "No DNS provider API is called in this version: add the records yourself, then verify the resolution.":
    "目前版本不呼叫任何 DNS 服務商 API：請手動新增記錄，再由工具驗證解析。",
  "Certificate plan": "憑證簽發計畫",

  // -- 動作標籤（key 與 Rust ActionKind 逐字一致）--
  "Check server dependencies": "檢查伺服器相依",
  "Create directory": "建立目錄",
  "Prepare release directory": "準備發佈目錄",
  "Upload artifact": "上傳產物",
  "Verify artifact checksum": "驗證產物雜湊",
  "Extract archive": "解壓縮封存檔",
  "Build image": "建置映像",
  "Pull image": "拉取映像",
  "Write runtime config": "寫入執行期設定",
  "Generate compose file": "產生 Compose 檔案",
  "Start compose stack": "啟動 Compose 堆疊",
  "Stop compose stack": "停止 Compose 堆疊",
  "Wait for container health": "等待容器健康",
  "Restart service unit": "重啟服務單元",
  "Back up nginx config": "備份 Nginx 設定",
  "Write nginx config": "寫入 Nginx 設定",
  "Restore nginx backup": "還原 Nginx 備份",
  "Test nginx config": "測試 Nginx 設定",
  "Reload nginx": "重新載入 Nginx",
  "Verify DNS resolution": "驗證 DNS 解析",
  "Issue certificate": "簽發憑證",
  "Renew certificate": "續期憑證",
  "HTTP health check": "HTTP 健康檢查",
  "TCP health check": "TCP 健康檢查",
  "Switch release symlink": "切換版本軟連結",
  "Promote release": "提升版本",
  "Stop previous release": "停止舊版本",
  "Roll back release": "回復版本",
  "Manual confirmation step": "人工確認步驟",

  // -- 階段標籤 --
  "Prepare artifacts": "準備產物",
  "Write configuration": "寫入設定",
  "Start services": "啟動服務",
  Gateway: "閘道",
  "Health checks": "健康檢查",
  Promote: "提升",
  Rollback: "回復",

  // -- P5.5 AI 提供方與複核 --
  "AI not configured": "AI 未設定",
  "Add a model in Settings → AI models": "請到「設定 → AI 模型」新增一個模型提供方",
  "AI review queued": "AI 複核已排隊",
  "AI review running": "AI 複核進行中",
  "AI review finished": "AI 複核完成",
  "AI review failed": "AI 複核失敗",
  "AI review cancelled": "AI 複核已取消",
  "Run AI review": "執行 AI 複核",
  "Retry AI review": "重試 AI 複核",
  "AI suggestions are advisory only and never modify this proposal.":
    "AI 建議僅供人工參考，不會自動修改這份部署方案。",
  Model: "模型",
  Accepted: "已採納",
  Rejected: "已拒絕",
  Attempts: "嘗試次數",
  Duration: "耗時",
  "AI suggestion": "AI 建議",
  "Rejected AI content": "被安全校驗拒絕的內容",
  "Knowledge citations": "知識引用",

  // -- P5.5 知識庫頁面 --
  "Knowledge base": "知識庫",
  "New knowledge": "新增知識",
  "All knowledge": "全部知識",
  "All categories": "全部分類",
  global: "全域",
  application: "應用",
  environment: "環境",
  platform: "平台",
  deployment_pattern: "部署形態",
  sizing: "容量口徑",
  dns: "DNS",
  ssl: "憑證",
  health_check: "健康檢查",
  rollback: "回復",
  security: "安全",
  troubleshooting: "除錯",
  project_context: "專案背景",
  custom: "自訂",
  manual: "手寫",
  markdown_file: "Markdown 匯入",
  imported_text: "文字貼上",
  "No knowledge yet": "還沒有知識",
  "No user knowledge: the system still generates proposals from its built-in rules.":
    "沒有使用者知識時，系統仍使用內建規則產生部署方案。",
  Title: "標題",
  Source: "來源",
  "Tags (comma separated)": "標籤（逗號分隔）",
  "Save as new version": "儲存為新版本",
  "Saving never overwrites the previous version.": "儲存永遠不會覆蓋上一個版本。",
  "Retrieval test": "檢索測試",
  "Retrieval results": "檢索結果",
  "Only usable as quoted data": "僅可作為引用資料",
  "Current version": "目前版本",
  History: "歷史版本",
  "No versions yet": "還沒有版本",
  Restore: "還原",
  "Used by proposals": "被哪些方案引用",
  "Not referenced yet": "還沒有被引用",

  // -- P5.5.1 設定：AI 模型管理 --
  "AI models": "AI 模型",
  "Models only review deployment proposals; they never execute anything.":
    "模型只用於複核部署方案，絕不會執行任何操作。",
  "Add model": "新增模型",
  "Edit model": "編輯模型",
  "No models yet": "還沒有模型提供方",
  Default: "預設",
  "Test connection": "連線測試",
  "Set as default": "設為預設",
  "Delete model provider": "刪除模型提供方",
  'Delete "{{name}}"? The saved configuration is removed.':
    "刪除「{{name}}」？已儲存的設定會被移除。",
  "Also delete the API key from the system credential manager":
    "同時從系統認證管理員刪除該 API Key",
  "Provider type": "提供方類型",
  "OpenAI compatible": "OpenAI 相容",
  "Base URL": "Base URL",
  "For example https://api.example.com/v1; a self-hosted gateway usually allows plain HTTP on the local network.":
    "例如 https://api.example.com/v1；自建閘道通常於內網使用明文 HTTP。",
  "API Key": "API Key",
  "Leave empty to keep the saved key. Keys are only written to the system credential manager.":
    "留空表示保留已儲存的密鑰；密鑰只會寫入系統認證管理員。",
  "The key is written to the system credential manager only; the database keeps a reference.":
    "密鑰只寫入系統認證管理員，資料庫只保存參照。",
  "Leave empty to keep the saved key": "留空表示保留原密鑰",
  "Timeout (seconds)": "逾時（秒）",
  "Max output tokens": "最大輸出 token",
  "Use as default": "設為預設",
  "Allow plain HTTP for non-local hosts": "允許非本機主機使用明文 HTTP",
  "Only enable this for a trusted self-hosted gateway on your own network.":
    "僅在你自己的網路裡、受信任的自建閘道才開啟。",
  "Connection OK ({{ms}} ms, {{attempts}} attempt(s))":
    "連線成功（{{ms}} 毫秒，{{attempts}} 次嘗試）",

  // -- P5.5.1 AI 複核狀態 --
  "AI review idle": "AI 複核未執行",
  "Run again": "再跑一次",
  "Go to settings → AI models": "前往設定 → AI 模型",

  // -- P5.5.1 知識庫管理 --
  "Import Markdown": "匯入 Markdown",
  "Show archived": "顯示已封存",
  "Knowledge draft": "草稿",
  "Knowledge published": "已發佈",
  "Knowledge archived": "已封存",
  Metadata: "中繼資料",
  "Last verified": "最近核對",
  "Knowledge note": "備註",
  "Save metadata": "儲存中繼資料",
  "Archived or disabled knowledge does not participate in AI retrieval.":
    "已封存或未啟用的知識不會參與 AI 檢索。",
  "Archive knowledge": "封存知識",
  'Archiving "{{title}}" hides it from AI retrieval; its content and version history are kept.':
    "封存「{{title}}」後它不再參與 AI 檢索，但內容與歷史版本都會保留。",
  "Preview this version": "預覽該版本",
  "Previewing version {{version}}": "正在預覽第 {{version}} 版",
  "Restore version {{version}}": "還原第 {{version}} 版",
  "Version {{version}} content will be saved as a new version (v{{next}}). History is never rewritten.":
    "第 {{version}} 版的內容將儲存為一個新版本（v{{next}}），歷史記錄不會被改寫。",
} as const;
