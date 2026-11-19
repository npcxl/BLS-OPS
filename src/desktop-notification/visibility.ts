/**
 * 主窗口是否处于「用户看不到」的状态。
 *
 * 两个来源要合起来看：
 * - 原生侧 `app:collapsed`：点 X 隐藏到托盘、最小化（`approval.ts` 负责转成
 *   `setCollapsed`）；
 * - WebView 的 `document.hidden`：部分平台最小化只改页面可见性。
 *
 * 只有这个值为真时才允许发桌面通知。任务状态、历史恢复、切换对话都只改
 * 应用内状态，不读这里。
 */
import { getCurrentWindow } from "@tauri-apps/api/window";

let collapsed = false;

export function setCollapsed(value: boolean): void {
  collapsed = value;
}

export function isWindowHidden(): boolean {
  return collapsed || document.hidden;
}

/**
 * 再问一次原生窗口：最小化 / 不可见都算收起。
 *
 * 页面可见性在个别平台的最小化路径上不会翻，所以推送前补一次窗口状态；
 * 浏览器预览或测试没有窗口 API 时按“可见”处理，宁可不弹也不误弹。
 */
export async function isMainWindowHidden(): Promise<boolean> {
  if (isWindowHidden()) return true;
  try {
    const window = getCurrentWindow();
    const [minimized, visible] = await Promise.all([
      window.isMinimized(),
      window.isVisible(),
    ]);
    return minimized || !visible;
  } catch {
    return false;
  }
}
