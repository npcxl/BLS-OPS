/**
 * 应用内统一的下拉选择器。
 *
 * 为什么不用原生 `<select>`：WebView 展开的选项列表由系统绘制，白底、
 * 系统字体、蓝色高亮，和这套深色 UI 完全脱节（数据库模块一屏好几个下拉
 * 时尤其明显）。这里用 button + listbox 自己画，触发器与 `selectClass`
 * 同一套 token，展开面板用 `surface-2` / `line` / `accent`。
 *
 * 面板通过 portal 挂到 `body` 并用 fixed 定位：Modal、表格工具栏这些
 * 容器都有 `overflow`，绝对定位会被裁剪；fixed + portal 才能保证下拉
 * 永远完整显示，且不会被 `overflow-y-auto` 截断。
 *
 * 行为对齐原生 select：
 * - 点击外部 / Esc / 滚动 / 窗口 resize 关闭；
 * - ↑↓ 移动、Enter 选择、Space 打开；
 * - 禁用项不可选；
 * - 空间不够时向上展开。
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "@/components/icons";
import { cn } from "@/lib/cn";
import { CONTROL_HEIGHT, CONTROL_TEXT, controlBase, type ControlSize } from "./input";
import { OVERLAY_Z, useOverlayLayer } from "./overlay";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** 右侧浅色补充信息（例如 `root@host`）。 */
  hint?: string;
  /** 左侧图标（例如数据库引擎标志），选中项与选项都会显示。 */
  icon?: ReactNode;
}

interface MenuPosition {
  left: number;
  width: number;
  maxHeight: number;
  /** 面板顶部（向下展开时）或底部（向上展开时）的 fixed 坐标。 */
  top?: number;
  bottom?: number;
}

