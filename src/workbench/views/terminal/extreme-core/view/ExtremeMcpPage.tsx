/**
 * 超能模式 → MCP：市场 / 我的连接。
 *
 * 市场只提供**候选连接配置**（本地点目录 + 官方 Registry），真实能力以
 * 连接测试发现的工具为准；添加后配置与令牌分别落 SQLite 和系统钥匙串。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  Globe,
  Loader2,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { PaneTabBar } from "@/components/ui/pane-tab-bar";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorState } from "@/components/ui/error-state";
import { Field, Modal, fieldClass } from "@/components/ui/modal";
import { useActionError } from "@/hooks/use-action-error";
import { i18n } from "@/i18n";
import { cn } from "@/lib/cn";
import { copyTextWithFeedback } from "@/lib/clipboard-feedback";
import { openExternal } from "@/lib/open-external";
import {
  chosen,
  mcpSessionKey,
  useExtremeMcpSelection,
} from "@/stores/extreme-mcp-selection";

import { opsApi } from "@/api/ops-api";
import type {
  McpRegistryEntry,
  McpRuntimeDetail,
  McpRuntimeId,
  McpRuntimeReport,
  McpRuntimeStatus,
  McpScope,
  McpServerInput,
  McpServerView,
} from "@/api/types/mcp";
import { BUILTIN_MCP_SKILLS } from "../mcp-capabilities";
import { backendChangeText } from "../file-changes";
import {
  catalogInstances,
  catalogToInput,
  registryToCatalog,
  type McpCatalogEntry,
} from "../mcp-catalog";
import { bumpMcpData, checkMcpServer, useMcpHealthVersion } from "../mcp-events";
import { ExtremePageShell } from "./ExtremePageShell";
import {
  CommandProbeSummary,
  RuntimeDiagnostics,
  RuntimeStatusStrip,
  runtimeBlocksAdd,
  runtimeStatusLabel,
} from "./McpRuntimePanel";

function MarketIcon({ entry }: { entry: McpCatalogEntry }) {
  const [failed, setFailed] = useState(false);
  const iconUrl = entry.iconUrl;
  if (!iconUrl || !/^https:\/\//i.test(iconUrl) || failed) return null;
  return <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-active/55"><img src={iconUrl} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-7 object-contain" onError={() => setFailed(true)} /></span>;
}

type Tab = "market" | "connections";

type Draft = {
  id: string | null;
  catalogId?: string | null;
  /** 来自市场目录时，用配置字段生成 URL / Header / env。 */
  catalog?: McpCatalogEntry;
  values: Record<string, string>;
  name: string;
  transport: "http" | "stdio";
  command: string;
  argsText: string;
  envText: string;
  url: string;
  headersText: string;
  enabled: boolean;
  defaultEnabled: boolean;
  binding: McpScope;
  tools: McpServerView["tools"];
  resources: McpServerView["resources"];
  prompts: McpServerView["prompts"];
  /** 编辑时仅展示：已有令牌不回显。 */
  envSaved?: string[];
  headerSaved?: string[];
};

function parsePairs(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf("=");
      return index < 0
        ? { name: line, value: "" }
        : { name: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
    })
    .filter((item) => item.name);
}

function pairsText(items: { name: string; value?: string; hasValue?: boolean }[]): string {
  return items
    .map((item) => (item.value ? `${item.name}=${item.value}` : item.hasValue ? `${item.name}=` : ""))
    .filter(Boolean)
    .join("\n");
}

function draftFromServer(server: McpServerView): Draft {
  return {
    id: server.id,
    catalogId: server.catalogId,
    values: {},
    name: server.name,
    transport: server.transport,
    command: server.command,
    argsText: server.args.join("\n"),
    envText: pairsText(server.env),
    url: server.url,
    headersText: pairsText(server.headers),
    enabled: server.enabled,
    defaultEnabled: server.defaultEnabled,
    // MCP 只有全局作用域；旧记录打开编辑时也统一成 global。
    binding: { scope: "global", workspaceId: null, serverId: null },
    tools: server.tools,
    resources: server.resources,
    prompts: server.prompts,
    envSaved: server.env.filter((item) => item.hasValue).map((item) => item.name),
    headerSaved: server.headers.filter((item) => item.hasValue).map((item) => item.name),
  };
}

function catalogDraft(
  entry: McpCatalogEntry,
  values: Record<string, string>,
  scope: { workspaceId: string | null; serverId: string | null; serverName: string },
): Draft {
  const input = catalogToInput(entry, values, scope);
  return {
    id: null,
    catalog: entry,
    values,
    name: input.name,
    transport: input.transport,
    command: input.command,
    argsText: input.args.join("\n"),
    envText: input.env.map((item) => `${item.name}=${item.value}`).join("\n"),
    url: input.url,
    headersText: input.headers.map((item) => `${item.name}=${item.value}`).join("\n"),
    enabled: true,
    defaultEnabled: true,
    binding: input.binding,
    tools: [],
    resources: [],
    prompts: [],
  };
}

function emptyCustom(
  _scope: { workspaceId: string | null; serverId: string | null },
  transport: "http" | "stdio" = "http",
): Draft {
  return {
    id: null,
    values: {},
    name: "",
    transport,
    command: "",
    argsText: "",
    envText: "",
    url: "",
    headersText: "",
    enabled: true,
    defaultEnabled: true,
    binding: { scope: "global", workspaceId: null, serverId: null },
    tools: [],
    resources: [],
    prompts: [],
  };
}

function buildInput(
  draft: Draft,
  scope: { workspaceId: string | null; serverId: string | null; serverName: string },
): McpServerInput {
  if (draft.catalog) {
    const generated = catalogToInput(draft.catalog, draft.values, scope);
    return {
      ...generated,
      id: draft.id,
      name: draft.name.trim() || generated.name,
      // 目录模板可能随实例不同：允许用户改生成出的地址/命令，但不改 Header。
      url: draft.url.trim() || generated.url,
      command: draft.command.trim() || generated.command,
      enabled: draft.enabled,
      defaultEnabled: draft.defaultEnabled,
      binding: draft.binding,
    };
  }
  return {
    id: draft.id,
    name: draft.name.trim(),
    catalogId: draft.catalogId ?? null,
    binding: draft.binding,
    defaultEnabled: draft.defaultEnabled,
    transport: draft.transport,
    command: draft.command.trim(),
    args: draft.argsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    env: parsePairs(draft.envText),
    url: draft.url.trim(),
    headers: parsePairs(draft.headersText),
    enabled: draft.enabled,
    tools: draft.tools,
    resources: draft.resources,
    prompts: draft.prompts,
  };
}

/** 市场条目的"添加前条件"，和用户实例的连接状态是两件事。 */
function AvailabilityBadge({ entry }: { entry: McpCatalogEntry }) {
  const { t } = useTranslation();
  const label =
    entry.availability === "addable"
      ? t("可添加")
      : entry.availability === "oauth"
        ? t("需要 OAuth")
        : entry.availability === "local-runtime"
          ? t("需要本地运行环境")
          : t("暂不支持");
  return (
    <span
      className={cn(
        "rounded px-1 text-9",
        entry.availability === "addable"
          ? "bg-accent/10 text-accent"
          : entry.availability === "unsupported"
            ? "bg-surface-active text-fg-subtle"
            : "bg-warning/10 text-warning",
      )}
    >
      {label}
    </span>
  );
}

