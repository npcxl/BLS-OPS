/**
 * Published GitHub Releases, checked 2026-11-05 (not every Git tag was published).
 * Dates: GitHub published_at; v0.1.18 uses the release tag date (user confirmed
 * the release; the public GitHub release listing has not included it yet).
 * Summaries: release text and commits since the
 * preceding published release. v0.1.20 is built from the current worktree; its
 * date is the planned release date.
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
  { version: "0.1.26", date: "2026-11-11", title: "修复监控趋势图崩溃", changes: [
    { kind: "fix", title: "监控图表", text: "修复 0.1.25 打不开趋势图的问题：渐变色用了 CSS Color 4 的 rgb(r g b / a) 写法，CanvasGradient 只认传统 rgba(r, g, b, a)，渲染时抛 addColorStop 异常、整块图表中断。现在统一输出 rgba()。" },
  ] },
  { version: "0.1.25", date: "2026-11-11", title: "SQL 补全体验修复", changes: [
    { kind: "fix", title: "补全候选", text: "输入第二个字母不再突然空白：以前 CodeMirror 复用第一次的 200 条结果做过滤，表多时关键字排在后面，一过滤就没了；现在每次输入都重新计算候选。" },
    { kind: "fix", title: "选中态", text: "补全面板选中行只保留淡背景（去掉整行蓝底与左侧色条），匹配字符改用下划线标示，不会再被同色背景吞掉首字母。" },
    { kind: "fix", title: "编辑器", text: "去掉活动行与选区上的 1px 描边 —— 在不同主题下它会显示成文字上下各一条虚线。" },
  ] },
  { version: "0.1.24", date: "2026-11-11", title: "终端命令智能补全与监控图表", changes: [
    { kind: "feature", title: "命令名补全", text: "内置 300+ 常用命令（含 systemd、Docker、K8s、数据库客户端、排障工具）：敲 unz 直接提示 unzip，拼错一个字符（连相邻键敲反 unizp）也能纠正；补全后自动带空格，接着就能输参数。" },
    { kind: "feature", title: "按语义补文件", text: "unzip 只提示 .zip、tar 只提示压缩包、unrar 只提示 .rar、gunzip 只提示 .gz；目录始终保留，方便继续往里走。当前目录没有对应类型时会明说，而不是静默空白。" },
    { kind: "feature", title: "趋势图换 ECharts", text: "监控页四条趋势改平滑曲线 + 渐变面积，鼠标悬停显示时刻与数值；颜色跟随主题 token，亮色/暗色都不刺眼。按需引入，只打包 line/grid/tooltip。" },
    { kind: "fix", title: "cd 补全", text: "Shell Integration 还没报回当前目录时不再只显示 unknown，而是退回家目录列出可进入的目录；~ 仍然在 home 未知时明确拒绝，不编造路径。" },
  ] },
  { version: "0.1.23", date: "2026-11-10", title: "查询结果分页与 GPU 监控", changes: [
    { kind: "fix", title: "超预算不再断连", text: "结果超过展示上限时不再 KILL 查询并丢弃连接（以前会弹「会话连接已关闭」）；现在继续读完但只保留预算内的行，连接保持可用。默认上限同时提高到 10000 行 / 32 MiB。" },
    { kind: "feature", title: "结果分页", text: "单条只读查询按 1000 行一页浏览，结果区提供上一页 / 第 N 页 / 下一页；翻页按 LIMIT/OFFSET 重新执行，不缓存全量结果。多语句与写操作不分页。" },
    { kind: "feature", title: "GPU 监控", text: "装了 NVIDIA 驱动的服务器显示每块卡的利用率、显存、温度与功耗；没有 nvidia-smi 的机器静默跳过，不显示空卡片，也不影响快照其它指标。" },
    { kind: "feature", title: "新建查询带当前表", text: "从某张表新建查询时直接带上 SELECT * FROM 库.表 LIMIT 200；空白处新建从空白开始，不再继承上一次的 SQL。" },
    { kind: "fix", title: "终端", text: "文件面板默认收起（开关按机器记住）；命令历史对快速连接也记录；删除后重新创建的同名文件不再点不动。" },
    { kind: "feature", title: "监控页改版", text: "指标卡带状态徽章（正常 / 负载适中 / 偏高）与型号、swap、文件系统数等上下文；趋势图改渐变面积并标注样本数与峰值；磁盘明细加分区图标、健康图例与底部汇总（聚合利用率、最后采集时间）。小屏 1 列、中屏 2 列、宽屏 4 列自适应。" },
    { kind: "fix", title: "界面", text: "服务器列表分组标题弱化并缩进；监控页限制最大宽度，全屏不再被拉伸；连接失败通知改为居中。" },
  ] },
  { version: "0.1.22", date: "2026-11-09", title: "修复查询结果不显示", changes: [
    { kind: "fix", title: "查询结果", text: "修复查询返回了行数（例如 20 行、14 KiB）但网格一片空白：行批次原地追加后数组引用未变，grid 的 useMemo 一直返回首次缓存的空数组；现在把行数纳入依赖，数据到达即渲染。" },
  ] },
  { version: "0.1.21", date: "2026-11-06", title: "修复崩溃与 SQL 草稿丢失", changes: [
    { kind: "fix", title: "结构页", text: "修复打开表/视图结构页时 React 直接崩溃（Rendered more hooks than during the previous render）：结构面板在详情到达前提前返回，详情到达后多调一个 hook。" },
    { kind: "fix", title: "服务器监控", text: "修复从「未选服务器」切到已选服务器时同一类 hook 数量变化导致的崩溃。" },
    { kind: "fix", title: "SQL 草稿", text: "修复重启或新建查询后编辑器一片空白：查询工作项的 id 每次重建都会变，按 id 存的草稿读不到；现在额外按连接保留最后一份草稿，且空内容不再覆盖已有草稿。" },
    { kind: "fix", title: "SQL 补全", text: "修复输入 SE 只看到表名、看不到 SELECT：库里表太多时表名把关键字挤出候选上限，现在关键字和函数优先入列。" },
  ] },
  { version: "0.1.20", date: "2026-11-05", title: "SQL 自动补全与视图浏览修复", changes: [
    { kind: "feature", title: "SQL 补全", text: "编辑器按光标位置提示库、表、字段与关键字；提示语言跟随连接引擎（MySQL / PostgreSQL / SQLite），不再一律按 MySQL 给词。" },
    { kind: "feature", title: "补全数据", text: "元数据首次用到才查询，资产树已加载的直接复用；会话断开时不给过期字段名。" },
    { kind: "fix", title: "视图浏览", text: "修复打开视图只显示一条无内容错误、表格空白的问题：读取视图定义时列数不匹配导致后端中断，现在按列解析，视图可正常浏览数据与查看 DDL。" },
    { kind: "fix", title: "错误提示", text: "后端没返回内容时不再显示 [object ArrayBuffer]，改为可读原因；表/视图结构读取失败会直接说明，不再静默留一张空表。" },
  ] },
  { version: "0.1.19", date: "2026-11-04", title: "多格式导出与工作区体验优化", changes: [
    { kind: "feature", title: "查询结果编辑", text: "单表且包含完整主键的结果可直接编辑，支持暂存、差异查看与应用修改。" },
    { kind: "fix", title: "查询连接", text: "修复多连接新建查询时的循环更新，切换连接清空库选择并保留 SQL。" },
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
