import { useMemo, useState } from "react";
import { Box, Boxes, Container, Server, Ship } from "lucide-react";
import { cn } from "@/lib/cn";
import { ModuleEmpty } from "@/workbench/views/module-frame";
import type { DeploymentInstance, InstanceRuntime } from "@/api/ops-api";
import {
  PortChips,
  RuntimeBadge,
  ServiceBadge,
  instanceKindMeta,
} from "../badges";

type Filter = "all" | "linked" | "unlinked" | "stopped";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "linked", label: "已关联" },
  { id: "unlinked", label: "未关联" },
  { id: "stopped", label: "已停止" },
];

const RUNTIME_ICON: Record<InstanceRuntime, typeof Box> = {
  host: Server,
  container: Container,
  kubernetes: Ship,
};

/**
 * 运行服务 tab：服务器上真实在跑的实例 —— Docker 容器、systemd、PM2、Kubernetes Pod。
 * 这与"项目"是两层东西：容器是运行形态，项目是源码身份；一个项目可能跑出多个容器。
 */
export function TabRuntime({
  instances,
  onOpenPath,
}: {
  instances: DeploymentInstance[];
  onOpenPath: (path: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");

  const counts = useMemo(() => {
    const linked = instances.filter((i) => i.source_known).length;
    const unlinked = instances.filter((i) => !i.source_known).length;
    const stopped = instances.filter((i) => i.status && i.status !== "running").length;
    return { all: instances.length, linked, unlinked, stopped };
  }, [instances]);

  const visible = useMemo(() => {
    switch (filter) {
      case "linked":
        return instances.filter((i) => i.source_known);
      case "unlinked":
        return instances.filter((i) => !i.source_known);
      case "stopped":
        return instances.filter((i) => i.status && i.status !== "running");
      default:
        return instances;
    }
  }, [instances, filter]);

  if (instances.length === 0) {
    return (
      <ModuleEmpty
        icon={Boxes}
        title="没有发现运行实例"
        hint="扫描会探测 Docker、systemd、PM2、Kubernetes 等真实实例。没有探测到时说明这台服务器当前没有以这些方式运行的服务。"
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={cn(
              "rounded-full px-2.5 py-1 text-10 transition-colors",
              filter === f.id
                ? "bg-accent/15 text-accent"
                : "bg-surface-2 text-fg-subtle hover:text-fg",
            )}
          >
            {f.label}
            <span className="ml-1 tabular-nums opacity-70">{counts[f.id]}</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="text-11 text-fg-subtle">该筛选下没有实例。</p>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((instance) => {
            const meta = instanceKindMeta(instance.kind);
            const Icon = RUNTIME_ICON[instance.runtime] ?? meta.icon;
            const stopped = instance.status && instance.status !== "running";
            return (
              <article
                key={instance.id}
                className={cn(
                  "overflow-hidden rounded-[12px] border border-line bg-surface-1 px-4 py-3 shadow-[0_1px_2px_rgb(15_23_42/0.04)]",
                  stopped && "opacity-70",
                )}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <Icon size={15} className="shrink-0 text-accent" />
                  <strong className="text-13 text-fg">{instance.name}</strong>
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 text-10 text-fg-muted">
                    {meta.label}
                  </span>
                  <RuntimeBadge runtime={instance.runtime} />
                  <ServiceBadge service={instance.service} />
                  {instance.status && (
                    <span
                      className={cn(
                        "text-10",
                        stopped ? "text-fg-subtle" : "text-success",
                      )}
                    >
                      {instance.status}
                    </span>
                  )}
                  {!instance.source_known && !instance.system_owned && (
                    <span className="rounded bg-warning/12 px-1.5 py-0.5 text-10 text-warning">
                      源码未知
                    </span>
                  )}
                  {instance.system_owned && (
                    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-10 text-fg-subtle">
                      系统自带
                    </span>
                  )}
                </div>

                <div className="mt-1.5">
                  <PortChips ports={instance.ports} empty="无暴露端口" />
                </div>

                {instance.source_paths.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-10 text-fg-subtle">
                    <span className="rounded bg-success/12 px-1.5 py-0.5 text-success">已关联源码</span>
                    {instance.source_paths.map((dir) => (
                      <button
                        key={dir}
                        type="button"
                        className="font-mono text-fg-muted hover:text-fg"
                        onClick={() => onOpenPath(dir)}
                        title={`在文件面板打开 ${dir}`}
                      >
                        {dir}
                      </button>
                    ))}
                  </div>
                )}

                {instance.config_files.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
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
                  <p className="mt-1.5 truncate text-10 text-fg-subtle" title={instance.detail}>
                    {instance.detail}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
