import { beforeEach, describe, expect, it } from "vitest";

import type { NginxContainer, NginxEnvironment } from "@/api/types/environment";
import { configMounts, publishedPorts } from "@/api/types/environment";
import {
  clearNginxSelections,
  createEnvironmentProvider,
  forgetNginxContainer,
  nginxCommands,
  rememberNginxContainer,
} from "../environment";

/**
 * 环境驱动的建议：同一句 `nginx`，在不同服务器上必须给出**不同且都能跑**的
 * 命令。这里覆盖规格里的 Nginx 清单（宿主机 / Docker / Compose / OpenResty /
 * 私有仓库镜像 / 多容器 / 无权限），以及风险等级不得被"美化"。
 */

function container(name: string, image: string, overrides: Partial<NginxContainer> = {}): NginxContainer {
  const [repository, tag = ""] = image.split(":");
  return {
    name,
    shortId: "abc123def456",
    image,
    imageRepository: repository,
    imageTag: tag,
    flavor: "nginx",
    state: "running",
    status: "Up 5 minutes",
    running: true,
    ports: [],
    mounts: [],
    compose: null,
    hasBinary: true,
    reasons: [],
    ...overrides,
  };
}

function env(kind: NginxEnvironment["kind"], containers: NginxContainer[] = [], overrides: Partial<NginxEnvironment> = {}): NginxEnvironment {
  return {
    kind,
    containers,
    hostInstalled: kind === "host",
    dockerAvailable: kind !== "host",
    dockerReason: null,
    warnings: [],
    ...overrides,
  };
}

const provider = createEnvironmentProvider();

async function complete(line: string, environment: NginxEnvironment | null, sessionId = "s1") {
  return provider.complete(
    { line, cursor: line.length, sessionId, cwd: "/root", home: "/root", environment },
    { command: line.split(" ")[0], index: line.includes(" ") ? 1 : 0 } as never,
  );
}

beforeEach(() => {
  clearNginxSelections();
});

describe("nginx command generation", () => {
  it("uses host commands when nginx runs on the host", () => {
    const commands = nginxCommands(env("host"), null);
    const lines = commands.map((item) => item.command);
    expect(lines).toContain("nginx -v");
    expect(lines).toContain("nginx -t");
    expect(lines).toContain("systemctl status nginx");
    expect(lines.some((line) => line.includes("docker"))).toBe(false);
  });

  it("recommends docker exec commands for a containerised nginx", () => {
    const commands = nginxCommands(env("docker", [container("bls-nginx", "nginx:alpine")]), null);
    const lines = commands.map((item) => item.command);
    expect(lines).toContain("docker exec bls-nginx nginx -v");
    expect(lines).toContain("docker exec bls-nginx nginx -t");
    expect(lines).toContain("docker exec bls-nginx nginx -T");
    expect(lines).toContain("docker exec bls-nginx nginx -s reload");
    expect(lines).toContain("docker logs --tail 200 bls-nginx");
    expect(lines).toContain("docker logs -f bls-nginx");
    expect(lines).toContain("docker inspect bls-nginx");
    expect(lines).toContain("docker exec -it bls-nginx sh");
    expect(lines).toContain("docker port bls-nginx");
  });

  it("recommends docker compose commands when compose manages the service", () => {
    const commands = nginxCommands(
      env("compose", [
        container("bls-nginx-1", "nginx:alpine", {
          compose: { project: "bls", service: "nginx", workingDir: "/srv/bls" },
        }),
      ]),
      null,
    );
    const lines = commands.map((item) => item.command);
    // 带 -p 指定项目：不依赖当前工作目录，任何地方都能跑。
    expect(lines).toContain("docker compose -p bls ps nginx");
    expect(lines).toContain("docker compose -p bls logs --tail 200 nginx");
    expect(lines).toContain("docker compose -p bls exec nginx nginx -t");
    expect(lines).toContain("docker compose -p bls exec nginx nginx -s reload");
    expect(lines).toContain("docker compose -p bls restart nginx");
  });

  it("falls back to docker exec when the compose working dir is unknown", () => {
    const commands = nginxCommands(
      env("docker", [
        container("bls-nginx-1", "nginx:alpine", {
          compose: { project: "bls", service: "nginx", workingDir: "" },
        }),
      ]),
      null,
    );
    const lines = commands.map((item) => item.command);
    expect(lines.some((line) => line.startsWith("docker compose"))).toBe(false);
    expect(lines).toContain("docker exec bls-nginx-1 nginx -t");
  });

  it("handles images behind a private registry", () => {
    const commands = nginxCommands(
      env("docker", [container("gw", "registry.internal:5000/team/nginx:1.25")]),
      null,
    );
    expect(commands.map((item) => item.command)).toContain("docker exec gw nginx -t");
  });

  it("handles openresty the same way as nginx", () => {
    const commands = nginxCommands(
      env("docker", [container("api-gw", "openresty/openresty:alpine", { flavor: "openresty" })]),
      null,
    );
    // 容器里同样是 `nginx` 可执行文件（OpenResty 自带）。
    expect(commands.map((item) => item.command)).toContain("docker exec api-gw nginx -t");
  });

  it("quotes container names that contain spaces", () => {
    const commands = nginxCommands(env("docker", [container("my nginx", "nginx:alpine")]), null);
    expect(commands.map((item) => item.command)).toContain('docker exec "my nginx" nginx -v');
  });

  it("never generates destructive commands", () => {
    const commands = nginxCommands(env("docker", [container("bls-nginx", "nginx:alpine")]), null);
    for (const command of commands) {
      expect(command.command).not.toMatch(/\brm\b/);
      expect(command.command).not.toMatch(/\brmi\b/);
      expect(command.command).not.toMatch(/\bprune\b/);
    }
  });

  it("keeps risk levels real: reload / restart need confirmation, reads stay read-only", () => {
    const dockerCommands = nginxCommands(env("docker", [container("bls-nginx", "nginx:alpine")]), null);
    expect(dockerCommands.find((item) => item.id === "docker.reload")?.risk).toBe("medium");
    for (const id of ["docker.version", "docker.test", "docker.dump", "docker.logs", "docker.inspect"]) {
      expect(dockerCommands.find((item) => item.id === id)?.risk).toBe("read_only");
    }

    const composeCommands = nginxCommands(
      env("compose", [
        container("bls-nginx-1", "nginx:alpine", {
          compose: { project: "bls", service: "nginx", workingDir: "/srv/bls" },
        }),
      ]),
      null,
    );
    expect(composeCommands.find((item) => item.id === "compose.reload")?.risk).toBe("medium");
    expect(composeCommands.find((item) => item.id === "compose.restart")?.risk).toBe("medium");
    expect(composeCommands.find((item) => item.id === "compose.test")?.risk).toBe("read_only");
  });
});

