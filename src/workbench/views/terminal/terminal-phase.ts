/**
 * 终端会话的生命周期状态。
 *
 * 单独成文件：工具栏 / 右键菜单 / 会话 hook 都要判定它，而它们不应该
 * 互相 import（`TerminalView` 只做组装）。
 */
export type Phase = "idle" | "connecting" | "connected" | "error" | "closed";
