/**
 * 「应用服务 / 基础设施」列表里的一张实例卡片。
 *
 * 单独成组件的原因：右键菜单需要 `useContextMenu` 与动作 hook，而 hook 不能
 * 写在 `map` 里 —— 列表卡片必须各自是组件。
 *
 * 能力与项目卡片对齐：复制路径、在终端中跟踪、Nginx 重载 / 看配置、容器
 * 重启 / 停止 / 看配置。没有的事实（systemd 的重启、k8s 的容器操作）不给入口。
 */
import { useState } from "react";
import { CircleDashed } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { cn } from "@/lib/cn";
import type { DeploymentInstance } from "@/api/ops-api";
import {
  PortChips,
  RuntimeBadge,
  ServiceBadge,
  instanceKindMeta,
} from "./badges";
import { COMPONENT_ROLE_LABELS, instanceRole } from "./classify";
import { ContainerConfigDialog } from "./container-config-dialog";
import { buildInstanceMenuItems } from "./project-candidate-menu";
import { useCandidateActions } from "./use-candidate-actions";

export function RuntimeInstanceCard({
  instance,
  serverId,
  sessionId,
  onOpenPath,
}: {
  instance: DeploymentInstance;
  /** 服务器与会话：右键里的容器 / Nginx 动作走它们。 */
  serverId: string;
  sessionId: string;
  onOpenPath: (path: string) => void;
}) {
  const { t } = useTranslation();
  const menu = useContextMenu();
  const actions = useCandidateActions(serverId, sessionId);
  const [stopTarget, setStopTarget] = useState<string | null>(null);

  const meta = instanceKindMeta(instance.kind);
  const unclassified = instanceRole(instance) === "unknown";
  const stopped = instance.status && instance.status !== "running";
  const componentLabel = COMPONENT_ROLE_LABELS[instance.component_role]
    ? t(COMPONENT_ROLE_LABELS[instance.component_role])
    : undefined;

  const menuItems = buildInstanceMenuItems({
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
  });

  return (
    <article
      className={cn(
        "overflow-hidden rounded-[12px] border border-line bg-surface-1 px-4 py-3 shadow-[0_1px_2px_rgb(15_23_42/0.04)]",
        stopped && "opacity-70",
      )}
      onContextMenu={menu.onContextMenu(() => menuItems)}
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
          <span className={cn("text-10", stopped ? "text-fg-subtle" : "text-success")}>
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

      {/* 右键动作的结果就地反馈，失败给后端原文。 */}
      {actions.notice && (
        <p
          className={cn(
            "mt-1.5 text-11",
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
    </article>
  );
}
