/**
 * 顶层实例分类纯函数：应用服务 / 基础设施 / 待归类 / 系统组件 四个**互斥**集合。
 *
 * 分类判断一律以后端 `workload_role` 为准（React 只展示后端结果）；
 * 旧快照缺失该字段时按 `unknown`（待归类）处理，绝不默认归基础设施。
 */
import type { DeploymentInstance, InfrastructureCategory } from "@/api/ops-api";

export interface PartitionedInstances {
  /** workload_role = application */
  applications: DeploymentInstance[];
  /** workload_role = infrastructure */
  infrastructure: DeploymentInstance[];
  /** workload_role = unknown（待归类） */
  unclassified: DeploymentInstance[];
  /** workload_role = system（默认不进任何顶层 Tab） */
  system: DeploymentInstance[];
}

/** 实例的顶层角色；旧快照缺字段按待归类处理。 */
export function instanceRole(instance: DeploymentInstance): NonNullable<DeploymentInstance["workload_role"]> {
  return instance.workload_role ?? "unknown";
}

/** 把实例划分成四个互斥集合：同一个 id 只会落在一个集合里。 */
export function partitionInstances(instances: DeploymentInstance[]): PartitionedInstances {
  const partitioned: PartitionedInstances = {
    applications: [],
    infrastructure: [],
    unclassified: [],
    system: [],
  };
  for (const instance of instances) {
    switch (instanceRole(instance)) {
      case "application":
        partitioned.applications.push(instance);
        break;
      case "infrastructure":
        partitioned.infrastructure.push(instance);
        break;
      case "system":
        partitioned.system.push(instance);
        break;
      default:
        partitioned.unclassified.push(instance);
        break;
    }
  }
  return partitioned;
}

/** 开发期断言：同一个实例不允许同时出现在应用服务与基础设施。 */
export function findDuplicateIds(partitioned: PartitionedInstances): string[] {
  return partitioned.applications
    .filter((app) => partitioned.infrastructure.some((infra) => infra.id === app.id))
    .map((instance) => instance.id);
}

// ---------------------------------------------------------------------------
// 基础设施分组
// ---------------------------------------------------------------------------

/** 基础设施分组展示顺序（与后端 InfrastructureCategory 对齐）；label 存英文 key，渲染处 t()。 */
export const INFRA_CATEGORY_LABELS: Record<InfrastructureCategory, string> = {
  database: "Database",
  cache: "Cache",
  object_storage: "Object storage",
  messaging: "Messaging & streams",
  search: "Search & indexing",
  gateway: "Gateway & proxy",
  coordination: "Config & coordination",
  observability: "Observability",
  devops: "DevOps",
  container_platform: "Container platform",
  security: "Security & identity",
  ai_runtime: "AI runtime",
  unknown: "Other",
};

export const INFRA_CATEGORY_ORDER: InfrastructureCategory[] = [
  "database",
  "cache",
  "object_storage",
  "messaging",
  "search",
  "gateway",
  "coordination",
  "observability",
  "devops",
  "container_platform",
  "security",
  "ai_runtime",
  "unknown",
];

export interface InfrastructureGroup {
  category: InfrastructureCategory;
  label: string;
  instances: DeploymentInstance[];
}

/** 按 infrastructure_category 分组；只返回非空组，顺序稳定。 */
export function groupInfrastructure(instances: DeploymentInstance[]): InfrastructureGroup[] {
  const byCategory = new Map<InfrastructureCategory, DeploymentInstance[]>();
  for (const instance of instances) {
    const category = instance.infrastructure_category ?? "unknown";
    const bucket = byCategory.get(category);
    if (bucket) {
      bucket.push(instance);
    } else {
      byCategory.set(category, [instance]);
    }
  }
  return INFRA_CATEGORY_ORDER.filter((category) => byCategory.has(category)).map((category) => ({
    category,
    label: INFRA_CATEGORY_LABELS[category],
    instances: byCategory.get(category) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// 标签
// ---------------------------------------------------------------------------

export const WORKLOAD_ROLE_LABELS: Record<NonNullable<DeploymentInstance["workload_role"]>, string> = {
  application: "App services",
  infrastructure: "Infrastructure",
  system: "System components",
  unknown: "Unclassified",
};

export const COMPONENT_ROLE_LABELS: Record<string, string> = {
  frontend: "Frontend",
  backend: "Backend",
  worker: "Worker",
  scheduled_job: "Scheduled job",
  database: "Database",
  cache: "Cache",
  object_storage: "Object storage",
  message_queue: "Message queue",
  search: "Search engine",
  gateway: "Gateway",
  observability: "Observability",
  ai_inference: "AI inference",
  unknown: "Role unknown",
};

export const OWNERSHIP_LABELS: Record<string, string> = {
  shared: "Shared",
  project_scoped: "Project-scoped",
  unknown: "Ownership unknown",
};

export const CONFIDENCE_LABELS: Record<string, string> = {
  high: "Confidence: high",
  medium: "Confidence: medium",
  low: "Confidence: low",
};

/** 卡片展示的产品名：technology → service → 实例名，绝不编造。 */
export function instanceProductLabel(instance: DeploymentInstance): string {
  return instance.technology?.label ?? instance.service?.label ?? instance.name;
}
