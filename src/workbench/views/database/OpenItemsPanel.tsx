/**
 * 右侧"已打开"工作项列表 —— 中央唯一的切换入口。
 *
 * 每项显示：类型图标、可重命名标题、所属库/连接、选中态，以及
 * 固定 / 待修改 / 运行中 / 未保存 / 事务未提交等标记。
 * 右键菜单提供关闭、关闭其他、复制名称、定位资产树、固定。
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Columns3,
  Copy,
  Database as DatabaseIcon,
  FileCode2,
  Loader2,
  PanelRightClose,
  Pin,
  PinOff,
  Search,
  Split,
  SquareMinus,
  Table2,
  X,
} from "@/components/icons";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { IconButton } from "@/components/ui/mac-button";

import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { useDatabaseStore } from "@/stores/database-store";
import { useDatabaseWorkbenchStore } from "@/stores/database-workbench-store";
import {
  orderedItems,
  useDatabaseWorkspaceStore,
  type WorkItem,
} from "@/stores/database-workspace-store";

/** 列表内 ↑↓ 移动焦点：按 DOM 顺序走，跨连接分组也是连续的。 */
function moveItemFocus(current: HTMLElement, delta: number) {
  const list = current.closest<HTMLElement>("[data-item-list]");
  if (!list) return;
  const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-item-row]"));
  const index = rows.indexOf(current);
  if (index < 0) return;
  rows[Math.max(0, Math.min(rows.length - 1, index + delta))]?.focus();
}

/** 执行失败 / 结果未知的行内标记：不展开结果也能看出哪个工作项出过问题。 */
function RunStateBadge({ itemId }: { itemId: string }) {
  const { t } = useTranslation();
  const state = useDatabaseWorkbenchStore((s) => s.tabs[itemId]?.runState);
  if (state !== "failed" && state !== "outcome_unknown") return null;
  return (
    <span
      className="shrink-0 rounded bg-danger/20 px-1 text-[9px] leading-4 text-danger"
      title={
        state === "outcome_unknown" ? t("结果未知，请勿自动重试") : t("执行失败")
      }
    >
      !
    </span>
  );
}

