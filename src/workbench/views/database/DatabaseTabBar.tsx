/**
 * 数据库工作区的顶部标签条。
 *
 * 外观与交互**复用 `PaneTabBar`**（高度、圆角、选中态、横向溢出、滚轮与
 * 键盘导航都只有一份实现）；这里只负责把工作项映射成标签，并接上数据库
 * 自己的业务动作：关闭 / 关闭其他 / 关闭右侧 / 固定 / 中键关闭 / 拖拽排序。
 *
 * 关闭动作一律**回调给 DatabaseView**：它才知道运行中的查询、待提交修改与
 * 未提交事务该怎么收尾。这里不直接调 `close()`，否则会绕过风险确认。
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Columns3,
  Database as DatabaseIcon,
  Loader2,
  SquareTerminal,
  Table2,
} from "@/components/icons";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { PaneTabBar, type PaneTab } from "@/components/ui/pane-tab-bar";
import { cn } from "@/lib/cn";
import {
  orderedItems,
  useDatabaseWorkspaceStore,
  type WorkItem,
} from "@/stores/database-workspace-store";

import { OpenTabsMenu } from "./OpenTabsMenu";
import { workItemMenuItems } from "./work-item-row";

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
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title={t("有未保存的修改")} />
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

  const tabs: PaneTab[] = items.map((item) => ({
    id: item.id,
    label: item.title,
    icon: KIND_ICON[item.kind],
    title: `${connectionName} › ${item.database ?? "—"} › ${item.objectName}${
      item.preview ? ` · ${t("预览标签，双击保留")}` : ""
    }`,
    preview: item.preview,
    pinned: item.pinned,
    badge: <ItemBadges item={item} />,
    onClose: () => onRequestClose(item),
    onDoubleClick: () => {
      // 预览 → 常驻：双击是"我要留着它"。
      if (item.preview) promote(item.id);
    },
    onAuxClick: () => onRequestClose(item),
    onContextMenu: menu.onContextMenu(() =>
      workItemMenuItems(item, {
        close: onRequestClose,
        closeOthers: onRequestCloseOthers,
        closeRight: onRequestCloseRight,
        togglePin,
      }),
    ),
  }));

  return (
    <div
      className={cn(
        "flex h-[var(--page-toolbar-height)] w-full min-w-0 max-w-full shrink-0 items-center gap-1 overflow-hidden border-b border-divider/70 bg-transparent px-[var(--page-inline)]",
      )}
    >
      <PaneTabBar
        tabs={tabs}
        value={effectiveActiveId ?? ""}
        onChange={setActive}
        ariaLabel={t("工作区标签")}
        onReorder={(fromId, toId) => reorder(fromId, toId)}
        // 外框已经有分隔线，标签条自己不要再画一条。
        className="border-b-0"
        trailing={<OpenTabsMenu profileId={profileId} onNewQuery={onNewQuery} />}
      />
      <ContextMenu {...menu.props} />
    </div>
  );
}
