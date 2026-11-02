/**
 * 数据库工作区的顶部标签条。
 *
 * 这是工作项的**常驻**切换入口（右侧只放检查器 / DDL，不维护第二份停靠列表）：
 * - 单击切换；中键关闭；双击预览标签 → 固定为常驻；
 * - 拖动排序（只影响本连接，跨连接各自一条标签条）；
 * - 右键：关闭 / 关闭其他 / 关闭右侧 / 固定 / 复制名称；
 * - 预览标签用斜体标题表示"会被下一次单击替换"，有草稿时自动升级（见 store）。
 * - 标签多到需要横向滚动时，右侧的「已打开的标签」浮窗（OpenTabsMenu）
 *   提供一次看全 + 搜索，两层数据同源，不额外维护列表状态。
 *
 * 关闭动作一律**回调给 DatabaseView**：它才知道运行中的查询、待提交修改与
 * 未提交事务该怎么收尾。这里不直接调 `close()`，否则会绕过风险确认。
 */
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Columns3,
  Database as DatabaseIcon,
  Loader2,
  Pin,
  PinOff,
  SquareTerminal,
  Table2,
  X,
} from "@/components/icons";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import {
  orderedItems,
  useDatabaseWorkspaceStore,
  type WorkItem,
} from "@/stores/database-workspace-store";

import { OpenTabsMenu } from "./OpenTabsMenu";

const KIND_ICON = {
  table: Table2,
  structure: Columns3,
  query: SquareTerminal,
  objects: DatabaseIcon,
} as const;

function ItemBadges({ item }: { item: WorkItem }) {
  const { t } = useTranslation();
  if (item.running) {
    return (
      <Loader2
        size={11}
        className="shrink-0 animate-spin text-accent"
        aria-label={t("执行中")}
      />
    );
  }
  return (
    <>
      {item.pendingCount > 0 && (
        <span
          className="shrink-0 rounded-[4px] bg-warning/20 px-1 text-[10px] leading-4 text-warning"
          title={t("待提交修改 {{count}} 项", { count: item.pendingCount })}
        >
          {item.pendingCount}
        </span>
      )}
      {item.dirty && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
          title={t("有未保存的修改")}
        />
      )}
    </>
  );
}

