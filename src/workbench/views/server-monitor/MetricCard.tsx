import { cn } from "@/lib/cn";

/** 指标卡的语义色：进度条、状态徽章、数值强调共用一套。 */
export type MetricTone = "accent" | "success" | "warning" | "danger" | "ai";

const BAR: Record<MetricTone, string> = {
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  ai: "bg-ai",
};

const BADGE: Record<MetricTone, string> = {
  accent: "bg-accent/12 text-accent",
  success: "bg-success/12 text-success",
  warning: "bg-warning/12 text-warning",
  danger: "bg-danger/12 text-danger",
  ai: "bg-ai/12 text-ai",
};

const ICON: Record<MetricTone, string> = {
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  ai: "text-ai",
};

/** 按占用率给条上色（表格与指标卡共用）。 */
export function usageTone(percent: number): string {
  if (percent >= 90) return "bg-danger";
  if (percent >= 75) return "bg-warning";
  return "bg-accent";
}

/** 按占用率给语义色（状态徽章用）。 */
export function usageMetricTone(percent: number): MetricTone {
  if (percent >= 90) return "danger";
  if (percent >= 75) return "warning";
  return "accent";
}

export interface MetricCardProps {
  icon: React.ElementType;
  label: string;
  value: string;
  unit?: string;
  /** 左下：一句解释（核心数、已用/总量…）。 */
  detail: string;
  /** 右下：次要信息（型号、swap、阈值说明…）。 */
  meta?: string;
  percent?: number;
  /** 覆盖进度条颜色；不传则按占用率自动分级。 */
  tone?: MetricTone;
  /** 右上角状态徽章。 */
  badge?: { text: string; tone: MetricTone };
}

export function MetricCard({
  icon: Icon,
  label,
  value,
  unit,
  detail,
  meta,
  percent,
  tone,
  badge,
}: MetricCardProps) {
  const barTone = tone ?? (percent !== undefined ? usageMetricTone(percent) : "accent");

  return (
    <div className="flex min-w-0 flex-col gap-2.5 rounded-[12px] border border-line bg-surface-1 p-3.5">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-fg-subtle">
          <Icon size={13} strokeWidth={1.75} className={cn("shrink-0", ICON[barTone])} />
          <span className="truncate text-11">{label}</span>
        </div>
        {badge && (
          <span
            className={cn(
              "shrink-0 rounded-full px-1.5 py-px text-10 font-medium",
              BADGE[badge.tone],
            )}
          >
            {badge.text}
          </span>
        )}
      </div>

      <div className="flex items-baseline gap-1">
        <span className="font-mono text-[26px] leading-none tracking-tight text-fg">{value}</span>
        {unit && <span className="text-11 text-fg-subtle">{unit}</span>}
      </div>

      {percent !== undefined && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-surface-3">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-300 ease-out",
              BAR[barTone],
            )}
            style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
          />
        </div>
      )}

      <div className="flex items-center justify-between gap-2 text-10 text-fg-subtle">
        <span className="truncate">{detail}</span>
        {meta && <span className="shrink-0 truncate font-mono opacity-80">{meta}</span>}
      </div>
    </div>
  );
}
