/**
 * 部署中心 —— 表单的纯逻辑（**不碰 React、不碰 IPC**，因此可单测）。
 *
 * 三件事：
 *
 * 1. 新建实体的空值工厂（id / 时间戳留给后端生成）；
 * 2. 结构化运行方式 `ServiceRuntime` ↔ 扁平表单的双向转换；
 * 3. **与 Rust 校验保持一致的本地检查** —— 只为即时反馈，权威仍在 Rust
 *    （`deployment::validate`）。这里同样拒绝 shell 元字符：在 UI 层就不让
 *    用户产生"看起来像命令"的输入。
 */

import type {
  ApplicationKind,
  DeploymentApplication,
  DeploymentEnvironment,
  DeploymentServiceUnit,
  EnvironmentKind,
  FailurePolicy,
  PortMapping,
  ServiceKind,
  ServiceRelation,
  ServiceRelationKind,
  ServiceRole,
  ServiceRuntime,
  SourceKind,
} from "@/api/types/deployment";

/** shell 元字符（与 Rust `validate::SHELL_META` 同一套）。 */
const SHELL_META = /[;&|`$<>'"\\\n\r\t*?!~#(){}[\]]/;

/** 文本里是否含 shell 元字符（空串视为合法）。 */
export function hasShellMeta(value: string): boolean {
  return SHELL_META.test(value);
}

/** 绝对路径检查（Rust 那边更严格，这里只挡住明显的错）。 */
export function isAbsolutePath(value: string): boolean {
  return value.trim().startsWith("/");
}

/** `path` 是否落在 `root` 之内（按目录边界比较，避免 /opt/web2 命中 /opt/web）。 */
export function isInsideRoot(path: string, root: string): boolean {
  const normalizedPath = normalize(path);
  const normalizedRoot = normalize(root);
  if (!normalizedRoot) return false;
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function normalize(value: string): string {
  const segments: string[] = [];
  for (const segment of value.trim().split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

// -- 空实体 ---------------------------------------------------------------

export function newApplication(serverId: string): DeploymentApplication {
  return {
    id: "",
    server_id: serverId,
    name: "",
    description: "",
    application_kind: "frontend",
    source_kind: "existing_remote_dir",
    source_ref: "",
    default_branch: "main",
    confirmed_project_path: null,
    status: "active",
    created_at: 0,
    updated_at: 0,
  };
}

export function newEnvironment(application: DeploymentApplication): DeploymentEnvironment {
  return {
    id: "",
    application_id: application.id,
    server_id: application.server_id,
    name: "",
    kind: "production",
    deploy_root: application.confirmed_project_path ?? "",
    capacity_profile_id: null,
    notes: "",
    status: "active",
    created_at: 0,
    updated_at: 0,
  };
}

export function newServiceUnit(
  applicationId: string,
  environmentId: string,
): DeploymentServiceUnit {
  return {
    id: "",
    application_id: applicationId,
    environment_id: environmentId,
    name: "",
    role: "web",
    service_kind: "static_nginx",
    runtime: { kind: "static_nginx", site_name: "", root: "" },
    deploy_path: null,
    confirmed_project_id: null,
    confirmed_project_path: null,
    artifact_id: null,
    status: "incomplete",
    notes: "",
    created_at: 0,
    updated_at: 0,
  };
}

export function newServiceRelation(applicationId: string): ServiceRelation {
  return {
    id: "",
    application_id: applicationId,
    from_service_id: "",
    to_service_id: "",
    relation_kind: "depends_on",
    required: true,
    failure_policy: "block",
    notes: "",
    created_at: 0,
    updated_at: 0,
  };
}

// -- 运行方式 ↔ 表单 ------------------------------------------------------

/** 运行方式表单：判别标签 + 各变体的字段（扁平存放，便于受控输入）。 */
export interface RuntimeFormState {
  kind: ServiceRuntime["kind"];
  site_name: string;
  root: string;
  unit: string;
  image: string;
  tag: string;
  container_name: string;
  ports: PortMapping[];
  compose_path: string;
  project_name: string;
  service: string;
  entry: string;
  /** 每行一个参数。 */
  args_text: string;
  endpoint: string;
}

export function emptyRuntimeForm(): RuntimeFormState {
  return {
    kind: "static_nginx",
    site_name: "",
    root: "",
    unit: "",
    image: "",
    tag: "latest",
    container_name: "",
    ports: [],
    compose_path: "",
    project_name: "",
    service: "",
    entry: "",
    args_text: "",
    endpoint: "",
  };
}

export function runtimeFormFrom(runtime: ServiceRuntime): RuntimeFormState {
  const form = emptyRuntimeForm();
  form.kind = runtime.kind;
  switch (runtime.kind) {
    case "static_nginx":
      form.site_name = runtime.site_name;
      form.root = runtime.root;
      break;
    case "systemd_unit":
      form.unit = runtime.unit;
      break;
    case "docker_image":
      form.image = runtime.image;
      form.tag = runtime.tag;
      form.container_name = runtime.container_name;
      form.ports = runtime.ports.map((port) => ({ ...port }));
      break;
    case "docker_compose":
      form.compose_path = runtime.compose_path;
      form.project_name = runtime.project_name;
      form.service = runtime.service;
      break;
    case "native_process":
      form.entry = runtime.entry;
      form.args_text = runtime.args.join("\n");
      break;
    case "external":
      form.endpoint = runtime.endpoint;
      break;
  }
  return form;
}

export function runtimeFromForm(form: RuntimeFormState): ServiceRuntime {
  switch (form.kind) {
    case "static_nginx":
      return { kind: "static_nginx", site_name: form.site_name.trim(), root: form.root.trim() };
    case "systemd_unit":
      return { kind: "systemd_unit", unit: form.unit.trim() };
    case "docker_image":
      return {
        kind: "docker_image",
        image: form.image.trim(),
        tag: form.tag.trim(),
        container_name: form.container_name.trim(),
        ports: form.ports,
      };
    case "docker_compose":
      return {
        kind: "docker_compose",
        compose_path: form.compose_path.trim(),
        project_name: form.project_name.trim(),
        service: form.service.trim(),
      };
    case "native_process":
      return {
        kind: "native_process",
        entry: form.entry.trim(),
        args: form.args_text
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      };
    case "external":
      return { kind: "external", endpoint: form.endpoint.trim() };
  }
}

/** `native_process` 之外，部署形态由运行方式决定（避免自相矛盾的组合）。 */
export function serviceKindForRuntime(
  runtimeKind: ServiceRuntime["kind"],
  current: ServiceKind,
): ServiceKind {
  switch (runtimeKind) {
    case "static_nginx":
      return "static_nginx";
    case "systemd_unit":
      return "systemd_unit";
    case "docker_image":
      return "docker_image";
    case "docker_compose":
      return "docker_compose";
    case "external":
      return "external_managed";
    case "native_process":
      // JAR / Node / Python / 原生二进制共用一套运行方式，由用户选具体形态。
      return ["java_jar", "node_process", "python_venv", "native_binary"].includes(current)
        ? current
        : "native_binary";
  }
}

/**
 * 运行方式字段校验：返回**英文 key**（调用方 `t()` 展示），合法时返回 null。
 * 规则与 Rust 侧一致（那边是权威，这里只为即时反馈）。
 */
export function runtimeFormError(form: RuntimeFormState): string | null {
  const textProblem = (value: string, required = true): string | null => {
    if (required && value.trim().length === 0) return "This field is required";
    if (hasShellMeta(value)) {
      return "Shell metacharacters (; & | $ ` > <) and newlines are not allowed";
    }
    return null;
  };

  const switchKind = (): string | null => {
    switch (form.kind) {
      case "static_nginx":
        return (
          textProblem(form.site_name) ??
          textProblem(form.root) ??
          (form.root.trim().length > 0 && !isAbsolutePath(form.root)
            ? "Must be an absolute path, e.g. /opt/web"
            : null)
        );
      case "systemd_unit":
        return textProblem(form.unit);
      case "docker_image": {
        const problem =
          textProblem(form.image) ?? textProblem(form.tag) ?? textProblem(form.container_name);
        if (problem) return problem;
        for (const port of form.ports) {
          if (!Number.isInteger(port.host_port) || port.host_port < 1 || port.host_port > 65535) {
            return "Port must be between 1 and 65535";
          }
          if (
            !Number.isInteger(port.container_port) ||
            port.container_port < 1 ||
            port.container_port > 65535
          ) {
            return "Port must be between 1 and 65535";
          }
        }
        return null;
      }
      case "docker_compose":
        return (
          textProblem(form.compose_path) ??
          (!isAbsolutePath(form.compose_path) ? "Must be an absolute path, e.g. /opt/web" : null) ??
          textProblem(form.project_name) ??
          textProblem(form.service)
        );
      case "native_process": {
        const problem = textProblem(form.entry);
        if (problem) return problem;
        for (const line of form.args_text.split("\n")) {
          const argument = line.trim();
          if (argument.length === 0) continue;
          if (hasShellMeta(argument)) {
            return "Shell metacharacters (; & | $ ` > <) and newlines are not allowed";
          }
        }
        return null;
      }
      case "external":
        return textProblem(form.endpoint) ?? (!form.endpoint.includes(":") ? "This field is required" : null);
    }
  };

  return switchKind();
}