describe("multiple nginx containers", () => {
  const two = env("multiple", [
    container("a-nginx", "nginx:alpine"),
    container("b-nginx", "nginx:1.25", {
      compose: { project: "web", service: "nginx", workingDir: "/srv/web" },
      ports: [{ containerPort: 80, hostPort: 8080, protocol: "tcp" }],
    }),
  ]);

  it("offers a chooser instead of picking the first container", async () => {
    const result = await complete("nginx", two);
    expect(result.items.map((item) => item.label)).toEqual(["a-nginx", "b-nginx"]);
    expect(result.notice).toContain("请先选择");
  });

  it("shows image, state, ports and the compose project in the chooser", async () => {
    const result = await complete("nginx", two);
    // 用户要靠这一行把两个容器区分开。
    expect(result.items[1].detail).toContain("nginx:1.25"); // 镜像
    expect(result.items[1].detail).toContain("Up 5 minutes"); // 状态
    expect(result.items[1].detail).toContain("8080"); // 端口
    expect(result.items[1].detail).toContain("web"); // Compose 项目
  });

  it("gives no command until a container is chosen", () => {
    expect(nginxCommands(two, null)).toHaveLength(0);
    expect(nginxCommands(two, "a-nginx").length).toBeGreaterThan(0);
    expect(nginxCommands(two, "a-nginx").every((item) => item.command.includes("a-nginx"))).toBe(true);
  });

  it("drops a remembered choice once that container is gone", async () => {
    rememberNginxContainer("s1", "a-nginx");
    const result = await complete("nginx", env("multiple", [container("b-nginx", "nginx:1.25")]));
    // 记住的容器不在了 → 选择失效，回到"请先选择容器"。
    expect(result.items.map((item) => item.label)).toEqual(["b-nginx"]);
    expect(result.notice).toContain("已停止或不存在");
  });

  it("drops a remembered choice once that container stops", async () => {
    rememberNginxContainer("s1", "a-nginx");
    const result = await complete(
      "nginx",
      env("multiple", [
        container("a-nginx", "nginx:alpine", { running: false, state: "exited" }),
        container("b-nginx", "nginx:1.25"),
      ]),
    );
    expect(result.notice).toContain("已停止或不存在");
    forgetNginxContainer("s1");
  });

  it("keeps choices per session", async () => {
    rememberNginxContainer("s1", "b-nginx");
    const first = await complete("nginx", two, "s1");
    const second = await complete("nginx", two, "s2");
    // s1 记住的是 b-nginx → 走它的 Compose 命令（用 service 名，不用容器名）。
    expect(first.items.some((item) => item.command?.command === "docker compose -p web ps nginx")).toBe(
      true,
    );
    // 另一个会话没有选择 → 仍然要它自己选。
    expect(second.notice).toContain("请先选择");
  });

  it("remembers the container the user picked", async () => {
    const result = await complete("nginx", two, "s3");
    const chosen = result.items[1];
    expect(chosen.container?.name).toBe("b-nginx");
    // 选中即记住（由 TerminalView 在写入时调用 rememberNginxContainer）。
    rememberNginxContainer("s3", chosen.container!.name);
    const after = await complete("nginx", two, "s3");
    const commands = after.items.map((item) => item.command?.command ?? "");
    expect(commands).toContain("docker compose -p web exec nginx nginx -t");
    expect(commands).toContain("docker logs --tail 200 b-nginx");
  });
});

