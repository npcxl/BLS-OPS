//! 备份格式、预览与事务性导入的固定样本测试。

use super::*;
use crate::db::SCHEMA_SQL;

fn db() -> Connection {
    let conn = Connection::open_in_memory().expect("in-memory db");
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    conn.execute_batch(SCHEMA_SQL).expect("schema");
    conn
}

fn server(id: &str, name: &str) -> ServerRecord {
    ServerRecord {
        id: id.to_string(),
        name: name.to_string(),
        host: "10.0.0.1".to_string(),
        port: 22,
        username: "root".to_string(),
        credential_id: None,
        group_id: None,
        tags: vec!["prod".to_string()],
        proxy_jump_id: None,
        favorite: false,
        last_connected_at: None,
        status: "unknown".to_string(),
        environment: "unspecified".to_string(),
        created_at: 1,
        updated_at: 1,
    }
}

fn credential(id: &str) -> CredentialRecord {
    CredentialRecord {
        id: id.to_string(),
        name: "deploy".to_string(),
        credential_type: "key".to_string(),
        username: "root".to_string(),
        secret_ref: Some("keyring://secret".to_string()),
        passphrase_ref: Some("keyring://pass".to_string()),
        created_at: 1,
        updated_at: 1,
    }
}

fn project(id: &str, path: &str) -> ConfirmedProjectRecord {
    ConfirmedProjectRecord {
        id: id.to_string(),
        server_id: "s1".to_string(),
        canonical_path: path.to_string(),
        name: "shop".to_string(),
        project_type: "node".to_string(),
        candidate_payload: "{}".to_string(),
        scan_state: "active".to_string(),
        confirmed_at: 1,
        updated_at: 1,
        last_seen_at: 1,
        missing_since: None,
        deleted_at: None,
    }
}

/// 把一份最小备份写进一个空库。
fn seed_database(conn: &Connection) {
    conn.execute(
        "INSERT INTO servers (id, name, host, port, username, credential_id, group_id, tags,
                              proxy_jump_id, favorite, last_connected_at, status, created_at, updated_at)
         VALUES ('s1', 'web', '10.0.0.1', 22, 'root', NULL, NULL, '[\"prod\"]', NULL, 0, NULL, 'unknown', 1, 1)",
        [],
    )
    .unwrap();
}

#[test]
fn export_never_carries_secrets() {
    let conn = db();
    crate::db::insert_or_replace_credential(&conn, &credential("c1")).unwrap();

    let backup = collect(&conn, "0.1.0", None).unwrap();

    assert_eq!(backup.format, BACKUP_FORMAT);
    assert_eq!(backup.version, BACKUP_VERSION);
    assert_eq!(backup.credentials.len(), 1);
    // 密钥引用必须被清空：换台机器上它本来就无效，留着只会误导。
    assert!(backup.credentials[0].secret_ref.is_none());
    assert!(backup.credentials[0].passphrase_ref.is_none());
}

#[test]
fn preview_counts_added_and_conflicts() {
    let conn = db();
    seed_database(&conn);

    let mut backup = collect(&conn, "0.1.0", None).unwrap();
    // 同一份备份再导入一次 → 全部是冲突。
    let first = preview(&conn, &backup).unwrap();
    let servers = first.sections.iter().find(|s| s.key == "servers").unwrap();
    assert_eq!(servers.total, 1);
    assert_eq!(servers.added, 0);
    assert_eq!(servers.conflicts, 1);
    assert_eq!(first.conflict_samples.len(), 1);

    // 换成一台本地没有的机器 → 新增。
    backup.servers.push(server("s2", "db"));
    let second = preview(&conn, &backup).unwrap();
    let servers = second.sections.iter().find(|s| s.key == "servers").unwrap();
    assert_eq!(servers.total, 2);
    assert_eq!(servers.added, 1);
    assert_eq!(servers.conflicts, 1);
}

