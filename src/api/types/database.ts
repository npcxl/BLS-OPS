/**
 * 数据库工作台的 IPC 类型 —— 与 `src-tauri/src/database/model.rs` 一一对应。
 *
 * 三条必须遵守的约定：
 * 1. 整数/DECIMAL 是 **string**：`BIGINT UNSIGNED` 超过 2^53，JS 的
 *    `Number` 会静默丢精度。前端只展示，不 `Number()`。
 * 2. `DbValue` 是带 `kind` 的联合：`null` 与 `""` 是两种不同的值。
 * 3. 行是数组、列有 `index`：重复列名（`SELECT a.id, b.id`）靠序号区分。
 */

/**
 * 常用关系型数据库。当前只有 `mysql` 有真实适配器；其余值出现在连接表单
 * 里是为了让"支持边界"可见，UI 会禁用并标注"尚未实现"——不能在还没有
 * 驱动/类型/取消实现时假装可选。
 */
export type DbEngine =
  | "mysql"
  | "mariadb"
  | "postgres"
  | "sqlite"
  | "sqlserver"
  | "oracle";

export type TlsMode = "disabled" | "verify_ca" | "verify_identity";

export interface DatabaseProfile {
  id: string;
  name: string;
  engine: DbEngine;
  host: string;
  port: number;
  username: string;
  default_database: string | null;
  /** 只表示"钥匙串里有没有密码"，密码本身永远不回传。 */
  has_password: boolean;
  ssh_server_id: string | null;
  tls_mode: TlsMode;
  tls_ca_path: string | null;
  tls_server_name: string | null;
  read_only: boolean;
  connect_timeout_ms: number;
  query_timeout_ms: number;
  created_at: number;
  updated_at: number;
}

export interface SaveProfileRequest {
  profile: DatabaseProfile;
  /** `null` 保留原密码；`""` 清除；其他值覆盖。 */
  password: string | null;
}

export interface DbErrorInfo {
  /** config | ssh_tunnel | tcp | tls | auth | database | query |
   *  permission | cancelled | timeout | outcome_unknown | unsupported | budget */
  stage: string;
  code: number | null;
  sql_state: string | null;
  message: string;
  detail: string | null;
  retryable: boolean;
}

export type DbValue =
  | { kind: "null" }
  | { kind: "int"; value: string; unsigned: boolean }
  | { kind: "decimal"; value: string }
  | { kind: "float"; value: number }
  | { kind: "text"; value: string; bytes: number; truncated: boolean }
  | { kind: "json"; value: string; bytes: number; truncated: boolean }
  | { kind: "date"; value: string }
  | { kind: "date_time"; value: string; timezone: string }
  | { kind: "time"; value: string }
  | { kind: "binary"; base64: string; bytes: number; truncated: boolean }
  | { kind: "bit"; bits: string; value: string }
  | { kind: "unsupported"; type_name: string; preview: string; bytes: number };

export interface DbColumn {
  index: number;
  name: string;
  org_name: string;
  table: string;
  org_table: string;
  type_name: string;
  type_code: number;
  nullable: boolean;
  unsigned: boolean;
  binary: boolean;
  primary_key: boolean;
  auto_increment: boolean;
  decimals: number;
  charset: number;
}

export interface DbSessionInfo {
  session_id: string;
  profile_id: string;
  generation: number;
  connection_id: number;
  server_version: string | null;
  current_database: string | null;
  tls_active: boolean;
  tls_cipher: string | null;
  tls_version: string | null;
  transaction: "none" | "in_transaction" | "in_transaction_read_only" | "unknown";
  read_only: boolean;
  opened_at: number;
}

export type DbQueryState =
  | "queued"
  | "running"
  | "streaming"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed"
  | "outcome_unknown";

export type DbBatch =
  | {
      kind: "result_set";
      result_set_id: string;
      index: number;
      columns: DbColumn[];
      statement: string;
    }
  | {
      kind: "rows";
      result_set_id: string;
      sequence: number;
      rows: DbValue[][];
      bytes: number;
    }
  | {
      kind: "result_set_end";
      result_set_id: string;
      affected_rows: number;
      last_insert_id: string | null;
      warnings: number;
      info: string;
      rows: number;
      bytes: number;
      elapsed_ms: number;
    }
  | { kind: "error"; error: DbErrorInfo }
  | {
      kind: "finished";
      state: DbQueryState;
      elapsed_ms: number;
      rows: number;
      bytes: number;
      truncated: boolean;
      truncation_reason: string | null;
    };

export interface QueryBatchResponse {
  batch: DbBatch | null;
  state: DbQueryState;
  query_id: string;
  generation: number;
  in_flight: number;
  in_flight_bytes: number;
}

export interface QueryBudget {
  max_rows?: number;
  max_bytes?: number;
  batch_rows?: number;
  batch_bytes?: number;
  field_preview_bytes?: number;
}

export interface QueryStarted {
  query_id: string;
  state: DbQueryState;
  generation: number;
  connection_id: number;
}

export interface DbDatabase {
  name: string;
  system: boolean;
  charset: string | null;
  collation: string | null;
}

export interface DbTable {
  name: string;
  kind: "table" | "view";
  engine: string | null;
  estimated_rows: number | null;
  comment: string;
}

export interface DbTableColumn {
  name: string;
  ordinal: number;
  data_type: string;
  column_type: string;
  nullable: boolean;
  default_value: string | null;
  default_expression: string | null;
  primary_key: boolean;
  auto_increment: boolean;
  unsigned: boolean;
  charset: string | null;
  collation: string | null;
  comment: string;
}

export interface DbIndexColumn {
  name: string;
  seq: number;
  sub_part: number | null;
  direction: string | null;
}

