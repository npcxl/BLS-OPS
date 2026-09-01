# UI 技术规范

## 当前技术栈

- React 19 + TypeScript
- Tailwind CSS v4
- Zustand：仅保存工作台布局和轻量 UI 状态
- Tauri 2：原生能力和 IPC
- rusqlite + SQLite：本地持久化

## 组件边界

- `workbench/` 负责工作台外壳、导航、侧边栏、Tab 和分屏。
- 服务器数据通过统一 API Hook 获取，不在组件内散落 `invoke()`。
- 终端输出属于会话流，不进入 Zustand；接入 xterm.js 后由终端组件直接消费事件/Channel。
- `connected` 只能由真实 SSH 会话状态驱动，禁止使用静态假状态。
- 监控指标只来自 `monitor_snapshot`，禁止任何模拟值或随机数；读不到的值显示 `—`。
- 监控状态按 Tab id 存在 `monitor-store`：暂停、采集间隔、30 分钟趋势互不共享。
- 页面不可见（窗口隐藏或该 Tab 非活动页签）时停止轮询；SSH 断开后同样停止。

## 上下文菜单

统一使用 `components/ui/context-menu.tsx`，不要再手写浮动菜单：

```tsx
const menu = useContextMenu();
<div onContextMenu={menu.onContextMenu(() => [{ label: "删除", danger: true, onSelect }])} />
<ContextMenu {...menu.props} />
```

约定：

- 左键点击任意处、Escape、窗口失焦、窗口尺寸变化 → 立即关闭。
- **右键别处时菜单移动而不是关闭重开**（不闪烁）：关闭只发生在没有 handler 的区域。
- 键盘 ↑↓ / Home / End / Enter 可操作，自动跳过分隔符与禁用项。
- 菜单 `memo` 化：父组件（如长文件列表）重渲染不会带着菜单一起重渲染。
- 危险操作放菜单末尾并加 `danger`；有快捷键的动作在 `hint` 里标注。

## 交互原则

- 所有用户可见文案使用中文。
- 加载、空数据、错误和重试必须有明确状态。
- 删除操作必须走 `ConfirmDialog` 确认（不使用 `window.confirm`），连接失败必须可重试。
- 服务器保存成功后刷新列表，并在应用重启后从 SQLite 恢复。
- 列表类视图（文件列表等）的行必须 `memo` 化，且回调保持稳定引用，避免 hover/选中/右键时全量重渲染。
- 上传这类“可拖拽”的操作必须**同时提供点击入口**，拖拽不能是唯一路径。
- **管理类操作的安全边界**：前端只传结构化标识（单元名、容器名、路径、项目 id），绝不传命令字符串。新增任何管理动作都必须先在 `src-tauri/src/safe.rs` 的 `Capability` 枚举里加一个变体并写死命令模板；禁止在别处拼接命令。
- **会修改服务端状态的操作必须有确认弹窗**（停止/重启服务、删除容器/镜像、清理、停用站点、删除项目）。
- **先校验后生效**：Nginx 配置保存后必须先 `nginx -t`，通过才重载；校验失败要明确告知用户“未重载，站点继续使用旧配置”。
- “不可用”和“空”是两件事：Docker 没装、Nginx 没站点、journal 读不到，都要给出原因，不能显示一个看起来像“什么都没有”的空列表。
