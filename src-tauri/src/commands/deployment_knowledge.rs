//! P5.5 用户知识库 IPC。
//!
//! # 版本纪律（在命令层，因为它需要"读旧 + 写新"两步）
//!
//! * 保存：当前内容先**追加为历史版本**，再把当前行改成新版本 —— 旧内容永不覆盖；
//! * 恢复：把某个旧版本的**内容**作为**新版本**写入（版本号继续 +1），
//!   这样"恢复"也是一次可追溯的编辑，而不是把指针拨回去、让历史对不上；
//! * 删除：归档（不参与检索，内容仍在），历史方案里的引用因此不会悬空。
//!
//! # 检索
//!
//! `deployment_knowledge_search_test` 用与 AI 复核**完全相同**的检索函数，
//! 因此"界面上试出来的结果"就是"模型将看到的东西"。
//!
//! 知识内容是**不可信数据**：出现"忽略系统规则""执行以下命令"这类文字时
//! 会打上 `suspicious` 标记，但仍然可用 —— 它只是被引用，不会变成指令。

use tauri::State;

use crate::db::{self, AppDb};
use crate::deployment::knowledge;
use crate::deployment::knowledge::model::{
    ImportedMarkdown, KnowledgeBudget, KnowledgeDocStatus, KnowledgeDocument, KnowledgeHit,
    KnowledgeQueryInput, KnowledgeSourceType, KnowledgeUsageRecord, KnowledgeVersion,
    MARKDOWN_EXTENSIONS, MAX_MARKDOWN_BYTES,
};
use crate::state::AppState;

use super::record_audit;

/// 内容哈希（与 DB 层同一个函数，保证"库里的"和"界面算的"一致）。
fn hash(content: &str) -> String {
    db::hash_content(content)
}

