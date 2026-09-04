import { memo } from "react";
import {
  Activity,
  FolderInput,
  Pencil,
  Plug,
  ScrollText,
  SquareCheckBig,
  Star,
  Trash2,
} from "lucide-react";
import type { ServerGroupRecord, ServerRecord } from "@/api/types/servers";
import { ContextMenu, useContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import { cn } from "@/lib/cn";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { UNGROUPED_LABEL } from "./sections";
import type { ManageKind } from "./use-server-list";

export interface ServerRowProps {
  server: ServerRecord;
  /** All groups, so the context menu can offer "移动到分组". */
  groups: ServerGroupRecord[];
  /** Primary action: row click. Meaning depends on the sidebar's module. */
  onOpen: (server: ServerRecord) => void;
  onEdit: (server: ServerRecord) => void;
  onDelete: (server: ServerRecord) => void;
  onToggleFavorite: (server: ServerRecord) => void;
  onMoveToGroup: (server: ServerRecord, groupId: string | null) => void;
}

/**
 * One server line: name, target, favorite star and the shared context menu.
 *
 * The star is a *sibling* of the open button and stops propagation, so
 * starring a server never also opens a session on it — the two used to share a
 * hit area, which made the favorite toggle unusable.
 */
export const ServerRow = memo(function ServerRow({
  server,
  groups,
  onOpen,
  onEdit,
  onDelete,
  onToggleFavorite,
  onMoveToGroup,
}: ServerRowProps) {
  const menu = useContextMenu();
  const openTab = useWorkbenchStore((s) => s.openTab);
  const openOrFocusServerTab = useWorkbenchStore((s) => s.openOrFocusServerTab);

  const openTerminal = () =>
    openOrFocusServerTab({
      id: crypto.randomUUID(),
      type: "terminal",
      title: server.name,
      subtitle: `${server.host}:${server.port}`,
      serverId: server.id,
      sessionId: crypto.randomUUID(),
    });

  // Monitoring and the P3 modules each get their own tab and session: they run
  // read-only exec channels and must not disturb an open shell.
  const openMonitor = () =>
    openTab({
      id: crypto.randomUUID(),
      type: "monitor",
      title: server.name,
      subtitle: `${server.host}:${server.port}`,
      serverId: server.id,
      sessionId: crypto.randomUUID(),
    });

  const openManage = (kind: ManageKind) =>
    openTab({
      id: crypto.randomUUID(),
      type: kind,
      title: server.name,
      subtitle: `${server.host}:${server.port}`,
      serverId: server.id,
      sessionId: crypto.randomUUID(),
    });

  const items: ContextMenuItem[] = [
    { id: "connect", label: "打开终端", icon: Plug, onSelect: openTerminal },
    { id: "monitor", label: "打开监控", icon: Activity, onSelect: openMonitor },
    { id: "sep-manage", separator: true },
    {
      id: "services",
      label: "服务管家",
      icon: SquareCheckBig,
      onSelect: () => openManage("service"),
    },
    { id: "logs", label: "日志中心", icon: ScrollText, onSelect: () => openManage("logs") },
    { id: "sep-fav", separator: true },
    {
      id: "favorite",
      label: server.favorite ? "取消收藏" : "收藏",
      icon: Star,
      onSelect: () => onToggleFavorite(server),
    },
    {
      id: "move",
      label: "移动到分组",
      icon: FolderInput,
      // A dedicated command instead of the full edit dialog: moving is the
      // common case and should not require a form round-trip.
      children: [
        {
          id: "move-ungrouped",
          label: UNGROUPED_LABEL,
          hint: server.group_id ? undefined : "当前",
          onSelect: () => onMoveToGroup(server, null),
        },
        ...groups.map((group) => ({
          id: `move-${group.id}`,
          label: group.name,
          hint: server.group_id === group.id ? "当前" : undefined,
          onSelect: () => onMoveToGroup(server, group.id),
        })),
      ],
    },
    { id: "edit", label: "编辑服务器", icon: Pencil, onSelect: () => onEdit(server) },
    { id: "sep-delete", separator: true },
    { id: "delete", label: "删除服务器", icon: Trash2, danger: true, onSelect: () => onDelete(server) },
  ];

  const favoriteLabel = server.favorite ? "取消收藏" : "收藏";

  return (
    <div
      data-testid={`server-row-${server.id}`}
      className="group/row flex w-full items-center rounded-[6px] px-2.5 py-1.5 hover:bg-surface-hover"
      onContextMenu={menu.onContextMenu(() => items)}
    >
      <button
        type="button"
        data-testid={`server-open-${server.id}`}
        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
        onClick={() => onOpen(server)}
      >
        <span className="flex items-center gap-1.5">
          <span className="truncate text-12 text-fg">{server.name}</span>
          {server.proxy_jump_id && (
            <span className="shrink-0 rounded-[4px] border border-line px-1 text-10 text-fg-subtle">
              跳板
            </span>
          )}
        </span>
        <span className="truncate text-11 text-fg-subtle">
          {server.username}@{server.host}:{server.port}
        </span>
      </button>

      <button
        type="button"
        data-testid={`server-favorite-${server.id}`}
        aria-label={`${favoriteLabel} ${server.name}`}
        aria-pressed={server.favorite}
        title={favoriteLabel}
        className={cn(
          "shrink-0 rounded p-1 transition-opacity duration-150",
          server.favorite
            ? "text-warning opacity-100"
            : "text-fg-subtle opacity-0 group-hover/row:opacity-100",
        )}
        onClick={(event) => {
          // Without this the click also bubbles into the row's own handlers.
          event.stopPropagation();
          onToggleFavorite(server);
        }}
      >
        <Star size={12} strokeWidth={1.75} fill={server.favorite ? "currentColor" : "none"} />
      </button>

      <ContextMenu {...menu.props} title={server.name} />
    </div>
  );
});
