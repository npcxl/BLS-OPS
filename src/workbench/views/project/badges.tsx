import { Box, Container, Globe, Server, Ship } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { i18n } from "@/i18n";
import type {
  CandidateInstance,
  DetectedService,
  InstanceRuntime,
  ServiceGroup,
} from "@/api/ops-api";

// ---------------------------------------------------------------------------
// 服务分类配色
// ---------------------------------------------------------------------------

/** 每一类服务一种颜色，让"数据库 / 缓存 / 网关"在列表里一眼可分。label 存英文 key，渲染处 t()。 */
const GROUP_TONE: Record<ServiceGroup, { chip: string; labelKey: string }> = {
  application: { chip: "bg-accent/12 text-accent", labelKey: "Business app" },
  database: { chip: "bg-[#f59e0b]/12 text-[#b45309]", labelKey: "Database" },
  cache: { chip: "bg-[#ef4444]/12 text-[#b91c1c]", labelKey: "Cache" },
  messaging: { chip: "bg-[#8b5cf6]/12 text-[#6d28d9]", labelKey: "Message queue" },
  search: { chip: "bg-[#06b6d4]/12 text-[#0e7490]", labelKey: "Search engine" },
  gateway: { chip: "bg-success/12 text-success", labelKey: "Gateway" },
  storage: { chip: "bg-[#14b8a6]/12 text-[#0f766e]", labelKey: "Object storage" },
  coordination: { chip: "bg-[#6366f1]/12 text-[#4338ca]", labelKey: "Config & coordination" },
  observability: { chip: "bg-[#a855f7]/12 text-[#7e22ce]", labelKey: "Observability" },
  devops: { chip: "bg-[#0ea5e9]/12 text-[#0369a1]", labelKey: "DevOps platform" },
  infrastructure: { chip: "bg-surface-2 text-fg-subtle", labelKey: "Container infrastructure" },
  security: { chip: "bg-[#64748b]/12 text-[#475569]", labelKey: "Security & identity" },
  ai_runtime: { chip: "bg-[#ec4899]/12 text-[#be185d]", labelKey: "AI runtime" },
};

export function serviceGroupLabel(group: ServiceGroup): string {
  return i18n.t(GROUP_TONE[group]?.labelKey ?? group);
}

// ---------------------------------------------------------------------------
// 端口
// ---------------------------------------------------------------------------

/** 事实标准的端口 → 服务名。仅用于展示提示，绝不据此判定项目性质。中文文案存英文 key，渲染处 t()。 */
const WELL_KNOWN_PORTS: Record<number, string> = {
  22: "SSH",
  80: "HTTP",
  443: "HTTPS",
  3306: "MySQL",
  3307: "MySQL",
  5432: "PostgreSQL",
  5433: "PostgreSQL",
  6379: "Redis",
  6380: "Redis",
  11211: "Memcached",
  27017: "MongoDB",
  5672: "RabbitMQ",
  15672: "RabbitMQ admin",
  9092: "Kafka",
  2181: "ZooKeeper",
  9200: "Elasticsearch",
  9300: "Elasticsearch",
  2379: "etcd",
  2380: "etcd",
  8080: "Common app port",
  8000: "Common app port",
  3000: "Common app port",
  5000: "Common app port",
  8888: "Common app port",
};

/** 端口 chip 的配色：已知服务用暖色提醒"这是标准端口"，普通端口保持中性。 */
function portTone(port: number) {
  const known = WELL_KNOWN_PORTS[port];
  if (!known) return "border-line bg-surface-2 text-fg-muted";
  switch (port) {
    case 3306:
    case 3307:
    case 5432:
    case 5433:
    case 27017:
      return "border-[#f59e0b]/30 bg-[#f59e0b]/10 text-[#b45309]";
    case 6379:
    case 6380:
    case 11211:
      return "border-[#ef4444]/30 bg-[#ef4444]/10 text-[#b91c1c]";
    case 5672:
    case 15672:
    case 9092:
    case 2181:
      return "border-[#8b5cf6]/30 bg-[#8b5cf6]/10 text-[#6d28d9]";
    case 9200:
    case 9300:
      return "border-[#06b6d4]/30 bg-[#06b6d4]/10 text-[#0e7490]";
    case 2379:
    case 2380:
      return "border-[#6366f1]/30 bg-[#6366f1]/10 text-[#4338ca]";
    case 22:
      return "border-line bg-surface-2 text-fg-subtle";
    default:
      return "border-success/30 bg-success/10 text-success";
  }
}

