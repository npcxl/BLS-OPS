/**
 * Docker domain — spec §32–§33.
 */

export type DockerStatus = "not-installed" | "cli-missing" | "daemon-down" | "permission-denied" | "ready";

export interface DockerHost {
  id: string;
  serverId: string;
  status: DockerStatus;
  version?: string;
  daemonInfo?: Record<string, any>;
  composeVersion?: string;
  lastCheckedAt: number;
}

export type ContainerStatus = "created" | "restarting" | "running" | "removing" | "paused" | "exited" | "dead";

export interface DockerContainer {
  id: string;
  dockerHostId: string;
  name: string;
  image: string;
  status: ContainerStatus;
  ports: Array<{
    hostPort: number;
    containerPort: number;
    protocol: string;
  }>;
  volumes: string[];
  networks: string[];
  createdAt: number;
  startedAt?: number;
  health?: string;
}

export interface DockerImage {
  id: string;
  dockerHostId: string;
  repository: string;
  tag: string;
  digest: string;
  size: number;
  createdAt: number;
}

export interface DockerCompose {
  id: string;
  dockerHostId: string;
  filePath: string;
  projectName: string;
  services: string[];
  status: "up" | "down" | "partially-up" | "error";
  lastChangedAt: number;
}
