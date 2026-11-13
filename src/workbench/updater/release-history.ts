/**
 * Published GitHub Releases, checked 2026-11-05 (not every Git tag was published).
 * Dates: GitHub published_at; v0.1.18 uses the release tag date (user confirmed
 * the release; the public GitHub release listing has not included it yet).
 * Summaries: release text and commits since the
 * preceding published release. v0.1.20 is built from the current worktree; its
 * date is the planned release date.
 * Source: https://github.com/npcxl/BLS-OPS/releases
 */
/** 一条更新项。英文缺省时回退中文（见 `pickText`）。 */
export interface ReleaseChange {
  kind: "feature" | "fix";
  title: string;
  text: string;
  /** 英文标题；不填则英文界面显示 `title`。 */
  titleEn?: string;
  /** 英文说明；不填则英文界面显示 `text`。 */
  textEn?: string;
}

export interface ReleaseHistoryEntry {
  version: string;
  date: string;
  title: string;
  /** 英文标题；不填则英文界面显示 `title`。 */
  titleEn?: string;
  upcoming?: boolean;
  changes: ReleaseChange[];
}

/**
 * 按界面语言取文案。
 *
 * 更新日志是随应用一起发布的**静态数据**，不走 `i18n` 资源表（那会变成几十个
 * 无意义的 key）。英文缺省时回退中文，避免英文界面出现空白条目。
 */
export function pickText(zh: string, en: string | undefined, english: boolean): string {
  return english && en ? en : zh;
}

