//! 整机配置备份与恢复（服务器 / 分组 / 凭据元数据 / 指纹 / 项目 / 设置）。
//!
//! 三条边界：
//!
//! 1. **绝不导出密钥。** `credentials` 只带 id / 名称 / 用户名 / 类型，
//!    `secret_ref` 一律清空 —— 私钥口令与密码在操作系统钥匙串里，换台机器本来
//!    就不该跟着走。导入后由 UI 提示"重新绑定凭据"。
//! 2. **导入是一个事务。** 中途失败整批回滚，数据库不会停在"导了一半"的
//!    状态 —— 这就是"恢复失败可以退回原状态"。
//! 3. **预览只读。** 先算新增 / 冲突，用户确认才写。
use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::db::{
    ConfirmedProjectRecord, CredentialRecord, KnownHostRecord, ProjectMergeRecord,
    ProjectReviewRecord, ServerGroupRecord, ServerRecord,
};

/// 备份文件标识（导入时据此拒绝无关的 JSON）。
pub const BACKUP_FORMAT: &str = "bls-ops-backup";
/// 备份格式版本。字段增删时 +1，导入端只接受 <= 当前版本。
pub const BACKUP_VERSION: u32 = 1;
/// 上限：再大的"配置备份"一定是文件选错了。
pub const MAX_BACKUP_BYTES: u64 = 32 * 1024 * 1024;
/// 迁移前自动备份保留份数。
const AUTO_BACKUP_KEEP: usize = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupFile {
    pub format: String,
    pub version: u32,
    pub app_version: String,
    pub exported_at: i64,
    #[serde(default)]
    pub servers: Vec<ServerRecord>,
    #[serde(default)]
    pub groups: Vec<ServerGroupRecord>,
    #[serde(default)]
    pub credentials: Vec<CredentialRecord>,
    #[serde(default)]
    pub known_hosts: Vec<KnownHostRecord>,
    #[serde(default)]
    pub projects: Vec<ConfirmedProjectRecord>,
    #[serde(default)]
    pub project_reviews: Vec<ProjectReviewRecord>,
    #[serde(default)]
    pub project_merges: Vec<ProjectMergeRecord>,
    /// 前端 localStorage 里的偏好（主题 / 语言 / 字体…），由 WebView 收集。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<Value>,
}

/// 导出结果：让 UI 能说清"导出了多少、写到哪"。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupSummary {
    pub path: String,
    pub bytes: u64,
    pub exported_at: i64,
    pub servers: usize,
    pub groups: usize,
    pub credentials: usize,
    pub known_hosts: usize,
    pub projects: usize,
    pub settings_included: bool,
}

/// 预览里的一个分区。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupSection {
    /// `servers` / `groups` / …（前端据此挑文案）。
    pub key: String,
    pub total: usize,
    /// 本地没有、导入后会新增。
    pub added: usize,
    /// 本地已存在、导入会覆盖（或按策略跳过）。
    pub conflicts: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupPreview {
    pub format: String,
    pub version: u32,
    pub app_version: String,
    pub exported_at: i64,
    pub sections: Vec<BackupSection>,
    /// 冲突项示例（`服务器: web-01`），最多 10 条，够用户判断是不是同一批机器。
    pub conflict_samples: Vec<String>,
    pub settings_included: bool,
    /// 需要如实告诉用户的事（凭据要重绑、版本偏高…）。
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupImportResult {
    pub added: usize,
    pub overwritten: usize,
    pub skipped: usize,
    /// 备份里带的偏好，由前端写入 localStorage。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<Value>,
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

pub fn collect(
    conn: &Connection,
    app_version: &str,
    settings: Option<Value>,
) -> Result<BackupFile> {
    let mut credentials = read_credentials(conn)?;
    // 元数据可以迁移，密钥不能：引用一并清空，导入后必须重新绑定。
    for credential in &mut credentials {
        credential.secret_ref = None;
        credential.passphrase_ref = None;
    }

    Ok(BackupFile {
        format: BACKUP_FORMAT.to_string(),
        version: BACKUP_VERSION,
        app_version: app_version.to_string(),
        exported_at: chrono::Utc::now().timestamp_millis(),
        servers: read_servers(conn)?,
        groups: read_groups(conn)?,
        credentials,
        known_hosts: read_known_hosts(conn)?,
        projects: read_projects(conn)?,
        project_reviews: read_project_reviews(conn)?,
        project_merges: read_project_merges(conn)?,
        settings,
    })
}

/// 写文件并返回字节数。先写临时文件再 `rename`：写到一半崩溃不会留下一个
/// 看起来完整、实际截断的备份。
pub fn write_file(path: &Path, backup: &BackupFile) -> Result<u64> {
    if path.as_os_str().is_empty() {
        return Err(anyhow!("备份路径不能为空"));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("无法创建目录 {}", parent.display()))?;
    }
    let json = serde_json::to_vec_pretty(backup)?;
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, &json).with_context(|| format!("无法写入 {}", temp.display()))?;
    std::fs::rename(&temp, path).with_context(|| format!("无法写入 {}", path.display()))?;
    Ok(json.len() as u64)
}

