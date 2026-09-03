import { useMemo, useState } from "react";
import { Boxes, CircleDashed } from "lucide-react";
import { cn } from "@/lib/cn";
import { ModuleEmpty } from "@/workbench/views/module-frame";
import type { DeploymentInstance } from "@/api/ops-api";
import {
  PortChips,
  RuntimeBadge,
  ServiceBadge,
  instanceKindMeta,
} from "../badges";
import { COMPONENT_ROLE_LABELS, instanceRole } from "../classify";

type Filter = "all" | "linked" | "unlinked" | "unclassified" | "stopped";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "全部应用" },
  { id: "linked", label: "已关联项目" },
  { id: "unlinked", label: "未关联项目" },
  { id: "unclassified", label: "待归类" },
  { id: "stopped", label: "已停止" },
];

/**
 * 应用服务 tab：只展示后端判定为 `application` 的运行实例
 * （Node/Java/Go 业务进程、项目专属容器等），外加"待归类"实例供筛选查看。
 * MySQL/Redis 这类基础设施在「基础设施」tab —— 两个 tab 互斥，不会重复。
 */
export function TabRuntime({
  instances,
  onOpenPath,
}: {
  instances: DeploymentInstance[];
  onOpenPath: (path: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");

  // 已关联项目 = 后端回填的 linked_project_ids 非空；待归类 = workload_role 缺证据。
  const counts = useMemo(() => {
    const linked = instances.filter((i) => i.linked_project_ids.length > 0).length;
    const unlinked = instances.filter(
      (i) => i.linked_project_ids.length === 0 && instanceRole(i) === "application",
    ).length;
    const unclassified = instances.filter((i) => instanceRole(i) === "unknown").length;
    const stopped = instances.filter((i) => i.status && i.status !== "running").length;
    return { all: instances.length, linked, unlinked, unclassified, stopped };
  }, [instances]);

  const visible = useMemo(() => {
    switch (filter) {
      case "linked":
        return instances.filter((i) => i.linked_project_ids.length > 0);
      case "unlinked":
        return instances.filter(
          (i) => i.linked_project_ids.length === 0 && instanceRole(i) === "application",
        );
      case "unclassified":
        return instances.filter((i) => instanceRole(i) === "unknown");
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
        title="没有应用服务"
        hint="这里只列出后端判定为业务应用的运行实例（Node/Java/Go 进程、项目专属容器等）。MySQL、Redis 这类依赖在「基础设施」tab；未识别的实例标记为待归类，绝不冒充业务应用。"
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
            const unclassified = instanceRole(instance) === "unknown";
            const stopped = instance.status && instance.status !== "running";
            const componentLabel = COMPONENT_ROLE_LABELS[instance.component_role];
            return (
              <article
                key={instance.id}
                className={cn(
                  "overflow-hidden rounded-[12px] border border-line bg-surface-1 px-4 py-3 shadow-[0_1px_2px_rgb(15_23_42/0.04)]",
                  stopped && "opacity-70",
                )}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <strong className="text-13 text-fg">{instance.name}</strong>
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 text-10 text-fg-muted">
                    {meta.label}
                  </span>
                  <RuntimeBadge runtime={instance.runtime} />
                  <ServiceBadge service={instance.service} />
                  {/* 待归类必须显式标记，绝不与业务应用混为一谈。 */}
                  {unclassified && (
                    <span
                      className="inline-flex items-center gap-1 rounded bg-warning/12 px-1.5 py-0.5 text-10 text-warning"
                      title="证据不足，暂时无法判断是业务应用；后端绝不默认归为基础设施"
                    >
                      <CircleDashed size={9} />
                      待归类
                    </span>
                  )}
                  {!unclassified && componentLabel && instance.component_role !== "unknown" && (
                    <span className="rounded bg-accent/12 px-1.5 py-0.5 text-10 text-accent">
                      {componentLabel}
                    </span>
                  )}
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
                  {!instance.source_known && !unclassified && (
                    <span className="rounded bg-warning/12 px-1.5 py-0.5 text-10 text-warning">
                      源码未知
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
