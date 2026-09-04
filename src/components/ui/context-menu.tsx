import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Reusable desktop context menu.
 *
 * Desktop conventions implemented here:
 * - right-click opens, and a right-click elsewhere moves the menu instead of
 *   closing and reopening it (no flicker);
 * - any left click outside, Escape, window blur, resize or scroll closes it;
 * - arrow keys / Home / End / Enter navigate and activate;
 * - items may carry `children`, which opens a submenu (hover, click, or →);
 * - the menu never overflows the viewport and never jumps after paint.
 *
 * It is `memo`ised and every listener is registered exactly once per open, so
 * a busy parent (a file list with hundreds of rows) re-rendering never touches
 * the menu.
 */

export interface ContextMenuItem {
  id?: string;
  label?: string;
  icon?: LucideIcon;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  /** Right-aligned secondary text (shortcut hint). */
  hint?: string;
  onSelect?: () => void;
  /**
   * Turns the item into a submenu parent. Selecting it (or hovering it, or →)
   * opens the child list; the parent's own `onSelect` is never fired.
   * Nesting is intentionally one level deep.
   */
  children?: ContextMenuItem[];
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

/** Distance kept from the viewport edge when clamping. */
const GAP = 4;
const DEFAULT_MIN_WIDTH = 184;
const NO_ITEMS: ContextMenuItem[] = [];

/**
 * Global slot for "the context menu that is open right now". Every menu
 * registers its own close handler here while open; any other `useContextMenu`
 * closes it before opening its own.
 *
 * Without this, call sites that mount *several* independent menus — e.g. every
 * server row plus the blank-space list menu — would each keep their own open
 * state, and right-clicking a second area while the first menu is up leaves
 * both visible at once.
 */
let activeMenuClose: (() => void) | null = null;

/** Closes whichever context menu is open (no-op when none is). */
export function closeActiveContextMenu(): void {
  activeMenuClose?.();
}

interface ContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  /** Optional heading, e.g. the file the actions apply to. */
  title?: string;
  minWidth?: number;
}

