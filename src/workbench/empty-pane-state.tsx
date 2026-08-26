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
        <p className="text-13 text-fg-muted">No open editors</p>
      </div>
      <div className="flex items-center gap-1.5">
        <Button variant="secondary" size="sm" onClick={() => openTab({ id: crypto.randomUUID(), type: "terminal", title: "New Terminal" }, { paneId })}>
          <SquareTerminal size={14} />
          New Terminal
        </Button>
        <Button variant="ghost" size="sm" onClick={() => openTab({ id: crypto.randomUUID(), type: "home", title: "Home" }, { paneId })}>
          <House size={14} />
          Open Home
        </Button>
      </div>
    </div>
  );
}
