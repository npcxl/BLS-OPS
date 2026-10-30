/**
 * 前端统一的错误模型 —— 所有"给用户看的错误"都从这里出去。
 *
 * # 为什么需要一层
 *
 * 后端（Rust）返回的错误有三种形态：结构化 `{ stage, message, detail, code,
 * retryable }`、纯字符串、以及偶尔的 Tauri 传输错误。以前每个调用点都自己
 * `cause instanceof Error ? cause.message : String(cause)`，于是出现了
 * 三种糟糕的界面：
 * - `[object Object]`（结构化错误被 toString）；
 * - 一屏红的原始报错（把整段 SQL + 绑定参数塞进 11px 的一行里）；
 * - 只说"失败"不说"哪一步失败、我该怎么办"。
 *
 * 这里把三种形态归一成 `AppErrorInfo`，并补上两条信息：
 * - `hint`：用户可以自己做的下一步（没有就明说结果未知，别让他乱重试）；
 * - `outcomeUnknown`：操作可能已经生效。**绝不能**当成失败或成功来渲染。
 */

import { i18n } from "@/i18n";

export interface AppErrorInfo {
  /** 失败阶段（`auth` / `tcp` / `query` / …），没有则为 null。 */
  stage: string | null;
  /** 引擎错误码（MySQL 1045、SQLSTATE…），拼成短标签。 */
  code: string | null;
  /** 摘要：一行能读完的原因。 */
  message: string;
  /** 详情：后端原文、多行堆栈、服务器附加信息。 */
  detail: string | null;
  /** 用户可以执行的下一步。 */
  hint: string | null;
  /** 同一次操作原样重试是否可能成功（写操作永远为 false）。 */
  retryable: boolean;
  /** 结果未知：可能已经生效，禁止自动重试，也禁止显示"失败"。 */
  outcomeUnknown: boolean;
}

/** 阶段 → 简短标题（natural key，zh-CN 见 locales/zh-CN/common.ts）。 */
const STAGE_LABELS: Record<string, string> = {
  config: "Configuration",
  ssh_tunnel: "SSH tunnel",
  tcp: "Network",
  tls: "TLS",
  auth: "Authentication",
  database: "Database",
  query: "Query",
  permission: "Permission",
  cancelled: "Cancelled",
  timeout: "Timeout",
  outcome_unknown: "Outcome unknown",
  unsupported: "Unsupported",
  budget: "Budget",
  // -- 运维模块（Rust `OpsError` 的默认阶段）--
  ssh: "SSH session",
  sftp: "File transfer",
  systemd: "Service",
  journal: "Logs",
  docker: "Containers",
  nginx: "Gateway",
  project: "Discovery",
  deploy: "Deployment",
  io: "Local files",
  monitor: "Monitoring",
  server: "Server",
  local: "Local action",
};

/** 阶段 → 用户可执行的下一步。诊断信息必须能落成动作。 */
const STAGE_HINTS: Record<string, string> = {
  config: "Fill in the required fields: check the host, port range and database path.",
  ssh_tunnel:
    "Check that the SSH server is reachable and that the account is allowed to open a tunnel.",
  tcp: "Check the host and port, the firewall, and that the service is listening.",
  tls: "Check the CA file, the TLS mode, and whether the host name matches the certificate.",
  auth: "Check the username and password (or ACL), and whether this host is allowed to connect.",
  database: "Check that the database exists and that the account can see it.",
  query: "Check the SQL syntax, blocking locks, and the statement timeout.",
  permission: "This account lacks the privilege. Use an account with the required grants.",
  timeout: "Raise the timeout, or check the network path between here and the server.",
  outcome_unknown:
    "Do not retry blindly: verify the actual state (rows, file, service) before running it again.",
  unsupported: "This engine or feature is not supported yet.",
  cancelled: "The operation was cancelled before it changed anything.",
  ssh: "Check that the session is still connected; reconnect if the server restarted or the network dropped.",
  sftp:
    "Check the path and the account's permissions on it, then retry — nothing was half-written.",
  systemd:
    "Check that the unit name is right and that the account may manage services (polkit / sudo).",
  journal: "Check that the journal is readable: the account may need the adm or systemd-journal group.",
  docker: "Check that Docker is running and that the account is in the docker group.",
  nginx: "Run a syntax test first; a config that fails `nginx -t` is never reloaded.",
  project: "Check that the project directory is readable and on a local disk, not a network mount.",
  deploy: "Check the target environment, the artifact, and whether the previous run is still in progress.",
  io: "Check whether the file exists and whether this app may read or write it.",
  monitor: "Metrics are read over the SSH session: check that the session is still connected, then refresh.",
  server: "Check the host, port and credential, and whether the same name already exists.",
  local: "This is a local action: check that the program exists and that no other copy of the app is holding the file.",
};

