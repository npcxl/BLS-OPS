/** MCP 服务管理的前端类型，与 `src-tauri/src/mcp.rs` 的 camelCase 序列化对应。 */

export type McpTransport = "stdio" | "http";

export interface McpKeyValue {
  name: string;
  /** 只在新增时填写；空 = 保留钥匙串里的原值。 */
  value?: string;
  /** 钥匙串里是否已保存（界面只显示这一位，不回显明文）。 */
  hasValue?: boolean;
}

/** 连接实例绑定的范围。 */
export interface McpScope {
  scope: "server" | "workspace" | "global";
  serverId?: string | null;
  workspaceId?: string | null;
}

export interface McpToolDef {
  name: string;
  title?: string | null;
  description?: string | null;
  /** 服务端给的 JSON Schema。 */
  inputSchema: unknown;
  /** `annotations.readOnlyHint`。 */
  readOnly: boolean;
  /** 用户在 MCP 页里的启用状态。 */
  enabled: boolean;
}

export interface McpResourceDef {
  uri: string;
  name?: string | null;
  description?: string | null;
  mimeType?: string | null;
}

export interface McpPromptDef {
  name: string;
  description?: string | null;
}

export interface McpServerView {
  id: string;
  name: string;
  /** 市场条目 id；自定义连接为空。 */
  catalogId?: string | null;
  binding: McpScope;
  /** 连接成功后默认勾选到对应会话。 */
  defaultEnabled: boolean;
  transport: McpTransport;
  command: string;
  args: string[];
  env: McpKeyValue[];
  url: string;
  headers: McpKeyValue[];
  enabled: boolean;
  tools: McpToolDef[];
  resources: McpResourceDef[];
  prompts: McpPromptDef[];
  status: "unknown" | "connected" | "error" | "tools_error" | string;
  error?: string | null;
  /** resources / prompts 等非阻断能力发现失败。 */
  warnings?: string[];
  /** 初始化协商出的协议版本（诊断用）。 */
  protocolVersion?: string | null;
  updatedAt: number;
}

export interface McpServerInput {
  id?: string | null;
  name: string;
  catalogId?: string | null;
  binding: McpScope;
  defaultEnabled: boolean;
  transport: McpTransport;
  command: string;
  args: string[];
  env: McpKeyValue[];
  url: string;
  headers: McpKeyValue[];
  enabled: boolean;
  tools: McpToolDef[];
  resources: McpResourceDef[];
  prompts: McpPromptDef[];
}

export interface McpRegistryRemote {
  type: string;
  url: string;
}

export interface McpRegistryPackage {
  registryType: string;
  identifier: string;
  version: string;
  transport: string;
}

export interface McpRegistryEntry {
  id: string;
  name: string;
  registryName?: string;
  publisher: string;
  description: string;
  version: string;
  repositoryUrl: string;
  websiteUrl: string;
  remotes: McpRegistryRemote[];
  packages: McpRegistryPackage[];
}

export interface McpRegistryResult {
  servers: McpRegistryEntry[];
  nextCursor?: string | null;
}

export interface McpTestResult {
  ok: boolean;
  latencyMs: number;
  status: string;
  error?: string | null;
  warnings?: string[];
  protocolVersion?: string | null;
  tools: McpToolDef[];
  resources: McpResourceDef[];
  prompts: McpPromptDef[];
}
