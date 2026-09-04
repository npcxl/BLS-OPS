import { useCallback, useEffect, useState } from "react";
import { ChevronRight, ChevronsLeft, FolderPlus, Plus, RefreshCw, Star } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { IconButton } from "@/components/ui/mac-button";
import { ErrorText } from "@/components/ui/modal";
import { ContextMenu, useContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import { cn } from "@/lib/cn";
import { emptyServer, useDomainStore } from "@/stores/domain-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import type { ServerGroupRecord, ServerRecord } from "@/api/types/servers";
import { NewGroupInput } from "./NewGroupInput";
import { SectionTitle } from "./SectionTitle";
import { ServerForm } from "./ServerForm";
import { ServerGroupSectionView } from "./ServerGroupSection";
import { ServerRow } from "./ServerRow";
import { serverSectionsInOrder } from "./sections";
import { useServerListActions, useServerSections } from "./use-server-list";

/**
 * The whole server list — favorites, groups, 未分组, plus the group CRUD and
 * the context-menu actions. Every sidebar renders this.
 *
 * A sidebar is responsible for exactly two things: the title, and what happens
 * when a server is clicked (see `onOpenServer`). Everything else — ordering,
 * favorites, groups, moving, renaming, deleting — lives here once, so the
 * terminal rail and the 项目 / 服务 / 日志 rails cannot drift apart again.
 */
export function ServerListTree({
  title,
  onOpenServer,
}: {
  title: string;
  /** Primary row action. The sidebar decides which module it targets. */
  onOpenServer: (server: ServerRecord) => void;
}) {
  const servers = useDomainStore((s) => s.servers);
  const groups = useDomainStore((s) => s.groups);
  const removeServer = useDomainStore((s) => s.deleteServer);
  const setSidebarCollapsed = useWorkbenchStore((s) => s.setSidebarCollapsed);

  const sections = useServerSections();
  const { error, setError, clearError, refresh, toggleFavorite, moveToGroup, createGroup, renameGroup, deleteGroup } =
    useServerListActions();

  const [loading, setLoading] = useState(true);
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [favoritesFolded, setFavoritesFolded] = useState(false);
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [editing, setEditing] = useState<ServerRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ServerRecord | null>(null);
  const [groupDeleteTarget, setGroupDeleteTarget] = useState<ServerGroupRecord | null>(null);
  /** Right-click on blank list area — mirrors the header icon row. */
  const backgroundMenu = useContextMenu();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Servers and groups together: the sections are built from both, so
      // refreshing only one leaves stale buckets on screen.
      await refresh();
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  useEffect(() => {
    void load();
  }, [load]);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    try {
      await removeServer(target.id);
      setDeleteTarget(null);
      clearError();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const sectionsInOrder = serverSectionsInOrder(sections);

  /**
   * The header actions, defined once. They are rendered twice — as the icon
   * row and as the background context menu — so the two can never disagree,
   * and the menu stays reachable once the list is long enough that the header
   * has scrolled out of view.
   */
  const headerActions: ContextMenuItem[] = [
    { id: "refresh", label: "刷新服务器", icon: RefreshCw, onSelect: () => void load() },
    {
      id: "add-server",
      label: "新增服务器",
      icon: Plus,
      onSelect: () => setEditing(emptyServer()),
    },
    { id: "add-group", label: "新增分组", icon: FolderPlus, onSelect: () => setCreatingGroup(true) },
    {
      id: "collapse",
      label: "收起侧边栏",
      icon: ChevronsLeft,
      onSelect: () => setSidebarCollapsed(true),
    },
  ];

  return (
    <div className="flex flex-col gap-1 pb-3">
      <div
        className="mt-1"
        // Rows stop propagation on their own right-click, so this only fires on
        // the blank areas: headers, group titles and empty space.
        onContextMenu={backgroundMenu.onContextMenu(() => headerActions)}
      >
        <SectionTitle
          actions={
            <div className="flex items-center gap-0.5">
              <IconButton
                icon={RefreshCw}
                size="xs"
                className="h-5 w-5 px-0"
                aria-label="刷新服务器"
                tip="刷新服务器"
                onClick={() => void load()}
              />
              <IconButton
                icon={ChevronsLeft}
                size="xs"
                className="h-5 w-5 px-0"
                aria-label="收起侧边栏"
                tip="收起侧边栏"
                onClick={() => setSidebarCollapsed(true)}
              />
              <IconButton
                icon={Plus}
                size="xs"
                className="h-5 px-1"
                aria-label="新增服务器"
                tip="新增服务器"
                onClick={() => setEditing(emptyServer())}
              />
              <IconButton
                icon={FolderPlus}
                size="xs"
                className="h-5 px-1"
                aria-label="新增分组"
                tip="新增分组"
                onClick={() => setCreatingGroup(true)}
              />
            </div>
          }
        >
          {title}
        </SectionTitle>

        {loading ? (
          <p className="px-2.5 py-2 text-11 text-fg-subtle">正在加载…</p>
        ) : (
          <>
            {servers.length === 0 && groups.length === 0 && (
              <p className="px-2.5 py-2 text-11 text-fg-subtle">暂无服务器，点击 + 新增</p>
            )}

            {/* Shortcut area only: these servers stay in their own group below. */}
            {sections.favorites.length > 0 && (
              <div data-testid="favorites-section">
                <button
                  type="button"
                  data-testid="favorites-toggle"
                  className="flex w-full items-center gap-1 px-2.5 py-1 text-11 font-medium text-fg-subtle hover:text-fg"
                  onClick={() => setFavoritesFolded((current) => !current)}
                >
                  <ChevronRight
                    size={11}
                    aria-hidden="true"
                    className={cn("shrink-0 transition-transform", !favoritesFolded && "rotate-90")}
                  />
                  <Star size={11} className="shrink-0 text-warning" fill="currentColor" />
                  <span className="min-w-0 flex-1 truncate text-left">收藏</span>
                  <span className="shrink-0">{sections.favorites.length}</span>
                </button>
                {!favoritesFolded &&
                  sections.favorites.map((server) => (
                    <ServerRow
                      key={server.id}
                      server={server}
                      groups={groups}
                      onOpen={onOpenServer}
                      onEdit={setEditing}
                      onDelete={setDeleteTarget}
                      onToggleFavorite={(item) => void toggleFavorite(item)}
                      onMoveToGroup={(item, groupId) => void moveToGroup(item, groupId)}
                    />
                  ))}
              </div>
            )}

            {sectionsInOrder.map((section) => (
              <ServerGroupSectionView
                key={section.id}
                section={section}
                folded={Boolean(folded[section.id])}
                renaming={renamingGroupId === section.id}
                onToggleFold={() =>
                  setFolded((current) => ({ ...current, [section.id]: !current[section.id] }))
                }
                onStartRename={() => setRenamingGroupId(section.id)}
                onRename={(name) => {
                  setRenamingGroupId(null);
                  // The 未分组 bucket is synthetic — there is nothing to rename.
                  if (section.group) void renameGroup(section.group, name);
                }}
                onCancelRename={() => setRenamingGroupId(null)}
                onDelete={() => {
                  if (section.group) setGroupDeleteTarget(section.group);
                }}
                renderRow={(server) => (
                  <ServerRow
                    server={server}
                    groups={groups}
                    onOpen={onOpenServer}
                    onEdit={setEditing}
                    onDelete={setDeleteTarget}
                    onToggleFavorite={(item) => void toggleFavorite(item)}
                    onMoveToGroup={(item, groupId) => void moveToGroup(item, groupId)}
                  />
                )}
              />
            ))}
          </>
        )}
      </div>

      {creatingGroup && (
        <NewGroupInput
          pending={false}
          onSave={async (name) => {
            const saved = await createGroup(name);
            if (saved) {
              setCreatingGroup(false);
              return true;
            }
            // Keep the editor open so the typed name and the error stay visible.
            return false;
          }}
          onCancel={() => setCreatingGroup(false)}
        />
      )}

      {error && (
        <p role="alert" data-testid="server-list-error" className="px-2.5 py-1 text-11 text-danger">
          {error}
        </p>
      )}

      {sections.warnings.map((warning) => (
        <ErrorText key={warning}>{warning}</ErrorText>
      ))}

      <ContextMenu {...backgroundMenu.props} title={title} />

      {editing && <ServerForm server={editing} onClose={() => setEditing(null)} />}

      {deleteTarget && (
        <ConfirmDialog
          open
          title="删除服务器"
          description={`删除“${deleteTarget.name}”会同时删除它的会话与命令历史。此操作不可撤销。`}
          confirmLabel="确认删除"
          danger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}

      {groupDeleteTarget && (
        <ConfirmDialog
          open
          title="删除分组"
          description={
            servers.filter((server) => server.group_id === groupDeleteTarget.id).length > 0
              ? `分组“${groupDeleteTarget.name}”中有 ${
                  servers.filter((server) => server.group_id === groupDeleteTarget.id).length
                } 台服务器。\n删除分组后这些服务器会变为“未分组”，服务器本身不会被删除。\n\n确定删除分组吗？`
              : `确定删除分组“${groupDeleteTarget.name}”吗？`
          }
          confirmLabel="确认删除"
          danger
          onCancel={() => setGroupDeleteTarget(null)}
          onConfirm={() => {
            const target = groupDeleteTarget;
            setGroupDeleteTarget(null);
            void deleteGroup(target);
          }}
        />
      )}
    </div>
  );
}
