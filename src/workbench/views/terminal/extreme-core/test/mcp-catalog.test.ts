import { describe, expect, it } from "vitest";
import {
  catalogToInput,
  registryToCatalog,
} from "../mcp-catalog";
import { parseMcpProbe } from "../mcp-capabilities";

describe("MCP 市场目录", () => {
  it("Registry 连接预填地址与 Bearer 授权头", () => {
    const entry = registryToCatalog({ id: "registry:demo", name: "Demo", publisher: "demo", description: "", version: "", repositoryUrl: "", websiteUrl: "", remotes: [{ type: "streamable-http", url: "https://example.com/mcp" }], packages: [] });
    const input = catalogToInput(
      entry,
      { token: "test-token" },
      { workspaceId: "w1", serverId: "s1", serverName: "prod" },
    );
    expect(input.url).toBe("https://example.com/mcp");
    expect(input.headers).toEqual([{ name: "Authorization", value: "Bearer test-token" }]);
    expect(input.binding).toMatchObject({ scope: "global" });
    expect(input.defaultEnabled).toBe(true);

    // 所有服务器 / 任务都同一份全局配置。
    const noServer = catalogToInput(
      entry,
      { token: "test-token" },
      { workspaceId: null, serverId: null, serverName: "" },
    );
    expect(noServer.binding).toMatchObject({ scope: "global" });
  });

  it("Registry 结果只映射为候选配置，SSE 标为不支持", () => {
    const http = registryToCatalog({
      id: "registry:pkg",
      name: "pkg",
      publisher: "acme",
      description: "demo",
      version: "1.0.0",
      repositoryUrl: "https://github.com/acme/pkg",
      websiteUrl: "",
      remotes: [{ type: "streamable-http", url: "https://mcp.example/mcp" }],
      packages: [],
    });
    expect(http.transport).toBe("http");
    expect(http.urlTemplate).toBe("https://mcp.example/mcp");
    expect(http.availability).toBe("addable");

    const sse = registryToCatalog({
      id: "registry:sse",
      name: "sse",
      publisher: "acme",
      description: "",
      version: "",
      repositoryUrl: "",
      websiteUrl: "",
      remotes: [{ type: "sse", url: "https://mcp.example/sse" }],
      packages: [],
    });
    expect(sse.availability).toBe("unsupported");
    expect(sse.availabilityNote).toContain("SSE");
  });

  it("只映射可接入的传输，并保留发行包版本", () => {
    const base = { id: "registry:pkg", name: "pkg", publisher: "acme", description: "", version: "", repositoryUrl: "", websiteUrl: "", remotes: [] };
    const supported = registryToCatalog({ ...base, packages: [{ registryType: "npm", identifier: "@acme/server", version: "1.2.3", transport: "stdio" }] });
    expect(supported.availability).toBe("local-runtime");
    expect(supported.args).toEqual(["-y", "@acme/server@1.2.3"]);
    expect(registryToCatalog({ ...base, packages: [{ registryType: "npm", identifier: "server", version: "", transport: "stdio", requiresConfiguration: true }] }).availability).toBe("unsupported");
    expect(registryToCatalog({ ...base, packages: [], remotes: [{ type: "streamable-http", url: "https://example.com/{id}" }] }).availability).toBe("unsupported");
  });

  it("环境探测按标记解析，缺段按不可用处理", () => {
    const probe = parseMcpProbe(
      "@@@docker\nyes\n@@@nginx\nno\n@@@systemd\nyes\n@@@database\nno\n@@@dns\nyes",
      "ssh-1",
    );
    expect(probe.docker).toBe(true);
    expect(probe.nginx).toBe(false);
    expect(probe.systemd).toBe(true);
    expect(probe.files).toBe(true);
  });
});
