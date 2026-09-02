import { ShieldCheck } from "lucide-react";

/** A labelled key/value list used across the project graphs. */
export function Detail({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center gap-1 font-medium text-fg">
        <ShieldCheck size={12} className="text-fg-subtle" />
        {title}
      </div>
      {items.length ? (
        <ul className="space-y-0.5 text-fg-muted">
          {items.map((item) => (
            <li key={item} className="truncate">
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-fg-subtle">暂无</div>
      )}
    </div>
  );
}
