/**
 * zh-CN · 远程文件面板/编辑器/预览 —— 由对应模块的 i18n 代理维护。
 *
 * 覆盖范围：`src/workbench/views/remote-file/**` 与 `src/workbench/views/preview/**`。
 * key 与组件里 `t("...")` 逐字一致（natural keys，英文即 key）；
 * 跨模块通用词（Confirm/Cancel/Close/Delete/Rename/Refresh/Search…）在
 * `common.ts`，这里只放本模块文案。
 */
export default {
  // -- 面板骨架（RemoteFilePanel） --
  "Remote files": "远程文件",
  "Drag to resize": "拖动调整宽度",
  Forward: "前进",
  "Go up": "上一级",
  "Upload files to this directory": "上传文件到当前目录",
  "Collapse panel": "折叠面板",

  // -- 右键菜单 --
  "Download to local…": "下载到本地…",
  "Download to local": "下载到本地",
  "Create a copy": "创建副本",
  "Copy full path": "复制完整路径",
  "Copy file name": "复制文件名",
  "Upload files…": "上传文件…",

  // -- 名称对话框（结构字段存 key，渲染处 t()） --
  "New name": "新名称",
  "Copy name": "副本名称",
  "Folder name": "文件夹名称",
  "File name": "文件名称",

  // -- 上传 --
  "Upload to {{path}}": "上传到 {{path}}",
  "Upload complete": "文件上传完成",
  "{{count}} files uploaded": "{{count}} 个文件上传完成",
  "Uploading {{count}} files…": "正在上传 {{count}} 个文件…",
  "Do not close this panel": "请勿关闭面板",
  "Drop to upload here": "松开以上传到当前目录",
  "Files and folders supported": "支持多个文件与文件夹",
  "This folder is empty. Drop local files here to upload.": "此目录为空。可拖入本地文件上传。",

  // -- 下载 --
  "Download {{name}}": "下载 {{name}}",
  "Downloaded {{name}} ({{size}})": "已下载“{{name}}”（{{size}}）",

  // -- 删除确认 --
  "Delete folder": "删除文件夹",
  "Delete file": "删除文件",
  'Delete folder "{{name}}"? Everything inside will also be deleted. This action cannot be undone.':
    "确定删除文件夹“{{name}}”？文件夹内的全部内容也会一并删除，此操作不可撤销。",
  'Delete file "{{name}}"? This action cannot be undone.':
    "确定删除文件“{{name}}”？此操作不可撤销。",

  // -- 连接状态 --
  "Connection lost. File browsing is unavailable.": "连接已断开，文件浏览不可用。",

  // -- 目录大小（utils.ts · 纯 TS 模块走 i18n.t） --
  Folder: "文件夹",
  Queued: "排队中",
  "Queued…": "排队中…",
  "Computing…": "计算中…",
  Completed: "已完成",
  "Partial size": "部分统计",
  "Permission denied": "权限不足",
  Cancelled: "已取消",
  "Timed out": "计算超时",
  "Session disconnected": "连接已断开",
  "Computation failed": "计算失败",
  "Folder · {{status}}": "文件夹 · {{status}}",
  "{{name}} files": "{{name}} 个文件",

  // -- 名称校验（utils.ts · validateName） --
  "Name cannot be empty": "名称不能为空",
  "Name cannot contain /": "名称不能包含 /",
  "Name cannot be . or ..": "名称不能是 . 或 ..",

  // -- 通用预览弹窗（FilePreviewModal） --
  "Reading file…": "正在读取文件…",
  "You can download it to view locally.": "可直接下载到本地查看。",
  "Saved {{size}} → {{path}}": "已保存 {{size}} → {{path}}",
  "Download failed: {{message}}": "下载失败：{{message}}",

  // -- 压缩包（ArchivePreview） --
  "{{name}} entries": "{{name}} 个条目",
  "({{name}} folders)": "（{{name}} 个文件夹）",
  "Filter paths…": "过滤路径…",
  Path: "路径",
  Size: "大小",
  'No entries match "{{filter}}"': "没有匹配 “{{filter}}” 的条目。",
  "Uncompressed size ≈ {{size}}": "解压后约 {{size}}",
  "Listing only — nothing extracted": "仅列出内容，未解压",

  // -- 代码/文本（CodeText） --
  "Wrap lines": "自动换行",
  "Find (Ctrl+F)": "查找（Ctrl+F）",
  "{{name}} lines": "{{name}} 行",
  "Loading viewer…": "正在加载查看器…",

  // -- 文档/幻灯片（DocPreview） --
  Table: "表格",

  // -- 十六进制（HexPreview） --
  Hex: "十六进制",
  "Detected as {{name}}": "识别为 {{name}}",
  "Showing {{shown}} of {{total}}": "已显示 {{shown}}/{{total}}",
  "Show next {{size}}": "继续显示后 {{size}}",

  // -- 图片（ImagePreview） --
  "Fit to window": "适应窗口",
  Fit: "适应",
  "Auto fit": "自适应",
  "Zoom out": "缩小",
  "Zoom in": "放大",

  // -- 音视频（MediaPreview） --
  Audio: "音频",
  Video: "视频",
  "This format cannot be played here ({{mime}}). Download it and open with a local player.":
    "当前环境无法播放这种格式（{{mime}}）。可下载后用本地播放器打开。",

  // -- PDF（PdfPreview） --
  "Loading PDF…": "正在加载 PDF…",
  "Cannot render this PDF": "无法渲染这个 PDF",
  "Failed to render page": "渲染页面失败",
  "This PDF is encrypted and needs a password to preview.": "这个 PDF 已加密，需要密码才能预览。",
  "This is not a valid PDF file, or the file is corrupted.": "这不是有效的 PDF 文件，或文件已损坏。",
  "{{message}}: {{detail}}": "{{message}}：{{detail}}",

  // -- 表格（SheetPreview） --
  "Show next {{count}} rows ({{name}} total)": "继续显示后 {{count}} 行（共 {{name}} 行）",
  "{{name}} rows × {{cols}} columns": "{{name}} 行 × {{cols}} 列",
  "{{name}} more rows not rendered": "另有 {{name}} 行未渲染",
} as const;
