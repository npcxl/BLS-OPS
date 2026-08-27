/**
 * Workflow domain — spec §53–§59.
 */

export type WorkflowNodeType =
  | "git-clone"
  | "git-fetch"
  | "git-pull"
  | "git-checkout"
  | "install-dependencies"
  | "build"
  | "test"
  | "use-existing-artifact"
  | "create-artifact"
  | "upload"
  | "download"
  | "resolve-config"
  | "check-dependencies"
  | "docker-build"
  | "docker-push"
  | "docker-pull"
  | "docker-run"
  | "docker-compose"
  | "nginx-generate"
  | "nginx-validate"
  | "nginx-reload"
  | "release-create"
  | "release-switch"
  | "systemd-start"
  | "systemd-stop"
  | "systemd-restart"
  | "systemd-reload"
  | "database-migration"
  | "health-check"
  | "approval"
  | "rollback-point"
  | "local-command"
  | "remote-command"
  | "custom-script";

export type WorkflowNodeStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "disabled";

export interface WorkflowNode {
  id: string;
  workflowId: string;
  type: WorkflowNodeType;
  name: string;
  description?: string;
  x: number;
  y: number;
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  conditions?: {
    skipIf?: string; // Expression to evaluate for skipping
    disabledIf?: string;
  };
  timeout?: number; // seconds
  retryCount?: number;
}

export interface WorkflowEdge {
  id: string;
  workflowId: string;
  sourceId: string;
  targetId: string;
  condition?: string; // Optional edge condition
}

export interface Workflow {
  id: string;
  projectId: string;
  name: string;
  version: number;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowVersion: number;
  projectId: string;
  environmentId?: string;
  status: WorkflowNodeStatus;
  startedAt: number;
  completedAt?: number;
  duration?: number;
  errorMessage?: string;
}

export interface WorkflowNodeRun {
  id: string;
  workflowRunId: string;
  nodeId: string;
  status: WorkflowNodeStatus;
  startedAt: number;
  completedAt?: number;
  duration?: number;
  output?: string;
  errorMessage?: string;
  inputSnapshot: Record<string, string>;
  outputSnapshot: Record<string, string>;
}
