import { useMemo, useState } from "react";
import { Boxes, CircleDashed } from "lucide-react";
import { useTranslation } from "react-i18next";
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

/** 筛选名存英文 key，渲染处 t()（模块级常量不能调 hook）。 */
const FILTERS: { id: Filter; labelKey: string }[] = [
  { id: "all", labelKey: "All apps" },
  { id: "linked", labelKey: "Linked to projects" },
  { id: "unlinked", labelKey: "Unlinked" },
  { id: "unclassified", labelKey: "Unclassified" },
  { id: "stopped", labelKey: "Stopped" },
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
  const { t } = useTranslation();
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
        title={t("No app services")}
        hint={t(
          "Only running instances the backend classified as business apps are listed here (Node/Java/Go processes, project-scoped containers…). Dependencies like MySQL and Redis live in the Infrastructure tab; unrecognized instances are marked unclassified and never pose as business apps.",
        )}
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
            {t(f.labelKey)}
            <span className="ml-1 tabular-nums opacity-70">{counts[f.id]}</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="text-11 text-fg-subtle">{t("No instances match this filter.")}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((instance) => {
            const meta = instanceKindMeta(instance.kind);
            const unclassified = instanceRole(instance) === "unknown";
            const stopped = instance.status && instance.status !== "running";
            const componentLabel = COMPONENT_ROLE_LABELS[instance.component_role]
              ? t(COMPONENT_ROLE_LABELS[instance.component_role])
              : undefined;
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
                      title={t(
                        "Not enough evidence to tell whether it's a business app; the backend never defaults to infrastructure",
                      )}
                    >
                      <CircleDashed size={9} />
                      {t("Unclassified")}
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
                      {t("Source unknown")}
                    </span>
                  )}
                </div>

                <div className="mt-1.5">
                  <PortChips ports={instance.ports} empty="No exposed ports" />
                </div>

                {instance.source_paths.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-10 text-fg-subtle">
                    <span className="rounded bg-success/12 px-1.5 py-0.5 text-success">
                      {t("Source linked")}
                    </span>
                    {instance.source_paths.map((dir) => (
                      <button
                        key={dir}
                        type="button"
                        className="font-mono text-fg-muted hover:text-fg"
                        onClick={() => onOpenPath(dir)}
                        title={t("Open {{path}} in the file panel", { path: dir })}
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
                        title={t("Open {{path}}", { path: file })}
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
