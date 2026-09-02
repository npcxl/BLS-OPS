import { useMemo } from "react";
import { Database } from "lucide-react";
import { ModuleEmpty } from "@/workbench/views/module-frame";
import type { DeploymentInstance, ServiceGroup } from "@/api/ops-api";
import {
  PortChips,
  RuntimeBadge,
  ServiceBadge,
  instanceKindMeta,
  serviceGroupLabel,
} from "../badges";

/**
 * 基础设施 tab：被识别成依赖的实例（数据库 / 缓存 / 网关 / 消息队列 / 搜索引擎 …）。
 * 这些是业务项目运行所依赖的组件，不是要部署的业务项目，单独一屏看清依赖全貌。
 *
 * 注意：一个业务项目可能"用到"MySQL/Redis/Nginx，但项目**身份**仍由源码决定，
 * 不会因此变成基础设施。这里只列确实被判定为依赖的运行实例。
 */
export function TabInfrastructure({
  instances,
  onOpenPath,
}: {
  instances: DeploymentInstance[];
  onOpenPath: (path: string) => void;
}) {
  const byGroup = useMemo(() => {
    const map = new Map<ServiceGroup, DeploymentInstance[]>();
    for (const instance of instances) {
      const group = instance.service?.group;
      if (!group) continue;
      const bucket = map.get(group) ?? [];
      bucket.push(instance);
      map.set(group, bucket);
    }
    return [...map.entries()];
  }, [instances]);

  if (instances.length === 0) {
    return (
      <ModuleEmpty
        icon={Database}
        title="没有发现基础设施实例"
        hint="扫描到的数据库 / 缓存 / 网关 / 消息队列 / 搜索引擎 等依赖会显示在这里。没有探测到时说明当前没有以独立实例形式运行的基础设施组件。"
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {byGroup.map(([group, groupInstances]) => (
        <section
          key={group}
          className="overflow-hidden rounded-[12px] border border-line bg-surface-1 shadow-[0_1px_2px_rgb(15_23_42/0.04)]"
        >
          <div className="flex items-center gap-2 border-b border-line bg-surface-2/70 px-4 py-2.5">
            <span className="rounded-full bg-accent/12 px-2 py-0.5 text-10 font-medium text-accent">
              {serviceGroupLabel(group)}
            </span>
            <span className="text-11 text-fg-subtle">{groupInstances.length} 个实例</span>
          </div>
          <div className="divide-y divide-line/70">
            {groupInstances.map((instance) => {
              const meta = instanceKindMeta(instance.kind);
              const Icon = meta.icon;
              return (
                <div
                  key={instance.id}
                  className="flex flex-col gap-1.5 px-4 py-2.5 transition-colors hover:bg-surface-hover/50"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Icon size={14} className="shrink-0 text-accent" />
                    <strong className="text-12 text-fg">{instance.name}</strong>
                    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-10 text-fg-muted">
                      {meta.label}
                    </span>
                    <RuntimeBadge runtime={instance.runtime} />
                    <ServiceBadge service={instance.service} />
                    {instance.status && (
                      <span className="text-10 text-fg-subtle">{instance.status}</span>
                    )}
                  </div>
                  <div>
                    <PortChips ports={instance.ports} empty="无暴露端口" />
                  </div>
                  {instance.config_files.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {instance.config_files.map((file) => (
                        <button
                          key={file}
                          type="button"
                          className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-10 text-fg-muted hover:text-fg"
                          onClick={() => onOpenPath(file)}
                          title={`打开 ${file}`}
                        >
                          {file}
                        </button>
                      ))}
                    </div>
                  )}
                  {instance.detail && (
                    <p className="truncate text-10 text-fg-subtle" title={instance.detail}>
                      {instance.detail}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
