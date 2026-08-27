import { invoke } from "@tauri-apps/api/core";

export interface ServerRecord {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  credential_id?: string | null;
  group_id?: string | null;
  tags: string[];
  proxy_jump_id?: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface CredentialRecord {
  id: string;
  name: string;
  credential_type: string;
  username: string;
  secret_ref?: string | null;
  created_at: number;
  updated_at: number;
}

export interface KnownHostRecord {
  id: string;
  host: string;
  port: number;
  fingerprint: string;
  fingerprint_type: string;
  status: string;
  first_seen_at: number;
  last_seen_at: number;
}

export const opsApi = {
  listServers: () => invoke<ServerRecord[]>("server_list"),
  getServer: (id: string) => invoke<ServerRecord | null>("server_get", { id }),
  saveServer: (server: ServerRecord) => invoke<ServerRecord>("server_save", { server }),
  deleteServer: (id: string) => invoke<void>("server_delete", { id }),
  listCredentials: () => invoke<CredentialRecord[]>("credential_list"),
  saveCredential: (credential: CredentialRecord, secret?: string) => invoke<CredentialRecord>("credential_save", { credential, secret }),
  deleteCredential: (id: string, secretRef?: string | null) => invoke<void>("credential_delete", { id, secretRef }),
  listKnownHosts: () => invoke<KnownHostRecord[]>("known_host_list"),
  saveKnownHost: (host: KnownHostRecord) => invoke<KnownHostRecord>("known_host_save", { host }),
  saveCredentialSecret: (secretId: string, secret: string) => invoke<string>("credential_save_secret", { secretId, secret }),
  getCredentialSecret: (secretId: string) => invoke<string>("credential_get_secret", { secretId }),
  deleteCredentialSecret: (secretId: string) => invoke<void>("credential_delete_secret", { secretId }),
};
