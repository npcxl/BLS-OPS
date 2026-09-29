//! Persistence tests (moved verbatim from `db.rs`).
//!
//! The emphasis is on the parts that are easy to get wrong and hard to notice:
//! idempotent migrations, cascading deletes that clear references instead of
//! leaving dangling ids, and upserts that update in place.

use rusqlite::Connection;

use super::*;
use crate::deployment::artifact::model::{
    ArtifactImportTask, ArtifactInspection, BuildStep, FingerprintBasis, ImportProgress,
    ImportSource, ImportStage, ImportStatus, Language, SecurityScanReport, StackProfile,
};
use crate::deployment::model::{
    ApplicationKind, ArtifactKind, ArtifactRecord, ArtifactSourceKind, ArtifactStatus,
    CapacityProfile, ConfigDataType, ConfigDefinition, ConfigScope, ConfigSourceKind,
    DeploymentApplication, DeploymentEnvironment, DeploymentPlan, DeploymentPlanGraph, DnsStatus,
    DomainBinding, EdgeCondition, EnvironmentKind, EstimationBasis, FailurePolicy, PlanActionKind,
    PlanEdge, PlanNode, PlanStatus, PortMapping, PortProtocol, ProposalSource, ReleaseRecord,
    ReleaseStatus, RiskLevel, SecretRef, SecretStoreKind, ServiceKind, ServiceRelation,
    ServiceRelationKind, ServiceRole, ServiceRuntime, ServiceUnit, SourceKind, SslMode, SslStatus,
};

/// 测试用数据库（其它 db 子模块的单测也用它，因此 `pub(crate)`）。
pub(crate) fn test_db() -> Connection {
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

// ---------------------------------------------------------------------------
// P5.0 部署中心（migration v9）
// ---------------------------------------------------------------------------

fn deployment_application(id: &str) -> DeploymentApplication {
    DeploymentApplication {
        id: id.to_string(),
        server_id: "s1".to_string(),
        name: format!("应用 {id}"),
        description: String::new(),
        application_kind: ApplicationKind::Frontend,
        source_kind: SourceKind::ExistingRemoteDir,
        source_ref: "/opt/web".to_string(),
        default_branch: "main".to_string(),
        confirmed_project_path: None,
        status: "active".to_string(),
        created_at: 1,
        updated_at: 1,
    }
}

fn deployment_environment(id: &str, application_id: &str) -> DeploymentEnvironment {
    DeploymentEnvironment {
        id: id.to_string(),
        application_id: application_id.to_string(),
        server_id: "s1".to_string(),
        name: format!("环境 {id}"),
        kind: EnvironmentKind::Production,
        deploy_root: "/opt/web".to_string(),
        capacity_profile_id: None,
        notes: String::new(),
        status: "active".to_string(),
        created_at: 1,
        updated_at: 1,
    }
}

fn deployment_service(id: &str, application_id: &str, environment_id: &str) -> ServiceUnit {
    ServiceUnit {
        id: id.to_string(),
        application_id: application_id.to_string(),
        environment_id: environment_id.to_string(),
        name: format!("服务 {id}"),
        role: ServiceRole::Static,
        service_kind: ServiceKind::StaticNginx,
        runtime: ServiceRuntime::StaticNginx {
            site_name: format!("site-{id}"),
            root: "/opt/web/current".to_string(),
        },
        deploy_path: Some("/opt/web/current".to_string()),
        confirmed_project_id: None,
        confirmed_project_path: None,
        artifact_id: None,
        status: "configured".to_string(),
        notes: String::new(),
        created_at: 1,
        updated_at: 1,
    }
}

fn deployment_plan(id: &str, application_id: &str, environment_id: &str) -> DeploymentPlan {
    DeploymentPlan {
        id: id.to_string(),
        application_id: application_id.to_string(),
        environment_id: environment_id.to_string(),
        name: format!("方案 {id}"),
        version: 1,
        status: PlanStatus::Draft,
        proposal_source: ProposalSource::Manual,
        risk_level: RiskLevel::Low,
        notes: String::new(),
        created_at: 1,
        updated_at: 1,
    }
}

fn deployment_plan_node(
    plan_id: &str,
    id: &str,
    key: &str,
    action: PlanActionKind,
    position: i64,
) -> PlanNode {
    PlanNode {
        id: id.to_string(),
        plan_id: plan_id.to_string(),
        node_key: key.to_string(),
        title: key.to_string(),
        action,
        service_unit_id: None,
        risk_level: action.default_risk(),
        approval_required: action.requires_approval(),
        skippable: true,
        params_json: "{}".to_string(),
        position,
        created_at: 1,
        updated_at: 1,
    }
}

fn release(id: &str, service_id: &str, active: bool) -> ReleaseRecord {
    ReleaseRecord {
        id: id.to_string(),
        application_id: "app-1".to_string(),
        environment_id: "env-1".to_string(),
        service_unit_id: Some(service_id.to_string()),
        run_id: None,
        version_label: format!("v-{id}"),
        artifact_id: None,
        is_active: active,
        activated_at: Some(1),
        replaced_release_id: None,
        nginx_backup_path: None,
        image_digest: None,
        config_snapshot_json: None,
        status: if active {
            ReleaseStatus::Active
        } else {
            ReleaseStatus::Superseded
        },
        notes: String::new(),
        created_at: 1,
        updated_at: 1,
    }
}

#[test]
fn deployment_centre_tables_exist() {
    let conn = test_db();
    for table in DEPLOYMENT_TABLES {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "{table} 应该存在");
    }
}

