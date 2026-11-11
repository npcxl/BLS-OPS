import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { MonitorSample } from "@/stores/monitor-store";
import { cn } from "@/lib/cn";
import type { MetricTone } from "./MetricCard";

const BADGE: Record<MetricTone, string> = {
  accent: "bg-accent/12 text-accent",
  success: "bg-success/12 text-success",
  warning: "bg-warning/12 text-warning",
  danger: "bg-danger/12 text-danger",
  ai: "bg-ai/12 text-ai",
};

/**
 * A 30-minute sparkline. Every point is a real measurement; with fewer than
 * two points there is nothing to draw and the chart says so instead of
 * inventing a curve.
 */
export function TrendChart({
  title,
  value,
  unit,
  detail,
  points,
  pick,
  max,
  tone,
  badge,
}: {
  title: string;
  value: string;
  unit?: string;
  detail: string;
  points: MonitorSample[];
  pick: (point: MonitorSample) => number;
  max: number;
  /** 曲线与填充的颜色（`text-accent` 等）。 */
  tone: string;
  badge?: { text: string; tone: MetricTone };
}) {
  const { t } = useTranslation();
  const gradientId = useId();
  const values = useMemo(() => points.map(pick), [pick, points]);
  const width = 100;
  const height = 80;
  const ceiling = Math.max(max, ...values, 0.0001);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const coords = values.map((value, index) => {
    const x = values.length > 1 ? index * step : width;
    const y = height - (Math.min(Math.max(value, 0), ceiling) / ceiling) * height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const gridLines = [0.25, 0.5, 0.75].map((ratio) => height * ratio);

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-[12px] border border-line bg-surface-1 px-3.5 py-3">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <span className="truncate text-11 text-fg-subtle">{title}</span>
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
        <span className="font-mono text-[18px] leading-none tracking-tight text-fg">{value}</span>
        {unit && <span className="text-10 text-fg-subtle">{unit}</span>}
      </div>

      <div className="h-[80px] w-full">
        {values.length < 2 ? (
          <div className="flex h-full items-center text-10 text-fg-subtle">
            {t("Waiting for the second sample…")}
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            className={cn("h-full w-full", tone)}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="currentColor" stopOpacity="0.32" />
                <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
              </linearGradient>
            </defs>
            {gridLines.map((y) => (
              <line
                key={y}
                x1={0}
                x2={width}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeWidth={1}
                opacity={0.1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <polygon
              points={`0,${height} ${coords.join(" ")} ${width},${height}`}
              fill={`url(#${gradientId})`}
            />
            <polyline
              points={coords.join(" ")}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 text-10 text-fg-subtle">
        <span className="shrink-0">{t("Last 30 minutes")}</span>
        <span className="truncate text-right opacity-80">{detail}</span>
      </div>
    </div>
  );
}
