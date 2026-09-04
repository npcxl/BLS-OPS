import { House, SquareTerminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useWorkbenchStore } from "@/stores/workbench-store";

/** Shown when a leaf pane has no open tabs. */
export function EmptyPaneState({ paneId }: { paneId: string }) {
  const { t } = useTranslation();
  const openTab = useWorkbenchStore((s) => s.openTab);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-surface-1">
      <div className="flex flex-col items-center gap-1.5">
        <div className="flex h-10 w-10 items-center justify-center rounded-control border border-line bg-surface-1 text-fg-subtle">
          <SquareTerminal size={18} strokeWidth={1.75} />
        </div>
        <p className="text-13 text-fg-muted">{t("No open editors")}</p>
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            openTab({ id: crypto.randomUUID(), type: "terminal", title: t("New Terminal") }, { paneId })
          }
        >
          <SquareTerminal size={14} />
          {t("New Terminal")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => openTab({ id: crypto.randomUUID(), type: "home", title: t("Home") }, { paneId })}
        >
          <House size={14} />
          {t("Open home")}
        </Button>
      </div>
    </div>
  );
}
