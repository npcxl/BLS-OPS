/**
 * 可输入下拉（combobox）：文本输入框 + 候选列表。
 *
 * 为什么不直接用 `Select`：字段类型这种格子既要能从列表里选（varchar / int /
 * datetime …），也要允许手写列表里没有的写法（`enum('a','b')`、
 * `int unsigned`、`decimal(12,4)`），所以输入框必须始终可编辑。
 *
 * 面板同样走 portal + fixed：结构表外层有 `overflow-x-auto`，绝对定位会被
 * 裁掉，只有 fixed 才能完整显示。
 *
 * 交互对齐 Navicat 的类型下拉：
 * - 点输入框或右侧箭头 → 展开完整列表；
 * - 打字 → 按输入内容过滤，列表里没有匹配也照常可以提交手写值；
 * - ↑↓ 移动、Enter 选中高亮项（无匹配时只关闭，保留手写值）；
 * - Esc / 点击外部 / 滚动 / 窗口 resize 关闭。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "@/components/icons";
import { cn } from "@/lib/cn";

export interface ComboOption {
  value: string;
  label: string;
  /** 右侧浅色补充信息（例如默认长度 `255`）。 */
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

export function ComboInput({
  value,
  options,
  onChange,
  onPick,
  placeholder,
  disabled = false,
  className,
  inputClassName,
  ariaLabel,
}: {
  value: string;
  options: ComboOption[];
  /** 手写输入：每次按键都回传，父组件直接落库即可。 */
  onChange: (value: string) => void;
  /** 从列表选中；不传则退化成 `onChange(option.value)`。 */
  onPick?: (option: ComboOption) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const keyword = filter.trim().toLowerCase();
  const visible = keyword
    ? options.filter((option) => option.label.toLowerCase().includes(keyword))
    : options;
  const activeOptionsIndex = Math.min(activeIndex, Math.max(visible.length - 1, 0));

  const computePosition = () => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const gap = 4;
    const spaceBelow = window.innerHeight - rect.bottom - gap - 8;
    const spaceAbove = rect.top - gap - 8;
    const dropUp = spaceBelow < 160 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(96, Math.min(240, dropUp ? spaceAbove : spaceBelow));
    const width = Math.min(
      Math.max(rect.width, 168),
      Math.max(168, window.innerWidth - rect.left - 8),
    );
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
    // 外部滚动 → 重新定位；面板自身的滚动要忽略，否则一滚列表就关。
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
    if (!open || !position) return;
    const element = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeOptionsIndex}"]`);
    element?.scrollIntoView({ block: "nearest" });
  }, [activeOptionsIndex, open, position]);

  const openMenu = (nextFilter: string) => {
    if (disabled) return;
    setFilter(nextFilter);
    const index = options.findIndex(
      (option) => option.label.toLowerCase() === nextFilter.trim().toLowerCase(),
    );
    setActiveIndex(index >= 0 ? index : 0);
    setOpen(true);
  };

  const choose = (index: number) => {
    const option = visible[index];
    if (!option) return;
    if (onPick) onPick(option);
    else onChange(option.value);
    setOpen(false);
    inputRef.current?.focus();
  };

  const move = (delta: number) => {
    if (visible.length === 0) return;
    setActiveIndex((current) => (current + delta + visible.length) % visible.length);
  };

  const menu = open && position && (
    <div
      ref={listRef}
      role="listbox"
      aria-label={ariaLabel}
      className="select-menu fixed z-[120] min-w-[168px] overflow-y-auto rounded-[8px] border border-line bg-surface-2 p-1 shadow-xl shadow-black/40 outline-none animate-[ops-pop_120ms_ease-out]"
      style={{
        left: position.left,
        width: position.width,
        maxHeight: position.maxHeight,
        top: position.top,
        bottom: position.bottom,
      }}
      // 面板内的按键交给输入框处理：焦点始终留在输入框，用户接着打字不会丢。
      onMouseDown={(event) => event.preventDefault()}
    >
      {visible.length === 0 && (
        <p className="px-2 py-1.5 text-11 text-fg-subtle">—</p>
      )}
      {visible.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="option"
          data-index={index}
          aria-selected={option.value === value}
          className={cn(
            "flex w-full items-center gap-2 rounded-[5px] px-2 py-[6px] text-left font-mono text-12 transition-colors",
            option.value === value ? "text-accent" : "text-fg",
            index === activeOptionsIndex ? "bg-surface-hover" : null,
          )}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => choose(index)}
        >
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
          {option.hint && (
            <span className="shrink-0 text-10 text-fg-subtle">{option.hint}</span>
          )}
          {option.value === value && <Check size={11} className="shrink-0 text-accent" />}
        </button>
      ))}
    </div>
  );

  return (
    <div ref={rootRef} className={cn("relative min-w-0", className)}>
      <input
        ref={inputRef}
        className={cn(
          "w-full rounded border border-line bg-surface-2 py-0.5 pl-1 pr-5 font-mono text-12 text-fg outline-none focus:border-accent",
          inputClassName,
        )}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        disabled={disabled}
        placeholder={placeholder}
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next);
          setFilter(next);
          setActiveIndex(0);
          setOpen(true);
        }}
        onClick={() => {
          if (!open) openMenu("");
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            if (open) move(1);
            else openMenu("");
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            if (open) move(-1);
            else openMenu("");
          } else if (event.key === "Enter") {
            if (!open) return;
            event.preventDefault();
            if (visible.length > 0) choose(activeOptionsIndex);
            else setOpen(false);
          } else if (event.key === "Escape") {
            if (!open) return;
            event.preventDefault();
            setOpen(false);
          } else if (event.key === "Tab") {
            setOpen(false);
          }
        }}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={ariaLabel}
        disabled={disabled}
        className="absolute inset-y-0 right-0 flex w-4 items-center justify-center text-fg-subtle hover:text-fg disabled:opacity-50"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (open) setOpen(false);
          else openMenu("");
          inputRef.current?.focus();
        }}
      >
        <ChevronDown
          size={10}
          className={cn("transition-transform duration-150", open && "rotate-180")}
        />
      </button>

      {menu ? createPortal(menu, document.body) : null}
    </div>
  );
}