pub fn read_file(path: &Path) -> Result<BackupFile> {
    let meta = std::fs::metadata(path).with_context(|| format!("无法读取 {}", path.display()))?;
    if meta.len() > MAX_BACKUP_BYTES {
        return Err(anyhow!(
            "备份文件过大（{} MB），看起来不是本应用的配置文件",
            meta.len() / 1024 / 1024
        ));
    }
    let raw = std::fs::read(path).with_context(|| format!("无法读取 {}", path.display()))?;
    let backup: BackupFile =
        serde_json::from_slice(&raw).map_err(|error| anyhow!("备份文件不是合法 JSON：{error}"))?;
    if backup.format != BACKUP_FORMAT {
        return Err(anyhow!("不是本应用的备份文件"));
    }
    if backup.version > BACKUP_VERSION {
        return Err(anyhow!(
            "备份来自更新的版本（格式 v{}，当前只认到 v{}）",
            backup.version,
            BACKUP_VERSION
        ));
    }
    Ok(backup)
}

// ---------------------------------------------------------------------------
// 预览
// ---------------------------------------------------------------------------

pub fn preview(conn: &Connection, backup: &BackupFile) -> Result<BackupPreview> {
    let mut sections = Vec::new();
    let mut samples = Vec::new();
    let mut warnings = Vec::new();

    let mut section = |key: &str, total: usize, added: usize| {
        sections.push(BackupSection {
            key: key.to_string(),
            total,
            added,
            conflicts: total - added,
        });
    };

    section(
        "servers",
        backup.servers.len(),
        count_new(
            conn,
            "servers",
            backup.servers.iter().map(|item| item.id.as_str()),
            &mut samples,
            "server",
        )?,
    );
    section(
        "groups",
        backup.groups.len(),
        count_new(
            conn,
            "server_groups",
            backup.groups.iter().map(|item| item.id.as_str()),
            &mut samples,
            "group",
        )?,
    );
    section(
        "credentials",
        backup.credentials.len(),
        count_new(
            conn,
            "credentials",
            backup.credentials.iter().map(|item| item.id.as_str()),
            &mut samples,
            "credential",
        )?,
    );
    section(
        "known_hosts",
        backup.known_hosts.len(),
        count_new(
            conn,
            "known_hosts",
            backup.known_hosts.iter().map(|item| item.id.as_str()),
            &mut samples,
            "host",
        )?,
    );
    section(
        "projects",
        backup.projects.len(),
        count_new(
            conn,
            "confirmed_projects",
            backup.projects.iter().map(|item| item.id.as_str()),
            &mut samples,
            "project",
        )?,
    );

    // 复核结论是复合主键 (server_id, path)。
    let mut review_added = 0;
    for record in &backup.project_reviews {
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM project_reviews WHERE server_id = ?1 AND path = ?2",
                params![record.server_id, record.path],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_none() {
            review_added += 1;
        }
    }
    section(
        "project_reviews",
        backup.project_reviews.len(),
        review_added,
    );

    section(
        "project_merges",
        backup.project_merges.len(),
        count_new(
            conn,
            "project_merges",
            backup.project_merges.iter().map(|item| item.id.as_str()),
            &mut samples,
            "merge",
        )?,
    );

    if backup
        .credentials
        .iter()
        .any(|item| item.secret_ref.is_none())
    {
        warnings
            .push("Credentials are exported without secrets — rebind them after importing".into());
    }
    if backup.version < BACKUP_VERSION {
        warnings.push("This backup was written by an older format version".into());
    }

    Ok(BackupPreview {
        format: backup.format.clone(),
        version: backup.version,
        app_version: backup.app_version.clone(),
        exported_at: backup.exported_at,
        sections,
        conflict_samples: samples,
        settings_included: backup.settings.is_some(),
        warnings,
    })
}

