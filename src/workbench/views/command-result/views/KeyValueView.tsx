import { cn } from "@/lib/cn";
import type { ResultSection } from "../model";

/**
 * 通用属性面板 —— `systemctl show` / `docker info` / `sysctl -a` / `ulimit`
 * 共用。行契约：`{key, value}`；分块用 sections（`[Section]` 标题）。
 */
export function KeyValueView({
  rows,
  sections,
}: {
  rows: Record<string, unknown>[];
  sections?: ResultSection[];
}) {
  if (sections && sections.length > 0) {
    return (
      <div className="min-h-0 flex-1 overflow-auto">
        {sections.map((section) => (
          <section key={section.title}>
            <h4 className="sticky top-0 z-10 bg-surface-2/90 px-3 py-1 text-10 font-semibold tracking-[0.06em] text-fg-subtle uppercase backdrop-blur">
              {section.title}
            </h4>
            <Rows rows={section.rows} />
          </section>
        ))}
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Rows rows={rows} />
    </div>
  );
}

function Rows({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) {
    return <p className="px-3 py-6 text-center text-11 text-fg-subtle">没有属性。</p>;
  }
  return (
    <dl className="divide-y divide-line/40">
      {rows.map((row, index) => (
        <div
          key={`${String(row.key ?? index)}-${index}`}
          className="flex gap-3 px-3 py-1.5 transition-colors hover:bg-surface-hover/40"
        >
          <dt className="w-2/5 shrink-0 truncate font-mono text-11 text-fg-muted" title={String(row.key ?? "")}>
            {String(row.key ?? "")}
          </dt>
          <dd
            className={cn("min-w-0 flex-1 break-words font-mono text-11 text-fg")}
            title={String(row.value ?? "")}
          >
            {String(row.value ?? "") || "—"}
          </dd>
        </div>
      ))}
    </dl>
  );
}