export function DatabaseTabBar({
  profileId,
  connectionName,
  onRequestClose,
  onRequestCloseOthers,
  onRequestCloseRight,
  onNewQuery,
}: {
  profileId: string;
  connectionName: string;
  onRequestClose: (item: WorkItem) => void;
  onRequestCloseOthers: (item: WorkItem) => void;
  onRequestCloseRight: (item: WorkItem) => void;
  onNewQuery: () => void;
}) {
  const { t } = useTranslation();
  const allItems = useDatabaseWorkspaceStore((state) => state.items);
  const activeId = useDatabaseWorkspaceStore((state) => state.activeId);
  const setActive = useDatabaseWorkspaceStore((state) => state.setActive);
  const togglePin = useDatabaseWorkspaceStore((state) => state.togglePin);
  const promote = useDatabaseWorkspaceStore((state) => state.promote);
  const reorder = useDatabaseWorkspaceStore((state) => state.reorder);
  const menu = useContextMenu();

  const items = useMemo(
    () => orderedItems(allItems.filter((item) => item.profileId === profileId)),
    [allItems, profileId],
  );
  // activeId 是全局的：切到另一个连接时它可能指向别处的工作项。
  const effectiveActiveId = items.some((item) => item.id === activeId)
    ? activeId
    : (items[items.length - 1]?.id ?? null);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const dragRef = useRef<string | null>(null);

  const buildMenu = (item: WorkItem) => [
    {
      id: "close",
      label: t("关闭"),
      hint: "Ctrl+W",
      onSelect: () => onRequestClose(item),
    },
    {
      id: "close-others",
      label: t("关闭其他"),
      onSelect: () => onRequestCloseOthers(item),
    },
    {
      id: "close-right",
      label: t("关闭右侧"),
      onSelect: () => onRequestCloseRight(item),
    },
    { id: "sep-1", separator: true },
    {
      id: "pin",
      label: item.pinned ? t("取消固定") : t("固定到最左"),
      hint: item.pinned ? undefined : t("固定项不参与预览替换"),
      icon: item.pinned ? PinOff : Pin,
      onSelect: () => togglePin(item.id),
    },
    {
      id: "copy",
      label: t("复制名称"),
      disabled: item.kind === "query",
      onSelect: () => void copyText(item.objectName),
    },
  ];

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-divider/70 bg-shell/40">
      <div
        role="tablist"
        aria-label={t("工作区标签")}
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden"
      >
        {items.map((item) => {
          const active = item.id === effectiveActiveId;
          const Icon = KIND_ICON[item.kind];
          const isDropTarget = dropTargetId === item.id && draggingId !== item.id;
          return (
            <div
              key={item.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={`${connectionName} › ${item.database ?? "—"} › ${item.objectName}`}
              draggable
              onDragStart={(event) => {
                dragRef.current = item.id;
                setDraggingId(item.id);
                event.dataTransfer.effectAllowed = "move";
                // Firefox 需要写一次数据才会真正开始拖动。
                event.dataTransfer.setData("text/plain", item.id);
              }}
              onDragEnd={() => {
                dragRef.current = null;
                setDraggingId(null);
                setDropTargetId(null);
              }}
              onDragOver={(event) => {
                if (!dragRef.current || dragRef.current === item.id) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropTargetId(item.id);
              }}
              onDragLeave={() => {
                setDropTargetId((current) => (current === item.id ? null : current));
              }}
              onDrop={(event) => {
                event.preventDefault();
                const draggedId = dragRef.current;
                setDropTargetId(null);
                setDraggingId(null);
                dragRef.current = null;
                if (draggedId && draggedId !== item.id) reorder(draggedId, item.id);
              }}
              onClick={() => setActive(item.id)}
              onDoubleClick={() => {
                // 预览 → 常驻：双击是"我要留着它"。
                if (item.preview) promote(item.id);
              }}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  onRequestClose(item);
                }
              }}
              onContextMenu={menu.onContextMenu(() => buildMenu(item))}
              className={cn(
                "group relative flex max-w-[220px] min-w-[112px] shrink-0 cursor-default items-center gap-1.5 border-r border-divider/60 px-2.5 text-12 outline-none transition-colors",
                active
                  ? "bg-tab-active text-fg shadow-[var(--tab-active-shadow)]"
                  : "text-fg-muted hover:bg-tab-hover hover:text-fg",
                isDropTarget && "before:absolute before:inset-y-1 before:left-0 before:w-[2px] before:rounded-full before:bg-accent",
                draggingId === item.id && "opacity-50",
              )}
            >
              <Icon
                size={13}
                strokeWidth={1.75}
                className={cn("shrink-0", active ? "text-accent" : "text-fg-subtle")}
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  // 预览标签斜体：一眼能看出它会被下一次单击替换。
                  item.preview && "italic",
                )}
              >
                {item.title}
              </span>
              {item.pinned && <Pin size={10} className="shrink-0 text-fg-subtle" />}
              <ItemBadges item={item} />
              <button
                type="button"
                aria-label={t("关闭标签")}
                className={cn(
                  "ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] text-fg-subtle transition-colors hover:bg-surface-active hover:text-fg",
                  active ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  onRequestClose(item);
                }}
              >
                <X size={11} strokeWidth={2} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex shrink-0 items-center gap-1 px-1.5">
        {/* 标签多到要横向滚动时，用它一次看全：搜索 + 键盘选择，底部保留新建查询。 */}
        <OpenTabsMenu profileId={profileId} onNewQuery={onNewQuery} />
      </div>

      <ContextMenu {...menu.props} />
    </div>
  );
}