fn count_new<'a>(
    conn: &Connection,
    table: &str,
    ids: impl Iterator<Item = &'a str>,
    samples: &mut Vec<String>,
    label: &str,
) -> Result<usize> {
    let mut added = 0;
    for id in ids {
        let exists: Option<i64> = conn
            .query_row(
                &format!("SELECT 1 FROM {table} WHERE id = ?1"),
                [id],
                |row| row.get(0),
            )
            .optional()?;
        if exists.is_some() {
            if samples.len() < 10 {
                samples.push(format!("{label}: {id}"));
            }
        } else {
            added += 1;
        }
    }
    Ok(added)
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

/// 在一个事务里合并备份。`overwrite = false` 时已存在的行原样保留（只导入新增）。
pub fn apply(
    conn: &mut Connection,
    backup: &BackupFile,
    overwrite: bool,
) -> Result<BackupImportResult> {
    let tx = conn.transaction()?;
    let mut added = 0usize;
    let mut overwritten = 0usize;
    let mut skipped = 0usize;

    for group in &backup.groups {
        let existed = row_exists(&tx, "server_groups", &group.id)?;
        let changed = if overwrite {
            tx.execute(
                "INSERT INTO server_groups (id, name, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                     name=excluded.name, sort_order=excluded.sort_order, updated_at=excluded.updated_at",
                params![group.id, group.name, group.sort_order, group.created_at, group.updated_at],
            )?
        } else {
            tx.execute(
                "INSERT OR IGNORE INTO server_groups (id, name, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    group.id,
                    group.name,
                    group.sort_order,
                    group.created_at,
                    group.updated_at
                ],
            )?
        };
        tally(changed, existed, &mut added, &mut overwritten, &mut skipped);
    }

    for credential in &backup.credentials {
        let existed = row_exists(&tx, "credentials", &credential.id)?;
        // secret_ref 恒为 NULL：备份里本来就没有密钥，目标机器上也不该凭空出现。
        let changed = if overwrite {
            tx.execute(
                "INSERT INTO credentials (id, name, type, username, secret_ref, passphrase_ref, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                     name=excluded.name, type=excluded.type, username=excluded.username,
                     created_at=excluded.created_at, updated_at=excluded.updated_at",
                params![
                    credential.id,
                    credential.name,
                    credential.credential_type,
                    credential.username,
                    credential.created_at,
                    credential.updated_at
                ],
            )?
        } else {
            tx.execute(
                "INSERT OR IGNORE INTO credentials (id, name, type, username, secret_ref, passphrase_ref, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5, ?6)",
                params![
                    credential.id,
                    credential.name,
                    credential.credential_type,
                    credential.username,
                    credential.created_at,
                    credential.updated_at
                ],
            )?
        };
        tally(changed, existed, &mut added, &mut overwritten, &mut skipped);
    }

    for server in &backup.servers {
        let existed = row_exists(&tx, "servers", &server.id)?;
        let tags = serde_json::to_string(&server.tags)?;
        let changed = if overwrite {
            tx.execute(
                "INSERT INTO servers (id, name, host, port, username, credential_id, group_id, tags,
                                      proxy_jump_id, favorite, last_connected_at, status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                 ON CONFLICT(id) DO UPDATE SET
                     name=excluded.name, host=excluded.host, port=excluded.port,
                     username=excluded.username, credential_id=excluded.credential_id,
                     group_id=excluded.group_id, tags=excluded.tags,
                     proxy_jump_id=excluded.proxy_jump_id, favorite=excluded.favorite,
                     status=excluded.status, updated_at=excluded.updated_at",
                params![
                    server.id,
                    server.name,
                    server.host,
                    server.port,
                    server.username,
                    server.credential_id,
                    server.group_id,
                    tags,
                    server.proxy_jump_id,
                    server.favorite,
                    server.last_connected_at,
                    server.status,
                    server.created_at,
                    server.updated_at
                ],
            )?
        } else {
            tx.execute(
                "INSERT OR IGNORE INTO servers (id, name, host, port, username, credential_id, group_id, tags,
                                                proxy_jump_id, favorite, last_connected_at, status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    server.id,
                    server.name,
                    server.host,
                    server.port,
                    server.username,
                    server.credential_id,
                    server.group_id,
                    tags,
                    server.proxy_jump_id,
                    server.favorite,
                    server.last_connected_at,
                    server.status,
                    server.created_at,
                    server.updated_at
                ],
            )?
        };
        tally(changed, existed, &mut added, &mut overwritten, &mut skipped);
    }

    for host in &backup.known_hosts {
        let existed = row_exists(&tx, "known_hosts", &host.id)?;
        let changed = if overwrite {
            tx.execute(
                "INSERT INTO known_hosts (id, host, port, fingerprint, fingerprint_type, status, first_seen_at, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(id) DO UPDATE SET
                     fingerprint=excluded.fingerprint, fingerprint_type=excluded.fingerprint_type,
                     status=excluded.status, last_seen_at=excluded.last_seen_at",
                params![
                    host.id,
                    host.host,
                    host.port,
                    host.fingerprint,
                    host.fingerprint_type,
                    host.status,
                    host.first_seen_at,
                    host.last_seen_at
                ],
            )?
        } else {
            tx.execute(
                "INSERT OR IGNORE INTO known_hosts (id, host, port, fingerprint, fingerprint_type, status, first_seen_at, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    host.id,
                    host.host,
                    host.port,
                    host.fingerprint,
                    host.fingerprint_type,
                    host.status,
                    host.first_seen_at,
                    host.last_seen_at
                ],
            )?
        };
        tally(changed, existed, &mut added, &mut overwritten, &mut skipped);
    }

    for project in &backup.projects {
        let existed = row_exists(&tx, "confirmed_projects", &project.id)?;
        let changed = if overwrite {
            tx.execute(
                "INSERT INTO confirmed_projects (id, server_id, canonical_path, name, project_type,
                                                 candidate_payload, scan_state, confirmed_at, updated_at,
                                                 last_seen_at, missing_since, deleted_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL)
                 ON CONFLICT(id) DO UPDATE SET
                     name=excluded.name, project_type=excluded.project_type,
                     candidate_payload=excluded.candidate_payload, scan_state=excluded.scan_state,
                     updated_at=excluded.updated_at, last_seen_at=excluded.last_seen_at,
                     missing_since=excluded.missing_since, deleted_at=NULL",
                params![
                    project.id,
                    project.server_id,
                    project.canonical_path,
                    project.name,
                    project.project_type,
                    project.candidate_payload,
                    project.scan_state,
                    project.confirmed_at,
                    project.updated_at,
                    project.last_seen_at,
                    project.missing_since
                ],
            )?
        } else {
            tx.execute(
                "INSERT OR IGNORE INTO confirmed_projects (id, server_id, canonical_path, name, project_type,
                                                           candidate_payload, scan_state, confirmed_at, updated_at,
                                                           last_seen_at, missing_since, deleted_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL)",
                params![
                    project.id,
                    project.server_id,
                    project.canonical_path,
                    project.name,
                    project.project_type,
                    project.candidate_payload,
                    project.scan_state,
                    project.confirmed_at,
                    project.updated_at,
                    project.last_seen_at,
                    project.missing_since
                ],
            )?
        };
        tally(changed, existed, &mut added, &mut overwritten, &mut skipped);
    }

    for review in &backup.project_reviews {
        let existed: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM project_reviews WHERE server_id = ?1 AND path = ?2",
                params![review.server_id, review.path],
                |row| row.get(0),
            )
            .optional()?;
        let sql = if overwrite {
            "INSERT INTO project_reviews (server_id, path, review, name, project_type, note, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(server_id, path) DO UPDATE SET
                 review=excluded.review, name=excluded.name, project_type=excluded.project_type,
                 note=excluded.note, updated_at=excluded.updated_at"
        } else {
            "INSERT OR IGNORE INTO project_reviews (server_id, path, review, name, project_type, note, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
        };
        let changed = tx.execute(
            sql,
            params![
                review.server_id,
                review.path,
                review.review,
                review.name,
                review.project_type,
                review.note,
                review.created_at,
                review.updated_at
            ],
        )?;
        tally(
            changed,
            existed.is_some(),
            &mut added,
            &mut overwritten,
            &mut skipped,
        );
    }

    for merge in &backup.project_merges {
        let existed = row_exists(&tx, "project_merges", &merge.id)?;
        let sql = if overwrite {
            "INSERT INTO project_merges (id, server_id, child_path, parent_path, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
                 child_path=excluded.child_path, parent_path=excluded.parent_path,
                 updated_at=excluded.updated_at"
        } else {
            "INSERT OR IGNORE INTO project_merges (id, server_id, child_path, parent_path, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
        };
        let changed = tx.execute(
            sql,
            params![
                merge.id,
                merge.server_id,
                merge.child_path,
                merge.parent_path,
                merge.created_at,
                merge.updated_at
            ],
        )?;
        tally(changed, existed, &mut added, &mut overwritten, &mut skipped);
    }

    // 提交前不做别的写操作：任何一步失败都由 `tx` 的 Drop 回滚。
    tx.commit()?;

    Ok(BackupImportResult {
        added,
        overwritten,
        skipped,
        settings: backup.settings.clone(),
    })
}

