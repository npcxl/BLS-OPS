import { useWorkbenchStore } from "@/stores/workbench-store";
import { WorkbenchPane } from "./WorkbenchPane";
import { ConnectionProgressBar } from "./ConnectionProgressBar";

/**
 * Workspace — the primary work area (spec §10).
 *
 * 内容区是一张实色卡片，浮在参与磨砂的外壳上：只与外层在
 * **上、左**两个方向留出玻璃，（左上圆角），**右、下直接贴到窗口边缘**。
 *
 * 为什么内容区必须实色：数据表格、SQL 编辑器、单元格编辑都要求稳定的
 * 背景与足够的文字对比度。磨砂只属于外壳（标题栏 / 模块栏 / 资产侧栏），
 * 不要往下扩散 —— 也不要用 `opacity` 做层次，那会让文字一起变淡。
 */
export function Workspace() {
  const rootPane = useWorkbenchStore((s) => s.rootPane);
  return (
    <main className="relative m-2 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[12px] bg-content">
      {/* 连接光条只覆盖右侧内容区顶部（`main` 是 relative，光条 absolute 定位）。 */}
      <ConnectionProgressBar />
      <div className="flex min-h-0 flex-1">
        <WorkbenchPane pane={rootPane} />
      </div>
    </main>
  );
}
