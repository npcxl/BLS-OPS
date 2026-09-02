import { memo, type MouseEvent as ReactMouseEvent } from "react";
import { CornerDownLeft } from "lucide-react";
import type { RemoteFileEntry } from "@/api/ops-api";
import { cn } from "@/lib/cn";
import { formatSize, formatTime } from "@/lib/format";
import { useDirSizeStore } from "@/stores/dir-size-store";
import { EntryIcon } from "./EntryIcon";
import { dirSizeSummary } from "./utils";

/**
 * One row of the listing. Memoised because the list can hold thousands of
 * entries: hovering, selecting and right-clicking must not re-render all of
 * them. Every callback it receives is stable.
 */
export const FileRow = memo(function FileRow({
  sessionId,
  entry,
  selected,
  onSelect,
  onOpen,
  onContextMenu,
}: {
  sessionId: string;
  entry: RemoteFileEntry;
  selected: boolean;
  onSelect: (entry: RemoteFileEntry) => void;
  onOpen: (entry: RemoteFileEntry) => void;
  onContextMenu: (event: ReactMouseEvent, entry: RemoteFileEntry) => void;
}) {
  // Subscribe only to this directory's size result: a size event for another
  // path must not re-render this row.
  const dirSize = useDirSizeStore((state) =>
    entry.kind === "directory" ? state.get(sessionId, entry.path) : undefined,
  );

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
