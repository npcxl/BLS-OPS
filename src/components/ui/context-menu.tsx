import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Minimal floating context menu — spec §27.
 * Desktop convention: right-click opens, Escape / outside click closes,
 * keyboard focus is kept inside (arrow keys + enter).
 */

export interface ContextMenuItem {
  id?: string;
  label?: string;
  icon?: LucideIcon;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  onSelect?: () => void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

interface ContextMenuProps {
  state: ContextMenuState;
  onClose: () => void;
}

const ITEM_H = 28;
const MENU_PAD = 4;
const GAP = 4;

export function ContextMenu({ state, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: state.x, y: state.y });

  // clamp to viewport so the menu never overflows the window
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.min(state.x, window.innerWidth - rect.width - GAP),
      y: Math.min(state.y, window.innerHeight - rect.height - GAP),
    });
  }, [state.x, state.y]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // keyboard navigation over menu items
  const [focusIdx, setFocusIdx] = useState(0);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusIdx((i) => Math.min(i + 1, state.items.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = state.items[focusIdx];
        if (item && !item.disabled && item.onSelect) item.onSelect();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state.items, focusIdx]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-[100] min-w-[180px] rounded-[10px] border border-line bg-surface-3 p-1 shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
      style={{ left: pos.x, top: pos.y, paddingTop: MENU_PAD, paddingBottom: MENU_PAD }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {state.items.map((item, i) => {
        if (item.separator) {
          return <div key={item.id ?? `sep-${i}`} className="my-1 h-px bg-line" role="separator" />;
        }
        const Icon = item.icon;
        const active = focusIdx === i;
        return (
          <button
            key={item.id ?? item.label ?? i}
            role="menuitem"
            disabled={item.disabled}
            className={cn(
              "flex h-7 w-full cursor-default items-center gap-2 rounded-[6px] px-2 text-12",
              item.danger ? "text-danger" : "text-fg",
              active && "bg-surface-hover",
              item.disabled && "opacity-50",
            )}
            onMouseEnter={() => setFocusIdx(i)}
            onClick={() => {
              onClose();
              if (!item.disabled && item.onSelect) item.onSelect();
            }}
          >
            {Icon && <Icon size={14} strokeWidth={1.75} className="shrink-0 text-fg-subtle" />}
            <span className="truncate">{item.label}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

/** Position a menu next to the cursor from a native context menu event. */
export function contextMenuStateAt(
  e: { clientX: number; clientY: number },
  items: ContextMenuItem[],
): ContextMenuState {
  return { x: e.clientX, y: e.clientY, items };
}

/** Wrapper to keep menu item row height in sync with ITEM_H. */
export const CONTEXT_MENU_ITEM_H = ITEM_H;
