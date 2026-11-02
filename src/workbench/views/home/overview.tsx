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
    <div className="home-overview">
      {stats.map((stat) => {
        const Icon = stat.icon;
        return (
          <button
            key={stat.id}
            type="button"
            onClick={stat.onOpen}
            data-testid={`home-stat-${stat.id}`}
            className={cn(
              "home-stat group min-w-0 text-left",
              "focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-[-2px]",
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="home-stat-icon">
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
            <span className="home-stat-value">{stat.value}</span>
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
