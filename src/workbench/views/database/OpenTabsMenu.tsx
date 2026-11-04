/**
 * 标签条右侧的「更多」（⋯）入口。
 *
 * 菜单只有两项，都是**标签列表本身**的事：
 * - 已打开的标签：可搜索的浮窗（标签多到横向滚动时一次看全）；
 * - 标签向右打开 / 标签回到顶部：工作项在顶部标签条与右侧列表之间切换。
 *
 * 新建连接在左侧资产树标题栏的 `+`，新建查询在 SQL 页工具栏 —— 菜单里不重复
 * 摆一份"新建"，否则同一个动作有了第二个入口。
 *
 * 右侧列表模式下顶部标签条是隐藏的，列表已经摊开，所以那里的入口直接就是
 * 「回到顶部」，不再多一层菜单。
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  FilePlus2,
  ListTodo,
  MoreHorizontal,
  PanelRight,
  PanelTop,
  Search,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { isTopOverlayLayer, OVERLAY_Z, useOverlayLayer } from "@/components/ui/overlay";
import { Tooltip } from "@/components/ui/tooltip";
import {
  orderedItems,
  useDatabaseWorkspaceStore,
  type WorkItem,
} from "@/stores/database-workspace-store";
import { WorkItemRow } from "./work-item-row";

const PANEL_WIDTH = 316;
const PANEL_MAX_HEIGHT = 380;
/** 低于这个高度就不值得向下展开，改为贴着按钮向上长。 */
const MIN_SPACE_BELOW = 240;

