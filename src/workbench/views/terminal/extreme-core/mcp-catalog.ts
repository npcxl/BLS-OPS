/**
 * MCP 市场目录。
 *
 * 运维精选放在 `mcp-catalog.json`（可维护的本地清单）；官方 Registry 的结果
 * 归一化成同一形状，详情与添加表单共用。目录只提供**候选连接配置**，真实
 * 工具永远以连接测试发现的结果为准。
 */
import raw from "./mcp-catalog.json";
import type {
  McpRegistryEntry,
  McpScope,
  McpServerInput,
  McpServerView,
  McpToolDef,
} from "@/api/types/mcp";

export type McpMarketCategory = "all" | "monitor" | "container" | "cloud" | "cicd" | "database";

export const MCP_MARKET_CATEGORIES: { id: McpMarketCategory; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "monitor", label: "监控与日志" },
  { id: "container", label: "容器与集群" },
  { id: "cloud", label: "云服务与 DNS" },
  { id: "cicd", label: "CI/CD" },
  { id: "database", label: "数据库" },
];

export type McpCatalogField = {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  secret?: boolean;
  apply: "url" | "header" | "env";
  target?: string;
  prefix?: string;
};

/**
 * 市场条目的接入条件：能直接添加、需要 OAuth、需要本地运行环境、或客户端
 * 暂不支持该传输。这里描述的是"添加前"的条件，不是用户实例的连接状态。
 */
export type McpAvailability = "addable" | "oauth" | "local-runtime" | "unsupported";

export interface McpCatalogEntry {
  id: string;
  name: string;
  publisher: string;
  category: Exclude<McpMarketCategory, "all">;
  summary: string;
  detail: string;
  transport: "http" | "stdio";
  urlTemplate?: string;
  command?: string;
  args?: string[];
  auth: "none" | "bearer" | "oauth";
  docsUrl: string;
  upstreamUrl: string;
  availability: McpAvailability;
  availabilityNote?: string;
  defaultBinding?: "server" | "workspace" | "global";
  configFields: McpCatalogField[];
  /** 官方 Registry 来源时才有的元信息。 */
  source: "curated" | "registry";
  registryName?: string;
  version?: string;
}

type CatalogFile = { version: number; entries: Omit<McpCatalogEntry, "source">[] };

export const CURATED_MCP_CATALOG: McpCatalogEntry[] = (raw as CatalogFile).entries.map(
  (entry) => ({ ...entry, source: "curated" as const }),
);

export function filterCatalog(
  entries: McpCatalogEntry[],
  query: string,
  category: McpMarketCategory,
): McpCatalogEntry[] {
  const keyword = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (category !== "all" && entry.category !== category) return false;
    if (!keyword) return true;
    return [entry.name, entry.publisher, entry.summary, entry.detail, entry.registryName ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(keyword);
  });
}

/** 目录条目 + 用户填写值 → 连接表单初始值。 */
export function catalogToInput(
  entry: McpCatalogEntry,
  values: Record<string, string>,
  scope: { workspaceId: string | null; serverId: string | null; serverName: string },
): McpServerInput {
  const bindingScope = entry.defaultBinding ?? "workspace";
  const binding: McpScope = {
    scope: bindingScope,
    serverId: bindingScope === "server" ? scope.serverId : null,
    workspaceId: bindingScope === "workspace" ? scope.workspaceId : null,
  };
  const instance = values.instance?.trim() || values.endpoint?.trim() || "";
  const name =
    instance && instance !== entry.name
      ? `${entry.name} · ${instance.replace(/^https?:\/\//, "").slice(0, 40)}`
      : entry.name;

  let url = entry.urlTemplate ?? "";
  if (url) {
    url = url.replace(/\{(\w+)\}/g, (_, key: string) => values[key]?.trim() ?? "");
  }

  const headers = entry.configFields
    .filter((field) => field.apply === "header" && field.target && values[field.key]?.trim())
    .map((field) => ({
      name: field.target!,
      value: `${field.prefix ?? ""}${values[field.key].trim()}`,
    }));
  const env = entry.configFields
    .filter((field) => field.apply === "env" && field.target && values[field.key]?.trim())
    .map((field) => ({
      name: field.target!,
      value: values[field.key].trim(),
    }));

  return {
    id: null,
    name,
    catalogId: entry.id,
    binding,
    defaultEnabled: true,
    transport: entry.transport,
    command: entry.command ?? "",
    args: entry.args ?? [],
    env,
    url,
    headers,
    enabled: true,
    tools: [],
    resources: [],
    prompts: [],
  };
}

