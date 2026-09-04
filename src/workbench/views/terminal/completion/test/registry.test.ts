import { describe, expect, it } from "vitest";

import type { NginxContainer, NginxEnvironment } from "@/api/types/environment";
import type { RemoteFileEntry } from "@/api/ops-api";
import { defaultProviders, providerFor, resolveCompletions } from "../registry";
import { parseLine } from "../path-input";
import { createRemoteDirectoryProvider } from "../providers/remote-directory";
import { createDockerResourceProvider, resourceKindAt } from "../providers/docker-resource";
import { createServiceProvider, isUnitPosition } from "../providers/service";
import { createProcessProvider } from "../providers/process";
import { createFileProvider } from "../providers/file";
import { createKnowledgeProvider, setKnowledgeSearcher } from "../providers/knowledge";
import type { CommandSearchHit } from "@/api/ops-api";
import { createEnvironmentProvider } from "../providers/environment";
import { invalidateDirectoryCache } from "../remote-listing";
import type { CompletionContext } from "../types";

/**
 * 路由测试：**同一行、不同光标位置必须落到不同的 Provider**。
 * 这是"补全按光标所在参数工作，而不是只分析整行结尾"的可执行证明。
 */

function ctx(line: string, cursor = line.length, overrides: Partial<CompletionContext> = {}): CompletionContext {
  return { line, cursor, sessionId: "s1", cwd: "/root", home: "/root", ...overrides };
}

function container(name: string, image = "nginx:alpine"): NginxContainer {
  return {
    name,
    shortId: "abc123",
    image,
    imageRepository: image.split(":")[0],
    imageTag: image.split(":")[1] ?? "",
    flavor: "nginx",
    state: "running",
    status: "Up 5 minutes",
    running: true,
    ports: [{ containerPort: 80, hostPort: 8080, protocol: "tcp" }],
    mounts: [],
    compose: null,
    hasBinary: true,
    reasons: [],
  };
}

/** 知识库命中的最小骨架：测试只关心 syntax / title。 */
const BASE_HIT: CommandSearchHit = {
  id: "test",
  syntax: "test",
  title: "测试",
  summary: "",
  category: "系统",
  tags: [],
  risk: "read_only",
  mutability: "read",
  panel_worthy: false,
  source_command: "test",
  source: "builtin",
  placeholders: [],
  hint: null,
  score: 0,
  deleted: false,
  executable: "test",
  subcommand: null,
  description: null,
  output_adapter: null,
  output_hint: null,
  display: "test",
  params: [],
  example: null,
  requires_root: false,
  supported_os: [],
} as unknown as CommandSearchHit;

function dockerEnv(kind: NginxEnvironment["kind"], containers: NginxContainer[]): NginxEnvironment {
  return {
    kind,
    containers,
    hostInstalled: kind === "host",
    dockerAvailable: kind !== "host",
    dockerReason: null,
    warnings: [],
  };
}

describe("provider routing", () => {
  const providers = defaultProviders();

  it("routes `cd <cursor>` to the remote directory provider", () => {
    expect(providerFor(parseLine("cd ", 3), providers)?.id).toBe("remote-directory");
  });

  it("routes `cat <cursor>` to the file provider", () => {
    expect(providerFor(parseLine("cat ", 4), providers)?.id).toBe("file");
  });

  it("routes `docker logs <cursor>` to the docker provider", () => {
    expect(providerFor(parseLine("docker logs ", 12), providers)?.id).toBe("docker");
  });

  it("routes `systemctl status <cursor>` to the service provider", () => {
    expect(providerFor(parseLine("systemctl status ", 17), providers)?.id).toBe("service");
  });

  it("routes `kill <cursor>` to the process provider", () => {
    expect(providerFor(parseLine("kill ", 5), providers)?.id).toBe("process");
  });

  it("routes a bare command word to the knowledge provider", () => {
    expect(providerFor(parseLine("sys", 3), providers)?.id).toBe("knowledge");
  });

  it("routes `nginx` to the environment provider when an environment is known", () => {
    expect(providerFor(parseLine("nginx", 5), providers)?.id).toBe("environment");
  });

  it("does not let docker own a bare `docker <cursor>` (that is a subcommand)", () => {
    // `docker <cursor>` 该给子命令补全，不是容器名。
    expect(providerFor(parseLine("docker ", 7), providers)?.id).toBe("knowledge");
  });

  it("decides by the cursor's argument position, not the end of the line", () => {
    // 同一行，光标在 `-f` 之前 → 补容器；在 `-f` 之后 → 该补下一个参数。
    const before = parseLine("docker logs -f web", 12);
    const after = parseLine("docker logs -f web", 18);
    expect(providerFor(before, providers)?.id).toBe("docker");
    expect(providerFor(after, providers)?.id).not.toBe("docker");
  });
});