/** 服务目录必须落在环境根目录内（Rust 侧同样是硬校验）。 */
export function servicePathError(
  deployPath: string | null | undefined,
  deployRoot: string,
): string | null {
  const path = (deployPath ?? "").trim();
  if (path.length === 0) return null;
  if (!isAbsolutePath(path)) return "Must be an absolute path, e.g. /opt/web";
  if (hasShellMeta(path)) {
    return "Shell metacharacters (; & | $ ` > <) and newlines are not allowed";
  }
  if (!isInsideRoot(path, deployRoot)) {
    return "The service directory must be inside the environment deploy root";
  }
  return null;
}

/** 端口输入的宽松解析（空串 → null，非法 → NaN 由调用方提示）。 */
export function parseOptionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/** 数值 → 输入框文本（null → 空串，**不用 0 冒充"未知"**）。 */
export function numberInputValue(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

// -- 计划图（只读展示用的小工具） ------------------------------------------

/** 节点按动作统计（列表页显示"这个方案里有哪些步骤"）。 */
export function summarizeActions(
  actions: ServiceRuntime["kind"][] | string[],
): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const action of actions) {
    summary[action] = (summary[action] ?? 0) + 1;
  }
  return summary;
}

/** 方案里最高风险（列表页给一个整体风险徽标）。 */
export function highestRisk(risks: string[]): "low" | "medium" | "high" | "critical" {
  const order = ["low", "medium", "high", "critical"] as const;
  let highest: (typeof order)[number] = "low";
  for (const risk of risks) {
    const index = order.indexOf(risk as (typeof order)[number]);
    if (index > order.indexOf(highest)) highest = order[index];
  }
  return highest;
}

// -- 枚举取值清单（供下拉框使用，类型上保证不漏项） ------------------------

export const APPLICATION_KINDS: ApplicationKind[] = [
  "frontend",
  "backend",
  "full_stack",
  "static_site",
  "worker",
  "scheduled_task",
];

export const SOURCE_KINDS: SourceKind[] = ["git", "existing_remote_dir", "local_upload"];

export const ENVIRONMENT_KINDS: EnvironmentKind[] = [
  "development",
  "testing",
  "staging",
  "production",
];

export const SERVICE_ROLES: ServiceRole[] = [
  "web",
  "api",
  "worker",
  "scheduler",
  "gateway",
  "database",
  "cache",
  "static",
  "other",
];

export const SERVICE_KINDS: ServiceKind[] = [
  "static_nginx",
  "systemd_unit",
  "docker_image",
  "docker_compose",
  "java_jar",
  "node_process",
  "python_venv",
  "native_binary",
  "external_managed",
];

export const RELATION_KINDS: ServiceRelationKind[] = [
  "depends_on",
  "provides_to",
  "shares_network",
  "shares_volume",
  "order_before",
];

export const FAILURE_POLICIES: FailurePolicy[] = ["block", "warn", "ignore"];