/** 摘要上限：再长就另起详情，绝不把窗口撑爆。 */
const MAX_SUMMARY = 600;
/** 详情上限：够定位问题即可，超大原文交给"复制错误信息"。 */
const MAX_DETAIL = 8_000;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/** 结构化错误对象的最小形状（后端 `DbErrorInfo` 就是它）。 */
interface StructuredError {
  stage?: unknown;
  message?: unknown;
  detail?: unknown;
  code?: unknown;
  sql_state?: unknown;
  retryable?: unknown;
}

function asStructured(value: unknown): StructuredError | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.message !== "string" && typeof record.error !== "string") return null;
  return record as StructuredError;
}

/** 把任意异常归一成可渲染的错误信息。**永不抛错**。 */
export function toAppError(cause: unknown): AppErrorInfo {
  if (cause === null || cause === undefined) {
    return base(i18n.t("Unknown error"));
  }

  if (typeof cause === "string") return fromString(cause);

  const structured = asStructured(cause);
  if (structured) {
    const stage = typeof structured.stage === "string" ? structured.stage : null;
    const codeParts: string[] = [];
    if (typeof structured.code === "number" || typeof structured.code === "string") {
      codeParts.push(String(structured.code));
    }
    if (typeof structured.sql_state === "string" && structured.sql_state) {
      codeParts.push(structured.sql_state);
    }
    const message =
      typeof structured.message === "string"
        ? structured.message
        : String((structured as { error?: unknown }).error ?? "");
    const detail = typeof structured.detail === "string" ? structured.detail : null;
    return {
      ...base(message),
      stage,
      code: codeParts.length > 0 ? codeParts.join(" ") : null,
      detail: detail ? clip(detail, MAX_DETAIL) : null,
      hint: stage ? (STAGE_HINTS[stage] ? i18n.t(STAGE_HINTS[stage]) : null) : null,
      retryable: structured.retryable === true,
      outcomeUnknown: stage === "outcome_unknown",
    };
  }

  if (cause instanceof Error) {
    // Tauri 的 IPC 错误也被包成 Error，message 里就是后端原文。
    return fromString(cause.message || i18n.t("Unknown error"));
  }

  if (typeof cause === "number" || typeof cause === "boolean") {
    return base(String(cause));
  }

  return base(i18n.t("Unknown error"));
}

function base(message: string): AppErrorInfo {
  return {
    stage: null,
    code: null,
    message,
    detail: null,
    hint: null,
    retryable: false,
    outcomeUnknown: false,
  };
}

/** 纯字符串错误：可能是 JSON（旧接口）、也可能是多行原文。 */
function fromString(raw: string): AppErrorInfo {
  const text = raw.trim();
  const looksJson = text.startsWith("{") && text.endsWith("}");
  if (looksJson) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const structured = asStructured(parsed);
      if (structured) return toAppError(parsed);
    } catch {
      // 不是合法 JSON：按原文处理。
    }
  }

  // 多行：第一行当摘要，其余留作详情 —— 让"一行话 + 可展开细节"成立。
  const lines = text.split("\n");
  const firstLine = lines[0] ?? text;
  const rest = lines.slice(1).join("\n").trim();
  const summary = clip(firstLine, MAX_SUMMARY);
  return {
    ...base(summary),
    message: summary,
    detail: rest ? clip(rest, MAX_DETAIL) : null,
    // 后端字符串错误里就带了"结果未知"：这必须是显式状态，不能被当成失败。
    outcomeUnknown: /outcome[_\s]?unknown|结果未知/i.test(text),
  };
}

/** 阶段的中文/英文短标题。 */
export function stageLabel(stage: string | null | undefined): string | null {
  if (!stage) return null;
  const key = STAGE_LABELS[stage];
  return key ? i18n.t(key) : stage;
}

/** 复制到剪贴板的错误全文（含阶段、错误码、详情）。 */
export function formatErrorForCopy(error: AppErrorInfo, context?: string): string {
  const lines: string[] = [];
  if (context) lines.push(`## ${context}`);
  if (error.stage) lines.push(`stage: ${error.stage}`);
  if (error.code) lines.push(`code: ${error.code}`);
  lines.push(`message: ${error.message}`);
  if (error.detail) lines.push(`detail:\n${error.detail}`);
  if (error.outcomeUnknown) lines.push("outcome: unknown (the action may have taken effect)");
  return lines.join("\n");
}

/** 错误是否值得给一个「重试」按钮。结果未知的操作永远不给。 */
export function canRetry(error: AppErrorInfo, retry?: () => void): boolean {
  if (!retry) return false;
  if (error.outcomeUnknown) return false;
  if (error.stage === "cancelled") return false;
  return true;
}
