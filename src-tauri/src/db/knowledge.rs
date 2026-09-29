//! 用户知识库的持久化。
//!
//! # 版本规则（写在 DB 层，因为它是硬约束）
//!
//! * `knowledge_documents` 只存**当前版本**；
//! * 每次保存都往 `knowledge_document_versions` **追加一行**，旧行永不动；
//! * "删除"= 归档（`status = archived`）：文档不再参与检索，但历史方案里
//!   `knowledge:<id>@<version>` 的引用仍然能读到内容 —— 这正是"历史引用可追溯"。
//!
//! # 没有 FTS
//!
//! 检索在 Rust 里做（BM25，见 `deployment::knowledge::retrieve`）：
//! 它可复现、可单测，也不依赖 SQLite 的 FTS5 编译开关。因此这里**没有**
//! `knowledge_fts` 虚拟表。

use anyhow::Result;
use rusqlite::{params, Connection};

use crate::deployment::knowledge::model::{
    KnowledgeCategory, KnowledgeDocStatus, KnowledgeDocument, KnowledgeScope, KnowledgeSourceType,
    KnowledgeUsageRecord, KnowledgeVersion,
};

/// 正文哈希（内容一变版本就得变；提示词哈希会覆盖它）。
pub fn hash_content(content: &str) -> String {
    crate::deployment::artifact::fingerprint::hash_bytes(content.as_bytes())
}

fn scope_from_text(text: &str) -> KnowledgeScope {
    match text {
        "application" => KnowledgeScope::Application,
        "environment" => KnowledgeScope::Environment,
        _ => KnowledgeScope::Global,
    }
}

fn category_from_text(text: &str) -> KnowledgeCategory {
    for category in KnowledgeCategory::ALL {
        if category.as_str() == text {
            return *category;
        }
    }
    KnowledgeCategory::Custom
}

fn source_from_text(text: &str) -> KnowledgeSourceType {
    match text {
        "markdown_file" => KnowledgeSourceType::MarkdownFile,
        "imported_text" => KnowledgeSourceType::ImportedText,
        _ => KnowledgeSourceType::Manual,
    }
}

fn status_from_text(text: &str) -> KnowledgeDocStatus {
    match text {
        "active" => KnowledgeDocStatus::Active,
        "archived" => KnowledgeDocStatus::Archived,
        _ => KnowledgeDocStatus::Draft,
    }
}

fn tags_from_text(text: &str) -> Vec<String> {
    serde_json::from_str(text).unwrap_or_default()
}

