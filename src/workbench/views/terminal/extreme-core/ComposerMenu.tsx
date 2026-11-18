import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check } from "@/components/icons";
import { cn } from "@/lib/cn";
import { OVERLAY_Z } from "@/components/ui/overlay";

/**
 * 输入框底栏的浮层菜单。
 *
 * 只在**输入区上方**展开（底栏贴着窗口底边），并夹在视口内；点外部、Esc、
 * 窗口尺寸变化都会重算或关闭。菜单打开时不夺焦：用户可以继续打字。
 */
const MENU_WIDTH = 320;
const GAP = 6;
const EDGE = 8;

interface MenuPosition {
  left: number;
  width: number;
  bottom: number;
  maxHeight: number;
}

export function ComposerMenu({
  open,
  onClose,
  anchor,
  label,
  opaque = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** 触发按钮：定位与"点自己不算外部"都靠它。 */
  anchor: HTMLElement | null;
  label: string;
  opaque?: boolean;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<MenuPosition | null>(null);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const update = () => {
      const rect = anchor?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(MENU_WIDTH, window.innerWidth - EDGE * 2);
      const left = Math.max(EDGE, Math.min(rect.left, window.innerWidth - width - EDGE));
      const spaceAbove = rect.top - EDGE;
      setPosition({
        left,
        width,
        bottom: window.innerHeight - rect.top + GAP,
        maxHeight: Math.max(180, Math.min(440, spaceAbove)),
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, anchor]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    // 捕获阶段：输入框自己也会处理 Esc，先把菜单关掉再说。
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, anchor, onClose]);

  if (!open || !position) return null;
  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label={label}
      className="page-overlay-surface overlay-enter fixed overflow-y-auto p-1.5"
      style={{
        left: position.left,
        width: position.width,
        bottom: position.bottom,
        maxHeight: position.maxHeight,
        zIndex: OVERLAY_Z.popover,
        ...(opaque ? { backgroundColor: "rgb(var(--overlay))" } : {}),
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** 菜单分组标题（供应商名 / 「设置」之类）。 */
export function MenuGroupTitle({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-1.5 text-10 font-medium uppercase tracking-wide text-fg-subtle">
      {children}
    </div>
  );
}

/**
 * 一行菜单项。
 *
 * 选中用**一层薄膜 + 打勾**，不用实心亮块 —— 深色下那样会抢走正文注意力。
 */
export function MenuChoice({
  label,
  hint,
  selected,
  disabled,
  onClick,
}: {
  label: ReactNode;
  hint?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected ? "true" : "false"}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-[8px] px-2 text-left text-12 transition-colors",
        selected ? "bg-menu-item-active text-fg" : "text-fg hover:bg-surface-hover",
        disabled && "pointer-events-none opacity-40",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 text-10 text-fg-subtle">{hint}</span>}
      <Check
        size={12}
        strokeWidth={2}
        aria-hidden="true"
        className={cn("shrink-0 text-accent", selected ? "opacity-100" : "opacity-0")}
      />
    </button>
  );
}

/** 一排小按钮（上下文长度 / 思考强度）。 */
export function MenuSegments<T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex flex-wrap items-center gap-1"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={active ? "true" : "false"}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-full px-2 py-0.5 text-11 transition-colors",
              active
                ? "bg-menu-item-active text-fg"
                : "text-fg-muted hover:bg-surface-hover hover:text-fg",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
