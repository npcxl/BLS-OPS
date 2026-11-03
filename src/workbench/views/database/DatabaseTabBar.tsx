/**
 * 数据库工作区的顶部标签条。
 *
 * 这是工作项的**常驻**切换入口（右侧只放检查器 / DDL，不维护第二份停靠列表）：
 * - 单击切换；中键关闭；双击预览标签 → 固定为常驻；
 * - 拖动排序（只影响本连接，跨连接各自一条标签条）；
 * - 右键：关闭 / 关闭其他 / 关闭右侧 / 固定 / 复制名称；
 * - 预览标签用小标记表示"会被下一次单击替换"，有草稿时自动升级（见 store）。
 * - 标签多到需要横向滚动时，右侧的「已打开的标签」浮窗（OpenTabsMenu）
 *   提供一次看全 + 搜索，两层数据同源，不额外维护列表状态。
 *
 * 关闭动作一律**回调给 DatabaseView**：它才知道运行中的查询、待提交修改与
 * 未提交事务该怎么收尾。这里不直接调 `close()`，否则会绕过风险确认。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Columns3,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database as DatabaseIcon,
  Loader2,
  PanelRightClose,
  Pin,
  PinOff,
  SquareMinus,
  SquareTerminal,
  Table2,
  X,
} from "@/components/icons";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { copyTextWithFeedback as copyText } from "@/lib/clipboard-feedback";
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

/** 标签条两端的渐隐：只在那一侧确实被挡住时出现。 */
function tabStripMask(left: boolean, right: boolean): string | undefined {
  if (!left && !right) return undefined;
  const stops: string[] = [];
  stops.push(left ? "transparent 0px" : "#000 0px");
  if (left) stops.push("#000 20px");
  if (right) stops.push("#000 calc(100% - 20px)");
  stops.push(right ? "transparent 100%" : "#000 100%");
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

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
  const stripRef = useRef<HTMLDivElement>(null);
  /** 左右是否还有被挡住的标签：用来给两端加渐隐提示。 */
  const [edges, setEdges] = useState({ left: false, right: false });
  const hasOverflow = edges.left || edges.right;

  // 标签条是横向的，鼠标滚轮默认只给纵向（这里被隐藏了）—— 不转发的话
  // 用户会觉得"标签太多滚不动"。React 的 onWheel 是 passive 的，
  // preventDefault 不生效，所以必须用原生监听。
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      if (strip.scrollWidth <= strip.clientWidth) return;
      // 触控板的横向手势（deltaX）优先，普通滚轮用 deltaY。
      const unit = event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? strip.clientWidth : 1;
      const delta = (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * unit;
      if (delta === 0) return;
      event.preventDefault();
      event.stopPropagation();
      strip.scrollLeft += delta;
    };
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, []);

  // 两端渐隐 + 切标签时把它滚进可见区。
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const sync = () => {
      const max = strip.scrollWidth - strip.clientWidth;
      setEdges({ left: strip.scrollLeft > 1, right: max > 1 && strip.scrollLeft < max - 1 });
    };
    sync();
    strip.addEventListener("scroll", sync, { passive: true });
    // 测试环境（happy-dom）没有 ResizeObserver：没有它只是少了窗口缩放时的
    // 渐隐刷新，不影响滚动本身。
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(strip);
    return () => {
      strip.removeEventListener("scroll", sync);
      observer?.disconnect();
    };
  }, [items.length]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || !effectiveActiveId) return;
    const tab = strip.querySelector<HTMLElement>("[data-tab-active='true']");
    // 只滚标签条，不要连带滚动页面。
    if (!tab) return;
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < strip.scrollLeft) strip.scrollLeft = left;
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth;
  }, [effectiveActiveId, items.length, hasOverflow]);

  const buildMenu = (item: WorkItem) => [
    {
      id: "close",
      label: t("关闭"),
      icon: X,
      hint: "Ctrl+W",
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
      icon: Copy,
      disabled: item.kind === "query",
      onSelect: () => void copyText(item.objectName),
    },
  ];

  return (
    <div className="flex h-[var(--page-toolbar-height)] w-full min-w-0 max-w-full shrink-0 items-center gap-1 overflow-hidden border-b border-divider/70 bg-transparent px-[var(--page-inline)]">
      {(edges.left || edges.right) && <button type="button" aria-label={t("向左滚动标签")}
        title={t("向左滚动标签")} disabled={!edges.left}
        className="grid size-6 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-tab-hover disabled:opacity-30"
        onClick={() => { const strip = stripRef.current; if (strip) strip.scrollLeft -= Math.max(160, strip.clientWidth * .7); }}><ChevronLeft size={13} /></button>}
      <div className="relative flex min-w-0 flex-1 basis-0 items-center overflow-hidden">
      <div
        ref={stripRef}
        role="tablist"
        aria-label={t("工作区标签")}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        // 滚轮可滚动 + 两端渐隐：标签条不显示滚动条，用户需要知道"还有更多"。
        style={{
          maskImage: tabStripMask(edges.left, edges.right),
          WebkitMaskImage: tabStripMask(edges.left, edges.right),
        }}
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
              data-tab-active={active ? "true" : undefined}
              tabIndex={active ? 0 : -1}
              title={`${connectionName} › ${item.database ?? "—"} › ${item.objectName}${item.preview ? ` · ${t("预览标签，双击保留")}` : ""}`}
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
                "group relative flex h-[26px] max-w-[200px] min-w-[112px] shrink-0 cursor-default items-center gap-1.5 rounded-[7px] px-2.5 text-[12px] outline-none transition-colors",
                active
                  ? "bg-tab-active text-tab-active-fg shadow-[var(--tab-active-shadow)]"
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
              <span className="min-w-0 flex-1 truncate">
                {item.title}
              </span>
              {item.preview && <span className="shrink-0 rounded bg-surface-2 px-1 text-10 not-italic text-fg-subtle">{t("预览")}</span>}
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
      </div>
      {(edges.left || edges.right) && <button type="button" aria-label={t("向右滚动标签")}
        title={t("向右滚动标签")} disabled={!edges.right}
        className="grid size-6 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-tab-hover disabled:opacity-30"
        onClick={() => { const strip = stripRef.current; if (strip) strip.scrollLeft += Math.max(160, strip.clientWidth * .7); }}><ChevronRight size={13} /></button>}

      <div className="flex shrink-0 items-center gap-1 px-1.5">
        {/* 标签多到要横向滚动时，用它一次看全：搜索 + 键盘选择，底部保留新建查询。 */}
        <OpenTabsMenu profileId={profileId} onNewQuery={onNewQuery} />
      </div>

      <ContextMenu {...menu.props} />
    </div>
  );
}
