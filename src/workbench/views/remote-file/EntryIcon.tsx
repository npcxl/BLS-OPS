import type { RemoteFileEntry } from "@/api/ops-api";
import { Icon } from "@iconify/react";
import { fileKind } from "@/lib/file-kind";
import { FILE_ICONS } from "@/lib/icons/vscode-file-icons";

/**
 * Row icon for a listing entry.
 *
 * `fileKind` only decides *which* icon (a stable key); the glyph itself comes
 * from the bundled vscode-icons set, rendered fully offline by
 * @iconify/react — no API requests, so icons are identical on an offline or
 * air-gapped server.
 */
export function EntryIcon({ entry }: { entry: RemoteFileEntry }) {
  const kind = fileKind(entry);
  return (
    <span title={kind.label} className="shrink-0">
      <Icon icon={FILE_ICONS[kind.iconKey]} width={14} height={14} aria-hidden />
    </span>
  );
}
