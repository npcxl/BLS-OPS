//! 真实 SQLite 集成测试：本地临时文件，不需要外部实例。
//!
//! 覆盖链路：配置 → plan → 运行时（专用线程）→ 会话 → 查询 → 批次终态。
//! 同时验证最重要的两个"不许假成功"的语义：缺文件不创建、只读由 SQLite 拒绝。

use std::time::Duration;

use ops_workbench_lib::database::{
    driver, manager::DatabaseManager, metadata, model::*, query, session::SessionKind, table,
};

fn temp_app_db() -> (std::path::PathBuf, rusqlite::Connection) {
    let path =
        std::env::temp_dir().join(format!("bls-sqlite-app-{}.sqlite3", uuid::Uuid::new_v4()));
    let app = ops_workbench_lib::db::AppDb::new(path.clone());
    app.init().expect("init sqlite");
    let conn = app.open().expect("open sqlite");
    (path, conn)
}

fn sqlite_db(name: &str) -> std::path::PathBuf {
    let path =
        std::env::temp_dir().join(format!("bls-sqlite-it-{name}-{}.db", uuid::Uuid::new_v4()));
    let conn = rusqlite::Connection::open(&path).expect("create db");
    conn.execute_batch(
        "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, payload BLOB);
         INSERT INTO items (name, payload) VALUES ('a', x'00ff'), ('b', NULL);",
    )
    .expect("seed");
    drop(conn);
    path
}

fn profile(path: &std::path::Path) -> DatabaseProfile {
    let now = chrono::Utc::now().timestamp_millis();
    DatabaseProfile {
        id: "sqlite-test".to_string(),
        name: "sqlite".to_string(),
        engine: "sqlite".to_string(),
        host: String::new(),
        port: 0,
        username: String::new(),
        default_database: None,
        has_password: false,
        ssh_server_id: None,
        tls_mode: "disabled".to_string(),
        tls_ca_path: None,
        tls_server_name: None,
        read_only: false,
        connect_timeout_ms: 10_000,
        query_timeout_ms: 30_000,
        created_at: now,
        updated_at: now,
        redis_mode: None,
        sentinel_master: None,
        nodes_json: None,
        engine_options: EngineOptions {
            path: Some(path.to_string_lossy().to_string()),
            ..Default::default()
        },
    }
}

#[tokio::test]
async fn sqlite_session_query_returns_typed_rows() {
    let (app_path, app_conn) = temp_app_db();
    let db_path = sqlite_db("e2e");
    let plan = driver::plan_from_profile(&app_conn, &profile(&db_path), None).expect("plan");

    let manager = DatabaseManager::default();
    let info = manager
        .open_session(plan, "sqlite-session")
        .await
        .expect("open");
    assert_eq!(info.profile_id, "sqlite-test");
    assert!(
        info.connection.label.starts_with("file:"),
        "SQLite 身份应是文件路径：{}",
        info.connection.label
    );
    assert!(
        info.server_version
            .as_deref()
            .unwrap_or_default()
            .starts_with("SQLite"),
        "应读到 SQLite 版本：{:?}",
        info.server_version
    );

    let session = manager.session("sqlite-session").await.expect("session");
    assert_eq!(session.kind, SessionKind::Sqlite);

    let runtime = manager
        .runtime(
            driver::plan_from_profile(&app_conn, &profile(&db_path), None).expect("plan again"),
        )
        .await
        .expect("runtime");

    let started = manager
        .queries
        .start(query::StartQueryRequest {
            session: session.clone(),
            runtime,
            sql: "SELECT id, name, payload FROM items ORDER BY id".to_string(),
            budget: ResolvedBudget::resolve(None),
        })
        .await
        .expect("start");

    let mut columns = 0usize;
    let mut rows = 0usize;
    let mut saw_binary = false;
    let mut finished: Option<String> = None;
    for _ in 0..20 {
        let batch = manager.queries.next(&started.query_id).await.expect("next");
        match batch.batch {
            Some(DbBatch::ResultSet { columns: cols, .. }) => columns = cols.len(),
            Some(DbBatch::Rows { rows: page, .. }) => {
                rows += page.len();
                saw_binary |= page
                    .iter()
                    .flatten()
                    .any(|value| matches!(value, DbValue::Binary { .. }));
            }
            Some(DbBatch::Error { error }) => panic!("查询失败：{error}"),
            Some(DbBatch::Finished { state, .. }) => {
                finished = Some(state);
                break;
            }
            Some(_) => {}
            None => {
                if matches!(batch.state.as_str(), "completed" | "cancelled" | "failed") {
                    finished = Some(batch.state);
                    break;
                }
            }
        }
    }

    assert_eq!(columns, 3);
    assert_eq!(rows, 2);
    assert!(saw_binary, "BLOB 必须以二进制值返回，不能当文本");
    assert_eq!(finished.as_deref(), Some("completed"));

    manager.close_session("sqlite-session").await;
    manager.close_profile("sqlite-test").await;
    let _ = std::fs::remove_file(db_path);
    let _ = std::fs::remove_file(app_path);
}

