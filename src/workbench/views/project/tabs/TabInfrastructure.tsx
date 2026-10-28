import { useMemo, useState } from "react";
import { Database } from "@/components/icons";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { cn } from "@/lib/cn";
import { ModuleEmpty } from "@/workbench/views/module-frame";
import type { DeploymentInstance } from "@/api/ops-api";
import { PortChips, RuntimeBadge, ServiceBadge, instanceKindMeta } from "../badges";
import {
  CONFIDENCE_LABELS,
  OWNERSHIP_LABELS,
  groupInfrastructure,
  instanceProductLabel,
} from "../classify";
import { ContainerConfigDialog } from "../container-config-dialog";
import { buildInstanceMenuItems } from "../project-candidate-menu";
import { useCandidateActions } from "../use-candidate-actions";

/**
 * 基础设施 tab：只展示后端判定为 `workload_role === "infrastructure"` 的实例，
 * 按 `infrastructure_category` 分组（数据库 / 缓存 / 对象存储 / …）。
 *
 * 与「应用服务」互斥：MySQL、Redis、MinIO 只出现在这里；共享 Nginx 是网关
 * 依赖，项目专属的 Nginx 前端容器归应用服务。每个卡片都给出分类依据与置信度。
 */
export function TabInfrastructure({
  instances,
  serverId,
  sessionId,
  onOpenPath,
}: {
  instances: DeploymentInstance[];
  /** 服务器与会话：右键里的容器 / Nginx 动作走它们。 */
  serverId: string;
  sessionId: string;
  onOpenPath: (path: string) => void;
}) {
  const { t } = useTranslation();
  const groups = useMemo(() => groupInfrastructure(instances), [instances]);

  // 一个页面级菜单就够：右键菜单是全局单例，行内只负责把它打开到某个实例上。
  const menu = useContextMenu();
  const actions = useCandidateActions(serverId, sessionId);
  const [stopTarget, setStopTarget] = useState<string | null>(null);

  const openMenuFor = (instance: DeploymentInstance) =>
    menu.onContextMenu(() =>
      buildInstanceMenuItems({
        instance,
        busy: actions.busy,
        t,
        onCopyPath: (path) => void actions.copyPath(path),
        onOpenTerminal: (path) => actions.openInTerminal(path),
        onReloadNginx: () => void actions.reloadNginx(),
        onContainerAction: (action, container) => void actions.controlContainer(action, container),
        onStopContainer: (container) => setStopTarget(container),
        onInspectContainer: (container) => void actions.inspectContainer(container),
        onOpenPath,
      }),
    );

  if (instances.length === 0) {
    return (
      <ModuleEmpty
        icon={Database}
        title={t("No infrastructure instances found")}
        hint={t(
          "Databases, caches, object storage, message queues, gateways and other dependencies found by the scan appear here by category. Unrecognized instances are marked unclassified — never assumed to be infrastructure.",
        )}
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
              {t(group.label)}
            </span>
            <span className="text-11 text-fg-subtle">
              {t("{{count}} instances", { count: group.instances.length })}
            </span>
          </div>
          <div className="divide-y divide-line/70">
            {group.instances.map((instance) => {
              const meta = instanceKindMeta(instance.kind);
              const Icon = meta.icon;
              const ownership = t(OWNERSHIP_LABELS[instance.ownership] ?? instance.ownership);
              const confidence = t(
                CONFIDENCE_LABELS[instance.classification_confidence] ??
                  instance.classification_confidence,
              );
              const evidence =
                instance.classification_evidence.map((e) => e.detail).join("; ") ?? "";
              const product = instanceProductLabel(instance);
              const linkedCount = instance.linked_project_ids.length;
              return (
                <div
                  key={instance.id}
                  className="flex flex-col gap-1.5 px-4 py-2.5 transition-colors hover:bg-surface-hover/50"
                  onContextMenu={openMenuFor(instance)}
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
                      title={t("Instance ownership: shared by multiple projects, or serving a single one")}
                    >
                      {ownership}
                    </span>
                    {linkedCount > 0 && (
                      <span
                        className="rounded bg-success/12 px-1.5 py-0.5 text-10 text-success"
                        title={instance.linked_project_ids.join("\n")}
                      >
                        {t("Linked to {{count}} projects", { count: linkedCount })}
                      </span>
                    )}
                    {instance.status && (
                      <span className="text-10 text-fg-subtle">{instance.status}</span>
                    )}
                  </div>
                  <div>
                    <PortChips ports={instance.ports} empty="No exposed ports" />
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
                          title={t("Open {{path}}", { path: file })}
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
                    {evidence && (
                      <span title={evidence}>{t("Classification evidence: {{evidence}}", { evidence })}</span>
                    )}
                    {evidence && " · "}
                    {confidence}
                  </p>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {/* 右键动作的结果就地反馈，失败给后端原文。 */}
      {actions.notice && (
        <p
          className={cn(
            "text-11",
            actions.notice.tone === "danger" ? "text-danger" : "text-success",
          )}
        >
          {actions.notice.text}
        </p>
      )}

      <ContextMenu {...menu.props} />
      <ContainerConfigDialog
        open={actions.configOpen}
        config={actions.config}
        onClose={actions.closeConfig}
        onOpenPath={onOpenPath}
        onTrackPath={actions.openInTerminal}
        onCopyPath={(path) => void actions.copyPath(path)}
      />
      <ConfirmDialog
        open={stopTarget !== null}
        danger
        title={t("Stop container {{name}}?", { name: stopTarget ?? "" })}
        description={t(
          "The container stops immediately and anything it serves becomes unreachable. Its data stays on disk, so you can start it again from the Docker view.",
        )}
        confirmLabel={t("Stop container")}
        onCancel={() => setStopTarget(null)}
        onConfirm={() => {
          const target = stopTarget;
          setStopTarget(null);
          if (target) void actions.controlContainer("stop", target);
        }}
      />
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
