/**
 * 右侧的「已打开的标签」列表 —— 顶部标签条的第二种展示。
 *
 * 标签一多，横向标签条只能靠滚动和搜索浮窗找；改成右侧竖排后每行都能露出
 * 完整标题和来源库，扫起来更像文件列表。两种展示共用 `items` 与同一份菜单，
 * 切换只改渲染位置，工作项状态（分页、草稿、待提交）不受影响。
 *
 * 关闭动作和标签条一样回调给 `DatabaseView`：事务与运行中查询要它来收尾。
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { PageInspector, PageInspectorHeader } from "@/workbench/page-layout";
import {
  orderedItems,
  useDatabaseWorkspaceStore,
  type WorkItem,
} from "@/stores/database-workspace-store";
import { OpenTabsMenu } from "./OpenTabsMenu";
import { WorkItemRow, workItemMenuItems } from "./work-item-row";

const RAIL_WIDTH = 232;

export function WorkItemRail({
  profileId,
  onNewQuery,
  onRequestClose,
  onRequestCloseOthers,
  onRequestCloseRight,
}: {
  profileId: string;
  onNewQuery: () => void;
  onRequestClose: (item: WorkItem) => void;
  onRequestCloseOthers: (item: WorkItem) => void;
  onRequestCloseRight: (item: WorkItem) => void;
}) {
  const { t } = useTranslation();
  const allItems = useDatabaseWorkspaceStore((state) => state.items);
  const activeId = useDatabaseWorkspaceStore((state) => state.activeId);
  const setActive = useDatabaseWorkspaceStore((state) => state.setActive);
  const togglePin = useDatabaseWorkspaceStore((state) => state.togglePin);
  const menu = useContextMenu();

  const items = useMemo(
    () => orderedItems(allItems.filter((item) => item.profileId === profileId)),
    [allItems, profileId],
  );
  // activeId 是全局的：切到另一个连接时它可能指向别处的工作项。
  const effectiveActiveId = items.some((item) => item.id === activeId)
    ? activeId
    : (items[items.length - 1]?.id ?? null);

  return (
    <PageInspector className="shrink-0" style={{ width: RAIL_WIDTH }}>
      <PageInspectorHeader
        actions={
          <OpenTabsMenu
            profileId={profileId}
            onNewQuery={onNewQuery}
            variant="rail"
          />
        }
      >
        <span className="text-12 font-semibold uppercase tracking-[0.08em] text-fg-subtle">
          {t("已打开的标签")}
        </span>
      </PageInspectorHeader>

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {items.length === 0 ? (
          <EmptyState
            className="px-2 py-6"
            title={t("还没有打开的工作项")}
            description={t("双击左侧表打开数据页，或新建查询。")}
          />
        ) : (
          items.map((item) => (
            <WorkItemRow
              key={item.id}
              item={item}
              active={item.id === effectiveActiveId}
              onSelect={() => setActive(item.id)}
              onClose={() => onRequestClose(item)}
              onContextMenu={menu.onContextMenu(() =>
                workItemMenuItems(item, {
                  close: onRequestClose,
                  closeOthers: onRequestCloseOthers,
                  closeRight: onRequestCloseRight,
                  togglePin,
                }),
              )}
            />
          ))
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-divider/70 px-[var(--page-inline)] py-1 text-10 text-fg-subtle">
        <span>{t("共 {{count}} 个标签", { count: items.length })}</span>
      </div>

      <ContextMenu {...menu.props} />
    </PageInspector>
  );
}