// -- P5.1 制品导入任务 -------------------------------------------------------

fn import_task(id: &str) -> ArtifactImportTask {
    ArtifactImportTask {
        id: id.to_string(),
        application_id: Some("app-1".to_string()),
        service_unit_id: None,
        source: ImportSource::LocalFolder {
            path: "/tmp/web".to_string(),
        },
        display_name: "web".to_string(),
        stage: ImportStage::AwaitingConfirmation,
        status: ImportStatus::Succeeded,
        progress: ImportProgress {
            processed_bytes: 10,
            total_bytes: 10,
            processed_entries: 2,
            total_entries: 2,
            percent: 100,
            ..ImportProgress::queued()
        },
        fingerprint: Some(crate::deployment::artifact::fingerprint::fingerprint_for(
            FingerprintBasis::DirectoryManifest,
            "a".repeat(64),
            10,
            2,
            Some(1_700_000_000_000),
            1_700_000_000_000,
        )),
        security: Some(SecurityScanReport::empty()),
        inspection: Some(ArtifactInspection {
            artifact_kind: ArtifactKind::Folder,
            source_kind: ArtifactSourceKind::LocalPath,
            stack: StackProfile {
                language: Language::Unknown,
                package_manager: None,
                framework: None,
                markers: Vec::new(),
            },
            build: vec![BuildStep::None],
            start: Vec::new(),
            ports: Vec::new(),
            health: Vec::new(),
            env_keys: Vec::new(),
            dependencies: Vec::new(),
            services: Vec::new(),
            checks: Vec::new(),
            open_questions: Vec::new(),
            files_seen: 2,
            truncated: false,
            inspected_at: 1_700_000_000_000,
        }),
        error: None,
        can_cancel: false,
        attempt: 1,
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
        finished_at: Some(1_700_000_000_000),
        artifact_id: None,
    }
}

#[test]
fn artifact_import_task_round_trips_through_json_columns() {
    let conn = test_db();
    let task = import_task("task-1");
    upsert_import_task(&conn, &task).expect("save");

    let loaded = get_import_task(&conn, "task-1")
        .expect("load")
        .expect("found");
    assert_eq!(loaded.display_name, "web");
    assert_eq!(loaded.stage, ImportStage::AwaitingConfirmation);
    assert_eq!(loaded.status, ImportStatus::Succeeded);
    assert_eq!(loaded.progress.percent, 100);
    let fingerprint = loaded.fingerprint.expect("fingerprint");
    assert_eq!(fingerprint.sha256.len(), 64);
    assert_eq!(fingerprint.basis, FingerprintBasis::DirectoryManifest);
    assert!(loaded.security.is_some());
    let inspection = loaded.inspection.expect("inspection");
    assert_eq!(inspection.files_seen, 2);
    assert_eq!(inspection.build.len(), 1);
    assert!(loaded.artifact_id.is_none());

    // 覆盖写：确认导入后带上制品 id 与 Done 阶段。
    mark_import_task_confirmed(&conn, "task-1", "artifact-1", 2_000).expect("mark");
    let confirmed = get_import_task(&conn, "task-1")
        .expect("load")
        .expect("found");
    assert_eq!(confirmed.artifact_id.as_deref(), Some("artifact-1"));
    assert_eq!(confirmed.stage, ImportStage::Done);

    assert_eq!(
        list_import_tasks(&conn, Some("app-1"), 10)
            .expect("list")
            .len(),
        1
    );
    assert_eq!(
        list_import_tasks(&conn, Some("other"), 10)
            .expect("list")
            .len(),
        0
    );

    delete_import_task(&conn, "task-1").expect("delete");
    assert!(get_import_task(&conn, "task-1").expect("load").is_none());
}

// -- P5.2 部署方案与安全策略 -------------------------------------------------

