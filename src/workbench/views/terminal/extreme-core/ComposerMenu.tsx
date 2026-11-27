import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { OVERLAY_Z } from "@/components/ui/overlay";

/**
 * 超能模式的内容浮层（目前只剩输入区右下角的「上下文用量」）。
 *
 * 选择类入口（服务器筛选 / 权限 / 上下文范围与长度）已经统一走
 * `@/components/ui/select`，这里只负责不属于选择框的信息面板。
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
  top?: number;
  bottom?: number;
  maxHeight: number;
}

export function ComposerMenu({
  open,
  onClose,
  anchor,
  label,
  opaque = false,
  placement = "top",
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** 触发按钮：定位与"点自己不算外部"都靠它。 */
  anchor: HTMLElement | null;
  label: string;
  opaque?: boolean;
  /** 默认向上展开（输入框在窗口底部）；左栏筛选等顶部入口用 `bottom`。 */
  placement?: "top" | "bottom";
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
      if (placement === "bottom") {
        const top = rect.bottom + GAP;
        setPosition({
          left,
          width,
          top,
          maxHeight: Math.max(180, Math.min(440, window.innerHeight - top - EDGE)),
        });
        return;
      }
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
  }, [open, anchor, placement]);

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
      className="page-overlay-surface overlay-enter fixed overflow-y-auto rounded-2xl border border-line/70 p-1.5 backdrop-blur-md"
      style={{
        left: position.left,
        width: position.width,
        ...(position.top !== undefined
          ? { top: position.top }
          : { bottom: position.bottom }),
        maxHeight: position.maxHeight,
        zIndex: OVERLAY_Z.popover,
        transformOrigin: placement === "bottom" ? "top left" : "bottom left",
        boxShadow:
          "0 14px 36px -10px rgb(0 0 0 / 0.28), 0 2px 6px -1px rgb(0 0 0 / 0.08)",
        ...(opaque ? { backgroundColor: "rgb(var(--overlay))" } : {}),
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
