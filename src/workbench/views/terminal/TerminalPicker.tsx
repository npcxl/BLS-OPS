import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ServerRecord } from "@/api/ops-api";
import { emptyServer, useDomainStore } from "@/stores/domain-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { Input } from "@/components/ui/input";
import { PageScroll, PageSurface, PageToolbar, SegmentedControl } from "@/workbench/page-layout";
import { QuickConnectForm, type QuickConnectAuth, type QuickConnectTarget } from "../home/quick-connect";
import { ServerForm } from "@/workbench/server-list/ServerForm";

/** Shown when a terminal tab has no connection target yet. */
export function TerminalPicker({ tabId, servers, initialMode = "quick" }: { tabId: string; servers: ServerRecord[]; initialMode?: "quick" | "create" }) {
  const { t } = useTranslation();
  const updateTab = useWorkbenchStore((s) => s.updateTab);
  const closeTab = useWorkbenchStore(s => s.closeTabById);
  const [mode, setMode] = useState<"quick" | "saved" | "create">(initialMode);
  const [draftServer] = useState(emptyServer);
  const [filter, setFilter] = useState("");
  const visible = useMemo(() => servers.filter(server =>
    [server.name, server.host, server.username].join(" ").toLowerCase().includes(filter.trim().toLowerCase())), [servers, filter]);

  const attach = (server: ServerRecord) =>
    updateTab(tabId, {
      type: "terminal",
      title: server.name,
      subtitle: `${server.host}:${server.port}`,
      serverId: server.id,
      sessionId: crypto.randomUUID(),
      quickTarget: undefined, credentialId: undefined, oneTimePassword: undefined,
    });

  const connectQuick = async (target: QuickConnectTarget, auth: QuickConnectAuth, saveAsServer: boolean) => {
    const { username, host, port } = target;
    let saved: ServerRecord | undefined;
    if (saveAsServer) {
      try {
        saved = await useDomainStore.getState().saveServer({
          ...emptyServer(), name: host, host, port, username, credential_id: auth.credentialId ?? null,
        });
      } catch {
        // Preserve quick connect even when saving the server entry fails.
      }
    }
    updateTab(tabId, {
      type: "terminal",
      title: saved?.name ?? host, subtitle: `${host}:${port}`, serverId: saved?.id,
      quickTarget: saved ? undefined : `${username}@${host}:${port}`,
      credentialId: auth.credentialId, oneTimePassword: auth.password, sessionId: crypto.randomUUID(),
    });
  };

  return (
    <PageSurface>
      <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-2.5">
        <h1 className="text-13 font-medium text-fg">{t(initialMode === "create" ? "Add server" : "New Terminal")}</h1>
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-10 text-fg-subtle">SSH</span>
      </div>
      <PageToolbar><SegmentedControl value={mode} onChange={setMode} label={t("Connection method")}
        items={[{id:"quick",label:t("Quick connect")},{id:"saved",label:t("Saved servers")},{id:"create",label:t("Add server")}]} /></PageToolbar>
      <div className={mode === "quick" ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"}>
        <QuickConnectForm onClose={() => closeTab(tabId)} onConnect={connectQuick} />
      </div>
      <div className={mode === "create" ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"}>
        <ServerForm server={draftServer} onClose={() => closeTab(tabId)} variant="inline" />
      </div>
      <div className={mode === "saved" ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"}>
        <PageScroll width="reading">
          <div className="flex flex-col gap-4 py-2">
            <div className="page-form-heading">{t("Select a server to start an SSH session")}</div>
            <Input value={filter} onChange={event => setFilter(event.target.value)}
              placeholder={t("Search servers…")} aria-label={t("Search servers…")} />
        <div className="page-form-list divide-y divide-line/60">
          {visible.map((server) => (
            <button
              key={server.id}
              type="button"
              className="page-form-row w-full flex-col items-start text-left hover:bg-surface-hover"
              onClick={() => attach(server)}
            >
              <span className="text-12 text-fg">{server.name}</span>
              <span className="text-11 text-fg-subtle">
                {server.username}@{server.host}:{server.port}
              </span>
            </button>
          ))}
          {visible.length === 0 && <p className="px-4 py-8 text-center text-12 text-fg-subtle">
            {servers.length ? t("No matching servers") : t("No servers yet. Add one under \"Servers\" on the left first.")}
          </p>}
        </div>
          </div>
        </PageScroll>
      </div>
    </PageSurface>
  );
}
