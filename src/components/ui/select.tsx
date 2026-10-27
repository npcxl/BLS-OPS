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
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** 右侧浅色补充信息（例如 `root@host`）。 */
  hint?: string;
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
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
  ariaLabel?: string;
  title?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const generatedId = useId();
  const listId = `select-list-${id ?? generatedId}`;

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
    const onViewportChange = () => setOpen(false);
    window.addEventListener("resize", onViewportChange);
    // capture：Modal/表格内部的滚动也会让 fixed 面板跟不动，直接关闭。
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
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
      className="ops-scroll fixed z-[120] min-w-[160px] overflow-y-auto rounded-[8px] border border-line bg-surface-2 p-1 shadow-xl shadow-black/40 outline-none animate-[ops-pop_120ms_ease-out]"
      style={{
        left: position.left,
        width: position.width,
        maxHeight: position.maxHeight,
        top: position.top,
        bottom: position.bottom,
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
      {options.length === 0 && <p className="px-2 py-1.5 text-[10px] text-fg-subtle">—</p>}
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
              "flex w-full items-center gap-2 rounded-[5px] px-2 py-[5px] text-left text-11 transition-colors",
              active ? "bg-accent/10 text-accent" : "text-fg",
              !option.disabled && "hover:bg-surface-hover",
              option.disabled && "cursor-not-allowed opacity-40",
              activeIndex === index && !option.disabled && "bg-surface-hover",
            )}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => choose(index)}
          >
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {option.hint && (
              <span className="max-w-[150px] shrink-0 truncate text-[9px] text-fg-subtle">
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
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        title={title ?? selected?.label}
        className={cn(
          "flex w-full items-center justify-between gap-1 rounded-[6px] border bg-surface-1 px-2 text-left outline-none transition-colors",
          size === "sm" ? "h-[24px] text-11" : "h-[30px] text-12",
          open
            ? "border-accent/70 ring-1 ring-accent/20"
            : "border-line hover:border-line-strong",
          disabled && "cursor-not-allowed opacity-50",
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
        <span className={cn("min-w-0 flex-1 truncate", selected ? "text-fg" : "text-fg-subtle")}>
          {selected?.label ?? placeholder ?? ""}
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
