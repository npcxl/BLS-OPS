# UI 技术规范

> 状态：**现行**，对照代码日期 2026-11-20。
> 交互细节（终端、数据库、极核）各自有专文；本篇是全局约定。

---

## 1. 技术栈

- React 19 + TypeScript 5.8 + Vite 7
- Tailwind CSS v4（Vite 插件，无 PostCSS）
- Zustand（只放 UI 与领域状态，终端输出不进 store）
- Tauri 2 + rusqlite（SQLite）
- antd 6 / `@ant-design/x` / CodeMirror 6 / ECharts 6 / xterm 6（按需懒加载）

---

## 2. 组件边界

- `src/workbench/` 负责外壳、导航、侧栏、标签与分屏；业务视图在 `views/<域>/`。
- 服务器等业务数据通过统一 API / store 获取，**组件内不散落 `invoke()`**。
- 终端输出属于会话流，由 xterm 直接消费事件，不进 Zustand。
- `connected` 只能由 `stores/session-store` 驱动，禁止静态假状态。
- 监控指标只来自 `monitor_snapshot`，读不到显示 `—`，禁止模拟值/随机数。
- 监控状态按标签隔离在 `monitor-store`：暂停、采集间隔、30 分钟趋势互不共享。
- 窗口隐藏或标签非活动时停止轮询；SSH 断开同样停止。
- 列表行必须 `memo` 化，回调引用稳定；长列表 hover/选中/右键不能全量重渲染。

---

## 3. 设计令牌与主题

- **唯一令牌源**：`src/styles/tokens.css`。`:root` 定义 RGB 通道变量（`--app`、`--surface-1/2/3`、`--surface-hover/active`、`--line`、`--fg*`、`--accent*`、`--ai*`、`--success/warning/danger`、`--tab-*`、`--glass-menu-*`），深色值在同一文件成对定义；文件中的 `@theme` 块把它们映射成 Tailwind 工具类（`bg-surface-3` / `text-fg-subtle` / `border-line`）。
- **CSS 禁写死十六进制背景色**；组件只用令牌工具类。
- 深色模式要"更轻"：选中态不要用实心亮块或强白色高光，用 `--surface-active` / `--accent-soft` 这类低对比层。
- 主题切换由 `hooks/use-theme.ts` 统一；原生窗口材质（Windows Acrylic）由 Rust `window_material` 同步，系统关闭透明效果时回落实色。
- 窗口 chrome：macOS 用原生（顶栏留出 `pl-[76px]`），Windows/Linux 自绘 `window-controls.tsx`；平台判定只走 `lib/platform.ts::isMacOS()`。

---

## 4. 层级与浮层

- 统一层级常量：`src/components/ui/overlay.ts` 的 `OVERLAY_Z`；不要各写 `z-[9999]`。
- 浮层用 `.glass-panel` / `.glass-panel-strong`：背景是实色 `--overlay`（按主题成对定义），不依赖 `backdrop-filter`；限高用 `calc(...vh)`。
- **嵌套 flex 里的百分比高度不可靠**：面板高度一律走 `style`，不要依赖 `h-full` 链。
- 浮层/横幅**不得遮挡命令行与输入区**。
- 每个浮层独立开关状态，禁止合并成一个布尔量。
- 点击外部、Esc、窗口失焦、尺寸变化都应关闭浮层；右键别处时菜单**移动而不是关闭重开**。

---

## 5. 弹窗（Modal / ConfirmDialog）

- 破坏性操作统一 `components/ui/confirm-dialog.tsx`，**禁用 `window.confirm`**。
- Modal 整体是 `max-h-[85vh]`，内容区已经是 `flex-1 overflow-y-auto`；表单里**不要再套一层** `max-h-* + overflow-auto`，否则出现内外双滚动条。
- Modal 的 `description` 只放确认、风险、上下文；**不要写功能介绍副标题**。
- 新建/进入类入口直接落到可用空白态，可选项放页面里，不要前置一个"介绍功能"的弹窗。
- 有内容产生就自动展开右栏（附件/上传/AI 文件日志统一走 `openPane`），不要只切标签。

---

## 6. 右键菜单

统一 `useContextMenu()`（`components/ui/context-menu.tsx`），不要手写浮动菜单：

```tsx
const menu = useContextMenu();
<div onContextMenu={menu.onContextMenu(() => [{ label: t("Delete"), danger: true, onSelect }])} />
<ContextMenu {...menu.props} />
```

约定：

- 左键任意处、Esc、窗口失焦、尺寸变化 → 立即关闭。
- 右键别处：菜单移动到新位置，不闪烁重开。
- 键盘 ↑↓ / Home / End / Enter 可操作，自动跳过分隔符与禁用项。
- 菜单 `memo` 化：父组件重渲染不带着菜单一起渲染。
- 危险操作放末尾并加 `danger`；有快捷键的动作写在 `hint`。

桌面级右键菜单（屏幕坐标、超出窗口）走独立透明窗口 `desktop_menu.rs`，**不要**用页面内 fixed/portal 模拟。

---

## 7. 文案与 i18n

- 所有用户可见文案走 `t()`；默认语言英文、`zh-CN` 全量。详见 `i18n.md`。
- 不在 JSX 写死中文（数据库工作台的中文 key 是历史例外，不要扩散）。
- 加载、空数据、错误、重试必须有明确状态；"不可用"和"空"是两件事（Docker 没装、Nginx 没站点、日志读不到都要给原因）。

---

## 8. 安全相关的 UI 约定

- 前端只传结构化标识（unit 名、容器名、路径、项目 id），绝不传命令字符串。
- 会修改服务端状态的操作必须有确认弹窗（停止/重启服务、删除容器/镜像、清理、停用站点、删除项目）。
- Nginx 保存后先 `nginx -t`，通过才 reload；失败要明确告知"未重载，站点继续使用旧配置"。
- 上传这类"可拖拽"的操作必须**同时有点击入口**，拖拽不能是唯一路径。
- 复制/粘贴一律走 `lib/clipboard.ts`（Rust 插件），禁止裸 `navigator.clipboard`。

---

## 9. 桌面级效果

"桌面右下角/屏幕级" = 真实 OS 窗口（屏幕坐标），不是页面内的 fixed/portal：

- 通知：`desktop_notification.rs`（固定窗口池 + 队列 + 堆叠），前端 `src/desktop-notification/`。
- 右键菜单：`desktop_menu.rs`，前端 `src/desktop-menu/`。
- 两者通过 `window.__BLS_VIEW__` 分发，且**不跑** `initTheme()`（避免污染主窗口主题）。

---

## 10. 测试与验证

```bash
pnpm build     # tsc + vite
pnpm test      # vitest（happy-dom）
```

- 视图测试放被测目录下 `test/`；渲染类测试顶部 `import "@/i18n"`。
- 受控 input 用 native setter；ConfirmDialog 查 `document.body`；shell/TextPreview 不得导入 CodeMirror 符号。
- 改样式后至少目视检查亮/暗两套主题与最小窗口尺寸（980×620）。
