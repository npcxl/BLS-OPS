/**
 * 右栏的**唯一一套**布局约束。
 *
 * `preferred` 是用户首选宽度（持久化）；`available` 是扣除左侧任务列表后
 * 聊天 + 右栏真正能用的宽度。窗口缩小只压缩 `actual`，不覆盖 preferred，
 * 窗口再放大时自动恢复。
 */
export const PANE_MIN = 300;
/** 紧凑布局下聊天区的最小可用宽度。 */
export const CHAT_MIN = 320;
/** 浮层至少还给聊天留这么宽。 */
const OVERLAY_CHAT_MIN = 80;

export interface PaneLayout {
  /** 当前是否应改成浮层。 */
  overlay: boolean;
  /** 分栏时右栏可用上限。 */
  room: number;
  /** 当前实际显示宽度（临时压缩后的结果）。 */
  actual: number;
}

export function paneLayout(preferred: number, available: number): PaneLayout {
  const width = Math.max(PANE_MIN, Math.round(preferred));
  if (available <= 0) {
    return { overlay: false, room: width, actual: width };
  }
  const overlay = available < PANE_MIN + CHAT_MIN;
  const room = Math.max(PANE_MIN, available - CHAT_MIN);
  const actual = overlay
    ? Math.min(width, Math.max(PANE_MIN, available - OVERLAY_CHAT_MIN))
    : Math.min(width, room);
  return { overlay, room, actual };
}
