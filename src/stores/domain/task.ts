/**
 * Task queue domain — spec §107–§108.
 */

export type TaskType =
  | "transfer"
  | "build"
  | "deploy"
  | "rollback"
  | "docker-pull"
  | "docker-build"
  | "git-clone"
  | "git-pull"
  | "command"
  | "health-check"
  | "custom";

export type TaskStatus = "pending" | "running" | "waiting-approval" | "paused" | "succeeded" | "failed" | "cancelled" | "rolling-back";

export interface Task {
  id: string;
  type: TaskType;
  title: string;
  description?: string;
  status: TaskStatus;
  progress: number; // 0-100
  serverId?: string;
  projectId?: string;
  deploymentId?: string;
  buildId?: string;
  transferId?: string;
  startedAt: number;
  completedAt?: number;
  duration?: number;
  errorMessage?: string;
  metadata?: Record<string, any>;
}