/**
 * 端口是重要数据，不能挤在一行小字里。每个端口一个等宽 chip，
 * 已知服务还会标出用途，鼠标悬停给出完整说明。
 */
export function PortChips({
  ports,
  className,
  empty = "No listening ports",
}: {
  ports: number[];
  className?: string;
  /** 空态文案（英文 key，渲染处 t()；传空串则不显示）。 */
  empty?: string;
}) {
  const { t } = useTranslation();
  if (ports.length === 0) {
    return <span className="text-10 text-fg-subtle">{t(empty)}</span>;
  }
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      {ports.map((port) => {
        const hint = WELL_KNOWN_PORTS[port];
        return (
          <span
            key={port}
            title={hint ? t("{{port}} — {{hint}}", { port, hint: t(hint) }) : t("Port {{port}}", { port })}
            className={cn(
              "inline-flex items-center gap-1 rounded-[5px] border px-1.5 py-[1px] font-mono text-10 leading-[15px] tabular-nums",
              portTone(port),
            )}
          >
            <span className="h-1 w-1 rounded-full bg-current opacity-60" />
            {port}
            {hint && <span className="font-sans opacity-75">{t(hint)}</span>}
          </span>
        );
      })}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 徽标
// ---------------------------------------------------------------------------

/** 识别出的服务（MySQL / Redis / Nginx …）。认不出就不渲染。 */
export function ServiceBadge({ service }: { service?: DetectedService }) {
  const { t } = useTranslation();
  if (!service) return null;
  const tone = GROUP_TONE[service.group] ?? GROUP_TONE.infrastructure;
  return (
    <span
      className={cn("rounded px-1.5 py-0.5 text-10", tone.chip)}
      title={t("Detected as {{service}} ({{group}})", { service: service.label, group: t(tone.labelKey) })}
    >
      {service.label}
    </span>
  );
}

const RUNTIME_META: Record<
  InstanceRuntime,
  { icon: typeof Box; labelKey: string; tone: string }
> = {
  host: { icon: Server, labelKey: "Host machine", tone: "bg-surface-2 text-fg-muted" },
  container: { icon: Container, labelKey: "Docker container", tone: "bg-[#0ea5e9]/12 text-[#0369a1]" },
  kubernetes: { icon: Ship, labelKey: "Kubernetes", tone: "bg-[#6366f1]/12 text-[#4338ca]" },
};

/**
 * 实例**跑在哪里**。宿主机进程、Docker 容器、k8s Pod 三者可以共存于同一台
 * 机器（k8s 用 docker 承载 Pod），所以这个徽标是判断归属的关键。
 */
export function RuntimeBadge({
  runtime,
  className,
}: {
  runtime?: InstanceRuntime;
  className?: string;
}) {
  const { t } = useTranslation();
  const meta = RUNTIME_META[runtime ?? "host"] ?? RUNTIME_META.host;
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-10",
        meta.tone,
        className,
      )}
    >
      <Icon size={9} />
      {t(meta.labelKey)}
    </span>
  );
}

const INSTANCE_KIND_META: Record<string, { icon: typeof Box; label: string }> = {
  docker: { icon: Box, label: "Docker" },
  systemd: { icon: Server, label: "systemd" },
  nginx: { icon: Globe, label: "Nginx" },
  k8s: { icon: Ship, label: "Kubernetes" },
};

export function instanceKindMeta(kind: string) {
  return INSTANCE_KIND_META[kind] ?? { icon: Box, label: kind };
}

/**
 * 配置文件入口的展示名：`docker-compose.yml` → "Docker 配置"、
 * `nginx.conf` → "Nginx 配置"、`.service` → "unit 文件"。
 * 认不出就回退到文件名本身，绝不编造。
 */
export function configFileLabel(path: string): string {
  const name = path.split("/").pop() ?? path;
  const lower = name.toLowerCase();
  if (lower.startsWith("docker-compose") || lower === "compose.yml" || lower === "compose.yaml") {
    return "Docker Compose";
  }
  if (lower === "dockerfile") return "Dockerfile";
  if (lower.includes("nginx") || lower.endsWith(".conf")) {
    return lower.includes("nginx") ? i18n.t("Nginx config") : name;
  }
  if (lower.endsWith(".service")) return "systemd unit";
  if (lower === "procfile") return "Procfile";
  return name;
}

/** 一个实例有没有宿主机上的配置文件可看（镜像运行的实例通常没有）。 */
export function hasConfig(instance: CandidateInstance): boolean {
  return instance.config_files.length > 0;
}
 