import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { useWorkbenchStore } from "@/stores/workbench-store";

/** Shown when a monitor tab has no server attached yet. */
export function MonitorPicker({
  tabId,
  servers,
}: {
  tabId: string;
  servers: { id: string; name: string; username: string; host: string; port: number }[];
}) {
  const { t } = useTranslation();
  const updateTab = useWorkbenchStore((s) => s.updateTab);
  const closeTabById = useWorkbenchStore((s) => s.closeTabById);

  const attach = (server: { id: string; name: string; host: string; port: number }) =>
    updateTab(tabId, {
      title: server.name,
      subtitle: `${server.host}:${server.port}`,
      serverId: server.id,
      sessionId: crypto.randomUUID(),
    });

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-surface-1">
      <p className="text-13 text-fg-muted">{t("Pick a server to start monitoring")}</p>
      {servers.length === 0 ? (
        <p className="text-12 text-fg-subtle">
          {t("No servers yet — add one under Servers in the sidebar first.")}
        </p>
      ) : (
        <div className="flex max-h-[50vh] w-72 flex-col overflow-y-auto rounded-[8px] border border-line bg-surface-1">
          {servers.map((server) => (
            <button
              key={server.id}
              type="button"
              className="flex flex-col items-start gap-0.5 border-b border-line px-3 py-2 text-left last:border-b-0 hover:bg-surface-hover"
              onClick={() => attach(server)}
            >
              <span className="text-12 text-fg">{server.name}</span>
              <span className="text-11 text-fg-subtle">
                {server.username}@{server.host}:{server.port}
              </span>
            </button>
          ))}
        </div>
      )}
      <Button variant="ghost" size="sm" onClick={() => closeTabById(tabId)}>
        {t("Close this tab")}
      </Button>
    </div>
  );
}
