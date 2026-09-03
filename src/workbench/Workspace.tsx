import { useWorkbenchStore } from "@/stores/workbench-store";
import { WorkbenchPane } from "./WorkbenchPane";

/**
 * Workspace — the primary work area (spec §10).
 *
 * 内容区是一张**白色圆角卡片**，浮在灰色的应用底色（bg-app）上；头部、
 * 导航栏、侧边栏、状态栏组成的外层 chrome 共享同一份底色，形成
 * "外层是背景、内层是白纸"的层次（macOS 系统设置风格）。
 */
export function Workspace() {
  const rootPane = useWorkbenchStore((s) => s.rootPane);
  return (
    <main className="relative m-2 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[12px] border border-line bg-surface-1 shadow-[0_1px_2px_rgb(15_23_42/0.05)]">
      <div className="flex min-h-0 flex-1">
        <WorkbenchPane pane={rootPane} />
      </div>
    </main>
  );
}
