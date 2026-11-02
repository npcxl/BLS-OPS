//! 真实 PostgreSQL 集成测试（本地容器 `bls-pg-test`，端口 55432）。
//!
//! 覆盖：连接/认证 → 会话（backend pid）→ simple query → 批次终态 → 精度。
//! 数据库不可达时跳过；CI 设 `BLS_TEST_PG_REQUIRED=1` 时不可达必须红。

use ops_workbench_lib::database::{
    driver, manager::DatabaseManager, metadata, model::*, query, session::SessionKind, table,
};

fn env(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

fn profile() -> DatabaseProfile {
    let now = chrono::Utc::now().timestamp_millis();
    DatabaseProfile {
        id: "postgres-test".to_string(),
        name: "postgres".to_string(),
        engine: "postgres".to_string(),
        host: env("BLS_TEST_PG_HOST", "127.0.0.1"),
        port: env("BLS_TEST_PG_PORT", "55432").parse().unwrap_or(55432),
        username: env("BLS_TEST_PG_USER", "postgres"),
        default_database: Some(env("BLS_TEST_PG_DB", "ops_test")),
        has_password: true,
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
        engine_options: Default::default(),
    }
}

fn password() -> String {
    env("BLS_TEST_PG_PASSWORD", "bls_test_pw")
}

fn temp_app_db() -> (std::path::PathBuf, rusqlite::Connection) {
    let path = std::env::temp_dir().join(format!("bls-pg-app-{}.sqlite3", uuid::Uuid::new_v4()));
    let app = ops_workbench_lib::db::AppDb::new(path.clone());
    app.init().expect("init sqlite");
    let conn = app.open().expect("open sqlite");
    (path, conn)
}

#[tokio::test]
async fn postgres_metadata_and_table_browse_are_real() {
    let (app_path, app_conn) = temp_app_db();
    let plan = driver::plan_from_profile(&app_conn, &profile(), Some(&password())).expect("plan");
    let manager = DatabaseManager::default();
    let info = match manager.open_session(plan, "pg-meta").await {
        Ok(info) => info,
        Err(error) => {
            if std::env::var("BLS_TEST_PG_REQUIRED").as_deref() == Ok("1") {
                panic!("required PostgreSQL integration test cannot connect: {error}");
            }
            eprintln!("skip PostgreSQL metadata test: {error}");
            let _ = std::fs::remove_file(app_path);
            return;
        }
    };
    assert!(!info.session_id.is_empty());

    let runtime = manager
        .runtime(
            driver::plan_from_profile(&app_conn, &profile(), Some(&password())).expect("plan again"),
        )
        .await
        .expect("runtime");
    let conn = runtime.postgres().expect("postgres runtime").clone();

    conn.simple_query("DROP TABLE IF EXISTS it_items", 0)
        .await
        .expect("drop");
    conn.simple_query(
        "CREATE TABLE it_items (
             id bigserial PRIMARY KEY,
             name text NOT NULL,
             body text
         )",
        0,
    )
    .await
    .expect("create table");
    conn.simple_query(
        "INSERT INTO it_items (name, body) VALUES ('a', 'A'), ('b', 'B'), ('c', 'C')",
        0,
    )
    .await
    .expect("seed");

    let cache = metadata::MetadataCache::default();
    let databases = metadata::list_databases(&runtime, &cache)
        .await
        .expect("databases");
    let database = databases
        .iter()
        .find(|item| item.name == "ops_test")
        .expect("ops_test 必须出现在库列表里");
    assert!(!database.system);

    let tables = metadata::list_tables(&runtime, &cache, "ops_test")
        .await
        .expect("tables");
    let items = tables
        .iter()
        .find(|item| item.name == "it_items")
        .expect("it_items 必须出现在表列表里");
    assert_eq!(items.kind, "table");
    assert!(items.engine.is_none(), "PG 没有存储引擎");

    let detail = metadata::table_detail(&runtime, &cache, "ops_test", "it_items")
        .await
        .expect("table detail");
    assert_eq!(detail.primary_key, vec!["id".to_string()]);
    assert_eq!(detail.reliable_key, Some(vec!["id".to_string()]));
    assert!(detail.create_sql.is_none(), "PG 不应编造建表 SQL");
    assert_eq!(detail.columns.len(), 3);
    let id = detail
        .columns
        .iter()
        .find(|column| column.name == "id")
        .expect("id column");
    assert!(id.primary_key);
    assert!(!id.nullable);
    assert!(id.auto_increment, "bigserial 必须识别为自增");
    assert!(
        detail.indexes.iter().any(|index| index.primary),
        "主键索引必须由目录给出"
    );

    let request = |after: Option<Vec<Option<String>>>, page_size: u32| BrowseRequest {
        session_id: "pg-meta".to_string(),
        database: "ops_test".to_string(),
        table: "it_items".to_string(),
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
        &request(None, 2),
        &ResolvedBudget::resolve(None),
    )
    .await
    .expect("browse first");
    assert_eq!(first.rows.len(), 2);
    assert_eq!(first.pagination, "keyset");
    assert_eq!(first.exact_rows, Some(3));
    assert!(first.has_more);
    let cursor = first.next_cursor.clone().expect("cursor");

    let second = table::browse(
        &runtime,
        &detail,
        &request(Some(cursor), 2),
        &ResolvedBudget::resolve(None),
    )
    .await
    .expect("browse second");
    assert_eq!(second.rows.len(), 1);
    assert!(!second.has_more);
    assert_ne!(first.rows[0], second.rows[0], "keyset 第二页不能重复第一页");

    let mut filtered = request(None, 10);
    filtered.filters = Some(vec![BrowseFilter {
        column: "name".to_string(),
        op: "contains".to_string(),
        value: Some("b".to_string()),
    }]);
    let filtered = table::browse(&runtime, &detail, &filtered, &ResolvedBudget::resolve(None))
        .await
        .expect("browse filtered");
    assert_eq!(filtered.rows.len(), 1);
    assert_eq!(filtered.exact_rows, Some(1));

    conn.simple_query("DROP TABLE it_items", 0)
        .await
        .expect("cleanup");
    manager.close_session("pg-meta").await;
    manager.close_profile("postgres-test").await;
    let _ = std::fs::remove_file(app_path);
}

