/**
 * 独立快捷键窗口（`index.html?view=shortcuts`）。
 *
 * 边操作边查的组合最常用，所以做成独立窗口而不是设置里的一个区块：
 * 主窗口全屏操作时，这个窗口可以放在旁边一直开着。
 */
import { ShortcutSettingsGroup } from "./settings-shortcuts";

export function ShortcutsWindow() {
  return (
    <div className="h-full overflow-y-auto bg-surface-1 p-3 text-fg">
      <ShortcutSettingsGroup />
    </div>
  );
}
