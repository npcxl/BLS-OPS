/**
 * 项目与部署 (P3-2.2, P3-2.3, P3-3.5).
 *
 * A project is a deployment target: one directory on one server plus the steps
 * that publish to it. Steps are validated by Rust before they are stored
 * (allowlisted programs, no shell operators, no paths outside `deploy_path`),
 * and re-validated at run time — the WebView only ever sends a project id.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  AlertOctagon,
  Check,
  FolderTree,
  GitBranch,
  Loader2,
  Pencil,
  Plus,
  Rocket,
  ScrollText,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { Field, Modal, fieldClass } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import {
  deployStatusLabel,
  opsApi,
  projectSteps,
  toErrorMessage,
  type DeploymentRecord,
  type ProjectRecord,
} from "@/api/ops-api";
import { useCommandSession } from "@/hooks/use-command-session";
import { useDomainStore } from "@/stores/domain-store";
import { ModuleEmpty, ModuleFrame, RefreshButton } from "@/workbench/views/module-frame";
import type { WorkspaceTab } from "@/workbench/types";

export function ProjectView({ tab }: { tab: WorkspaceTab }) {
  const session = useCommandSession(tab);

  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<ProjectRecord | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ProjectRecord | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [liveLog, setLiveLog] = useState<{ id: string; name: string; text: string } | null>(null);
  const [viewLog, setViewLog] = useState<DeploymentRecord | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, history] = await Promise.all([
        opsApi.projectList(),
        opsApi.deploymentList(undefined, 50),
      ]);
      setProjects(list);
      setDeployments(history);
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const execute = useCallback(
    async (project: ProjectRecord) => {
      if (!session.ready) {
        setError("SSH 会话未连接，请先连接服务器");
        return;
      }
      setRunning(project.id);
      setError(null);

      // The id is generated here so the subscription is live *before* the run
      // starts; otherwise the first steps' output would be emitted before
      // anyone was listening.
      const deploymentId = crypto.randomUUID();
      const event = `deploy-progress-${deploymentId}`;
      setLiveLog({ id: deploymentId, name: project.name, text: "正在启动部署…\n" });

      const unlisten = await listen<string>(event, (message) => {
        setLiveLog((current) =>
          current && current.id === deploymentId
            ? { ...current, text: message.payload }
            : current,
        );
      });

      try {
        const record = await opsApi.deploymentExecute({
          projectId: project.id,
          sessionId: session.sessionId,
          deploymentId,
        });
        setLiveLog({
          id: record.id,
          name: project.name,
          text: record.log || "（部署没有产生输出）",
        });
      } catch (cause) {
        setError(toErrorMessage(cause));
        setLiveLog(null);
      } finally {
        unlisten();
        setRunning(null);
        void refresh();
      }
    },
    [refresh, session.ready, session.sessionId],
  );

  const menu = useContextMenu();
  const projectMenu = (project: ProjectRecord) =>
    menu.onContextMenu(() => [
      {
        id: "deploy",
        label: "执行部署",
        icon: Rocket,
        disabled: !session.ready || running !== null,
        onSelect: () => void execute(project),
      },
      { id: "edit", label: "编辑项目", icon: Pencil, onSelect: () => openEditor(project) },
      { id: "sep", separator: true },
      {
        id: "delete",
        label: "删除项目",
        icon: Trash2,
        danger: true,
        onSelect: () => setPendingDelete(project),
      },
    ]);

  const openEditor = (project: ProjectRecord | null) => {
    setEditing(project ?? emptyProject());
    setDialogOpen(true);
  };

  const serverName = (id: string) =>
    useDomainStore.getState().servers.find((server) => server.id === id)?.name ?? id;

  return (
    <ModuleFrame
      tab={tab}
      session={session}
      icon={FolderTree}
      toolbar={
        <>
          <RefreshButton busy={loading} onClick={() => void refresh()} />
          <div className="mx-1 h-4 w-px bg-line" />
          <Button variant="ghost" size="xs" onClick={() => openEditor(null)}>
            <Plus size={12} />
            新建项目
          </Button>
          <span className="ml-auto text-11 text-fg-subtle">
            {projects.length} 个项目 · 最近 {deployments.length} 次部署
          </span>
        </>
      }
    >
      {error && (
        <div className="mx-3 mt-3 rounded-[8px] border border-danger/30 bg-danger/10 px-3 py-2 text-12 text-danger">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-4 p-3">
        <section>
          <h3 className="mb-2 text-11 font-semibold tracking-[0.06em] text-fg-subtle uppercase">
            项目
          </h3>
          {projects.length === 0 ? (
            <ModuleEmpty
              icon={FolderTree}
              title="还没有任何项目"
              hint="新建项目来保存部署目标与部署步骤，之后就能一键执行部署。"
            />
          ) : (
            <div className="overflow-hidden rounded-[10px] border border-line bg-surface-1">
              {projects.map((project) => (
                <ProjectRow
                  key={project.id}
                  project={project}
                  serverName={serverName(project.server_id)}
                  running={running === project.id}
                  canDeploy={session.ready && running === null}
                  onContextMenu={projectMenu(project)}
                  onDeploy={() => void execute(project)}
                  onEdit={() => openEditor(project)}
                />
              ))}
            </div>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-11 font-semibold tracking-[0.06em] text-fg-subtle uppercase">
            部署历史
          </h3>
          {deployments.length === 0 ? (
            <ModuleEmpty icon={ScrollText} title="还没有部署记录" />
          ) : (
            <div className="overflow-hidden rounded-[10px] border border-line bg-surface-1">
              {deployments.map((deployment) => (
                <DeploymentRow
                  key={deployment.id}
                  deployment={deployment}
                  onViewLog={() => setViewLog(deployment)}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      <ContextMenu {...menu.props} title={pendingDelete?.name} />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`删除项目 ${pendingDelete?.name ?? ""}`}
        description={`确定删除项目“${pendingDelete?.name ?? ""}”？它的全部部署历史也会一并删除，此操作不可撤销。`}
        confirmLabel="删除"
        danger
        onConfirm={async () => {
          if (!pendingDelete) return;
          try {
            await opsApi.projectDelete(pendingDelete.id);
          } catch (cause) {
            setError(toErrorMessage(cause));
          }
          setPendingDelete(null);
          void refresh();
        }}
        onCancel={() => setPendingDelete(null)}
      />

      {dialogOpen && editing && (
        <ProjectDialog
          project={editing}
          onClose={() => setDialogOpen(false)}
          onSaved={() => {
            setDialogOpen(false);
            void refresh();
          }}
        />
      )}

      {liveLog && (
        <LogOverlay
          title={`正在部署 ${liveLog.name}`}
          text={liveLog.text}
          busy
          onClose={() => setLiveLog(null)}
        />
      )}

      {viewLog && (
        <LogOverlay
          title={`部署记录 · ${viewLog.project_name}`}
          text={viewLog.log || "（没有输出）"}
          error={viewLog.error_message}
          onClose={() => setViewLog(null)}
        />
      )}
    </ModuleFrame>
  );
}

function ProjectRow({
  project,
  serverName,
  running,
  canDeploy,
  onContextMenu,
  onDeploy,
  onEdit,
}: {
  project: ProjectRecord;
  serverName: string;
  running: boolean;
  canDeploy: boolean;
  onContextMenu: (event: React.MouseEvent) => void;
  onDeploy: () => void;
  onEdit: () => void;
}) {
  const steps = projectSteps(project);
  const tone =
    project.status === "failed"
      ? "text-danger"
      : project.status === "success"
        ? "text-success"
        : project.status === "running"
          ? "text-accent"
          : "text-fg-subtle";

  return (
    <div
      className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0 hover:bg-surface-hover"
      onContextMenu={onContextMenu}
      onDoubleClick={onEdit}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-12 text-fg">{project.name}</span>
          <span className={cn("shrink-0 text-11", tone)}>{project.status}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2 truncate text-11 text-fg-subtle">
          <span>{serverName}</span>
          <span className="text-line-strong">|</span>
          <span className="font-mono">{project.deploy_path}</span>
          {project.branch && (
            <>
              <span className="text-line-strong">|</span>
              <span className="flex items-center gap-1">
                <GitBranch size={10} />
                {project.branch}
              </span>
            </>
          )}
        </div>
        <div className="mt-1 truncate text-10 text-fg-subtle">
          {steps.length} 个步骤：{steps.join(" · ") || "—"}
        </div>
      </div>
      <Button variant="ghost" size="xs" onClick={onDeploy} disabled={!canDeploy}>
        {running ? <Loader2 size={12} className="animate-spin" /> : <Rocket size={12} />}
        {running ? "部署中" : "部署"}
      </Button>
    </div>
  );
}

function DeploymentRow({
  deployment,
  onViewLog,
}: {
  deployment: DeploymentRecord;
  onViewLog: () => void;
}) {
  const tone =
    deployment.status === "failed"
      ? "text-danger"
      : deployment.status === "success"
        ? "text-success"
        : "text-accent";

  const when = deployment.started_at
    ? new Date(deployment.started_at).toLocaleString(undefined, { hour12: false })
    : "—";

  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 border-b border-line px-3 py-2 text-left last:border-b-0 hover:bg-surface-hover"
      onClick={onViewLog}
    >
      <span className={cn("w-[48px] shrink-0 text-11", tone)}>
        {deployStatusLabel(deployment.status)}
      </span>
      <span className="min-w-0 flex-1 truncate text-12 text-fg">
        {deployment.project_name}
        {deployment.error_message && (
          <span className="ml-2 text-11 text-danger">{deployment.error_message}</span>
        )}
      </span>
      <span className="shrink-0 text-11 text-fg-subtle">{when}</span>
      <span className="w-[64px] shrink-0 text-right text-11 text-fg-subtle">
        {deployment.duration_ms === null ? "—" : `${(deployment.duration_ms / 1000).toFixed(1)}s`}
      </span>
    </button>
  );
}

/** Full-screen log overlay, used for both a running deploy and past records. */
function LogOverlay({
  title,
  text,
  error,
  busy = false,
  onClose,
}: {
  title: string;
  text: string;
  error?: string | null;
  busy?: boolean;
  onClose: () => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [text]);

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-app/85 backdrop-blur-sm">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-surface-1 px-3">
        {busy ? (
          <Loader2 size={13} className="shrink-0 animate-spin text-accent" />
        ) : (
          <ScrollText size={13} className="shrink-0 text-fg-subtle" />
        )}
        <span className="text-12 font-semibold text-fg">{title}</span>
        <Button variant="ghost" size="xs" className="ml-auto" onClick={onClose}>
          关闭
        </Button>
      </div>
      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-danger/30 bg-danger/10 px-3 py-2 text-11 text-danger">
          <AlertOctagon size={12} className="shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
        </div>
      )}
      <pre className="flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-11 leading-relaxed text-fg-muted">
        {text}
      </pre>
      <div ref={endRef} />
    </div>
  );
}

