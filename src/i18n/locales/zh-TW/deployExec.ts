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
} as const;