fn document_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<KnowledgeDocument> {
    Ok(KnowledgeDocument {
        id: row.get("id")?,
        title: row.get("title")?,
        scope: scope_from_text(&row.get::<_, String>("scope")?),
        application_id: row.get("application_id")?,
        environment_id: row.get("environment_id")?,
        category: category_from_text(&row.get::<_, String>("category")?),
        tags: tags_from_text(&row.get::<_, String>("tags_json")?),
        source_type: source_from_text(&row.get::<_, String>("source_type")?),
        source_name: row.get("source_name")?,
        version: row.get("version")?,
        status: status_from_text(&row.get::<_, String>("status")?),
        content: row.get("content")?,
        content_hash: row.get("content_hash")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        last_verified_at: row.get("last_verified_at")?,
        note: row.get("note")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 列出文档（`include_archived = false` 时排除已归档）。
pub fn list_documents(
    conn: &Connection,
    application_id: Option<&str>,
    environment_id: Option<&str>,
    include_archived: bool,
) -> Result<Vec<KnowledgeDocument>> {
    let mut statement = conn.prepare(
        "SELECT * FROM knowledge_documents
         WHERE (?1 = 1 OR status != 'archived')
           AND (?2 IS NULL OR application_id IS NULL OR application_id = ?2)
           AND (?3 IS NULL OR environment_id IS NULL OR environment_id = ?3)
         ORDER BY scope DESC, title ASC",
    )?;
    let rows = statement.query_map(
        params![include_archived as i64, application_id, environment_id],
        document_from_row,
    )?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_document(conn: &Connection, id: &str) -> Result<Option<KnowledgeDocument>> {
    let mut statement = conn.prepare("SELECT * FROM knowledge_documents WHERE id = ?1")?;
    let mut rows = statement.query_map([id], document_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// 写入当前版本（**只在调用方确认已追加历史版本之后使用**）。
pub fn upsert_document(conn: &Connection, document: &KnowledgeDocument) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO knowledge_documents (
            id, title, scope, application_id, environment_id, category, tags_json, source_type,
            source_name, version, status, content, content_hash, enabled, last_verified_at, note,
            created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
        ON CONFLICT(id) DO UPDATE SET
            title=excluded.title,
            scope=excluded.scope,
            application_id=excluded.application_id,
            environment_id=excluded.environment_id,
            category=excluded.category,
            tags_json=excluded.tags_json,
            source_type=excluded.source_type,
            source_name=excluded.source_name,
            version=excluded.version,
            status=excluded.status,
            content=excluded.content,
            content_hash=excluded.content_hash,
            enabled=excluded.enabled,
            last_verified_at=excluded.last_verified_at,
            note=excluded.note,
            updated_at=excluded.updated_at
        "#,
        params![
            &document.id,
            &document.title,
            document.scope.as_str(),
            &document.application_id,
            &document.environment_id,
            document.category.as_str(),
            serde_json::to_string(&document.tags).unwrap_or_else(|_| "[]".to_string()),
            document.source_type.as_str(),
            &document.source_name,
            document.version,
            document.status.as_str(),
            &document.content,
            &document.content_hash,
            document.enabled as i64,
            document.last_verified_at,
            &document.note,
            document.created_at,
            document.updated_at,
        ],
    )?;
    Ok(())
}

/// 追加一个历史版本（**永不覆盖**：同 id 同 version 已存在就原样返回）。
pub fn append_version(conn: &Connection, version: &KnowledgeVersion) -> Result<()> {
    conn.execute(
        r#"
        INSERT OR IGNORE INTO knowledge_document_versions (
            id, document_id, version, title, content, content_hash, source_type, note, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        "#,
        params![
            &version.id,
            &version.document_id,
            version.version,
            &version.title,
            &version.content,
            &version.content_hash,
            version.source_type.as_str(),
            &version.note,
            version.created_at,
        ],
    )?;
    Ok(())
}

fn version_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<KnowledgeVersion> {
    Ok(KnowledgeVersion {
        id: row.get("id")?,
        document_id: row.get("document_id")?,
        version: row.get("version")?,
        title: row.get("title")?,
        content: row.get("content")?,
        content_hash: row.get("content_hash")?,
        source_type: source_from_text(&row.get::<_, String>("source_type")?),
        note: row.get("note")?,
        created_at: row.get("created_at")?,
    })
}

/// 历史版本（从旧到新）。
pub fn list_versions(conn: &Connection, document_id: &str) -> Result<Vec<KnowledgeVersion>> {
    let mut statement = conn.prepare(
        "SELECT * FROM knowledge_document_versions WHERE document_id = ?1 ORDER BY version ASC",
    )?;
    let rows = statement.query_map([document_id], version_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_version(
    conn: &Connection,
    document_id: &str,
    version: i64,
) -> Result<Option<KnowledgeVersion>> {
    let mut statement = conn.prepare(
        "SELECT * FROM knowledge_document_versions WHERE document_id = ?1 AND version = ?2",
    )?;
    let mut rows = statement.query_map(params![document_id, version], version_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// 归档（软删除）：不参与检索，历史引用仍可追溯。
pub fn archive_document(conn: &Connection, id: &str, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE knowledge_documents SET status = 'archived', enabled = 0, updated_at = ?2
         WHERE id = ?1",
        params![id, now],
    )?;
    Ok(())
}

/// 记录一次引用（供"被哪些方案引用"与"当时用的是哪一版"查询）。
pub fn record_usage(conn: &Connection, record: &KnowledgeUsageRecord) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO knowledge_usage_records (
            id, document_id, version, proposal_id, used_by, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            &record.id,
            &record.document_id,
            record.version,
            &record.proposal_id,
            &record.used_by,
            record.created_at,
        ],
    )?;
    Ok(())
}

pub fn usage_by_document(
    conn: &Connection,
    document_id: &str,
) -> Result<Vec<KnowledgeUsageRecord>> {
    let mut statement = conn.prepare(
        "SELECT * FROM knowledge_usage_records WHERE document_id = ?1 ORDER BY created_at DESC",
    )?;
    let rows = statement.query_map([document_id], |row| {
        Ok(KnowledgeUsageRecord {
            id: row.get("id")?,
            document_id: row.get("document_id")?,
            version: row.get("version")?,
            proposal_id: row.get("proposal_id")?,
            used_by: row.get("used_by")?,
            created_at: row.get("created_at")?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn usage_by_proposal(
    conn: &Connection,
    proposal_id: &str,
) -> Result<Vec<KnowledgeUsageRecord>> {
    let mut statement = conn.prepare(
        "SELECT * FROM knowledge_usage_records WHERE proposal_id = ?1 ORDER BY created_at DESC",
    )?;
    let rows = statement.query_map([proposal_id], |row| {
        Ok(KnowledgeUsageRecord {
            id: row.get("id")?,
            document_id: row.get("document_id")?,
            version: row.get("version")?,
            proposal_id: row.get("proposal_id")?,
            used_by: row.get("used_by")?,
            created_at: row.get("created_at")?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_db;

    fn document(id: &str) -> KnowledgeDocument {
        let mut document = KnowledgeDocument::new(id, "部署规范", 1);
        document.content = "第一版内容".to_string();
        document.content_hash = hash_content(&document.content);
        document.status = KnowledgeDocStatus::Active;
        document.enabled = true;
        document
    }

    #[test]
    fn saving_produces_a_new_version_and_keeps_the_old_one() {
        let conn = test_db();
        upsert_document(&conn, &document("d1")).unwrap();
        append_version(
            &conn,
            &KnowledgeVersion {
                id: "d1:v1".to_string(),
                document_id: "d1".to_string(),
                version: 1,
                title: "部署规范".to_string(),
                content: "第一版内容".to_string(),
                content_hash: hash_content("第一版内容"),
                source_type: KnowledgeSourceType::Manual,
                note: String::new(),
                created_at: 1,
            },
        )
        .unwrap();

        // 保存第二版：先追加历史，再更新当前行。
        let mut second = get_document(&conn, "d1").unwrap().unwrap();
        second.content = "第二版内容".to_string();
        second.content_hash = hash_content(&second.content);
        second.version = 2;
        append_version(
            &conn,
            &KnowledgeVersion {
                id: "d1:v2".to_string(),
                document_id: "d1".to_string(),
                version: 2,
                title: second.title.clone(),
                content: second.content.clone(),
                content_hash: second.content_hash.clone(),
                source_type: second.source_type,
                note: "修订".to_string(),
                created_at: 2,
            },
        )
        .unwrap();
        upsert_document(&conn, &second).unwrap();

        let current = get_document(&conn, "d1").unwrap().unwrap();
        assert_eq!(current.version, 2);
        assert_eq!(current.content, "第二版内容");

        let versions = list_versions(&conn, "d1").unwrap();
        assert_eq!(versions.len(), 2, "旧版本必须还在");
        assert_eq!(versions[0].content, "第一版内容");
        assert_eq!(versions[1].content, "第二版内容");
        // 历史版本单独读得到（恢复旧版本时用它）。
        let first = get_version(&conn, "d1", 1).unwrap().unwrap();
        assert_eq!(first.content, "第一版内容");
    }

    #[test]
    fn an_archived_document_is_hidden_but_its_history_survives() {
        let conn = test_db();
        let saved = document("d1");
        upsert_document(&conn, &saved).unwrap();
        append_version(
            &conn,
            &KnowledgeVersion {
                id: "d1:v1".to_string(),
                document_id: "d1".to_string(),
                version: 1,
                title: saved.title.clone(),
                content: saved.content.clone(),
                content_hash: saved.content_hash.clone(),
                source_type: saved.source_type,
                note: String::new(),
                created_at: 1,
            },
        )
        .unwrap();
        let loaded = get_document(&conn, "d1").unwrap().unwrap();
        assert_eq!(loaded.status, KnowledgeDocStatus::Active);

        archive_document(&conn, "d1", 5).unwrap();
        let archived = get_document(&conn, "d1").unwrap().unwrap();
        assert_eq!(archived.status, KnowledgeDocStatus::Archived);
        assert!(!archived.enabled);
        // 归档的文档不出现在默认列表里。
        assert!(list_documents(&conn, None, None, false).unwrap().is_empty());
        assert_eq!(list_documents(&conn, None, None, true).unwrap().len(), 1);
        // 历史引用仍然能读到内容（不破坏历史方案）。
        assert!(!list_versions(&conn, "d1").unwrap().is_empty());
    }

    #[test]
    fn scope_and_tags_round_trip() {
        let conn = test_db();
        let mut document = document("d1");
        document.scope = KnowledgeScope::Environment;
        document.environment_id = Some("env-1".to_string());
        document.tags = vec!["回滚".to_string(), "生产".to_string()];
        document.category = KnowledgeCategory::Rollback;
        upsert_document(&conn, &document).unwrap();

        let loaded = get_document(&conn, "d1").unwrap().unwrap();
        assert_eq!(loaded.scope, KnowledgeScope::Environment);
        assert_eq!(loaded.tags, vec!["回滚".to_string(), "生产".to_string()]);
        assert_eq!(loaded.category, KnowledgeCategory::Rollback);
    }

    #[test]
    fn usage_records_survive_being_queried_by_both_sides() {
        let conn = test_db();
        upsert_document(&conn, &document("d1")).unwrap();
        record_usage(
            &conn,
            &KnowledgeUsageRecord {
                id: "u1".to_string(),
                document_id: "d1".to_string(),
                version: 1,
                proposal_id: "proposal-1".to_string(),
                used_by: "ai_review".to_string(),
                created_at: 10,
            },
        )
        .unwrap();
        assert_eq!(usage_by_document(&conn, "d1").unwrap().len(), 1);
        assert_eq!(
            usage_by_proposal(&conn, "proposal-1").unwrap()[0].version,
            1
        );
        // 重复写入不产生两条（同一方案 + 同一版本只记一次）。
        record_usage(
            &conn,
            &KnowledgeUsageRecord {
                id: "u1".to_string(),
                document_id: "d1".to_string(),
                version: 1,
                proposal_id: "proposal-1".to_string(),
                used_by: "ai_review".to_string(),
                created_at: 10,
            },
        )
        .unwrap();
        assert_eq!(usage_by_proposal(&conn, "proposal-1").unwrap().len(), 1);
    }
}