#[tauri::command]
pub async fn deployment_knowledge_list(
    state: State<'_, AppState>,
    application_id: Option<String>,
    environment_id: Option<String>,
    include_archived: Option<bool>,
) -> Result<Vec<KnowledgeDocument>, String> {
    let conn = state.db.open().map_err(|error| error.to_string())?;
    db::list_documents(
        &conn,
        application_id.as_deref(),
        environment_id.as_deref(),
        include_archived.unwrap_or(false),
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn deployment_knowledge_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<KnowledgeDocument>, String> {
    let conn = state.db.open().map_err(|error| error.to_string())?;
    db::get_document(&conn, &id).map_err(|error| error.to_string())
}

/// 保存（产生**新版本**）。
#[tauri::command]
pub async fn deployment_knowledge_save(
    state: State<'_, AppState>,
    document: KnowledgeDocument,
    note: Option<String>,
) -> Result<KnowledgeDocument, String> {
    let now = AppDb::now();
    let conn = state.db.open().map_err(|error| error.to_string())?;

    let id = document.id.trim().to_string();
    if id.is_empty() {
        return Err("知识 id 不能为空".to_string());
    }
    if document.title.trim().is_empty() {
        return Err("标题不能为空".to_string());
    }
    if document.content.trim().is_empty() {
        return Err("内容不能为空".to_string());
    }
    // 作用域与目标的对应关系：环境级必须给环境 id，应用级必须给应用 id。
    match document.scope {
        knowledge::model::KnowledgeScope::Environment if document.environment_id.is_none() => {
            return Err("环境级知识必须指定环境".to_string())
        }
        knowledge::model::KnowledgeScope::Application if document.application_id.is_none() => {
            return Err("应用级知识必须指定应用".to_string())
        }
        _ => {}
    }

    let existing = db::get_document(&conn, &id).map_err(|error| error.to_string())?;
    // 版本号：历史表里最大的那个 + 1（比"当前版本 + 1"更稳，避免历史缺失时撞号）。
    let versions = db::list_versions(&conn, &id).map_err(|error| error.to_string())?;
    let next_version = versions
        .iter()
        .map(|version| version.version)
        .max()
        .unwrap_or(
            existing
                .as_ref()
                .map(|document| document.version)
                .unwrap_or(0),
        )
        .max(1)
        + 1;

    // 1) 旧内容先保证进历史（若之前没记过，这里补上，避免内容丢失）。
    if let Some(previous) = existing.as_ref() {
        let recorded = versions
            .iter()
            .any(|version| version.version == previous.version);
        if !recorded {
            db::append_version(
                &conn,
                &KnowledgeVersion {
                    id: format!("{id}:v{}", previous.version),
                    document_id: id.clone(),
                    version: previous.version,
                    title: previous.title.clone(),
                    content: previous.content.clone(),
                    content_hash: previous.content_hash.clone(),
                    source_type: previous.source_type,
                    note: "（补记：首次进入版本管理）".to_string(),
                    created_at: previous.updated_at,
                },
            )
            .map_err(|error| error.to_string())?;
        }
    }

    // 2) 新内容作为新版本追加。
    let mut saved = document.clone();
    saved.id = id.clone();
    saved.version = next_version;
    saved.content_hash = hash(&document.content);
    saved.updated_at = now;
    if existing.is_none() {
        saved.created_at = now;
    }
    db::append_version(
        &conn,
        &KnowledgeVersion {
            id: format!("{id}:v{next_version}"),
            document_id: id.clone(),
            version: next_version,
            title: saved.title.clone(),
            content: saved.content.clone(),
            content_hash: saved.content_hash.clone(),
            source_type: saved.source_type,
            note: note.clone().unwrap_or_default(),
            created_at: now,
        },
    )
    .map_err(|error| error.to_string())?;
    db::upsert_document(&conn, &saved).map_err(|error| error.to_string())?;

    record_audit(
        &state,
        "deployment_knowledge_save",
        None,
        None,
        &format!(
            "{{\"document\":\"{id}\",\"version\":{next_version},\"scope\":\"{}\"}}",
            saved.scope.as_str()
        ),
    );
    Ok(saved)
}

#[tauri::command]
pub async fn deployment_knowledge_versions(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<KnowledgeVersion>, String> {
    let conn = state.db.open().map_err(|error| error.to_string())?;
    db::list_versions(&conn, &id).map_err(|error| error.to_string())
}

/// 恢复某个历史版本 —— **作为新版本写入**，历史不被改写。
#[tauri::command]
pub async fn deployment_knowledge_restore(
    state: State<'_, AppState>,
    id: String,
    version: i64,
) -> Result<KnowledgeDocument, String> {
    let conn = state.db.open().map_err(|error| error.to_string())?;
    let current = db::get_document(&conn, &id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "知识文档不存在".to_string())?;
    let target = db::get_version(&conn, &id, version)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("没有第 {version} 版"))?;

    let mut restored = current.clone();
    restored.title = target.title.clone();
    restored.content = target.content.clone();
    restored.content_hash = hash(&target.content);
    restored.source_type = target.source_type;
    drop(conn);
    deployment_knowledge_save(state, restored, Some(format!("从第 {version} 版恢复"))).await
}

/// 归档（软删除）：不参与检索，历史引用仍可追溯。
#[tauri::command]
pub async fn deployment_knowledge_archive(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let now = AppDb::now();
    let conn = state.db.open().map_err(|error| error.to_string())?;
    db::archive_document(&conn, &id, now).map_err(|error| error.to_string())?;
    record_audit(
        &state,
        "deployment_knowledge_archive",
        None,
        None,
        &format!("{{\"document\":\"{id}\"}}"),
    );
    Ok(())
}

/// 元数据更新入参（**完整替换**语义，避免"没传 = 不改"造成的歧义）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct KnowledgeMetaUpdate {
    pub enabled: bool,
    pub status: KnowledgeDocStatus,
    /// `None` = 还没核对过（可清除）。
    pub last_verified_at: Option<i64>,
    pub note: String,
}

/// 只更新元数据：启用开关 / 状态 / 最近核对时间 / 备注。
///
/// **不改内容、不产生新版本** —— 版本号只由正文变更驱动；
/// "启用 / 标记已核对 / 归档"这类操作不该污染版本历史。
/// 状态设为 `archived` 时会同时停用（归档 = 不参与检索，两者必须一致）。
#[tauri::command]
pub async fn deployment_knowledge_update_meta(
    state: State<'_, AppState>,
    id: String,
    update: KnowledgeMetaUpdate,
) -> Result<KnowledgeDocument, String> {
    let now = AppDb::now();
    let conn = state.db.open().map_err(|error| error.to_string())?;
    let mut document = db::get_document(&conn, &id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "知识文档不存在".to_string())?;

    document.enabled = update.enabled;
    document.status = update.status;
    if document.status == KnowledgeDocStatus::Archived {
        // 归档 = 不可检索：不能出现"已归档但仍启用"。
        document.enabled = false;
    }
    document.last_verified_at = update.last_verified_at;
    document.note = update.note.clone();
    document.updated_at = now;

    db::update_document_meta(
        &conn,
        &id,
        document.enabled,
        document.status,
        document.last_verified_at,
        &document.note,
        now,
    )
    .map_err(|error| error.to_string())?;

    record_audit(
        &state,
        "deployment_knowledge_update_meta",
        None,
        None,
        &format!(
            "{{\"document\":\"{id}\",\"enabled\":{},\"status\":\"{}\"}}",
            document.enabled,
            document.status.as_str()
        ),
    );
    Ok(document)
}

/// 导入本地 Markdown 文件。
///
/// **受限读取**：只接受 `.md` / `.markdown` / `.txt`，上限 2 MiB，必须是 UTF-8。
/// 返回内容供编辑器预览，**不落库、不覆盖任何已有文档**（用户确认后再 save）。
///
/// 之所以做成 Rust IPC 而不是前端任意读文件：前端拿不到"任意读文件"的能力，
/// 路径只能来自系统文件选择器，读取范围被上面三条规则限死。
#[tauri::command]
pub async fn deployment_knowledge_import_markdown(
    path: String,
) -> Result<ImportedMarkdown, String> {
    read_markdown_file(&path)
}

/// 受限地读一个 Markdown 文件（纯逻辑，便于单测）。
fn read_markdown_file(path: &str) -> Result<ImportedMarkdown, String> {
    let path = std::path::Path::new(path);
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase());
    match extension.as_deref() {
        Some(ext) if MARKDOWN_EXTENSIONS.contains(&ext) => {}
        Some(other) => {
            return Err(format!(
                "只支持 .md / .markdown / .txt 文件，当前是 .{other}"
            ))
        }
        None => return Err("只支持 .md / .markdown / .txt 文件".to_string()),
    }

    let metadata = std::fs::metadata(path).map_err(|error| format!("无法读取文件：{error}"))?;
    if !metadata.is_file() {
        return Err("选择的不是文件".to_string());
    }
    if metadata.len() > MAX_MARKDOWN_BYTES {
        return Err(format!(
            "文件太大（{} KiB）：上限 {} KiB",
            metadata.len() / 1024,
            MAX_MARKDOWN_BYTES / 1024
        ));
    }

    let bytes = std::fs::read(path).map_err(|error| format!("无法读取文件：{error}"))?;
    // 读入后再查一次大小：避免"检查与读取之间文件被换掉"。
    let size = bytes.len() as u64;
    if size > MAX_MARKDOWN_BYTES {
        return Err(format!(
            "文件太大（{} KiB）：上限 {} KiB",
            size / 1024,
            MAX_MARKDOWN_BYTES / 1024
        ));
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| "文件不是 UTF-8 编码：请另存为 UTF-8 后再导入".to_string())?;
    // UTF-8 BOM 不该出现在正文里。
    let content = content.trim_start_matches('\u{feff}').to_string();

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("knowledge.md")
        .to_string();
    let suggested_title = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or("导入的知识")
        .to_string();

    Ok(ImportedMarkdown {
        file_name,
        suggested_title,
        content,
        bytes: size,
        source_type: KnowledgeSourceType::MarkdownFile,
    })
}

