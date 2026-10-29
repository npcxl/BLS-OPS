/**
 * 独立设置窗口的根组件（`index.html?view=settings`）。
 *
 * 只渲染设置内容：没有导航栏、没有工作区、不建立任何会话 —— 独立窗口不该
 * 顺手把主界面整套状态再拉一遍（那会多出一批"看不见的"标签页与会话）。
 */
import { SettingsContextSidebar } from "./settings-context-sidebar";

export function SettingsWindow() {
  return (
    <div className="h-full overflow-y-auto bg-surface-1 text-fg">
      <div className="mx-auto max-w-[760px] px-4 py-3">
        <SettingsContextSidebar />
      </div>
    </div>
  );
}
