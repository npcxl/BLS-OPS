import { describe, expect, it } from "vitest";
import {
  CURATED_MCP_CATALOG,
  catalogToInput,
  filterCatalog,
  registryToCatalog,
} from "../mcp-catalog";
import { parseMcpProbe } from "../mcp-capabilities";

describe("MCP 市场目录", () => {
  it("按关键词与分类筛选", () => {
    expect(filterCatalog(CURATED_MCP_CATALOG, "grafana", "all").map((e) => e.id)).toEqual([
      "grafana",
      "grafana-self-hosted",
    ]);
    expect(filterCatalog(CURATED_MCP_CATALOG, "", "container").map((e) => e.id)).toEqual([
      "kubernetes",
      "aws-eks",
    ]);
    expect(filterCatalog(CURATED_MCP_CATALOG, "不存在", "all")).toEqual([]);
  });

  it("Grafana 预填实例地址与 Bearer 授权头", () => {
    const entry = CURATED_MCP_CATALOG.find((item) => item.id === "grafana")!;
    const input = catalogToInput(
      entry,
      { stack: "ops", token: "glsa_123" },
      { workspaceId: "w1", serverId: "s1", serverName: "prod" },
    );
    expect(input.url).toBe("https://ops.grafana.net/api/mcp");
    expect(input.headers).toEqual([{ name: "Authorization", value: "Bearer glsa_123" }]);
    expect(input.binding).toMatchObject({ scope: "workspace", workspaceId: "w1" });
    expect(input.defaultEnabled).toBe(true);
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
