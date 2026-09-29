/**
 * P5.0 部署中心 —— 基础页面。
 *
 * 五个 Tab：应用 / 环境 / 服务 / 方案 / 运行记录。本阶段的能力边界很明确：
 *
 * * **只读写本机 SQLite 模型**：应用、环境、服务的增删改，方案的建立与查看，
 *   运行记录与版本的只读浏览；
 * * **不执行任何部署**：没有"部署"按钮，没有 SSH 调用 —— 那属于工作流引擎
 *   （后续阶段）。页面顶部对此有一行明确说明，避免用户以为点了就会上线。
 * * **没有命令输入框**：服务的运行方式是结构化字段（systemd 单元名 / 镜像 +
 *   标签 + 端口 / 可执行文件 + 逐项参数），参数逐行输入、逐项校验。
 *
 * 所有 IPC 都经过 `opsApi`（见 `use-deployment-center.ts`），组件里不出现 `invoke`。
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { opsApi } from "@/api/ops-api";
import type { ConfirmedProject } from "@/api/types/project";
import type {
  DeploymentApplication,
  DeploymentEnvironment,
  DeploymentPlan,
  DeploymentServiceUnit,
} from "@/api/types/deployment";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { LoadingState } from "@/components/ui/loading";
import { ErrorText, selectClass } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import type { WorkspaceTab } from "@/workbench/types";

import { ArtifactImportPanel } from "./artifact-import";
import { ProposalPanel } from "./proposal-panel";
import { RunPanel } from "./run-panel";
import { ApplicationDialog, EnvironmentDialog, PlanDialog, ServiceDialog } from "./dialogs";
import { KnowledgePanel } from "./knowledge-panel";
import { ApplicationsList, EnvironmentsList, PlansList, RunsList, ServicesList } from "./lists";
import { newApplication, newEnvironment, newServiceUnit } from "./form";
import { useDeploymentCenter } from "./use-deployment-center";

type TabId =
  | "applications"
  | "environments"
  | "services"
  | "artifacts"
  | "proposal"
  | "knowledge"
  | "execute"
  | "plans"
  | "runs";

const TAB_ORDER: TabId[] = [
  "applications",
  "environments",
  "services",
  "artifacts",
  "proposal",
  "knowledge",
  "execute",
  "plans",
  "runs",
];

const TAB_LABEL_KEYS: Record<TabId, string> = {
  applications: "Applications",
  environments: "Environments",
  services: "Deploy services",
  artifacts: "Artifacts",
  proposal: "Proposal",
  knowledge: "Knowledge base",
  execute: "Deploy run",
  plans: "Plans",
  runs: "Runs",
};

/** 待确认的删除动作（确认框里要能说清"删掉它会连带失去什么"）。 */
type PendingDelete =
  | { kind: "application"; id: string; name: string }
  | { kind: "environment"; id: string; name: string }
  | { kind: "service"; id: string; name: string }
  | { kind: "plan"; id: string; name: string };