export const releaseHistory: ReleaseHistoryEntry[] = [
  { version: "0.1.30", date: "2026-11-13", title: "终端输入栏候选与选区", titleEn: "Candidate bar and selection in the terminal input", changes: [
    { kind: "feature", title: "横向候选栏", titleEn: "Inline suggestion bar", text: "输入栏上方出现微软输入法式的候选条：贴着弧线上的光标，横排 3–5 条、首选轻高亮、末尾标「Tab 补全」。靠近右边界向左收、底部空间不足翻到上方，绝对定位不占布局，出现和消失都不会让终端跳动。", textEn: "A Microsoft-IME-style strip appears under the curved caret: 3–5 candidates, the first one lightly highlighted, \"Tab to fill\" at the end. It flips above the caret when there is no room below and shifts left near the right edge. Absolutely positioned, so the terminal never jumps when it appears or disappears." },
    { kind: "feature", title: "本地优先的补全", titleEn: "Local-first completion", text: "命令名、子命令、当前服务器历史都在内存里同步算好，输入那一刻就有（`doc` → docker、`docker ` → ps/logs/exec）；目录、容器、服务名异步补进来。命令库里没有、但执行过的命令从该服务器历史召回，标「历史」。", textEn: "Command names, subcommands and this server's history are computed in memory and show up on the keystroke (doc → docker, docker + space → ps/logs/exec). Directories, containers and services are filled in asynchronously. Commands that are not in the catalog but have been run on this server are recalled from its history and labelled \"history\"." },
    { kind: "feature", title: "选区高亮", titleEn: "Selection highlight", text: "按原生 input 的选区在弧线上画高亮条，选中文字提亮：Ctrl+A 覆盖全部可见文字，Shift+方向键 只高亮对应字符；高亮跟随长命令横向滚动，并裁在文字区内不会盖住发送按钮。", textEn: "Drawn from the native input selection: Ctrl+A covers everything visible, Shift+Arrow highlights just those characters. The highlight follows horizontal scrolling and is clipped to the text area, so it never covers the Send button." },
    { kind: "fix", title: "空格不再和提示打架", titleEn: "Space no longer fights the popup", text: "按编辑位置判断：行尾或命令中间插入空格都只多一个空格，上一轮候选与灰字同时收起、也不会被 Tab 选中；连续空格不弹窗；继续输入 `l` 立刻给出 `logs`。Ctrl+Space 可主动查看当前位置的候选（子命令 / 路径 / 容器）。", textEn: "Judged by edit position: pressing space at the end of the line or in the middle of a command only inserts a space, hides the previous candidates and ghost text, and Tab can no longer pick them. Consecutive spaces stay quiet; typing l brings logs back immediately. Ctrl+Space shows candidates for the current position (subcommands / paths / containers)." },
    { kind: "fix", title: "Esc 收起后不再自动弹出", titleEn: "Esc stays closed", text: "按 Esc 收起候选后，即使远程目录 / 容器结果晚到也不会重新弹出浮层或灰字；此时 Tab 恢复浏览器正常的焦点导航，不会填进屏幕上看不到的东西。", textEn: "After Esc, late remote results will not reopen the popup or the ghost text; Tab falls back to normal focus navigation instead of filling in something you cannot see." },
    { kind: "fix", title: "候选选不中", titleEn: "Candidates that could not be clicked", text: "候选改用稳定 ID 记录选中项，并用 mousedown 直接填入（不再依赖 click）——之前异步结果插到前面时按钮会重挂载，点击落空、Tab 也可能填进屏幕外那条。数字键 1–6 直接选，`=` / `-` 翻页。", textEn: "The selected item is tracked by a stable ID and applied on mousedown instead of click, so async results reordering the list can no longer swallow the click. 1–6 pick a candidate, = and - page through them." },
    { kind: "fix", title: "Ctrl+C 复制", titleEn: "Ctrl+C copies", text: "输入框里有选区时 Ctrl+C 复制所选文字并保留命令；没有选区才清空草稿。中断命令改为右下角的显式按钮，误触不会打断服务器上的进程。", textEn: "With a selection it copies the selected text and keeps the command; without one it clears the draft. Interrupting a running command is now an explicit button, so a stray Ctrl+C cannot kill a process on the server." },
    { kind: "fix", title: "数据库与文件面板", titleEn: "Database and file panel", text: "数据库工作项标题的「对象」改为走翻译（英文显示 Object）；切换表格时右侧 DDL 自动跟随；表头筛选加了明确的「应用筛选」按钮。文件面板：`/proc`、`/sys`、`/dev` 下的虚拟文件不再显示 128 TB，改为 —。", textEn: "The \"对象\" tab title is translated (Object in English), the DDL panel follows the current table, and the table filter has an explicit Apply button. Virtual files under /proc, /sys and /dev no longer show 128 TB — they show a dash." },
  ] },
  { version: "0.1.29", date: "2026-11-12", title: "命令块配色与文件大小修复", changes: [
    { kind: "fix", title: "命令块误标红", text: "修复「上一条命令报错会把下一条的正常输出整片标红」：命令与结果的配对改为按本次提交的块 id，不再取「最后一个未完成块」；错误块的红色也收窄到命令行与其下紧邻的一行，正常输出不再被染红。" },
    { kind: "fix", title: "文件大小", text: "/proc、/sys、/dev 下的内核虚拟文件不再显示大小（/proc/kcore 恒为 128 TiB、设备节点为 0），改为 —；真实文件的大小显示不变。" },
  ] },
  { version: "0.1.28", date: "2026-11-11", title: "终端对话式输入与命令块", changes: [
    { kind: "feature", title: "对话式输入", text: "终端下方新增独立输入条（弧形 CurvedInput：文字、光标、发送键都沿弧线走），Enter 或点按钮发送，上方的终端变成纯输出区。中文输入法、光标遮挡、行重绘这些在裸终端里难以避免的问题一次性绕开。" },
    { kind: "feature", title: "命令补全", text: "输入命令词时弹出候选（内置 300+ 命令，前缀与缩写都行：doc → docker、dc → docker），1-9 或 Tab 直接选、↑↓ 移动、Esc 关闭；不选则原样执行，输入法组合期间不拦截。" },
    { kind: "feature", title: "命令块条纹", text: "每条命令与它的输出合成一个片区：成功块在两种淡底间交替，失败块（退出码非 0）默认淡红，不用悬停也能看出哪条命令报错了。" },
    { kind: "fix", title: "发送与提交", text: "修复回车/点击发送无反应：命令块的装饰用了 xterm 的 proposed API，未开启时抛错会打断整条提交链路；现在开启该选项并给装饰加了兜底，装饰失败也照常发送。" },
    { kind: "fix", title: "vim 之后输入条变灰", text: "全屏程序（vim/top）的进出改由输出判断，不再依赖按键事件——之前进过 vim 后输入条会被永久禁用。" },
  ] },
  { version: "0.1.27", date: "2026-11-11", title: "中英双语与命令知识库", changes: [
    { kind: "feature", title: "中英双语", text: "语言精简为中国（简体）与英文；首次启动按系统语言与时区推断（大中华区默认中文），手动切换后以选择为准。英文补齐数据库工作台、引擎说明、导出格式、只读原因与 300+ 条终端命令说明。" },
    { kind: "fix", title: "中文界面", text: "修复中文界面偶发显示英文：英文资源里给中文 key 补了译文后，中文缺这条就会回退成英文。现在中文 key 始终命中自身，也不会覆盖已写好的中文措辞。" },
    { kind: "fix", title: "新建连接", text: "数据库引擎下拉宽度跟随触发按钮（原来固定 340px，说明文字被大量截断）；能力面板的受限原因与验证备注一并本地化。" },
    { kind: "feature", title: "命令知识库", text: "内置命令知识库迁移为 catalog.json 并在构建期生成，检索与展示行为不变，以后补命令只改数据文件。" },
  ] },
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
