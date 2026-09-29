/**
 * 部署中心的五个列表（应用 / 环境 / 服务 / 方案 / 运行记录）。
 *
 * 都是"纯展示 + 回调"：数据与动作全部来自 `useDeploymentCenter`，列表本身不碰 IPC。
 * 列表行不 `memo`：这里的行数是个位数（应用 / 环境 / 服务 / 方案），
 * 过早优化反而会掩盖刷新语义。
 */

import { Fragment } from "react";
import { useTranslation } from "react-i18next";

import type { ConfirmedProject } from "@/api/types/project";
import type {
  DeploymentApplication,
  DeploymentEnvironment,
  DeploymentPlan,
  DeploymentServiceUnit,
} from "@/api/types/deployment";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/cn";

import type { DeploymentCenter } from "./use-deployment-center";
import {
  ACTION_LABELS,
  APPLICATION_KIND_LABELS,
  ENVIRONMENT_KIND_LABELS,
  RELEASE_STATUS_LABELS,
  RISK_LABELS,
  RISK_TONES,
  RUN_STATUS_LABELS,
  SERVICE_KIND_LABELS,
  SERVICE_ROLE_LABELS,
  SOURCE_KIND_LABELS,
} from "./labels";

function ListHeader({
  title,
  count,
  action,
}: {
  title: string;
  count: number;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-12 font-medium text-fg">{title}</span>
        <span className="rounded-full bg-surface-2 px-1.5 text-10 text-fg-subtle">{count}</span>
      </div>
      {action}
    </div>
  );
}

function Row({
  title,
  badges,
  detail,
  actions,
}: {
  title: string;
  badges: React.ReactNode;
  detail?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 border-b border-line/60 px-3 py-2 last:border-b-0 hover:bg-surface-hover/60">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-12 text-fg">{title}</span>
          {badges}
        </div>
        {detail && <div className="mt-1 text-11 leading-relaxed text-fg-subtle">{detail}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}

function Chip({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-[5px] border border-line bg-surface-2 px-1.5 py-0.5 text-10 text-fg-muted",
        tone,
      )}
    >
      {children}
    </span>
  );
}

// -- 应用 -------------------------------------------------------------------

