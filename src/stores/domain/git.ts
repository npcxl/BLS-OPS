/**
 * Git domain — spec §38.
 */

export type GitProvider = "github" | "gitlab" | "gitea" | "generic" | "local";

export interface GitSource {
  id: string;
  projectId: string;
  url: string;
  provider: GitProvider;
  branch: string;
  tag?: string;
  commit?: string;
  username?: string;
  tokenReference?: string; // Secret reference for auth
}

export interface GitSnapshot {
  id: string;
  gitSourceId: string;
  commit: string;
  message: string;
  author: string;
  timestamp: number;
}
