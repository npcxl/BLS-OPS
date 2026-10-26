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
 * 从本地文件导入的私钥（**只返回内容，不落库**）。
 *
 * 读取是受限的：≤64 KiB、必须是 UTF-8、内容必须真的像私钥
 * （OpenSSH / PEM / PuTTY）。路径只能来自系统文件选择器。
 */
export interface ImportedPrivateKey {
  /** 原始文件名（用于界面显示来源）。 */
  file_name: string;
  /** 私钥文本（已去 BOM）。 */
  content: string;
  bytes: number;
  /** `openssh` / `pem` / `ppk` */
  format: string;
  /**
   * 私钥本身是否需要口令。
   *
   * `null` = 无法从文本判断（OpenSSH 的加密信息在 base64 blob 里）。
   */
  encrypted: boolean | null;
}

/**
 * label 存 i18n key（natural keys）：渲染处统一 `t(option.label)`，
 * 语言切换即重渲染 —— 模块级常量不能用 hook。
 */
export const CREDENTIAL_TYPES = [
  { value: "password", label: "Password" },
  { value: "private_key", label: "Private key" },
] as const;
