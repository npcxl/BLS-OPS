import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

/** A labelled key/value list used across the project graphs. */
export function Detail({ title, items }: { title: string; items: string[] }) {
  const { t } = useTranslation();
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1 text-10 font-semibold tracking-[0.06em] text-fg-subtle uppercase">
        <ShieldCheck size={12} className="text-fg-muted" />
        {title}
      </div>
      {items.length ? (
        <ul className="space-y-0.5 text-11 text-fg-muted">
          {items.map((item) => (
            <li key={item} className="truncate" title={item}>
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-11 text-fg-subtle">{t("None")}</div>
      )}
    </div>
  );
}