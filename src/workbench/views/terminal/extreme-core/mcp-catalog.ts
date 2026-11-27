/**
 * MCP 市场目录。
 *
 * 官方 Registry 的结果归一化成同一形状，详情与添加表单共用。目录只提供**候选连接配置**，真实
 * 工具永远以连接测试发现的结果为准。
 */
import type {
  McpRegistryEntry,
  McpScope,
  McpServerInput,
  McpServerView,
  McpToolDef,
} from "@/api/types/mcp";

export type McpMarketCategory = "all" | "monitor" | "container" | "cloud" | "cicd" | "database";

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
  iconUrl?: string;
  version?: string;
}

/** 目录条目 + 用户填写值 → 连接表单初始值。 */
export function catalogToInput(
  entry: McpCatalogEntry,
  values: Record<string, string>,
  _scope: { workspaceId: string | null; serverId: string | null; serverName: string },
): McpServerInput {
  /*
   * MCP 只有全局作用域：添加后对所有服务器的后续任务都可用，
   * 实际能否调用由任务权限、连接状态和工具级权限决定。
   */
  const binding: McpScope = {
    scope: "global",
    serverId: null,
    workspaceId: null,
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
  const remote = entry.remotes.find((item) => {
    if (item.type !== "streamable-http" || item.requiresConfiguration || /[{}]/.test(item.url)) return false;
    try { return new URL(item.url).protocol === "https:"; } catch { return false; }
  }) ?? null;
  const pkg = entry.packages.find((item) =>
    item.transport === "stdio" && !item.requiresConfiguration && Boolean(item.identifier.trim()) &&
    ["npm", "pypi", "oci"].includes(item.registryType.toLowerCase()),
  ) ?? null;
  const unsupportedNote = !remote && !pkg
    ? entry.remotes.some((item) => item.type === "sse")
      ? "该服务只提供旧版 SSE 传输，当前客户端暂不支持。"
      : "目录没有提供客户端可直接配置的连接方式。"
    : undefined;

  let command = "";
  let args: string[] = [];
  if (!remote && pkg) {
    const version = pkg.version.trim();
    switch (pkg.registryType.toLowerCase()) {
      case "npm":
        command = "npx";
        args = ["-y", `${pkg.identifier}${version ? `@${version}` : ""}`];
        break;
      case "pypi":
        command = "uvx";
        args = [`${pkg.identifier}${version ? `==${version}` : ""}`];
        break;
      case "oci":
        command = "docker";
        args = ["run", "-i", "--rm", `${pkg.identifier}${version ? `:${version}` : ""}`];
        break;
    }
  }

  return {
    id: entry.id,
    iconUrl: entry.iconUrl,
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