describe("docker resource kinds", () => {
  it("maps subcommands to the right resource", () => {
    expect(resourceKindAt(parseLine("docker logs ", 12))).toEqual({
      kind: "container",
      subcommand: "logs",
    });
    expect(resourceKindAt(parseLine("docker rmi ", 11))?.kind).toBe("image");
    expect(resourceKindAt(parseLine("docker network rm ", 18))?.kind).toBe("network");
    expect(resourceKindAt(parseLine("docker volume inspect ", 22))?.kind).toBe("volume");
    expect(resourceKindAt(parseLine("docker ps ", 10))).toBeNull();
  });

  it("completes only container names for `docker logs`", async () => {
    const provider = createDockerResourceProvider();
    const result = await provider.complete(ctx("docker logs "), parseLine("docker logs ", 12));
    expect(result.items.length).toBe(0);
    // 没有 Docker 数据时给出原因，而不是静默空白。
    expect(result.notice).toBeTruthy();
  });
});

describe("service provider positions", () => {
  it("recognizes `systemctl status <cursor>`", () => {
    expect(isUnitPosition(parseLine("systemctl status ", 17))).toBe(true);
  });

  it("recognizes `journalctl -u <cursor>` only right after -u", () => {
    expect(isUnitPosition(parseLine("journalctl -u ", 14))).toBe(true);
    expect(isUnitPosition(parseLine("journalctl -f ", 14))).toBe(false);
  });

  it("does not treat options as unit names", () => {
    expect(isUnitPosition(parseLine("systemctl status --", 19))).toBe(false);
  });

  it("completes units for systemctl", async () => {
    const provider = createServiceProvider();
    const result = await provider.complete(ctx("systemctl status ng"), parseLine("systemctl status ng", 20));
    expect(result.items.length).toBe(0);
    expect(result.notice).toBeTruthy();
  });
});

describe("process provider", () => {
  it("only owns the first argument of kill / killall", () => {
    const provider = createProcessProvider();
    expect(provider.matches(parseLine("kill ", 5))).toBe(true);
    expect(provider.matches(parseLine("killall ", 9))).toBe(true);
    expect(provider.matches(parseLine("kill -9 ", 8))).toBe(false);
  });
});

describe("file provider routing", () => {
  it("owns file arguments for cat/tail/vim/rm but not for cd", () => {
    const provider = createFileProvider();
    expect(provider.matches(parseLine("cat ", 4))).toBe(true);
    expect(provider.matches(parseLine("tail ", 5))).toBe(true);
    expect(provider.matches(parseLine("vim ", 4))).toBe(true);
    expect(provider.matches(parseLine("rm ", 3))).toBe(true);
    expect(provider.matches(parseLine("cd ", 3))).toBe(false);
  });
});

describe("knowledge provider", () => {
  it("searches the knowledge base for the command word", async () => {
    setKnowledgeSearcher(async () => [
      {
        ...BASE_HIT,
        id: "system.resource.memory",
        syntax: "free -h",
        title: "查看内存",
      },
    ]);
    const provider = createKnowledgeProvider();
    const result = await provider.complete(ctx("fre"), parseLine("fre", 3));
    expect(result.items.map((item) => item.label)).toEqual(["free -h"]);
    expect(result.items[0].hit?.syntax).toBe("free -h");
    setKnowledgeSearcher(null);
  });

  it("does not hijack argument positions", () => {
    const provider = createKnowledgeProvider();
    expect(provider.matches(parseLine("free -h", 7))).toBe(false);
  });
});

