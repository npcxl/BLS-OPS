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
 * 支持的数据库引擎。当前 `mysql` 与 `redis` 有真实适配器；其余值出现在
 * 连接表单里是为了让"支持边界"可见，UI 会禁用并标注"尚未实现"——不能在
 * 还没有驱动/类型/取消实现时假装可选。
 */
export type DbEngine =
  | "mysql"
  | "mariadb"
  | "postgres"
  | "sqlite"
  | "sqlserver"
  | "oracle"
  /** Redis：键值引擎，走独立的 db_redis_* 命令族与键浏览器视图。 */
  | "redis";

/** Redis 连接模式。cluster 只有 db 0；sentinel/cluster 直连（不走 SSH 隧道）。 */
export type RedisMode = "standalone" | "sentinel" | "cluster";

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
  /** Redis 专用：连接模式；MySQL 为 null。 */
  redis_mode: RedisMode | null;
  /** Redis sentinel 模式的 master 名。 */
  sentinel_master: string | null;
  /** Redis sentinel/cluster 附加节点，JSON 字符串数组。 */
  nodes_json: string | null;
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

export interface ColumnEdit {
  original_name: string | null;
  name: string;
  column_type: string;
  nullable: boolean;
  auto_increment: boolean;
  default_value: string | null;
  comment: string;
}

export interface IndexEdit {
  original_name: string | null;
  name: string;
  columns: string[];
  unique: boolean;
}

export interface AlterTableRequest {
  database: string;
  table: string;
  /** 数组顺序就是目标字段顺序（上移/下移直接改数组）。 */
  columns: ColumnEdit[];
  indexes: IndexEdit[];
  /** 目标主键（按顺序、用新字段名）；留空表示不要主键。 */
  primary_key: string[];
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

// ---------------------------------------------------------------------------
// Redis 引擎（db_redis_* 命令族）
// ---------------------------------------------------------------------------

/** 键列表里的一行。ttl_ms：-1 = 永久，-2 = 不存在。 */
export interface RedisKeyBrief {
  key: string;
  kind: string;
  ttl_ms: number;
}

/** SCAN 的一页；cursor 为 0 表示已扫完。 */
export interface RedisScanPage {
  cursor: number;
  keys: RedisKeyBrief[];
  dbsize: number;
}

/** 键元信息。memory_bytes：None = 服务器不支持或键已不存在。 */
export interface RedisKeyInfo {
  key: string;
  kind: string;
  ttl_ms: number;
  memory_bytes: number | null;
}

export interface RedisFieldEntry {
  field: string;
  /** 二进制值以 `b64:` 前缀 + Base64 编码传输（数据无损）。 */
  value: string;
}

/** HSCAN 的一页；cursor 为 0 表示已取完。 */
export interface RedisHashPage {
  cursor: number;
  fields: RedisFieldEntry[];
  length: number;
}

export interface RedisZEntry {
  member: string;
  score: number;
}

export interface RedisStreamEntry {
  id: string;
  fields: RedisFieldEntry[];
}

/** 键值的类型化载荷：UI 按 kind 分支渲染与编辑。 */
export type RedisValuePayload =
  | { kind: "string"; value: string; binary: boolean }
  | { kind: "hash"; fields: RedisFieldEntry[]; length: number; cursor: number }
  | { kind: "list"; items: string[]; length: number; truncated: boolean }
  | { kind: "set"; members: string[]; length: number; truncated: boolean }
  | { kind: "zset"; entries: RedisZEntry[]; length: number; truncated: boolean }
  | { kind: "stream"; entries: RedisStreamEntry[]; length: number }
  | { kind: "other"; type_name: string };

/** list 写操作形态（与 Rust ListWrite 对应）。 */
export type RedisListWrite =
  | { push: { front: boolean; value: string } }
  | { set: { index: number; value: string } }
  | { remove: { value: string } };

/** 订阅事件（经 Tauri Channel 推送）。 */
export interface RedisPubSubEvent {
  event: "subscribed" | "message" | "error" | "closed" | "unsubscribed";
  subId: string;
  profileId?: string;
  channel?: string;
  /** 系统类事件的文本（错误/关闭原因）。 */
  message?: string;
  /** 消息事件的字节负载：统一 Base64 编码（二进制无损），前端解码显示。 */
  messageBase64?: string;
}
