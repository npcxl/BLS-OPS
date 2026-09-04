import { useWorkbenchStore } from "@/stores/workbench-store";
import { ServerListTree } from "./server-list";

/**
 * Terminal rail.
 *
 * Everything about the list itself — favorites, groups, moving, renaming,
 * creating, deleting — lives in `ServerListTree`. This file only decides the
 * title and that clicking a server opens (or focuses) a terminal tab.
 */
export function SshContextSidebar() {
  const openOrFocusServerTab = useWorkbenchStore((s) => s.openOrFocusServerTab);

  return (
    <ServerListTree
      title="服务器列表"
      onOpenServer={(server) =>
        openOrFocusServerTab({
          id: crypto.randomUUID(),
          type: "terminal",
          title: server.name,
          subtitle: `${server.host}:${server.port}`,
          serverId: server.id,
          sessionId: crypto.randomUUID(),
        })
      }
    />
  );
}
