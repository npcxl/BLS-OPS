import { useMemo } from "react";
import { Database } from "lucide-react";
import { ModuleEmpty } from "@/workbench/views/module-frame";
import type { DeploymentInstance } from "@/api/ops-api";
import { PortChips, RuntimeBadge, ServiceBadge, instanceKindMeta } from "../badges";
import {
  CONFIDENCE_LABELS,
  OWNERSHIP_LABELS,
  groupInfrastructure,
  instanceProductLabel,
} from "../classify";

/**
 * 基础设施 tab：只展示后端判定为 `workload_role === "infrastructure"` 的实例，
 * 按 `infrastructure_category` 分组（数据库 / 缓存 / 对象存储 / …）。
 *
 * 与「应用服务」互斥：MySQL、Redis、MinIO 只出现在这里；共享 Nginx 是网关
 * 依赖，项目专属的 Nginx 前端容器归应用服务。每个卡片都给出分类依据与置信度。
 */
export function TabInfrastructure({
  instances,
  onOpenPath,
}: {
  instances: DeploymentInstance[];
  onOpenPath: (path: string) => void;
}) {
  const groups = useMemo(() => groupInfrastructure(instances), [instances]);

  if (instances.length === 0) {
    return (
      <ModuleEmpty
        icon={Database}
        title="没有发现基础设施实例"
        hint="扫描到的数据库 / 缓存 / 对象存储 / 消息队列 / 网关等依赖会按类别显示在这里。未识别的实例显示为待归类，绝不默认当作基础设施。"
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <section
          key={group.category}
          className="overflow-hidden rounded-[12px] border border-line bg-surface-1 shadow-[0_1px_2px_rgb(15_23_42/0.04)]"
        >
          <div className="flex items-center gap-2 border-b border-line bg-surface-2/70 px-4 py-2.5">
            <span className="rounded-full bg-accent/12 px-2 py-0.5 text-10 font-medium text-accent">
              {group.label}
            </span>
            <span className="text-11 text-fg-subtle">{group.instances.length} 个实例</span>
          </div>
          <div className="divide-y divide-line/70">
            {group.instances.map((instance) => {
              const meta = instanceKindMeta(instance.kind);
              const Icon = meta.icon;
              const ownership = OWNERSHIP_LABELS[instance.ownership] ?? instance.ownership;
              const confidence =
                CONFIDENCE_LABELS[instance.classification_confidence] ??
                instance.classification_confidence;
              const evidence =
                instance.classification_evidence.map((e) => e.detail).join("；") ?? "";
              const product = instanceProductLabel(instance);
              const linkedCount = instance.linked_project_ids.length;
              return (
                <div
                  key={instance.id}
                  className="flex flex-col gap-1.5 px-4 py-2.5 transition-colors hover:bg-surface-hover/50"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Icon size={14} className="shrink-0 text-accent" />
                    <strong className="text-12 text-fg">{product}</strong>
                    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-10 text-fg-muted">
                      {meta.label}
                    </span>
                    <RuntimeBadge runtime={instance.runtime} />
                    <ServiceBadge service={instance.service} />
                    {/* 共享 / 项目专属。 */}
                    <span
                      className={ownershipTone(instance.ownership)}
                      title="实例归属：多个项目共用，还是只服务某一个项目"
                    >
                      {ownership}
                    </span>
                    {linkedCount > 0 && (
                      <span
                        className="rounded bg-success/12 px-1.5 py-0.5 text-10 text-success"
                        title={instance.linked_project_ids.join("\n")}
                      >
                        关联 {linkedCount} 个项目
                      </span>
                    )}
                    {instance.status && (
                      <span className="text-10 text-fg-subtle">{instance.status}</span>
                    )}
                  </div>
                  <div>
                    <PortChips ports={instance.ports} empty="无暴露端口" />
                  </div>
                  {/* 镜像或 unit：识别证据，一眼看清运行方式。 */}
                  {(instance.image || instance.kind === "systemd") && (
                    <p className="truncate font-mono text-10 text-fg-subtle" title={instance.image ?? instance.name}>
                      {instance.image ?? instance.name}
                    </p>
                  )}
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
                  <p className="text-10 text-fg-subtle/80">
                    {evidence && <span title={evidence}>分类依据：{evidence}</span>}
                    {evidence && " · "}
                    {confidence}
                  </p>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/** 归属徽标配色：共享中性、项目专属强调。 */
function ownershipTone(ownership: DeploymentInstance["ownership"]): string {
  switch (ownership) {
    case "shared":
      return "rounded bg-surface-2 px-1.5 py-0.5 text-10 text-fg-muted";
    case "project_scoped":
      return "rounded bg-accent/12 px-1.5 py-0.5 text-10 text-accent";
    default:
      return "rounded bg-warning/12 px-1.5 py-0.5 text-10 text-warning";
  }
}