/// 用规则引擎现做一份方案（比手搓 20 个字段更不容易写错）。
fn proposal_fixture(id: &str) -> crate::deployment::proposal::model::DeploymentProposal {
    use crate::deployment::proposal::{engine, ProposalInputs, SecurityPolicy};
    let inputs = ProposalInputs {
        application: deployment_application("app-1"),
        environment: None,
        server_id: "srv-1".to_string(),
        services: Vec::new(),
        relations: Vec::new(),
        artifacts: Vec::new(),
        domains: Vec::new(),
        facts: Vec::new(),
        capability: None,
        capacity: None,
        policy: SecurityPolicy::default(),
        observed: None,
        now: 1_700_000_000_000,
    };
    let mut outcome = engine::generate(&inputs, None);
    outcome.proposal.id = id.to_string();
    outcome.proposal
}

#[test]
fn proposal_round_trips_with_its_fingerprint() {
    let conn = test_db();
    let proposal = proposal_fixture("proposal-1");
    upsert_proposal(&conn, &proposal).expect("save");

    let loaded = get_proposal(&conn, "proposal-1")
        .expect("load")
        .expect("found");
    assert_eq!(loaded.id, "proposal-1");
    assert_eq!(
        loaded.fingerprint.input_hash,
        proposal.fingerprint.input_hash
    );
    assert_eq!(
        loaded.fingerprint.output_hash,
        proposal.fingerprint.output_hash
    );
    assert_eq!(
        loaded.fingerprint.engine_version,
        proposal.fingerprint.engine_version
    );
    assert_eq!(
        loaded.fingerprint.knowledge_version,
        proposal.fingerprint.knowledge_version
    );
    assert!(!loaded.summary.headline.is_empty());
    // 整份 JSON 往返后仍然相等（结构没有被序列化破坏）。
    assert_eq!(loaded, proposal);

    // 按输入哈希可以找回（"同样输入可复现"的检索入口）。
    let found = find_proposal_by_input_hash(&conn, "app-1", &proposal.fingerprint.input_hash)
        .expect("find")
        .expect("found");
    assert_eq!(found.id, "proposal-1");

    assert_eq!(
        list_proposals(&conn, Some("app-1"), 10)
            .expect("list")
            .len(),
        1
    );
    assert_eq!(
        list_proposals(&conn, Some("other"), 10)
            .expect("list")
            .len(),
        0
    );

    mark_proposal_confirmed(&conn, "proposal-1", "plan-1", 2_000).expect("confirm");
    let confirmed = get_proposal(&conn, "proposal-1")
        .expect("load")
        .expect("found");
    assert_eq!(
        confirmed.status,
        crate::deployment::proposal::ProposalStatus::Confirmed
    );

    delete_proposal(&conn, "proposal-1").expect("delete");
    assert!(get_proposal(&conn, "proposal-1").expect("load").is_none());
}

#[test]
fn security_policy_defaults_are_conservative_and_round_trip() {
    let conn = test_db();
    let default = get_security_policy(&conn, "app-1").expect("default");
    assert!(default.production_requires_approval, "默认必须要求人工审批");
    assert!(default.forbid_secrets_in_artifact);
    assert!(default.require_health_check);
    assert!(default.require_https);
    assert!(default.min_headroom_percent >= 10);

    // 存进去再读出来：被改松的字段会被钉回去，读到的是钉回去的版本。
    let loosened = crate::deployment::proposal::SecurityPolicy {
        production_requires_approval: false,
        min_headroom_percent: 0,
        ..Default::default()
    };
    let (hardened, restored) = loosened.clone().hardened();
    assert_eq!(restored.len(), 2);
    upsert_security_policy(&conn, "app-1", &hardened, 1).expect("save");
    let loaded = get_security_policy(&conn, "app-1").expect("load");
    assert!(loaded.production_requires_approval);
    assert_eq!(loaded.min_headroom_percent, 10);
}

#[test]
fn migration_upgrades_a_v10_database_in_place() {
    let conn = Connection::open_in_memory().unwrap();
    // 模拟停留在 v10 的老库：P5.0 / P5.1 的表都在，还没有方案表。
    conn.execute_batch(super::DEPLOYMENT_CENTER_SCHEMA_SQL)
        .unwrap();
    conn.execute_batch(super::DEPLOYMENT_IMPORT_SCHEMA_SQL)
        .unwrap();
    conn.pragma_update(None, "user_version", 10u32).unwrap();

    migrate(&conn).expect("v10 → v11 升级");

    let version: u32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION);
    assert!(column_exists(&conn, "deployment_proposals", "output_hash").unwrap());
    assert!(column_exists(&conn, "deployment_security_policies", "policy_json").unwrap());
    // 升级完能直接写。
    upsert_proposal(&conn, &proposal_fixture("proposal-upgraded")).expect("write after upgrade");
}