/** 本地 stdio 条目的运行环境入口：给出缺什么、去哪装、装完怎么继续。 */
function runtimeForCommand(
  commandRaw: string,
  docsUrl: string,
): {
  name: string;
  installUrl: string;
  command: string;
  commandWindows?: string;
} {
  const command = commandRaw.toLowerCase();
  if (command.includes("uvx") || command.includes("uv")) {
    return {
      name: "uv / uvx",
      installUrl: "https://docs.astral.sh/uv/getting-started/installation/",
      command: "curl -LsSf https://astral.sh/uv/install.sh | sh",
      commandWindows: 'powershell -c "irm https://astral.sh/uv/install.ps1 | iex"',
    };
  }
  if (command.includes("npx") || command.includes("node")) {
    return {
      name: "Node.js / npx",
      installUrl: "https://nodejs.org/en/download",
      command: "node --version && npx --version",
      commandWindows: "winget install OpenJS.NodeJS.LTS",
    };
  }
  if (command.includes("docker")) {
    return {
      name: "Docker",
      installUrl: "https://docs.docker.com/get-docker/",
      command: "docker --version",
      commandWindows: "winget install Docker.DockerDesktop",
    };
  }
  return {
    name: commandRaw || i18n.t("本地运行环境"),
    installUrl: docsUrl,
    command: commandRaw,
  };
}

/** 连接命令 → 市场里的运行时 id（只用于筛选诊断信息，不做安装判断）。 */
function runtimeIdForCommand(commandRaw: string): McpRuntimeId | null {
  const file = commandRaw.trim().toLowerCase().split(/[\\/]/).pop() ?? "";
  const base = file.replace(/\.(exe|cmd|bat)$/, "");
  if (base === "uv" || base === "uvx") return base;
  if (base === "npx" || base === "npm" || base === "node") return "npx";
  if (base.startsWith("docker")) return "docker";
  return null;
}

function missingRuntime(server: McpServerView): boolean {
  return (
    server.transport === "stdio" &&
    // 404 日志里也有 "Not Found"，不要把它误判成运行环境缺失。
    /启动 MCP 服务失败|找不到可执行文件|not recognized|command not found|ENOENT|不是内部或外部命令/i.test(
      server.error ?? "",
    )
  );
}

function needsAuth(server: McpServerView): boolean {
  return (
    server.status === "error" &&
    /401|403|unauthoriz|forbidden|authentication|授权/i.test(server.error ?? "")
  );
}

type ConnectionState =
  | "disabled"
  | "unknown"
  | "auth"
  | "connected"
  | "empty"
  | "tools_error"
  | "error";

/** 实例级六态：停用优先，其次才是验证结果。 */
function connectionState(server: McpServerView): ConnectionState {
  if (!server.enabled) return "disabled";
  if (server.status === "connected") {
    return server.tools.length > 0 ? "connected" : "empty";
  }
  if (server.status === "tools_error") return "tools_error";
  if (server.status === "error") return needsAuth(server) ? "auth" : "error";
  return "unknown";
}

/** 失败细分：包下载 / 进程启动 / 握手 / 权限，避免都显示成"连接失败"。 */
function failureLabel(error: string | null | undefined, t: (key: string) => string): string {
  const text = error ?? "";
  if (/失败阶段：初始化握手/.test(text)) return t("服务握手失败");
  if (/失败阶段：读取服务能力/.test(text)) return t("工具发现失败");
  if (/失败阶段：启动 MCP 进程/.test(text)) {
    if (/Docker 已安装，但服务尚未启动/.test(text)) return t("Docker 服务未启动");
    if (/找不到可执行文件/.test(text)) return t("运行环境未就绪");
    return t("MCP 进程启动失败");
  }
  if (/包下载失败/.test(text)) return t("包下载失败");
  if (/包不存在或版本不可用|这个 npm 包不存在/.test(text)) return t("包不存在");
  if (/Docker 已安装，但服务尚未启动/.test(text)) return t("Docker 服务未启动");
  return t("连接失败");
}

function connectionLabel(
  state: ConnectionState,
  t: (key: string) => string,
  error?: string | null,
): string {
  switch (state) {
    case "disabled":
      return t("已停用");
    case "auth":
      return t("需要授权");
    case "connected":
      return t("已连接");
    case "empty":
      return t("已连接但无可用工具");
    case "tools_error":
      return t("工具发现失败");
    case "error":
      return failureLabel(error, t);
    default:
      return t("未验证");
  }
}

/**
 * 连接测试的反馈条。
 *
 * `npx` / `uvx` 首次运行会下载依赖，后端是一条 IPC 请求，拿不到字节级进度；
 * 这里显示**阶段 + 已用时间 + 不确定进度条**，不让界面看起来卡死。
 */
function McpProgress({
  startedAt,
  local,
}: {
  startedAt: number | null;
  local: boolean;
}) {
  const { t } = useTranslation();
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!startedAt) return undefined;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const seconds = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
  const label =
    seconds < 3
      ? local
        ? t("正在启动本地进程…")
        : t("正在连接服务…")
      : seconds < 12
        ? t("正在握手并读取服务能力…")
        : local
          ? t("等待工具发现（首次运行可能正在下载依赖包或拉取镜像）…")
          : t("等待工具列表…");
  return (
    <div className="mt-1.5" role="status" aria-live="polite">
      <style>{`
        @keyframes mcp-progress-slide {
          0% { transform: translateX(-110%); }
          100% { transform: translateX(340%); }
        }
        @media (prefers-reduced-motion: reduce) {
          .mcp-progress-bar { animation: none !important; width: 100% !important; opacity: 0.55; }
        }
      `}</style>
      <div className="flex items-center gap-2 text-9 text-fg-subtle">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {startedAt && <span className="shrink-0 tabular-nums">{seconds}s</span>}
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-active">
        <span
          className="mcp-progress-bar block h-full w-1/3 rounded-full bg-accent/70"
          style={{ animation: "mcp-progress-slide 1.4s ease-in-out infinite" }}
        />
      </div>
    </div>
  );
}

function ConnectionDot({ state }: { state: ConnectionState }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        state === "connected"
          ? "bg-accent"
          : state === "empty" || state === "auth" || state === "tools_error"
            ? "bg-warning"
            : state === "error"
              ? "bg-danger"
              : "bg-fg-subtle/50",
      )}
    />
  );
}

