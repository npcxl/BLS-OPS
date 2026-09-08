/**
 * zh-TW · 遠端檔案面板/編輯器/預覽 —— 由對應模組的 i18n 代理維護。
 *
 * 覆蓋範圍：`src/workbench/views/remote-file/**` 與 `src/workbench/views/preview/**`。
 * key 與元件裡 `t("...")` 逐字一致（natural keys，英文即 key）；
 * 跨模組通用詞（Confirm/Cancel/Close/Delete/Rename/Refresh/Search…）在
 * `common.ts`，這裡只放本模組文案。
 */
export default {
  // -- 面板骨架（RemoteFilePanel） --
  "Remote files": "遠端檔案",
  "Drag to resize": "拖動調整寬度",
  Forward: "前進",
  "Go up": "上一級",
  "Upload files to this directory": "上傳檔案到當前目錄",
  "Collapse panel": "摺疊面板",

  // -- 右鍵選單 --
  "Download to local…": "下載到本地…",
  "Download to local": "下載到本地",
  "Open in VSCode": "在 VSCode 中開啟",
  "Create a copy": "建立副本",
  "Copy full path": "複製完整路徑",
  "Copy file name": "複製檔名",
  "Upload files…": "上傳檔案…",

  // -- 名稱對話方塊（結構欄位存 key，渲染處 t()） --
  "New name": "新名稱",
  "Copy name": "副本名稱",
  "Folder name": "資料夾名稱",
  "File name": "檔名稱",

  // -- 上傳 --
  "Upload to {{path}}": "上傳到 {{path}}",
  "Upload complete": "檔案上傳完成",
  "{{count}} files uploaded": "{{count}} 個檔案上傳完成",
  "Uploading {{count}} files…": "正在上傳 {{count}} 個檔案…",
  "Do not close this panel": "請勿關閉面板",
  "Drop to upload here": "鬆開以上傳到當前目錄",
  "Files and folders supported": "支援多個檔案與資料夾",
  "This folder is empty. Drop local files here to upload.": "此目錄為空。可拖入本地檔案上傳。",

  // -- 下載 --
  "Download {{name}}": "下載 {{name}}",
  "Downloaded {{name}} ({{size}})": "已下載“{{name}}”（{{size}}）",

  // -- 刪除確認 --
  "Delete folder": "刪除資料夾",
  "Delete file": "刪除檔案",
  'Delete folder "{{name}}"? Everything inside will also be deleted. This action cannot be undone.':
    "确定删除文件夹“{{name}}”？文件夹内的全部内容也会一并删除，此操作不可撤销。",
  'Delete file "{{name}}"? This action cannot be undone.':
    "确定删除文件“{{name}}”？此操作不可撤销。",

  // -- 連線狀態 --
  "Connection lost. File browsing is unavailable.": "連線已斷開，檔案瀏覽不可用。",

  // -- 目錄大小（utils.ts · 純 TS 模組走 i18n.t） --
  Folder: "資料夾",
  Queued: "排隊中",
  "Queued…": "排隊中…",
  "Computing…": "計算中…",
  Completed: "已完成",
  "Partial size": "部分統計",
  "Permission denied": "許可權不足",
  Cancelled: "已取消",
  "Timed out": "計算超時",
  "Session disconnected": "連線已斷開",
  "Computation failed": "計算失敗",
  "Folder · {{status}}": "資料夾 · {{status}}",
  "{{name}} files": "{{name}} 個檔案",

  // -- 名稱校驗（utils.ts · validateName） --
  "Name cannot be empty": "名稱不能為空",
  "Name cannot contain /": "名稱不能包含 /",
  "Name cannot be . or ..": "名稱不能是 . 或 ..",

  // -- 通用預覽彈窗（FilePreviewModal） --
  "Reading file…": "正在讀取檔案…",
  "You can download it to view locally.": "可直接下載到本地檢視。",
  "Saved {{size}} → {{path}}": "已儲存 {{size}} → {{path}}",
  "Download failed: {{message}}": "下載失敗：{{message}}",

  // -- 壓縮包（ArchivePreview） --
  "{{name}} entries": "{{name}} 個條目",
  "({{name}} folders)": "（{{name}} 個資料夾）",
  "Filter paths…": "過濾路徑…",
  Path: "路徑",
  Size: "大小",
  'No entries match "{{filter}}"': "沒有匹配 “{{filter}}” 的條目。",
  "Uncompressed size ≈ {{size}}": "解壓後約 {{size}}",
  "Listing only — nothing extracted": "僅列出內容，未解壓",

  // -- 程式碼/文本（CodeText） --
  "Wrap lines": "自動換行",
  "Find (Ctrl+F)": "查詢（Ctrl+F）",
  "{{name}} lines": "{{name}} 行",
  "Loading viewer…": "正在載入檢視器…",

  // -- 文件/幻燈片（DocPreview） --
  Table: "表格",

  // -- 十六進位制（HexPreview） --
  Hex: "十六進位制",
  "Detected as {{name}}": "識別為 {{name}}",
  "Showing {{shown}} of {{total}}": "已顯示 {{shown}}/{{total}}",
  "Show next {{size}}": "繼續顯示後 {{size}}",

  // -- 圖片（ImagePreview） --
  "Fit to window": "適應視窗",
  Fit: "適應",
  "Auto fit": "自適應",
  "Zoom out": "縮小",
  "Zoom in": "放大",

  // -- 音影片（MediaPreview） --
  Audio: "音訊",
  Video: "影片",
  "This format cannot be played here ({{mime}}). Download it and open with a local player.":
    "当前环境无法播放这种格式（{{mime}}）。可下载后用本地播放器打开。",

  // -- PDF（PdfPreview） --
  "Loading PDF…": "正在載入 PDF…",
  "Cannot render this PDF": "無法渲染這個 PDF",
  "Failed to render page": "渲染頁面失敗",
  "This PDF is encrypted and needs a password to preview.": "這個 PDF 已加密，需要密碼才能預覽。",
  "This is not a valid PDF file, or the file is corrupted.": "這不是有效的 PDF 檔案，或檔案已損壞。",
  "{{message}}: {{detail}}": "{{message}}：{{detail}}",

  // -- 表格（SheetPreview） --
  "Show next {{count}} rows ({{name}} total)": "繼續顯示後 {{count}} 行（共 {{name}} 行）",
  "{{name}} rows × {{cols}} columns": "{{name}} 行 × {{cols}} 列",
  "{{name}} more rows not rendered": "另有 {{name}} 行未渲染",

  // -- 遠端檔案面板（RemoteFilePanel）--
  "New folder": "新建資料夾",
  "New file": "新建檔案",
  "New file.txt": "新建檔案.txt",
  "{{name}} - Copy": "{{name}} - 副本",
} as const;
