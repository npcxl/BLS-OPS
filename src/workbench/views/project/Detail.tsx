import { ShieldCheck } from "@/components/icons";
import { useTranslation } from "react-i18next";

/** A labelled key/value list used across the project graphs. */
export function Detail({ title, items }: { title: string; items: string[] }) {
  const { t } = useTranslation();
  return (
    <div className="project-detail-group">
      <div className="project-detail-label flex items-center gap-1.5">
        <ShieldCheck size={12} className="text-fg-muted" />
        {title}
      </div>
      {items.length ? (
        <ul className="project-detail-values text-12 text-fg-muted">
          {items.map((item) => (
            <li key={item} title={item}>
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
