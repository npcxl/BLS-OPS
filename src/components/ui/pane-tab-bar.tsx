import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Pin, X, type IconComponent } from "@/components/icons";
import { cn } from "@/lib/cn";

/**
 * 通用标签栏。
 *
 * 外观与交互沿用数据库工作区那套：26px 高、7px 圆角、选中态（`bg-tab-active`
 * + 阴影 + 强调色图标）、两端渐隐的横向溢出、滚轮横滚、←/→/Home/End 键盘导航。
 *
 * **不带业务状态**：关闭、固定、预览、拖拽排序、右键菜单都由调用方通过每项上的
 * 回调声明；组件只负责画和交互，不知道"数据库工作项"或"会话标签"是什么。
 */
export interface PaneTab {
  id: string;
  label: string;
  /** 13px 线性图标。 */
  icon?: IconComponent;
  /** 数量、状态点之类的小角标（画在标签文字后）。 */
  badge?: ReactNode;
  title?: string;
  disabled?: boolean;
  /** 预览标签（双击可保留）：显示一个小标记。 */
  preview?: boolean;
  /** 已固定：显示图钉。 */
  pinned?: boolean;
  /** 关掉这一项：给了才显示 × 按钮。 */
  onClose?: () => void;
  onContextMenu?: (event: ReactMouseEvent) => void;
  /** 中键点击（数据库用它关闭标签）。 */
  onAuxClick?: (event: ReactMouseEvent) => void;
  onDoubleClick?: () => void;
}

