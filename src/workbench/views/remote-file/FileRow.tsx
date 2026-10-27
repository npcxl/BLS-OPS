import { memo, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { CornerDownLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { RemoteFileEntry } from "@/api/ops-api";
import { cn } from "@/lib/cn";
import { formatSize, formatTime } from "@/lib/format";
import { useDirSizeStore } from "@/stores/dir-size-store";
import { EntryIcon } from "./EntryIcon";
import { dirSizeSummary } from "./utils";

/**
 * 就地重命名（像资源管理器那样在行内改名，而不是弹窗）。
 *
 * 单独成组件的原因：它的 `draft` 必须在**进入编辑那一刻**用当前文件名初始化，
 * 而 `FileRow` 是一直挂着的 —— 在 `FileRow` 里 `useState(initial)` 只会拿到
 * 首次挂载时的空值。组件只在编辑态挂载，state 初始化时机自然正确。
 */
function RenameRow({
  entry,
  initial,
  onSubmit,
  onCancel,
}: {
  entry: RemoteFileEntry;
  initial: string;
  onSubmit: (entry: RemoteFileEntry, name: string) => boolean;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // 与资源管理器一致：选中主干，扩展名留在选区外，直接输入就是改文件名。
    const dot = initial.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  const commit = () => {
    if (!onSubmit(entry, draft)) {
      // 名字不合法：留在编辑态，重新聚焦继续改（父层会给出原因）。
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  };

  return (
    <div className="flex w-full items-center gap-2 bg-accent/15 px-3 py-1.5">
      <EntryIcon entry={entry} />
      <input
        ref={inputRef}
        value={draft}
        aria-label={t("Rename")}
        className="h-[22px] min-w-0 flex-1 rounded-[4px] border border-accent bg-surface-1 px-1 text-12 text-fg outline-none"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        onBlur={commit}
      />
    </div>
  );
}

/**
 * One row of the listing. Memoised because the list can hold thousands of
 * entries: hovering, selecting and right-clicking must not re-render all of
 * them. Every callback it receives is stable.
 */
export const FileRow = memo(function FileRow({
  sessionId,
  entry,
  selected,
  renaming = false,
  renameInitial = "",
  onRenameSubmit,
  onRenameCancel,
  onSelect,
  onOpen,
  onContextMenu,
}: {
  sessionId: string;
  entry: RemoteFileEntry;
  selected: boolean;
  /** 该行是否处于就地重命名状态。 */
  renaming?: boolean;
  /** 进入编辑时的文件名（只在 renaming 时读）。 */
  renameInitial?: string;
  /** 返回 false 表示名字不合法，行内保持编辑态。 */
  onRenameSubmit?: (entry: RemoteFileEntry, name: string) => boolean;
  onRenameCancel?: () => void;
  onSelect: (entry: RemoteFileEntry) => void;
  onOpen: (entry: RemoteFileEntry) => void;
  onContextMenu: (event: ReactMouseEvent, entry: RemoteFileEntry) => void;
}) {
  // Subscribe only to this directory's size result: a size event for another
  // path must not re-render this row.
  const dirSize = useDirSizeStore((state) =>
    entry.kind === "directory" ? state.get(sessionId, entry.path) : undefined,
  );

  if (renaming && onRenameSubmit && onRenameCancel) {
    return (
      <RenameRow
        entry={entry}
        initial={renameInitial || entry.name}
        onSubmit={onRenameSubmit}
        onCancel={onRenameCancel}
      />
    );
  }

  return (
    <button
      type="button"
      data-kind={entry.kind}
      className={cn(
        "group flex w-full items-center gap-2 px-3 py-1.5 text-left",
        selected ? "bg-accent/15" : "hover:bg-surface-hover/70",
      )}
      onClick={() => onSelect(entry)}
      onDoubleClick={() => onOpen(entry)}
      onContextMenu={(event) => onContextMenu(event, entry)}
    >
      <EntryIcon entry={entry} />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-12",
            entry.kind === "directory" ? "text-fg" : "text-fg-muted",
          )}
          title={entry.path}
        >
          {entry.name}
          {entry.kind === "symlink" && <span className="ml-1 text-fg-subtle">→</span>}
        </span>
        <span className="block truncate text-10 text-fg-subtle">
          {entry.kind === "directory"
            ? dirSizeSummary(dirSize)
            : `${formatSize(entry.size)} · ${formatTime(entry.modified_at)}`}
        </span>
      </span>
      {entry.kind === "directory" && (
        <CornerDownLeft
          size={11}
          className="shrink-0 text-fg-subtle opacity-0 group-hover:opacity-100"
        />
      )}
    </button>
  );
});