interface PanelPosition {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

export function OpenTabsMenu({
  profileId,
  onNewQuery,
  variant = "tabs",
}: {
  profileId: string;
  onNewQuery: () => void;
  /** `rail` = 右侧列表的标题栏：列表已经摊开，只留"回到顶部"。 */
  variant?: "tabs" | "rail";
}) {
  const { t } = useTranslation();
  const listId = `open-tabs-${useId()}`;
  const allItems = useDatabaseWorkspaceStore((state) => state.items);
  const activeId = useDatabaseWorkspaceStore((state) => state.activeId);
  const setActive = useDatabaseWorkspaceStore((state) => state.setActive);
  const layout = useDatabaseWorkspaceStore((state) => state.layout);
  const setLayout = useDatabaseWorkspaceStore((state) => state.setLayout);

  const items = useMemo(
    () => orderedItems(allItems.filter((item) => item.profileId === profileId)),
    [allItems, profileId],
  );

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState(0);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const layer = useOverlayLayer(open, "open-tabs");
  const menu = useContextMenu();

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (item) =>
        item.title.toLowerCase().includes(needle) ||
        item.objectName.toLowerCase().includes(needle) ||
        (item.database ?? "").toLowerCase().includes(needle),
    );
  }, [items, search]);

  const close = (returnFocus = true) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  };

  const openPanel = () => {
    setSearch("");
    const index = items.findIndex((item) => item.id === activeId);
    setCursor(index >= 0 ? index : 0);
    setOpen(true);
  };

  const openMenu = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    // 右对齐到按钮、贴着按钮下沿展开：菜单往右下方长，不遮住标签本身。
    const x = rect ? rect.right - 200 : 0;
    const y = rect ? rect.bottom + 6 : 0;
    menu.openAt(x, y, menuItems());
  };

  const menuItems = () => [
    {
      id: "tabs",
      label: t("已打开的标签"),
      icon: ListTodo,
      onSelect: openPanel,
    },
    { separator: true as const },
    ...(layout === "top"
      ? [
          {
            id: "layout-right",
            label: t("标签向右打开"),
            icon: PanelRight,
            onSelect: () => setLayout("right"),
          },
        ]
      : [
          {
            id: "layout-top",
            label: t("标签回到顶部"),
            icon: PanelTop,
            onSelect: () => setLayout("top"),
          },
        ]),
  ];

  const choose = (item: WorkItem) => {
    setActive(item.id);
    close();
  };

  // 按钮在标签条最右侧：右对齐展开，空间不够就向上；外部滚动时跟随，
  // 不用关闭（标签条自己会横向滚，关掉反而更烦）。
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(PANEL_WIDTH, window.innerWidth - 16);
      const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
      const spaceBelow = window.innerHeight - rect.bottom - 8;
      const spaceAbove = rect.top - 8;
      const dropUp = spaceBelow < MIN_SPACE_BELOW && spaceAbove > spaceBelow;
      setPosition({
        left,
        width,
        maxHeight: Math.max(180, Math.min(PANEL_MAX_HEIGHT, dropUp ? spaceAbove : spaceBelow)),
        ...(dropUp
          ? { bottom: window.innerHeight - rect.top + 6 }
          : { top: rect.bottom + 6 }),
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // 焦点可能落在行按钮甚至面板外（点完列表后），Esc 不能只靠面板内的 onKeyDown。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !isTopOverlayLayer(layer.id)) return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, layer.id]);

  useEffect(() => {
    if (open && position) inputRef.current?.focus();
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    panelRef.current
      ?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [cursor, open]);

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (filtered.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setCursor((current) => (current + delta + filtered.length) % filtered.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = filtered[cursor];
      if (item) choose(item);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  // 右侧列表模式：列表就摊在旁边，一个「回到顶部」按钮比只含一项的菜单直接。
  if (variant === "rail") {
    return (
      <Tooltip side="bottom" label={t("标签回到顶部")}>
        <button
          type="button"
          aria-label={t("标签回到顶部")}
          onClick={() => setLayout("top")}
          className="flex h-6 w-6 items-center justify-center rounded-[6px] text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg"
        >
          <PanelTop size={13} strokeWidth={1.75} />
        </button>
      </Tooltip>
    );
  }

  return (
    <>
      <Tooltip side="bottom" label={t("标签列表")}>
        <button
          ref={buttonRef}
          type="button"
          aria-label={t("标签列表")}
          aria-haspopup="menu"
          aria-expanded={menu.props.open}
          onClick={() => {
            if (open) close(false);
            openMenu();
          }}
          className="flex h-6 w-6 items-center justify-center rounded-[6px] text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg aria-expanded:bg-surface-active aria-expanded:text-fg"
        >
          <MoreHorizontal size={14} strokeWidth={1.75} />
        </button>
      </Tooltip>

      <ContextMenu {...menu.props} />

      {open &&
        position &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={t("已打开的标签")}
            className="page-overlay-surface overlay-enter fixed outline-none"
            style={{
              left: position.left,
              width: position.width,
              maxHeight: position.maxHeight,
              top: position.top,
              bottom: position.bottom,
              // 高于所在弹窗（含嵌套），低于右键菜单与 tooltip。
              zIndex: OVERLAY_Z.popover + Math.min(layer.depth, 8) * 2,
            }}
          >
            <div className="page-overlay-header page-overlay-header--compact">
              <Input
                ref={inputRef}
                size="xs"
                leading={<Search size={11} />}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setCursor(0);
                }}
                onKeyDown={onSearchKeyDown}
                aria-label={t("搜索已打开的标签…")}
                aria-controls={listId}
                placeholder={t("搜索已打开的标签…")}
                className="border-0 bg-transparent shadow-none focus:ring-0"
              />
            </div>

            <div
              id={listId}
              role="listbox"
              aria-label={t("已打开的标签")}
              className="min-h-0 flex-1 overflow-y-auto p-1"
            >
              {filtered.length === 0 && (
                <EmptyState
                  className="min-h-20 py-4"
                  title={items.length === 0 ? t("还没有打开的工作项") : t("没有匹配的标签")}
                  description={items.length === 0 ? undefined : t("Try a shorter search.")}
                />
              )}
              {filtered.map((item, index) => (
                <div key={item.id} data-index={index} onMouseEnter={() => setCursor(index)}>
                  <WorkItemRow
                    item={item}
                    active={item.id === activeId}
                    highlighted={index === cursor}
                    onSelect={() => choose(item)}
                  />
                </div>
              ))}
            </div>

            <div className="page-overlay-footer page-overlay-footer--compact justify-between">
              <span className="text-10 text-fg-subtle">
                {/* 跟随过滤结果：搜到 2 个时还说 6 个，会让人以为列表没筛。 */}
                {t("共 {{count}} 个标签", { count: filtered.length })}
              </span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  close(false);
                  onNewQuery();
                }}
              >
                <FilePlus2 size={11} />
                {t("新建查询")}
              </Button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
