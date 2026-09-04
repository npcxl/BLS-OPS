//! editor_sync 纯函数与模型测试（固定样本，无 I/O）。

use super::is_temp_artifact;
use super::model::{EditorSyncEventPayload, EditorSyncScope, EditorSyncStatus, SyncSessionInfo};
use std::path::{Path, PathBuf};

fn sample_info() -> SyncSessionInfo {
    SyncSessionInfo {
        id: "sync-1".to_string(),
        session_id: "ssh-1".to_string(),
        scope: EditorSyncScope::File,
        remote_path: "/etc/nginx/nginx.conf".to_string(),
        local_path: "C:\\Temp\\bls-ops-editor-sync\\sync-1".to_string(),
        editor_id: "vscode".to_string(),
        editor_name: "VS Code".to_string(),
        status: EditorSyncStatus::Active,
        message: None,
        sync_count: 3,
        last_sync_at: 1_700_000_000_000,
        opened_at: 1_700_000_000_000,
    }
}

#[test]
fn temp_artifacts_are_filtered() {
    for path in [".#nginx.conf", "notes.txt~", "x.conf.swp", "x.conf.swx", "a.tmp", "4913"] {
        assert!(is_temp_artifact(Path::new(path)), "{path} 应被过滤");
    }
    for path in ["nginx.conf", "script.lua", "data.sql", "4914", "notes.md"] {
        assert!(!is_temp_artifact(Path::new(path)), "{path} 不应被过滤");
    }
}

#[test]
fn event_path_strips_windows_extended_prefix() {
    let normalized = super::sync::normalize_event_path(PathBuf::from(r"\\?\C:\Temp\a.conf"));
    assert_eq!(normalized, PathBuf::from(r"C:\Temp\a.conf"));

    let unc = super::sync::normalize_event_path(PathBuf::from(r"\\?\UNC\server\share\a.conf"));
    assert_eq!(unc, PathBuf::from(r"\\server\share\a.conf"));

    let plain = super::sync::normalize_event_path(PathBuf::from("/tmp/a.conf"));
    assert_eq!(plain, PathBuf::from("/tmp/a.conf"));
}

#[test]
fn payload_is_camel_case_with_snake_case_enums() {
    let payload = EditorSyncEventPayload::upsert(sample_info());
    let json = serde_json::to_value(&payload).unwrap();
    let session = json.get("session").unwrap();
    assert_eq!(json.get("kind").unwrap(), "upsert");
    for key in ["sessionId", "remotePath", "localPath", "editorId", "editorName", "syncCount", "lastSyncAt", "openedAt"] {
        assert!(session.get(key).is_some(), "缺少 camelCase 字段 {key}");
    }
    assert!(!session.get("session_id").is_some(), "字段必须是 camelCase");
    assert_eq!(session.get("scope").unwrap(), "file");
    assert_eq!(session.get("status").unwrap(), "active");
}

#[test]
fn scope_and_status_enum_values_match_frontend() {
    assert_eq!(
        serde_json::to_value(EditorSyncScope::Directory).unwrap(),
        "directory"
    );
    for (value, expected) in [
        (EditorSyncStatus::Starting, "starting"),
        (EditorSyncStatus::Active, "active"),
        (EditorSyncStatus::Error, "error"),
        (EditorSyncStatus::Closed, "closed"),
    ] {
        assert_eq!(serde_json::to_value(value).unwrap(), expected);
    }
}

#[test]
fn error_message_round_trips() {
    let mut info = sample_info();
    info.status = EditorSyncStatus::Error;
    info.message = Some("保存未同步：SSH 会话不存在或已断开".to_string());
    let json = serde_json::to_value(&info).unwrap();
    assert_eq!(
        json.get("message").unwrap(),
        "保存未同步：SSH 会话不存在或已断开"
    );
}
