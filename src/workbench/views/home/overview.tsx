/**
 * 全局概览：每张卡片只放**有真实来源**的数字。
 *
 * - `value` 由调用方从 Store / 本地库算出；读不到时传 `—`，绝不填 0；
 * - `live` 标记"实时"数值（当前工作区的会话/运行时状态），历史与资产数量不带它；
 * - `alert` 只用于 Store 里真实存在的失败状态。
 */
import { TriangleAlert, type IconComponent } from "@/components/icons";
import { cn } from "@/lib/cn";

export interface OverviewStat {
  id: string;
  label: string;
  value: string;
  icon: IconComponent;
  live?: boolean;
  hint?: string | null;
  alert?: string | null;
  onOpen: () => void;
}

export function OverviewSection({ stats, liveLabel }: { stats: OverviewStat[]; liveLabel: string }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
      {stats.map((stat) => {
        const Icon = stat.icon;
        return (
          <button
            key={stat.id}
            type="button"
            onClick={stat.onOpen}
            data-testid={`home-stat-${stat.id}`}
            className={cn(
              "group flex min-w-0 flex-col gap-1.5 rounded-[12px] border border-line bg-surface-1/70 p-3.5 text-left",
              "shadow-[0_1px_2px_rgb(15_23_42/0.04)] transition-colors",
              "hover:border-line-strong hover:bg-surface-hover/40",
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-surface-2 text-fg-subtle transition-colors group-hover:text-fg-muted">
                <Icon size={13} strokeWidth={1.8} />
              </span>
              <span className="min-w-0 truncate text-11 text-fg-muted">{stat.label}</span>
              {stat.live && (
                <span className="ml-auto flex shrink-0 items-center gap-1 rounded-[5px] bg-success/12 px-1.5 py-0.5 text-10 font-medium text-success">
                  <span className="h-1 w-1 rounded-full bg-current" />
                  {liveLabel}
                </span>
              )}
            </span>
            <span className="text-[24px] leading-none font-semibold tabular-nums text-fg">{stat.value}</span>
            {stat.hint && <span className="truncate text-11 text-fg-subtle">{stat.hint}</span>}
            {stat.alert && (
              <span className="flex items-center gap-1 text-11 text-danger">
                <TriangleAlert size={11} className="shrink-0" />
                <span className="min-w-0 truncate">{stat.alert}</span>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
