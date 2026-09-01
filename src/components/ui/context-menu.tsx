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
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Reusable desktop context menu.
 *
 * Desktop conventions implemented here:
 * - right-click opens, and a right-click elsewhere moves the menu instead of
 *   closing and reopening it (no flicker);
 * - any left click outside, Escape, window blur, resize or scroll closes it;
 * - arrow keys / Home / End / Enter navigate and activate;
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
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [active, setActive] = useState(-1);

  // Listeners are registered once per open, so they read through refs —
  // otherwise every parent re-render would tear down and re-add them.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const activeRef = useRef(active);
  activeRef.current = active;

  // A new position (or a fresh open) means a new menu: drop the highlight.
  useEffect(() => {
    setActive(-1);
  }, [open, x, y]);

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
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }

      const current = itemsRef.current;
      const enabled: number[] = [];
      current.forEach((item, index) => {
        if (!item.separator && !item.disabled) enabled.push(index);
      });
      if (enabled.length === 0) return;

      if (event.key === "Enter") {
        event.preventDefault();
        const item = current[activeRef.current];
        if (item && !item.disabled && !item.separator && item.onSelect) {
          closeRef.current();
          item.onSelect();
        }
        return;
      }

      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        setActive(event.key === "Home" ? enabled[0] : enabled[enabled.length - 1]);
        return;
      }

      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const at = enabled.indexOf(activeRef.current);
      if (at < 0) {
        // Nothing focused yet: Down lands on the first item, Up on the last.
        setActive(step === 1 ? enabled[0] : enabled[enabled.length - 1]);
        return;
      }
      setActive(enabled[(at + step + enabled.length) % enabled.length]);
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
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={title ?? "上下文菜单"}
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
        return (
          <button
            key={item.id ?? item.label ?? index}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={cn(
              "flex h-7 w-full cursor-default items-center gap-2 rounded-[8px] px-2 text-12 select-none",
              item.danger ? "text-danger" : "text-fg",
              highlighted && (item.danger ? "bg-danger/12" : "bg-surface-hover"),
              item.disabled && "pointer-events-none opacity-40",
            )}
            onPointerEnter={() => !item.disabled && setActive(index)}
            onClick={() => {
              if (item.disabled) return;
              closeRef.current();
              item.onSelect?.();
            }}
          >
            {Icon ? (
              <Icon
                size={14}
                strokeWidth={1.75}
                className={cn("shrink-0", item.danger ? "text-danger/80" : "text-fg-subtle")}
              />
            ) : (
              <span className="w-[14px] shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
            {item.hint && <span className="shrink-0 text-10 text-fg-subtle">{item.hint}</span>}
          </button>
        );
      })}
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