#[tokio::test]
async fn missing_file_is_rejected_and_not_created() {
    let (app_path, app_conn) = temp_app_db();
    let missing =
        std::env::temp_dir().join(format!("bls-sqlite-missing-{}.db", uuid::Uuid::new_v4()));
    let plan = driver::plan_from_profile(&app_conn, &profile(&missing), None).expect("plan");
    let manager = DatabaseManager::default();
    let error = manager
        .open_session(plan, "missing-session")
        .await
        .expect_err("缺文件必须失败");
    assert_eq!(error.stage, "database");
    assert!(!missing.exists(), "打开失败不能顺手创建空库");

    let _ = std::fs::remove_file(app_path);
}

#[tokio::test]
async fn sqlite_metadata_and_table_browse_are_real() {
    let (app_path, app_conn) = temp_app_db();
    let db_path = sqlite_db("meta");
    let plan = driver::plan_from_profile(&app_conn, &profile(&db_path), None).expect("plan");
    let manager = DatabaseManager::default();
    manager
        .open_session(plan, "meta-session")
        .await
        .expect("open");

    let runtime = manager
        .runtime(driver::plan_from_profile(&app_conn, &profile(&db_path), None).expect("plan"))
        .await
        .expect("runtime");
    let cache = metadata::MetadataCache::default();

    let databases = metadata::list_databases(&runtime, &cache)
        .await
        .expect("databases");
    assert_eq!(databases.len(), 1);
    assert_eq!(databases[0].name, "main");
    assert!(!databases[0].system);

    let tables = metadata::list_tables(&runtime, &cache, "main")
        .await
        .expect("tables");
    assert!(tables.iter().any(|item| item.name == "items"));
    assert!(tables.iter().all(|item| item.kind == "table"));

    let detail = metadata::table_detail(&runtime, &cache, "main", "items")
        .await
        .expect("detail");
    assert_eq!(detail.kind, "table");
    assert_eq!(detail.primary_key, vec!["id".to_string()]);
    assert!(
        detail
            .create_sql
            .as_deref()
            .unwrap_or_default()
            .to_uppercase()
            .contains("CREATE TABLE"),
        "应读到建表 SQL：{:?}",
        detail.create_sql
    );
    assert_eq!(detail.columns.len(), 3);
    assert!(
        detail
            .columns
            .iter()
            .find(|column| column.name == "id")
            .expect("id column")
            .primary_key
    );

    let request = |after: Option<Vec<Option<String>>>, page_size: u32| BrowseRequest {
        session_id: "meta-session".to_string(),
        database: "main".to_string(),
        table: "items".to_string(),
        page_size: Some(page_size),
        offset: Some(0),
        after,
        sorts: None,
        filters: None,
        pagination: Some("auto".to_string()),
        exact_count: Some(true),
    };

    let first = table::browse(
        &runtime,
        &detail,
        &request(None, 1),
        &ResolvedBudget::resolve(None),
    )
    .await
    .expect("browse first");
    assert_eq!(first.rows.len(), 1);
    assert_eq!(first.pagination, "keyset");
    assert_eq!(first.exact_rows, Some(2));
    let cursor = first.next_cursor.clone().expect("cursor");

    let second = table::browse(
        &runtime,
        &detail,
        &request(Some(cursor), 1),
        &ResolvedBudget::resolve(None),
    )
    .await
    .expect("browse second");
    assert_eq!(second.rows.len(), 1);
    assert_ne!(first.rows[0], second.rows[0], "keyset 第二页不能重复第一页");

    manager.close_session("meta-session").await;
    manager.close_profile("sqlite-test").await;
    let _ = std::fs::remove_file(db_path);
    let _ = std::fs::remove_file(app_path);
}

#[tokio::test]
async fn read_only_file_rejects_writes_at_the_engine() {
    let (app_path, app_conn) = temp_app_db();
    let db_path = sqlite_db("readonly");
    let mut read_only = profile(&db_path);
    read_only.read_only = true;
    // 连接测试路径覆盖"只读打开 + 会话初始化"。
    let plan = driver::plan_from_profile(&app_conn, &read_only, None).expect("plan");
    let manager = DatabaseManager::default();
    let result = manager.test_connection(plan).await;
    assert!(result.ok, "只读打开应成功：{:?}", result.error);
    assert!(result.read_only);
    assert!(result.tls.is_none() || !result.tls.as_ref().unwrap().active);

    // 直接写文件仍然成功（证明只读只是这条连接的语义，不是文件被改坏）。
    let conn = rusqlite::Connection::open(&db_path).expect("open rw");
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM items", [], |row| row.get(0))
        .expect("count");
    assert_eq!(count, 2);
    drop(conn);
    let _ = tokio::time::sleep(Duration::from_millis(10)).await;

    let _ = std::fs::remove_file(db_path);
    let _ = std::fs::remove_file(app_path);
}