describe("environment provider", () => {
  const provider = createEnvironmentProvider();

  it("asks the user to choose when several nginx containers exist", async () => {
    const env = dockerEnv("multiple", [container("a-nginx"), container("b-nginx")]);
    const result = await provider.complete(
      ctx("nginx", 5, { environment: env }),
      parseLine("nginx", 5),
    );
    expect(result.items.map((item) => item.label)).toEqual(["a-nginx", "b-nginx"]);
    expect(result.notice).toContain("请先选择");
    // 每条候选都要带上镜像/状态/端口/项目，用户才好选。
    expect(result.items[0].detail).toContain("Up 5 minutes");
  });

  it("uses the remembered container for later commands", async () => {
    const env = dockerEnv("multiple", [container("a-nginx"), container("b-nginx")]);
    provider.complete(ctx("nginx", 5, { environment: env }), parseLine("nginx", 5));
    // 模拟用户选了第二个容器。
    const { rememberNginxContainer, forgetNginxContainer } = await import(
      "../providers/environment"
    );
    rememberNginxContainer("s1", "b-nginx");
    const result = await provider.complete(
      ctx("nginx", 5, { environment: env }),
      parseLine("nginx", 5),
    );
    expect(result.items.every((item) => item.label.includes("b-nginx"))).toBe(true);
    forgetNginxContainer("s1");
  });

  it("shows docker exec commands for a single container", async () => {
    const env = dockerEnv("docker", [container("bls-nginx")]);
    const result = await provider.complete(
      ctx("nginx", 5, { environment: env }),
      parseLine("nginx", 5),
    );
    const commands = result.items.map((item) => item.label);
    expect(commands).toContain("docker exec bls-nginx nginx -v");
    expect(commands).toContain("docker exec bls-nginx nginx -t");
    expect(commands).toContain("docker logs --tail 200 bls-nginx");
  });

  it("keeps reload at a confirm-worthy risk level", async () => {
    const env = dockerEnv("docker", [container("bls-nginx")]);
    const result = await provider.complete(
      ctx("nginx", 5, { environment: env }),
      parseLine("nginx", 5),
    );
    const reload = result.items.find((item) => item.command?.id === "docker.reload");
    expect(reload?.command?.risk).toBe("medium");
    const version = result.items.find((item) => item.command?.id === "docker.version");
    expect(version?.command?.risk).toBe("read_only");
  });

  it("explains itself while the environment is still unknown", async () => {
    const result = await provider.complete(ctx("nginx", 5), parseLine("nginx", 5));
    expect(result.notice).toContain("正在探测");
  });

  it("reports the docker reason when nginx is absent", async () => {
    const env: NginxEnvironment = {
      kind: "none",
      containers: [],
      hostInstalled: false,
      dockerAvailable: false,
      dockerReason: "当前用户没有权限访问 Docker。",
      warnings: [],
    };
    const result = await provider.complete(
      ctx("nginx", 5, { environment: env }),
      parseLine("nginx", 5),
    );
    expect(result.notice).toContain("没有权限");
  });
});

describe("resolveCompletions", () => {
  it("returns nothing for an empty line", async () => {
    const result = await resolveCompletions(ctx(""));
    expect(result.items).toEqual([]);
  });

  it("uses injected providers and returns a tagged result", async () => {
    invalidateDirectoryCache();
    const provider = createRemoteDirectoryProvider({
      list: async ({ path }: { sessionId: string; path: string }): Promise<RemoteFileEntry[]> =>
        path === "/root" ? ([{ name: "opt", kind: "directory", hidden: false }] as RemoteFileEntry[]) : [],
    });
    const result = await resolveCompletions(ctx("cd o"), { providers: [provider] });
    expect(result.items.map((item) => item.label)).toEqual(["opt"]);
    expect(result.requestKey).toBe("cd:/root:o");
  });

  it("returns an empty result when no provider owns the position", async () => {
    const provider = createRemoteDirectoryProvider({ list: async () => [] });
    const result = await resolveCompletions(ctx("ls -l "), { providers: [provider] });
    expect(result.items).toEqual([]);
    expect(result.requestKey.startsWith("none:")).toBe(true);
  });
});