function ConnectionForm({
  draft,
  busy,
  scope,
  onChange,
  onCancel,
  onSave,
}: {
  draft: Draft;
  busy: boolean;
  scope: { workspaceId: string | null; serverId: string | null; serverName: string };
  onChange: (next: Draft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const previewUrl = draft.catalog
    ? catalogToInput(draft.catalog, draft.values, scope).url
    : draft.url;
  return (
    <Modal
      open
      width={620}
      title={draft.id ? t("编辑 MCP 连接") : draft.catalog ? t("添加 {{name}}", { name: draft.catalog.name }) : t("自定义 MCP 连接")}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            {t("取消")}
          </Button>
          {/* 添加流程不在表单里强制测试：保存后由后台自动连接并发现工具。 */}
          <Button size="sm" onClick={onSave} disabled={busy}>
            {draft.id
              ? busy ? t("保存中") : t("保存")
              : busy ? t("正在添加…") : t("添加连接")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {draft.catalog && (
          <div className="rounded-lg border border-line/60 p-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-12 font-medium text-fg">{draft.catalog.name}</span>
              <span className="text-10 text-fg-subtle">{draft.catalog.publisher}</span>
              <AvailabilityBadge entry={draft.catalog} />
            </div>
            <p className="mt-1 whitespace-pre-wrap text-10 leading-4 text-fg-muted">
              {t(draft.catalog.detail)}
            </p>
            <div className="mt-1.5 flex flex-wrap gap-3 text-10">
              {draft.catalog.docsUrl && (
                <a
                  className="inline-flex items-center gap-1 text-accent hover:underline"
                  href={draft.catalog.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("官方文档")} <Globe size={10} />
                </a>
              )}
              {draft.catalog.upstreamUrl && (
                <span className="truncate text-fg-subtle">
                  {t("上游来源")}：{draft.catalog.upstreamUrl}
                </span>
              )}
            </div>
          </div>
        )}

        <Field label={t("名称")} hint={t("同一服务可以配多个实例，例如「Grafana · 生产」。")}>
          <input
            className={fieldClass}
            data-testid="mcp-name"
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
        </Field>

        {draft.catalog ? (
          <div className="flex flex-col gap-3">
            {draft.catalog.configFields.map((field) => (
              <Field
                key={field.key}
                label={t(field.label)}
                hint={field.required ? t("必填") : t("可选")}
              >
                <input
                  className={fieldClass}
                  type={field.secret ? "password" : "text"}
                  autoComplete={field.secret ? "off" : undefined}
                  data-testid={`mcp-field-${field.key}`}
                  placeholder={field.placeholder}
                  value={draft.values[field.key] ?? ""}
                  onChange={(event) => {
                    const values = { ...draft.values, [field.key]: event.target.value };
                    const generated = catalogToInput(draft.catalog!, values, scope);
                    onChange({
                      ...draft,
                      values,
                      url: generated.url,
                      command: generated.command,
                      headersText: generated.headers
                        .map((item) => `${item.name}=${item.value}`)
                        .join("\n"),
                      envText: generated.env
                        .map((item) => `${item.name}=${item.value}`)
                        .join("\n"),
                    });
                  }}
                />
              </Field>
            ))}
            {draft.catalog.transport === "http" ? (
              <Field
                label={t("服务地址（可修改）")}
                hint={t("已按模板预填；实例地址不同或模板变更时以这里为准。")}
              >
                <input
                  className={fieldClass}
                  data-testid="mcp-catalog-url"
                  value={draft.url}
                  onChange={(event) => onChange({ ...draft, url: event.target.value })}
                />
              </Field>
            ) : (
              <Field label={t("启动命令（可修改）")} hint={t("默认使用目录模板。")}>
                <input
                  className={fieldClass}
                  data-testid="mcp-catalog-command"
                  value={draft.command}
                  onChange={(event) => onChange({ ...draft, command: event.target.value })}
                />
              </Field>
            )}
            <p className="break-all text-10 text-fg-subtle">
              {t("当前目标：{{url}}", { url: previewUrl || draft.command || "—" })}
            </p>
          </div>
        ) : (
          <>
            <div className="flex gap-1.5">
              {(["http", "stdio"] as const).map((transport) => (
                <button
                  key={transport}
                  type="button"
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-11",
                    draft.transport === transport
                      ? "border-accent/50 bg-accent/10 text-accent"
                      : "border-line/60 text-fg-muted hover:bg-surface-hover",
                  )}
                  onClick={() => onChange({ ...draft, transport })}
                >
                  {transport === "http" ? t("远程 HTTP") : t("本地进程（stdio）")}
                </button>
              ))}
            </div>
            {draft.transport === "http" ? (
              <>
                <Field label={t("服务地址")} hint={t("Streamable HTTP 的 MCP 端点（http/https）。")}>
                  <input
                    className={fieldClass}
                    data-testid="mcp-url"
                    value={draft.url}
                    onChange={(event) => onChange({ ...draft, url: event.target.value })}
                  />
                </Field>
                <Field
                  label={t("请求 Header")}
                  hint={t("一行一个 KEY=VALUE；令牌写入系统钥匙串，值留空表示保留原值。")}
                >
                  <textarea
                    className={cn(fieldClass, "min-h-[64px] font-mono text-11")}
                    data-testid="mcp-headers"
                    value={draft.headersText}
                    onChange={(event) => onChange({ ...draft, headersText: event.target.value })}
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label={t("启动命令")} hint={t("例如 npx、uvx 或服务自己的可执行文件。")}>
                  <input
                    className={fieldClass}
                    data-testid="mcp-command"
                    value={draft.command}
                    onChange={(event) => onChange({ ...draft, command: event.target.value })}
                  />
                </Field>
                <Field label={t("参数")} hint={t("一行一个参数。")}>
                  <textarea
                    className={cn(fieldClass, "min-h-[64px] font-mono text-11")}
                    data-testid="mcp-args"
                    value={draft.argsText}
                    onChange={(event) => onChange({ ...draft, argsText: event.target.value })}
                  />
                </Field>
                <Field
                  label={t("环境变量")}
                  hint={t("一行一个 KEY=VALUE；值写入系统钥匙串，留空表示保留原值。")}
                >
                  <textarea
                    className={cn(fieldClass, "min-h-[56px] font-mono text-11")}
                    data-testid="mcp-env"
                    value={draft.envText}
                    onChange={(event) => onChange({ ...draft, envText: event.target.value })}
                  />
                </Field>
              </>
            )}
          </>
        )}

        <div className="rounded-md border border-line/60 bg-surface-1/40 px-2.5 py-2">
          <p className="text-11 font-medium text-fg">{t("作用范围：全局")}</p>
          <p className="mt-0.5 text-10 leading-4 text-fg-subtle">
            {t("所有服务器的任务都可以使用这个连接；实际调用仍受会话权限、连接状态和工具级权限约束，不绑定到某台服务器。")}
          </p>
        </div>
        <div className="flex flex-wrap gap-4 text-11 text-fg-muted">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              data-testid="mcp-enabled"
              checked={draft.enabled}
              onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
            />
            {t("启用这个连接")}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              data-testid="mcp-default-enabled"
              checked={draft.defaultEnabled}
              onChange={(event) =>
                onChange({ ...draft, defaultEnabled: event.target.checked })
              }
            />
            {t("连接成功后默认勾选")}
          </label>
        </div>

      </div>
    </Modal>
  );
}

export function ExtremeMcpPage({
  initialTab = "market",
  workspaceId,
  serverId,
  serverName,
  connected,
  onBack,
}: {
  initialTab?: Tab;
  workspaceId: string | null;
  serverId: string | null;
  serverName: string;
  connected: boolean;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>(initialTab);
  const mcpVersion = useMcpHealthVersion();
  const [servers, setServers] = useState<McpServerView[] | null>(null);
  const [detail, setDetail] = useState<{ entry: McpCatalogEntry; values: Record<string, string> } | null>(
    null,
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<McpServerView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyStartedAt, setBusyStartedAt] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  /** 已存在的 stdio 连接启动失败时，给出本机运行环境的安装入口。 */
  const [repairServer, setRepairServer] = useState<McpServerView | null>(null);
  /** 安装弹窗里的实时检测结果（含脱敏路径 / 版本 / 失败原因）。 */
  const [repairReport, setRepairReport] = useState<McpRuntimeReport | null>(null);
  const [repairChecking, setRepairChecking] = useState(false);
  const [repairError, setRepairError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importPreview, setImportPreview] = useState<
    { input: McpServerInput; label: string }[] | null
  >(null);
  const [registry, setRegistry] = useState<{
    query: string;
    entries: McpRegistryEntry[];
    cursor: string | null;
    loading: boolean;
    error: string | null;
    searched: boolean;
    resultQuery: string;
    loadingMore: boolean;
    runtimes: Partial<Record<McpRuntimeId, McpRuntimeStatus>>;
    runtimeDetails: McpRuntimeDetail[];
    runtimeCheckedAt: number | null;
    runtimeChecking: boolean;
    runtimeError: string | null;
  }>({
    query: "",
    entries: [],
    cursor: null,
    loading: false,
    error: null,
    searched: false,
    resultQuery: "",
    loadingMore: false,
    runtimes: {},
    runtimeDetails: [],
    runtimeCheckedAt: null,
    runtimeChecking: false,
    runtimeError: null,
  });
  const registryRequest = useRef(0);
  useEffect(() => () => { registryRequest.current += 1; }, []);
  const { error, fail, clear, retry } = useActionError();
  const bySession = useExtremeMcpSelection((state) => state.bySession);
  const setChoice = useExtremeMcpSelection((state) => state.setChoice);
  const sessionKey = mcpSessionKey(workspaceId, serverId);

  const load = useCallback(async () => {
    const list = await opsApi.mcpServerList();
    setServers(Array.isArray(list) ? list : []);
  }, []);

  const applySavedServer = (saved: McpServerView) => {
    setServers((current) => [saved, ...(current ?? []).filter(({ id }) => id !== saved.id)]);
    bumpMcpData();
  };

  useEffect(() => {
    void load().catch((cause) => fail(cause, () => void load()));
  }, [load, fail, mcpVersion]);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  const scope = useMemo(
    () => ({ workspaceId, serverId, serverName }),
    [workspaceId, serverId, serverName],
  );

  const visibleRegistryEntries = useMemo(() => {
    const seen = new Set<string>();
    return registry.entries.map(registryToCatalog).filter((entry) => {
      if (entry.availability === "unsupported" || seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
  }, [registry.entries]);

  const searchRegistry = async (nextQuery: string, cursor: string | null, append: boolean) => {
    const requestId = ++registryRequest.current;
    const query = nextQuery.trim();
    setRegistry((current) => ({ ...current, loading: true, loadingMore: append, error: null, searched: true, resultQuery: query, ...(append ? {} : { entries: [], cursor: null }) }));
    try {
      const result = await opsApi.mcpRegistrySearch(query, cursor, 20);
      if (requestId !== registryRequest.current) return;
      setRegistry((current) => ({
        ...current,
        entries: append ? [...current.entries, ...result.servers] : result.servers,
        cursor: result.nextCursor ?? null,
        loading: false,
        loadingMore: false,
        runtimes: result.runtimes ?? {},
        runtimeDetails: result.runtimeDetails ?? [],
        runtimeCheckedAt: result.runtimeCheckedAt ?? null,
      }));
    } catch (cause) {
      if (requestId !== registryRequest.current) return;
      setRegistry((current) => ({ ...current, loading: false, loadingMore: false, error: cause instanceof Error ? cause.message : String(cause) }));
    }
  };

  /**
   * 重新检测运行环境：只刷新状态，不清空搜索结果、不动已有连接。
   *
   * 用户装完 uv / Node / Docker 后点这里就能继续添加，不需要重启应用：
   * 后端每次检测都会重新读用户级与系统级 PATH。
   */
  const recheckRuntimes = useCallback(async (): Promise<McpRuntimeReport | null> => {
    setRegistry((current) => ({ ...current, runtimeChecking: true, runtimeError: null }));
    try {
      const report = await opsApi.mcpRuntimeStatus();
      setRegistry((current) => ({
        ...current,
        runtimeChecking: false,
        runtimes: report.statuses ?? {},
        runtimeDetails: report.runtimes ?? [],
        runtimeCheckedAt: report.checkedAt ?? null,
      }));
      return report;
    } catch (cause) {
      setRegistry((current) => ({
        ...current,
        runtimeChecking: false,
        runtimeError: cause instanceof Error ? cause.message : String(cause),
      }));
      return null;
    }
  }, []);

  const testServer = async (server: McpServerView) => {
    setBusyId(server.id);
    setBusyStartedAt(Date.now());
    clear();
    try {
      const result = await checkMcpServer(server.id);
      setServers((current) =>
        (current ?? []).map((item) =>
          item.id === server.id
            ? {
              ...item,
              status: result.status,
              error: result.error ?? null,
              warnings: result.warnings ?? [],
              protocolVersion: result.protocolVersion ?? null,
              tools: result.tools,
              resources: result.resources,
              prompts: result.prompts,
            }
            : item,
        ),
      );
      bumpMcpData();
    } catch (cause) {
      fail(cause, () => void testServer(server));
    } finally {
      setBusyId(null);
      setBusyStartedAt(null);
    }
  };

  /** 打开修复弹窗时先检测一次：直接告诉用户"装在哪、能不能跑"。 */
  const openRepair = (server: McpServerView) => {
    setRepairServer(server);
    setRepairReport(null);
    setRepairError(null);
    void runRepairCheck(server.command);
  };

  const runRepairCheck = async (command: string): Promise<McpRuntimeReport | null> => {
    setRepairChecking(true);
    setRepairError(null);
    try {
      const report = await opsApi.mcpRuntimeStatus(command);
      setRepairReport(report);
      return report;
    } catch (cause) {
      setRepairError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      setRepairChecking(false);
    }
  };

  /**
   * 安装完点这里：先重新检测，确认能跑再重试连接。
   * 只调用连接测试，不重复保存配置，也不会创建第二条连接。
   */
  const retryWithRecheck = async () => {
    if (!repairServer) return;
    const target = repairServer;
    const report = await runRepairCheck(target.command);
    if (report?.command?.status === "ready") {
      setRepairServer(null);
      setRepairReport(null);
      await testServer(target);
    }
  };

  const toggleTool = async (server: McpServerView, tool: string, enabled: boolean) => {
    setServers((current) =>
      (current ?? []).map((item) =>
        item.id === server.id
          ? {
            ...item,
            tools: item.tools.map((entry) =>
              entry.name === tool ? { ...entry, enabled } : entry,
            ),
          }
          : item,
      ),
    );
    try {
      await opsApi.mcpToolSetEnabled(server.id, tool, enabled);
      bumpMcpData();
    } catch (cause) {
      fail(cause, () => void load());
    }
  };

  const toggleServer = async (server: McpServerView, enabled: boolean) => {
    try {
      const saved = await opsApi.mcpServerSave({
        id: server.id,
        name: server.name,
        catalogId: server.catalogId ?? null,
        binding: server.binding,
        defaultEnabled: server.defaultEnabled,
        transport: server.transport,
        command: server.command,
        args: server.args,
        env: server.env,
        url: server.url,
        headers: server.headers,
        enabled,
        tools: server.tools,
        resources: server.resources,
        prompts: server.prompts,
      });
      applySavedServer(saved);
      // 启用后由后台重新握手；用户不需要再到表单里点一次测试。
      if (enabled && saved.status !== "connected") await testServer(saved);
    } catch (cause) {
      fail(cause, () => void load());
    }
  };

  /** 目录条目在"必填项齐全 / 本地环境已就绪"时的直接添加路径。 */
  const saveCatalog = async (entry: McpCatalogEntry, values: Record<string, string>) => {
    setSaving(true);
    clear();
    try {
      const saved = await opsApi.mcpServerSave(catalogToInput(entry, values, scope));
      applySavedServer(saved);
      if (saved.enabled) await testServer(saved);
    } catch (cause) {
      fail(cause, () => void saveCatalog(entry, values));
    } finally {
      setSaving(false);
    }
  };

  const addFromMarket = async (entry: McpCatalogEntry) => {
    if (entry.availability !== "unsupported" && !entry.configFields.some((field) => field.required)) {
      await saveCatalog(entry, {});
      return;
    }
    openDetail(entry);
  };

  const saveDraft = async () => {
    if (!draft) return;
    setSaving(true);
    clear();
    try {
      const input = buildInput(draft, scope);
      const saved = await opsApi.mcpServerSave(input);
      setDraft(null);
      applySavedServer(saved);
      // 保存后立刻握手一次：市场卡/聊天菜单马上能看到真实工具与状态。
      if (saved.enabled) await testServer(saved);
      if (!draft.catalog) setTab("connections");
    } catch (cause) {
      fail(cause, () => void saveDraft());
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setSaving(true);
    clear();
    try {
      await opsApi.mcpServerDelete(deleteTarget.id);
      setDeleteTarget(null);
      setServers((current) => (current ?? []).filter(({ id }) => id !== deleteTarget.id));
      bumpMcpData();
    } catch (cause) {
      fail(cause, () => void remove());
    } finally {
      setSaving(false);
    }
  };

  const parseImport = () => {
    try {
      const parsed = JSON.parse(importText) as Record<string, unknown>;
      const source =
        (parsed.mcpServers as Record<string, unknown> | undefined) ??
        (parsed.servers as Record<string, unknown> | undefined) ??
        (typeof parsed.url === "string" || typeof parsed.command === "string"
          ? { single: parsed }
          : null);
      if (!source) throw new Error(t("未找到 mcpServers / servers 配置"));
      const inputs: { input: McpServerInput; label: string }[] = [];
      for (const [name, value] of Object.entries(source)) {
        const config = (value ?? {}) as Record<string, unknown>;
        const url = typeof config.url === "string" ? config.url : "";
        const command = typeof config.command === "string" ? config.command : "";
        if (!url && !command) continue;
        const headers = Object.entries(
          (config.headers as Record<string, string> | undefined) ?? {},
        ).map(([key, header]) => ({ name: key, value: String(header) }));
        const env = Object.entries((config.env as Record<string, string> | undefined) ?? {}).map(
          ([key, entry]) => ({ name: key, value: String(entry) }),
        );
        inputs.push({
          label: name,
          input: {
            id: null,
            name,
            catalogId: null,
            binding: {
              scope: "workspace",
              workspaceId,
              serverId: null,
            },
            defaultEnabled: true,
            transport: url ? "http" : "stdio",
            command,
            args: Array.isArray(config.args) ? config.args.map(String) : [],
            env,
            url,
            headers,
            enabled: true,
            tools: [],
            resources: [],
            prompts: [],
          },
        });
      }
      if (inputs.length === 0) throw new Error(t("没有可导入的服务"));
      setImportPreview(inputs);
      clear();
    } catch (cause) {
      fail(cause);
    }
  };

  const confirmImport = async () => {
    if (!importPreview) return;
    setSaving(true);
    clear();
    try {
      const saved: McpServerView[] = [];
      for (const item of importPreview) {
        const server = await opsApi.mcpServerSave(item.input);
        saved.push(server);
        applySavedServer(server);
      }
      setImportOpen(false);
      setImportPreview(null);
      setImportText("");
      setTab("connections");
      // 与"自定义添加"同一套后台连接流程：保存后自动握手并发现工具。
      for (const server of saved.filter((item) => item.enabled)) {
        await testServer(server);
      }
    } catch (cause) {
      fail(cause, () => void confirmImport());
    } finally {
      setSaving(false);
    }
  };

  const openDetail = (entry: McpCatalogEntry) => {
    setDetail({ entry, values: {} });
  };

  const startCatalog = () => {
    if (!detail) return;
    const missing = detail.entry.configFields.find(
      (field) => field.required && !detail.values[field.key]?.trim(),
    );
    if (missing) {
      fail(new Error(t("请填写 {{label}}", { label: t(missing.label) })));
      return;
    }
    if (detail.entry.availability === "local-runtime") {
      setDetail(null);
      void saveCatalog(detail.entry, detail.values);
      return;
    }
    setDraft(catalogDraft(detail.entry, detail.values, scope));
    setDetail(null);
  };

  const openImport = () => {
    setImportOpen(true);
    setImportPreview(null);
    setImportText("");
  };

  const openCustom = () => {
    setDraft(emptyCustom({ workspaceId, serverId }));
  };

  const detailInput = detail
    ? catalogToInput(detail.entry, detail.values, scope)
    : null;

  const renderMarketEntry = (entry: McpCatalogEntry) => {
    const instances = catalogInstances(entry, servers ?? []);
    const ready = instances.find((server) => connectionState(server) === "connected");
    const testing = instances.find((server) => server.id === busyId && server.enabled);
    const primary = ready ?? testing ?? instances.find((server) => server.enabled) ?? instances[0];
    const state = primary ? connectionState(primary) : null;
    const pending = Boolean(primary && primary.id === busyId && primary.enabled);
    const canRetry = state === "error" || state === "tools_error";
    const runtime = entry.transport === "stdio" && (entry.command === "npx" || entry.command === "uvx" || entry.command === "docker")
      ? (entry.command as McpRuntimeId)
      : null;
    const runtimeState: McpRuntimeStatus | null = runtime
      ? registry.runtimes[runtime] ?? "unknown"
      : null;
    const runtimeBlocked = runtimeBlocksAdd(runtimeState);
    const runtimeDetail = runtime
      ? registry.runtimeDetails.find((item) => item.id === runtime) ?? null
      : null;
    const status = pending ? t("正在连接服务…")
      : state === "unknown" ? t("已添加 · 未验证")
        : state ? connectionLabel(state, t, primary?.error) : null;
    const action = pending ? t("测试中…")
      : canRetry ? t("重试")
        : primary ? t("管理")
          : entry.availability === "unsupported" ? t("查看限制")
            : entry.availability === "local-runtime" ? t("添加") : t("连接");

    return (
      <article
        key={entry.id}
        data-testid={`mcp-market-${entry.id}`}
        className="min-w-0 overflow-hidden rounded-2xl border border-line/60 bg-surface-2 text-fg shadow-[0_2px_12px_rgb(0_0_0/0.04)] transition-colors duration-150 hover:border-line-strong"
      >
        <div className="flex min-w-0 items-start gap-3 px-5 pb-2 pt-4">
          <MarketIcon key={entry.iconUrl ?? entry.id} entry={entry} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="min-w-0 break-words text-13 font-medium leading-5">{entry.name}</h3>
              {status && <span className="flex items-center gap-1 text-11 text-fg-subtle" role="status">
                {state && !pending && <ConnectionDot state={state} />}{status}
              </span>}
            </div>
            <p className="mt-1 break-words text-12 leading-5 text-fg-muted">{t(entry.summary)}</p>
            <p className="mt-2 break-all text-11 text-fg-subtle">{entry.publisher}{entry.version ? ` · v${entry.version}` : ""}</p>
            {runtime && runtimeState && <p className={cn("mt-2 text-11", runtimeBlocked ? "text-warning" : "text-fg-subtle")} role="status">
              {runtime === "docker" ? t("运行方式：Docker 镜像") : t("运行方式：{{runtime}} 自动下载", { runtime })} ·{" "}
              {runtimeState === "ready"
                ? t("本机环境已就绪")
                : runtimeState === "not_running"
                  ? t("Docker 已安装，服务尚未启动")
                  : runtimeStatusLabel(runtimeState, t)}
            </p>}
            {runtime && runtimeBlocked && (
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <button type="button" className="text-11 text-accent hover:underline" onClick={() => void openExternal(runtimeForCommand(runtime, "").installUrl)}>
                  {t("查看运行环境安装说明")}
                </button>
                <button
                  type="button"
                  className="text-11 text-accent hover:underline disabled:opacity-60"
                  disabled={registry.runtimeChecking}
                  onClick={() => void recheckRuntimes()}
                >
                  {registry.runtimeChecking ? t("检测中…") : t("重新检测")}
                </button>
              </div>
            )}
            {runtime && runtimeBlocked && runtimeDetail && (
              <details className="mt-1">
                <summary className="cursor-pointer select-none text-10 text-fg-subtle hover:text-fg">{t("诊断详情")}</summary>
                <RuntimeDiagnostics details={[runtimeDetail]} />
              </details>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 px-5 pb-4 pt-2">
          <Button size="sm" variant="ghost" className="rounded-full" onClick={() => openDetail(entry)}>{t("查看详情")}</Button>
          <Button
            size="sm"
            className="rounded-full"
            variant={primary || entry.availability === "unsupported" ? "secondary" : "primary"}
            disabled={servers === null || saving || pending || (!primary && runtimeBlocked) || (canRetry && busyId !== null)}
            onClick={() => {
              if (!primary) void addFromMarket(entry);
              else if (canRetry) void testServer(primary);
              else setTab("connections");
            }}
          >
            {action}
          </Button>
        </div>
      </article>
    );
  };

  return (
    <ExtremePageShell
      title="MCP"
      description="市场、连接与可用能力"
      onBack={onBack}
      actions={
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="xs" onClick={openImport} data-testid="mcp-import">
            {t("导入 JSON")}
          </Button>
          <Button variant="ghost" size="xs" onClick={openCustom} data-testid="mcp-custom-add">
            <Plus size={13} /> {t("自定义添加")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <PaneTabBar
          ariaLabel={t("MCP")}
          value={tab}
          onChange={(value) => setTab(value as Tab)}
          tabs={[{ id: "market", label: t("市场"), icon: Globe }, { id: "connections", label: t("我的连接"), icon: Plug }]}
        />

        {error ? <ErrorState error={error} compact onRetry={retry} /> : null}

        {tab === "market" ? (
          <>
            <RuntimeStatusStrip
              statuses={registry.runtimes}
              details={registry.runtimeDetails}
              checking={registry.runtimeChecking}
              error={registry.runtimeError}
              onRecheck={() => void recheckRuntimes()}
            />
            <section>
              <div className="mb-3 flex items-center gap-2">
                <h2 className="text-13 font-medium text-fg">{t("官方 MCP Registry")}</h2>
              </div>
              <div className="flex items-center gap-2 rounded-2xl border border-line/60 bg-surface-2 p-2 shadow-[0_2px_12px_rgb(0_0_0/0.04)] focus-within:border-accent/60">
                <Search size={16} className="ml-2 shrink-0 text-fg-subtle" />
                <input
                  className="h-8 min-w-0 flex-1 bg-transparent px-1 text-12 text-fg outline-none placeholder:text-fg-subtle"
                  data-testid="mcp-registry-search"
                  placeholder={t("关键词，例如 postgres、github")}
                  value={registry.query}
                  onChange={(event) => {
                    const query = event.target.value;
                    registryRequest.current += 1;
                    setRegistry((current) => ({ ...current, query, entries: [], cursor: null, loading: false, loadingMore: false, error: null, searched: false }));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void searchRegistry(registry.query, null, false);
                  }}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  className="rounded-xl"
                  disabled={registry.loading}
                  onClick={() => void searchRegistry(registry.query, null, false)}
                >
                  {registry.loading && !registry.loadingMore ? <><Loader2 size={13} className="animate-spin motion-reduce:animate-none" /> {t("搜索中…")}</> : t("搜索")}
                </Button>
              </div>
              {registry.loading && !registry.loadingMore && (
                <div className="mt-3 rounded-2xl border border-line/60 bg-surface-2 px-4 py-4 shadow-[0_2px_12px_rgb(0_0_0/0.04)]" role="status" aria-live="polite" data-testid="mcp-registry-loading">
                  <div className="mb-3 flex items-center gap-2 text-11 text-fg-muted"><Loader2 size={13} className="animate-spin motion-reduce:animate-none" />{t("正在搜索 MCP 服务…")}</div>
                  {[0, 1, 2].map((row) => <div key={row} className="flex items-center gap-3 py-2 motion-safe:animate-pulse"><span className="size-9 rounded-lg bg-surface-active/60" /><span className="flex flex-1 flex-col gap-2"><span className="h-2.5 w-1/3 rounded bg-surface-active/60" /><span className="h-2 w-2/3 rounded bg-surface-active/40" /></span></div>)}
                </div>
              )}
              {!registry.loading && !registry.error && registry.searched && visibleRegistryEntries.length === 0 && <p className="mt-3 rounded-2xl border border-line/60 bg-surface-2 px-5 py-6 text-12 text-fg-muted shadow-[0_2px_12px_rgb(0_0_0/0.04)]">{t("没有找到匹配的 MCP 服务，请尝试其他关键词。")}</p>}
              {registry.error && (
                <div className="mt-2 flex items-center gap-2 text-10 text-danger">
                  <span className="min-w-0 flex-1 break-words">
                    {backendChangeText(registry.error, t)}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 underline underline-offset-2"
                    onClick={() => void searchRegistry(registry.query, null, false)}
                  >
                    {t("重试")}
                  </button>
                </div>
              )}
              {(visibleRegistryEntries.length > 0 || registry.cursor) && (
                <div className="mt-3 flex flex-col gap-3">
                  <div className="flex flex-col gap-3">
                    {visibleRegistryEntries.map(renderMarketEntry)}
                  </div>
                  {registry.cursor && (
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={registry.loading}
                      onClick={() =>
                        void searchRegistry(registry.resultQuery, registry.cursor, true)
                      }
                    >
                      {registry.loadingMore ? <><Loader2 size={13} className="animate-spin motion-reduce:animate-none" /> {t("加载中…")}</> : t("加载更多")}
                    </Button>
                  )}
                </div>
              )}
            </section>

            <section className="mt-2">
              <div className="mb-1.5 flex items-center gap-1.5">
                <h2 className="text-12 font-medium text-fg">{t("内置运维技能")}</h2>
                <span className="text-10 text-fg-subtle">{t("由 BLS-OPS 现有能力提供")}</span>
              </div>
              <p className="mb-1 text-10 text-fg-subtle">
                {t("当前服务器：{{name}}。勾选后会出现在输入框下栏的 MCP 菜单里。", {
                  name: serverName || t("未连接"),
                })}
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {BUILTIN_MCP_SKILLS.map((skill) => {
                  const id = `builtin:${skill.id}`;
                  const on = chosen({ bySession }, sessionKey, id, connected);
                  return (
                    <label
                      key={skill.id}
                      className="flex cursor-pointer items-start gap-3 rounded-2xl border border-line/60 bg-surface-2 px-4 py-3 shadow-[0_2px_12px_rgb(0_0_0/0.04)] transition-colors hover:border-line-strong hover:bg-surface-hover/40"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={on}
                        onChange={(event) => setChoice(sessionKey, id, event.target.checked)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-11 text-fg">{t(skill.name)}</span>
                        <span className="block text-10 text-fg-subtle">{t(skill.summary)}</span>
                        <span
                          className={cn(
                            "block text-9",
                            connected ? "text-fg-subtle" : "text-warning",
                          )}
                        >
                          {connected
                            ? t("可用 · 经由 {{server}}", {
                              server: serverName || t("当前连接"),
                            })
                            : t("需要先连接服务器")}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </section>
          </>
        ) : (
          <section>
            <div className="mb-1.5 flex items-center gap-1.5">
              <h2 className="text-12 font-medium text-fg">{t("我的连接")}</h2>
              <span className="text-10 text-fg-subtle">{t("{{n}} 个实例", { n: servers?.length ?? 0 })}</span>
            </div>
            {servers === null ? (
              <p className="text-11 text-fg-subtle">{t("正在加载…")}</p>
            ) : servers.length === 0 ? (
              <div className="rounded-lg border border-dashed border-line/60 px-4 py-8 text-center">
                <Plug size={18} className="mx-auto text-fg-subtle" />
                <p className="mt-2 text-12 text-fg">{t("还没有 MCP 连接")}</p>
                <p className="mt-1 text-10 text-fg-subtle">
                  {t("从市场添加，或自定义远程 / 本地服务。")}
                </p>
                <Button variant="ghost" size="xs" className="mt-2" onClick={openCustom}>
                  <Plus size={13} /> {t("自定义添加")}
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {servers.map((server) => (
                  <section
                    key={server.id}
                    data-testid={`mcp-server-${server.id}`}
                    className="overflow-hidden rounded-2xl border border-line/60 bg-surface-2 text-fg shadow-[0_2px_12px_rgb(0_0_0/0.04)]"
                  >
                    <header className="flex items-start gap-3 px-5 py-4">
                      <span className="mt-1">
                        <ConnectionDot state={connectionState(server)} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-12 font-medium text-fg">{server.name}</span>
                          <span className="rounded border border-line/60 px-1 text-9 uppercase text-fg-subtle">
                            {server.transport}
                          </span>
                          <span
                            className={cn(
                              "text-10",
                              connectionState(server) === "connected"
                                ? "text-accent"
                                : connectionState(server) === "error"
                                  ? "text-danger"
                                  : connectionState(server) === "empty" ||
                                    connectionState(server) === "auth" ||
                                    connectionState(server) === "tools_error"
                                    ? "text-warning"
                                    : "text-fg-subtle",
                            )}
                          >
                            {connectionLabel(connectionState(server), t, server.error)}
                          </span>
                          {server.defaultEnabled && (
                            <span className="text-9 text-fg-subtle">{t("默认勾选")}</span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate text-10 text-fg-subtle">
                          {server.transport === "stdio"
                            ? [server.command, ...server.args].filter(Boolean).join(" ")
                            : server.url}
                        </p>
                        <p className="mt-0.5 truncate text-9 text-fg-subtle">
                          {t("绑定：全局")}
                          {" · "}
                          {server.id}
                        </p>
                        {server.error && (
                          <div className="mt-1 flex flex-wrap items-baseline gap-2">
                            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-10 text-danger">
                              {backendChangeText(server.error, t)}
                            </p>
                            {missingRuntime(server) && (
                              <button
                                type="button"
                                className="shrink-0 text-10 text-accent hover:underline"
                                onClick={() => openRepair(server)}
                              >
                                {t("安装运行环境")}
                              </button>
                            )}
                          </div>
                        )}
                        {(server.warnings ?? []).map((warning) => (
                          <p key={warning} className="mt-1 break-words text-10 text-warning">
                            {backendChangeText(warning, t)}
                          </p>
                        ))}
                        {server.protocolVersion && (
                          <p className="mt-1 text-9 text-fg-subtle">
                            {t("协议版本：{{version}}", { version: server.protocolVersion })}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={server.enabled}
                          aria-label={server.enabled ? t("停用服务") : t("启用服务")}
                          onClick={() => void toggleServer(server, !server.enabled)}
                          className={cn(
                            "relative h-4 w-7 rounded-full transition-colors",
                            server.enabled ? "bg-accent/75" : "bg-surface-active",
                          )}
                        >
                          <span
                            className={cn(
                              "absolute top-0.5 size-3 rounded-full bg-surface-1 transition-[left]",
                              server.enabled ? "left-3.5" : "left-0.5",
                            )}
                          />
                        </button>
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={busyId === server.id}
                          data-testid={`mcp-test-${server.id}`}
                          onClick={() => void testServer(server)}
                        >
                          <RefreshCw size={12} />
                          {busyId === server.id ? t("测试中…") : t("测试 / 刷新")}
                        </Button>
                        <button
                          type="button"
                          aria-label={t("编辑")}
                          onClick={() => {
                            setDraft(draftFromServer(server));
                          }}
                          className="rounded px-1.5 py-1 text-10 text-fg-subtle hover:bg-surface-hover hover:text-fg"
                        >
                          {t("编辑")}
                        </button>
                        <button
                          type="button"
                          aria-label={t("删除")}
                          onClick={() => setDeleteTarget(server)}
                          className="rounded p-1 text-fg-subtle hover:bg-danger/10 hover:text-danger"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </header>

                    {busyId === server.id && (
                      <div className="border-t border-line/50 px-3 py-2">
                        <McpProgress
                          startedAt={busyStartedAt}
                          local={server.transport === "stdio"}
                        />
                      </div>
                    )}

                    {server.enabled &&
                      server.status === "connected" &&
                      server.tools.length === 0 &&
                      server.resources.length === 0 &&
                      server.prompts.length === 0 && (
                        <p className="border-t border-line/50 px-3 py-2 text-10 text-warning">
                          {t("已连接，但这个服务没有声明可用的工具、资源或提示模板。")}
                        </p>
                      )}

                    {/* 默认收起：连接多了以后一屏全是工具清单；展开状态由原生 details 记住。 */}
                    {server.tools.length > 0 && (
                      <details className="mcp-tools border-t border-line/50 px-3 py-2">
                        <summary className="flex cursor-pointer list-none items-center gap-1 text-11 text-fg-muted">
                          <ChevronDown size={12} />
                          {t("可用能力")}
                          <span className="text-10 text-fg-subtle">
                            {t("{{tools}} 个工具", { tools: server.tools.length })}
                            {server.resources.length > 0
                              ? ` · ${t("{{n}} 个资源", { n: server.resources.length })}`
                              : ""}
                            {server.prompts.length > 0
                              ? ` · ${t("{{n}} 个提示", { n: server.prompts.length })}`
                              : ""}
                          </span>
                        </summary>
                        <ul className="mt-1 flex flex-col gap-0.5">
                          {server.tools.map((tool) => (
                            <li
                              key={tool.name}
                              className="flex items-start gap-2 rounded px-1 py-1 hover:bg-surface-hover/60"
                            >
                              <input
                                type="checkbox"
                                className="mt-0.5"
                                data-testid={`mcp-tool-${server.id}-${tool.name}`}
                                checked={tool.enabled}
                                onChange={(event) =>
                                  void toggleTool(server, tool.name, event.target.checked)
                                }
                              />
                              <span className="min-w-0 flex-1">
                                <span className="flex flex-wrap items-center gap-1.5">
                                  <span className="font-mono text-11 text-fg">{tool.name}</span>
                                  {tool.readOnly && (
                                    <span className="rounded bg-accent/10 px-1 text-9 text-accent">
                                      {t("只读")}
                                    </span>
                                  )}
                                </span>
                                {tool.description && (
                                  <span className="mt-0.5 block text-10 leading-4 text-fg-subtle">
                                    {tool.description}
                                  </span>
                                )}
                              </span>
                            </li>
                          ))}
                        </ul>
                        {server.resources.length > 0 && (
                          <div className="mt-2">
                            <p className="text-10 uppercase tracking-wide text-fg-subtle">
                              {t("资源")}
                            </p>
                            <ul className="mt-0.5 space-y-0.5 text-10 text-fg-muted">
                              {server.resources.map((resource) => (
                                <li key={resource.uri} className="break-words">
                                  <span className="font-mono">{resource.uri}</span>
                                  {resource.name ? ` · ${resource.name}` : ""}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {server.prompts.length > 0 && (
                          <div className="mt-2">
                            <p className="text-10 uppercase tracking-wide text-fg-subtle">
                              {t("提示模板")}
                            </p>
                            <ul className="mt-0.5 space-y-0.5 text-10 text-fg-muted">
                              {server.prompts.map((prompt) => (
                                <li key={prompt.name}>
                                  <span className="font-mono">{prompt.name}</span>
                                  {prompt.description ? ` · ${prompt.description}` : ""}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </details>
                    )}
                  </section>
                ))}
              </div>
            )}
            <p className="mt-2 px-1 text-10 leading-4 text-fg-subtle">
              {t("配置与能力缓存存本地 SQLite；env / Header 的值存系统钥匙串，界面只显示是否已保存。")}
            </p>
          </section>
        )}
      </div>

      {detail && detailInput && (
        <Modal
          open
          width={560}
          title={detail.entry.name}
          onClose={() => setDetail(null)}
          footer={
            <>
              {detail.entry.auth === "oauth" && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void openExternal(detail.entry.docsUrl)}
                >
                  {t("打开授权页")}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setDetail(null)}>
                {t("取消")}
              </Button>
              <Button
                size="sm"
                disabled={saving || detail.entry.availability === "unsupported"}
                onClick={startCatalog}
              >
                {t("添加连接")}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-10 text-fg-subtle">{detail.entry.publisher}</span>
              <AvailabilityBadge entry={detail.entry} />
            </div>
            <p className="whitespace-pre-wrap text-11 leading-5 text-fg-muted">
              {t(detail.entry.detail)}
            </p>
            <div className="flex flex-wrap gap-3 text-10">
              {detail.entry.docsUrl && (
                <a
                  className="inline-flex items-center gap-1 text-accent hover:underline"
                  href={detail.entry.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("官方文档")} <Globe size={10} />
                </a>
              )}
              {detail.entry.upstreamUrl && (
                <span className="min-w-0 break-all text-fg-subtle">
                  {t("上游来源")}：{detail.entry.upstreamUrl}
                </span>
              )}
            </div>
            <p className="text-10 text-fg-subtle">
              {t("连接方式：{{transport}} · 授权：{{auth}}", {
                transport:
                  detail.entry.transport === "http" ? "Streamable HTTP" : t("本地进程（stdio）"),
                auth:
                  detail.entry.auth === "bearer"
                    ? t("Bearer Token")
                    : detail.entry.auth === "oauth"
                      ? t("OAuth")
                      : t("无"),
              })}
            </p>
            {detail.entry.availability !== "addable" && (
              <p
                className={cn(
                  "rounded border px-2 py-1.5 text-10",
                  detail.entry.availability === "unsupported"
                    ? "border-line/60 bg-surface-active/40 text-fg-subtle"
                    : "border-warning/40 bg-warning/10 text-warning",
                )}
              >
                {detail.entry.availabilityNote ? t(detail.entry.availabilityNote) : detail.entry.availability === "local-runtime" ? t("需要本机安装对应的运行环境。") : t("当前客户端不支持这个传输方式。")}
              </p>
            )}
            {(() => {
              const existing = catalogInstances(detail.entry, servers ?? []);
              if (existing.length === 0) return null;
              return (
                <div className="rounded-md border border-line/60 px-2 py-1.5">
                  <p className="text-10 text-fg-subtle">{t("已配置的实例")}</p>
                  <ul className="mt-1 space-y-1">
                    {existing.map((server) => (
                      <li key={server.id} className="flex items-center gap-2 text-11">
                        <ConnectionDot state={connectionState(server)} />
                        <span className="min-w-0 flex-1 truncate text-fg">{server.name}</span>
                        <span className="shrink-0 text-10 text-fg-subtle">
                          {connectionLabel(connectionState(server), t)}
                        </span>
                        <button
                          type="button"
                          className="shrink-0 text-10 text-accent hover:underline"
                          onClick={() => {
                            setDetail(null);
                            setDraft(draftFromServer(server));
                          }}
                        >
                          {t("配置")}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}
            {detail.entry.configFields.map((field) => (
              <Field
                key={field.key}
                label={t(field.label)}
                hint={field.required ? t("必填") : t("可选")}
              >
                <input
                  className={fieldClass}
                  type={field.secret ? "password" : "text"}
                  autoComplete={field.secret ? "off" : undefined}
                  placeholder={field.placeholder}
                  data-testid={`mcp-detail-${field.key}`}
                  value={detail.values[field.key] ?? ""}
                  onChange={(event) =>
                    setDetail({
                      ...detail,
                      values: { ...detail.values, [field.key]: event.target.value },
                    })
                  }
                />
              </Field>
            ))}
          </div>
        </Modal>
      )}

      {draft && (
        <ConnectionForm
          draft={draft}
          busy={saving}
          scope={scope}
          onChange={setDraft}
          onCancel={() => {
            setDraft(null);
          }}
          onSave={() => void saveDraft()}
        />
      )}

      {repairServer && (() => {
        const runtime = runtimeForCommand(repairServer.command, "");
        const command = /win/i.test(navigator.platform)
          ? runtime.commandWindows ?? runtime.command
          : runtime.command;
        const probe = repairReport?.command ?? null;
        const relatedId = runtimeIdForCommand(repairServer.command);
        const related = (repairReport?.runtimes ?? []).filter((item) => item.id === relatedId);
        return (
          <Modal
            open
            width={560}
            title={t("安装运行环境 · {{name}}", { name: repairServer.name })}
            onClose={() => {
              setRepairServer(null);
              setRepairReport(null);
              setRepairError(null);
            }}
            footer={
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setRepairServer(null);
                    setRepairReport(null);
                    setRepairError(null);
                  }}
                >
                  {t("取消")}
                </Button>
                {command && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void copyTextWithFeedback(command)}
                  >
                    {t("复制安装命令")}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={repairChecking}
                  data-testid="mcp-repair-recheck"
                  onClick={() => void runRepairCheck(repairServer.command)}
                >
                  {repairChecking ? t("检测中…") : t("重新检测")}
                </Button>
                <Button
                  size="sm"
                  disabled={repairChecking}
                  data-testid="mcp-repair-retry"
                  onClick={() => void retryWithRecheck()}
                >
                  {t("重新检测并重试")}
                </Button>
              </>
            }
          >
            <div className="space-y-3 text-11 leading-5 text-fg-muted">
              <p>
                {t("这个连接需要本机具备 {{runtime}}。", { runtime: runtime.name })}
              </p>
              <CommandProbeSummary probe={probe} checking={repairChecking} error={repairError} />
              {repairServer.error && (
                <p className="rounded-md border border-warning/35 bg-warning/10 px-2.5 py-2 break-words text-10 text-warning">
                  {backendChangeText(repairServer.error, t)}
                </p>
              )}
              {runtime.installUrl && (
                <div>
                  <p className="text-10 text-fg-subtle">{t("安装页面")}</p>
                  <button
                    type="button"
                    className="mt-1 flex items-center gap-1 break-all text-left text-11 text-accent hover:underline"
                    onClick={() => void openExternal(runtime.installUrl)}
                  >
                    <Globe size={11} /> {runtime.installUrl}
                  </button>
                </div>
              )}
              {command && (
                <div>
                  <p className="text-10 text-fg-subtle">{t("复制到终端执行")}</p>
                  <code className="mt-1 block break-all rounded-md border border-line/60 bg-surface-1 px-2 py-1.5 font-mono text-10 text-fg">
                    {command}
                  </code>
                </div>
              )}
              <p className="text-10 text-fg-subtle">
                {t("安装后点「重新检测」即可，不需要重启应用：每次检测和启动都会重新读取用户级与系统级 PATH。")}
              </p>
              {related.length > 0 && (
                <details>
                  <summary className="cursor-pointer select-none text-10 text-fg-subtle hover:text-fg">
                    {t("诊断详情")}
                  </summary>
                  <RuntimeDiagnostics details={related} />
                </details>
              )}
            </div>
          </Modal>
        );
      })()}

      {importOpen && (
        <Modal
          open
          width={560}
          title={t("导入 MCP JSON")}
          onClose={() => {
            setImportOpen(false);
            setImportPreview(null);
          }}
          footer={
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setImportOpen(false);
                  setImportPreview(null);
                }}
              >
                {t("取消")}
              </Button>
              {importPreview ? (
                <Button size="sm" disabled={saving} onClick={() => void confirmImport()}>
                  {t("确认添加 {{n}} 个", { n: importPreview.length })}
                </Button>
              ) : (
                <Button size="sm" onClick={parseImport}>
                  {t("解析预览")}
                </Button>
              )}
            </>
          }
        >
          {saving && <McpProgress startedAt={null} local={false} />}
          {importPreview ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-11 text-fg-muted">{t("将添加这些连接：")}</p>
              {importPreview.map((item) => (
                <div
                  key={item.label}
                  className="flex items-center gap-2 rounded border border-line/60 px-2 py-1.5 text-11"
                >
                  <span className="min-w-0 flex-1 truncate text-fg">{item.label}</span>
                  <span className="text-10 text-fg-subtle">
                    {item.input.transport === "http" ? item.input.url : item.input.command}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <Field
              label={t("粘贴 mcpServers / servers 配置")}
              hint={t("识别常见的 mcpServers、servers 对象；先预览再确认。")}
            >
              <textarea
                className={cn(fieldClass, "min-h-[160px] font-mono text-11")}
                data-testid="mcp-import-json"
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
              />
            </Field>
          )}
        </Modal>
      )}

      {deleteTarget && (
        <ConfirmDialog
          open
          title={t("删除 MCP 连接")}
          description={t("删除「{{name}}」？它的工具会从后续任务中移除。", {
            name: deleteTarget.name,
          })}
          confirmLabel={t("删除")}
          cancelLabel={t("取消")}
          risk="irreversible"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void remove()}
        />
      )}
    </ExtremePageShell>
  );
}
