/**
 * 部署中心的表单弹窗：应用 / 环境 / 服务 / 新建方案。
 *
 * 三条通则（与项目其它弹窗一致）：
 * * 校验只做**即时反馈**，权威在后端；后端返回的中文错误原样显示（`ErrorText`）。
 * * 危险动作（删除）不走这里，统一由 `ConfirmDialog` 处理。
 * * 所有用户可见文案走 i18n，`t(...)` 的 key 就是英文原文。
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { ErrorText, Field, Modal, fieldClass } from "@/components/ui/modal";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type {
  DeploymentApplication,
  DeploymentEnvironment,
  DeploymentServiceUnit,
  PortMapping,
} from "@/api/types/deployment";
import {
  APPLICATION_KINDS,
  ENVIRONMENT_KINDS,
  SERVICE_ROLES,
  SOURCE_KINDS,
  hasShellMeta,
  isAbsolutePath,
  runtimeFormError,
  runtimeFormFrom,
  runtimeFromForm,
  serviceKindForRuntime,
  servicePathError,
  type RuntimeFormState,
} from "./form";
import {
  APPLICATION_KIND_LABELS,
  ENVIRONMENT_KIND_LABELS,
  RUNTIME_KIND_LABELS,
  SERVICE_KIND_LABELS,
  SERVICE_ROLE_LABELS,
  SOURCE_KIND_LABELS,
} from "./labels";

/** 表单里通用的"短文本"检查（必填 + 无 shell 元字符）。 */
function textError(value: string, required = true): string | null {
  if (required && value.trim().length === 0) return "This field is required";
  if (hasShellMeta(value)) {
    return "Shell metacharacters (; & | $ ` > <) and newlines are not allowed";
  }
  return null;
}

// -- 应用 -------------------------------------------------------------------

