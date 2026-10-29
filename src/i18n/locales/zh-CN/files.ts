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
  "More actions": "更多操作",
  "Cannot open {{path}} — {{reason}}": "无法打开 {{path}}：{{reason}}",
  "Upload files to this directory": "上传文件到当前目录",
  "Collapse panel": "折叠面板",

  // -- 右键菜单 --
  "Download to local…": "下载到本地…",
  "Download to local": "下载到本地",
  "Open in VSCode": "在 VSCode 中打开",
  "Already open in VSCode": "该文件已在 VSCode 中打开",
  "Opened {{name}} in VSCode — saving syncs back to the server":
    "已在 VSCode 打开“{{name}}”，保存后自动回传服务器",
  "Save sync failed: {{message}}": "保存回传失败：{{message}}",
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

  // -- 远程文件面板（RemoteFilePanel）--
  "New folder": "新建文件夹",
  "New file": "新建文件",
  "New file.txt": "新建文件.txt",
  "{{name}} - Copy": "{{name}} - 副本",

  // -- 编辑器：版本冲突与历史（FileEditorModal）--
  History: "历史版本",
  "This file changed on the server": "服务器上的文件已被修改",
  "You opened this file earlier, but it has been modified since. Saving now would overwrite those changes.":
    "你打开这个文件之后，它又被修改过。现在保存会覆盖那部分改动。",
  "Current version: {{size}} KB · modified {{time}}": "当前版本：{{size}} KB · 修改于 {{time}}",
  "Unknown time": "时间未知",
  "The file no longer exists on the server.": "该文件在服务器上已不存在。",
  "Reload from server": "从服务器重新加载",
  "Save as a copy": "另存为副本",
  "Overwrite anyway": "仍然覆盖",
  "Version history": "历史版本",
  "Kept on this machine before each overwrite. Older copies roll off automatically.":
    "每次覆盖前保存在本机，旧副本会自动淘汰。",
  "No history yet — the first copy is recorded when you save over this file.":
    "还没有历史版本 —— 第一次覆盖保存时会记录一份。",
  "{{size}} KB": "{{size}} KB",
  "Load this version": "载入这个版本",
  "Saved as {{path}}. The original file was left untouched.": "已另存为 {{path}}，原文件未被改动。",
  "The copy target changed too. Try again.": "副本目标也被改动了，请重试。",
  "Reloaded the current version from the server.": "已重新加载服务器上的当前版本。",
  "Loaded a historical version into the editor. Save to write it back.":
    "已把历史版本载入编辑器，保存后才会写回服务器。",

  // -- 回收站（TrashDialog / RemoteFilePanel 删除）--
  "Recycle bin": "回收站",
  "Move to recycle bin": "移入回收站",
  "Move file to recycle bin": "移入回收站",
  "Move folder to recycle bin": "移入回收站",
  'Move file "{{name}}" to the recycle bin? You can restore it later.':
    "把文件“{{name}}”移入回收站？之后可以恢复。",
  'Move folder "{{name}}" and everything inside to the recycle bin? You can restore it later.':
    "把文件夹“{{name}}”及其内容移入回收站？之后可以恢复。",
  "Delete permanently…": "永久删除…",
  "Delete permanently": "永久删除",
  "Delete {{name}} permanently?": "永久删除 {{name}}？",
  "This cannot be undone — no copy is kept in the recycle bin.": "此操作不可撤销 —— 回收站里不会保留副本。",
  "This cannot be undone — the file is gone for good.": "此操作不可撤销，文件将被彻底删除。",
  "Deleted files wait here before they are gone for good. Restore anything you still need.":
    "删除的文件会先放在这里，确认不再需要后再彻底删除。",
  "The recycle bin is empty.": "回收站是空的。",
  "{{count}} items": "{{count}} 项",
  "Empty recycle bin": "清空回收站",
  "Empty the recycle bin?": "清空回收站？",
  "Every entry is deleted permanently. This cannot be undone.":
    "所有条目都会被永久删除，此操作不可撤销。",
  Restore: "恢复",

  // -- 传输任务中心（TransferCenterDialog）--
  Transfers: "传输任务",
  "Transfers keep running in the background, even if you close this panel.":
    "关闭面板后，传输仍会在后台继续。",
  "No transfers yet.": "还没有传输任务。",
  "Transferring": "传输中",
  "Skipped (already exists)": "已跳过（同名文件已存在）",
  "Clear finished": "清理已结束",
  "{{count}} files queued for upload": "已排队 {{count}} 个上传任务",
  "{{count}} queued, {{skipped}} skipped (already exist)":
    "已排队 {{count}} 个，跳过 {{skipped}} 个（同名文件已存在）",
  "Download queued: {{name}}": "已加入下载队列：{{name}}",

  // -- 巡检模式（只读）--
  "Inspection mode: changes are disabled": "巡检模式：写操作已禁用",
  "Read-only": "只读",
  "Inspection mode: saving is disabled.": "巡检模式：保存已禁用。",
  "Inspection mode: editing is view-only. Turn it off in Settings to save changes.":
    "巡检模式下只能查看。要保存请先在设置里关闭巡检模式。",
} as const;