export function OpenItemsPanel({
  onRequestClose,
  onRequestCloseOthers,
  onRequestCloseRight,
}: {
  onRequestClose: (item: WorkItem) => void;
  onRequestCloseOthers: (item: WorkItem) => void;
  onRequestCloseRight: (item: WorkItem) => void;
}) {
  const { t } = useTranslation();
  const items = useDatabaseWorkspaceStore((state) => state.items);
  const activeId = useDatabaseWorkspaceStore((state) => state.activeId);
  const setActive = useDatabaseWorkspaceStore((state) => state.setActive);
  const togglePin = useDatabaseWorkspaceStore((state) => state.togglePin);
  const rename = useDatabaseWorkspaceStore((state) => state.rename);
  const setRightCollapsed = useDatabaseWorkspaceStore((state) => state.setRightCollapsed);
  const transactions = useDatabaseStore((state) => state.sessions);

  const [search, setSearch] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const menu = useContextMenu();
  /**
   * 右键打开菜单的那一行。菜单开着期间它一直保持选中底色（否则只剩下
   * hover 的一闪，看不出菜单到底作用在哪一项）；菜单关了再复原。
   * 这里只影响高亮，**不**切换中央工作项 —— 右键不该顺手打开东西。
   */
  const [contextId, setContextId] = useState<string | null>(null);

  useEffect(() => {
    if (!menu.props.open) setContextId(null);
  }, [menu.props.open]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return orderedItems(items).filter((item) => {
      if (!needle) return true;
      return (
        item.title.toLowerCase().includes(needle) ||
        item.objectName.toLowerCase().includes(needle) ||
        (item.database ?? "").toLowerCase().includes(needle) ||
        item.connectionName.toLowerCase().includes(needle)
      );
    });
  }, [items, search]);

  const groups = useMemo(() => {
    const map = new Map<string, WorkItem[]>();
    for (const item of visible) {
      const list = map.get(item.connectionName) ?? [];
      list.push(item);
      map.set(item.connectionName, list);
    }
    return [...map.entries()];
  }, [visible]);

  const beginRename = (item: WorkItem) => {
    setRenamingId(item.id);
    setDraftTitle(item.title);
  };

  const commitRename = () => {
    if (renamingId) rename(renamingId, draftTitle);
    setRenamingId(null);
  };

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-line bg-surface-1">
      <div className="page-panel-header">
        <span className="min-w-0 flex-1 truncate text-12 font-medium text-fg-muted">
          {t("已打开")}
          <span className="ml-1 text-fg-subtle">{items.length}</span>
        </span>
        <button
          type="button"
          aria-label={t("收起已打开列表")}
          className="flex h-6 w-6 items-center justify-center rounded text-fg-subtle hover:bg-surface-hover hover:text-fg"
          onClick={() => setRightCollapsed(true)}
        >
          <PanelRightClose size={15} />
        </button>
      </div>

      <div className="shrink-0 px-2 py-1.5">
        <Input
          size="xs"
          leading={<Search size={11} />}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("搜索表 / 查询 / 连接…")}
          aria-label={t("搜索表 / 查询 / 连接…")}
        />
      </div>

      <div
        role="listbox"
        aria-label={t("已打开")}
        data-item-list
        className="min-h-0 flex-1 overflow-y-auto px-1 pb-2"
      >
        {visible.length === 0 && (
          <EmptyState
            className="min-h-20 py-4"
            title={items.length === 0 ? t("还没有打开的工作项") : t("没有匹配的工作项")}
            description={items.length === 0 ? t("双击左侧表，或新建查询。") : undefined}
            action={
              items.length > 0 ? (
                <button
                  type="button"
                  className="text-11 text-fg-subtle hover:text-accent"
                  onClick={() => setSearch("")}
                >
                  {t("Clear search")}
                </button>
              ) : undefined
            }
          />
        )}
        {groups.map(([connectionName, groupItems]) => (
          <div key={connectionName} className="mb-1">
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-fg-subtle">
              {connectionName}
            </div>
            {groupItems.map((item) => {
              const active = item.id === activeId;
              // 右键目标与当前工作项共用同一套选中底色，但互不改变对方。
              const selected = active || item.id === contextId;
              const transaction = transactions[item.profileId]?.transaction;
              const inTransaction =
                transaction === "in_transaction" ||
                transaction === "in_transaction_read_only";
              // 行提示用原生 title：100 个工作项时不必为每行挂一个 Tooltip
              // 实例（每个都要 hooks + 事件监听），渲染成本差一个量级。
              const rowTitle = `${t("连接")}：${item.connectionName}${
                item.kind !== "objects" && item.database
                  ? ` · ${t("数据库")}：${item.database}`
                  : ""
              } · ${item.title}`;
              return (
                  <div
                    key={item.id}
                    data-item-row
                    role="option"
                    aria-selected={active}
                    tabIndex={0}
                    title={rowTitle}
                    className={cn(
                      // 行间留 2px：选中底色不会和上下相邻行的 hover 底色粘成一块。
                      "group my-0.5 flex cursor-default items-center gap-1 rounded-[6px] py-[5px] pl-2 pr-1 outline-none",
                      selected
                        ? "bg-accent/10 text-fg"
                        : "text-fg-muted hover:bg-surface-hover",
                      "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/40",
                    )}
                    // 右键按下就标成菜单目标：contextmenu 在 pointerdown 之后才来，
                    // 等菜单弹出时底色已经就位，不会先闪一下 hover 的灰。
                    onPointerDown={(event) => {
                      if (event.button === 2) setContextId(item.id);
                    }}
                    onClick={() => setActive(item.id)}
                    // 只有键盘（Tab）聚焦才切走当前工作项。鼠标按下同样会给
                    // 这一行焦点，而右键只想弹菜单，不该顺手把工作项打开。
                    onFocus={(event) => {
                      if (event.currentTarget.matches(":focus-visible")) {
                        setActive(item.id);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                        event.preventDefault();
                        moveItemFocus(
                          event.currentTarget,
                          event.key === "ArrowDown" ? 1 : -1,
                        );
                        return;
                      }
                      if (event.key === "F2") {
                        event.preventDefault();
                        beginRename(item);
                        return;
                      }
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setActive(item.id);
                      }
                    }}
                    onDoubleClick={() => beginRename(item)}
                    onContextMenu={menu.onContextMenu(() => [
                      {
                        id: "close",
                        label: t("关闭"),
                        icon: X,
                        danger: true,
                        onSelect: () => onRequestClose(item),
                      },
                      {
                        id: "close-others",
                        label: t("关闭其他"),
                        icon: SquareMinus,
                        onSelect: () => onRequestCloseOthers(item),
                      },
                      {
                        id: "close-right",
                        label: t("关闭右侧"),
                        icon: PanelRightClose,
                        disabled: item.id === visible[visible.length - 1]?.id,
                        onSelect: () => onRequestCloseRight(item),
                      },
                      { separator: true },
                      {
                        id: "copy",
                        label: t("复制名称"),
                        icon: Copy,
                        onSelect: () => void copyText(item.title),
                      },
                      {
                        id: "pin",
                        label: item.pinned ? t("取消固定") : t("固定"),
                        icon: item.pinned ? PinOff : Pin,
                        onSelect: () => togglePin(item.id),
                      },
                      { separator: true },
                      {
                        id: "split",
                        label: t("分屏打开"),
                        icon: Split,
                        disabled: true,
                        hint: t("即将支持"),
                      },
                    ])}
                  >
                  {item.kind === "table" ? (
                    <Table2 size={12} className="shrink-0 text-fg-subtle" />
                  ) : item.kind === "structure" ? (
                    <Columns3 size={12} className="shrink-0 text-fg-subtle" />
                  ) : item.kind === "objects" ? (
                    <DatabaseIcon size={12} className="shrink-0 text-fg-subtle" />
                  ) : (
                    <FileCode2 size={12} className="shrink-0 text-fg-subtle" />
                  )}
                  {renamingId === item.id ? (
                    <input
                      autoFocus
                      value={draftTitle}
                      onChange={(event) => setDraftTitle(event.target.value)}
                      onClick={(event) => event.stopPropagation()}
                      onBlur={commitRename}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") commitRename();
                        if (event.key === "Escape") setRenamingId(null);
                        event.stopPropagation();
                      }}
                      className="h-[20px] min-w-0 flex-1 rounded border border-accent bg-surface-1 px-1 text-11 text-fg outline-none"
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-11">{item.title}</span>
                  )}

                  {item.pinned && <Pin size={9} className="shrink-0 text-accent" />}
                  {item.running && (
                    <Loader2 size={10} className="shrink-0 animate-spin text-accent" />
                  )}
                  <RunStateBadge itemId={item.id} />
                  {item.pendingCount > 0 && (
                    <span
                      className="shrink-0 rounded bg-warning/20 px-1 text-[9px] text-warning"
                      title={t("待提交修改 {{count}} 项", { count: item.pendingCount })}
                    >
                      {item.pendingCount}
                    </span>
                  )}
                  {item.dirty && (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                      title={t("SQL 未保存")}
                    />
                  )}
                  {inTransaction && (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                      title={t("事务未提交")}
                    />
                  )}

                  <IconButton
                    icon={item.pinned ? PinOff : Pin}
                    size="xs"
                    aria-label={item.pinned ? t("取消固定") : t("固定")}
                    // 用原生 title：tip 会为每个按钮挂一个 Tooltip 实例，
                    // 100 个工作项就是 200 个，渲染成本比提示本身值钱。
                    title={item.pinned ? t("取消固定") : t("固定")}
                    className={cn(
                      "hidden h-4 w-4 px-0 text-fg-subtle hover:text-fg group-hover:flex",
                      item.pinned && "flex text-accent",
                    )}
                    onClick={(event) => {
                      event.stopPropagation();
                      togglePin(item.id);
                    }}
                  />
                  <IconButton
                    icon={X}
                    size="xs"
                    aria-label={t("关闭")}
                    title={t("关闭")}
                    className="hidden h-4 w-4 px-0 text-fg-subtle hover:bg-surface-hover hover:text-danger group-hover:flex"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRequestClose(item);
                    }}
                  />
                  </div>
              );
            })}
          </div>
        ))}
      </div>

      <ContextMenu {...menu.props} />
    </aside>
  );
}
