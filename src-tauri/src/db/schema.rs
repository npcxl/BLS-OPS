//! Database handle, schema and migrations.
//!
//! Migrations are keyed off SQLite's `PRAGMA user_version` and every step is
//! idempotent, so an app start is safe to run them on any database, twice.

use anyhow::Result;
use rusqlite::Connection;
use std::path::{Path, PathBuf};

/// How the SQLite file is opened and upgraded.
#[derive(Debug, Clone)]
pub struct AppDb {
    path: PathBuf,
}

impl AppDb {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn open(&self) -> Result<Connection> {
        let conn = Connection::open(&self.path)?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(conn)
    }

    pub fn init(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = self.open()?;
        conn.execute_batch(SCHEMA_SQL)?;
        migrate(&conn)?;
        Ok(())
    }

    pub fn now() -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
}

/// Current schema version. Bump it whenever `migrate()` gains a new step so an
/// already-created database is upgraded in place instead of silently drifting.
pub const SCHEMA_VERSION: u32 = 13;

/// Project and deployment tables (P3-2.2, P3-2.3).
///
/// A macro rather than a plain constant so the same literal can be spliced
/// into `SCHEMA_SQL` (fresh databases) and re-run by `migrate()` (existing
/// ones): both paths must produce exactly the same shape.
macro_rules! p3_schema_sql {
    () => {
        r#"
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    server_id TEXT NOT NULL,
    repo_url TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL DEFAULT 'main',
    deploy_path TEXT NOT NULL,
    commands TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'idle',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    project_name TEXT NOT NULL,
    server_id TEXT NOT NULL,
    server_name TEXT NOT NULL,
    status TEXT NOT NULL,
    trigger_source TEXT NOT NULL DEFAULT 'manual',
    branch TEXT NOT NULL DEFAULT '',
    commit_sha TEXT NOT NULL DEFAULT '',
    started_at INTEGER,
    finished_at INTEGER,
    duration_ms INTEGER,
    log TEXT NOT NULL DEFAULT '',
    error_message TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deployments_project
    ON deployments (project_id, created_at DESC);
"#
    };
}

/// The P3 tables on their own, for `migrate()`.
pub const P3_SCHEMA_SQL: &str = p3_schema_sql!();

/// 人工复核结论表（P3 用户流程收敛）：用户的"确认项目 / 忽略目录"必须跨扫描
/// 保留，否则每次重扫都要重新处理一遍不确定项。
///
/// 一个 (server_id, path) 只有一条记录，重复复核用 UPSERT 覆盖。
macro_rules! project_reviews_schema_sql {
    () => {
        r#"
CREATE TABLE IF NOT EXISTS project_reviews (
    server_id TEXT NOT NULL,
    path TEXT NOT NULL,
    review TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    project_type TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, path)
);

CREATE INDEX IF NOT EXISTS idx_project_reviews_server
    ON project_reviews (server_id, review);
"#
    };
}

/// The review table on its own, for `migrate()`.
pub const PROJECT_REVIEWS_SCHEMA_SQL: &str = project_reviews_schema_sql!();

