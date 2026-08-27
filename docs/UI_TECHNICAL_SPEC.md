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

## 交互原则

- 所有用户可见文案使用中文。
- 加载、空数据、错误和重试必须有明确状态。
- 删除操作必须有确认，连接失败必须可重试。
- 服务器保存成功后刷新列表，并在应用重启后从 SQLite 恢复。