#[test]
fn skip_strategy_keeps_local_rows() {
    let conn = db();
    seed_database(&conn);

    let mut backup = collect(&conn, "0.1.0", None).unwrap();
    backup.servers[0].name = "renamed-by-other-machine".to_string();

    let mut conn = conn;
    let result = apply(&mut conn, &backup, false).unwrap();

    assert_eq!(result.added, 0);
    assert_eq!(result.skipped, 1);
    let name: String = conn
        .query_row("SELECT name FROM servers WHERE id = 's1'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(name, "web", "skip 策略下本地行必须原样保留");
}

#[test]
fn overwrite_strategy_replaces_conflicts() {
    let conn = db();
    seed_database(&conn);

    let mut backup = collect(&conn, "0.1.0", None).unwrap();
    backup.servers[0].name = "renamed-by-other-machine".to_string();

    let mut conn = conn;
    let result = apply(&mut conn, &backup, true).unwrap();

    assert_eq!(result.overwritten, 1);
    let name: String = conn
        .query_row("SELECT name FROM servers WHERE id = 's1'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(name, "renamed-by-other-machine");
}

#[test]
fn a_failed_import_rolls_everything_back() {
    let mut conn = db();
    // 两条 id 不同、但 (server_id, canonical_path) 相同的项目：第二条会撞唯一索引。
    let mut backup = BackupFile {
        format: BACKUP_FORMAT.to_string(),
        version: BACKUP_VERSION,
        app_version: "0.1.0".to_string(),
        exported_at: 1,
        servers: vec![server("s1", "web")],
        groups: Vec::new(),
        credentials: Vec::new(),
        known_hosts: Vec::new(),
        projects: vec![project("p1", "/opt/shop"), project("p2", "/opt/shop")],
        project_reviews: Vec::new(),
        project_merges: Vec::new(),
        settings: None,
    };

    assert!(apply(&mut conn, &backup, true).is_err());

    // 服务器那一步在失败之前就写过了 —— 事务回滚必须把它一起撤掉。
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM servers", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0, "导入失败不能留下半份数据");

    // 修正数据后同一份备份可以正常导入。
    backup.projects[0].canonical_path = "/opt/a".to_string();
    backup.projects[1].canonical_path = "/opt/b".to_string();
    let result = apply(&mut conn, &backup, true).unwrap();
    assert_eq!(result.added, 3);
}

#[test]
fn file_round_trip_keeps_settings_and_counts() {
    let conn = db();
    seed_database(&conn);
    let backup = collect(&conn, "0.1.0", Some(serde_json::json!({ "theme": "dark" }))).unwrap();

    let path = std::env::temp_dir().join(format!("bls-ops-backup-{}.json", std::process::id()));
    let bytes = write_file(&path, &backup).unwrap();
    assert!(bytes > 0);

    let loaded = read_file(&path).unwrap();
    assert_eq!(loaded.servers.len(), 1);
    assert_eq!(loaded.settings.as_ref().unwrap()["theme"], "dark");

    let _ = std::fs::remove_file(&path);
}

#[test]
fn rejects_foreign_or_newer_files() {
    let dir = std::env::temp_dir();
    let path = dir.join(format!("bls-ops-backup-bad-{}.json", std::process::id()));

    std::fs::write(
        &path,
        br#"{"format":"something-else","version":1,"app_version":"x","exported_at":0}"#,
    )
    .unwrap();
    assert!(read_file(&path).is_err(), "别的 JSON 不能被当成备份");

    std::fs::write(
        &path,
        format!(r#"{{"format":"{BACKUP_FORMAT}","version":99,"app_version":"x","exported_at":0}}"#),
    )
    .unwrap();
    assert!(
        read_file(&path).is_err(),
        "更高版本的格式必须拒绝，不能猜字段"
    );

    let _ = std::fs::remove_file(&path);
}

#[test]
fn migration_backup_keeps_only_the_latest_copies() {
    let dir = std::env::temp_dir().join(format!("bls-ops-db-backup-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("ops.db");
    std::fs::write(&db_path, b"sqlite").unwrap();

    // 造 4 份旧备份，新的迁移备份之后应只留 AUTO_BACKUP_KEEP 份。
    for index in 0..4 {
        std::fs::write(
            dir.join(format!("ops.db.v{index}-20260101-00000{index}.bak")),
            b"x",
        )
        .unwrap();
    }
    let created = backup_before_migration(&db_path, 13).unwrap();
    assert!(created.exists());

    let kept = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".bak"))
        .count();
    assert_eq!(kept, AUTO_BACKUP_KEEP);

    let _ = std::fs::remove_dir_all(&dir);
}
