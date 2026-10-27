import { useWorkbenchStore } from "@/stores/workbench-store";
import { WorkbenchPane } from "./WorkbenchPane";
import { ConnectionProgressBar } from "./ConnectionProgressBar";

/**
 * Workspace — the primary work area (spec §10).
 *
 * 内容区是一张白色卡片，浮在灰色的应用底色（bg-app）上：只与外层在
 * **上、左**两个方向留出灰色底（左上圆角），**右、下直接贴到窗口边缘**，
 * 不加边框线条 —— "外层是背景、内层是白纸"。
 */
export function Workspace() {
  const rootPane = useWorkbenchStore((s) => s.rootPane);
  return (
    <main className="relative m-2 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[12px] bg-surface-1">
      {/* 连接光条只覆盖右侧内容区顶部（`main` 是 relative，光条 absolute 定位）。 */}
      <ConnectionProgressBar />
      <div className="flex min-h-0 flex-1">
        <WorkbenchPane pane={rootPane} />
      </div>
    </main>
  );
}