/// 项目扫描快照缓存：每台服务器保留最近一次成功扫描的结果（候选 + 实例 + 能力），
/// 让前端打开"服务器项目"时立即展示，后台再增量复核。整段以 JSON 存储。
macro_rules! project_inventory_schema_sql {
    () => {
        r#"
CREATE TABLE IF NOT EXISTS project_inventory (
    server_id TEXT PRIMARY KEY NOT NULL,
    payload TEXT NOT NULL,
    completed_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
"#
    };
}

/// The inventory cache table on its own, for `migrate()`.
pub const PROJECT_INVENTORY_SCHEMA_SQL: &str = project_inventory_schema_sql!();

/// 已确认项目资产表（修复"已确认项目消失"的核心）。
///
/// 与 `project_reviews`（只存确认/忽略结论）不同，这里**保存完整候选项目快照**，
/// 即使后续扫描没有再次发现该路径，项目也必须继续存在，直到用户主动取消确认
/// 或软删除。`canonical_path` 是统一规范化后的路径，review / candidate /
/// inventory 全部使用它，避免 `/opt/app` 与 `/opt/app/` 被当成两个项目。
///
/// `scan_state` 记录最近一次扫描对该项目的态度：active（本次发现）/ missing
/// （本次未发现，保留快照）/ inaccessible（服务器暂不可访问）/ changed（分类或
/// 关键信息有变化，待复核）。`missing_since` 记录首次未发现的时间。
macro_rules! confirmed_projects_schema_sql {
    () => {
        r#"
CREATE TABLE IF NOT EXISTS confirmed_projects (
    id TEXT PRIMARY KEY NOT NULL,
    server_id TEXT NOT NULL,
    canonical_path TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    project_type TEXT NOT NULL DEFAULT '',
    candidate_payload TEXT NOT NULL,
    scan_state TEXT NOT NULL DEFAULT 'active',
    confirmed_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    missing_since INTEGER,
    deleted_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_confirmed_projects_server_path
    ON confirmed_projects (server_id, canonical_path);

CREATE INDEX IF NOT EXISTS idx_confirmed_projects_server
    ON confirmed_projects (server_id, deleted_at);
"#
    };
}

/// The confirmed-projects table on its own, for `migrate()`.
pub const CONFIRMED_PROJECTS_SCHEMA_SQL: &str = confirmed_projects_schema_sql!();

/// 人工合并/拆分项目关系表（P3 合同：多模块仓库默认合并 + 用户手动合并/拆分）。
///
/// 每行表示"child_path 被用户**手动并入** parent_path"。唯一键
/// `(server_id, child_path)`：一个子目录只能并入一个父项目；拆分 = 删除行。
/// 后续扫描用该表回填候选的 `merged_into` 标注 —— 人工决定持久化，
/// 重扫不覆盖。路径全部为 canonical 形式。
macro_rules! project_merges_schema_sql {
    () => {
        r#"
CREATE TABLE IF NOT EXISTS project_merges (
    id TEXT PRIMARY KEY NOT NULL,
    server_id TEXT NOT NULL,
    child_path TEXT NOT NULL,
    parent_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_merges_server_child
    ON project_merges (server_id, child_path);

CREATE INDEX IF NOT EXISTS idx_project_merges_server
    ON project_merges (server_id, parent_path);
"#
    };
}

/// The project-merges table on its own, for `migrate()`.
pub const PROJECT_MERGES_SCHEMA_SQL: &str = project_merges_schema_sql!();

/// P5.0 智能部署中心（v9）：应用 / 环境 / 服务 / 关系 / 容量 / 域名 / 配置 /
/// 密钥引用 / 制品 / 方案图 / 运行 / 版本。
///
/// 三条刻意的取舍：
///
/// * **`runtime_json` 存的是类型化枚举**（`ServiceRuntime`），不是命令字符串；
///   模型里没有任何字段能装下一条自由命令（见 `deployment::validate`）。
/// * **`secret_refs` 没有 value 列**：密钥只会出现在 OS Keyring 或部署期的
///   运行时临时文件里，库里只有引用。
/// * **不引用 `projects` / `deployments`**（P3 那套 `commands_json`）：新模型与
///   旧记录完全解耦，旧表原样保留（legacy）。唯一关联是
///   `service_units.confirmed_project_id` → P3.8 的已确认项目。
///
/// `server_id` 刻意**不加外键**：P3 的 `server_delete` 级联目前只清
/// sessions/history，加了 FK 会让删除服务器直接失败。删除服务器后残留的部署记录
/// 由后续阶段一起并入服务器级联（见 P5.0 报告的"已知缺口"）。
macro_rules! deployment_center_schema_sql {
    () => {
        r#"
CREATE TABLE IF NOT EXISTS deployment_applications (
    id TEXT PRIMARY KEY NOT NULL,
    server_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    application_kind TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_ref TEXT NOT NULL DEFAULT '',
    default_branch TEXT NOT NULL DEFAULT '',
    confirmed_project_path TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deployment_applications_server_name
    ON deployment_applications (server_id, name);

CREATE TABLE IF NOT EXISTS deployment_environments (
    id TEXT PRIMARY KEY NOT NULL,
    application_id TEXT NOT NULL,
    server_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    deploy_root TEXT NOT NULL,
    capacity_profile_id TEXT,
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (application_id) REFERENCES deployment_applications (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deployment_environments_app_name
    ON deployment_environments (application_id, name);

CREATE TABLE IF NOT EXISTS service_units (
    id TEXT PRIMARY KEY NOT NULL,
    application_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    service_kind TEXT NOT NULL,
    runtime_json TEXT NOT NULL,
    deploy_path TEXT,
    confirmed_project_id TEXT,
    confirmed_project_path TEXT,
    artifact_id TEXT,
    status TEXT NOT NULL DEFAULT 'incomplete',
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (application_id) REFERENCES deployment_applications (id) ON DELETE CASCADE,
    FOREIGN KEY (environment_id) REFERENCES deployment_environments (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_service_units_env_name
    ON service_units (environment_id, name);

CREATE INDEX IF NOT EXISTS idx_service_units_application
    ON service_units (application_id);

CREATE INDEX IF NOT EXISTS idx_service_units_confirmed_project
    ON service_units (confirmed_project_id);

CREATE TABLE IF NOT EXISTS service_relations (
    id TEXT PRIMARY KEY NOT NULL,
    application_id TEXT NOT NULL,
    from_service_id TEXT NOT NULL,
    to_service_id TEXT NOT NULL,
    relation_kind TEXT NOT NULL,
    required INTEGER NOT NULL DEFAULT 1,
    failure_policy TEXT NOT NULL DEFAULT 'block',
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (application_id) REFERENCES deployment_applications (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_service_relations_triple
    ON service_relations (from_service_id, to_service_id, relation_kind);

CREATE INDEX IF NOT EXISTS idx_service_relations_application
    ON service_relations (application_id);

CREATE TABLE IF NOT EXISTS capacity_profiles (
    id TEXT PRIMARY KEY NOT NULL,
    environment_id TEXT NOT NULL,
    expected_dau INTEGER,
    concurrent_users INTEGER,
    peak_qps REAL,
    avg_qps REAL,
    websocket_connections INTEGER,
    response_target_ms INTEGER,
    monthly_bandwidth_gb REAL,
    monthly_upload_gb REAL,
    monthly_data_growth_gb REAL,
    availability_target TEXT,
    rpo_minutes INTEGER,
    rto_minutes INTEGER,
    monthly_budget REAL,
    budget_currency TEXT,
    estimation_basis TEXT NOT NULL DEFAULT 'unknown',
    assumptions TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (environment_id) REFERENCES deployment_environments (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_capacity_profiles_environment
    ON capacity_profiles (environment_id);

CREATE TABLE IF NOT EXISTS domain_bindings (
    id TEXT PRIMARY KEY NOT NULL,
    environment_id TEXT NOT NULL,
    service_unit_id TEXT,
    domain TEXT NOT NULL,
    listen_port INTEGER NOT NULL,
    path_prefix TEXT NOT NULL DEFAULT '/',
    dns_credential_ref TEXT,
    dns_status TEXT NOT NULL DEFAULT 'unknown',
    dns_checked_at INTEGER,
    ssl_mode TEXT NOT NULL DEFAULT 'none',
    ssl_status TEXT NOT NULL DEFAULT 'not_applicable',
    ssl_expires_at INTEGER,
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (environment_id) REFERENCES deployment_environments (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_bindings_target
    ON domain_bindings (environment_id, domain, listen_port, path_prefix);

CREATE INDEX IF NOT EXISTS idx_domain_bindings_service
    ON domain_bindings (service_unit_id);

CREATE TABLE IF NOT EXISTS config_definitions (
    id TEXT PRIMARY KEY NOT NULL,
    application_id TEXT NOT NULL,
    service_unit_id TEXT,
    key TEXT NOT NULL,
    data_type TEXT NOT NULL,
    required INTEGER NOT NULL DEFAULT 0,
    secret INTEGER NOT NULL DEFAULT 0,
    scope TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_ref TEXT,
    default_value TEXT,
    description TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (application_id) REFERENCES deployment_applications (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_config_definitions_key
    ON config_definitions (application_id, key, COALESCE(service_unit_id, ''));

CREATE TABLE IF NOT EXISTS secret_refs (
    id TEXT PRIMARY KEY NOT NULL,
    application_id TEXT,
    name TEXT NOT NULL,
    store_kind TEXT NOT NULL,
    keyring_service TEXT,
    keyring_account TEXT,
    runtime_path TEXT,
    description TEXT NOT NULL DEFAULT '',
    last_used_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_secret_refs_name
    ON secret_refs (COALESCE(application_id, ''), name);

CREATE TABLE IF NOT EXISTS artifact_records (
    id TEXT PRIMARY KEY NOT NULL,
    application_id TEXT NOT NULL,
    service_unit_id TEXT,
    kind TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_ref TEXT NOT NULL DEFAULT '',
    file_name TEXT,
    size_bytes INTEGER,
    sha256 TEXT,
    docker_digest TEXT,
    version_label TEXT,
    built_at INTEGER,
    checksum_verified INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (application_id) REFERENCES deployment_applications (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_artifact_records_application
    ON artifact_records (application_id, created_at);

CREATE TABLE IF NOT EXISTS deployment_plans (
    id TEXT PRIMARY KEY NOT NULL,
    application_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    name TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'draft',
    proposal_source TEXT NOT NULL DEFAULT 'manual',
    risk_level TEXT NOT NULL DEFAULT 'low',
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (application_id) REFERENCES deployment_applications (id) ON DELETE CASCADE,
    FOREIGN KEY (environment_id) REFERENCES deployment_environments (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deployment_plans_env_name
    ON deployment_plans (environment_id, name);

CREATE TABLE IF NOT EXISTS plan_nodes (
    id TEXT PRIMARY KEY NOT NULL,
    plan_id TEXT NOT NULL,
    node_key TEXT NOT NULL,
    title TEXT NOT NULL,
    action TEXT NOT NULL,
    service_unit_id TEXT,
    risk_level TEXT NOT NULL,
    approval_required INTEGER NOT NULL DEFAULT 0,
    skippable INTEGER NOT NULL DEFAULT 1,
    params_json TEXT NOT NULL DEFAULT '{}',
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (plan_id) REFERENCES deployment_plans (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_nodes_key
    ON plan_nodes (plan_id, node_key);

CREATE TABLE IF NOT EXISTS plan_edges (
    id TEXT PRIMARY KEY NOT NULL,
    plan_id TEXT NOT NULL,
    from_node_id TEXT NOT NULL,
    to_node_id TEXT NOT NULL,
    condition TEXT NOT NULL DEFAULT 'always',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (plan_id) REFERENCES deployment_plans (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_edges_pair
    ON plan_edges (plan_id, from_node_id, to_node_id);

CREATE TABLE IF NOT EXISTS deployment_runs (
    id TEXT PRIMARY KEY NOT NULL,
    plan_id TEXT NOT NULL,
    application_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    server_id TEXT NOT NULL,
    server_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    trigger_source TEXT NOT NULL DEFAULT 'manual',
    plan_version INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    duration_ms INTEGER,
    log TEXT NOT NULL DEFAULT '',
    error_message TEXT,
    snapshot_json TEXT,
    release_id TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deployment_runs_application
    ON deployment_runs (application_id, created_at);

CREATE INDEX IF NOT EXISTS idx_deployment_runs_plan
    ON deployment_runs (plan_id, created_at);

CREATE TABLE IF NOT EXISTS run_nodes (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL,
    node_id TEXT,
    node_key TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    started_at INTEGER,
    finished_at INTEGER,
    duration_ms INTEGER,
    exit_code INTEGER,
    output TEXT NOT NULL DEFAULT '',
    error_message TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (run_id) REFERENCES deployment_runs (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_run_nodes_run
    ON run_nodes (run_id, created_at);

CREATE TABLE IF NOT EXISTS release_records (
    id TEXT PRIMARY KEY NOT NULL,
    application_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    service_unit_id TEXT,
    run_id TEXT,
    version_label TEXT NOT NULL,
    artifact_id TEXT,
    is_active INTEGER NOT NULL DEFAULT 0,
    activated_at INTEGER,
    replaced_release_id TEXT,
    nginx_backup_path TEXT,
    image_digest TEXT,
    config_snapshot_json TEXT,
    status TEXT NOT NULL DEFAULT 'superseded',
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (application_id) REFERENCES deployment_applications (id) ON DELETE CASCADE,
    FOREIGN KEY (environment_id) REFERENCES deployment_environments (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_release_records_environment
    ON release_records (environment_id, created_at);

-- 一个服务在任一时刻只能有一个生效版本（部分唯一索引）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_release_records_active
    ON release_records (service_unit_id)
    WHERE is_active = 1 AND service_unit_id IS NOT NULL;
"#
    };
}

/// The P5.0 deployment-centre tables on their own, for `migrate()`.
pub const DEPLOYMENT_CENTER_SCHEMA_SQL: &str = deployment_center_schema_sql!();

/// P5.1 制品导入任务（v10）：**只保存最终态**。
///
/// 中间进度没有持久化价值（应用重启后任务本来就作废），所以这里存的是
/// 任务的对象快照：来源、指纹、安全报告、识别结果整段 JSON。
/// 这样"确认导入"在重启之后依然可做 —— 用户看到的东西和库里的一致。
macro_rules! deployment_import_schema_sql {
    () => {
        r#"
CREATE TABLE IF NOT EXISTS artifact_import_tasks (
    id TEXT PRIMARY KEY NOT NULL,
    application_id TEXT,
    service_unit_id TEXT,
    source_json TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    progress_json TEXT NOT NULL DEFAULT '{}',
    fingerprint_json TEXT,
    security_json TEXT,
    inspection_json TEXT,
    error TEXT,
    attempt INTEGER NOT NULL DEFAULT 1,
    artifact_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_artifact_import_tasks_application
    ON artifact_import_tasks (application_id, created_at DESC);
"#
    };
}

/// The P5.1 artifact-import tables on their own, for `migrate()`.
pub const DEPLOYMENT_IMPORT_SCHEMA_SQL: &str = deployment_import_schema_sql!();

/// P5.2 部署方案与安全策略（v11）。
///
/// 方案整份存 JSON（**不可变的审计快照**），指纹关键字段另存列以便按哈希检索；
/// 安全策略同样存 JSON —— 它是策略不是数据，字段会随引擎演进。
macro_rules! deployment_proposal_schema_sql {
    () => {
        r#"
CREATE TABLE IF NOT EXISTS deployment_proposals (
    id TEXT PRIMARY KEY NOT NULL,
    application_id TEXT NOT NULL,
    environment_id TEXT,
    server_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    ready INTEGER NOT NULL DEFAULT 0,
    approvable INTEGER NOT NULL DEFAULT 0,
    input_hash TEXT NOT NULL,
    output_hash TEXT NOT NULL,
    model TEXT,
    prompt_version TEXT NOT NULL DEFAULT '',
    knowledge_version TEXT NOT NULL DEFAULT '',
    engine_version TEXT NOT NULL DEFAULT '',
    proposal_json TEXT NOT NULL,
    plan_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deployment_proposals_application
    ON deployment_proposals (application_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_deployment_proposals_input_hash
    ON deployment_proposals (input_hash);

CREATE TABLE IF NOT EXISTS deployment_security_policies (
    application_id TEXT PRIMARY KEY NOT NULL,
    policy_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
"#
    };
}

/// The P5.2 proposal tables on their own, for `migrate()`.
pub const DEPLOYMENT_PROPOSAL_SCHEMA_SQL: &str = deployment_proposal_schema_sql!();

/// P5.5 AI 提供方、复核任务与用户知识库（v13）。
///
/// 三条纪律：
/// * `ai_providers` **只有 `api_key_ref`**（钥匙串账户名），没有任何能装明文密钥的列；
/// * `ai_review_tasks` 只存状态 / 耗时 / 次数 / 脱敏错误，**不存提示词与答复原文**；
/// * 知识库分两张表：当前版本（`knowledge_documents`）+ 历史版本
///   （`knowledge_document_versions`，只追加不覆盖），删除走归档而不是物理删除，
///   因此"历史方案引用了哪一版"永远查得到。
macro_rules! deployment_ai_schema_sql {
    () => {
        r#"
CREATE TABLE IF NOT EXISTS ai_providers (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    provider_kind TEXT NOT NULL,
    base_url TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    api_key_ref TEXT,
    enabled INTEGER NOT NULL DEFAULT 0,
    is_default INTEGER NOT NULL DEFAULT 0,
    allow_insecure_http INTEGER NOT NULL DEFAULT 0,
    timeout_seconds INTEGER NOT NULL DEFAULT 30,
    max_output_tokens INTEGER NOT NULL DEFAULT 1200,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_providers_default
    ON ai_providers (enabled, is_default);

CREATE TABLE IF NOT EXISTS ai_review_tasks (
    id TEXT PRIMARY KEY NOT NULL,
    proposal_id TEXT NOT NULL,
    provider_id TEXT,
    model TEXT,
    status TEXT NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    duration_ms INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_review_tasks_proposal
    ON ai_review_tasks (proposal_id, created_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_documents (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    scope TEXT NOT NULL,
    application_id TEXT,
    environment_id TEXT,
    category TEXT NOT NULL,
    tags_json TEXT NOT NULL DEFAULT '[]',
    source_type TEXT NOT NULL,
    source_name TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 0,
    last_verified_at INTEGER,
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_knowledge_documents_scope
    ON knowledge_documents (scope, status, enabled);

CREATE TABLE IF NOT EXISTS knowledge_document_versions (
    id TEXT PRIMARY KEY NOT NULL,
    document_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source_type TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE (document_id, version)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_versions_document
    ON knowledge_document_versions (document_id, version);

CREATE TABLE IF NOT EXISTS knowledge_usage_records (
    id TEXT PRIMARY KEY NOT NULL,
    document_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    proposal_id TEXT NOT NULL,
    used_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (document_id, version, proposal_id, used_by)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_usage_document
    ON knowledge_usage_records (document_id, created_at DESC);
"#
    };
}

/// The P5.5 AI / knowledge tables on their own, for `migrate()`.
pub const DEPLOYMENT_AI_SCHEMA_SQL: &str = deployment_ai_schema_sql!();

pub(crate) const SCHEMA_SQL: &str = concat!(
    r#"
CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    username TEXT NOT NULL,
    credential_id TEXT,
    group_id TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    proxy_jump_id TEXT,
    favorite INTEGER NOT NULL DEFAULT 0,
    last_connected_at INTEGER,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS server_groups (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    username TEXT NOT NULL,
    secret_ref TEXT,
    passphrase_ref TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS known_hosts (
                id TEXT PRIMARY KEY NOT NULL,
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                fingerprint TEXT NOT NULL,
                fingerprint_type TEXT NOT NULL,
                status TEXT NOT NULL,
                first_seen_at INTEGER NOT NULL,
                last_seen_at INTEGER NOT NULL,
                UNIQUE(host, port)
            );

            CREATE TABLE IF NOT EXISTS ssh_sessions (
                id TEXT PRIMARY KEY NOT NULL,
                server_id TEXT NOT NULL,
                server_name TEXT NOT NULL,
                server_host TEXT NOT NULL,
                server_port INTEGER NOT NULL,
                username TEXT NOT NULL,
                status TEXT NOT NULL,
                connected_at INTEGER,
                disconnected_at INTEGER,
                error_message TEXT,
                keep_alive_interval INTEGER NOT NULL,
                reconnect_policy TEXT NOT NULL,
                terminal_rows INTEGER,
                terminal_cols INTEGER,
                terminal_pty INTEGER,
                sftp_enabled INTEGER NOT NULL,
                port_forwards TEXT NOT NULL DEFAULT '[]'
            );

            CREATE TABLE IF NOT EXISTS command_history (
                id TEXT PRIMARY KEY NOT NULL,
                session_id TEXT NOT NULL,
                server_id TEXT NOT NULL,
                server_name TEXT NOT NULL,
                command TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                exit_code INTEGER,
                source TEXT NOT NULL,
                output TEXT
            );

            CREATE TABLE IF NOT EXISTS audit_logs (
                id TEXT PRIMARY KEY NOT NULL,
                action TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                user_id TEXT,
                server_id TEXT,
                server_name TEXT,
                project_id TEXT,
                project_name TEXT,
                details TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT
);
"#,
    p3_schema_sql!(),
    project_reviews_schema_sql!(),
    project_inventory_schema_sql!(),
    confirmed_projects_schema_sql!(),
    project_merges_schema_sql!(),
    deployment_center_schema_sql!(),
    deployment_import_schema_sql!(),
    deployment_proposal_schema_sql!(),
    deployment_ai_schema_sql!()
);

pub(crate) fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(columns.iter().any(|existing| existing == column))
}

fn add_column(conn: &Connection, table: &str, column: &str, definition: &str) -> Result<()> {
    if column_exists(conn, table, column)? {
        return Ok(());
    }
    conn.execute(
        &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
        [],
    )?;
    Ok(())
}

/// Idempotent, ordered schema upgrades. Every step must be safe to run twice.
pub fn migrate(conn: &Connection) -> Result<()> {
    let version: u32 = conn
        .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
        .unwrap_or(0);

    if version < 1 {
        // v1 == the original `CREATE TABLE IF NOT EXISTS` baseline.
        conn.pragma_update(None, "user_version", 1u32)?;
    }
    if version < 2 {
        add_column(conn, "servers", "favorite", "INTEGER NOT NULL DEFAULT 0")?;
        add_column(conn, "servers", "last_connected_at", "INTEGER")?;
        add_column(conn, "credentials", "passphrase_ref", "TEXT")?;
        conn.pragma_update(None, "user_version", 2u32)?;
    }
    if version < 3 {
        // Projects and deployments are additive, so the same
        // `CREATE TABLE IF NOT EXISTS` block used for new databases works
        // here: an upgraded database ends up byte-identical in shape.
        conn.execute_batch(P3_SCHEMA_SQL)?;
        conn.pragma_update(None, "user_version", 3u32)?;
    }
    if version < 4 {
        // Project review decisions (确认项目 / 忽略目录) must survive a rescan.
        conn.execute_batch(PROJECT_REVIEWS_SCHEMA_SQL)?;
        conn.pragma_update(None, "user_version", 4u32)?;
    }
    if version < 5 {
        // 上一次扫描的快照缓存：用户再次打开"服务器项目"时立即展示，不必等
        // 后台重新扫描完成。每台服务器至多保留一份（整段 JSON）。
        conn.execute_batch(PROJECT_INVENTORY_SCHEMA_SQL)?;
        conn.pragma_update(None, "user_version", 5u32)?;
    }
    if version < 6 {
        // 已确认项目资产表：保存完整候选项目快照，即使后续扫描没再发现该路径
        // 也必须继续存在（修复"已确认项目消失"）。唯一键 (server_id, canonical_path)。
        conn.execute_batch(CONFIRMED_PROJECTS_SCHEMA_SQL)?;
        conn.pragma_update(None, "user_version", 6u32)?;
    }
    if version < 7 {
        // P4 命令中心：收藏与使用记录（知识条目本体是编译期常量，不进库）。
        conn.execute_batch(super::command_center::COMMAND_CENTER_SCHEMA_SQL)?;
        conn.pragma_update(None, "user_version", 7u32)?;
    }
    if version < 8 {
        // 人工合并/拆分项目关系：用户手动把多个目录并成一个项目，或拆分回去。
        // 结论持久化，后续扫描回填 merged_into 标注，绝不覆盖人工决定。
        conn.execute_batch(PROJECT_MERGES_SCHEMA_SQL)?;
        conn.pragma_update(None, "user_version", 8u32)?;
    }
    if version < 9 {
        // P5.0 部署中心：应用 / 环境 / 服务 / 关系 / 容量 / 域名 / 配置 / 密钥引用 /
        // 制品 / 方案图 / 运行 / 版本。纯新增，不触碰旧表（老库升级后形状与
        // 新库完全一致）。
        conn.execute_batch(DEPLOYMENT_CENTER_SCHEMA_SQL)?;
        conn.pragma_update(None, "user_version", 9u32)?;
    }
    if version < 10 {
        // P5.1 制品导入任务：纯新增一张表，不触碰 P5.0 的任何表。
        // 旧库升级后形状与新库完全一致（同一段 `CREATE TABLE IF NOT EXISTS`）。
        conn.execute_batch(DEPLOYMENT_IMPORT_SCHEMA_SQL)?;
        conn.pragma_update(None, "user_version", 10u32)?;
    }
    if version < 11 {
        // P5.2 部署方案与安全策略：同样纯新增，不触碰任何旧表。
        conn.execute_batch(DEPLOYMENT_PROPOSAL_SCHEMA_SQL)?;
        // 容量问卷补一个"响应时间目标"：填了它，容量估算就能用真实值，
        // 而不是"平均响应 0.5 秒"这条假设。老库升级时列不存在，补上即可。
        add_column(&conn, "capacity_profiles", "response_target_ms", "INTEGER")?;
        conn.pragma_update(None, "user_version", 11u32)?;
    }
    if version < 12 {
        // P5.3：运行节点要记录**类型化动作标识与风险级别**，否则重启之后历史
        // 运行只剩一句标题，无法复核"当时执行的是哪个动作、有多危险"。
        // 纯新增列（旧行取默认值），不触碰任何既有数据。
        add_column(&conn, "run_nodes", "action", "TEXT NOT NULL DEFAULT ''")?;
        add_column(
            &conn,
            "run_nodes",
            "risk_level",
            "TEXT NOT NULL DEFAULT 'low'",
        )?;
        conn.pragma_update(None, "user_version", 12u32)?;
    }
    if version < 13 {
        // P5.5：纯新增表（AI 提供方 / 复核任务 / 用户知识库），
        // 不触碰任何既有表 —— 没配置 AI 时老功能一行代码都不用改。
        conn.execute_batch(DEPLOYMENT_AI_SCHEMA_SQL)?;
        conn.pragma_update(None, "user_version", 13u32)?;
    }
    Ok(())
}
