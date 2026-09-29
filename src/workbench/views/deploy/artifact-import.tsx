/**
 * P5.1 制品导入面板。
 *
 * 与 P5.0 页面同一套纪律：**所有 IPC 都经过 `opsApi`**，组件里不出现 `invoke`；
 * 页面不提供任何"命令输入框"，运行方式始终是结构化字段。
 *
 * 三块内容，顺序就是用户的操作顺序：
 *
 * 1. **选来源并开始导入** —— 本地文件夹 / 本地文件 / 服务器已有目录 / 镜像引用。
 *    分析全程只读（+ 服务器目录只读列目录），不执行、不解压落盘。
 * 2. **识别结果** —— 指纹口径、安全结论（只有脱敏证据）、多服务候选。
 *    有阻断项时确认按钮直接禁用，并把原因写在旁边。
 * 3. **制品** —— 每个服务一件制品；上传走 `.part` + 哈希校验 + 原子改名。
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { opsApi, toErrorMessage } from "@/api/ops-api";
import type {
  ArtifactImportSource,
  ArtifactImportTask,
  ArtifactKind,
  ArtifactRecord,
  DeploymentEnvironment,
} from "@/api/ops-api";
import { ErrorText, selectClass } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import { artifactImportEvent } from "@/lib/events";

import {
  ARTIFACT_KIND_LABELS,
  ARTIFACT_SOURCE_LABELS,
  ARTIFACT_STATUS_LABELS,
  CHECK_STATE_LABELS,
  FINDING_KIND_LABELS,
  FINDING_SEVERITY_LABELS,
  FINGERPRINT_BASIS_LABELS,
  IMPORT_STAGE_LABELS,
  IMPORT_STATUS_LABELS,
  SERVICE_KIND_LABELS,
  SERVICE_ROLE_LABELS,
} from "./labels";

type SourceKind = ArtifactImportSource["kind"];

const SOURCE_ORDER: SourceKind[] = [
  "local_folder",
  "local_archive",
  "local_file",
  "remote_directory",
  "docker_image_ref",
];

/** 本地文件来源要在创建任务时声明制品类型（后端据此决定怎么读）。 */
const LOCAL_FILE_KINDS: ArtifactKind[] = [
  "zip",
  "tar",
  "tar_gz",
  "jar",
  "binary",
  "dockerfile",
  "compose_file",
];

const SEVERITY_TONES: Record<string, string> = {
  info: "border-line bg-surface-2 text-fg-muted",
  low: "border-line bg-surface-2 text-fg-muted",
  medium: "border-amber-400/40 bg-amber-400/10 text-amber-600",
  high: "border-orange-500/40 bg-orange-500/10 text-orange-600",
  critical: "border-danger/50 bg-danger/10 text-danger",
};

/** 任务是否还在推进（决定要不要轮询）。 */
function isRunning(task: ArtifactImportTask): boolean {
  return task.status === "pending" || task.status === "running";
}

export interface ArtifactImportPanelProps {
  serverId: string;
  applicationId: string;
  environmentId: string;
  environments: DeploymentEnvironment[];
  /** 确认导入后通知父级刷新服务与制品列表。 */
  onChanged: () => void;
}