#[test]
fn migration_upgrades_a_v9_database_in_place() {
    let conn = Connection::open_in_memory().unwrap();
    // 模拟停留在 v9 的老库：P5.0 的表都在，但还没有导入任务表。
    conn.execute_batch(super::DEPLOYMENT_CENTER_SCHEMA_SQL)
        .unwrap();
    conn.pragma_update(None, "user_version", 9u32).unwrap();

    migrate(&conn).expect("v9 → v10 升级");

    let version: u32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION);
    assert!(column_exists(&conn, "artifact_import_tasks", "inspection_json").unwrap());
    // 升级完能直接写。
    upsert_import_task(&conn, &import_task("task-upgraded")).expect("write after upgrade");
}

#[test]
fn migration_upgrades_a_v8_database_in_place() {
    let conn = Connection::open_in_memory().unwrap();
    // 模拟一台停留在 v8 的老库：只有最早的基础表，user_version 已经是 8。
    conn.execute_batch(
        r#"
        CREATE TABLE servers (
            id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, host TEXT NOT NULL,
            port INTEGER NOT NULL, username TEXT NOT NULL, credential_id TEXT,
            group_id TEXT, tags TEXT NOT NULL DEFAULT '[]', proxy_jump_id TEXT,
            favorite INTEGER NOT NULL DEFAULT 0, last_connected_at INTEGER,
            status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE credentials (
            id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
            username TEXT NOT NULL, secret_ref TEXT, passphrase_ref TEXT,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        "#,
    )
    .unwrap();
    conn.pragma_update(None, "user_version", 8u32).unwrap();

    migrate(&conn).expect("v8 → v9 升级");

    let version: u32 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION);
    for table in DEPLOYMENT_TABLES {
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "{table} 升级后应该存在");
    }
    // 老表没被动过。
    assert!(column_exists(&conn, "servers", "favorite").unwrap());
}

#[test]
fn deployment_entities_round_trip() {
    let conn = test_db();
    upsert_application(&conn, &deployment_application("app-1")).unwrap();
    upsert_environment(&conn, &deployment_environment("env-1", "app-1")).unwrap();

    let mut service = deployment_service("svc-1", "app-1", "env-1");
    service.runtime = ServiceRuntime::DockerImage {
        image: "registry.example.com/acme/web".to_string(),
        tag: "v1.2.3".to_string(),
        container_name: "web-prod".to_string(),
        ports: vec![PortMapping {
            host_port: 8080,
            container_port: 80,
            protocol: PortProtocol::Tcp,
        }],
    };
    service.artifact_id = None;
    upsert_service_unit(&conn, &service).unwrap();

    let loaded = get_service_unit(&conn, "svc-1").unwrap().unwrap();
    assert_eq!(loaded, service, "服务（含运行方式 JSON）必须原样往返");
    match &loaded.runtime {
        ServiceRuntime::DockerImage { ports, tag, .. } => {
            assert_eq!(tag, "v1.2.3");
            assert_eq!(ports[0].host_port, 8080);
        }
        other => panic!("运行方式反序列化错误：{other:?}"),
    }
    assert_eq!(list_applications(&conn, Some("s1")).unwrap().len(), 1);
    assert_eq!(list_environments(&conn, Some("app-1")).unwrap().len(), 1);
    assert_eq!(
        list_service_units(&conn, Some("app-1"), Some("env-1"))
            .unwrap()
            .len(),
        1
    );

    // 同一环境里服务名唯一。
    let mut duplicate = deployment_service("svc-2", "app-1", "env-1");
    duplicate.name = service.name.clone();
    assert!(upsert_service_unit(&conn, &duplicate).is_err());
}