#[tokio::test]
async fn postgres_connects_and_keeps_numeric_precision() {
    let (app_path, app_conn) = temp_app_db();
    let plan = driver::plan_from_profile(&app_conn, &profile(), Some(&password())).expect("plan");
    let manager = DatabaseManager::default();

    let info = match manager.open_session(plan, "pg-session").await {
        Ok(info) => info,
        Err(error) => {
            if std::env::var("BLS_TEST_PG_REQUIRED").as_deref() == Ok("1") {
                panic!("required PostgreSQL integration test cannot connect: {error}");
            }
            eprintln!("skip PostgreSQL integration test: {error}");
            let _ = std::fs::remove_file(app_path);
            return;
        }
    };
    assert!(
        info.server_version
            .as_deref()
            .unwrap_or_default()
            .starts_with("PostgreSQL"),
        "应读到版本：{:?}",
        info.server_version
    );
    assert!(
        info.connection.label.starts_with("pid "),
        "PostgreSQL 身份应是 backend pid：{}",
        info.connection.label
    );

    let session = manager.session("pg-session").await.expect("session");
    assert_eq!(session.kind, SessionKind::Postgres);

    let runtime = manager
        .runtime(
            driver::plan_from_profile(&app_conn, &profile(), Some(&password()))
                .expect("plan again"),
        )
        .await
        .expect("runtime");

    let started = manager
        .queries
        .start(query::StartQueryRequest {
            session: session.clone(),
            runtime,
            sql: "SELECT 9223372036854775807::bigint AS big, \
                  12345678901234567890.123456789::numeric AS n, \
                  'hi'::text AS t"
                .to_string(),
            budget: ResolvedBudget::resolve(None),
        })
        .await
        .expect("start");

    let mut columns = 0usize;
    let mut rows: Vec<Vec<DbValue>> = Vec::new();
    let mut finished: Option<String> = None;
    for _ in 0..20 {
        let batch = manager.queries.next(&started.query_id).await.expect("next");
        match batch.batch {
            Some(DbBatch::ResultSet { columns: cols, .. }) => columns = cols.len(),
            Some(DbBatch::Rows { rows: page, .. }) => rows.extend(page),
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
    assert_eq!(rows.len(), 1);
    // 文本协议：bigint / numeric 必须是服务器原始字符串，不能经过 f64。
    assert!(
        matches!(&rows[0][0], DbValue::Text { value, .. } if value == "9223372036854775807"),
        "bigint 精度丢失：{:?}",
        rows[0][0]
    );
    assert!(
        matches!(&rows[0][1], DbValue::Text { value, .. } if value == "12345678901234567890.123456789"),
        "numeric 精度丢失：{:?}",
        rows[0][1]
    );
    assert_eq!(finished.as_deref(), Some("completed"));

    manager.close_session("pg-session").await;
    manager.close_profile("postgres-test").await;
    let _ = std::fs::remove_file(app_path);
}
