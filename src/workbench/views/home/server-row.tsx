/**
 * 首页资产区里的服务器行：与服务器列表同一套右键菜单，
 * 悬浮只放"收藏 / 删除"两个高频动作。
 */
import { useTranslation } from "react-i18next";
import { Copy, Pencil, Plug, Server as ServerIcon, Star, Trash2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ContextMenu, useContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { copyText } from "@/lib/clipboard";
import type { ServerRecord } from "@/api/ops-api";
import { relativeTime, timestampTitle } from "./utils";

export function ServerHomeRow({
  server,
  onOpen,
  onToggleFavorite,
  onEdit,
  onDelete,
}: {
  server: ServerRecord;
  onOpen: () => void;
  onToggleFavorite: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const menu = useContextMenu();
  const items: ContextMenuItem[] = [
    { id: "open", label: t("Open terminal"), icon: Plug, onSelect: onOpen },
    {
      id: "favorite",
      label: server.favorite ? t("Unfavorite") : t("Favorite"),
      icon: Star,
      onSelect: onToggleFavorite,
    },
    { id: "sep-edit", separator: true },
    { id: "edit", label: t("Edit server"), icon: Pencil, onSelect: onEdit },
    {
      id: "copy-target",
      label: t("Copy connection address"),
      icon: Copy,
      onSelect: () => void copyText(`${server.username}@${server.host}:${server.port}`),
    },
    { id: "sep-delete", separator: true },
    { id: "delete", label: t("Delete server"), icon: Trash2, danger: true, onSelect: onDelete },
  ];

  return (
    <div
      data-testid={`home-server-row${server.id ? `-${server.id}` : ""}`}
      className="group flex h-11 w-full items-center gap-2.5 px-3 transition-colors hover:bg-surface-hover/60"
      onContextMenu={menu.onContextMenu(() => items)}
    >
      <ServerIcon size={14} className="shrink-0 text-fg-subtle" />
      <button type="button" className="min-w-0 flex-1 truncate text-left text-13 text-fg" onClick={onOpen}>
        {server.name}
        <span className="ml-2 text-11 text-fg-subtle">
          {server.username}@{server.host}:{server.port}
        </span>
      </button>
      <span className="shrink-0 text-11 text-fg-subtle" title={timestampTitle(server.last_connected_at)}>
        {relativeTime(server.last_connected_at, t)}
      </span>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <Tooltip label={server.favorite ? t("Unfavorite") : t("Favorite")} side="left">
          <Button
            variant="ghost"
            size="xs"
            className="h-6 w-6 px-0"
            aria-label={t("Favorite")}
            onClick={onToggleFavorite}
          >
            <Star size={13} className={server.favorite ? "fill-current text-accent" : ""} />
          </Button>
        </Tooltip>
        <Tooltip label={t("Delete")} side="left">
          <Button
            variant="ghost"
            size="xs"
            className="h-6 w-6 px-0 hover:text-danger"
            aria-label={t("Delete")}
            onClick={onDelete}
          >
            <Trash2 size={13} />
          </Button>
        </Tooltip>
      </div>

      <ContextMenu {...menu.props} title={server.name} />
    </div>
  );
}