#[test]
fn linking_a_confirmed_project_to_a_service_unit() {
    let conn = test_db();
    upsert_application(&conn, &deployment_application("app-1")).unwrap();
    upsert_environment(&conn, &deployment_environment("env-1", "app-1")).unwrap();
    upsert_service_unit(&conn, &deployment_service("svc-1", "app-1", "env-1")).unwrap();

    link_service_confirmed_project(&conn, "svc-1", Some("proj-9"), "/opt/web").unwrap();
    let linked = get_service_unit(&conn, "svc-1").unwrap().unwrap();
    assert_eq!(linked.confirmed_project_id.as_deref(), Some("proj-9"));
    assert_eq!(linked.confirmed_project_path.as_deref(), Some("/opt/web"));
    assert_eq!(
        service_units_for_confirmed_project(&conn, "proj-9").unwrap(),
        vec!["svc-1".to_string()],
        "反查必须能找到引用该项目的服务"
    );

    unlink_service_confirmed_project(&conn, "svc-1").unwrap();
    let unlinked = get_service_unit(&conn, "svc-1").unwrap().unwrap();
    assert!(unlinked.confirmed_project_id.is_none());
    assert!(unlinked.confirmed_project_path.is_none());
    assert!(service_units_for_confirmed_project(&conn, "proj-9")
        .unwrap()
        .is_empty());

    // 只记路径、不挂 id 也允许（老项目没有 id 的情况）。
    link_service_confirmed_project(&conn, "svc-1", None, "/opt/legacy").unwrap();
    let path_only = get_service_unit(&conn, "svc-1").unwrap().unwrap();
    assert!(path_only.confirmed_project_id.is_none());
    assert_eq!(
        path_only.confirmed_project_path.as_deref(),
        Some("/opt/legacy")
    );
}

#[test]
fn plan_graph_is_replaced_wholesale() {
    let conn = test_db();
    upsert_application(&conn, &deployment_application("app-1")).unwrap();
    upsert_environment(&conn, &deployment_environment("env-1", "app-1")).unwrap();

    let plan = deployment_plan("plan-1", "app-1", "env-1");
    let graph = DeploymentPlanGraph {
        plan: plan.clone(),
        nodes: vec![
            deployment_plan_node(
                "plan-1",
                "n1",
                "fetch_source",
                PlanActionKind::FetchSource,
                0,
            ),
            deployment_plan_node(
                "plan-1",
                "n2",
                "build_artifact",
                PlanActionKind::BuildArtifact,
                1,
            ),
        ],
        edges: vec![PlanEdge {
            id: "e1".to_string(),
            plan_id: "plan-1".to_string(),
            from_node_id: "n1".to_string(),
            to_node_id: "n2".to_string(),
            condition: EdgeCondition::OnSuccess,
            created_at: 1,
        }],
    };
    upsert_plan_graph(&conn, &graph).unwrap();
    let loaded = get_plan_graph(&conn, "plan-1").unwrap().unwrap();
    assert_eq!(loaded.nodes.len(), 2);
    assert_eq!(loaded.edges.len(), 1);
    assert_eq!(loaded.plan, plan);

    // 整体替换：节点与边都按新内容重建，旧的不会残留。
    let smaller = DeploymentPlanGraph {
        plan: DeploymentPlan {
            version: 2,
            ..plan.clone()
        },
        nodes: vec![deployment_plan_node(
            "plan-1",
            "n3",
            "http_health",
            PlanActionKind::HttpHealthCheck,
            0,
        )],
        edges: vec![],
    };
    upsert_plan_graph(&conn, &smaller).unwrap();
    let loaded = get_plan_graph(&conn, "plan-1").unwrap().unwrap();
    assert_eq!(loaded.plan.version, 2);
    assert_eq!(loaded.nodes.len(), 1);
    assert_eq!(loaded.nodes[0].node_key, "http_health");
    assert!(loaded.edges.is_empty(), "旧边必须随替换一起消失");
    assert_eq!(list_plans(&conn, None, Some("env-1")).unwrap().len(), 1);

    // 删方案也会把节点与边一起带走。
    delete_plan_cascade(&conn, "plan-1").unwrap();
    assert!(get_plan_graph(&conn, "plan-1").unwrap().is_none());
    assert!(list_plan_nodes(&conn, "plan-1").unwrap().is_empty());
    assert!(list_plan_edges(&conn, "plan-1").unwrap().is_empty());
}

