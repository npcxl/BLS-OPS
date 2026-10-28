/**
 * 数据库品牌图标：使用本地 skill-icons 数据，离线渲染。
 *
 * 浅色主题用 *-dark 图标（深色底），深色主题用 *-light 图标（浅色底），
 * 保证图标自身底色和界面主题相反、品牌色始终清楚。
 */
import { Icon } from "@iconify/react";
import { Database } from "@/components/icons";
import { useThemeMode } from "@/hooks/use-theme";
import { cn } from "@/lib/cn";
import type { DbEngine } from "@/api/types/database";
import { DB_ENGINE_ICONS } from "./db-engine-icons";

export function DbEngineIcon({
  engine,
  connected,
  size = 16,
  className,
}: {
  engine: DbEngine;
  connected: boolean;
  size?: number;
  className?: string;
}) {
  const [mode] = useThemeMode();
  const dark =
    mode === "dark" ||
    (mode === "system" &&
      !!window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const pair = DB_ENGINE_ICONS[engine];
  const data = pair ? (dark ? pair.dark : pair.light) : undefined;
  // 未连接只靠灰度区分；暗色底上 0.35 几乎看不见，0.6 仍能认出是哪个引擎。
  const stateClass = connected
    ? "opacity-100 saturate-100"
    : "opacity-60 grayscale";

  if (!data) {
    return (
      <Database
        size={size}
        className={cn(
          "shrink-0 transition-[filter,opacity]",
          stateClass,
          className,
        )}
      />
    );
  }

  return (
    <Icon
      icon={data}
      width={size}
      height={size}
      // 本地图标数据直接渲染，避免首帧先出现空 span 再异步补 SVG。
      ssr
      aria-hidden="true"
      className={cn(
        "shrink-0 transition-[filter,opacity]",
        stateClass,
        className,
      )}
    />
  );
}