export function ApplicationDialog({
  open,
  draft,
  onCancel,
  onSubmit,
}: {
  /** 编辑中的实体（非空 = 编辑已有应用，用于标题）。 */
  open: DeploymentApplication | null;
  draft: DeploymentApplication | null;
  onCancel: () => void;
  onSubmit: (application: DeploymentApplication) => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<DeploymentApplication | null>(draft);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    setForm(draft);
    setProblem(null);
  }, [draft]);

  const sourceHint = useMemo(() => {
    if (!form) return undefined;
    switch (form.source_kind) {
      case "git":
        return t("Repository URL");
      case "existing_remote_dir":
        return t("Server directory");
      default:
        return t("Local folder");
    }
  }, [form, t]);

  if (!form) return null;

  const update = (patch: Partial<DeploymentApplication>) =>
    setForm((current) => (current ? { ...current, ...patch } : current));

  const submit = () => {
    const failure =
      textError(form.name) ??
      (form.server_id.trim() === "" ? "Select a server first" : null) ??
      (form.source_kind === "existing_remote_dir"
        ? isAbsolutePath(form.source_ref)
          ? textError(form.source_ref)
          : "Must be an absolute path, e.g. /opt/web"
        : textError(form.source_ref, form.source_kind === "git"));
    if (failure) {
      setProblem(failure);
      return;
    }
    onSubmit({ ...form, name: form.name.trim(), source_ref: form.source_ref.trim() });
  };

  return (
    <Modal
      open
      width={420}
      title={open ? t("Edit application") : t("New application")}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" size="sm" onClick={submit}>
            {t("Save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t("Application name")}>
          <input
            className={fieldClass}
            value={form.name}
            autoFocus
            onChange={(event) => update({ name: event.target.value })}
          />
        </Field>

        <Field label={t("Application type")}>
          <Select
            value={form.application_kind}
            onChange={(value) =>
              update({ application_kind: value as DeploymentApplication["application_kind"] })
            }
            options={APPLICATION_KINDS.map((kind) => ({
              value: kind,
              label: t(APPLICATION_KIND_LABELS[kind]),
            }))}
          />
        </Field>

        <Field
          label={t("Source kind")}
          hint={form.source_kind === "existing_remote_dir" ? t("Must be an absolute path, e.g. /opt/web") : undefined}
        >
          <Select
            value={form.source_kind}
            onChange={(value) =>
              update({ source_kind: value as DeploymentApplication["source_kind"] })
            }
            options={SOURCE_KINDS.map((kind) => ({
              value: kind,
              label: t(SOURCE_KIND_LABELS[kind]),
            }))}
          />
        </Field>

        <Field label={sourceHint ?? t("Source reference")}>
          <input
            className={fieldClass}
            value={form.source_ref}
            placeholder={form.source_kind === "existing_remote_dir" ? "/opt/web" : ""}
            onChange={(event) => update({ source_ref: event.target.value })}
          />
        </Field>

        {form.source_kind === "git" && (
          <Field label={t("Branch")}>
            <input
              className={fieldClass}
              value={form.default_branch}
              onChange={(event) => update({ default_branch: event.target.value })}
            />
          </Field>
        )}

        <Field label={t("Notes")}>
          <Textarea
            resizable={false}
            className="h-16"
            value={form.description}
            onChange={(event) => update({ description: event.target.value })}
          />
        </Field>

        <ErrorText>{problem ? t(problem) : null}</ErrorText>
      </div>
    </Modal>
  );
}

// -- 环境 -------------------------------------------------------------------

export function EnvironmentDialog({
  open,
  draft,
  application,
  onCancel,
  onSubmit,
}: {
  open: DeploymentEnvironment | null;
  draft: DeploymentEnvironment | null;
  application: DeploymentApplication | null;
  onCancel: () => void;
  onSubmit: (environment: DeploymentEnvironment) => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<DeploymentEnvironment | null>(draft);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    setForm(draft);
    setProblem(null);
  }, [draft]);

  if (!form) return null;

  const update = (patch: Partial<DeploymentEnvironment>) =>
    setForm((current) => (current ? { ...current, ...patch } : current));

  const submit = () => {
    const failure =
      textError(form.name) ??
      (isAbsolutePath(form.deploy_root)
        ? textError(form.deploy_root)
        : "Must be an absolute path, e.g. /opt/web");
    if (failure) {
      setProblem(failure);
      return;
    }
    onSubmit({ ...form, name: form.name.trim(), deploy_root: form.deploy_root.trim() });
  };

  return (
    <Modal
      open
      width={420}
      title={open ? t("Edit environment") : t("New environment")}
      description={application ? application.name : undefined}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" size="sm" onClick={submit}>
            {t("Save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t("Environment name")}>
          <input
            className={fieldClass}
            value={form.name}
            autoFocus
            placeholder="production"
            onChange={(event) => update({ name: event.target.value })}
          />
        </Field>

        <Field label={t("Environment kind")}>
          <Select
            value={form.kind}
            onChange={(value) => update({ kind: value as DeploymentEnvironment["kind"] })}
            options={ENVIRONMENT_KINDS.map((kind) => ({
              value: kind,
              label: t(ENVIRONMENT_KIND_LABELS[kind]),
            }))}
          />
        </Field>

        <Field
          label={t("Deploy root")}
          hint={t("The service directory must be inside the environment deploy root")}
        >
          <input
            className={fieldClass}
            value={form.deploy_root}
            placeholder="/opt/web"
            onChange={(event) => update({ deploy_root: event.target.value })}
          />
        </Field>

        <Field label={t("Notes")}>
          <Textarea
            resizable={false}
            className="h-14"
            value={form.notes}
            onChange={(event) => update({ notes: event.target.value })}
          />
        </Field>

        <ErrorText>{problem ? t(problem) : null}</ErrorText>
      </div>
    </Modal>
  );
}

// -- 服务 -------------------------------------------------------------------

export function ServiceDialog({
  open,
  draft,
  environments,
  onCancel,
  onSubmit,
}: {
  open: DeploymentServiceUnit | null;
  draft: DeploymentServiceUnit | null;
  environments: DeploymentEnvironment[];
  onCancel: () => void;
  onSubmit: (unit: DeploymentServiceUnit) => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<DeploymentServiceUnit | null>(draft);
  const [runtime, setRuntime] = useState<RuntimeFormState | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    setForm(draft);
    setRuntime(draft ? runtimeFormFrom(draft.runtime) : null);
    setProblem(null);
  }, [draft]);

  if (!form || !runtime) return null;

  const environment = environments.find((item) => item.id === form.environment_id) ?? null;
  const update = (patch: Partial<DeploymentServiceUnit>) =>
    setForm((current) => (current ? { ...current, ...patch } : current));
  const updateRuntime = (patch: Partial<RuntimeFormState>) =>
    setRuntime((current) => (current ? { ...current, ...patch } : current));

  const submit = () => {
    const failure =
      textError(form.name) ??
      (form.environment_id.trim() === "" ? "Select an environment" : null) ??
      runtimeFormError(runtime) ??
      servicePathError(form.deploy_path, environment?.deploy_root ?? "/");
    if (failure) {
      setProblem(failure);
      return;
    }
    onSubmit({
      ...form,
      name: form.name.trim(),
      service_kind: serviceKindForRuntime(runtime.kind, form.service_kind),
      runtime: runtimeFromForm(runtime),
      deploy_path: (form.deploy_path ?? "").trim() === "" ? null : (form.deploy_path ?? "").trim(),
    });
  };

  const ports = runtime.ports;

  return (
    <Modal
      open
      width={520}
      title={open ? t("Edit service") : t("New service")}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" size="sm" onClick={submit}>
            {t("Save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("Service name")}>
            <input
              className={fieldClass}
              value={form.name}
              autoFocus
              onChange={(event) => update({ name: event.target.value })}
            />
          </Field>
          <Field label={t("Service role")}>
            <Select
              value={form.role}
              onChange={(value) => update({ role: value as DeploymentServiceUnit["role"] })}
              options={SERVICE_ROLES.map((role) => ({
                value: role,
                label: t(SERVICE_ROLE_LABELS[role]),
              }))}
            />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t("Environment")}>
            <Select
              value={form.environment_id}
              placeholder={t("Select an environment")}
              onChange={(value) => update({ environment_id: value })}
              options={[
                { value: "", label: t("Select an environment") },
                ...environments.map((item) => ({ value: item.id, label: item.name })),
              ]}
            />
          </Field>
          <Field label={t("Runtime")}>
            <Select
              value={runtime.kind}
              onChange={(value) => {
                const kind = value as RuntimeFormState["kind"];
                updateRuntime({ kind });
                update({ service_kind: serviceKindForRuntime(kind, form.service_kind) });
              }}
              options={Object.entries(RUNTIME_KIND_LABELS).map(([kind, label]) => ({
                value: kind,
                label: t(label),
              }))}
            />
          </Field>
        </div>

        {/* 运行方式的形态字段：随 kind 变化，都是**结构化字段**，没有命令输入框。 */}
        {runtime.kind === "static_nginx" && (
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("Nginx site name")}>
              <input
                className={fieldClass}
                value={runtime.site_name}
                onChange={(event) => updateRuntime({ site_name: event.target.value })}
              />
            </Field>
            <Field label={t("Site root")}>
              <input
                className={fieldClass}
                value={runtime.root}
                placeholder="/opt/web/current"
                onChange={(event) => updateRuntime({ root: event.target.value })}
              />
            </Field>
          </div>
        )}

        {runtime.kind === "systemd_unit" && (
          <Field label={t("systemd unit name")}>
            <input
              className={fieldClass}
              value={runtime.unit}
              placeholder="api.service"
              onChange={(event) => updateRuntime({ unit: event.target.value })}
            />
          </Field>
        )}

        {runtime.kind === "docker_image" && (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("Image")}>
                <input
                  className={fieldClass}
                  value={runtime.image}
                  placeholder="registry.example.com/acme/web"
                  onChange={(event) => updateRuntime({ image: event.target.value })}
                />
              </Field>
              <Field label={t("Image tag")}>
                <input
                  className={fieldClass}
                  value={runtime.tag}
                  onChange={(event) => updateRuntime({ tag: event.target.value })}
                />
              </Field>
            </div>
            <Field label={t("Container name")}>
              <input
                className={fieldClass}
                value={runtime.container_name}
                onChange={(event) => updateRuntime({ container_name: event.target.value })}
              />
            </Field>
            <div className="rounded-[8px] border border-line bg-surface-2/50 p-2">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-11 font-medium text-fg-muted">{t("Host port")}</span>
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() =>
                    updateRuntime({
                      ports: [
                        ...ports,
                        { host_port: 0, container_port: 0, protocol: "tcp" } satisfies PortMapping,
                      ],
                    })
                  }
                >
                  {t("Add port mapping")}
                </Button>
              </div>
              <div className="flex flex-col gap-1.5">
                {ports.map((port, index) => (
                  <div key={index} className="flex items-center gap-1.5">
                    <Input
                      size="sm"
                      className="w-20"
                      value={port.host_port === 0 ? "" : String(port.host_port)}
                      aria-label={t("Host port")}
                      onChange={(event) => {
                        const next = ports.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, host_port: Number(event.target.value) || 0 }
                            : item,
                        );
                        updateRuntime({ ports: next });
                      }}
                    />
                    <span className="text-11 text-fg-subtle">→</span>
                    <Input
                      size="sm"
                      className="w-20"
                      value={port.container_port === 0 ? "" : String(port.container_port)}
                      aria-label={t("Container port")}
                      onChange={(event) => {
                        const next = ports.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, container_port: Number(event.target.value) || 0 }
                            : item,
                        );
                        updateRuntime({ ports: next });
                      }}
                    />
                    <Select
                      className="w-20 shrink-0"
                      size="sm"
                      value={port.protocol}
                      ariaLabel={t("协议")}
                      onChange={(value) => {
                        const next = ports.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, protocol: value as PortMapping["protocol"] }
                            : item,
                        );
                        updateRuntime({ ports: next });
                      }}
                      options={[
                        { value: "tcp", label: "TCP" },
                        { value: "udp", label: "UDP" },
                      ]}
                    />
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={t("Remove port mapping")}
                      onClick={() =>
                        updateRuntime({ ports: ports.filter((_, itemIndex) => itemIndex !== index) })
                      }
                    >
                      ✕
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {runtime.kind === "docker_compose" && (
          <div className="flex flex-col gap-3">
            <Field label={t("Compose file path")}>
              <input
                className={fieldClass}
                value={runtime.compose_path}
                placeholder="/opt/web/docker-compose.yml"
                onChange={(event) => updateRuntime({ compose_path: event.target.value })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("Compose project name")}>
                <input
                  className={fieldClass}
                  value={runtime.project_name}
                  onChange={(event) => updateRuntime({ project_name: event.target.value })}
                />
              </Field>
              <Field label={t("Compose service name")}>
                <input
                  className={fieldClass}
                  value={runtime.service}
                  onChange={(event) => updateRuntime({ service: event.target.value })}
                />
              </Field>
            </div>
          </div>
        )}

        {runtime.kind === "native_process" && (
          <div className="flex flex-col gap-3">
            <Field
              label={t("Executable")}
              hint={t("Runtime fields depend on the deployment shape")}
            >
              <input
                className={fieldClass}
                value={runtime.entry}
                placeholder="java / node / /opt/web/run.sh"
                onChange={(event) => updateRuntime({ entry: event.target.value })}
              />
            </Field>
            <Field label={t("Arguments")} hint={t("One argument per line — each line is passed as one argument, never through a shell")}>
              <Textarea
                resizable={false}
                className="h-18 font-mono"
                value={runtime.args_text}
                placeholder={"-jar\napp.jar"}
                onChange={(event) => updateRuntime({ args_text: event.target.value })}
              />
            </Field>
            <Field label={t("Service kind")}>
              <Select
                value={form.service_kind}
                onChange={(value) =>
                  update({ service_kind: value as DeploymentServiceUnit["service_kind"] })
                }
                options={(
                  ["java_jar", "node_process", "python_venv", "native_binary"] as const
                ).map((kind) => ({ value: kind, label: t(SERVICE_KIND_LABELS[kind]) }))}
              />
            </Field>
          </div>
        )}

        {runtime.kind === "external" && (
          <Field label={t("Source reference")} hint={t("External managed")}>
            <input
              className={fieldClass}
              value={runtime.endpoint}
              placeholder="db-prod-01:5432"
              onChange={(event) => updateRuntime({ endpoint: event.target.value })}
            />
          </Field>
        )}

        <Field
          label={t("Deploy path")}
          hint={environment ? `${t("Deploy root")}: ${environment.deploy_root}` : undefined}
        >
          <input
            className={fieldClass}
            value={form.deploy_path ?? ""}
            placeholder={environment ? `${environment.deploy_root}/current` : ""}
            onChange={(event) => update({ deploy_path: event.target.value })}
          />
        </Field>

        <Field label={t("Notes")}>
          <Textarea
            resizable={false}
            className="h-12"
            value={form.notes}
            onChange={(event) => update({ notes: event.target.value })}
          />
        </Field>

        <ErrorText>{problem ? t(problem) : null}</ErrorText>
      </div>
    </Modal>
  );
}

// -- 新建方案 ---------------------------------------------------------------

export function PlanDialog({
  open,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setProblem(null);
    }
  }, [open]);

  return (
    <Modal
      open={open}
      width={380}
      title={t("New plan")}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("Cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              const failure = textError(name);
              if (failure) {
                setProblem(failure);
                return;
              }
              onSubmit(name.trim());
            }}
          >
            {t("Save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t("Plan name")}>
          <input
            className={fieldClass}
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <ErrorText>{problem ? t(problem) : null}</ErrorText>
      </div>
    </Modal>
  );
}
