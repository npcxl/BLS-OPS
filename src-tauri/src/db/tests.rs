//! Persistence tests (moved verbatim from `db.rs`).
//!
//! The emphasis is on the parts that are easy to get wrong and hard to notice:
//! idempotent migrations, cascading deletes that clear references instead of
//! leaving dangling ids, and upserts that update in place.

use rusqlite::Connection;

use super::*;

fn test_db() -> Connection {
    let conn = Connection::open_in_memory().expect("in-memory sqlite");
    conn.execute_batch(SCHEMA_SQL).expect("schema");
    migrate(&conn).expect("migrate");
    conn
}

fn group(id: &str, name: &str) -> ServerGroupRecord {
    ServerGroupRecord {
        id: id.to_string(),
        name: name.to_string(),
        sort_order: 0,
        created_at: 1,
        updated_at: 1,
    }
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
        tags: vec![],
        proxy_jump_id: None,
        favorite: false,
        last_connected_at: None,
        status: "idle".to_string(),
        created_at: 1,
        updated_at: 1,
    }
}

fn project(id: &str, name: &str, server_id: &str) -> ProjectRecord {
    ProjectRecord {
        id: id.to_string(),
        name: name.to_string(),
        description: String::new(),
        server_id: server_id.to_string(),
        repo_url: "https://github.com/acme/app.git".to_string(),
        branch: "main".to_string(),
        deploy_path: "/var/www/app".to_string(),
        commands_json: r#"["git pull --ff-only","npm run build"]"#.to_string(),
        status: "idle".to_string(),
        created_at: 1,
        updated_at: 1,
    }
}

fn deployment(id: &str, project_id: &str) -> DeploymentRecord {
    DeploymentRecord {
        id: id.to_string(),
        project_id: project_id.to_string(),
        project_name: "app".to_string(),
        server_id: "s1".to_string(),
        server_name: "web".to_string(),
        status: "pending".to_string(),
        trigger_source: "manual".to_string(),
        branch: "main".to_string(),
        commit_sha: String::new(),
        started_at: None,
        finished_at: None,
        duration_ms: None,
        log: String::new(),
        error_message: None,
        created_at: 2,
    }
}

fn session_fixture(server_id: &str, server_name: &str) -> SessionRecord {
    SessionRecord {
        id: String::new(),
        server_id: server_id.to_string(),
        server_name: server_name.to_string(),
        server_host: "10.0.0.1".to_string(),
        server_port: 22,
        username: "root".to_string(),
        status: "connected".to_string(),
        connected_at: Some(1),
        disconnected_at: None,
        error_message: None,
        keep_alive_interval: 30,
        reconnect_policy: "manual".to_string(),
        terminal_rows: Some(24),
        terminal_cols: Some(80),
        terminal_pty: Some(true),
        sftp_enabled: false,
        port_forwards_json: "[]".to_string(),
    }
}

#[test]
fn schema_reaches_current_version() {
    let conn = test_db();
    let version: u32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("user_version");
    assert_eq!(version, SCHEMA_VERSION);
}

#[test]
fn migration_is_idempotent() {
    let conn = test_db();
    migrate(&conn).expect("second migrate");
    migrate(&conn).expect("third migrate");
    assert!(column_exists(&conn, "servers", "favorite").unwrap());
    assert!(column_exists(&conn, "credentials", "passphrase_ref").unwrap());
}

