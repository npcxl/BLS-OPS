import { House, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWorkbenchStore } from "@/stores/workbench-store";

/** Shown when a leaf pane has no open tabs. */
export function EmptyPaneState({ paneId }: { paneId: string }) {
  const openTab = useWorkbenchStore((s) => s.openTab);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-app">
      <div className="flex flex-col items-center gap-1.5">
        <div className="flex h-10 w-10 items-center justify-center rounded-control border border-line bg-surface-1 text-fg-subtle">
          <SquareTerminal size={18} strokeWidth={1.75} />
        </div>
        <p className="text-13 text-fg-muted">暂无打开的编辑器</p>
      </div>
      <div className="flex items-center gap-1.5">
        <Button variant="secondary" size="sm" onClick={() => openTab({ id: crypto.randomUUID(), type: "terminal", title: "新建终端" }, { paneId })}>
          <SquareTerminal size={14} />
          新建终端
        </Button>
        <Button variant="ghost" size="sm" onClick={() => openTab({ id: crypto.randomUUID(), type: "home", title: "首页" }, { paneId })}>
          <House size={14} />
          打开首页
        </Button>
      </div>
    </div>
  );
}
