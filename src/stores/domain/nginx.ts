/**
 * Nginx domain — spec §34.
 */

export type NginxStatus = "not-installed" | "installed" | "running" | "stopped" | "error";

export interface NginxInstance {
  id: string;
  serverId: string;
  status: NginxStatus;
  version?: string;
  configPath?: string;
  lastCheckedAt: number;
}

export type NginxSiteStatus = "enabled" | "disabled" | "error";

export interface NginxSite {
  id: string;
  nginxInstanceId: string;
  name: string;
  configPath: string;
  status: NginxSiteStatus;
  domains: string[];
  root?: string;
  proxyPass?: string;
  sslEnabled: boolean;
  sslCertPath?: string;
  sslKeyPath?: string;
  lastReloadedAt?: number;
}

export interface NginxConfigSnapshot {
  id: string;
  nginxInstanceId: string;
  configContent: string;
  createdAt: number;
  description?: string;
}

export interface NginxUpstream {
  id: string;
  nginxInstanceId: string;
  name: string;
  servers: Array<{
    address: string;
    port: number;
    weight?: number;
    maxFails?: number;
    failTimeout?: number;
  }>;
  method?: string; // round-robin, least-conn, ip-hash, etc.
}