export function ApplicationsList({
  center,
  onNew,
  onEdit,
  onDelete,
}: {
  center: DeploymentCenter;
  onNew: () => void;
  onEdit: (application: DeploymentApplication) => void;
  onDelete: (application: DeploymentApplication) => void;
}) {
  const { t } = useTranslation();
  const { applications } = center;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ListHeader
        title={t("Applications")}
        count={applications.length}
        action={
          <Button size="xs" variant="secondary" disabled={center.serverId === ""} onClick={onNew}>
            {t("New application")}
          </Button>
        }
      />
      {applications.length === 0 ? (
        <EmptyState
          title={
            center.serverId === "" ? t("Select a server first") : t("Create an application to get started")
          }
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {applications.map((application) => (
            <Row
              key={application.id}
              title={application.name}
              badges={
                <>
                  <Chip>{t(APPLICATION_KIND_LABELS[application.application_kind])}</Chip>
                  <Chip>{t(SOURCE_KIND_LABELS[application.source_kind])}</Chip>
                  {application.status === "archived" && <Chip>{t("Archived")}</Chip>}
                </>
              }
              detail={
                <>
                  {application.source_ref}
                  {application.description ? ` · ${application.description}` : ""}
                </>
              }
              actions={
                <>
                  <Button
                    size="xs"
                    variant={center.applicationId === application.id ? "secondary" : "ghost"}
                    onClick={() => center.setApplicationId(application.id)}
                  >
                    {center.applicationId === application.id ? t("Active") : t("Select an environment")}
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => onEdit(application)}>
                    {t("Edit")}
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => onDelete(application)}>
                    {t("Delete")}
                  </Button>
                </>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

// -- 环境 -------------------------------------------------------------------

export function EnvironmentsList({
  center,
  onNew,
  onEdit,
  onDelete,
}: {
  center: DeploymentCenter;
  onNew: () => void;
  onEdit: (environment: DeploymentEnvironment) => void;
  onDelete: (environment: DeploymentEnvironment) => void;
}) {
  const { t } = useTranslation();
  const { environments, applicationId } = center;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ListHeader
        title={t("Environments")}
        count={environments.length}
        action={
          <Button size="xs" variant="secondary" disabled={applicationId === ""} onClick={onNew}>
            {t("New environment")}
          </Button>
        }
      />
      {environments.length === 0 ? (
        <EmptyState
          title={
            applicationId === ""
              ? t("Select an application first")
              : t("Create an environment for this application first")
          }
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {environments.map((environment) => (
            <Row
              key={environment.id}
              title={environment.name}
              badges={
                <>
                  <Chip>{t(ENVIRONMENT_KIND_LABELS[environment.kind])}</Chip>
                  <Chip>{environment.deploy_root}</Chip>
                </>
              }
              detail={environment.notes || undefined}
              actions={
                <>
                  <Button
                    size="xs"
                    variant={center.environmentId === environment.id ? "secondary" : "ghost"}
                    onClick={() =>
                      center.setEnvironmentId(
                        center.environmentId === environment.id ? "" : environment.id,
                      )
                    }
                  >
                    {t("Filter by environment")}
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => onEdit(environment)}>
                    {t("Edit")}
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => onDelete(environment)}>
                    {t("Delete")}
                  </Button>
                </>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

// -- 服务 -------------------------------------------------------------------

export function ServicesList({
  center,
  confirmedProjects,
  onNew,
  onEdit,
  onDelete,
}: {
  center: DeploymentCenter;
  confirmedProjects: ConfirmedProject[];
  onNew: () => void;
  onEdit: (unit: DeploymentServiceUnit) => void;
  onDelete: (unit: DeploymentServiceUnit) => void;
}) {
  const { t } = useTranslation();
  const { services, environments, applicationId, environmentId } = center;
  const visible = environmentId === "" ? services : services.filter((unit) => unit.environment_id === environmentId);
  const environmentName = (id: string) => environments.find((item) => item.id === id)?.name ?? "—";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ListHeader
        title={t("Deploy services")}
        count={visible.length}
        action={
          <Button size="xs" variant="secondary" disabled={applicationId === ""} onClick={onNew}>
            {t("New service")}
          </Button>
        }
      />
      {visible.length === 0 ? (
        <EmptyState
          title={
            applicationId === ""
              ? t("Select an application first")
              : environments.length === 0
                ? t("Create an environment for this application first")
                : t("No services yet")
          }
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {visible.map((unit) => (
            <Fragment key={unit.id}>
              <Row
                title={unit.name}
                badges={
                  <>
                    <Chip>{environmentName(unit.environment_id)}</Chip>
                    <Chip>{t(SERVICE_ROLE_LABELS[unit.role])}</Chip>
                    <Chip>{t(SERVICE_KIND_LABELS[unit.service_kind])}</Chip>
                  </>
                }
                detail={
                  <>
                    {unit.deploy_path ?? "—"}
                    {unit.confirmed_project_path ? ` · ${unit.confirmed_project_path}` : ""}
                  </>
                }
                actions={
                  <>
                    <Button size="xs" variant="ghost" onClick={() => onEdit(unit)}>
                      {t("Edit")}
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => onDelete(unit)}>
                      {t("Delete")}
                    </Button>
                  </>
                }
              />
              {/* 已确认项目关联：改了立刻生效（走专用 IPC，不是普通保存）。 */}
              <div className="flex items-center gap-2 border-b border-line/60 bg-surface-2/40 px-3 py-1.5">
                <span className="shrink-0 text-10 text-fg-subtle">{t("Linked project")}</span>
                <select
                  className="h-6 min-w-0 flex-1 rounded-[6px] border border-line bg-surface-1/70 px-1 text-11 text-fg"
                  value={unit.confirmed_project_id ?? ""}
                  aria-label={t("Link a confirmed project")}
                  onChange={(event) => {
                    const project = confirmedProjects.find((item) => item.id === event.target.value);
                    if (!project) return;
                    void center.linkProject(unit.id, project.canonical_path, project.id);
                  }}
                >
                  <option value="">{t("No confirmed projects on this server")}</option>
                  {confirmedProjects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.canonical_path}
                    </option>
                  ))}
                </select>
                {unit.confirmed_project_id !== null && (
                  <Button size="xs" variant="ghost" onClick={() => void center.unlinkProject(unit.id)}>
                    {t("Unlink")}
                  </Button>
                )}
              </div>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

// -- 方案 -------------------------------------------------------------------

export function PlansList({
  center,
  onNew,
  onDelete,
}: {
  center: DeploymentCenter;
  onNew: () => void;
  onDelete: (plan: DeploymentPlan) => void;
}) {
  const { t } = useTranslation();
  const { plans, planGraph, applicationId } = center;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ListHeader
        title={t("Plans")}
        count={plans.length}
        action={
          <Button
            size="xs"
            variant="secondary"
            disabled={applicationId === "" || center.environmentId === ""}
            onClick={onNew}
          >
            {t("New plan")}
          </Button>
        }
      />
      {plans.length === 0 ? (
        <EmptyState title={applicationId === "" ? t("Select an application first") : t("No plans yet")} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {plans.map((plan) => (
            <Row
              key={plan.id}
              title={plan.name}
              badges={
                <>
                  <Chip tone={RISK_TONES[plan.risk_level]}>{t(RISK_LABELS[plan.risk_level])}</Chip>
                  <Chip>{`v${plan.version}`}</Chip>
                </>
              }
              detail={`${plan.status} · ${plan.proposal_source}`}
              actions={
                <>
                  <Button size="xs" variant="ghost" onClick={() => void center.openPlan(plan.id)}>
                    {t("Nodes")}
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => onDelete(plan)}>
                    {t("Delete")}
                  </Button>
                </>
              }
            />
          ))}
          {/* 方案详情：节点 + 连线（本阶段只读 —— 图编辑随工作流引擎一起来）。 */}
          {planGraph && plans.some((plan) => plan.id === planGraph.plan.id) && (
            <div className="border-t border-line px-3 py-2">
              <div className="mb-1.5 text-11 font-medium text-fg-muted">
                {planGraph.plan.name} · {t("Nodes")} {planGraph.nodes.length} · {t("Edges")}{" "}
                {planGraph.edges.length}
              </div>
              {planGraph.nodes.length === 0 ? (
                <p className="text-11 text-fg-subtle">{t("No nodes in this plan yet")}</p>
              ) : (
                <table className="w-full text-11">
                  <thead className="text-fg-subtle">
                    <tr className="text-left">
                      <th className="py-0.5 pr-2 font-medium">{t("Node key")}</th>
                      <th className="py-0.5 pr-2 font-medium">{t("Action")}</th>
                      <th className="py-0.5 pr-2 font-medium">{t("Risk level")}</th>
                      <th className="py-0.5 font-medium">{t("Approval required")}</th>
                    </tr>
                  </thead>
                  <tbody className="text-fg-muted">
                    {planGraph.nodes.map((node) => (
                      <tr key={node.id} className="border-t border-line/50">
                        <td className="py-0.5 pr-2 font-mono">{node.node_key}</td>
                        <td className="py-0.5 pr-2">{t(ACTION_LABELS[node.action])}</td>
                        <td className="py-0.5 pr-2">{t(RISK_LABELS[node.risk_level])}</td>
                        <td className="py-0.5">{node.approval_required ? t("Required") : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// -- 运行记录与版本 ---------------------------------------------------------

export function RunsList({ center }: { center: DeploymentCenter }) {
  const { t } = useTranslation();
  const { runs, releases, environmentId } = center;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ListHeader title={t("Runs")} count={runs.length} />
      {runs.length === 0 ? (
        <EmptyState
          title={t("No runs yet")}
          description={t("Runs appear here once the workflow engine executes a plan")}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {runs.map((run) => (
            <Row
              key={run.id}
              title={run.plan_id}
              badges={<Chip>{t(RUN_STATUS_LABELS[run.status])}</Chip>}
              detail={run.error_message ?? run.log.slice(0, 120) ?? undefined}
            />
          ))}
        </div>
      )}

      <div className="border-t border-line px-3 py-2">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-11 font-medium text-fg-muted">{t("Releases")}</span>
          <span className="rounded-full bg-surface-2 px-1.5 text-10 text-fg-subtle">
            {releases.length}
          </span>
        </div>
        {environmentId !== "" && releases.length === 0 && (
          <p className="text-11 text-fg-subtle">{t("No releases yet")}</p>
        )}
        {releases.map((release) => (
          <div key={release.id} className="flex items-center gap-2 py-0.5 text-11 text-fg-muted">
            <span className="font-mono">{release.version_label}</span>
            <span className={cn(release.is_active ? "text-accent" : "text-fg-subtle")}>
              {t(RELEASE_STATUS_LABELS[release.status])}
            </span>
            {release.image_digest && (
              <span className="truncate text-fg-subtle">{release.image_digest.slice(0, 24)}…</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
