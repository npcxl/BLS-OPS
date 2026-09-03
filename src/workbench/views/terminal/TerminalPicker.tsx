import { Button } from "@/components/ui/button";
import type { ServerRecord } from "@/api/ops-api";
import { useWorkbenchStore } from "@/stores/workbench-store";

/** Shown when a terminal tab has no connection target yet. */
export function TerminalPicker({ tabId, servers }: { tabId: string; servers: ServerRecord[] }) {
  const updateTab = useWorkbenchStore((s) => s.updateTab);
  const closeTabById = useWorkbenchStore((s) => s.closeTabById);

  const attach = (server: ServerRecord) =>
    updateTab(tabId, {
      title: server.name,
      subtitle: `${server.host}:${server.port}`,
      serverId: server.id,
      sessionId: crypto.randomUUID(),
    });

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-surface-1">
      <p className="text-13 text-fg-muted">选择一个服务器以开始 SSH 会话</p>
      {servers.length === 0 ? (
        <p className="text-12 text-fg-subtle">左侧“服务器”中还没有任何条目，请先新增服务器。</p>
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
        关闭此标签
      </Button>
    </div>
  );
}
