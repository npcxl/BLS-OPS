import { cn } from "@/lib/cn";
import { useTranslation } from "react-i18next";
import { COPYABLE, CopyNotice, clickCopyProps, useCopyFeedback } from "@/components/ui/copy-feedback";
import type { ResultSection } from "../model";

/**
 * 通用属性面板 —— `systemctl show` / `docker info` / `sysctl -a` / `ulimit`
 * 共用。行契约：`{key, value}`；分块用 sections（`[Section]` 标题）。
 *
 * 点击值 → 复制该值（键不可点，避免和"复制键名"混淆）。
 */
export function KeyValueView({
  rows,
  sections,
}: {
  rows: Record<string, unknown>[];
  sections?: ResultSection[];
}) {
  const { status, copy } = useCopyFeedback();

  if (sections && sections.length > 0) {
    return (
      <div className="relative min-h-0 flex-1 overflow-auto">
        {sections.map((section) => (
          <section key={section.title}>
            <h4 className="sticky top-0 z-10 bg-surface-2/90 px-3 py-1 text-10 font-semibold tracking-[0.06em] text-fg-subtle uppercase backdrop-blur">
              {section.title}
            </h4>
            <Rows rows={section.rows} onCopy={copy} />
          </section>
        ))}
        <CopyNotice status={status} />
      </div>
    );
  }
  return (
    <div className="relative min-h-0 flex-1 overflow-auto">
      <Rows rows={rows} onCopy={copy} />
      <CopyNotice status={status} />
    </div>
  );
}

function Rows({
  rows,
  onCopy,
}: {
  rows: Record<string, unknown>[];
  onCopy: (text: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  if (rows.length === 0) {
    return <p className="px-3 py-6 text-center text-11 text-fg-subtle">{t("No properties.")}</p>;
  }
  return (
    <dl className="divide-y divide-line/40">
      {rows.map((row, index) => {
        const text = String(row.value ?? "");
        return (
          <div
            key={`${String(row.key ?? index)}-${index}`}
            className="flex gap-3 px-3 py-1.5 transition-colors hover:bg-surface-hover/40"
          >
            <dt className="w-2/5 shrink-0 truncate font-mono text-11 text-fg-muted" title={String(row.key ?? "")}>
              {String(row.key ?? "")}
            </dt>
            <dd className="min-w-0 flex-1">
              <button
                type="button"
                data-testid="kv-value"
                {...clickCopyProps(() => void onCopy(text))}
                className={cn(COPYABLE, "block w-full break-words font-mono text-11 text-fg")}
                title={t("Click to copy the value")}
              >
                {text || "—"}
              </button>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
