/**
 * 服务器运行环境探测结果（Rust `env_probe` 的镜像类型）。
 *
 * 字段名与 Rust `#[serde(rename_all = "camelCase")]` 逐字对应 —— 任何一侧
 * 改名都要同时改另一侧，否则会掉进"接口正常但不渲染"的老坑。
 */

/** Nginx 环境类别（snake_case，与 Rust 枚举逐字一致）。 */
export type NginxKind = "host" | "docker" | "compose" | "multiple" | "none";

/** 容器内的 Nginx 家族。 */
export type NginxFlavor = "nginx" | "openresty";

/** 建议命令的风险等级（与知识库 `RiskLevel` 对齐）。 */
export type SuggestedRisk = "read_only" | "low" | "medium" | "high";

/** 端口映射：`80/tcp -> 0.0.0.0:8080`。 */
export interface PortBinding {
  containerPort: number;
  /** 宿主机端口；`null` 表示没有发布到宿主机。 */
  hostPort: number | null;
  protocol: string;
}

/** 挂载：宿主机路径 → 容器内路径。 */
export interface MountInfo {
  source: string;
  destination: string;
  readOnly: boolean;
}

/** Compose 归属。三项都齐全才算可靠。 */
export interface ComposeRef {
  project: string;
  service: string;
  workingDir: string;
}

/** 一个被识别为 Nginx 的容器。 */
export interface NginxContainer {
  name: string;
  shortId: string;
  image: string;
  imageRepository: string;
  imageTag: string;
  flavor: NginxFlavor | null;
  state: string;
  status: string;
  running: boolean;
  ports: PortBinding[];
  mounts: MountInfo[];
  compose: ComposeRef | null;
  /** `null` = 没探测到（容器没运行或没权限），**绝不当成 true**。 */
  hasBinary: boolean | null;
  /** 判定依据（给人看）。 */
  reasons: string[];
}

/** 一次探测的完整结果。 */
export interface NginxEnvironment {
  kind: NginxKind;
  containers: NginxContainer[];
  /** `null` = 无法判定宿主机是否装了 nginx。 */
  hostInstalled: boolean | null;
  dockerAvailable: boolean;
  /** Docker 不可用/无权限的具体原因；为 `null` 时表示可用。 */
  dockerReason: string | null;
  warnings: string[];
}

/** 环境生成的可执行命令。 */
export interface SuggestedCommand {
  id: string;
  title: string;
  command: string;
  risk: SuggestedRisk;
  note: string | null;
  /** 该命令依赖容器名（多容器环境下必须先选容器）。 */
  needsContainer?: boolean;
}

export const NGINX_KIND_LABELS: Record<NginxKind, string> = {
  host: "宿主机 Nginx",
  docker: "Docker Nginx",
  compose: "Docker Compose Nginx",
  multiple: "多个 Nginx 容器",
  none: "未检测到 Nginx",
};

/** 容器一行摘要：名称 · 镜像 · 状态 · 端口 · Compose 项目（选择器用）。 */
export function describeContainer(container: NginxContainer): string {
  const ports = publishedPorts(container);
  const compose = container.compose ? ` · ${container.compose.project}` : "";
  const portText = ports.length > 0 ? ` · ${ports.join("、")}` : "";
  return `${container.image}${portText} · ${container.status}${compose}`;
}

/** 对外发布的宿主机端口（去重升序）。 */
export function publishedPorts(container: NginxContainer): number[] {
  const ports = container.ports
    .map((port) => port.hostPort)
    .filter((port): port is number => port !== null);
  return [...new Set(ports)].sort((a, b) => a - b);
}

/** 挂载到容器内 Nginx 配置目录的项。 */
export function configMounts(container: NginxContainer): MountInfo[] {
  return container.mounts.filter(
    (mount) =>
      mount.destination === "/etc/nginx" ||
      mount.destination.startsWith("/etc/nginx/") ||
      mount.destination === "/usr/local/nginx/conf" ||
      mount.destination.startsWith("/usr/local/nginx/conf/"),
  );
}
