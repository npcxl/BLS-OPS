import { describe, expect, it } from "vitest";
import {
  buildRollback,
  buildUpdatePlan,
  matchServices,
  parseDockerPs,
  parseInspectMounts,
  pickDeployDirs,
} from "../extreme-core/update-plan";

describe("parseDockerPs", () => {
  it("解析容器名、镜像与端口", () => {
    const services = parseDockerPs(
      ["ops\tnginx:1.27\t0.0.0.0:80->80/tcp", "redis\tredis:7\t"].join("\n"),
    );
    expect(services).toHaveLength(2);
    expect(services[0]).toMatchObject({ name: "ops", image: "nginx:1.27", ports: "0.0.0.0:80->80/tcp" });
    expect(services[1].ports).toBe("");
  });

  it("忽略空行与缺列的行", () => {
    expect(parseDockerPs("\n\nbroken\n")).toEqual([]);
  });
});

describe("parseInspectMounts", () => {
  it("只保留 bind / volume，跳过 tmpfs 与缺字段的项", () => {
    const mounts = parseInspectMounts(
      JSON.stringify([
        { Type: "bind", Source: "/srv/ops", Destination: "/usr/share/nginx/html" },
        { Type: "volume", Source: "ops-data", Destination: "/data" },
        { Type: "tmpfs", Destination: "/tmp" },
        { Type: "bind", Destination: "/no-source" },
      ]),
    );
    expect(mounts).toEqual([
      { source: "/srv/ops", destination: "/usr/share/nginx/html" },
      { source: "ops-data", destination: "/data" },
    ]);
  });

  it("非法 JSON 返回空数组，不抛错", () => {
    expect(parseInspectMounts("not json")).toEqual([]);
  });
});

describe("matchServices", () => {
  const services = [
    { name: "ops", image: "nginx:1.27", ports: "0.0.0.0:80->80/tcp", mounts: [] },
    { name: "ops-worker", image: "node:20", ports: "", mounts: [] },
    { name: "redis", image: "redis:7", ports: "6379/tcp", mounts: [] },
  ];

  it("按容器名 / 镜像 / 端口匹配", () => {
    expect(matchServices(services, "ops").map((service) => service.name)).toEqual(["ops", "ops-worker"]);
    expect(matchServices(services, "nginx").map((service) => service.name)).toEqual(["ops"]);
  });

  it("关键词为空时返回全部（交给用户挑）", () => {
    expect(matchServices(services, "  ")).toHaveLength(3);
  });
});

describe("pickDeployDirs", () => {
  it("优先返回 web 根这类目录", () => {
    const dirs = pickDeployDirs({
      name: "ops",
      image: "nginx",
      ports: "",
      mounts: [
        { source: "/srv/app/data", destination: "/data" },
        { source: "/srv/app/html", destination: "/usr/share/nginx/html" },
      ],
    });
    expect(dirs).toEqual(["/srv/app/html"]);
  });

  it("没有明显 web 根时退回全部挂载", () => {
    const dirs = pickDeployDirs({
      name: "ops",
      image: "custom",
      ports: "",
      mounts: [{ source: "/srv/app/data", destination: "/data" }],
    });
    expect(dirs).toEqual(["/srv/app/data"]);
  });
});

describe("buildUpdatePlan", () => {
  const service = {
    name: "ops",
    image: "nginx:1.27",
    ports: "0.0.0.0:80->80/tcp",
    mounts: [{ source: "/srv/ops", destination: "/usr/share/nginx/html" }],
    healthcheck: "curl -f http://localhost/",
  };

  it("顺序固定为：校验 → 备份 → 解压 → 替换 → 重启 → 验证 → 清理", () => {
    const plan = buildUpdatePlan({
      service,
      zipPath: "/tmp/upload/dist.zip",
      deployDir: "/srv/ops",
      now: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    expect(plan.map((step) => step.id)).toEqual([
      "check-zip",
      "backup",
      "extract",
      "replace",
      "restart",
      "verify",
      "cleanup",
    ]);
  });

  it("备份发生在替换之前，且路径带时间戳", () => {
    const plan = buildUpdatePlan({
      service,
      zipPath: "/tmp/dist.zip",
      deployDir: "/srv/ops",
      now: Date.UTC(2026, 0, 2, 3, 4, 5),
    });
    const backup = plan.find((step) => step.id === "backup")!;
    expect(backup.command).toContain("cp -a '/srv/ops' '/srv/ops.bak-20260102030405'");
    expect(plan.indexOf(backup)).toBeLessThan(plan.findIndex((step) => step.id === "replace"));
  });

  it("替换不删除多余文件（避免抹掉运行时数据）", () => {
    const plan = buildUpdatePlan({ service, zipPath: "/tmp/dist.zip", deployDir: "/srv/ops" });
    const replace = plan.find((step) => step.id === "replace")!;
    expect(replace.command).toContain("cp -a");
    expect(replace.command).not.toContain("--delete");
    expect(replace.command).not.toContain("rm -rf '/srv/ops'");
  });

  it("路径里有单引号也不会破坏引号配对", () => {
    const plan = buildUpdatePlan({
      service,
      zipPath: "/tmp/a'b.zip",
      deployDir: "/srv/o'ps",
    });
    const check = plan.find((step) => step.id === "check-zip")!;
    expect(check.command).toContain(`'/tmp/a'\\''b.zip'`);
  });
});

describe("buildRollback", () => {
  it("把备份换回去并重启，且不删除备份之外的目录", () => {
    const command = buildRollback("ops", "/srv/ops", "/srv/ops.bak-20260102030405");
    expect(command).toContain("rm -rf '/srv/ops'");
    expect(command).toContain("mv '/srv/ops.bak-20260102030405' '/srv/ops'");
    expect(command).toContain("docker restart 'ops'");
  });
});
