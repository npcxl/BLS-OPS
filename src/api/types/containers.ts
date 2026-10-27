/** Docker containers / images / stats types. */

export interface ContainerInfo {
  id: string;
  short_id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  created_at: string;
}

export interface ImageInfo {
  id: string;
  short_id: string;
  repository: string;
  tag: string;
  size: string;
  created_since: string;
  display_name: string;
}

export interface ContainerStats {
  name: string;
  cpu_percent: number;
  memory_usage: string;
  memory_percent: number;
  net_io: string;
  block_io: string;
}

export interface DockerSnapshot {
  available: boolean;
  containers: ContainerInfo[];
  images: ImageInfo[];
  stats: ContainerStats[];
  /** Set when Docker is missing or the daemon is unreachable. */
  unavailable_reason: string | null;
}

export type ContainerActionName = "start" | "stop" | "restart" | "remove";

/** 一条端口映射：宿主 `8080` → 容器 `80/tcp`。未发布端口 `host_port` 为空。 */
export interface ContainerPort {
  host_ip: string;
  host_port: string;
  container_port: string;
}

export interface ContainerMount {
  /** `bind` / `volume` / `tmpfs` */
  kind: string;
  source: string;
  destination: string;
  read_only: boolean;
}

/**
 * 容器配置摘要（`docker inspect` 的安全子集）。
 *
 * 后端**刻意不返回** `Config.Env` 与启动命令：那里常见数据库密码与 token。
 * 前端也不要试图补全它们。
 */
export interface ContainerConfig {
  id: string;
  name: string;
  image: string;
  /** `created` / `running` / `exited` / `paused` / `restarting` */
  state: string;
  created: string;
  started_at: string;
  finished_at: string;
  exit_code: number;
  oom_killed: boolean;
  health?: string;
  restart_policy: string;
  working_dir: string;
  ports: ContainerPort[];
  mounts: ContainerMount[];
  compose_project?: string;
  compose_service?: string;
  compose_files: string[];
}
