import { describe, expect, it } from "vitest";
import { fileKind } from "@/lib/file-kind";
import { logSourceIconKey, serviceIconKey } from "../FileKindIcon";

/**
 * 超能里的图标映射：文件类型交给 `fileKind`（同一套 vscode-icons），
 * 服务 / 日志来源按名字认品牌，认不出就用中性图标，绝不猜错品牌。
 */
describe("超能图标：服务与日志来源", () => {
  it("按 systemd 单元名认品牌，认不出退回 systemd", () => {
    expect(serviceIconKey("nginx.service")).toBe("nginx");
    expect(serviceIconKey("docker.service")).toBe("docker");
    expect(serviceIconKey("containerd.service")).toBe("docker");
    expect(serviceIconKey("ssh.service")).toBe("ssh");
    expect(serviceIconKey("sshd.service")).toBe("ssh");
    expect(serviceIconKey("redis-server.service")).toBe("database");
    expect(serviceIconKey("postgresql.service")).toBe("database");
    expect(serviceIconKey("cron.service")).toBe("systemd");
  });

  it("日志来源 → 图标：容器用 Docker，单元看服务名，文件看扩展名", () => {
    expect(logSourceIconKey({ kind: "docker", container: "web", label: "web" })).toBe("docker");
    expect(logSourceIconKey({ kind: "journal", unit: "nginx", label: "nginx" })).toBe("nginx");
    expect(
      logSourceIconKey({ kind: "file", path: "/var/log/nginx/access.log", label: "access" }),
    ).toBe("log");
    expect(logSourceIconKey({ kind: "k8s", pod: "web-0", label: "web-0" })).toBe("docker");
  });

  it("附件按扩展名 / 特殊文件名给图标", () => {
    expect(fileKind({ name: "docker-compose.yml", kind: "file" }).iconKey).toBe("docker");
    expect(fileKind({ name: "nginx.conf", kind: "file" }).iconKey).toBe("nginx");
    expect(fileKind({ name: "report.pdf", kind: "file" }).iconKey).toBe("pdf");
    expect(fileKind({ name: "bundle.tar.gz", kind: "file" }).iconKey).toBe("archive");
    expect(fileKind({ name: ".ssh", kind: "directory" }).iconKey).toBe("folder");
    expect(fileKind({ name: "logs", kind: "directory" }).iconKey).toBe("folder-logs");
  });
});