export function DeployView({ tab }: { tab: WorkspaceTab }) {
  const { t } = useTranslation();
  const center = useDeploymentCenter();
  const [activeTab, setActiveTab] = useState<TabId>("applications");
  const [applicationDraft, setApplicationDraft] = useState<DeploymentApplication | null>(null);
  const [environmentDraft, setEnvironmentDraft] = useState<DeploymentEnvironment | null>(null);
  const [serviceDraft, setServiceDraft] = useState<DeploymentServiceUnit | null>(null);
  const [planDialogOpen, setPlanDialogOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [confirmedProjects, setConfirmedProjects] = useState<ConfirmedProject[]>([]);

  const selectedApplication =
    center.applications.find((application) => application.id === center.applicationId) ?? null;
  const activeEnvironment =
    center.environments.find((environment) => environment.id === center.environmentId) ?? null;

  /** 已确认项目（用于把服务关联到 P3.8 的项目资产）。 */
  useEffect(() => {
    let cancelled = false;
    if (center.serverId === "") {
      setConfirmedProjects([]);
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      try {
        const projects = await opsApi.projectConfirmedList(center.serverId);
        if (!cancelled) setConfirmedProjects(projects);
      } catch {
        // 项目资产读不到不影响部署中心本身：留空即可，不打断用户。
        if (!cancelled) setConfirmedProjects([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [center.serverId]);

  /** 切换应用时回到"应用已被选中"的第一个有意义 Tab。 */
  useEffect(() => {
    if (center.applicationId !== "" && activeTab === "applications") setActiveTab("environments");
    if (center.applicationId === "") setActiveTab("applications");
    // 只在选择变化时跳转，用户手动切 Tab 不干预。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center.applicationId]);

  /** 制品标签的计数由导入面板自己维护，所以这里是可缺省的。 */
  const counts: Partial<Record<TabId, number>> = {
    applications: center.applications.length,
    environments: center.environments.length,
    services: center.services.length,
    plans: center.plans.length,
    runs: center.runs.length,
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    switch (target.kind) {
      case "application": {
        await center.deleteApplication(target.id);
        break;
      }
      case "environment": {
        await center.deleteEnvironment(target.id);
        break;
      }
      case "service": {
        await center.deleteService(target.id);
        break;
      }
      case "plan": {
        await center.deletePlan(target.id);
        break;
      }
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1">
      {/* 页头：服务器选择 + 本阶段边界说明。 */}
      <div className="flex shrink-0 items-start gap-3 border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-13 font-semibold text-fg">{t("Deployment Center")}</span>
            <span className="rounded-[5px] border border-line bg-surface-2 px-1.5 py-0.5 text-10 text-fg-subtle">
              {t("Read-only in this stage")}
            </span>
          </div>
          <p className="mt-0.5 text-11 leading-relaxed text-fg-muted">
            {t(
              "Plan applications, environments and services. Nothing is executed in this stage — execution arrives with the workflow engine.",
            )}
          </p>
        </div>
        <label className="flex shrink-0 items-center gap-2">
          <span className="text-11 text-fg-muted">{tab.title}</span>
          <select
            className={cn(selectClass, "w-52")}
            value={center.serverId}
            aria-label={t("Select a server first")}
            onChange={(event) => center.setServerId(event.target.value)}
          >
            <option value="">{t("Select a server first")}</option>
            {center.servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.name} · {server.host}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Tab 条 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1">
        {TAB_ORDER.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            aria-current={activeTab === id ? "page" : undefined}
            className={cn(
              "flex items-center gap-1.5 rounded-[7px] px-2 py-1 text-12 transition-colors",
              activeTab === id
                ? "bg-surface-2 text-fg"
                : "text-fg-muted hover:bg-surface-hover hover:text-fg",
            )}
          >
            {t(TAB_LABEL_KEYS[id])}
            {counts[id] === undefined ? null : (
              <span className="rounded-full bg-surface-3 px-1.5 text-10 text-fg-subtle">
                {counts[id]}
              </span>
            )}
          </button>
        ))}
        {selectedApplication && (
          <span className="ml-auto truncate pr-1 text-11 text-fg-subtle">
            {selectedApplication.name}
            {activeEnvironment ? ` · ${activeEnvironment.name}` : ""}
          </span>
        )}
      </div>

      {center.error && (
        <div className="shrink-0 px-3 pt-2" onClick={center.clearError} role="presentation">
          <ErrorText>{center.error}</ErrorText>
        </div>
      )}

      {center.status.state === "loading" && center.applications.length === 0 ? (
        <LoadingState />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col pt-2">
          {activeTab === "applications" && (
            <ApplicationsList
              center={center}
              onNew={() => setApplicationDraft(newApplication(center.serverId))}
              onEdit={(application) => setApplicationDraft(application)}
              onDelete={(application) =>
                setPendingDelete({
                  kind: "application",
                  id: application.id,
                  name: application.name,
                })
              }
            />
          )}

          {activeTab === "environments" && (
            <EnvironmentsList
              center={center}
              onNew={() =>
                selectedApplication && setEnvironmentDraft(newEnvironment(selectedApplication))
              }
              onEdit={(environment) => setEnvironmentDraft(environment)}
              onDelete={(environment) =>
                setPendingDelete({
                  kind: "environment",
                  id: environment.id,
                  name: environment.name,
                })
              }
            />
          )}

          {activeTab === "services" && (
            <ServicesList
              center={center}
              confirmedProjects={confirmedProjects}
              onNew={() => {
                const environmentId = center.environmentId || center.environments[0]?.id || "";
                setServiceDraft(newServiceUnit(center.applicationId, environmentId));
              }}
              onEdit={(unit) => setServiceDraft(unit)}
              onDelete={(unit) =>
                setPendingDelete({ kind: "service", id: unit.id, name: unit.name })
              }
            />
          )}

          {activeTab === "artifacts" && (
            <ArtifactImportPanel
              serverId={center.serverId}
              applicationId={center.applicationId}
              environmentId={center.environmentId}
              environments={center.environments}
              onChanged={() => void center.reload()}
            />
          )}

          {activeTab === "proposal" && (
            <ProposalPanel
              applicationId={center.applicationId}
              environmentId={center.environmentId}
              // 部署中心不持有终端会话：没有实时探测时就退回最近一次扫描的
              // 能力缓存，方案会如实标注"该能力未探测"。
              sessionId={null}
              onConfirmed={() => void center.reload()}
            />
          )}

          {activeTab === "knowledge" && (
            <KnowledgePanel
              applicationId={center.applicationId}
              environmentId={center.environmentId}
            />
          )}

          {activeTab === "execute" && (
            <RunPanel
              applicationId={center.applicationId}
              environmentId={center.environmentId}
              // 与方案页一致：部署中心不持有终端会话，面板会退回到"该服务器上
              // 任意一个已连接的会话"（没有连接时会明确禁止开始）。
              sessionId={null}
              onChanged={() => void center.reload()}
            />
          )}

          {activeTab === "plans" && (
            <PlansList
              center={center}
              onNew={() => setPlanDialogOpen(true)}
              onDelete={(plan: DeploymentPlan) =>
                setPendingDelete({ kind: "plan", id: plan.id, name: plan.name })
              }
            />
          )}

          {activeTab === "runs" && <RunsList center={center} />}
        </div>
      )}

      <ApplicationDialog
        open={applicationDraft && applicationDraft.id !== "" ? applicationDraft : null}
        draft={applicationDraft}
        onCancel={() => setApplicationDraft(null)}
        onSubmit={async (application) => {
          if (await center.saveApplication(application)) setApplicationDraft(null);
        }}
      />

      <EnvironmentDialog
        open={environmentDraft && environmentDraft.id !== "" ? environmentDraft : null}
        draft={environmentDraft}
        application={selectedApplication}
        onCancel={() => setEnvironmentDraft(null)}
        onSubmit={async (environment) => {
          if (await center.saveEnvironment(environment)) setEnvironmentDraft(null);
        }}
      />

      <ServiceDialog
        open={serviceDraft && serviceDraft.id !== "" ? serviceDraft : null}
        draft={serviceDraft}
        environments={center.environments}
        onCancel={() => setServiceDraft(null)}
        onSubmit={async (unit) => {
          if (await center.saveService(unit)) setServiceDraft(null);
        }}
      />

      <PlanDialog
        open={planDialogOpen}
        onCancel={() => setPlanDialogOpen(false)}
        onSubmit={async (name) => {
          if (await center.createPlan(name)) setPlanDialogOpen(false);
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        danger
        title={t("Delete {{name}}?", { name: pendingDelete?.name ?? "" })}
        description={
          pendingDelete?.kind === "application"
            ? t("Deleting an application also removes its environments, services, plans, runs and releases.")
            : pendingDelete?.kind === "environment"
              ? t("Deleting an environment also removes its services, plans, domains, capacity data and releases.")
              : pendingDelete?.kind === "service"
                ? t("Deleting a service also removes its relations with other services.")
                : t("Read-only in this stage")
        }
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
