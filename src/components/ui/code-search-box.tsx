import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Replace,
  ReplaceAll,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { EditorView } from "@uiw/react-codemirror";
import {
  activeMatchIndex,
  applyQuery,
  buildQuery,
  clearQuery,
  gotoMatch,
  matchRanges,
  replaceMatch,
} from "@/lib/cm-search";

/**
 * VSCode 风格的编辑器内搜索框：右上角浮动，默认只有查找行，点左侧箭头才
 * 展开替换行。只读文档不显示替换（与 VSCode 一致：只读没有替换入口）。
 *
 * 交互与 VSCode 对齐：Enter 下一个、Shift+Enter 上一个、Esc 关闭、
 * Ctrl+H 展开/收起替换、Alt+Enter 全部替换。
 */
export function CodeSearchBox({
  view,
  readOnly = false,
  onClose,
}: {
  view: EditorView | null;
  readOnly?: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [total, setTotal] = useState(0);
  const [index, setIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();

  const searchQuery = useMemo(() => buildQuery(query, caseSensitive), [query, caseSensitive]);

  /** 重算匹配总数与当前序号。 */
  const refresh = useCallback(() => {
    if (!view) return;
    const ranges = matchRanges(view, searchQuery);
    setTotal(ranges.length);
    setIndex(activeMatchIndex(view, ranges));
  }, [view, searchQuery]);

  // 查询变化 → 写进编辑器并刷新计数。
  useEffect(() => {
    if (!view) return;
    applyQuery(view, searchQuery);
    refresh();
  }, [view, searchQuery, refresh]);

  // 光标移动（逐个跳转、点击文档）后刷新序号：编辑器内没有 React 层，
  // 用 DOM 事件捕获即可，无需订阅 CodeMirror 的 update 流。
  useEffect(() => {
    if (!view) return;
    view.dom.addEventListener("keyup", refresh);
    view.dom.addEventListener("mouseup", refresh);
    return () => {
      view.dom.removeEventListener("keyup", refresh);
      view.dom.removeEventListener("mouseup", refresh);
    };
  }, [view, refresh]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const step = useCallback(
    (backward: boolean) => {
      if (!view || total === 0) return;
      gotoMatch(view, backward);
      refresh();
    },
    [view, total, refresh],
  );

  const replace = useCallback(
    (all: boolean) => {
      if (!view || readOnly || total === 0) return;
      // 替换动作要求查询自带 replace 文本。
      applyQuery(view, buildQuery(query, caseSensitive, replaceText));
      replaceMatch(view, all);
      refresh();
    },
    [view, readOnly, total, query, caseSensitive, replaceText, refresh],
  );

  const close = useCallback(() => {
    if (view) {
      clearQuery(view);
      view.focus();
    }
    onClose();
  }, [view, onClose]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Enter" && !event.altKey) {
      event.preventDefault();
      step(event.shiftKey);
    } else if (event.key === "Enter" && event.altKey) {
      event.preventDefault();
      replace(true);
    } else if (event.key.toLowerCase() === "h" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      setExpanded((current) => !current);
    }
  };

  const counter =
    total === 0 ? (query ? t("No results") : "") : `${(index >= 0 ? index : 0) + 1}/${total}`;

  return (
    <div
      className="absolute right-2 top-2 z-30 w-[320px] overflow-hidden rounded-md border border-line bg-surface-1 shadow-[0_4px_16px_rgb(15_23_42/0.16)]"
      onKeyDown={onKeyDown}
      // 点击面板时不要让编辑器抢走焦点。
      onMouseDown={(event) => event.preventDefault()}
    >
      {/* 第一行：查找 */}
      <div className="flex items-center gap-1 p-1">
        {readOnly ? (
          <span className="h-7 w-7 shrink-0" />
        ) : (
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            title={expanded ? t("Collapse replace") : t("Expand replace (Ctrl+H)")}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg"
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        )}
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("Find")}
          spellCheck={false}
          className={cn(
            "h-7 min-w-0 flex-1 rounded border bg-surface-2 px-2 text-12 text-fg outline-none transition-colors placeholder:text-fg-subtle",
            query && total === 0 ? "border-danger/50" : "border-line focus:border-accent",
          )}
        />
        <button
          type="button"
          onClick={() => setCaseSensitive((current) => !current)}
          title={t("Match case")}
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors",
            caseSensitive
              ? "bg-accent/12 text-accent"
              : "text-fg-subtle hover:bg-surface-hover hover:text-fg",
          )}
        >
          <CaseSensitive size={14} />
        </button>
        {counter && (
          <span
            className={cn(
              "shrink-0 px-1 text-center text-11 tabular-nums",
              total === 0 ? "text-fg-subtle" : "text-fg-muted",
            )}
          >
            {counter}
          </span>
        )}
        <button
          type="button"
          onClick={() => step(true)}
          title={t("Previous (Shift+Enter)")}
          disabled={total === 0}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg disabled:opacity-40"
        >
          <ChevronUp size={14} />
        </button>
        <button
          type="button"
          onClick={() => step(false)}
          title={t("Next (Enter)")}
          disabled={total === 0}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg disabled:opacity-40"
        >
          <ChevronDown size={14} />
        </button>
        <button
          type="button"
          onClick={close}
          title={t("Close (Esc)")}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>

      {/* 第二行：替换（仅展开且可编辑时） */}
      {expanded && !readOnly && (
        <div className="flex items-center gap-1 px-1 pb-1">
          <span className="h-7 w-7 shrink-0" />
          <input
            value={replaceText}
            onChange={(event) => setReplaceText(event.target.value)}
            placeholder={t("Replace")}
            spellCheck={false}
            className="h-7 min-w-0 flex-1 rounded border border-line bg-surface-2 px-2 text-12 text-fg outline-none transition-colors placeholder:text-fg-subtle focus:border-accent"
          />
          <button
            type="button"
            onClick={() => replace(false)}
            title={t("Replace (Enter replaces the current match)")}
            disabled={total === 0}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg disabled:opacity-40"
          >
            <Replace size={14} />
          </button>
          <button
            type="button"
            onClick={() => replace(true)}
            title={t("Replace all (Alt+Enter)")}
            disabled={total === 0}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg disabled:opacity-40"
          >
            <ReplaceAll size={14} />
          </button>
          <span className="w-7 shrink-0" />
        </div>
      )}
    </div>
  );
}
