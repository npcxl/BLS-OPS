import { describe, expect, it } from "vitest";
import type { DeploymentInstance } from "@/api/ops-api";
import { buildInstanceMenuItems } from "../project-candidate-menu";

/** 只传关心的事实，其余给"什么都没发现"的默认值。 */
function instance(overrides: Partial<DeploymentInstance>): DeploymentInstance {
  return {
    id: "docker:abc",
    kind: "docker",
    name: "web",
    status: "running",
    runtime: "container",
    system_owned: false,
    ports: [],
    working_directories: [],
    config_files: [],
    source_paths: [],
    source_known: true,
    detail: "",
    workload_role: "application",
    component_role: "unknown",
    ownership: "unknown",
    linked_project_ids: [],
    classification_evidence: [],
    classification_confidence: "high",
    ...overrides,
  };
}

const items = (target: DeploymentInstance) =>
  buildInstanceMenuItems({
    instance: target,
    busy: false,
    t: (key: string) => key,
    onCopyPath: () => undefined,
    onOpenTerminal: () => undefined,
    onReloadNginx: () => undefined,
    onContainerAction: () => undefined,
    onStopContainer: () => undefined,
    onInspectContainer: () => undefined,
    onOpenPath: () => undefined,
  });

const ids = (target: DeploymentInstance) => items(target).map((item) => item.id);

describe("实例卡片的右键菜单", () => {
  it("docker 实例给容器三件套", () => {
    const target = instance({ kind: "docker", working_directories: ["/opt/shop"] });
    const menu = ids(target);

    expect(menu).toContain("docker-restart");
    expect(menu).toContain("docker-stop");
    expect(menu).toContain("docker-config");
    expect(menu).toContain("open-terminal");
  });

  it("systemd 实例不冒充容器：没有容器动作", () => {
    const target = instance({ kind: "systemd", name: "shop.service", runtime: "host" });
    const menu = ids(target);

    expect(menu.some((id) => id?.startsWith("docker"))).toBe(false);
    expect(menu).toContain("open-terminal");
  });

  it("没有任何路径时不给复制，终端跟踪置灰", () => {
    const target = instance({ kind: "systemd", runtime: "host" });
    const menu = items(target);

    expect(menu.some((item) => item.id === "copy-path")).toBe(false);
    const track = menu.find((item) => item.id === "open-terminal");
    expect(track?.disabled).toBe(true);
  });

  it("nginx 实例给重载与配置入口", () => {
    const target = instance({
      kind: "nginx",
      name: "Nginx",
      runtime: "host",
      config_files: ["/etc/nginx/nginx.conf", "/etc/nginx/sites-enabled/shop.conf"],
    });
    const menu = ids(target);

    expect(menu).toContain("nginx-reload");
    expect(menu).toContain("nginx-config");
    // 容器里的 nginx 由 docker 收集器识别，宿主机实例不该出现容器动作。
    expect(menu.some((id) => id?.startsWith("docker"))).toBe(false);
  });

  it("多条路径收进子菜单，避免菜单被路径撑爆", () => {
    const target = instance({
      kind: "systemd",
      runtime: "host",
      working_directories: ["/opt/a"],
      source_paths: ["/opt/b"],
    });
    const copy = items(target).find((item) => item.id === "copy-path");

    expect(copy?.children?.map((child) => child.label)).toEqual(["/opt/a", "/opt/b"]);
  });
});
