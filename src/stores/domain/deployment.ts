/**
 * Deployment domain — spec §63–§80.
 */

export type DeploymentStrategy =
  | "restart"
  | "graceful-reload"
  | "atomic-switch"
  | "rolling"
  | "blue-green";

export type DeploymentType =
  | "nginx-static"
  | "docker"
  | "docker-compose"
  | "native-service"
  | "custom";

export type DeploymentStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "rolling-back" | "rolled-back";

export interface DeploymentProfile {
  id: string;
  projectId: string;
  name: string;
  deploymentType: DeploymentType;
  deploymentStrategy: DeploymentStrategy;
  targetServerIds: string[];
  targetServerGroupId?: string;
  // Nginx specific
  nginxConfigTemplate?: string;
  nginxSites?: string[];
  // Docker specific
  dockerImage?: string;
  dockerTag?: string;
  dockerComposeFile?: string;
  dockerRunArgs?: string[];
  // Native service specific
  systemdServiceName?: string;
  systemdServiceFile?: string;
  // Health check
  healthCheckType?: "process" | "port" | "http" | "https" | "docker-health" | "command" | "database" | "redis" | "composite";
  healthCheckUrl?: string;
  healthCheckPort?: number;
  healthCheckCommand?: string;
  healthCheckInterval?: number;
  healthCheckTimeout?: number;
  // Rollback
  autoRollbackOnHealthFailure: boolean;
  rollbackStrategy?: DeploymentStrategy;
  // Config
  configOverrides: Record<string, string>;
  createdAt: number;
}

export interface Deployment {
  id: string;
  projectId: string;
  deploymentProfileId: string;
  environmentId?: string;
  artifactId?: string;
  gitCommit?: string;
  workflowId?: string;
  workflowVersion?: number;
  status: DeploymentStatus;
  statusMessage?: string;
  startedAt: number;
  completedAt?: number;
  duration?: number;
  // Snapshot data (spec §79)
  snapshot?: DeploymentSnapshot;
}

export interface DeploymentSnapshot {
  id: string;
  deploymentId: string;
  projectId: string;
  environmentId?: string;
  gitCommit?: string;
  artifactId?: string;
  workflowVersion: number;
  resolvedConfig: Record<string, string>;
  dependencySnapshot: Record<string, any>;
  serverFingerprint: string;
  dockerDigest?: string;
  nginxConfig?: string;
  composeSnapshot?: string;
  systemdSnapshot?: string;
  migrationState?: string;
  healthResult?: HealthResult;
  createdAt: number;
}

// ============================================================================
// Health Check (spec §76)
// ============================================================================

export interface HealthResult {
  id: string;
  deploymentId?: string;
  workflowRunId?: string;
  type: "process" | "port" | "http" | "https" | "docker-health" | "command" | "database" | "redis" | "composite";
  status: "healthy" | "unhealthy" | "degraded" | "unknown";
  checkedAt: number;
  responseTime?: number;
  details?: Record<string, any>;
  errorMessage?: string;
}