#[tauri::command]
pub async fn deployment_knowledge_usage(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<KnowledgeUsageRecord>, String> {
    let conn = state.db.open().map_err(|error| error.to_string())?;
    db::usage_by_document(&conn, &id).map_err(|error| error.to_string())
}

/// 检索测试：与 AI 复核用的是同一个函数、同一套预算。
#[tauri::command]
pub async fn deployment_knowledge_search_test(
    state: State<'_, AppState>,
    query: KnowledgeQueryInput,
) -> Result<Vec<KnowledgeHit>, String> {
    let conn = state.db.open().map_err(|error| error.to_string())?;
    let documents = db::list_documents(
        &conn,
        query.application_id.as_deref(),
        query.environment_id.as_deref(),
        false,
    )
    .map_err(|error| error.to_string())?;
    let limit = if query.limit == 0 { 8 } else { query.limit };
    let query = KnowledgeQueryInput { limit, ..query };
    Ok(knowledge::search(
        &documents,
        &query,
        KnowledgeBudget::default(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("bls-ops-kb-test-{}-{name}", uuid::Uuid::new_v4()));
        let mut file = std::fs::File::create(&path).expect("create");
        file.write_all(bytes).expect("write");
        path
    }

    #[test]
    fn a_markdown_file_becomes_content_with_a_suggested_title() {
        let path = temp_file("运维手册.md", "# 标题\n正文".as_bytes());
        let imported = read_markdown_file(path.to_str().unwrap()).expect("应当导入");
        // 测试文件带唯一前缀，因此断言"以原名结尾"（标题来自文件名去扩展名）。
        assert!(
            imported.suggested_title.ends_with("运维手册"),
            "{}",
            imported.suggested_title
        );
        assert!(
            imported.file_name.ends_with("运维手册.md"),
            "{}",
            imported.file_name
        );
        assert!(imported.content.contains("正文"));
        assert_eq!(imported.source_type, KnowledgeSourceType::MarkdownFile);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn an_unsupported_extension_is_rejected() {
        let path = temp_file("payload.exe", b"binary");
        let error = read_markdown_file(path.to_str().unwrap()).expect_err("必须拒绝");
        assert!(error.contains("只支持"), "{error}");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn an_oversized_file_is_rejected() {
        let huge = vec![b'a'; (MAX_MARKDOWN_BYTES + 1) as usize];
        let path = temp_file("huge.md", &huge);
        let error = read_markdown_file(path.to_str().unwrap()).expect_err("必须拒绝");
        assert!(error.contains("太大"), "{error}");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_non_utf8_file_is_rejected_with_a_clear_message() {
        // 0xFF 在 UTF-8 里是非法的起始字节。
        let path = temp_file("gbk.md", &[0xFF, 0xFE, 0x00, 0x41]);
        let error = read_markdown_file(path.to_str().unwrap()).expect_err("必须拒绝");
        assert!(error.contains("UTF-8"), "{error}");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_directory_is_rejected() {
        let dir = std::env::temp_dir().join(format!("bls-ops-kb-dir-{}.md", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let error = read_markdown_file(dir.to_str().unwrap()).expect_err("目录必须被拒");
        assert!(error.contains("不是文件"), "{error}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
