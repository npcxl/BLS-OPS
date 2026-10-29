import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ArrowRight, Search } from "@/components/icons";
import { cn } from "@/lib/cn";

export interface PaletteAction {
  id: string;
  title: string;
  category: string;
  description?: string;
  shortcut?: string;
  keywords?: string[];
  danger?: boolean;
  onSelect: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  actions: PaletteAction[];
  onClose: () => void;
}

/**
 * 执行一个面板动作。动作自己负责把失败展示给用户（多数是异步 + 内部提示），
 * 这里只兜住同步异常：不能让一次抛错把整个面板的键盘交互带崩。
 */
function runAction(action: PaletteAction): void {
  try {
    action.onSelect();
  } catch (error) {
    console.error("[palette] action failed", error);
  }
}

export function CommandPalette({ open, actions, onClose }: CommandPaletteProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const activeItemRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // ↑↓ 移动到列表可视范围之外时，把当前项滚进视野（滚到顶/底不再"看不见"）。
  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const scored = actions
      .map((action) => {
        if (!q) return { action, score: 0 };
        const text = [action.title, action.category, action.description ?? "", ...(action.keywords ?? [])]
          .join(" ")
          .toLowerCase();
        const hit = text.includes(q);
        const score = hit ? (text.startsWith(q) ? 0 : 1) : 999;
        return { action, score };
      })
      .filter((entry) => entry.score < 999)
      .sort((a, b) => a.score - b.score || a.action.title.localeCompare(b.action.title));
    return scored.map((entry) => entry.action);
  }, [actions, query]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // 输入法组合中的回车是"确认候选词"，不能当成执行命令。
      if (e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      }
      if (e.key === "Enter") {
        // 焦点落在列表项按钮上：交给按钮自己的 click。否则 button 的默认
        // 激活与本处理器会各跑一次，动作被触发两遍。
        if (e.target instanceof HTMLElement && e.target.closest("[data-palette-item]")) return;
        e.preventDefault();
        const action = filtered[activeIndex];
        if (!action) return;
        // 先关再执行：动作可能打开新标签或弹窗，面板留着会挡住结果；也避免
        // 动作同步抛错时把面板永久卡在"按了回车但没反应"的状态。
        onClose();
        runAction(action);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIndex, filtered, onClose, open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  if (!open) return null;

  return createPortal(
    // 高度预算全部相对视口（calc），不依赖 flex padding 的百分比解析：
    // 顶距 12vh + 面板 ≤ calc(88vh-1rem) + 底距 1rem = 100vh，永远装得下。
    // 列表 flex-1 内部滚动，高度跟随窗口自适应（固定 420px 会在矮窗口被裁）。
    <div
      className="overlay-scrim fixed inset-0 z-[120] flex items-start justify-center bg-black/20 px-4 pt-[12vh]"
      onMouseDown={onClose}
    >
      <div
        className="overlay-enter glass-panel-strong flex max-h-[calc(88vh-1rem)] w-full max-w-[720px] flex-col overflow-hidden rounded-2xl bg-surface-1"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
          <Search size={14} className="text-fg-subtle" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("Search actions, servers, tasks…")}
            className="h-full flex-1 bg-transparent text-13 text-fg outline-none placeholder:text-fg-subtle"
          />
          <span className="rounded-[7px] border border-line bg-surface-2 px-2 py-1 text-11 text-fg-muted shadow-[inset_0_1px_0_rgb(255_255_255/0.45)]">Ctrl+K</span>
        </div>

        {/* 列表占满面板剩余高度并内部滚动；↑↓ 导航时当前项自动滚入视野。 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <div className="px-3 py-8 text-center text-12 text-fg-muted">{t("No matching commands.")}</div>
          ) : (
            filtered.map((action, index) => (
              <button
                key={action.id}
                type="button"
                data-palette-item="true"
                ref={index === activeIndex ? activeItemRef : undefined}
                className={cn(
                  "flex w-full items-center gap-3 rounded-[7px] px-3 py-2 text-left transition-colors",
                  index === activeIndex
                    ? "bg-accent/10 text-fg"
                    : "hover:bg-surface-hover/70",
                )}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => {
                  onClose();
                  runAction(action);
                }}
              >
                <div className="min-w-0 flex-1">
                  <div className={cn("text-13", action.danger ? "text-danger" : "text-fg")}>{action.title}</div>
                  <div className="truncate text-11 text-fg-subtle">
                    {action.category}
                    {action.description ? ` · ${action.description}` : ""}
                  </div>
                </div>
                {action.shortcut ? (
                  <span className="shrink-0 rounded-control border border-line bg-surface-1 px-2 py-1 text-11 text-fg-muted">
                    {action.shortcut}
                  </span>
                ) : (
                  <ArrowRight size={14} className="shrink-0 text-fg-subtle" />
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