// -- Editor ------------------------------------------------------------------

export function emptyProject(): ProjectRecord {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: "",
    description: "",
    server_id: "",
    repo_url: "",
    branch: "main",
    deploy_path: "",
    commands_json: '["git pull --ff-only"]',
    status: "idle",
    created_at: now,
    updated_at: now,
  };
}

function ProjectDialog({
  project,
  onClose,
  onSaved,
}: {
  project: ProjectRecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const servers = useDomainStore((s) => s.servers);
  const [draft, setDraft] = useState<ProjectRecord>(project);
  /** Steps are edited as lines; serialising happens on save. */
  const [stepsText, setStepsText] = useState(projectSteps(project).join("\n"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = (next: Partial<ProjectRecord>) => setDraft((prev) => ({ ...prev, ...next }));

  const save = async () => {
    setSaving(true);
    setError(null);
    const steps = stepsText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    let commandsJson: string;
    try {
      commandsJson = JSON.stringify(steps);
    } catch {
      setError("部署步骤无法序列化");
      setSaving(false);
      return;
    }

    try {
      await opsApi.projectSave({
        ...draft,
        name: draft.name.trim(),
        deploy_path: draft.deploy_path.trim(),
        branch: draft.branch.trim(),
        repo_url: draft.repo_url.trim(),
        commands_json: commandsJson,
        updated_at: Date.now(),
      });
      onSaved();
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      width={520}
      title={project.name ? `编辑项目 · ${project.name}` : "新建项目"}
      description="部署步骤会被后端校验：只允许白名单内的命令，且不能引用项目目录之外的路径。"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="sm" disabled={saving} onClick={() => void save()}>
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <ErrorTextFor message={error} />}

        <Field label="项目名称">
          <input
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
            placeholder="my-app"
            className={fieldClass}
          />
        </Field>

        <Field label="部署服务器">
          <select
            value={draft.server_id}
            onChange={(event) => patch({ server_id: event.target.value })}
            className={fieldClass}
          >
            <option value="">选择服务器…</option>
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.name}（{server.username}@{server.host}）
              </option>
            ))}
          </select>
        </Field>

        <Field label="服务器上的部署目录" hint="必须是绝对路径，部署步骤不能访问它之外的路径">
          <input
            value={draft.deploy_path}
            onChange={(event) => patch({ deploy_path: event.target.value })}
            placeholder="/var/www/my-app"
            className={fieldClass}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="仓库地址（可选）">
            <input
              value={draft.repo_url}
              onChange={(event) => patch({ repo_url: event.target.value })}
              placeholder="https://github.com/acme/app.git"
              className={fieldClass}
            />
          </Field>
          <Field label="分支（可选）">
            <input
              value={draft.branch}
              onChange={(event) => patch({ branch: event.target.value })}
              placeholder="main"
              className={fieldClass}
            />
          </Field>
        </div>

        <Field label="部署步骤" hint="每行一条，按顺序执行；任一失败即中止">
          <textarea
            value={stepsText}
            onChange={(event) => setStepsText(event.target.value)}
            rows={5}
            spellCheck={false}
            placeholder={"git pull --ff-only\nnpm ci\nnpm run build"}
            className={cn(fieldClass, "resize-none font-mono leading-relaxed")}
          />
        </Field>

        <Field label="描述（可选）">
          <input
            value={draft.description}
            onChange={(event) => patch({ description: event.target.value })}
            placeholder="这个部署做什么"
            className={fieldClass}
          />
        </Field>
      </div>
    </Modal>
  );
}

function ErrorTextFor({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-[8px] border border-danger/30 bg-danger/10 px-3 py-2 text-12 text-danger">
      <TriangleAlert size={13} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
    </div>
  );
}
