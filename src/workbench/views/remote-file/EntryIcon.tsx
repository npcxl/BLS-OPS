import type { RemoteFileEntry } from "@/api/ops-api";
import { Icon } from "@iconify/react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  const kind = fileKind(entry);
  // kind.label 是英文 key（file-kind.ts 模块常量），tooltip 渲染处统一 t()。
  return (
    <span title={t(kind.label)} className="shrink-0">
      <Icon icon={FILE_ICONS[kind.iconKey]} width={14} height={14} aria-hidden />
    </span>
  );
}