export function PaneTabBar({
  tabs,
  value,
  onChange,
  ariaLabel,
  trailing,
  className,
  size = "md",
  /** 拖动排序：松手时告诉调用方从哪拖到哪。 */
  onReorder,
}: {
  tabs: PaneTab[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  /** 右侧常驻动作（展开 / 收起、已打开标签浮窗）。 */
  trailing?: ReactNode;
  className?: string;
  /** `sm` 用于面板内部的小段切换（执行输出 / 真实终端）。 */
  size?: "md" | "sm";
  onReorder?: (fromId: string, toId: string) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const dragRef = useRef<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  // 滚轮：横向滚动（标签条自身隐藏了滚动条）。
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (strip.scrollWidth <= strip.clientWidth) return;
      const unit = event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? strip.clientWidth : 1;
      const delta =
        (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * unit;
      if (delta === 0) return;
      event.preventDefault();
      event.stopPropagation();
      strip.scrollLeft += delta;
    };
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, [tabs.length]);

  // 两端渐隐 + 选中项滚进可见区。
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return undefined;
    const sync = () => {
      const max = strip.scrollWidth - strip.clientWidth;
      setEdges({ left: strip.scrollLeft > 1, right: max > 1 && strip.scrollLeft < max - 1 });
    };
    sync();
    strip.addEventListener("scroll", sync, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(strip);
    return () => {
      strip.removeEventListener("scroll", sync);
      observer?.disconnect();
    };
  }, [tabs.length, size]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const tab = strip.querySelector<HTMLElement>("[data-tab-active='true']");
    if (!tab) return;
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < strip.scrollLeft) strip.scrollLeft = left;
    else if (right > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = right - strip.clientWidth;
    }
  }, [value, tabs.length]);

  const move = (delta: number) => {
    const index = tabs.findIndex((tab) => tab.id === value);
    if (index < 0) return;
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (next && !next.disabled) onChange(next.id);
  };

  const mask =
    edges.left || edges.right
      ? `linear-gradient(to right, ${[
          edges.left ? "transparent 0px" : "#000 0px",
          edges.left ? "#000 20px" : null,
          edges.right ? "#000 calc(100% - 20px)" : null,
          edges.right ? "transparent 100%" : "#000 100%",
        ]
          .filter(Boolean)
          .join(", ")})`
      : undefined;

  const height = size === "sm" ? 24 : 26;

  return (
    <div
      className={cn(
        "flex w-full min-w-0 shrink-0 items-center gap-1",
        size === "md" && "border-b border-divider/70",
        className,
      )}
    >
      {edges.left && (
        <button
          type="button"
          aria-label="向左滚动标签"
          title="向左滚动标签"
          disabled={!edges.left}
          className="grid size-6 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-tab-hover disabled:opacity-30"
          onClick={() => {
            const strip = stripRef.current;
            if (strip) strip.scrollLeft -= Math.max(120, strip.clientWidth * 0.7);
          }}
        >
          <ChevronLeft size={13} />
        </button>
      )}

      <div className="relative flex min-w-0 flex-1 basis-0 items-center overflow-hidden">
        <div
          ref={stripRef}
          role="tablist"
          aria-label={ariaLabel}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{ maskImage: mask, WebkitMaskImage: mask }}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") {
              event.preventDefault();
              move(1);
            } else if (event.key === "ArrowLeft") {
              event.preventDefault();
              move(-1);
            } else if (event.key === "Home") {
              event.preventDefault();
              const first = tabs.find((tab) => !tab.disabled);
              if (first) onChange(first.id);
            } else if (event.key === "End") {
              event.preventDefault();
              const last = [...tabs].reverse().find((tab) => !tab.disabled);
              if (last) onChange(last.id);
            }
          }}
        >
          {tabs.map((tab) => {
            const active = tab.id === value;
            const Icon = tab.icon;
            const isDropTarget = dropTargetId === tab.id && draggingId !== tab.id;
            const reorderable = Boolean(onReorder);
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={active}
                data-tab-active={active ? "true" : undefined}
                tabIndex={active ? 0 : -1}
                title={tab.title ?? tab.label}
                draggable={reorderable}
                onClick={() => {
                  if (tab.disabled) return;
                  onChange(tab.id);
                }}
                onDoubleClick={() => tab.onDoubleClick?.()}
                onAuxClick={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    tab.onAuxClick?.(event);
                  }
                }}
                onContextMenu={(event) => tab.onContextMenu?.(event)}
                onDragStart={(event) => {
                  if (!reorderable) return;
                  dragRef.current = tab.id;
                  setDraggingId(tab.id);
                  event.dataTransfer.effectAllowed = "move";
                  // Firefox 需要写一次数据才会真正开始拖动。
                  event.dataTransfer.setData("text/plain", tab.id);
                }}
                onDragEnd={() => {
                  dragRef.current = null;
                  setDraggingId(null);
                  setDropTargetId(null);
                }}
                onDragOver={(event) => {
                  if (!dragRef.current || dragRef.current === tab.id) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDropTargetId(tab.id);
                }}
                onDragLeave={() => {
                  setDropTargetId((current) => (current === tab.id ? null : current));
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const from = dragRef.current;
                  setDropTargetId(null);
                  setDraggingId(null);
                  dragRef.current = null;
                  if (from && from !== tab.id) onReorder?.(from, tab.id);
                }}
                className={cn(
                  "group relative flex max-w-[200px] min-w-0 shrink-0 cursor-default items-center gap-1.5 rounded-[7px] text-[12px] outline-none transition-colors",
                  size === "md" ? "min-w-[96px] px-2.5" : "min-w-[72px] justify-center px-2",
                  active
                    ? "bg-tab-active text-tab-active-fg shadow-[var(--tab-active-shadow)]"
                    : "text-fg-muted hover:bg-tab-hover hover:text-fg",
                  tab.disabled && "cursor-not-allowed opacity-40",
                  isDropTarget &&
                    "before:absolute before:inset-y-1 before:left-0 before:w-[2px] before:rounded-full before:bg-accent",
                  draggingId === tab.id && "opacity-50",
                )}
                style={{ height }}
              >
                {Icon && (
                  <Icon
                    size={size === "sm" ? 12 : 13}
                    strokeWidth={1.75}
                    className={cn("shrink-0", active ? "text-accent" : "text-fg-subtle")}
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{tab.label}</span>
                {tab.preview && (
                  <span className="shrink-0 rounded bg-surface-2 px-1 text-10 text-fg-subtle">预览</span>
                )}
                {tab.pinned && <Pin size={10} className="shrink-0 text-fg-subtle" />}
                {tab.badge}
                {tab.onClose && (
                  <button
                    type="button"
                    aria-label="关闭标签"
                    className={cn(
                      "ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] text-fg-subtle transition-colors hover:bg-surface-active hover:text-fg",
                      active
                        ? "opacity-100"
                        : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                    )}
                    onClick={(event) => {
                      event.stopPropagation();
                      tab.onClose?.();
                    }}
                  >
                    <X size={11} strokeWidth={2} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {edges.right && (
        <button
          type="button"
          aria-label="向右滚动标签"
          title="向右滚动标签"
          disabled={!edges.right}
          className="grid size-6 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-tab-hover disabled:opacity-30"
          onClick={() => {
            const strip = stripRef.current;
            if (strip) strip.scrollLeft += Math.max(120, strip.clientWidth * 0.7);
          }}
        >
          <ChevronRight size={13} />
        </button>
      )}

      {trailing && <div className="flex shrink-0 items-center gap-1">{trailing}</div>}
    </div>
  );
}