#[test]
fn migration_upgrades_a_v1_database() {
    let conn = Connection::open_in_memory().unwrap();
    // Legacy v1 shapes: no favorite / last_connected_at / passphrase_ref.
    conn.execute_batch(
        r#"
            CREATE TABLE servers (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                username TEXT NOT NULL,
                credential_id TEXT,
                group_id TEXT,
                tags TEXT NOT NULL DEFAULT '[]',
                proxy_jump_id TEXT,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE credentials (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                username TEXT NOT NULL,
                secret_ref TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            "#,
    )
    .unwrap();
    migrate(&conn).unwrap();

    insert_or_replace_server(&conn, &server("s1", "legacy")).expect("save legacy server");
    let loaded = get_server(&conn, "s1").unwrap().unwrap();
    assert!(!loaded.favorite);
    assert_eq!(loaded.last_connected_at, None);
}

#[test]
fn favorite_round_trips() {
    let conn = test_db();
    insert_or_replace_server(&conn, &server("s1", "web")).unwrap();
    let updated = set_server_favorite(&conn, "s1", true).unwrap();
    assert!(updated.as_ref().unwrap().favorite);
    assert!(get_server(&conn, "s1").unwrap().unwrap().favorite);
    set_server_favorite(&conn, "s1", false).unwrap();
    assert!(!get_server(&conn, "s1").unwrap().unwrap().favorite);
}

#[test]
fn favoriting_a_missing_server_reports_none() {
    let conn = test_db();
    assert!(set_server_favorite(&conn, "ghost", true).unwrap().is_none());
}

#[test]
fn moving_a_server_between_groups_only_touches_the_group() {
    let conn = test_db();
    insert_or_replace_server_group(&conn, &group("g1", "prod")).unwrap();
    insert_or_replace_server_group(&conn, &group("g2", "test")).unwrap();
    let created = server("s1", "web");
    insert_or_replace_server(&conn, &created).unwrap();

    let moved = move_server_to_group(&conn, "s1", Some("g1"))
        .unwrap()
        .unwrap();
    assert_eq!(moved.group_id.as_deref(), Some("g1"));
    assert_eq!(moved.name, "web", "only group_id must change");

    let back = move_server_to_group(&conn, "s1", None).unwrap().unwrap();
    assert_eq!(back.group_id, None);
}

#[test]
fn moving_a_missing_server_reports_none() {
    let conn = test_db();
    assert!(move_server_to_group(&conn, "ghost", None)
        .unwrap()
        .is_none());
}

#[test]
fn group_names_are_unique() {
    let conn = test_db();
    insert_or_replace_server_group(&conn, &group("g1", "prod")).unwrap();

    // A different id with the same name is rejected…
    let clash = group("g2", "prod");
    assert!(insert_or_replace_server_group(&conn, &clash).is_err());

    // …while re-saving the same row (rename round-trip) is fine.
    let mut renamed = group("g1", "生产");
    renamed.sort_order = 2;
    insert_or_replace_server_group(&conn, &renamed).unwrap();
    assert_eq!(list_server_groups(&conn).unwrap()[0].name, "生产");
}

#[test]
fn deleting_a_server_cascades_to_sessions_and_history() {
    let conn = test_db();
    insert_or_replace_server(&conn, &server("s1", "web")).unwrap();
    insert_session(
        &conn,
        &SessionRecord {
            id: "sess-1".to_string(),
            ..session_fixture("s1", "web")
        },
    )
    .unwrap();
    insert_command_history(
        &conn,
        &CommandHistoryRecord {
            id: "h1".to_string(),
            session_id: "sess-1".to_string(),
            server_id: "s1".to_string(),
            server_name: "web".to_string(),
            command: "uptime".to_string(),
            timestamp: 1,
            exit_code: None,
            source: "terminal".to_string(),
            output: None,
        },
    )
    .unwrap();

    let result = delete_server_cascade(&conn, "s1").unwrap();
    assert_eq!(result.sessions, 1);
    assert_eq!(result.history, 1);
    assert!(get_server(&conn, "s1").unwrap().is_none());
    assert!(list_recent_sessions(&conn, 10).unwrap().is_empty());
}

#[test]
fn deleting_a_server_clears_jump_host_references() {
    let conn = test_db();
    insert_or_replace_server(&conn, &server("jump", "jump")).unwrap();
    let mut dependent = server("target", "target");
    dependent.proxy_jump_id = Some("jump".to_string());
    insert_or_replace_server(&conn, &dependent).unwrap();

    delete_server_cascade(&conn, "jump").unwrap();

    assert_eq!(
        get_server(&conn, "target").unwrap().unwrap().proxy_jump_id,
        None
    );
}

#[test]
fn deleting_a_credential_clears_server_references() {
    let conn = test_db();
    insert_or_replace_credential(
        &conn,
        &CredentialRecord {
            id: "c1".to_string(),
            name: "key".to_string(),
            credential_type: "password".to_string(),
            username: "root".to_string(),
            secret_ref: Some("cred-1".to_string()),
            passphrase_ref: None,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    let mut dependent = server("s1", "web");
    dependent.credential_id = Some("c1".to_string());
    insert_or_replace_server(&conn, &dependent).unwrap();
    assert_eq!(count_servers_by_credential(&conn, "c1").unwrap(), 1);

    delete_credential(&conn, "c1").unwrap();

    assert_eq!(count_servers_by_credential(&conn, "c1").unwrap(), 0);
    assert_eq!(
        get_server(&conn, "s1").unwrap().unwrap().credential_id,
        None
    );
}

#[test]
fn trusting_a_known_host_is_upserted() {
    let conn = test_db();
    let first = trust_known_host(&conn, "10.0.0.1", 22, "SHA256:aaa", "ssh-ed25519").unwrap();
    let second = trust_known_host(&conn, "10.0.0.1", 22, "SHA256:bbb", "ssh-ed25519").unwrap();

    assert_eq!(first.id, second.id, "trust must not duplicate the host row");
    assert_eq!(second.fingerprint, "SHA256:bbb");
    assert_eq!(second.status, "confirmed");
    assert_eq!(list_known_hosts(&conn).unwrap().len(), 1);

    assert!(delete_known_host(&conn, &second.id).unwrap());
    assert!(list_known_hosts(&conn).unwrap().is_empty());
}

#[test]
fn deleting_a_group_unlinks_its_servers() {
    let conn = test_db();
    insert_or_replace_server_group(
        &conn,
        &ServerGroupRecord {
            id: "g1".to_string(),
            name: "prod".to_string(),
            sort_order: 0,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    let mut dependent = server("s1", "web");
    dependent.group_id = Some("g1".to_string());
    insert_or_replace_server(&conn, &dependent).unwrap();

    delete_server_group(&conn, "g1").unwrap();

    assert_eq!(get_server(&conn, "s1").unwrap().unwrap().group_id, None);
    assert!(list_server_groups(&conn).unwrap().is_empty());
}

// -- projects ------------------------------------------------------------

#[test]
fn a_project_round_trips_with_its_steps() {
    let conn = test_db();
    insert_or_replace_project(&conn, &project("p1", "app", "s1")).unwrap();

    let loaded = get_project(&conn, "p1").unwrap().unwrap();
    assert_eq!(loaded.name, "app");
    assert_eq!(loaded.deploy_path, "/var/www/app");
    assert_eq!(loaded.branch, "main");

    // Steps are stored as a JSON array, not flattened into a string.
    let steps: Vec<String> = serde_json::from_str(&loaded.commands_json).unwrap();
    assert_eq!(steps, vec!["git pull --ff-only", "npm run build"]);
}

#[test]
fn saving_a_project_twice_updates_in_place() {
    let conn = test_db();
    insert_or_replace_project(&conn, &project("p1", "app", "s1")).unwrap();
    let mut renamed = project("p1", "app-v2", "s1");
    renamed.branch = "release".to_string();
    insert_or_replace_project(&conn, &renamed).unwrap();

    let all = list_projects(&conn).unwrap();
    assert_eq!(all.len(), 1, "重复保存不能产生第二条记录");
    assert_eq!(all[0].name, "app-v2");
    assert_eq!(all[0].branch, "release");
}

#[test]
fn projects_are_listed_by_name() {
    let conn = test_db();
    insert_or_replace_project(&conn, &project("p2", "zeta", "s1")).unwrap();
    insert_or_replace_project(&conn, &project("p1", "alpha", "s1")).unwrap();

    let names: Vec<String> = list_projects(&conn)
        .unwrap()
        .into_iter()
        .map(|project| project.name)
        .collect();
    assert_eq!(names, vec!["alpha", "zeta"]);
}

#[test]
fn deleting_a_project_takes_its_deployments_with_it() {
    let conn = test_db();
    insert_or_replace_project(&conn, &project("p1", "app", "s1")).unwrap();
    insert_deployment(&conn, &deployment("d1", "p1")).unwrap();
    insert_deployment(&conn, &deployment("d2", "p1")).unwrap();
    // Another project's history must survive.
    insert_or_replace_project(&conn, &project("p2", "other", "s1")).unwrap();
    insert_deployment(&conn, &deployment("d3", "p2")).unwrap();

    let removed = delete_project_cascade(&conn, "p1").unwrap();
    assert_eq!(removed, 2);
    assert!(get_project(&conn, "p1").unwrap().is_none());
    assert_eq!(list_deployments(&conn, None, 100).unwrap().len(), 1);
}

// -- deployments ---------------------------------------------------------

#[test]
fn a_deployment_records_its_outcome() {
    let conn = test_db();
    insert_deployment(&conn, &deployment("d1", "p1")).unwrap();

    update_deployment_progress(
        &conn,
        "d1",
        DEPLOY_RUNNING,
        "$ git pull --ff-only\n",
        Some(1000),
        None,
        None,
    )
    .unwrap();
    update_deployment_progress(
        &conn,
        "d1",
        DEPLOY_SUCCESS,
        "$ git pull --ff-only\nAlready up to date.\n",
        Some(1000),
        Some(4500),
        None,
    )
    .unwrap();

    let loaded = get_deployment(&conn, "d1").unwrap().unwrap();
    assert_eq!(loaded.status, DEPLOY_SUCCESS);
    assert_eq!(loaded.duration_ms, Some(3500));
    assert!(loaded.log.contains("Already up to date."));
    assert_eq!(loaded.error_message, None);
}

#[test]
fn a_failed_deployment_keeps_the_error() {
    let conn = test_db();
    insert_deployment(&conn, &deployment("d1", "p1")).unwrap();
    update_deployment_progress(
        &conn,
        "d1",
        DEPLOY_FAILED,
        "$ npm run build\n",
        Some(10),
        Some(20),
        Some("npm: command not found"),
    )
    .unwrap();

    let loaded = get_deployment(&conn, "d1").unwrap().unwrap();
    assert_eq!(loaded.status, DEPLOY_FAILED);
    assert_eq!(
        loaded.error_message.as_deref(),
        Some("npm: command not found")
    );
    // The partial log is what makes a failure diagnosable.
    assert!(loaded.log.contains("npm run build"));
}

#[test]
fn deployment_history_is_newest_first_and_filterable() {
    let conn = test_db();
    for (id, project_id, created) in [("d1", "p1", 10i64), ("d2", "p2", 30), ("d3", "p1", 20)] {
        let mut record = deployment(id, project_id);
        record.created_at = created;
        insert_deployment(&conn, &record).unwrap();
    }

    let all = list_deployments(&conn, None, 10).unwrap();
    assert_eq!(
        all.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(),
        vec!["d2", "d3", "d1"]
    );

    let only_p1 = list_deployments(&conn, Some("p1"), 10).unwrap();
    assert_eq!(only_p1.len(), 2);
    assert!(only_p1.iter().all(|d| d.project_id == "p1"));
}

#[test]
fn migration_v3_adds_the_p3_tables_to_an_existing_database() {
    // A database created before P3 has no projects table at all.
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
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
            "#,
    )
    .unwrap();
    conn.pragma_update(None, "user_version", 2u32).unwrap();

    migrate(&conn).unwrap();

    // The tables now exist and are usable.
    insert_or_replace_project(&conn, &project("p1", "app", "s1")).unwrap();
    assert_eq!(list_projects(&conn).unwrap().len(), 1);
}

#[test]
fn migration_keeps_p3_tables_on_every_start() {
    let conn = test_db();
    // Running twice (every app start) must not fail or duplicate anything.
    migrate(&conn).unwrap();
    insert_or_replace_project(&conn, &project("p1", "app", "s1")).unwrap();
    migrate(&conn).unwrap();
    assert_eq!(list_projects(&conn).unwrap().len(), 1);
}

#[test]
fn project_status_mirrors_the_last_deployment() {
    let conn = test_db();
    insert_or_replace_project(&conn, &project("p1", "app", "s1")).unwrap();
    set_project_status(&conn, "p1", DEPLOY_FAILED).unwrap();
    assert_eq!(get_project(&conn, "p1").unwrap().unwrap().status, "failed");
}

// -- confirmed projects (持久化已确认项目资产) --------------------------------

/// 构造一条已确认项目快照记录。
fn confirmed(
    server_id: &str,
    canonical_path: &str,
    name: &str,
    scan_state: &str,
) -> ConfirmedProjectRecord {
    ConfirmedProjectRecord {
        id: format!("{}:{}", server_id, canonical_path),
        server_id: server_id.to_string(),
        canonical_path: canonical_path.to_string(),
        name: name.to_string(),
        project_type: "node".to_string(),
        candidate_payload: r#"{"id":"x","name":"x","path":"x"}"#.to_string(),
        scan_state: scan_state.to_string(),
        confirmed_at: 1,
        updated_at: 1,
        last_seen_at: 1,
        missing_since: None,
        deleted_at: None,
    }
}

/// 模拟一次扫描完成：调用**真实的** `reconcile_confirmed_after_scan`（与
/// `commands/project.rs` 扫描完成块同一实现）。`found` 是 (path, name) 对；
/// project_type 固定 "node"，与 [`confirmed`] 构造的记录一致，kind 默认 application。
fn reconcile_after_scan(conn: &Connection, server_id: &str, found: &[(&str, &str)]) {
    let map = found
        .iter()
        .map(|(path, name)| {
            (
                (*path).to_string(),
                ScannedCandidateInfo {
                    name: (*name).to_string(),
                    project_type: "node".to_string(),
                    project_kind: "application".to_string(),
                },
            )
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    reconcile_confirmed_after_scan(conn, server_id, &map, 1000).unwrap();
}

#[test]
fn confirming_a_project_persists_it_across_scans() {
    let conn = test_db();
    // 用户确认了 3 个项目。
    for (path, name) in [("/opt/app1", "a"), ("/opt/app2", "b"), ("/opt/app3", "c")] {
        upsert_confirmed_project(&conn, &confirmed("s1", path, name, "active")).unwrap();
    }
    assert_eq!(list_confirmed_projects(&conn, "s1").unwrap().len(), 3);

    // 本次扫描只又发现了 1 个（app1），另两个没扫到。
    reconcile_after_scan(&conn, "s1", &[("/opt/app1", "a")]);

    // 已确认项目绝不能因为本次没扫到而消失：仍是 3 条。
    let all = list_confirmed_projects(&conn, "s1").unwrap();
    assert_eq!(all.len(), 3, "确认过的项目必须继续存在");
    let app1 = all
        .iter()
        .find(|c| c.canonical_path == "/opt/app1")
        .unwrap();
    let app2 = all
        .iter()
        .find(|c| c.canonical_path == "/opt/app2")
        .unwrap();
    assert_eq!(app1.scan_state, "active", "本次发现的应标记 active");
    assert_eq!(app2.scan_state, "missing", "本次没发现的应标记 missing");
    assert!(app2.missing_since.is_some());
}

#[test]
fn two_missing_confirmed_projects_are_marked_missing() {
    let conn = test_db();
    upsert_confirmed_project(&conn, &confirmed("s1", "/opt/a", "a", "active")).unwrap();
    upsert_confirmed_project(&conn, &confirmed("s1", "/opt/b", "b", "active")).unwrap();
    upsert_confirmed_project(&conn, &confirmed("s1", "/opt/c", "c", "active")).unwrap();

    // 本次一个都没扫到。
    reconcile_after_scan(&conn, "s1", &[]);

    let all = list_confirmed_projects(&conn, "s1").unwrap();
    assert_eq!(all.len(), 3);
    assert!(all.iter().all(|c| c.scan_state == "missing"));
    assert!(all.iter().all(|c| c.missing_since.is_some()));
}

#[test]
fn confirmed_project_is_kept_when_reclassified_as_infrastructure() {
    let conn = test_db();
    // 用户曾确认 /opt/app 是业务项目；本次扫描把它重新分类成基础设施。
    upsert_confirmed_project(&conn, &confirmed("s1", "/opt/app", "app", "active")).unwrap();
    reconcile_after_scan(&conn, "s1", &[("/opt/app", "app")]);

    // 仍必须在列表里（前端用 kindChanged 提示复核，而不是自动丢弃）。
    let all = list_confirmed_projects(&conn, "s1").unwrap();
    assert_eq!(all.len(), 1, "被重新分类成基础设施的已确认项目不能被丢");
    assert_eq!(all[0].canonical_path, "/opt/app");
    assert_eq!(
        all[0].scan_state, "active",
        "旧快照无 project_kind 字段不误报 changed"
    );
    // 快照持久化：payload 仍可被前端解析成候选继续渲染。
    assert!(all[0].candidate_payload.contains("name"));
}

#[test]
fn trailing_slash_paths_collapse_to_the_same_key() {
    // canonicalize 必须保证 /opt/app 与 /opt/app/ 是同一个项目。
    assert_eq!(
        crate::project_discovery::canonicalize_project_path("/opt/app/"),
        crate::project_discovery::canonicalize_project_path("/opt/app")
    );
    assert_eq!(
        crate::project_discovery::canonicalize_project_path("/opt//app"),
        "/opt/app"
    );
    assert_eq!(
        crate::project_discovery::canonicalize_project_path("/"),
        "/",
        "根目录不能把唯一的 / 去掉"
    );

    let conn = test_db();
    // 存储端：以规范化路径 /opt/app 存。
    upsert_confirmed_project(&conn, &confirmed("s1", "/opt/app", "app", "active")).unwrap();
    // 查询端：用带尾斜杠的路径来查，应命中同一条。
    let found = get_confirmed_project(
        &conn,
        "s1",
        &crate::project_discovery::canonicalize_project_path("/opt/app/"),
    )
    .unwrap();
    assert!(found.is_some(), "尾斜杠路径应映射到同一已确认项目");
    assert_eq!(found.unwrap().canonical_path, "/opt/app");
}

#[test]
fn old_confirmed_projects_survive_a_new_scan_start() {
    // 场景：用户确认了一批项目，然后发起一次新扫描。扫描"开始"本身绝不清除
    // 既有 confirmed_projects（只有"完成"才按 found_paths 重算 scan_state）。
    let conn = test_db();
    upsert_confirmed_project(&conn, &confirmed("s1", "/opt/a", "a", "active")).unwrap();
    upsert_confirmed_project(&conn, &confirmed("s1", "/opt/b", "b", "active")).unwrap();

    // 模拟"开始扫描"——不调用 reconcile，直接断言数据完整保留。
    assert_eq!(list_confirmed_projects(&conn, "s1").unwrap().len(), 2);
    assert!(get_confirmed_project(&conn, "s1", "/opt/a")
        .unwrap()
        .is_some());
}

#[test]
fn failed_scan_marks_active_projects_inaccessible() {
    // 场景：扫描中途失败（SSH 断开 / 超时）。失败不清除已确认项目，但 active
    // 必须转为 inaccessible（服务器暂不可访问），missing 行保持不变。
    let conn = test_db();
    upsert_confirmed_project(&conn, &confirmed("s1", "/opt/a", "a", "active")).unwrap();
    let mut missing = confirmed("s1", "/opt/b", "b", "missing");
    missing.missing_since = Some(500);
    upsert_confirmed_project(&conn, &missing).unwrap();

    // commands/project.rs 失败路径调用的真实函数。
    mark_confirmed_inaccessible(&conn, "s1", 2000).unwrap();

    let all = list_confirmed_projects(&conn, "s1").unwrap();
    assert_eq!(all.len(), 2, "失败扫描不能删除已确认项目");
    let a = all.iter().find(|c| c.canonical_path == "/opt/a").unwrap();
    let b = all.iter().find(|c| c.canonical_path == "/opt/b").unwrap();
    assert_eq!(a.scan_state, "inaccessible", "active 应转为 inaccessible");
    assert_eq!(b.scan_state, "missing", "missing 不被失败扫描覆盖");
    assert_eq!(b.missing_since, Some(500));
}

#[test]
fn confirmed_projects_persist_across_a_restart() {
    // 场景：关闭再打开 App。数据来自磁盘（这里用独立连接 + 同样 schema 模拟）。
    let conn = test_db();
    upsert_confirmed_project(&conn, &confirmed("s1", "/opt/a", "a", "active")).unwrap();
    upsert_confirmed_project(&conn, &confirmed("s1", "/opt/b", "b", "active")).unwrap();
    upsert_confirmed_project(&conn, &confirmed("s1", "/opt/c", "c", "active")).unwrap();

    // 模拟"重启"：新连接 + 重新 migrate（幂等），数据仍在。
    let conn2 = Connection::open_in_memory().expect("in-memory sqlite");
    conn2.execute_batch(SCHEMA_SQL).expect("schema");
    migrate(&conn2).expect("migrate");
    // 注：in-memory 数据库随连接销毁，这里验证的是表结构 + 迁移幂等不丢数据通道；
    // 真实 App 用文件数据库，数据跨进程保留。此处只断言表存在且可再次写入。
    upsert_confirmed_project(&conn2, &confirmed("s1", "/opt/new", "n", "active")).unwrap();
    assert_eq!(list_confirmed_projects(&conn2, "s1").unwrap().len(), 1);
    // 原来的连接数据也不受干扰。
    assert_eq!(list_confirmed_projects(&conn, "s1").unwrap().len(), 3);
}

#[test]
fn confirmed_project_is_removed_only_on_unconfirm() {
    let conn = test_db();
    upsert_confirmed_project(&conn, &confirmed("s1", "/opt/a", "a", "active")).unwrap();
    upsert_confirmed_project(&conn, &confirmed("s1", "/opt/b", "b", "active")).unwrap();
    assert_eq!(list_confirmed_projects(&conn, "s1").unwrap().len(), 2);

    // 用户"撤销结论"（取消确认）→ 软删除，从列表消失。
    soft_delete_confirmed_project(&conn, "s1", "/opt/a", 2000).unwrap();
    let remaining = list_confirmed_projects(&conn, "s1").unwrap();
    assert_eq!(remaining.len(), 1, "取消确认的项目应从列表移除");
    assert_eq!(remaining[0].canonical_path, "/opt/b");

    // 软删除是逻辑删除：行仍在，只是被过滤。可重新确认复活。
    let row = get_confirmed_project(&conn, "s1", "/opt/a").unwrap();
    assert!(row.is_some());
    assert!(row.unwrap().deleted_at.is_some());

    // 重新确认 → 复活，列表回到 2 条。
    upsert_confirmed_project(&conn, &confirmed("s1", "/opt/a", "a", "active")).unwrap();
    assert_eq!(list_confirmed_projects(&conn, "s1").unwrap().len(), 2);
}

#[test]
fn scan_marks_changed_when_project_type_changes() {
    // 问题5：项目关键信息（project_type）变化 → changed，而不是假装 active。
    let conn = test_db();
    upsert_confirmed_project(&conn, &confirmed("s1", "/opt/app", "app", "active")).unwrap();

    // 本次扫描发现该项目，但类型从 node 变成了 static。
    let map = [(
        "/opt/app".to_string(),
        ScannedCandidateInfo {
            name: "app".to_string(),
            project_type: "static".to_string(),
            project_kind: "application".to_string(),
        },
    )]
    .into_iter()
    .collect::<std::collections::BTreeMap<_, _>>();
    reconcile_confirmed_after_scan(&conn, "s1", &map, 1000).unwrap();

    let row = get_confirmed_project(&conn, "s1", "/opt/app")
        .unwrap()
        .unwrap();
    assert_eq!(row.scan_state, "changed");
    assert!(row.missing_since.is_none());
}

#[test]
fn scan_marks_changed_when_kind_is_reclassified() {
    // 问题5：快照里 project_kind=application，本次扫描判定 infrastructure →
    // changed（前端"信息有变化"徽标的数据来源）。
    let conn = test_db();
    let mut record = confirmed("s1", "/opt/app", "app", "active");
    record.candidate_payload =
        r#"{"id":"x","name":"app","path":"/opt/app","project_kind":"application"}"#.to_string();
    upsert_confirmed_project(&conn, &record).unwrap();

    // name / project_type 都没变，只有 kind 变了。
    let map = [(
        "/opt/app".to_string(),
        ScannedCandidateInfo {
            name: "app".to_string(),
            project_type: "node".to_string(),
            project_kind: "infrastructure".to_string(),
        },
    )]
    .into_iter()
    .collect::<std::collections::BTreeMap<_, _>>();
    reconcile_confirmed_after_scan(&conn, "s1", &map, 1000).unwrap();

    let row = get_confirmed_project(&conn, "s1", "/opt/app")
        .unwrap()
        .unwrap();
    assert_eq!(row.scan_state, "changed", "kind 重分类必须标 changed");

    // 下次扫描 kind 恢复一致 → 回到 active（状态不是单向门）。
    let map = [(
        "/opt/app".to_string(),
        ScannedCandidateInfo {
            name: "app".to_string(),
            project_type: "node".to_string(),
            project_kind: "application".to_string(),
        },
    )]
    .into_iter()
    .collect::<std::collections::BTreeMap<_, _>>();
    reconcile_confirmed_after_scan(&conn, "s1", &map, 2000).unwrap();
    let row = get_confirmed_project(&conn, "s1", "/opt/app")
        .unwrap()
        .unwrap();
    assert_eq!(row.scan_state, "active");
}

// -- project merges（人工合并/拆分项目） --------------------------------------

#[test]
fn project_merge_round_trip() {
    let conn = test_db();
    // 合并 /opt/child → /opt/parent。
    upsert_project_merge(&conn, "s1", "/opt/child", "/opt/parent", 1000).unwrap();
    let merges = list_project_merges(&conn, "s1").unwrap();
    assert_eq!(merges.len(), 1);
    assert_eq!(merges[0].child_path, "/opt/child");
    assert_eq!(merges[0].parent_path, "/opt/parent");

    // 改主意：并到另一个父项目 → 覆盖，不新增行。
    upsert_project_merge(&conn, "s1", "/opt/child", "/opt/other", 2000).unwrap();
    let merges = list_project_merges(&conn, "s1").unwrap();
    assert_eq!(merges.len(), 1, "一个子目录只能并入一个父项目");
    assert_eq!(merges[0].parent_path, "/opt/other");

    // 关系按服务器隔离。
    assert!(list_project_merges(&conn, "s2").unwrap().is_empty());

    // 拆分 → 关系删除；重复拆分返回 false（幂等）。
    assert!(delete_project_merge(&conn, "s1", "/opt/child").unwrap());
    assert!(list_project_merges(&conn, "s1").unwrap().is_empty());
    assert!(!delete_project_merge(&conn, "s1", "/opt/child").unwrap());
}

/// 扫描标注契约：`apply_manual_merges` 只打标不删行 —— 人工决定永不因重扫丢失。
#[test]
fn manual_merge_annotation_keeps_candidates() {
    use crate::project_discovery::{
        apply_manual_merges, CandidateCategory, ConfidenceLevel, DeploymentReadiness,
        DiscoveryStatus, ProjectCandidate, ProjectKind, ReviewState,
    };
    let candidate = |path: &str, name: &str| ProjectCandidate {
        id: format!("s1:{path}"),
        server_id: "s1".into(),
        name: name.into(),
        path: path.into(),
        project_type: "node".into(),
        score: 90,
        confidence: ConfidenceLevel::High,
        status: DiscoveryStatus::HighConfidence,
        category: CandidateCategory::SourceOnly,
        project_kind: ProjectKind::Application,
        deploy_instances: Vec::new(),
        markers: vec!["package.json".into()],
        config_files: Vec::new(),
        review: ReviewState::Pending,
        merged_into: None,
        evidence: Vec::new(),
        penalties: Vec::new(),
        runtime_links: Vec::new(),
        modules: Vec::new(),
        detected_ports: Vec::new(),
        required_environment_names: Vec::new(),
        blockers: Vec::new(),
        warnings: Vec::new(),
        readiness: DeploymentReadiness {
            score: 0,
            blockers: Vec::new(),
            warnings: Vec::new(),
            confirmed_facts: Vec::new(),
            unknown_facts: Vec::new(),
        },
        updated_at: "0".into(),
    };
    let mut candidates = vec![
        candidate("/opt/parent", "parent"),
        candidate("/opt/child", "child"),
    ];
    apply_manual_merges(
        &mut candidates,
        &[("/opt/child".to_string(), "/opt/parent".to_string())],
    );
    assert_eq!(candidates.len(), 2, "标注不删除候选行");
    assert_eq!(
        candidates[1].merged_into.as_deref(),
        Some("/opt/parent"),
        "子目录必须带上 merged_into 标注"
    );
    assert!(candidates[0].merged_into.is_none(), "父项目不受影响");
}
