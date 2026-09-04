import { useState } from "react";
import { Check, ChevronRight, Pencil, Trash2, X } from "lucide-react";
import type { ServerRecord } from "@/api/types/servers";
import { cn } from "@/lib/cn";
import type { ServerGroupSection } from "./sections";

export interface ServerGroupSectionProps {
  section: ServerGroupSection;
  folded: boolean;
  renaming: boolean;
  onToggleFold: () => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onDelete: () => void;
  /** Rows are rendered by the parent so favorites/group bodies stay identical. */
  renderRow: (server: ServerRecord) => React.ReactNode;
}

/**
 * One collapsible section: header (with inline rename/delete) plus its rows.
 *
 * The empty state is rendered on purpose — a group with no servers must still
 * be visible, otherwise creating a group looks like it did nothing.
 */
export function ServerGroupSectionView({
  section,
  folded,
  renaming,
  onToggleFold,
  onStartRename,
  onRename,
  onCancelRename,
  onDelete,
  renderRow,
}: ServerGroupSectionProps) {
  return (
    <div data-testid={`group-section-${section.id}`}>
      {renaming ? (
        <GroupRenameInput
          label={section.name}
          onCommit={onRename}
          onCancel={onCancelRename}
        />
      ) : (
        <div className="group/g flex w-full items-center px-2.5 py-1 text-11 font-medium text-fg-subtle hover:text-fg">
          <button
            type="button"
            data-testid={`group-toggle-${section.id}`}
            className="flex min-w-0 flex-1 items-center gap-1 text-left"
            onClick={onToggleFold}
          >
            <ChevronRight
              size={11}
              aria-hidden="true"
              className={cn("shrink-0 transition-transform", !folded && "rotate-90")}
            />
            <span className="min-w-0 flex-1 truncate">{section.name}</span>
            <span data-testid={`group-count-${section.id}`} className="shrink-0">
              {section.servers.length}
            </span>
          </button>
          {section.group && (
            <span className="flex shrink-0 items-center opacity-0 group-hover/g:opacity-100">
              <button
                type="button"
                aria-label={`重命名分组 ${section.name}`}
                className="rounded p-1 hover:text-fg"
                onClick={onStartRename}
              >
                <Pencil size={11} />
              </button>
              <button
                type="button"
                aria-label={`删除分组 ${section.name}`}
                className="rounded p-1 hover:text-danger"
                onClick={onDelete}
              >
                <Trash2 size={11} />
              </button>
            </span>
          )}
        </div>
      )}

      {!folded &&
        (section.servers.length === 0 ? (
          <p className="px-2.5 py-1 text-11 text-fg-subtle">暂无服务器</p>
        ) : (
          section.servers.map((server) => (
            <div key={server.id}>{renderRow(server)}</div>
          ))
        ))}
    </div>
  );
}

/** Inline group rename: Enter saves, Escape cancels, plus explicit buttons. */
function GroupRenameInput({
  label,
  onCommit,
  onCancel,
}: {
  label: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(label);

  const commit = () => {
    const next = value.trim();
    if (next && next !== label) onCommit(next);
    else onCancel();
  };

  return (
    <div className="flex items-center gap-1 px-2.5 py-1">
      <input
        autoFocus
        aria-label={`分组名称 ${label}`}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") onCancel();
        }}
        className="h-[22px] min-w-0 flex-1 rounded-[5px] border border-accent bg-surface-2 px-1.5 text-11 text-fg outline-none"
      />
      <button
        type="button"
        aria-label="保存分组名称"
        className="rounded p-1 text-fg-subtle hover:text-success"
        onClick={commit}
      >
        <Check size={12} />
      </button>
      <button
        type="button"
        aria-label="取消重命名"
        className="rounded p-1 text-fg-subtle hover:text-fg"
        onClick={onCancel}
      >
        <X size={12} />
      </button>
    </div>
  );
}
