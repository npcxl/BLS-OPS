import { Box, CircleAlert, Globe, Server } from "lucide-react";
import { cn } from "@/lib/cn";
import type { DeploymentInstance } from "@/api/ops-api";

/** 部署方式 → 图标与展示名。 */
const KIND_META: Record<string, { icon: typeof Box; label: string }> = {
  docker: { icon: Box, label: "Docker" },
  systemd: { icon: Server, label: "systemd" },
  nginx: { icon: Globe, label: "Nginx" },
};

/**
 * 第一轮部署实例清单：真实容器 / 服务 / 站点。`source_known === false` 的
 * 实例明确标为"源码未知"，绝不猜测路径。
 */
export function InstanceList({ instances }: { instances: DeploymentInstance[] }) {
  if (instances.length === 0) return null;
  const unknown = instances.filter((instance) => !instance.source_known).length;
  return (
    <section className="rounded-[10px] border border-line bg-surface-1">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-11 font-medium text-fg">部署实例</span>
        <span className="text-10 text-fg-subtle">
          {instances.length} 个实例 · {unknown} 个源码未知
        </span>
      </div>
      <div className="divide-y divide-line">
        {instances.map((instance) => {
          const meta = KIND_META[instance.kind];
          const Icon = meta?.icon ?? Box;
          return (
            <div key={instance.id} className="flex items-start gap-2.5 px-3 py-2">
              <Icon size={14} className="mt-0.5 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <strong className="truncate text-12 text-fg">{instance.name}</strong>
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 text-10 text-fg-muted">
                    {meta?.label ?? instance.kind}
                  </span>
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-10",
                      instance.source_known
                        ? "bg-success/12 text-success"
                        : "bg-warning/12 text-warning",
                    )}
                  >
                    {instance.source_known ? "已关联源码" : "源码未知"}
                  </span>
                  <span className="text-10 text-fg-subtle">{instance.status}</span>
                  {instance.ports.length > 0 && (
                    <span className="text-10 text-fg-subtle">
                      端口 {instance.ports.join(", ")}
                    </span>
                  )}
                </div>
                {instance.source_paths.length > 0 && (
                  <div className="mt-0.5 truncate font-mono text-10 text-fg-subtle" title={instance.source_paths.join("\n")}>
                    {instance.source_paths.join("  ·  ")}
                  </div>
                )}
                <div className="mt-0.5 truncate text-10 text-fg-subtle" title={instance.detail}>
                  {instance.detail}
                </div>
              </div>
              {!instance.source_known && (
                <CircleAlert size={13} className="mt-0.5 shrink-0 text-warning" />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
