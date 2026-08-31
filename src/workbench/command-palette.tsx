import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Search } from "lucide-react";
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

export function CommandPalette({ open, actions, onClose }: CommandPaletteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

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
        e.preventDefault();
        filtered[activeIndex]?.onSelect();
        onClose();
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
    <div className="overlay-scrim fixed inset-0 z-[120] flex items-start justify-center bg-black/20 px-4 pt-[12vh]" onMouseDown={onClose}>
      <div
        className="overlay-enter glass-panel-strong w-full max-w-[720px] overflow-hidden rounded-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-12 items-center gap-2 border-b border-line/80 px-3">
          <Search size={14} className="text-fg-subtle" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索操作、服务器、任务…"
            className="h-full flex-1 bg-transparent text-13 text-fg outline-none placeholder:text-fg-subtle"
          />
          <span className="rounded-[7px] border border-line bg-surface-2 px-2 py-1 text-11 text-fg-muted shadow-[inset_0_1px_0_rgb(255_255_255/0.45)]">Ctrl+K</span>
        </div>

        <div className="max-h-[420px] overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <div className="px-3 py-8 text-center text-12 text-fg-muted">未找到匹配的命令。</div>
          ) : (
            filtered.map((action, index) => (
              <button
                key={action.id}
                type="button"
                className={cn(
                  "flex w-full items-center gap-3 rounded-[7px] px-3 py-2 text-left transition-colors",
                  index === activeIndex
                    ? "bg-accent/10 text-fg"
                    : "hover:bg-surface-hover/70",
                )}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => {
                  action.onSelect();
                  onClose();
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
