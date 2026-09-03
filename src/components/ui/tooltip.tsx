import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

export type TooltipSide = "top" | "bottom" | "left" | "right";

export interface TooltipProps {
  label: ReactNode;
  side?: TooltipSide;
  children: ReactElement;
  className?: string;
  /** 鼠标悬停多久后显示。 */
  delay?: number;
}

interface Position {
  left: number;
  top: number;
  side: TooltipSide;
  arrowOffset: number;
}

interface TriggerProps {
  ref?: Ref<HTMLElement>;
  onPointerEnter?: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerLeave?: (event: ReactPointerEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
  "aria-describedby"?: string;
}

const GAP = 8;
const VIEWPORT_PADDING = 8;
const DEFAULT_DELAY = 150;
const LEAVE_DELAY = 70;
const ARROW_PADDING = 10;

const OPPOSITE_SIDE: Record<TooltipSide, TooltipSide> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") {
    ref(value);
    return;
  }

  if (ref) {
    (ref as { current: T | null }).current = value;
  }
}

export function Tooltip({
  label,
  side = "top",
  children,
  className,
  delay = DEFAULT_DELAY,
}: TooltipProps) {
  const tooltipId = useId();

  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);

  const triggerRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  const enterTimer = useRef<number | null>(null);
  const leaveTimer = useRef<number | null>(null);

  const clearEnterTimer = () => {
    if (enterTimer.current !== null) {
      window.clearTimeout(enterTimer.current);
      enterTimer.current = null;
    }
  };

  const clearLeaveTimer = () => {
    if (leaveTimer.current !== null) {
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  };

  const closeNow = useCallback(() => {
    setOpen(false);
    setPosition(null);
  }, []);

  const openNow = useCallback(() => {
    clearLeaveTimer();
    setOpen(true);
  }, []);

  const scheduleOpen = () => {
    clearLeaveTimer();
    clearEnterTimer();

    enterTimer.current = window.setTimeout(() => {
      enterTimer.current = null;
      openNow();
    }, delay);
  };

  const scheduleClose = () => {
    clearEnterTimer();
    clearLeaveTimer();

    leaveTimer.current = window.setTimeout(() => {
      leaveTimer.current = null;
      closeNow();
    }, LEAVE_DELAY);
  };

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;

    if (!trigger || !tooltip) return;

    const triggerRect = trigger.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();

    const availableSpace: Record<TooltipSide, number> = {
      top: triggerRect.top - VIEWPORT_PADDING,
      bottom: window.innerHeight - triggerRect.bottom - VIEWPORT_PADDING,
      left: triggerRect.left - VIEWPORT_PADDING,
      right: window.innerWidth - triggerRect.right - VIEWPORT_PADDING,
    };

    const requiredSpace = (targetSide: TooltipSide) =>
      targetSide === "top" || targetSide === "bottom"
        ? tooltipRect.height + GAP
        : tooltipRect.width + GAP;

    const opposite = OPPOSITE_SIDE[side];

    let actualSide = side;

    if (
      availableSpace[side] < requiredSpace(side) &&
      availableSpace[opposite] > availableSpace[side]
    ) {
      actualSide = opposite;
    }

    const centerX = triggerRect.left + triggerRect.width / 2;
    const centerY = triggerRect.top + triggerRect.height / 2;

    let left = 0;
    let top = 0;
    let arrowOffset = 0;

    if (actualSide === "top" || actualSide === "bottom") {
      left = centerX - tooltipRect.width / 2;
      left = clamp(
        left,
        VIEWPORT_PADDING,
        window.innerWidth - tooltipRect.width - VIEWPORT_PADDING,
      );

      top =
        actualSide === "top"
          ? triggerRect.top - tooltipRect.height - GAP
          : triggerRect.bottom + GAP;

      arrowOffset = clamp(
        centerX - left,
        ARROW_PADDING,
        tooltipRect.width - ARROW_PADDING,
      );
    } else {
      top = centerY - tooltipRect.height / 2;
      top = clamp(
        top,
        VIEWPORT_PADDING,
        window.innerHeight - tooltipRect.height - VIEWPORT_PADDING,
      );

      left =
        actualSide === "left"
          ? triggerRect.left - tooltipRect.width - GAP
          : triggerRect.right + GAP;

      arrowOffset = clamp(
        centerY - top,
        ARROW_PADDING,
        tooltipRect.height - ARROW_PADDING,
      );
    }

    left = clamp(
      left,
      VIEWPORT_PADDING,
      window.innerWidth - tooltipRect.width - VIEWPORT_PADDING,
    );

    top = clamp(
      top,
      VIEWPORT_PADDING,
      window.innerHeight - tooltipRect.height - VIEWPORT_PADDING,
    );

    setPosition({
      left: Math.round(left),
      top: Math.round(top),
      side: actualSide,
      arrowOffset: Math.round(arrowOffset),
    });
  }, [side]);

  useLayoutEffect(() => {
    if (!open) return;

    updatePosition();

    const observer = new ResizeObserver(updatePosition);

    if (tooltipRef.current) observer.observe(tooltipRef.current);
    if (triggerRef.current) observer.observe(triggerRef.current);

    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeNow();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", closeNow);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", closeNow);
    };
  }, [open, closeNow]);

  useEffect(
    () => () => {
      clearEnterTimer();
      clearLeaveTimer();
    },
    [],
  );

  if (!isValidElement(children) || label == null || label === "") {
    return children;
  }

  const child = children as ReactElement<TriggerProps>;
  const originalDescription = child.props["aria-describedby"];

  const trigger = cloneElement(child, {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      assignRef(child.props.ref, node);
    },

    "aria-describedby": open
      ? [originalDescription, tooltipId].filter(Boolean).join(" ")
      : originalDescription,

    onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => {
      child.props.onPointerEnter?.(event);

      // 触摸设备不显示悬停提示。
      if (event.pointerType !== "touch") scheduleOpen();
    },

    onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => {
      child.props.onPointerLeave?.(event);
      scheduleClose();
    },

    onFocus: (event: FocusEvent<HTMLElement>) => {
      child.props.onFocus?.(event);

      // 键盘聚焦立即显示，不让键盘用户等待。
      clearEnterTimer();
      openNow();
    },

    onBlur: (event: FocusEvent<HTMLElement>) => {
      child.props.onBlur?.(event);
      scheduleClose();
    },
  });

  return (
    <>
      {trigger}

      {open &&
        createPortal(
          <div
            ref={tooltipRef}
            id={tooltipId}
            role="tooltip"
            data-side={position?.side ?? side}
            className={cn(
              "ops-tooltip fixed z-[220]",
              "pointer-events-none select-none",
              "max-w-[min(280px,calc(100vw-16px))]",
              "whitespace-normal break-words",
              "rounded-[7px] border border-line/90",
              "bg-surface-1 px-2.5 py-1.5",
              "text-11 leading-4 font-normal text-fg-muted",
              "shadow-[0_8px_22px_rgb(15_23_42/0.12),0_1px_2px_rgb(15_23_42/0.08),inset_0_1px_0_rgb(255_255_255/0.7)]",
              "ops-tooltip-enter",
              className,
            )}
            style={{
              left: position?.left ?? 0,
              top: position?.top ?? 0,
              visibility: position ? "visible" : "hidden",
            }}
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  );
}