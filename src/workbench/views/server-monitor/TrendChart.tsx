import { useMemo } from "react";
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
  const values = useMemo(() => points.map(pick), [pick, points]);
  const width = 100;
  const height = 34;
  const ceiling = Math.max(max, ...values, 0.0001);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const coords = values.map((value, index) => {
    const x = values.length > 1 ? index * step : width;
    const y = height - (Math.min(Math.max(value, 0), ceiling) / ceiling) * height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-[10px] border border-line bg-surface-1 px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-11 text-fg-subtle">{title}</span>
        <span className="font-mono text-12 text-fg">{value}</span>
      </div>
      <div className="h-[34px] w-full">
        {values.length < 2 ? (
          <div className="flex h-full items-center text-10 text-fg-subtle">等待第二次采集…</div>
        ) : (
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={cn("h-full w-full", tone)}>
            <polygon
              points={`0,${height} ${coords.join(" ")} ${width},${height}`}
              fill="currentColor"
              opacity={0.14}
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
      <div className="flex items-center justify-between text-10 text-fg-subtle">
        <span>最近 30 分钟</span>
        <span>{detail}</span>
      </div>
    </div>
  );
}
