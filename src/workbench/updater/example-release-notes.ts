/** Placeholder copy only. Never used as updater metadata or a download source. */
export function exampleReleaseNotes(language: string): string {
  return language.startsWith("zh") ? `## 更顺手的工作台
- 将常用功能集中在一个工作区，减少来回切换。
- 保留已打开的标签，方便继续上一次的工作。
- 让连接状态与操作反馈更容易辨认。

## 服务器与终端
- 整理服务器分组，让资产列表更清晰。
- 优化常用操作的入口与提示。
- 保留终端独立的等宽字体与阅读习惯。

## 数据库工作区
- 连接、对象浏览和 SQL 工作项集中管理。
- 明确区分连接状态、执行结果和错误提示。
- 数据内容继续使用适合阅读的等宽排版。

## 界面与交互
- 调整浅色与深色主题下的内容层次。
- 改善浮层、空状态和操作提示的表达。
- 在设置中直接查看最新更新日志。

## 应用更新
- 在设置中查看最新版本的更新说明。
- 检查到新版本后，可以下载并安装更新。
- 更新时展示进度，并保留现有工作的确认提醒。

这些内容仅用于预览更新日志的排版，正式发布后将显示该版本的真实说明。`
    : `## A more comfortable workspace
- Keep common tools together and reduce switching.
- Continue work in the tabs you already opened.
- Make connection states and feedback easier to read.

## Servers and terminals
- Keep server groups organized.
- Make common actions easier to find.
- Preserve the terminal's dedicated monospace font.

## Database workspace
- Keep connections, objects and SQL work in one place.
- Distinguish connection states, results and errors.
- Preserve monospace formatting for data and queries.

## Interface and interaction
- Refine surfaces in light and dark themes.
- Improve overlays and empty states.
- Read the latest release notes directly in Settings.

## Application updates
- View the latest release notes in Settings.
- Download and install an update after checking availability.
- Follow download progress and existing work confirmations.

This is sample layout content. Published releases will show their actual notes.`;
}
