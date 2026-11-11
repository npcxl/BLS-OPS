import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { MonitorSample } from "@/stores/monitor-store";
import { cn } from "@/lib/cn";

/**
 * A 30-minute sparkline. Every point is a real measurement; with fewer than
 * two points there is nothing to draw and the chart says so instead of
 * inventing a curve.
 */
export function TrendChart({
  title,
  value,
  detail,
  points,
  pick,
  max,
  tone,
}: {
  title: string;
  value: string;
  detail: string;
  points: MonitorSample[];
  pick: (point: MonitorSample) => number;
  max: number;
  tone: string;
}) {
  const { t } = useTranslation();
  const values = useMemo(() => points.map(pick), [pick, points]);
  const width = 100;
  const height = 88;
  const ceiling = Math.max(max, ...values, 0.0001);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const coords = values.map((value, index) => {
    const x = values.length > 1 ? index * step : width;
    const y = height - (Math.min(Math.max(value, 0), ceiling) / ceiling) * height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  // 三条水平参考线：低于 50% 的曲线全靠它们才有"图表"的纵深感。
  const gridLines = [0.25, 0.5, 0.75].map((ratio) => height * ratio);

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-[12px] border border-line bg-surface-1 px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-11 text-fg-subtle">{title}</span>
        <span className="shrink-0 font-mono text-13 text-fg">{value}</span>
      </div>
      <div className="h-[88px] w-full">
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
            {gridLines.map((y) => (
              <line
                key={y}
                x1={0}
                x2={width}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeWidth={1}
                opacity={0.12}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <polygon
              points={`0,${height} ${coords.join(" ")} ${width},${height}`}
              fill="currentColor"
              opacity={0.16}
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
        <span className="truncate text-right">{detail}</span>
      </div>
    </div>
  );
}
