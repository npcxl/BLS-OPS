/**
 * Published GitHub Releases, checked 2026-11-04 (not every Git tag was published).
 * Dates: GitHub published_at; v0.1.18 uses the release tag date (user confirmed
 * the release; the public GitHub release listing has not included it yet).
 * Summaries: release text and commits since the
 * preceding published release. The upcoming v0.1.19 entry is prepared from the
 * current worktree for release; its date is the planned release date.
 * Source: https://github.com/npcxl/BLS-OPS/releases
 */
export interface ReleaseHistoryEntry {
  version: string;
  date: string;
  title: string;
  upcoming?: boolean;
  changes: { kind: "feature" | "fix"; title: string; text: string }[];
}

export const releaseHistory: ReleaseHistoryEntry[] = [
  { version: "0.1.19", date: "2026-11-04", title: "多格式导出与工作区体验优化", upcoming: true, changes: [
    { kind: "feature", title: "数据导出", text: "支持 CSV、TSV、JSON、JSON Lines、SQL INSERT、HTML、XML，统一导出界面。" },
    { kind: "feature", title: "工作标签", text: "支持顶部标签与右侧列表切换，统一搜索、固定和关闭操作。" },
    { kind: "fix", title: "操作反馈", text: "右键时高亮目标行，修复选中数据后滚动条误触框选与串轴滚动。" },
    { kind: "feature", title: "更新日志", text: "补齐历史版本摘要，支持分类筛选与动态渐变玻璃背景。" },
  ] },
  { version: "0.1.18", date: "2026-11-03", title: "多引擎数据库与桌面交互升级", changes: [
    { kind: "feature", title: "数据库引擎", text: "接入 Redis 键浏览与编辑，完善 PostgreSQL、SQLite 与 MariaDB 支持。" },
    { kind: "feature", title: "桌面交互", text: "新增独立右键菜单、已打开标签搜索和自定义快捷键。" },
    { kind: "fix", title: "数据修改", text: "修复表格编辑误报冲突，新增待提交行与新旧值差异高亮。" },
    { kind: "fix", title: "连接与查询", text: "完善 MySQL TLS 与 SSH 隧道，修复 PostgreSQL 事务、流式查询与导出。" },
  ] },
  { version: "0.1.17", date: "2026-10-29", title: "数据库工作台与数据编辑", changes: [
    { kind: "feature", title: "数据库工作台", text: "新增对象浏览、表格编辑、结构设计与独立 SQL 窗口。" },
    { kind: "feature", title: "备份与传输", text: "新增配置备份恢复与文件传输任务中心。" },
    { kind: "fix", title: "性能与可靠性", text: "优化结果缓存、数据网格和会话生命周期，完善 DDL 异常处理。" },
  ] },
  { version: "0.1.16", date: "2026-10-27", title: "终端、凭据与文件体验完善", changes: [
    { kind: "feature", title: "连接与终端", text: "支持私钥文件导入、连接光条和精简提示符。" },
    { kind: "fix", title: "保存可靠性", text: "修复凭据保存与远程文件写入可能丢失数据的问题。" },
    { kind: "fix", title: "响应速度", text: "优化终端输入、目录大小统计与搜索，修复取消和重连缓存问题。" },
  ] },
  { version: "0.1.15", date: "2026-09-24", title: "复制粘贴与文件错误提示", changes: [
    { kind: "feature", title: "终端剪贴板", text: "支持 Ctrl+C/V 与右键复制粘贴。" },
    { kind: "fix", title: "权限与提示", text: "使用原生剪贴板消除权限弹窗，文件错误显示原因和路径。" },
  ] },
  { version: "0.1.13", date: "2026-09-14", title: "终端复制粘贴", changes: [
    { kind: "feature", title: "终端交互", text: "支持复制粘贴，并禁用 WebView 默认右键菜单。" },
  ] },
  { version: "0.1.12", date: "2026-09-14", title: "外部下载链接修复", changes: [
    { kind: "fix", title: "更新下载", text: "通过系统链接插件打开外部下载地址。" },
  ] },
  { version: "0.1.10", date: "2026-09-14", title: "更新安装与终端高亮修复", changes: [
    { kind: "fix", title: "安装更新", text: "修复“安装并重启”点击无响应。" },
    { kind: "fix", title: "命令高亮", text: "将命令块高亮限制在可视区，修正背景显示。" },
  ] },
  { version: "0.1.8", date: "2026-09-08", title: "发布验证", changes: [
    { kind: "fix", title: "版本发布", text: "发布测试版本；该版本仅调整版本号，无新增功能记录。" },
  ] },
  { version: "0.1.7", date: "2026-09-08", title: "自动更新链路完善", changes: [
    { kind: "fix", title: "更新诊断", text: "更新失败可复制诊断信息，便于定位原因。" },
    { kind: "fix", title: "发布下载", text: "修复更新源直链、草稿查询与发布附件下载。" },
  ] },
  { version: "0.1.3", date: "2026-09-08", title: "远程开发与终端交互", changes: [
    { kind: "feature", title: "远程开发", text: "支持使用 VS Code Remote-SSH 打开远程目录。" },
    { kind: "feature", title: "操作入口", text: "新增系统托盘与命令块悬浮复制，优化命令中心和补全。" },
    { kind: "fix", title: "使用体验", text: "修复文件预览滚动和更新检测误报。" },
  ] },
  { version: "0.1.2", date: "2026-09-07", title: "自动更新与基础体验完善", changes: [
    { kind: "feature", title: "自动更新", text: "完善更新发布流程与安装前保护。" },
    { kind: "feature", title: "语言支持", text: "补齐简体、繁体中文翻译，统一产品名称。" },
    { kind: "fix", title: "启动与任务", text: "修复安装版白屏及目录大小任务取消问题。" },
  ] },
];