export function ArtifactImportPanel({
  serverId,
  applicationId,
  environmentId,
  environments,
  onChanged,
}: ArtifactImportPanelProps) {
  const { t } = useTranslation();
  const [sourceKind, setSourceKind] = useState<SourceKind>("local_folder");
  const [path, setPath] = useState("");
  const [fileKind, setFileKind] = useState<ArtifactKind>("zip");
  const [reference, setReference] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [tasks, setTasks] = useState<ArtifactImportTask[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [versionLabel, setVersionLabel] = useState("");
  const [uploadDir, setUploadDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [targetEnvironmentId, setTargetEnvironmentId] = useState(environmentId);

  const pending = useMemo(
    () => tasks.find((task) => task.stage === "awaiting_confirmation") ?? null,
    [tasks],
  );

  const reload = useCallback(async () => {
    if (applicationId === "") {
      setTasks([]);
      setArtifacts([]);
      return;
    }
    try {
      const [nextTasks, nextArtifacts] = await Promise.all([
        opsApi.deploymentArtifactImportList(applicationId),
        opsApi.deploymentArtifactList(applicationId),
      ]);
      setTasks(nextTasks);
      setArtifacts(nextArtifacts);
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  }, [applicationId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    setTargetEnvironmentId(environmentId);
  }, [environmentId]);

  /** 有任务在跑就轮询一次状态（事件是主路径，轮询只是兜底，避免漏事件后卡住）。 */
  const runningIds = tasks
    .filter(isRunning)
    .map((task) => task.id)
    .join(",");
  useEffect(() => {
    if (runningIds === "") return;
    const ids = runningIds.split(",");
    const timer = window.setInterval(() => {
      void (async () => {
        const updates = await Promise.all(
          ids.map((id) => opsApi.deploymentArtifactImportStatus(id).catch(() => null)),
        );
        setTasks((previous) =>
          previous.map((task) => updates.find((next) => next?.id === task.id) ?? task),
        );
      })();
    }, 800);
    return () => window.clearInterval(timer);
  }, [runningIds]);

  /** 事件流：任务进度由后端推进（`artifactImportEvent`），拿不到也不影响功能。 */
  const taskIdKey = tasks.map((task) => task.id).join(",");
  useEffect(() => {
    if (taskIdKey === "") return;
    let disposed = false;
    const stops: Array<() => void> = [];
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        for (const id of taskIdKey.split(",")) {
          const stop = await listen<ArtifactImportTask>(artifactImportEvent(id), (event) => {
            setTasks((previous) =>
              previous.map((task) => (task.id === event.payload.id ? event.payload : task)),
            );
          });
          if (disposed) {
            stop();
            return;
          }
          stops.push(stop);
        }
      } catch {
        // 事件不可用（例如浏览器里跑测试）时静默降级为轮询。
      }
    })();
    return () => {
      disposed = true;
      for (const stop of stops) stop();
    };
  }, [taskIdKey]);

  const browse = async (directory: boolean) => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory, multiple: false });
      if (typeof picked === "string") setPath(picked);
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  };

  /** 服务器目录要在导入期间借用一条只读的监控会话。 */
  const withSession = async <T,>(run: (sessionId: string) => Promise<T>): Promise<T> => {
    if (serverId === "") throw new Error(t("Connect the server first"));
    const sessionId = `artifact-import-${crypto.randomUUID()}`;
    await opsApi.sshConnectMonitor({ sessionId, serverId });
    try {
      return await run(sessionId);
    } finally {
      await opsApi.sshDisconnect(sessionId).catch(() => undefined);
    }
  };

  const startImport = async () => {
    if (applicationId === "") return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const source: ArtifactImportSource =
        sourceKind === "local_folder"
          ? { kind: "local_folder", path }
          : sourceKind === "local_archive"
            ? { kind: "local_archive", path }
            : sourceKind === "local_file"
              ? { kind: "local_file", path, artifact_kind: fileKind }
              : sourceKind === "docker_image_ref"
                ? { kind: "docker_image_ref", reference }
                : { kind: "remote_directory", server_id: serverId, path: remotePath };

      const created =
        source.kind === "remote_directory"
          ? await withSession((sessionId) =>
              opsApi.deploymentArtifactImportStart({
                application_id: applicationId,
                service_unit_id: null,
                source,
                session_id: sessionId,
              }),
            )
          : await opsApi.deploymentArtifactImportStart({
              application_id: applicationId,
              service_unit_id: null,
              source,
              session_id: null,
            });
      setTasks((previous) => [created, ...previous.filter((task) => task.id !== created.id)]);
      setSelected({});
      setVersionLabel("");
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const cancelTask = async (task: ArtifactImportTask) => {
    try {
      await opsApi.deploymentArtifactImportCancel(task.id);
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  };

  const retryTask = async (task: ArtifactImportTask) => {
    try {
      const next = await opsApi.deploymentArtifactImportRetry(task.id);
      setTasks((previous) => previous.map((item) => (item.id === next.id ? next : item)));
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  };

  const confirmImport = async () => {
    if (!pending || !pending.inspection) return;
    setError(null);
    const chosen = pending.inspection.services
      .filter((candidate) => selected[candidate.id])
      .map((candidate) => candidate.id);
    setBusy(true);
    try {
      const outcome = await opsApi.deploymentArtifactImportConfirm({
        task_id: pending.id,
        application_id: applicationId,
        environment_id: targetEnvironmentId,
        selected_service_ids: chosen,
        version_label: versionLabel.trim() === "" ? null : versionLabel.trim(),
      });
      setNotice(t("Services created from the artifact"));
      setTasks((previous) =>
        previous.map((task) =>
          task.id === pending.id ? { ...task, stage: "done", artifact_id: outcome.artifacts[0]?.id ?? null } : task,
        ),
      );
      setArtifacts((previous) => [...outcome.artifacts, ...previous]);
      onChanged();
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const uploadArtifact = async (artifact: ArtifactRecord) => {
    setError(null);
    if (uploadDir.trim() === "") return;
    setBusy(true);
    try {
      const updated = await withSession((sessionId) =>
        opsApi.deploymentArtifactUpload(artifact.id, sessionId, uploadDir.trim()),
      );
      setArtifacts((previous) =>
        previous.map((item) => (item.id === updated.id ? updated : item)),
      );
      onChanged();
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-3">
      {/* ---- 来源 ---- */}
      <section className="rounded-[8px] border border-line bg-surface-1 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-12 font-semibold text-fg">{t("Import artifact")}</span>
          <span className="text-10 text-fg-subtle">
            {t("Only local files are analysed; nothing is executed")}
          </span>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5">
            <span className="text-11 text-fg-muted">{t("Source type")}</span>
            <select
              className={cn(selectClass, "w-40")}
              value={sourceKind}
              onChange={(event) => setSourceKind(event.target.value as SourceKind)}
            >
              {SOURCE_ORDER.map((kind) => (
                <option key={kind} value={kind}>
                  {t(SOURCE_LABEL_KEYS[kind])}
                </option>
              ))}
            </select>
          </label>

          {sourceKind === "docker_image_ref" ? (
            <label className="flex min-w-56 flex-1 items-center gap-1.5">
              <span className="text-11 text-fg-muted">{t("Image reference")}</span>
              <input
                className={cn(selectClass, "flex-1")}
                value={reference}
                placeholder="registry.example.com/shop/api:1.4.0"
                onChange={(event) => setReference(event.target.value)}
              />
            </label>
          ) : (
            <label className="flex min-w-56 flex-1 items-center gap-1.5">
              <span className="text-11 text-fg-muted">
                {sourceKind === "remote_directory"
                  ? t("Server directory path")
                  : t("Local path")}
              </span>
              <input
                className={cn(selectClass, "flex-1")}
                value={sourceKind === "remote_directory" ? remotePath : path}
                placeholder={sourceKind === "remote_directory" ? "/opt/shop" : "/path/to/artifact"}
                onChange={(event) =>
                  sourceKind === "remote_directory"
                    ? setRemotePath(event.target.value)
                    : setPath(event.target.value)
                }
              />
            </label>
          )}

          {sourceKind === "local_folder" || sourceKind === "local_file" ? (
            <button
              type="button"
              className="rounded-[7px] border border-line px-2 py-1 text-11 text-fg-muted hover:bg-surface-hover hover:text-fg"
              onClick={() => void browse(sourceKind === "local_folder")}
            >
              {t("Browse")}
            </button>
          ) : null}

          {sourceKind === "local_file" ? (
            <label className="flex items-center gap-1.5">
              <span className="text-11 text-fg-muted">{t("Type")}</span>
              <select
                className={cn(selectClass, "w-36")}
                value={fileKind}
                onChange={(event) => setFileKind(event.target.value as ArtifactKind)}
              >
                {LOCAL_FILE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(ARTIFACT_KIND_LABELS[kind])}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <button
            type="button"
            disabled={busy || applicationId === ""}
            onClick={() => void startImport()}
            className="rounded-[7px] bg-accent px-3 py-1 text-11 font-medium text-white disabled:opacity-50"
          >
            {t("Start import")}
          </button>
        </div>

        {sourceKind === "remote_directory" ? (
          <p className="mt-1.5 text-10 text-fg-subtle">
            {t("Server directory needs a live SSH session")}
          </p>
        ) : null}
      </section>

      {error ? <ErrorText>{error}</ErrorText> : null}
      {notice ? <p className="text-11 text-fg-muted">{notice}</p> : null}

      {/* ---- 任务 ---- */}
      <section className="rounded-[8px] border border-line bg-surface-1">
        <div className="border-b border-line px-3 py-1.5 text-11 font-medium text-fg-muted">
          {t("Import tasks")}
        </div>
        {tasks.length === 0 ? (
          <p className="px-3 py-3 text-11 text-fg-subtle">{t("No import task yet")}</p>
        ) : (
          <ul className="divide-y divide-line">
            {tasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onCancel={() => void cancelTask(task)}
                onRetry={() => void retryTask(task)}
              />
            ))}
          </ul>
        )}
      </section>

      {/* ---- 识别结果与确认 ---- */}
      {pending && pending.inspection ? (
        <section className="rounded-[8px] border border-line bg-surface-1 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-12 font-semibold text-fg">{t("Recognised services")}</span>
            {/* 语言 / 包管理器 / 框架是工具名（node、npm、vite），按约定不翻译。 */}
            <span className="text-10 text-fg-subtle">
              {[
                pending.inspection.stack.language,
                pending.inspection.stack.package_manager,
                pending.inspection.stack.framework,
              ]
                .filter((value): value is string => Boolean(value))
                .join(" · ")}
            </span>
          </div>

          {/* 指纹口径必须如实展示：镜像引用与远程清单不是全内容哈希。 */}
          <p className="mt-1 text-11 text-fg-muted">
            {t("Content fingerprint")}:{" "}
            {pending.fingerprint
              ? `${pending.fingerprint.sha256.slice(0, 12)} · ${t(
                  FINGERPRINT_BASIS_LABELS[pending.fingerprint.basis],
                )}`
              : "—"}
          </p>

          <FindingList task={pending} />

          <ul className="mt-2 space-y-1">
            {pending.inspection.services.map((candidate) => (
              <li
                key={candidate.id}
                className="flex items-start gap-2 rounded-[7px] border border-line px-2 py-1.5"
              >
                <input
                  type="checkbox"
                  className="mt-0.5"
                  aria-label={candidate.name}
                  checked={selected[candidate.id] ?? candidate.selected_by_default}
                  onChange={(event) =>
                    setSelected((previous) => ({
                      ...previous,
                      [candidate.id]: event.target.checked,
                    }))
                  }
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-12 text-fg">{candidate.name}</span>
                    <Chip>{t(SERVICE_ROLE_LABELS[candidate.role])}</Chip>
                    <Chip>{t(SERVICE_KIND_LABELS[candidate.service_kind])}</Chip>
                    <Chip>{t(ARTIFACT_KIND_LABELS[candidate.artifact_kind])}</Chip>
                    <Chip>
                      {t("Confidence")} {candidate.confidence}
                    </Chip>
                  </div>
                  <div className="mt-0.5 text-10 text-fg-subtle">
                    {t("Path in artifact")}: {candidate.source_path === "" ? "." : candidate.source_path}
                    {candidate.ports.length > 0
                      ? ` · ${t("Ports")}: ${candidate.ports.map((port) => port.host_port).join(", ")}`
                      : ""}
                    {candidate.env_keys.length > 0
                      ? ` · ${t("Environment keys")}: ${candidate.env_keys.join(", ")}`
                      : ""}
                  </div>
                  {candidate.evidence.length > 0 ? (
                    <div className="mt-0.5 text-10 text-fg-subtle">
                      {t("Evidence")}: {candidate.evidence.join(", ")}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>

          {/* 检查项：`unknown` 就是"未能确认"，绝不画成通过。 */}
          <ul className="mt-2 space-y-0.5">
            {pending.inspection.checks.map((check) => (
              <li key={check.id} className="flex items-start gap-1.5 text-10 text-fg-subtle">
                <Chip tone={check.state === "blocked" ? "danger" : undefined}>
                  {t(CHECK_STATE_LABELS[check.state])}
                </Chip>
                <span className="min-w-0 flex-1">{check.detail}</span>
              </li>
            ))}
          </ul>

          {pending.inspection.open_questions.length > 0 ? (
            <div className="mt-2">
              <div className="text-10 font-medium text-fg-muted">{t("Open questions")}</div>
              <ul className="mt-0.5 list-disc pl-4 text-10 text-fg-subtle">
                {pending.inspection.open_questions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="flex items-center gap-1.5">
              <span className="text-11 text-fg-muted">{t("Select the environment to deploy into")}</span>
              <select
                className={cn(selectClass, "w-44")}
                value={targetEnvironmentId}
                onChange={(event) => setTargetEnvironmentId(event.target.value)}
              >
                <option value="">{t("No environment yet")}</option>
                {environments.map((environment) => (
                  <option key={environment.id} value={environment.id}>
                    {environment.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-11 text-fg-muted">{t("Version label")}</span>
              <input
                className={cn(selectClass, "w-36")}
                value={versionLabel}
                onChange={(event) => setVersionLabel(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={
                busy ||
                targetEnvironmentId === "" ||
                (pending.security?.findings ?? []).some((finding) => finding.blocking)
              }
              onClick={() => void confirmImport()}
              className="rounded-[7px] bg-accent px-3 py-1 text-11 font-medium text-white disabled:opacity-50"
            >
              {t("Confirm import")}
            </button>
            <span className="text-10 text-fg-subtle">
              {t("Select services to create, or confirm to save the artifact only")}
            </span>
          </div>
        </section>
      ) : null}

      {/* ---- 制品 ---- */}
      <section className="rounded-[8px] border border-line bg-surface-1">
        <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
          <span className="text-11 font-medium text-fg-muted">{t("Artifacts")}</span>
          <input
            className={cn(selectClass, "ml-auto w-56")}
            value={uploadDir}
            placeholder={t("Remote directory")}
            onChange={(event) => setUploadDir(event.target.value)}
          />
        </div>
        {artifacts.length === 0 ? (
          <p className="px-3 py-3 text-11 text-fg-subtle">{t("No artifact yet")}</p>
        ) : (
          <ul className="divide-y divide-line">
            {artifacts.map((artifact) => (
              <li key={artifact.id} className="flex items-center gap-2 px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate text-11 text-fg">
                  {artifact.file_name ?? artifact.source_ref}
                </span>
                <Chip>{t(ARTIFACT_KIND_LABELS[artifact.kind])}</Chip>
                <Chip>{t(ARTIFACT_SOURCE_LABELS[artifact.source_kind])}</Chip>
                <Chip>{t(ARTIFACT_STATUS_LABELS[artifact.status])}</Chip>
                {artifact.sha256 ? (
                  <span className="text-10 text-fg-subtle">{artifact.sha256.slice(0, 12)}</span>
                ) : null}
                <button
                  type="button"
                  disabled={busy || uploadDir.trim() === "" || artifact.kind === "docker_image"}
                  onClick={() => void uploadArtifact(artifact)}
                  className="rounded-[7px] border border-line px-2 py-0.5 text-10 text-fg-muted hover:bg-surface-hover hover:text-fg disabled:opacity-50"
                >
                  {t("Upload")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

const SOURCE_LABEL_KEYS: Record<SourceKind, string> = {
  local_folder: "Local folder",
  local_archive: "Archive",
  local_file: "Local file",
  remote_directory: "Server directory",
  docker_image_ref: "Docker image",
};

function Chip({ children, tone }: { children: ReactNode; tone?: "danger" }) {
  return (
    <span
      className={cn(
        "rounded-full border border-line bg-surface-2 px-1.5 text-10 text-fg-subtle",
        tone === "danger" && "border-danger/40 bg-danger/10 text-danger",
      )}
    >
      {children}
    </span>
  );
}

function TaskRow({
  task,
  onCancel,
  onRetry,
}: {
  task: ArtifactImportTask;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-11 text-fg">{task.display_name}</span>
        <Chip>{t(IMPORT_STAGE_LABELS[task.stage])}</Chip>
        <Chip tone={task.status === "failed" ? "danger" : undefined}>
          {t(IMPORT_STATUS_LABELS[task.status])}
        </Chip>
        {isRunning(task) ? (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-[7px] border border-line px-2 py-0.5 text-10 text-fg-muted hover:bg-surface-hover hover:text-fg"
          >
            {t("Cancel import")}
          </button>
        ) : null}
        {task.status === "failed" || task.status === "cancelled" ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-[7px] border border-line px-2 py-0.5 text-10 text-fg-muted hover:bg-surface-hover hover:text-fg"
          >
            {t("Retry")}
          </button>
        ) : null}
      </div>
      {isRunning(task) ? (
        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-3">
          <div
            className="h-full bg-accent transition-[width]"
            style={{ width: `${Math.max(2, task.progress.percent)}%` }}
          />
        </div>
      ) : null}
      {task.error ? (
        <p className="mt-1 text-10 text-danger">
          {t("Import failed")}: {task.error}
        </p>
      ) : null}
      {task.status === "running" && task.stage !== "awaiting_confirmation" ? (
        <p className="mt-0.5 text-10 text-fg-subtle">
          {Math.round(task.progress.percent)}%
          {task.progress.total_bytes > 0
            ? ` · ${task.progress.processed_bytes}/${task.progress.total_bytes} B`
            : ""}
        </p>
      ) : null}
    </li>
  );
}

function FindingList({ task }: { task: ArtifactImportTask }) {
  const { t } = useTranslation();
  const report = task.security;
  if (!report) {
    return <p className="mt-1 text-11 text-fg-subtle">{t("Waiting for the analysis to finish")}</p>;
  }
  return (
    <div className="mt-2">
      <div className="flex items-center gap-2">
        <span className="text-10 font-medium text-fg-muted">{t("Scan findings")}</span>
        <Chip>
          {report.entries_checked} / {report.files_scanned}
        </Chip>
        {report.truncated ? (
          <Chip tone="danger">{t("Scan coverage is partial")}</Chip>
        ) : null}
      </div>
      {report.findings.length === 0 ? (
        <p className="mt-0.5 text-10 text-fg-subtle">{t("No findings")}</p>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {report.findings.map((finding, index) => (
            <li key={`${finding.kind}-${finding.location}-${index}`} className="flex items-start gap-1.5">
              <span
                className={cn(
                  "shrink-0 rounded-full border px-1.5 text-10",
                  SEVERITY_TONES[finding.severity] ?? SEVERITY_TONES.info,
                )}
              >
                {t(FINDING_SEVERITY_LABELS[finding.severity])}
              </span>
              <span className="min-w-0 flex-1 text-10 text-fg-subtle">
                {t(FINDING_KIND_LABELS[finding.kind])} · {finding.location} — {finding.detail}
                {finding.evidence ? ` (${finding.evidence.preview})` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
