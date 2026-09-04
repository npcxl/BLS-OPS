import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();

  return (
    <ServerListTree
      title={t("Server list")}
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
