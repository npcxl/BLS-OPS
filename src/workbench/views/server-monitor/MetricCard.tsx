import { cn } from "@/lib/cn";

/** Bar colour by load: red ≥90, amber ≥75, accent below. */
export function usageTone(percent: number): string {
  if (percent >= 90) return "bg-danger";
  if (percent >= 75) return "bg-warning";
  return "bg-accent";
}

export function MetricCard({
  icon: Icon,
  label,
  value,
  unit,
  detail,
  percent,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  unit?: string;
  detail: string;
  percent?: number;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-[12px] border border-line bg-surface-1 p-3">
      <div className="flex items-center gap-1.5 text-fg-subtle">
        <Icon size={13} strokeWidth={1.75} />
        <span className="text-11">{label}</span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="font-mono text-20 text-fg">{value}</span>
        {unit && <span className="text-11 text-fg-subtle">{unit}</span>}
      </div>
      {percent !== undefined && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-surface-3">
          <div
            className={cn("h-full rounded-full transition-[width] duration-300 ease-out", usageTone(percent))}
            style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
          />
        </div>
      )}
      <span className="truncate text-11 text-fg-subtle">{detail}</span>
    </div>
  );
}