/** 官方 Registry 结果 → 同一种目录条目（只映射，不猜配置）。 */
export function registryToCatalog(entry: McpRegistryEntry): McpCatalogEntry {
  const remote =
    entry.remotes.find((item) => item.url && !item.url.endsWith("/sse") && item.type !== "sse") ??
    null;
  const pkg =
    entry.packages.find((item) => item.transport === "stdio") ?? entry.packages[0] ?? null;
  const unsupportedNote = remote
    ? undefined
    : entry.remotes.some((item) => item.type === "sse" || item.url.endsWith("/sse"))
      ? "该服务只提供旧版 SSE 传输，当前客户端暂不支持。"
      : pkg
        ? undefined
        : "目录没有提供可用的远程地址或 stdio 启动信息，暂不支持。";

  let command = "";
  let args: string[] = [];
  if (!remote && pkg) {
    const type = pkg.registryType.toLowerCase();
    if (type.includes("npm")) {
      command = "npx";
      args = ["-y", pkg.identifier];
    } else if (type.includes("pypi") || type.includes("uv")) {
      command = "uvx";
      args = [pkg.identifier];
    } else if (type.includes("oci") || type.includes("docker")) {
      command = "docker";
      args = ["run", "-i", "--rm", pkg.identifier];
    }
  }

  return {
    id: entry.id,
    name: entry.name || entry.registryName || "MCP 服务",
    publisher: entry.publisher || "官方 Registry",
    category: "cloud",
    summary: entry.description || "来自官方 MCP Registry",
    detail: [entry.description, entry.repositoryUrl ? `来源：${entry.repositoryUrl}` : ""]
      .filter(Boolean)
      .join("\n"),
    transport: remote ? "http" : "stdio",
    urlTemplate: remote?.url,
    command: command || undefined,
    args,
    auth: remote ? "bearer" : "none",
    docsUrl: entry.repositoryUrl || entry.websiteUrl,
    upstreamUrl: entry.repositoryUrl || entry.websiteUrl,
    availability: remote
      ? "addable"
      : command
        ? "local-runtime"
        : "unsupported",
    availabilityNote: unsupportedNote,
    defaultBinding: "workspace",
    configFields: remote
      ? [
          {
            key: "token",
            label: "访问令牌（如服务要求）",
            required: false,
            secret: true,
            apply: "header",
            target: "Authorization",
            prefix: "Bearer ",
          },
        ]
      : [],
    source: "registry",
    registryName: entry.registryName,
    version: entry.version,
  };
}

/** 连接上是否已有这个目录条目的实例（用于"已连接/配置"状态）。 */
export function catalogStatus(
  entry: McpCatalogEntry,
  connections: { catalogId?: string | null; status: string }[],
): "none" | "configured" | "connected" | "error" {
  const matches = connections.filter((item) => item.catalogId === entry.id);
  if (matches.length === 0) return "none";
  if (matches.some((item) => item.status === "connected")) return "connected";
  if (matches.some((item) => item.status === "error")) return "error";
  return "configured";
}

/** 兼容早期丢失目录 ID 的实例和手动导入的具体连接配置。 */
export function catalogInstances(entry: McpCatalogEntry, servers: readonly McpServerView[]) {
  return servers.filter((server) => {
    if (server.catalogId === entry.id) return true;
    if (server.transport !== entry.transport) return false;
    if (entry.transport === "http") {
      return Boolean(entry.urlTemplate && !/[{}]/.test(entry.urlTemplate) &&
        server.url.trim() === entry.urlTemplate.trim());
    }
    const args = entry.args ?? [];
    return Boolean(entry.command &&
      server.command === entry.command &&
      server.args.length === args.length &&
      args.every((arg, index) => arg === server.args[index]));
  });
}

export type CatalogTool = McpToolDef;