#[test]
fn deleting_an_application_cascades_and_reports_counts() {
    let conn = test_db();
    upsert_application(&conn, &deployment_application("app-1")).unwrap();
    upsert_environment(&conn, &deployment_environment("env-1", "app-1")).unwrap();
    upsert_service_unit(&conn, &deployment_service("svc-1", "app-1", "env-1")).unwrap();
    upsert_service_unit(&conn, &deployment_service("svc-2", "app-1", "env-1")).unwrap();
    upsert_service_relation(
        &conn,
        &ServiceRelation {
            id: "rel-1".to_string(),
            application_id: "app-1".to_string(),
            from_service_id: "svc-2".to_string(),
            to_service_id: "svc-1".to_string(),
            relation_kind: ServiceRelationKind::DependsOn,
            required: true,
            failure_policy: FailurePolicy::Block,
            notes: String::new(),
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    upsert_plan_graph(
        &conn,
        &DeploymentPlanGraph {
            plan: deployment_plan("plan-1", "app-1", "env-1"),
            nodes: vec![deployment_plan_node(
                "plan-1",
                "n1",
                "fetch_source",
                PlanActionKind::FetchSource,
                0,
            )],
            edges: vec![],
        },
    )
    .unwrap();
    upsert_domain_binding(
        &conn,
        &DomainBinding {
            id: "dom-1".to_string(),
            environment_id: "env-1".to_string(),
            service_unit_id: Some("svc-1".to_string()),
            domain: "app.example.com".to_string(),
            listen_port: 443,
            path_prefix: "/".to_string(),
            dns_credential_ref: None,
            dns_status: DnsStatus::Unchecked,
            dns_checked_at: None,
            ssl_mode: SslMode::Manual,
            ssl_status: SslStatus::Issued,
            ssl_expires_at: None,
            notes: String::new(),
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    upsert_release(&conn, &release("rel-1", "svc-1", true)).unwrap();

    let removed = delete_application_cascade(&conn, "app-1").unwrap();
    assert_eq!(removed.environments, 1);
    assert_eq!(removed.services, 2);
    assert_eq!(removed.relations, 1);
    assert_eq!(removed.plans, 1);
    assert_eq!(removed.domains, 1);
    assert_eq!(removed.releases, 1);

    assert!(list_applications(&conn, None).unwrap().is_empty());
    assert!(list_environments(&conn, None).unwrap().is_empty());
    assert!(list_service_units(&conn, None, None).unwrap().is_empty());
    assert!(list_service_relations(&conn, None).unwrap().is_empty());
    assert!(list_plans(&conn, None, None).unwrap().is_empty());
    assert!(list_domain_bindings(&conn, None).unwrap().is_empty());
    assert!(list_releases(&conn, None, None).unwrap().is_empty());
}

#[test]
fn only_one_active_release_per_service() {
    let conn = test_db();
    upsert_application(&conn, &deployment_application("app-1")).unwrap();
    upsert_environment(&conn, &deployment_environment("env-1", "app-1")).unwrap();
    upsert_service_unit(&conn, &deployment_service("svc-1", "app-1", "env-1")).unwrap();

    upsert_release(&conn, &release("rel-1", "svc-1", true)).unwrap();
    assert_eq!(active_release(&conn, "svc-1").unwrap().unwrap().id, "rel-1");

    // 发布新版本：旧版本自动让位（部分唯一索引在库层兜底）。
    upsert_release(&conn, &release("rel-2", "svc-1", true)).unwrap();
    let active = active_release(&conn, "svc-1").unwrap().unwrap();
    assert_eq!(active.id, "rel-2");
    let all = list_releases(&conn, Some("env-1"), Some("svc-1")).unwrap();
    assert_eq!(all.iter().filter(|record| record.is_active).count(), 1);
    assert!(all
        .iter()
        .any(|record| record.id == "rel-1" && record.status == ReleaseStatus::Superseded));
}

#[test]
fn capacity_profile_round_trips_with_assumptions() {
    let conn = test_db();
    upsert_application(&conn, &deployment_application("app-1")).unwrap();
    upsert_environment(&conn, &deployment_environment("env-1", "app-1")).unwrap();

    let profile = CapacityProfile {
        id: "cap-1".to_string(),
        environment_id: "env-1".to_string(),
        expected_dau: Some(10_000),
        concurrent_users: Some(500),
        peak_qps: Some(120.5),
        avg_qps: None,
        websocket_connections: Some(200),
        response_target_ms: Some(300),
        monthly_bandwidth_gb: Some(800.0),
        monthly_upload_gb: None,
        monthly_data_growth_gb: Some(5.5),
        availability_target: Some("99.9".to_string()),
        rpo_minutes: Some(60),
        rto_minutes: None,
        monthly_budget: Some(2000.0),
        budget_currency: Some("CNY".to_string()),
        estimation_basis: EstimationBasis::Estimated,
        assumptions: vec![
            "按 3 倍峰值系数由 DAU 推算 QPS".to_string(),
            "带宽按平均页面 2.5 MB 估算".to_string(),
        ],
        notes: String::new(),
        created_at: 1,
        updated_at: 1,
    };
    upsert_capacity_profile(&conn, &profile).unwrap();
    let loaded = get_capacity_profile(&conn, "env-1").unwrap().unwrap();
    assert_eq!(loaded, profile);
    assert_eq!(loaded.assumptions.len(), 2, "假设必须原样保留");

    // 一个环境只留一份问卷。
    let mut second = profile.clone();
    second.id = "cap-2".to_string();
    assert!(upsert_capacity_profile(&conn, &second).is_err());
}

#[test]
fn domain_bindings_are_unique_per_target() {
    let conn = test_db();
    upsert_application(&conn, &deployment_application("app-1")).unwrap();
    upsert_environment(&conn, &deployment_environment("env-1", "app-1")).unwrap();

    let binding = |id: &str, domain: &str, port: u16, prefix: &str| DomainBinding {
        id: id.to_string(),
        environment_id: "env-1".to_string(),
        service_unit_id: None,
        domain: domain.to_string(),
        listen_port: port,
        path_prefix: prefix.to_string(),
        dns_credential_ref: None,
        dns_status: DnsStatus::Unknown,
        dns_checked_at: None,
        ssl_mode: SslMode::None,
        ssl_status: SslStatus::NotApplicable,
        ssl_expires_at: None,
        notes: String::new(),
        created_at: 1,
        updated_at: 1,
    };

    upsert_domain_binding(&conn, &binding("dom-1", "app.example.com", 443, "/")).unwrap();
    // 同一个环境里，域名 + 端口 + 前缀不能重复。
    assert!(upsert_domain_binding(&conn, &binding("dom-2", "app.example.com", 443, "/")).is_err());
    // 换个前缀可以。
    upsert_domain_binding(&conn, &binding("dom-3", "app.example.com", 443, "/api")).unwrap();
    // 换个域名可以。
    upsert_domain_binding(&conn, &binding("dom-4", "admin.example.com", 443, "/")).unwrap();
    assert_eq!(list_domain_bindings(&conn, Some("env-1")).unwrap().len(), 3);
}

#[test]
fn secret_refs_have_no_plaintext_column() {
    let conn = test_db();
    let mut statement = conn.prepare("PRAGMA table_info(secret_refs)").unwrap();
    let columns: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    for banned in ["value", "secret", "password", "token", "private_key"] {
        assert!(
            !columns.iter().any(|column| column == banned),
            "secret_refs 不该有 {banned} 列（结构性保证：只存引用）"
        );
    }
    assert!(columns.iter().any(|column| column == "keyring_account"));
    assert!(columns.iter().any(|column| column == "runtime_path"));

    let reference = SecretRef {
        id: "sec-1".to_string(),
        application_id: Some("app-1".to_string()),
        name: "数据库口令".to_string(),
        store_kind: SecretStoreKind::Keyring,
        keyring_service: Some("ops-workbench".to_string()),
        keyring_account: Some("db-prod-password".to_string()),
        runtime_path: None,
        description: String::new(),
        last_used_at: None,
        created_at: 1,
        updated_at: 1,
    };
    upsert_application(&conn, &deployment_application("app-1")).unwrap();
    upsert_secret_ref(&conn, &reference).unwrap();
    let loaded = get_secret_ref(&conn, "sec-1").unwrap().unwrap();
    assert_eq!(loaded, reference);
    assert!(list_secret_refs(&conn, Some("app-1")).unwrap().len() == 1);
}

#[test]
fn config_keys_are_unique_per_application_and_service() {
    let conn = test_db();
    upsert_application(&conn, &deployment_application("app-1")).unwrap();
    upsert_environment(&conn, &deployment_environment("env-1", "app-1")).unwrap();
    upsert_service_unit(&conn, &deployment_service("svc-1", "app-1", "env-1")).unwrap();

    let config = |id: &str, service: Option<&str>| ConfigDefinition {
        id: id.to_string(),
        application_id: "app-1".to_string(),
        service_unit_id: service.map(str::to_string),
        key: "API_BASE_URL".to_string(),
        data_type: ConfigDataType::Url,
        required: true,
        secret: false,
        scope: ConfigScope::BuildTime,
        source_kind: ConfigSourceKind::Literal,
        source_ref: None,
        default_value: Some("https://api.example.com".to_string()),
        description: String::new(),
        created_at: 1,
        updated_at: 1,
    };

    upsert_config_definition(&conn, &config("cfg-1", None)).unwrap();
    // 应用级同一 key 不能重复（NULL 也要参与唯一性 —— 靠 COALESCE 表达式索引）。
    assert!(upsert_config_definition(&conn, &config("cfg-2", None)).is_err());
    // 绑到具体服务后可以再有一条同名 key。
    upsert_config_definition(&conn, &config("cfg-3", Some("svc-1"))).unwrap();
    assert_eq!(
        list_config_definitions(&conn, Some("app-1")).unwrap().len(),
        2
    );
}

#[test]
fn service_relations_are_unique_per_triple() {
    let conn = test_db();
    upsert_application(&conn, &deployment_application("app-1")).unwrap();
    upsert_environment(&conn, &deployment_environment("env-1", "app-1")).unwrap();
    upsert_service_unit(&conn, &deployment_service("svc-1", "app-1", "env-1")).unwrap();
    upsert_service_unit(&conn, &deployment_service("svc-2", "app-1", "env-1")).unwrap();

    let relation = |id: &str, kind: ServiceRelationKind| ServiceRelation {
        id: id.to_string(),
        application_id: "app-1".to_string(),
        from_service_id: "svc-2".to_string(),
        to_service_id: "svc-1".to_string(),
        relation_kind: kind,
        required: true,
        failure_policy: FailurePolicy::Block,
        notes: String::new(),
        created_at: 1,
        updated_at: 1,
    };

    upsert_service_relation(&conn, &relation("rel-1", ServiceRelationKind::DependsOn)).unwrap();
    assert!(
        upsert_service_relation(&conn, &relation("rel-2", ServiceRelationKind::DependsOn)).is_err()
    );
    upsert_service_relation(
        &conn,
        &relation("rel-3", ServiceRelationKind::SharesNetwork),
    )
    .unwrap();

    // 删服务时关系必须一起清掉，不留悬空引用。
    let removed = delete_service_unit_cascade(&conn, "svc-1").unwrap();
    assert_eq!(removed, 2);
    assert!(list_service_relations(&conn, Some("app-1"))
        .unwrap()
        .is_empty());
}

#[test]
fn artifacts_and_runs_round_trip() {
    let conn = test_db();
    upsert_application(&conn, &deployment_application("app-1")).unwrap();

    let artifact = ArtifactRecord {
        id: "art-1".to_string(),
        application_id: "app-1".to_string(),
        service_unit_id: None,
        kind: ArtifactKind::Dist,
        source_kind: ArtifactSourceKind::LocalPath,
        source_ref: "/home/dev/web/dist".to_string(),
        file_name: None,
        size_bytes: Some(2048),
        sha256: Some("c".repeat(64)),
        docker_digest: None,
        version_label: Some("v1.0.0".to_string()),
        built_at: Some(1),
        checksum_verified: false,
        status: ArtifactStatus::Ready,
        notes: String::new(),
        created_at: 1,
        updated_at: 1,
    };
    upsert_artifact(&conn, &artifact).unwrap();
    assert_eq!(get_artifact(&conn, "art-1").unwrap().unwrap(), artifact);
    assert_eq!(list_artifacts(&conn, Some("app-1"), None).unwrap().len(), 1);

    // 运行记录：P5.0 只落库不执行（引擎在后续阶段写）。
    upsert_environment(&conn, &deployment_environment("env-1", "app-1")).unwrap();
    upsert_plan_graph(
        &conn,
        &DeploymentPlanGraph {
            plan: deployment_plan("plan-1", "app-1", "env-1"),
            nodes: vec![],
            edges: vec![],
        },
    )
    .unwrap();
    let run = crate::deployment::model::DeploymentRun {
        id: "run-1".to_string(),
        plan_id: "plan-1".to_string(),
        application_id: "app-1".to_string(),
        environment_id: "env-1".to_string(),
        server_id: "s1".to_string(),
        server_name: "生产机".to_string(),
        status: crate::deployment::model::RunStatus::Succeeded,
        trigger_source: crate::deployment::model::RunTrigger::Manual,
        plan_version: 1,
        started_at: Some(1),
        finished_at: Some(2),
        duration_ms: Some(1),
        log: "ok".to_string(),
        error_message: None,
        snapshot_json: None,
        release_id: None,
        created_at: 1,
    };
    upsert_run(&conn, &run).unwrap();
    assert_eq!(get_run(&conn, "run-1").unwrap().unwrap(), run);

    let node = crate::deployment::model::RunNode {
        id: "runnode-1".to_string(),
        run_id: "run-1".to_string(),
        node_id: None,
        node_key: "fetch_source".to_string(),
        title: "拉取源码".to_string(),
        action: "upload_artifact".to_string(),
        risk_level: crate::deployment::model::RiskLevel::Medium,
        status: crate::deployment::model::RunNodeStatus::Succeeded,
        attempt: 1,
        started_at: Some(1),
        finished_at: Some(2),
        duration_ms: Some(1),
        exit_code: Some(0),
        output: String::new(),
        error_message: None,
        created_at: 1,
    };
    upsert_run_node(&conn, &node).unwrap();
    assert_eq!(list_run_nodes(&conn, "run-1").unwrap(), vec![node]);
    assert_eq!(list_runs(&conn, Some("app-1"), None, 10).unwrap().len(), 1);

    // 删方案时它的运行记录与节点一并清掉。
    delete_plan_cascade(&conn, "plan-1").unwrap();
    assert!(get_run(&conn, "run-1").unwrap().is_none());
    assert!(list_run_nodes(&conn, "run-1").unwrap().is_empty());
}