describe("provider wiring", () => {
  it("explains a missing docker permission instead of showing nothing", async () => {
    const result = await complete(
      "nginx",
      env("none", [], {
        dockerAvailable: false,
        dockerReason: "当前用户没有权限访问 Docker。",
      }),
    );
    expect(result.items).toHaveLength(0);
    expect(result.notice).toContain("没有权限");
  });

  it("says it is still probing when the environment is unknown", async () => {
    const result = await complete("nginx", null);
    expect(result.notice).toContain("正在探测");
  });

  it("filters commands by what has been typed", async () => {
    const result = await complete(
      "nginx -t",
      env("docker", [container("bls-nginx", "nginx:alpine")]),
    );
    // 输入已经指向 `-t`，不该再把整份命令列表糊上来。
    expect(result.items.length).toBeLessThan(10);
    expect(result.items.every((item) => item.label.toLowerCase().includes("-t"))).toBe(true);
  });

  it("only owns the nginx command word and its first argument", () => {
    expect(provider.matches({ command: "nginx", index: 0 } as never)).toBe(true);
    expect(provider.matches({ command: "nginx", index: 1 } as never)).toBe(true);
    expect(provider.matches({ command: "nginx", index: 2 } as never)).toBe(false);
    expect(provider.matches({ command: "docker", index: 0 } as never)).toBe(false);
  });
});

describe("environment summary shown in the hint area", () => {
  it("names the container, image, ports, config mount and state", async () => {
    const nginx = container("bls-nginx", "nginx:alpine", {
      ports: [
        { containerPort: 80, hostPort: 80, protocol: "tcp" },
        { containerPort: 443, hostPort: 443, protocol: "tcp" },
      ],
      mounts: [
        { source: "/srv/bls/nginx.conf", destination: "/etc/nginx/nginx.conf", readOnly: true },
      ],
    });
    const result = await complete("nginx", env("docker", [nginx]));
    const summary = result.notice ?? "";
    expect(summary).toContain("容器 bls-nginx");
    expect(summary).toContain("镜像 nginx:alpine");
    expect(summary).toContain("端口 80、443");
    expect(summary).toContain("配置 /srv/bls/nginx.conf → /etc/nginx/nginx.conf");
    expect(summary).toContain("运行中");
  });
});

describe("container facts shown to the user", () => {
  it("lists published ports, not container-internal ones", () => {
    const nginx = container("bls-nginx", "nginx:alpine", {
      ports: [
        { containerPort: 80, hostPort: 8080, protocol: "tcp" },
        { containerPort: 443, hostPort: 8443, protocol: "tcp" },
        { containerPort: 9000, hostPort: null, protocol: "tcp" },
      ],
    });
    expect(publishedPorts(nginx)).toEqual([8080, 8443]);
  });

  it("picks out the config mounts", () => {
    const nginx = container("bls-nginx", "nginx:alpine", {
      mounts: [
        { source: "/srv/nginx.conf", destination: "/etc/nginx/nginx.conf", readOnly: true },
        { source: "/srv/html", destination: "/usr/share/nginx/html", readOnly: true },
      ],
    });
    const mounts = configMounts(nginx);
    expect(mounts).toHaveLength(1);
    expect(mounts[0].source).toBe("/srv/nginx.conf");
    expect(mounts[0].destination).toBe("/etc/nginx/nginx.conf");
  });
});
