/**
 * 数据库品牌图标：使用本地 VSCode 图标集数据，离线渲染。
 *
 * 已连接时保留原色；未连接时灰度化，作为连接状态的一部分。
 */
import { Icon } from "@iconify/react";
import { Database } from "@/components/icons";
import { cn } from "@/lib/cn";
import type { DbEngine } from "@/api/types/database";
import { DB_ENGINE_ICONS } from "./db-engine-icons";

export function DbEngineIcon({
  engine,
  connected,
  size = 14,
  className,
}: {
  engine: DbEngine;
  connected: boolean;
  size?: number;
  className?: string;
}) {
  const data = DB_ENGINE_ICONS[engine];
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
      aria-hidden="true"
      className={cn(
        "shrink-0 transition-[filter,opacity]",
        stateClass,
        className,
      )}
    />
  );
}
