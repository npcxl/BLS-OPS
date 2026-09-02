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