export const ContextMenu = memo(function ContextMenu({
  open,
  x,
  y,
  items,
  onClose,
  title,
  minWidth = DEFAULT_MIN_WIDTH,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [active, setActive] = useState(-1);
  /** Index of the parent item whose submenu is open, or `null`. */
  const [submenu, setSubmenu] = useState<number | null>(null);
  const [subActive, setSubActive] = useState(-1);
  const [subPos, setSubPos] = useState<{ x: number; y: number } | null>(null);

  // Per-item DOM nodes, needed to anchor the submenu next to its parent row.
  const itemRefs = useRef(new Map<number, HTMLElement>());
  const submenuRef = useRef<HTMLDivElement>(null);

  // Listeners are registered once per open, so they read through refs —
  // otherwise every parent re-render would tear down and re-add them.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const activeRef = useRef(active);
  activeRef.current = active;
  const submenuRefValue = useRef(submenu);
  submenuRefValue.current = submenu;
  const subActiveRef = useRef(subActive);
  subActiveRef.current = subActive;

  const openSubmenu = useCallback((index: number) => {
    setSubmenu(index);
    setSubActive(-1);
  }, []);

  const resetSubmenu = useCallback(() => {
    setSubmenu(null);
    setSubActive(-1);
  }, []);

  // A new position (or a fresh open) means a new menu: drop the highlight.
  useEffect(() => {
    setActive(-1);
    resetSubmenu();
  }, [open, x, y, resetSubmenu]);

  // Claim the global singleton slot while open; another menu opening anywhere
  // (same or different useContextMenu) closes this one first.
  useEffect(() => {
    if (!open) return;
    const release = () => closeRef.current();
    activeMenuClose = release;
    return () => {
      if (activeMenuClose === release) activeMenuClose = null;
    };
  }, [open]);

  // Measure before paint. Until the measurement lands the menu is hidden, so
  // it never renders at the raw cursor position and then jumps.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.max(GAP, Math.min(x, window.innerWidth - rect.width - GAP)),
      y: Math.max(GAP, Math.min(y, window.innerHeight - rect.height - GAP)),
    });
  }, [open, x, y, items]);

  // The submenu is anchored to its parent row, measured before paint like the
  // root menu, and flipped to the other side when it would leave the viewport.
  useLayoutEffect(() => {
    if (submenu === null) {
      setSubPos(null);
      return;
    }
    const anchor = itemRefs.current.get(submenu);
    if (!anchor) return;
    const anchorRect = anchor.getBoundingClientRect();
    const panel = submenuRef.current;
    const width = panel?.offsetWidth ?? DEFAULT_MIN_WIDTH;
    const height = panel?.offsetHeight ?? 0;

    // Prefer opening to the right of the row; flip left when it overflows.
    let left = anchorRect.right - 6;
    if (left + width > window.innerWidth - GAP) {
      left = Math.max(GAP, anchorRect.left - width + 6);
    }
    let top = anchorRect.top - 6;
    if (top + height > window.innerHeight - GAP) {
      top = Math.max(GAP, window.innerHeight - height - GAP);
    }
    setSubPos({ x: left, y: top });
  }, [submenu, items, open]);

  useEffect(() => {
    if (!open) return;

    const isInside = (target: EventTarget | null) =>
      target instanceof Node && (ref.current?.contains(target) ?? false);

    const onPointerDown = (event: PointerEvent) => {
      // A right-click must NOT close: the `contextmenu` that follows decides
      // whether another menu replaces this one. Closing here first is what
      // makes re-opening elsewhere flicker.
      if (event.button === 2) return;
      if (isInside(event.target)) return;
      closeRef.current();
    };

    const onContextMenu = (event: MouseEvent) => {
      // Bubble phase: React handlers have already run. If one of them opened
      // a menu it called `preventDefault`, so leave this one alone and let the
      // incoming menu replace it in a single update.
      if (event.defaultPrevented) return;
      if (isInside(event.target)) {
        event.preventDefault();
        return;
      }
      closeRef.current();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // Escape unwinds one level: the submenu first, then the whole menu.
      if (event.key === "Escape") {
        event.preventDefault();
        if (submenuRefValue.current !== null) {
          setSubmenu(null);
          setSubActive(-1);
          return;
        }
        closeRef.current();
        return;
      }

      const current = itemsRef.current;
      const parent = submenuRefValue.current;
      const inSubmenu = parent !== null;
      const list = inSubmenu ? current[parent]?.children ?? [] : current;
      const selectable: number[] = [];
      list.forEach((item, index) => {
        if (!item.separator && !item.disabled) selectable.push(index);
      });
      const setIndex = (index: number) => (inSubmenu ? setSubActive(index) : setActive(index));

      if (event.key === "ArrowRight") {
        // Opens (or walks into) a submenu from the highlighted parent row.
        if (inSubmenu) return;
        const item = current[activeRef.current];
        if (item?.children?.length) {
          event.preventDefault();
          openSubmenu(activeRef.current);
        }
        return;
      }

      if (event.key === "ArrowLeft") {
        if (!inSubmenu) return;
        event.preventDefault();
        setSubmenu(null);
        setSubActive(-1);
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        const index = inSubmenu ? subActiveRef.current : activeRef.current;
        const item = list[index];
        if (!item || item.disabled || item.separator) return;
        if (item.children?.length) {
          if (!inSubmenu) openSubmenu(index);
          return;
        }
        closeRef.current();
        item.onSelect?.();
        return;
      }

      if (selectable.length === 0) return;

      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        setIndex(event.key === "Home" ? selectable[0] : selectable[selectable.length - 1]);
        return;
      }

      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const at = selectable.indexOf(inSubmenu ? subActiveRef.current : activeRef.current);
      if (at < 0) {
        // Nothing focused yet: Down lands on the first item, Up on the last.
        setIndex(step === 1 ? selectable[0] : selectable[selectable.length - 1]);
        return;
      }
      setIndex(selectable[(at + step + selectable.length) % selectable.length]);
    };

    const onBlur = () => closeRef.current();
    // The menu is anchored to the cursor, not to an element, so a resize is
    // the only geometry change that can leave it pointing somewhere else.
    const onResize = () => closeRef.current();

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onResize);
    };
  }, [open, openSubmenu]);

  if (!open) return null;

  const submenuItems = submenu === null ? null : items[submenu]?.children;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={title ?? t("Context menu")}
      className="glass-panel-strong fixed z-[200] rounded-[12px] p-1"
      style={{
        left: pos?.x ?? x,
        top: pos?.y ?? y,
        minWidth,
        visibility: pos ? "visible" : "hidden",
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {title && (
        <div
          className="truncate px-2 pb-1 pt-0.5 text-10 font-semibold tracking-[0.06em] text-fg-subtle uppercase"
          title={title}
        >
          {title}
        </div>
      )}
      {items.map((item, index) => {
        if (item.separator) {
          return <div key={item.id ?? `sep-${index}`} className="my-1 h-px bg-line" role="separator" />;
        }
        const Icon = item.icon;
        const highlighted = active === index;
        const hasChildren = (item.children?.length ?? 0) > 0;
        return (
          <button
            key={item.id ?? item.label ?? index}
            ref={(node) => {
              if (node) itemRefs.current.set(index, node);
              else itemRefs.current.delete(index);
            }}
            type="button"
            role="menuitem"
            aria-haspopup={hasChildren || undefined}
            aria-expanded={hasChildren ? submenu === index : undefined}
            data-submenu-open={hasChildren && submenu === index ? "true" : undefined}
            disabled={item.disabled}
            className={cn(
              "relative flex h-7 w-full cursor-default items-center gap-2 rounded-[8px] pl-3 pr-2 text-12 select-none transition-colors",
              item.danger ? "text-danger" : highlighted ? "text-accent" : "text-fg",
              item.disabled && "pointer-events-none opacity-40",
            )}
            onPointerEnter={() => {
              if (item.disabled) return;
              setActive(index);
              // Hovering a parent opens its submenu; hovering a leaf closes any
              // open one so the panel never belongs to a row the cursor left.
              if (hasChildren) openSubmenu(index);
              else resetSubmenu();
            }}
            onClick={() => {
              if (item.disabled) return;
              if (hasChildren) {
                setSubmenu((current) => (current === index ? null : index));
                setSubActive(-1);
                return;
              }
              closeRef.current();
              item.onSelect?.();
            }}
          >
            {/* active indicator bar (left) — replaces the old full-row highlight */}
            <span
              className={cn(
                "pointer-events-none absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-accent transition-opacity duration-150",
                highlighted ? "opacity-100" : "opacity-0",
              )}
            />
            {Icon ? (
              <Icon
                size={14}
                strokeWidth={1.75}
                className={cn("shrink-0", item.danger ? "text-danger/80" : highlighted ? "text-accent" : "text-fg-subtle")}
              />
            ) : (
              <span className="w-[14px] shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
            {item.hint && <span className="shrink-0 text-10 text-fg-subtle">{item.hint}</span>}
            {hasChildren && (
              <ChevronRight
                size={12}
                strokeWidth={1.75}
                aria-hidden="true"
                className="shrink-0 text-fg-subtle"
              />
            )}
          </button>
        );
      })}

      {submenuItems && (
        <div
          ref={submenuRef}
          role="menu"
          aria-label={items[submenu!]?.label ?? t("Submenu")}
          className="glass-panel-strong fixed z-[210] rounded-[12px] p-1"
          style={{
            left: subPos?.x ?? 0,
            top: subPos?.y ?? 0,
            minWidth,
            visibility: subPos ? "visible" : "hidden",
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {submenuItems.map((item, index) => {
            if (item.separator) {
              return <div key={item.id ?? `sub-sep-${index}`} className="my-1 h-px bg-line" role="separator" />;
            }
            const Icon = item.icon;
            const highlighted = subActive === index;
            return (
              <button
                key={item.id ?? item.label ?? index}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={cn(
                  "relative flex h-7 w-full cursor-default items-center gap-2 rounded-[8px] pl-3 pr-2 text-12 select-none transition-colors",
                  item.danger ? "text-danger" : highlighted ? "text-accent" : "text-fg",
                  item.disabled && "pointer-events-none opacity-40",
                )}
                onPointerEnter={() => !item.disabled && setSubActive(index)}
                onClick={() => {
                  if (item.disabled) return;
                  closeRef.current();
                  item.onSelect?.();
                }}
              >
                <span
                  className={cn(
                    "pointer-events-none absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-accent transition-opacity duration-150",
                    highlighted ? "opacity-100" : "opacity-0",
                  )}
                />
                {Icon ? (
                  <Icon
                    size={14}
                    strokeWidth={1.75}
                    className={cn("shrink-0", item.danger ? "text-danger/80" : highlighted ? "text-accent" : "text-fg-subtle")}
                  />
                ) : (
                  <span className="w-[14px] shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
                {item.hint && <span className="shrink-0 text-10 text-fg-subtle">{item.hint}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>,
    document.body,
  );
});

/**
 * State helper for one menu. `onContextMenu` builds the items at click time,
 * so nothing is allocated while the menu is closed.
 *
 * ```tsx
 * const menu = useContextMenu();
 * <div onContextMenu={menu.onContextMenu(() => [ … ])} />
 * <ContextMenu {...menu.props} />
 * ```
 */
export function useContextMenu() {
  const [state, setState] = useState<ContextMenuState | null>(null);

  const close = useCallback(() => setState(null), []);

  const onContextMenu = useCallback(
    (build: (event: ReactMouseEvent) => ContextMenuItem[]) =>
      (event: ReactMouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        // 同一时刻只保留一个右键菜单：新位置/新实例打开前，先关掉已经
        // 打开的那个（例：行菜单开着，再去空白处右键不能让两个并存）。
        // 同一实例时 close+open 被 React 批处理成一次"移动"，不闪跳。
        closeActiveContextMenu();
        setState({ x: event.clientX, y: event.clientY, items: build(event) });
      },
    [],
  );

  return {
    /** Spread onto <ContextMenu>. */
    props: {
      open: state !== null,
      x: state?.x ?? 0,
      y: state?.y ?? 0,
      items: state?.items ?? NO_ITEMS,
      onClose: close,
    },
    onContextMenu,
    close,
  };
}

/** Alias kept for call sites that only need the menu props. */
export const EMPTY_CONTEXT_MENU_ITEMS = NO_ITEMS;
