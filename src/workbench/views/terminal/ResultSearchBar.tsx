import { Search, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";

/**
 * 结果面板搜索栏 —— 搜索的是**当前结果的内容**（终端输出快照 / JSON /
 * 原始流），命中处高亮显示，而不是终端回滚缓冲（那是 xterm 的事）。
 *
 * 就地替换原终端工具栏的 scrollback 搜索：同一个入口位置（抽屉工具条右侧），
 * 但作用域明确落在"你正在看的结果"上。Esc 关闭并清空。
 */
export function ResultSearchBar({
  value,
  hits,
  onChange,
  onClose,
}: {
  value: string;
  /** 当前结果里的命中总数；`null` = 未搜索（空查询）。 */
  hits: number | null;
  onChange: (value: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="ml-1 flex shrink-0 items-center gap-1" data-testid="result-search-bar">
      <span className="relative flex items-center">
        <Search size={11} className="pointer-events-none absolute left-1.5 text-fg-subtle" />
        <input
          autoFocus
          value={value}
          data-testid="result-search-input"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
          }}
          placeholder={t("Search in result")}
          spellCheck={false}
          className="h-[24px] w-44 rounded-[6px] border border-line bg-surface-2 pl-6 pr-2 text-11 text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
        />
      </span>
      {hits !== null && (
        <span
          data-testid="result-search-count"
          className={cn("shrink-0 text-10 tabular-nums", hits === 0 ? "text-fg-subtle" : "text-fg-muted")}
        >
          {hits === 0 ? t("No matches") : t("{{count}} matches", { count: hits })}
        </span>
      )}
      <button
        type="button"
        onClick={onClose}
        aria-label={t("Close search")}
        className="flex shrink-0 items-center rounded-[5px] p-0.5 text-fg-subtle hover:bg-surface-hover hover:text-fg"
      >
        <X size={11} />
      </button>
    </div>
  );
}
