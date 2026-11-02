//! 真实 PostgreSQL 集成测试（本地容器 `bls-pg-test`，端口 55432）。
//!
//! 覆盖：连接/认证 → 会话（backend pid）→ simple query → 批次终态 → 精度。
//! 数据库不可达时跳过；CI 设 `BLS_TEST_PG_REQUIRED=1` 时不可达必须红。

use ops_workbench_lib::database::{
    driver, manager::DatabaseManager, model::*, query, session::SessionKind,
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
            driver::plan_from_profile(&app_conn, &profile(), Some(&password())).expect("plan again"),
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
