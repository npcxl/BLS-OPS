import { describe, expect, it } from "vitest";
import type { DeploymentInstance } from "@/api/ops-api";
import {
  findDuplicateIds,
  groupInfrastructure,
  instanceProductLabel,
  partitionInstances,
} from "../classify";

/** 构造一个最小实例；role 传 undefined 模拟旧快照缺字段。 */
function instance(overrides: Partial<DeploymentInstance> & { id: string }): DeploymentInstance {
  return {
    kind: "docker",
    name: overrides.id,
    status: "running",
    runtime: "container",
    system_owned: false,
    ports: [],
    working_directories: [],
    config_files: [],
    source_paths: [],
    source_known: false,
    detail: "",
    workload_role: "unknown",
    component_role: "unknown",
    ownership: "unknown",
    linked_project_ids: [],
    classification_evidence: [],
    classification_confidence: "low",
    ...overrides,
  } as DeploymentInstance;
}

function infra(id: string, category: DeploymentInstance["infrastructure_category"]) {
  return instance({ id, workload_role: "infrastructure", infrastructure_category: category });
}

describe("顶层实例互斥分类", () => {
  it("MySQL 只出现在基础设施，绝不进入应用服务", () => {
    const partitioned = partitionInstances([infra("mysql-1", "database")]);
    expect(partitioned.infrastructure.map((i) => i.id)).toEqual(["mysql-1"]);
    expect(partitioned.applications).toHaveLength(0);
    expect(partitioned.unclassified).toHaveLength(0);
  });

  it("Redis 只出现在基础设施", () => {
    const partitioned = partitionInstances([infra("redis-1", "cache")]);
    expect(partitioned.infrastructure.map((i) => i.id)).toEqual(["redis-1"]);
    expect(partitioned.applications).toHaveLength(0);
  });

  it("MinIO 只出现在基础设施", () => {
    const partitioned = partitionInstances([infra("minio-1", "object_storage")]);
    expect(partitioned.infrastructure.map((i) => i.id)).toEqual(["minio-1"]);
    expect(partitioned.applications).toHaveLength(0);
  });

  it("Node API 只出现在应用服务", () => {
    const node = instance({
      id: "node-api",
      workload_role: "application",
      component_role: "backend",
      technology: { id: "node", label: "Node.js" },
      linked_project_ids: ["/srv/api"],
    });
    const partitioned = partitionInstances([node]);
    expect(partitioned.applications.map((i) => i.id)).toEqual(["node-api"]);
    expect(partitioned.infrastructure).toHaveLength(0);
  });

  it("unknown 不进入基础设施，归入待归类", () => {
    const mystery = instance({ id: "custom-api", image: "registry.local/team/api:1.0" });
    const partitioned = partitionInstances([mystery]);
    expect(partitioned.unclassified.map((i) => i.id)).toEqual(["custom-api"]);
    expect(partitioned.infrastructure).toHaveLength(0);
    expect(partitioned.applications).toHaveLength(0);
  });

  it("同一个 instance.id 不会同时出现在两个顶层集合", () => {
    const partitioned = partitionInstances([
      infra("mysql-1", "database"),
      infra("redis-1", "cache"),
      instance({ id: "node-api", workload_role: "application" }),
    ]);
    expect(findDuplicateIds(partitioned)).toEqual([]);
    const ids = [
      ...partitioned.applications,
      ...partitioned.infrastructure,
      ...partitioned.unclassified,
      ...partitioned.system,
    ].map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("系统组件默认不进应用服务/基础设施/待归类", () => {
    const sandbox = instance({ id: "sandbox", workload_role: "system", system_owned: true });
    const partitioned = partitionInstances([sandbox]);
    expect(partitioned.system.map((i) => i.id)).toEqual(["sandbox"]);
    expect(partitioned.applications).toHaveLength(0);
    expect(partitioned.infrastructure).toHaveLength(0);
    expect(partitioned.unclassified).toHaveLength(0);
  });
});

describe("基础设施分组", () => {
  it("按 infrastructure_category 正确分组且顺序稳定", () => {
    const groups = groupInfrastructure([
      infra("redis-1", "cache"),
      infra("mysql-1", "database"),
      infra("nginx-1", "gateway"),
      infra("minio-1", "object_storage"),
      infra("redis-2", "cache"),
    ]);
    expect(groups.map((g) => g.category)).toEqual(["database", "cache", "object_storage", "gateway"]);
    expect(groups[1].instances.map((i) => i.id)).toEqual(["redis-1", "redis-2"]);
    expect(groups[1].label).toBe("Cache");
  });

  it("缺类别的实例归入「其他」组，不崩溃", () => {
    const groups = groupInfrastructure([instance({ id: "weird", workload_role: "infrastructure" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].category).toBe("unknown");
    expect(groups[0].label).toBe("Other");
  });

  it("基础设施可以带关联项目，但仍停留在基础设施分组（不进项目列表）", () => {
    const shared = infra("mysql-1", "database");
    shared.linked_project_ids = ["/srv/api", "/srv/web"];
    const partitioned = partitionInstances([shared]);
    expect(partitioned.infrastructure).toHaveLength(1);
    expect(partitioned.infrastructure[0].linked_project_ids).toHaveLength(2);
    // partition 的输出只有实例集合，没有"项目"；分组渲染也只消费 infrastructure。
    expect(groupInfrastructure(partitioned.infrastructure)[0].instances[0].id).toBe("mysql-1");
  });
});

describe("跨服务器与旧快照", () => {
  it("两次独立调用（模拟切换服务器）结果互不串台", () => {
    const first = partitionInstances([infra("mysql-1", "database")]);
    const second = partitionInstances([instance({ id: "node-api", workload_role: "application" })]);
    expect(first.infrastructure.map((i) => i.id)).toEqual(["mysql-1"]);
    expect(second.applications.map((i) => i.id)).toEqual(["node-api"]);
    expect(second.infrastructure).toHaveLength(0);
  });

  it("加载旧扫描快照（缺 workload_role 字段）不会崩溃，缺省按待归类处理", () => {
    const legacy = JSON.parse(
      JSON.stringify({
        id: "docker:old",
        kind: "docker",
        name: "old-container",
        status: "running",
        runtime: "container",
        system_owned: false,
        ports: [8080],
        working_directories: ["/srv/app"],
        config_files: [],
        source_paths: ["/srv/app"],
        source_known: true,
        detail: "旧快照",
      }),
    ) as DeploymentInstance;
    expect(() => partitionInstances([legacy])).not.toThrow();
    const partitioned = partitionInstances([legacy]);
    expect(partitioned.unclassified.map((i) => i.id)).toEqual(["docker:old"]);
  });

  it("产品名优先 technology，其次 service，最后实例名", () => {
    expect(
      instanceProductLabel(instance({ id: "x", workload_role: "application", technology: { id: "node", label: "Node.js" } })),
    ).toBe("Node.js");
    expect(
      instanceProductLabel(infra("db", "database")),
    ).toBe("db");
  });
});