export function Select({
  value,
  options,
  onChange,
  placeholder,
  disabled = false,
  size = "md",
  className,
  ariaLabel,
  title,
  id,
  testId,
  invalid = false,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Field-level validation: red border + aria-invalid (message rendered by Field). */
  invalid?: boolean;
  /**
   * 与 Button / Input 共用一套档位（24 / 28 / 30 / 34）。
   *
   * **不再提供 `height` / `itemHeight`**：以前每个页面自己传 42/38，
   * 结果是同一个弹窗里下拉比输入框高 12px。要更高就调公共档位。
   * `lg` 的**选项行**仍然是 34px 高（带图标/说明的选项需要），这是选项
   * 语义，不是触发器尺寸。
   */
  size?: ControlSize;
  className?: string;
  ariaLabel?: string;
  title?: string;
  id?: string;
  /** 端到端测试用的定位锚点（挂到触发器上）。 */
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const generatedId = useId();
  const listId = `select-list-${id ?? generatedId}`;
  /**
   * 面板层级来自 OverlayManager，不再写死 `z-[150]`：
   * 弹窗内的下拉比弹窗高一层，弹窗内的弹窗再高一层，永远压得住遮罩；
   * 同时面板会登记为浮层，Esc / 全局快捷键按栈顺序让路。
   */
  const layer = useOverlayLayer(open, "select");

  const selected = options.find((option) => option.value === value) ?? null;

  const computePosition = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const gap = 4;
    const spaceBelow = window.innerHeight - rect.bottom - gap - 8;
    const spaceAbove = rect.top - gap - 8;
    const dropUp = spaceBelow < 200 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(96, Math.min(260, dropUp ? spaceAbove : spaceBelow));
    const width = Math.min(Math.max(rect.width, 160), Math.max(160, window.innerWidth - rect.left - 8));
    return {
      left: Math.min(rect.left, window.innerWidth - width - 8),
      width,
      maxHeight,
      ...(dropUp
        ? { bottom: window.innerHeight - rect.top + gap }
        : { top: rect.bottom + gap }),
    } satisfies MenuPosition;
  };

  useLayoutEffect(() => {
    if (!open) return;
    setPosition(computePosition());

    let frame = 0;
    /**
     * 外部滚动 → 重新定位（fixed 面板不跟随滚动会"飘走"）。
     * **必须忽略面板自身的滚动**：scroll 不冒泡，但 capture 阶段会经过
     * window。之前无条件关闭，选项一滚下拉就消失 —— 表现就是"滚动不了"。
     */
    const onScroll = (event: Event) => {
      if (listRef.current?.contains(event.target as Node)) return;
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const next = computePosition();
        if (next) setPosition(next);
      });
    };
    const onResize = () => setOpen(false);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.focus();
    const element = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    element?.scrollIntoView({ block: "nearest" });
    // `position`：面板是 portal + fixed，第一次 render 时还没挂载。
  }, [activeIndex, open, position]);

  const openMenu = () => {
    if (disabled) return;
    const index = options.findIndex((option) => option.value === value);
    setActiveIndex(index >= 0 ? index : options.findIndex((option) => !option.disabled));
    setOpen(true);
  };

  const close = (focusButton = true) => {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    close();
  };

  const move = (delta: number) => {
    if (options.length === 0) return;
    let next = activeIndex;
    for (let step = 0; step < options.length; step += 1) {
      next = (next + delta + options.length) % options.length;
      if (!options[next]?.disabled) break;
    }
    setActiveIndex(next);
  };

  const menu = open && position && (
    <div
      ref={listRef}
      id={listId}
      role="listbox"
      tabIndex={-1}
      aria-label={ariaLabel}
      className="select-menu fixed min-w-[160px] overflow-y-auto rounded-[8px] border border-line bg-surface-2 p-1 shadow-xl shadow-black/40 outline-none animate-[ops-pop_120ms_ease-out]"
      style={{
        left: position.left,
        width: position.width,
        maxHeight: position.maxHeight,
        top: position.top,
        bottom: position.bottom,
        // 高于所在弹窗（含嵌套），低于右键菜单与 tooltip。
        zIndex: OVERLAY_Z.select + Math.min(layer.depth, 8) * 2,
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          move(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          move(-1);
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          choose(activeIndex);
        } else if (event.key === "Escape") {
          event.preventDefault();
          close();
        } else if (event.key === "Tab") {
          close(false);
        }
      }}
    >
      {options.length === 0 && <p className="px-2 py-1.5 text-11 text-fg-subtle">—</p>}
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value || index}
            type="button"
            role="option"
            data-index={index}
            aria-selected={active}
            disabled={option.disabled}
            className={cn(
              "flex w-full items-center gap-2 rounded-[5px] px-2 text-left text-12 transition-colors",
              // lg 的行更高：带引擎图标 + 版本号时 26px 会贴在一起
              size === "lg" ? "min-h-[34px] py-[9px]" : "py-[6px]",
              active ? "bg-accent/10 text-accent" : "text-fg",
              !option.disabled && "hover:bg-surface-hover",
              option.disabled && "cursor-not-allowed opacity-40",
              activeIndex === index && !option.disabled && "bg-surface-hover",
            )}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => choose(index)}
          >
            {option.icon}
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {option.hint && (
              <span className="max-w-[150px] shrink-0 truncate text-10 text-fg-subtle">
                {option.hint}
              </span>
            )}
            {active && <Check size={11} className="shrink-0 text-accent" />}
          </button>
        );
      })}
    </div>
  );

  return (
    <div ref={rootRef} className={cn("relative min-w-0", className)}>
      <button
        ref={buttonRef}
        type="button"
        id={id}
        data-testid={testId}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        title={title ?? selected?.label}
        className={cn(
          // 触发器与 Input 同一份基类：高度、边框、圆角、焦点、禁用完全一致。
          controlBase,
          CONTROL_HEIGHT[size],
          CONTROL_TEXT[size],
          "flex w-full items-center justify-between gap-1 px-2 text-left",
          open
            ? "border-accent/70 ring-1 ring-accent/20"
            : invalid
              ? "border-danger/70"
              : "border-line",
          disabled && "cursor-not-allowed",
        )}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openMenu();
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (open) choose(activeIndex);
            else openMenu();
          } else if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {selected?.icon}
          <span className={cn("min-w-0 truncate", selected ? "text-fg" : "text-fg-subtle")}>
            {selected?.label ?? placeholder ?? ""}
          </span>
        </span>
        <ChevronDown
          size={size === "sm" ? 11 : 12}
          className={cn(
            "shrink-0 text-fg-subtle transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </button>

      {menu ? createPortal(menu, document.body) : null}
    </div>
  );
}
