import type { RemoteFileEntry } from "@/api/ops-api";
import { fileKind } from "@/lib/file-kind";

export function EntryIcon({ entry }: { entry: RemoteFileEntry }) {
  if (entry.kind === "directory") {
    return <FolderGlyph />;
  }
  const kind = fileKind(entry.name);
  const Icon = kind.icon;
  return (
    <span title={kind.label} className="shrink-0">
      <Icon size={14} strokeWidth={1.75} className={kind.color} />
    </span>
  );
}

function FolderGlyph() {
  // Colored like the editor icons but distinctly folder-shaped.
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[14px] w-[14px] shrink-0 text-sky-400"
      aria-hidden
    >
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}
