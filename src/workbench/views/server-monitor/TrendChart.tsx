import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { MonitorSample } from "@/stores/monitor-store";
import { cn } from "@/lib/cn";
import type { MetricTone } from "./MetricCard";

// 按需引入：只打 line + grid + tooltip + canvas，避免把 1 MB 的完整包塞进产物。
echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

const BADGE: Record<MetricTone, string> = {
  accent: "bg-accent/12 text-accent",
  success: "bg-success/12 text-success",
  warning: "bg-warning/12 text-warning",
  danger: "bg-danger/12 text-danger",
  ai: "bg-ai/12 text-ai",
};

/** 语义色 → CSS 变量名（亮/暗主题各自定义）。 */
const VARIABLE: Record<MetricTone, string> = {
  accent: "--accent",
  success: "--success",
  warning: "--warning",
  danger: "--danger",
  ai: "--ai",
};

/** 把 `--accent: 49 117 241` 这样的 token 转成 canvas 能用的颜色。 */
function tokenColor(name: string, alpha = 1): string {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (raw) return `rgb(${raw} / ${alpha})`;
  } catch {
    /* 无 DOM（测试环境）时走兜底色 */
  }
  return `rgba(148, 163, 184, ${alpha})`;
}

function clock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * 30-minute trend line (ECharts).
 *
 * Every point is a real measurement; with fewer than two points there is
 * nothing to draw and the chart says so instead of inventing a curve.
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
  format,
}: {
  title: string;
  value: string;
  unit?: string;
  detail: string;
  points: MonitorSample[];
  pick: (point: MonitorSample) => number;
  max: number;
  tone: MetricTone;
  badge?: { text: string; tone: MetricTone };
  /** tooltip 里显示数字的方式（百分比 / 速率）。不传按两位小数。 */
  format?: (value: number) => string;
}) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const variable = VARIABLE[tone];
  const samples = useMemo(() => points.map((point) => ({ at: point.at, value: pick(point) })), [pick, points]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // 测试环境（happy-dom）没有 2D 上下文：安静降级，不把整页带崩。
    let chart: echarts.ECharts;
    try {
      chart = echarts.init(host, undefined, { renderer: "canvas" });
    } catch {
      return;
    }
    chartRef.current = chart;

    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => chart.resize());
    observer?.observe(host);

    return () => {
      observer?.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const color = tokenColor(variable);
    const axisColor = tokenColor("--fg-subtle", 0.75);
    const labels = samples.map((sample) => clock(sample.at));
    const values = samples.map((sample) => sample.value);
    const ceiling = Math.max(max, ...values, 0.0001);
    const render = format ?? ((next: number) => next.toFixed(2));

    chart.setOption(
      {
        animation: false,
        grid: { left: 2, right: 2, top: 6, bottom: 2, containLabel: false },
        xAxis: {
          type: "category",
          show: false,
          boundaryGap: false,
          data: labels,
        },
        yAxis: {
          type: "value",
          show: false,
          min: 0,
          max: ceiling,
        },
        tooltip: {
          trigger: "axis",
          confine: true,
          backgroundColor: tokenColor("--surface-1", 0.96),
          borderColor: tokenColor("--line", 1),
          borderWidth: 1,
          padding: [6, 8],
          textStyle: { color: tokenColor("--fg", 1), fontSize: 11 },
          axisPointer: { type: "line", lineStyle: { color: axisColor, width: 1 } },
          formatter: (params: unknown) => {
            const list = params as { dataIndex: number; value: number }[];
            const first = list[0];
            if (!first) return "";
            const sample = samples[first.dataIndex];
            return `<span style="opacity:.7">${sample ? clock(sample.at) : ""}</span><br/>${render(Number(first.value))}`;
          },
        },
        series: [
          {
            type: "line",
            smooth: 0.35,
            symbol: "none",
            showSymbol: false,
            data: values,
            lineStyle: { width: 1.6, color },
            areaStyle: {
              color: {
                type: "linear",
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color: tokenColor(variable, 0.32) },
                  { offset: 1, color: tokenColor(variable, 0) },
                ],
              },
            },
          },
        ],
      },
      { notMerge: true },
    );
  }, [format, max, samples, variable]);

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

      <div className="relative h-[88px] w-full">
        <div ref={hostRef} className="h-full w-full" />
        {samples.length < 2 && (
          <div className="pointer-events-none absolute inset-0 flex items-center text-10 text-fg-subtle">
            {t("Waiting for the second sample…")}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 text-10 text-fg-subtle">
        <span className="shrink-0">{t("Last 30 minutes")}</span>
        <span className="truncate text-right opacity-80">{detail}</span>
      </div>
    </div>
  );
}