fn row_exists(conn: &Connection, table: &str, id: &str) -> Result<bool> {
    let found: Option<i64> = conn
        .query_row(
            &format!("SELECT 1 FROM {table} WHERE id = ?1"),
            [id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

fn tally(
    changed: usize,
    existed: bool,
    added: &mut usize,
    overwritten: &mut usize,
    skipped: &mut usize,
) {
    if changed == 0 {
        *skipped += 1;
    } else if existed {
        *overwritten += 1;
    } else {
        *added += 1;
    }
}

// ---------------------------------------------------------------------------
// 读表
// ---------------------------------------------------------------------------

fn read_servers(conn: &Connection) -> Result<Vec<ServerRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM servers ORDER BY created_at ASC")?;
    let rows = stmt.query_map([], |row| {
        let tags: String = row.get("tags")?;
        Ok(ServerRecord {
            id: row.get("id")?,
            name: row.get("name")?,
            host: row.get("host")?,
            port: row.get("port")?,
            username: row.get("username")?,
            credential_id: row.get("credential_id")?,
            group_id: row.get("group_id")?,
            // 脏标签只会让这一行的标签变空，不影响整份备份。
            tags: serde_json::from_str(&tags).unwrap_or_default(),
            proxy_jump_id: row.get("proxy_jump_id")?,
            favorite: row.get("favorite")?,
            last_connected_at: row.get("last_connected_at")?,
            status: row.get("status")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn read_groups(conn: &Connection) -> Result<Vec<ServerGroupRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM server_groups ORDER BY sort_order ASC")?;
    let rows = stmt.query_map([], |row| {
        Ok(ServerGroupRecord {
            id: row.get("id")?,
            name: row.get("name")?,
            sort_order: row.get("sort_order")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn read_credentials(conn: &Connection) -> Result<Vec<CredentialRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM credentials ORDER BY created_at ASC")?;
    let rows = stmt.query_map([], |row| {
        Ok(CredentialRecord {
            id: row.get("id")?,
            name: row.get("name")?,
            credential_type: row.get("type")?,
            username: row.get("username")?,
            secret_ref: row.get("secret_ref")?,
            passphrase_ref: row.get("passphrase_ref")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn read_known_hosts(conn: &Connection) -> Result<Vec<KnownHostRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM known_hosts ORDER BY first_seen_at ASC")?;
    let rows = stmt.query_map([], |row| {
        Ok(KnownHostRecord {
            id: row.get("id")?,
            host: row.get("host")?,
            port: row.get("port")?,
            fingerprint: row.get("fingerprint")?,
            fingerprint_type: row.get("fingerprint_type")?,
            status: row.get("status")?,
            first_seen_at: row.get("first_seen_at")?,
            last_seen_at: row.get("last_seen_at")?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn read_projects(conn: &Connection) -> Result<Vec<ConfirmedProjectRecord>> {
    let mut stmt = conn.prepare(
        "SELECT * FROM confirmed_projects WHERE deleted_at IS NULL ORDER BY confirmed_at ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ConfirmedProjectRecord {
            id: row.get("id")?,
            server_id: row.get("server_id")?,
            canonical_path: row.get("canonical_path")?,
            name: row.get("name")?,
            project_type: row.get("project_type")?,
            candidate_payload: row.get("candidate_payload")?,
            scan_state: row.get("scan_state")?,
            confirmed_at: row.get("confirmed_at")?,
            updated_at: row.get("updated_at")?,
            last_seen_at: row.get("last_seen_at")?,
            missing_since: row.get("missing_since")?,
            deleted_at: row.get("deleted_at")?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn read_project_reviews(conn: &Connection) -> Result<Vec<ProjectReviewRecord>> {
    let mut stmt =
        conn.prepare("SELECT * FROM project_reviews ORDER BY server_id ASC, path ASC")?;
    let rows = stmt.query_map([], |row| {
        Ok(ProjectReviewRecord {
            server_id: row.get("server_id")?,
            path: row.get("path")?,
            review: row.get("review")?,
            name: row.get("name")?,
            project_type: row.get("project_type")?,
            note: row.get("note")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn read_project_merges(conn: &Connection) -> Result<Vec<ProjectMergeRecord>> {
    let mut stmt = conn.prepare("SELECT * FROM project_merges ORDER BY created_at ASC")?;
    let rows = stmt.query_map([], |row| {
        Ok(ProjectMergeRecord {
            id: row.get("id")?,
            server_id: row.get("server_id")?,
            child_path: row.get("child_path")?,
            parent_path: row.get("parent_path")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

// ---------------------------------------------------------------------------
// 迁移前自动备份
// ---------------------------------------------------------------------------

/// 数据库升级前把旧文件复制一份，保留最近 [`AUTO_BACKUP_KEEP`] 份。
///
/// 返回新备份的路径；调用方即使失败也不该阻止启动（可用性优先），
/// 但必须记下来 —— 静默失败会让人误以为有备份。
pub fn backup_before_migration(db_path: &Path, from_version: u32) -> Result<PathBuf> {
    let file_name = db_path
        .file_name()
        .ok_or_else(|| anyhow!("数据库路径没有文件名"))?
        .to_string_lossy();
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let target = db_path.with_file_name(format!("{file_name}.v{from_version}-{stamp}.bak"));
    std::fs::copy(db_path, &target)
        .with_context(|| format!("无法备份数据库到 {}", target.display()))?;
    prune_auto_backups(db_path, &file_name);
    Ok(target)
}

fn prune_auto_backups(db_path: &Path, file_name: &str) {
    let Some(dir) = db_path.parent() else { return };
    let prefix = format!("{file_name}.v");
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut backups: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .map(|name| {
                    let name = name.to_string_lossy();
                    name.starts_with(&prefix) && name.ends_with(".bak")
                })
                .unwrap_or(false)
        })
        .collect();
    if backups.len() <= AUTO_BACKUP_KEEP {
        return;
    }
    backups.sort();
    let drop_count = backups.len() - AUTO_BACKUP_KEEP;
    for stale in backups.into_iter().take(drop_count) {
        let _ = std::fs::remove_file(stale);
    }
}

#[cfg(test)]
mod tests;
