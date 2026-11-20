/**
 * 应用内统一的下拉选择器。
 *
 * 外观与手感**复制自**超能模式输入区的 Prompt Bar（`prompt-bar.tsx` 里的
 * 模型选择）：
 * - 收起态是轻量按钮：`menu` 档无边框，hover 只上一层淡底；
 * - 展开态是 12px 圆角浮层，36px 选项行、13px medium 主文案；
 * - 高亮不是给某一行刷底色，而是一块光晕在行间平滑移动（220ms）；
 * - 选中靠右侧勾，不靠 accent 色块 —— 深色下不会出现一条亮条；
 * - 面板 4px + 0.98 缩放入场，方向跟随展开方向。
 *
 * 两处必要适配（不改 Prompt Bar 的视觉）：
 * 1. 面板 portal 到 `body` + fixed：Modal、表格工具栏这些容器都有 `overflow`，
 *    绝对定位会被裁掉；
 * 2. 触发器分档：`field`（默认）与 Input 同高、留一条淡边，表单里看得出是
 *    控件；`menu`（页面顶栏入口）与 Prompt Bar 完全一致。
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
import { Tooltip } from "./tooltip";
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
  /** 向上展开：入场方向与变形原点都要翻过来。 */
  dropUp: boolean;
}

/** 与 Prompt Bar 同一组关键帧：从触发方向缩进来 4px。 */
const STYLE = `
@keyframes select-pop-up { from { opacity: 0; transform: translateY(4px) scale(0.98); } }
@keyframes select-pop-down { from { opacity: 0; transform: translateY(-4px) scale(0.98); } }
`;

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
  variant = "field",
  tone = "default",
  iconOnly = false,
  menuMinWidth = 180,
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
   * `menu` 档固定 28px（与输入区底栏同一行高），不受此值影响。
   */
  size?: ControlSize;
  className?: string;
  ariaLabel?: string;
  title?: string;
  id?: string;
  /** 端到端测试用的定位锚点（挂到触发器上）。 */
  testId?: string;
  /**
   * 外观档位：
   * - `field`（默认）表单字段：与 Input 同一套边框 / 高度 / 字号。
   * - `menu` 轻量入口（页面顶栏的服务器 / 环境之类）：无边框透明底，
   *   与输入区「模型 / 思考强度」按钮完全一致。
   */
  variant?: "field" | "menu";
  /**
   * 仅图标触发器（`menu` 档专用）。
   *
   * 顶栏这种"一行要放好几个入口"的位置，名字留给面板和 `title`，触发器本身
   * 只占 28px、跟 `ToolbarIcon` 同一尺寸；`field` 档忽略此值。
   */
  iconOnly?: boolean;
  /**
   * 触发器语气。`warning` = 当前值需要提醒（例如超能模式的「完全权限」），
   * 只在 `menu` 档生效；`field` 档由 `invalid` 表达。
   */
  tone?: "default" | "warning";
  /**
   * 面板最小宽度（默认 180）。选项带说明文字时（`hint`）调大，
   * 否则说明会被 `truncate` 切掉。
   */
  menuMinWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** 跟随光标（键盘 / 鼠标）移动的高亮块，见下方 `useLayoutEffect`。 */
  const glowRef = useRef<HTMLSpanElement | null>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const lastOpen = useRef(false);
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
    const maxHeight = Math.max(96, Math.min(288, dropUp ? spaceAbove : spaceBelow));
    const width = Math.min(
      Math.max(rect.width, menuMinWidth),
      Math.max(menuMinWidth, window.innerWidth - rect.left - 8),
    );
    return {
      left: Math.min(rect.left, window.innerWidth - width - 8),
      width,
      maxHeight,
      dropUp,
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

  /**
   * 光晕：**整块移动**，不是逐行切换底色（Prompt Bar 的做法）。
   *
   * 首次打开时先关掉过渡，否则会从面板顶部"飞"到选中行。
   */
  useLayoutEffect(() => {
    const glow = glowRef.current;
    if (!glow || !open) return;
    const row = rowRefs.current[activeIndex];
    if (!row) {
      glow.style.opacity = "0";
      return;
    }
    const fresh = !lastOpen.current;
    lastOpen.current = true;
    if (fresh) glow.style.transition = "none";
    glow.style.top = `${row.offsetTop}px`;
    glow.style.height = `${row.offsetHeight}px`;
    glow.style.opacity = "1";
    if (fresh) {
      void glow.offsetHeight;
      glow.style.transition = "";
    }
  }, [open, activeIndex, position, options.length]);

  useEffect(() => {
    if (!open) lastOpen.current = false;
  }, [open]);

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
      tabIndex={-1}
      className="select-menu fixed overflow-y-auto rounded-[12px] p-1 text-fg outline-none"
      style={{
        left: position.left,
        width: position.width,
        maxHeight: position.maxHeight,
        top: position.top,
        bottom: position.bottom,
        // 高于所在弹窗（含嵌套），低于右键菜单与 tooltip。
        zIndex: OVERLAY_Z.select + Math.min(layer.depth, 8) * 2,
        background: "rgb(var(--surface-2))",
        boxShadow: "0 10px 30px -10px rgb(0 0 0 / 0.35), 0 1px 2px rgb(0 0 0 / 0.08)",
        transformOrigin: position.dropUp ? "bottom left" : "top left",
        animation: position.dropUp
          ? "select-pop-up 180ms cubic-bezier(0.23, 1, 0.32, 1) both"
          : "select-pop-down 180ms cubic-bezier(0.23, 1, 0.32, 1) both",
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          move(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          move(-1);
        } else if (event.key === "Home") {
          event.preventDefault();
          setActiveIndex(options.findIndex((option) => !option.disabled));
        } else if (event.key === "End") {
          event.preventDefault();
          for (let i = options.length - 1; i >= 0; i -= 1) {
            if (!options[i]?.disabled) {
              setActiveIndex(i);
              break;
            }
          }
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
      <style>{STYLE}</style>
      {/* 高亮光晕：绝对定位在面板内容里，随 activeIndex 平移。 */}
      <span
        ref={glowRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-1 rounded-[8px] bg-fg/8 opacity-0 [transition:top_220ms_cubic-bezier(0.23,1,0.32,1),height_220ms_cubic-bezier(0.23,1,0.32,1),opacity_150ms_ease] motion-reduce:[transition:opacity_150ms_ease]"
      />
      {/* listbox 只包选项，光晕与关键帧留在外层，语义树里不出现装饰元素。 */}
      <div id={listId} role="listbox" aria-label={ariaLabel}>
        {options.length === 0 && (
          <p className="flex h-9 items-center px-2 text-11 text-fg-muted">—</p>
        )}
        {options.map((option, index) => {
          const active = option.value === value;
          return (
            <button
              key={option.value || index}
              ref={(element) => {
                rowRefs.current[index] = element;
              }}
              type="button"
              role="option"
              data-index={index}
              aria-selected={active}
              disabled={option.disabled}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(index)}
              className={cn(
                "relative z-[1] flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-[8px] border-0 bg-transparent px-2 py-1.5 text-left text-inherit outline-none [font:inherit] [-webkit-tap-highlight-color:transparent]",
                option.disabled && "cursor-not-allowed opacity-40",
              )}
            >
              {option.icon && <span className="flex shrink-0 items-center">{option.icon}</span>}
              <span className="min-w-0 flex-1 truncate text-12 font-medium">{option.label}</span>
              {option.hint && (
                <span className="max-w-[150px] shrink-0 truncate text-10 text-fg-subtle">
                  {option.hint}
                </span>
              )}
              <span
                className={cn(
                  "inline-flex w-4 shrink-0 justify-center transition-opacity duration-150",
                  active ? "opacity-100" : "opacity-0",
                )}
              >
                <Check size={13} strokeWidth={2.5} aria-hidden="true" />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div ref={rootRef} className={cn("relative min-w-0", className)}>
      <Tooltip
        label={iconOnly ? (title ?? selected?.label ?? ariaLabel ?? "") : undefined}
      >
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
        className={cn(
          variant === "menu"
            ? cn(
                // Prompt Bar 的模型按钮：无边框、透明底，hover / 打开只上一层淡底。
                "flex h-7 min-w-0 items-center rounded-[8px] text-11 font-medium transition-colors",
                iconOnly ? "w-7 shrink-0 justify-center px-0" : "w-full justify-between gap-1 px-2",
                tone === "warning"
                  ? cn(
                      "text-[rgb(var(--warning))] ring-1 ring-inset ring-warning/35",
                      open ? "bg-warning/12" : "hover:bg-warning/12",
                    )
                  : cn(
                      open ? "bg-fg/8 text-fg" : "text-fg-muted hover:bg-fg/8 hover:text-fg",
                    ),
                disabled && "cursor-not-allowed opacity-50",
              )
            : cn(
                // 触发器与 Input 同一份基类：高度、边框、圆角、焦点、禁用完全一致。
                controlBase,
                CONTROL_HEIGHT[size],
                CONTROL_TEXT[size],
                "flex w-full items-center justify-between gap-1 px-2 text-left",
                open
                  ? "border-accent/60 hover:border-accent/60"
                  : invalid
                    ? "border-danger/70"
                    : "border-line",
                disabled && "cursor-not-allowed",
              ),
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
        {iconOnly ? (
          // 只留图标：当前值靠图标 + `title` 说明，面板里仍是完整文字。
          <span className="flex shrink-0 items-center justify-center">
            {selected?.icon ?? (
              <ChevronDown size={variant === "menu" ? 11 : size === "sm" ? 11 : 12} className="text-fg-subtle" />
            )}
          </span>
        ) : (
          <>
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              {selected?.icon}
              <span className={cn("min-w-0 truncate", selected ? "text-fg" : "text-fg-subtle")}>
                {selected?.label ?? placeholder ?? ""}
              </span>
            </span>
            <ChevronDown
              size={variant === "menu" ? 11 : size === "sm" ? 11 : 12}
              className="shrink-0 text-fg-subtle"
            />
          </>
        )}
      </button>
      </Tooltip>

      {menu ? createPortal(menu, document.body) : null}
    </div>
  );
}
