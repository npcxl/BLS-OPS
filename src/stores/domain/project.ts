/**
 * Projects domain — spec §35–§47.
 */

export type ProjectType =
  | "frontend"
  | "backend"
  | "fullstack"
  | "worker"
  | "scheduled-task"
  | "docker"
  | "docker-compose"
  | "static"
  | "infrastructure"
  | "custom";

export type ProjectStatus = "active" | "inactive" | "archived";

export interface Project {
  id: string;
  name: string;
  description?: string;
  type: ProjectType;
  status: ProjectStatus;
  // Source (spec §37)
  sourceType: "git" | "local-directory" | "remote-directory" | "existing-artifact" | "docker-registry" | "none";
  gitUrl?: string;
  gitBranch?: string;
  localPath?: string;
  remotePath?: string;
  // Relations (spec §42)
  relations: ProjectRelation[];
  // Environments (spec §39)
  environments: ProjectEnvironment[];
  // Config (spec §40)
  configs: ProjectConfig[];
  // Dependencies (spec §47)
  dependencies: ProjectDependency[];
  createdAt: number;
  updatedAt: number;
}

// ============================================================================
// Relations (spec §42)
// ============================================================================

export type RelationType =
  | "api"
  | "database"
  | "redis"
  | "mq"
  | "search"
  | "storage"
  | "websocket"
  | "custom";

export interface ProjectRelation {
  id: string;
  projectId: string;
  targetProjectId: string;
  targetProjectName: string;
  relationType: RelationType;
  description?: string;
}

// ============================================================================
// Environments (spec §39)
// ============================================================================

export type EnvironmentType = "development" | "test" | "staging" | "production" | "custom";

export interface ProjectEnvironment {
  id: string;
  projectId: string;
  name: string;
  type: EnvironmentType;
  serverIds: string[];
  serverGroupId?: string;
  configOverrides: Record<string, string>;
  domain?: string;
  deploymentProfileId?: string;
}

// ============================================================================
// Config (spec §40, §41)
// ============================================================================

export type ConfigTime = "build-time" | "runtime" | "reload" | "restart";

export type ConfigSource =
  | "literal"
  | "secret"
  | "project-reference"
  | "dependency-reference"
  | "environment-reference"
  | "file"
  | "generated"
  | "ai-proposed";

export interface ProjectConfig {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  configTime: ConfigTime;
  source: ConfigSource;
  value?: string;
  secretReference?: string; // Reference to secret in OS keyring
  filePath?: string;
  required: boolean;
}

// ============================================================================
// Dependencies (spec §47)
// ============================================================================

export type DependencyType =
  | "postgresql"
  | "mysql"
  | "mariadb"
  | "mongodb"
  | "redis"
  | "elasticsearch"
  | "rabbitmq"
  | "kafka"
  | "nats"
  | "minio"
  | "s3"
  | "external-api"
  | "other-project"
  | "custom";

export type DependencyManagedBy = "native" | "docker" | "docker-compose" | "external";

export interface ProjectDependency {
  id: string;
  projectId: string;
  name: string;
  type: DependencyType;
  managedBy: DependencyManagedBy;
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  passwordReference?: string; // Secret reference
  // Connection info
  connectionString?: string;
  // Health check
  healthCheckEnabled: boolean;
  healthCheckUrl?: string;
  healthCheckCommand?: string;
}
