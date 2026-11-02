/**
 * 标签条右侧的「已打开的标签」浮窗。
 *
 * 标签条在标签变多后只能横向滚动，找一张表要来回拖；这个浮窗把当前连接的
 * 所有工作项收进一张可搜索的列表：
 * - 输入即过滤（标题 / 表名 / 库名）；
 * - ↑↓ 选择、Enter 打开、Esc 关闭；
 * - 单击任意一行直接切到那个标签，浮窗自动收起；
 * - 底部保留「新建查询」，所以标签条右侧换成这个入口后并没有丢掉新建动作。
 *
 * 为什么是 portal + fixed：标签条外层有 `overflow-x-auto`，绝对定位会被裁掉；
 * 浮层同时登记到 OverlayManager，Esc 只关最上面这一层（弹窗里的标签条也一样）。
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
  Check,
  Columns3,
  Database as DatabaseIcon,
  FileCode2,
  FilePlus2,
  History,
  Loader2,
  Pin,
  Search,
  Table2,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { isTopOverlayLayer, OVERLAY_Z, useOverlayLayer } from "@/components/ui/overlay";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import {
  orderedItems,
  useDatabaseWorkspaceStore,
  type WorkItem,
} from "@/stores/database-workspace-store";

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

function KindIcon({ item, active }: { item: WorkItem; active: boolean }) {
  const className = cn("shrink-0", active ? "text-accent" : "text-fg-subtle");
  if (item.kind === "table") return <Table2 size={12} className={className} />;
  if (item.kind === "structure") return <Columns3 size={12} className={className} />;
  if (item.kind === "objects") return <DatabaseIcon size={12} className={className} />;
  return <FileCode2 size={12} className={className} />;
}

/** 与标签条上保持同一套标记：固定 / 执行中 / 待提交 / 未保存。 */
function RowBadges({ item }: { item: WorkItem }) {
  return (
    <>
      {item.pinned && <Pin size={9} className="shrink-0 text-accent" />}
      {item.running && <Loader2 size={10} className="shrink-0 animate-spin text-accent" />}
      {item.pendingCount > 0 && (
        <span className="shrink-0 rounded-[4px] bg-warning/20 px-1 text-[9px] leading-4 text-warning">
          {item.pendingCount}
        </span>
      )}
      {item.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
    </>
  );
}

export function OpenTabsMenu({
  profileId,
  onNewQuery,
}: {
  profileId: string;
  onNewQuery: () => void;
}) {
  const { t } = useTranslation();
  const listId = `open-tabs-${useId()}`;
  const allItems = useDatabaseWorkspaceStore((state) => state.items);
  const activeId = useDatabaseWorkspaceStore((state) => state.activeId);
  const setActive = useDatabaseWorkspaceStore((state) => state.setActive);

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

  const openMenu = () => {
    setSearch("");
    const index = items.findIndex((item) => item.id === activeId);
    setCursor(index >= 0 ? index : 0);
    setOpen(true);
  };

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

  return (
    <>
      <Tooltip side="bottom" label={t("已打开的标签")}>
        <button
          ref={buttonRef}
          type="button"
          aria-label={t("已打开的标签")}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => (open ? close(false) : openMenu())}
          className="flex h-6 w-6 items-center justify-center rounded-[6px] text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg aria-expanded:bg-surface-active aria-expanded:text-fg"
        >
          <History size={13} strokeWidth={1.75} />
        </button>
      </Tooltip>

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
              {filtered.map((item, index) => {
                const active = item.id === activeId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-index={index}
                    onClick={() => choose(item)}
                    onMouseEnter={() => setCursor(index)}
                    title={`${item.database ?? "—"} › ${item.objectName}`}
                    className={cn(
                      "page-tree-row w-full text-left text-12",
                      active ? "text-fg" : "text-fg-muted",
                      // 当前标签已经有 accent 底色，别再被"键盘光标"的灰色盖掉。
                      index === cursor && !active && "bg-surface-hover",
                    )}
                  >
                    <KindIcon item={item} active={active} />
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    {item.database && (
                      <span className="max-w-[88px] shrink-0 truncate text-10 text-fg-subtle">
                        {item.database}
                      </span>
                    )}
                    <RowBadges item={item} />
                    {active && <Check size={11} className="shrink-0 text-accent" />}
                  </button>
                );
              })}
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
