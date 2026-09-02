import { useMemo, useState } from "react";
import { FileArchive, Folder, Search } from "lucide-react";
import { formatSize } from "@/lib/format";
import type { ArchiveEntry, ArchiveFormat } from "@/lib/preview/archive";

/**
 * Archive contents, listed from the file's own index — nothing is extracted.
 *
 * Entries are sorted directories-first so the shape of the archive is visible
 * without expanding anything, and the filter matches on the full member path.
 */
export function ArchivePreview({
  entries,
  format,
  totalSize,
}: {
  entries: ArchiveEntry[];
  format: ArchiveFormat;
  totalSize: number;
}) {
  const [filter, setFilter] = useState("");

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matched = needle ? entries.filter((entry) => entry.name.toLowerCase().includes(needle)) : entries;
    return [...matched].sort((a, b) => {
      if (a.directory !== b.directory) return a.directory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [entries, filter]);

  const directories = entries.filter((entry) => entry.directory).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2">
        <FileArchive size={13} className="shrink-0 text-amber-400" />
        <span className="shrink-0 text-11 text-fg-muted">
          {format.toUpperCase()} · {entries.length.toLocaleString()} 个条目
          {directories > 0 && ` （${directories.toLocaleString()} 个文件夹）`}
        </span>
        <div className="ml-auto flex items-center gap-1 rounded-[6px] border border-line px-1.5">
          <Search size={11} className="text-fg-subtle" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="过滤路径…"
            className="h-6 w-[180px] bg-transparent text-11 text-fg outline-none placeholder:text-fg-subtle"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-11">
          <thead className="sticky top-0 bg-surface-2">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium text-fg-subtle">路径</th>
              <th className="w-24 px-3 py-1.5 text-right font-medium text-fg-subtle">大小</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((entry, index) => (
              <tr key={`${entry.name}-${index}`} className="hover:bg-surface-hover/50">
                <td className="max-w-0 truncate px-3 py-1">
                  <span className="flex items-center gap-1.5">
                    {entry.directory ? (
                      <Folder size={11} className="shrink-0 text-sky-400" />
                    ) : null}
                    <span className="truncate text-fg-muted" title={entry.name}>
                      {entry.name}
                    </span>
                  </span>
                </td>
                <td className="px-3 py-1 text-right tabular-nums text-fg-subtle">
                  {entry.directory ? "—" : formatSize(entry.size)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {visible.length === 0 && (
          <p className="px-3 py-4 text-11 text-fg-subtle">没有匹配 “{filter}” 的条目。</p>
        )}
      </div>

      <div className="flex h-6 shrink-0 items-center border-t border-line px-2 text-10 text-fg-subtle">
        解压后约 {formatSize(totalSize)} · 仅列出内容，未解压
      </div>
    </div>
  );
}
