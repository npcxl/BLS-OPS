/**
 * Build & Artifacts domain — spec §60–§62.
 */

export type BuildType = "local" | "remote" | "docker" | "external-ci" | "no-build";

export type ArtifactType =
  | "static-directory"
  | "zip"
  | "tar"
  | "jar"
  | "binary"
  | "docker-image"
  | "docker-digest"
  | "custom";

export interface BuildProfile {
  id: string;
  projectId: string;
  name: string;
  buildType: BuildType;
  buildCommand?: string;
  outputPath?: string;
  dockerfile?: string;
  dockerContext?: string;
  dockerTag?: string;
  externalCiUrl?: string;
  createdAt: number;
}

export interface Build {
  id: string;
  projectId: string;
  buildProfileId: string;
  gitCommit?: string;
  gitBranch?: string;
  artifactId?: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  startedAt: number;
  completedAt?: number;
  duration?: number;
  output?: string;
  errorMessage?: string;
}

export interface Artifact {
  id: string;
  buildId: string;
  projectId: string;
  artifactType: ArtifactType;
  path: string;
  checksum: string;
  size: number;
  gitCommit?: string;
  createdAt: number;
  metadata?: Record<string, string>;
}
