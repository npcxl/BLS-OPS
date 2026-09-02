/** Nginx site / config types. */

export type NginxSource = "sites_available" | "conf_d";

export interface NginxSite {
  name: string;
  enabled: boolean;
  path: string;
  source: NginxSource;
  server_names: string[];
  listen_ports: number[];
  is_default: boolean;
}

export interface NginxTestResult {
  success: boolean;
  output: string;
}

export interface NginxSaveResult {
  saved: boolean;
  test: NginxTestResult;
  reloaded: boolean;
  backup_path: string | null;
}
