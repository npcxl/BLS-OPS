/**
 * 数据库模块内的快捷键收口。
 *
 * 背景：工作项是**常驻隐藏**的（切走不卸载，为的是保住滚动位置和待提交修改），
 * 所以任何挂在 `window` 上的快捷键都会被 100 个隐藏工作项同时收到。
 * 典型事故：在表 A 里按 Ctrl+S，隐藏着的表 B 也响应，把它的暂存修改提交了。
 *
 * 这里只做三件事，不引入插件式注册表：
 * 1. `enabled` 闸门 —— 只有当前活动工作项才装监听；
 * 2. 修饰键与按键精确匹配（不再用 `event.key === "s"` 这种模糊判断）；
 * 3. 输入框守卫 —— 默认在输入框里不触发，保存类显式打开。
 *
 * 全局快捷键（Ctrl+K / Ctrl+W 等）仍在 `useGlobalShortcuts`，两者职责不重叠：
 * 全局的管壳（标签/面板），这里的管当前工作项的数据操作。
 */
import { useEffect, useRef } from "react";
import { hasOpenOverlay } from "@/components/ui/overlay";

export interface ScopedShortcut {
  /** 与 `KeyboardEvent.key` 对应，大小写不敏感（"s" / "Escape" / "Enter"）。 */
  key: string;
  /** true = 必须按 Ctrl（macOS 上 Cmd 也算）。 */
  ctrl?: boolean;
  /** true = 必须按 Shift。 */
  shift?: boolean;
  /** 只有当前工作项处于活动状态时才响应。 */
  enabled: boolean;
  /** 焦点在 input/textarea/contenteditable 里时是否仍然触发。 */
  allowInInput?: boolean;
  run: (event: KeyboardEvent) => void;
}

/** 事件目标是否落在可输入元素上。 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function useScopedShortcut({
  key,
  ctrl = false,
  shift = false,
  enabled,
  allowInInput = false,
  run,
}: ScopedShortcut) {
  // 回调放 ref：调用方不必为了稳定的 handler 写 useCallback，也不会因此重装监听。
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // 弹窗 / 右键菜单打开时，键属于浮层：在「编辑行」弹窗里按 Ctrl+S
      // 不该把背后工作项的待提交修改写进数据库。
      if (hasOpenOverlay()) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod !== ctrl) return;
      if (event.shiftKey !== shift) return;
      if (event.key.toLowerCase() !== key.toLowerCase()) return;
      if (!allowInInput && isTypingTarget(event.target)) return;
      event.preventDefault();
      runRef.current(event);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [allowInInput, ctrl, enabled, key, shift]);
}
