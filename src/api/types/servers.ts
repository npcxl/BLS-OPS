/** Server / group / credential / known-host domain types. */

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
  favorite: boolean;
  last_connected_at?: number | null;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface ServerGroupRecord {

  id: string;
  name: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface CredentialRecord {
  id: string;
  name: string;
  credential_type: "password" | "private_key" | string;
  username: string;
  /** Keyring reference only — the secret itself never leaves Rust. */
  secret_ref?: string | null;
  passphrase_ref?: string | null;
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

export interface CascadeResult {
  sessions: number;
  history: number;
}

export interface CredentialDeleteResult {
  deleted: boolean;
  references: number;
}

/**
 * label 存 i18n key（natural keys）：渲染处统一 `t(option.label)`，
 * 语言切换即重渲染 —— 模块级常量不能用 hook。
 */
export const CREDENTIAL_TYPES = [
  { value: "password", label: "Password" },
  { value: "private_key", label: "Private key" },
] as const;