export interface DbIndex {
  name: string;
  unique: boolean;
  primary: boolean;
  kind: string;
  columns: DbIndexColumn[];
}

export interface NewColumn {
  name: string;
  column_type: string;
  nullable: boolean;
  auto_increment: boolean;
  default_value: string | null;
  comment: string;
}

export type SchemaChange =
  | {
      action: "create_database";
      name: string;
      charset: string | null;
      collation: string | null;
    }
  | {
      action: "create_table";
      database: string;
      table: string;
      columns: NewColumn[];
      primary_key: string[];
      engine: string | null;
      charset: string | null;
      collation: string | null;
    }
  | { action: "drop_database"; name: string }
  | {
      action: "save_view";
      database: string;
      view: string;
      select_sql: string;
      or_replace: boolean;
    }
  | { action: "drop_view"; database: string; view: string };

export interface SchemaPreview {
  sql: string;
  warning: string | null;
  destructive: boolean;
}

export interface SchemaOutcome {
  sql: string;
}

export type TableOperationKind =
  | "rename"
  | "copy_structure"
  | "copy_data"
  | "drop"
  | "truncate";

export interface TableOperationRequest {
  kind: TableOperationKind;
  database: string;
  table: string;
  new_name: string | null;
}

export interface TableOperationPreview {
  sql: string;
  warning: string | null;
  destructive: boolean;
}

export interface TableOperationOutcome {
  sql: string;
  warning: string | null;
}

export interface DbTableDetail {
  database: string;
  table: string;
  kind: "table" | "view";
  engine: string | null;
  collation: string | null;
  estimated_rows: number | null;
  comment: string;
  create_sql: string | null;
  columns: DbTableColumn[];
  indexes: DbIndex[];
  primary_key: string[];
  reliable_key: string[] | null;
}

export interface BrowseFilter {
  column: string;
  op:
    | "eq"
    | "ne"
    | "contains"
    | "starts_with"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "is_null"
    | "not_null";
  value: string | null;
}

export interface BrowseSort {
  column: string;
  direction: "asc" | "desc";
}

export interface BrowseRequest {
  session_id: string;
  database: string;
  table: string;
  page_size?: number | null;
  offset?: number | null;
  after?: (string | null)[] | null;
  sorts?: BrowseSort[] | null;
  filters?: BrowseFilter[] | null;
  pagination?: "auto" | "keyset" | "offset" | null;
  exact_count?: boolean | null;
}

export interface BrowseResult {
  columns: DbColumn[];
  rows: DbValue[][];
  page_size: number;
  offset: number;
  pagination: "keyset" | "offset";
  key_columns: string[];
  next_cursor: (string | null)[] | null;
  has_more: boolean;
  estimated_rows: number | null;
  exact_rows: number | null;
  has_reliable_key: boolean;
  truncated: boolean;
  warning: string | null;
  elapsed_ms: number;
}

export type AssignValue =
  | { kind: "null" }
  | { kind: "default" }
  | { kind: "value"; value: string };

export interface ColumnAssignment {
  column: string;
  value: AssignValue;
}

export interface RowMutation {
  kind: "insert" | "update" | "delete";
  key: AssignValue[] | null;
  values: ColumnAssignment[];
  expected: ColumnAssignment[] | null;
}

export interface MutationRowOutcome {
  index: number;
  kind: string;
  affected_rows: number;
  status: "applied" | "rolled_back" | "conflict" | "failed";
  error: DbErrorInfo | null;
}

export interface MutationResult {
  state: "committed" | "rolled_back" | "outcome_unknown";
  outcomes: MutationRowOutcome[];
  committed_rows: number;
  elapsed_ms: number;
  transactional: boolean;
  warning: string | null;
  verify_hint: string | null;
}

export interface ExportTableTarget {
  database: string;
  table: string;
}

export interface ExportRequest {
  profile_id: string;
  sql: string;
  database: string | null;
  target_path: string;
  pagination?: "auto" | "keyset" | "offset" | null;
  page_size?: number | null;
  sorts?: BrowseSort[] | null;
  filters?: BrowseFilter[] | null;
  table: ExportTableTarget | null;
  bom?: boolean | null;
  max_rows?: number | null;
}

export interface ExportStarted {
  export_id: string;
}

export interface ExportProgress {
  export_id: string;
  rows: number;
  bytes: number;
  state: "running" | "cancelling" | "completed" | "cancelled" | "failed";
  message: string | null;
  elapsed_ms: number;
}

export interface ExportOutcome {
  export_id: string;
  state: string;
  path: string | null;
  rows: number;
  bytes: number;
  error: DbErrorInfo | null;
  elapsed_ms: number;
}

export interface TlsStatus {
  active: boolean;
  cipher: string | null;
  version: string | null;
}

export interface ConnectionTestResult {
  ok: boolean;
  stage: string;
  error: DbErrorInfo | null;
  latency_ms: number;
  server_version: string | null;
  connection_id: number | null;
  tls: TlsStatus | null;
  tunnel_local_port: number | null;
  read_only: boolean;
}

export interface ProfileRuntimeStatus {
  profile_id: string;
  generation: number;
  connected: boolean;
  tunnel_active: boolean;
  tunnel_local_port: number | null;
  open_sessions: number;
  active_queries: number;
  server_version: string | null;
}

export interface MetadataCacheStatus {
  profile_id: string;
  entries: number;
  last_invalidated_at: number | null;
}

export interface QueryHistoryEntry {
  id: string;
  profile_id: string;
  session_id: string | null;
  sql: string;
  succeeded: boolean;
  rows: number;
  elapsed_ms: number;
  error: string | null;
  created_at: number;
}

export interface HistoryWrite {
  profile_id: string;
  session_id: string | null;
  sql: string;
  succeeded: boolean;
  rows: number;
  elapsed_ms: number;
  error: string | null;
}
