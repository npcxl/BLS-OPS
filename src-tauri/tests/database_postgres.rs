//! 真实 PostgreSQL 集成测试（本地容器 `bls-pg-test`，端口 55432）。
//!
//! 覆盖：连接/认证 → 会话（backend pid）→ simple query → 批次终态 → 精度。
//! 数据库不可达时跳过；CI 设 `BLS_TEST_PG_REQUIRED=1` 时不可达必须红。

use std::time::Duration;

use ops_workbench_lib::database::{
    adapter::AdapterSet,
    driver, export,
    manager::DatabaseManager,
    metadata,
    model::*,
    mutate,
    protocol::TransactionState,
    query,
    schema_ops::{self, SchemaChange},
    session::SessionKind,
    table,
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
            driver::plan_from_profile(&app_conn, &profile(), Some(&password()))
                .expect("plan again"),
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
        .find(|item| item.name == "public")
        .expect("public schema 必须出现在库列表里");
    assert!(!database.system);

    let tables = metadata::list_tables(&runtime, &cache, "public")
        .await
        .expect("tables");
    let items = tables
        .iter()
        .find(|item| item.name == "it_items")
        .expect("it_items 必须出现在表列表里");
    assert_eq!(items.kind, "table");
    assert!(items.engine.is_none(), "PG 没有存储引擎");

    let detail = metadata::table_detail(&runtime, &cache, "public", "it_items")
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
        database: "public".to_string(),
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
    // 精确总数不包含分页游标：翻到第二页仍然是全量 3 行。
    assert_eq!(second.exact_rows, Some(3));

    // 游标与排序键数量不一致必须报错，不能 panic 或生成错 SQL。
    let bad_cursor = table::browse(
        &runtime,
        &detail,
        &request(Some(vec![Some("1".to_string()), Some("2".to_string())]), 2),
        &ResolvedBudget::resolve(None),
    )
    .await;
    assert!(bad_cursor.is_err(), "长度不匹配的游标必须被拒绝");

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
async fn postgres_mutation_commits_and_detects_conflict() {
    let (app_path, app_conn) = temp_app_db();
    let plan = driver::plan_from_profile(&app_conn, &profile(), Some(&password())).expect("plan");
    let manager = DatabaseManager::default();
    let info = match manager.open_session(plan, "pg-mutate").await {
        Ok(info) => info,
        Err(error) => {
            if std::env::var("BLS_TEST_PG_REQUIRED").as_deref() == Ok("1") {
                panic!("required PostgreSQL integration test cannot connect: {error}");
            }
            eprintln!("skip PostgreSQL mutation test: {error}");
            let _ = std::fs::remove_file(app_path);
            return;
        }
    };
    assert_eq!(info.connection.label.starts_with("pid "), true);

    let runtime = manager
        .runtime(
            driver::plan_from_profile(&app_conn, &profile(), Some(&password()))
                .expect("plan again"),
        )
        .await
        .expect("runtime");
    let session = manager.session("pg-mutate").await.expect("session");
    let conn = runtime.postgres().expect("postgres runtime").clone();
    conn.simple_query("DROP TABLE IF EXISTS pg_mut", 0)
        .await
        .expect("drop");
    conn.simple_query(
        "CREATE TABLE pg_mut (id bigint PRIMARY KEY, name text NOT NULL)",
        0,
    )
    .await
    .expect("create");
    conn.simple_query("INSERT INTO pg_mut (id, name) VALUES (1, 'a')", 0)
        .await
        .expect("seed");

    let cache = metadata::MetadataCache::default();
    let detail = metadata::table_detail(&runtime, &cache, "public", "pg_mut")
        .await
        .expect("detail");
    assert_eq!(detail.reliable_key, Some(vec!["id".to_string()]));

    let request = |expected: &str| MutationRequest {
        session_id: "pg-mutate".to_string(),
        database: "public".to_string(),
        table: "pg_mut".to_string(),
        rows: vec![RowMutation {
            kind: "update".to_string(),
            key: Some(vec![AssignValue::Value {
                value: "1".to_string(),
            }]),
            values: vec![ColumnAssignment {
                column: "name".to_string(),
                value: AssignValue::Value {
                    value: "A".to_string(),
                },
            }],
            expected: Some(vec![ColumnAssignment {
                column: "name".to_string(),
                value: AssignValue::Value {
                    value: expected.to_string(),
                },
            }]),
        }],
        allow_non_transactional: None,
    };

    let (result, _info) = mutate::apply(&runtime, &session, &detail, &request("a"))
        .await
        .expect("mutate");
    assert_eq!(result.state, "committed");
    assert_eq!(result.committed_rows, 1);

    // 期望值仍是 'a'，但库里已是 'A'：0 行 → 冲突并回滚。
    let (conflict, _info) = mutate::apply(&runtime, &session, &detail, &request("a"))
        .await
        .expect("conflict");
    assert_eq!(conflict.state, "rolled_back");
    assert_eq!(conflict.committed_rows, 0);
    assert_eq!(conflict.outcomes[0].status, "conflict");

    let sets = conn
        .simple_query("SELECT name FROM pg_mut WHERE id = 1", 1)
        .await
        .expect("read back");
    let name = sets[0].rows[0][0].clone();
    assert!(
        matches!(&name, DbValue::Text { value, .. } if value == "A"),
        "第一次提交必须还在：{name:?}"
    );

    // 导出：真实写 CSV（表头 + 1 行），走 `run_postgres_export`。
    let out_path = std::env::temp_dir().join(format!("bls-pg-export-{}.csv", uuid::Uuid::new_v4()));
    let registry = export::ExportRegistry::default();
    let started = registry
        .start(
            runtime.clone(),
            ExportRequest {
                profile_id: "postgres-test".to_string(),
                sql: String::new(),
                database: Some("public".to_string()),
                target_path: out_path.to_string_lossy().to_string(),
                pagination: Some("auto".to_string()),
                page_size: None,
                sorts: None,
                filters: None,
                table: Some(ExportTableTarget {
                    database: "public".to_string(),
                    table: "pg_mut".to_string(),
                }),
                bom: Some(true),
                max_rows: None,
            },
            Some(detail.clone()),
        )
        .await
        .expect("start export");

    let mut state = String::new();
    for _ in 0..200 {
        tokio::time::sleep(Duration::from_millis(25)).await;
        let progress = registry.status(&started.export_id).await.expect("status");
        state = progress.state.clone();
        if matches!(state.as_str(), "completed" | "failed" | "cancelled") {
            break;
        }
    }
    assert_eq!(state, "completed");
    let csv = std::fs::read_to_string(&out_path).expect("read csv");
    let body = csv.trim_start_matches('\u{feff}');
    let lines: Vec<&str> = body.lines().collect();
    assert_eq!(lines.len(), 2, "表头 + 1 行数据：{body}");
    assert_eq!(lines[0], "id,name");
    assert!(body.contains('A'), "导出必须包含提交后的值：{body}");
    let _ = std::fs::remove_file(out_path);

    conn.simple_query("DROP TABLE pg_mut", 0)
        .await
        .expect("cleanup");
    manager.close_session("pg-mutate").await;
    manager.close_profile("postgres-test").await;
    let _ = std::fs::remove_file(app_path);
}

#[tokio::test]
async fn postgres_streaming_zero_rows_transaction_and_export_paging() {
    let (app_path, app_conn) = temp_app_db();
    let plan = driver::plan_from_profile(&app_conn, &profile(), Some(&password())).expect("plan");
    let manager = DatabaseManager::default();
    let info = match manager.open_session(plan, "pg-stream").await {
        Ok(info) => info,
        Err(error) => {
            if std::env::var("BLS_TEST_PG_REQUIRED").as_deref() == Ok("1") {
                panic!("required PostgreSQL integration test cannot connect: {error}");
            }
            eprintln!("skip PostgreSQL streaming test: {error}");
            let _ = std::fs::remove_file(app_path);
            return;
        }
    };
    assert!(!info.session_id.is_empty());

    let runtime = manager
        .runtime(
            driver::plan_from_profile(&app_conn, &profile(), Some(&password()))
                .expect("plan again"),
        )
        .await
        .expect("runtime");
    let session = manager.session("pg-stream").await.expect("session");
    let conn = runtime.postgres().expect("postgres runtime").clone();

    // 1) 事务状态由**独立控制连接**探测：BEGIN 后必须是 InTransaction。
    conn.simple_query("BEGIN", 0).await.expect("begin");
    assert_eq!(
        conn.transaction_state().await,
        TransactionState::InTransaction,
        "BEGIN 后必须探测到事务（同连接查 pg_stat_activity 只会得到 active）"
    );
    conn.simple_query("ROLLBACK", 0).await.expect("rollback");
    assert_eq!(conn.transaction_state().await, TransactionState::None);

    // 2) 零行结果仍然有列：列信息来自 prepare 的 RowDescription。
    let started = manager
        .queries
        .start(query::StartQueryRequest {
            session: session.clone(),
            runtime: runtime.clone(),
            sql: "SELECT 1 AS a, 'x'::text AS b WHERE false".to_string(),
            budget: ResolvedBudget::resolve(None),
        })
        .await
        .expect("start zero-row query");

    let mut columns = 0usize;
    let mut status: Option<String> = None;
    for _ in 0..10 {
        let batch = manager.queries.next(&started.query_id).await.expect("next");
        match batch.batch {
            Some(DbBatch::ResultSet { columns: cols, .. }) => columns = cols.len(),
            Some(DbBatch::Error { error }) => panic!("零行查询失败：{error}"),
            Some(DbBatch::Finished { state, .. }) => {
                status = Some(state);
                break;
            }
            Some(_) => {}
            None => {
                if matches!(batch.state.as_str(), "completed" | "failed" | "cancelled") {
                    status = Some(batch.state);
                    break;
                }
            }
        }
    }
    assert_eq!(columns, 2, "零行结果必须带列信息");
    assert_eq!(status.as_deref(), Some("completed"));

    // 3) 导出跨页：1200 行 > 单批 500 行，必须全部写出。
    conn.simple_query("DROP TABLE IF EXISTS pg_export", 0)
        .await
        .expect("drop");
    conn.simple_query(
        "CREATE TABLE pg_export (id bigint PRIMARY KEY, name text)",
        0,
    )
    .await
    .expect("create");
    conn.simple_query(
        "INSERT INTO pg_export (id, name) SELECT g, 'n' || g FROM generate_series(1, 1200) g",
        0,
    )
    .await
    .expect("seed");

    let cache = metadata::MetadataCache::default();
    let detail = metadata::table_detail(&runtime, &cache, "public", "pg_export")
        .await
        .expect("detail");
    let out_path =
        std::env::temp_dir().join(format!("bls-pg-big-export-{}.csv", uuid::Uuid::new_v4()));
    let registry = export::ExportRegistry::default();
    let export = registry
        .start(
            runtime.clone(),
            ExportRequest {
                profile_id: "postgres-test".to_string(),
                sql: String::new(),
                database: Some("public".to_string()),
                target_path: out_path.to_string_lossy().to_string(),
                pagination: Some("auto".to_string()),
                page_size: None,
                sorts: None,
                filters: None,
                table: Some(ExportTableTarget {
                    database: "public".to_string(),
                    table: "pg_export".to_string(),
                }),
                bom: Some(true),
                max_rows: None,
            },
            Some(detail),
        )
        .await
        .expect("start export");

    let mut state = String::new();
    for _ in 0..400 {
        tokio::time::sleep(Duration::from_millis(25)).await;
        let progress = registry.status(&export.export_id).await.expect("status");
        state = progress.state.clone();
        if matches!(state.as_str(), "completed" | "failed" | "cancelled") {
            break;
        }
    }
    assert_eq!(state, "completed");
    let csv = std::fs::read_to_string(&out_path).expect("read csv");
    let lines: Vec<&str> = csv.trim_start_matches('\u{feff}').lines().collect();
    assert_eq!(lines.len(), 1201, "表头 + 1200 行，跨页不能丢行");
    assert_eq!(lines[0], "id,name");

    let _ = std::fs::remove_file(out_path);
    conn.simple_query("DROP TABLE pg_export", 0)
        .await
        .expect("cleanup");
    manager.close_session("pg-stream").await;
    manager.close_profile("postgres-test").await;
    let _ = std::fs::remove_file(app_path);
}

#[tokio::test]
async fn postgres_ddl_creates_table_and_view() {
    let (app_path, app_conn) = temp_app_db();
    let plan = driver::plan_from_profile(&app_conn, &profile(), Some(&password())).expect("plan");
    let manager = DatabaseManager::default();
    let info = match manager.open_session(plan, "pg-ddl").await {
        Ok(info) => info,
        Err(error) => {
            if std::env::var("BLS_TEST_PG_REQUIRED").as_deref() == Ok("1") {
                panic!("required PostgreSQL integration test cannot connect: {error}");
            }
            eprintln!("skip PostgreSQL DDL test: {error}");
            let _ = std::fs::remove_file(app_path);
            return;
        }
    };
    assert!(!info.session_id.is_empty());

    let runtime = manager
        .runtime(
            driver::plan_from_profile(&app_conn, &profile(), Some(&password()))
                .expect("plan again"),
        )
        .await
        .expect("runtime");
    let session = manager.session("pg-ddl").await.expect("session");
    let conn = runtime.postgres().expect("postgres runtime").clone();
    conn.simple_query("DROP VIEW IF EXISTS pg_ddl_v", 0)
        .await
        .expect("drop view");
    conn.simple_query("DROP TABLE IF EXISTS pg_ddl", 0)
        .await
        .expect("drop table");

    let adapter = AdapterSet::of("postgres").expect("postgres adapter");
    let create = SchemaChange::CreateTable {
        database: "public".to_string(),
        table: "pg_ddl".to_string(),
        columns: vec![
            schema_ops::NewColumn {
                name: "id".to_string(),
                column_type: "bigint".to_string(),
                nullable: false,
                auto_increment: true,
                default_value: None,
                comment: String::new(),
            },
            schema_ops::NewColumn {
                name: "body".to_string(),
                column_type: "text".to_string(),
                nullable: true,
                auto_increment: false,
                default_value: None,
                comment: String::new(),
            },
        ],
        primary_key: vec!["id".to_string()],
        engine: Some("InnoDB".to_string()),
        charset: None,
        collation: None,
    };
    let preview = schema_ops::preview(&adapter, &create).expect("preview");
    assert!(
        preview.sql.contains("GENERATED BY DEFAULT AS IDENTITY"),
        "自增必须落成 IDENTITY：{}",
        preview.sql
    );
    assert!(
        !preview.sql.to_uppercase().contains("ENGINE"),
        "PostgreSQL 不能出现 ENGINE：{}",
        preview.sql
    );
    assert!(preview.warning.is_some(), "忽略 ENGINE 必须提示");

    schema_ops::apply(&adapter, &session, &create)
        .await
        .expect("create table");

    // IDENTITY 生效：不写 id 也能插入。
    conn.simple_query("INSERT INTO pg_ddl (body) VALUES ('x')", 0)
        .await
        .expect("insert with identity");

    let view = SchemaChange::SaveView {
        database: "public".to_string(),
        view: "pg_ddl_v".to_string(),
        select_sql: "SELECT id, body FROM pg_ddl".to_string(),
        or_replace: true,
    };
    schema_ops::apply(&adapter, &session, &view)
        .await
        .expect("create view");
    // PG 有 CREATE OR REPLACE VIEW：第二次直接替换，不需要先删。
    schema_ops::apply(&adapter, &session, &view)
        .await
        .expect("replace view");

    let sets = conn
        .simple_query("SELECT COUNT(*) FROM pg_ddl_v", 1)
        .await
        .expect("query view");
    assert_eq!(sets[0].rows.len(), 1);

    // 改表仍明确拒绝（PG 的 ALTER 子集没有接）。
    let error = schema_ops::preview(
        &adapter,
        &SchemaChange::CreateDatabase {
            name: "x".to_string(),
            charset: None,
            collation: None,
        },
    )
    .unwrap_err();
    assert_eq!(error.stage, "unsupported");

    conn.simple_query("DROP VIEW pg_ddl_v", 0)
        .await
        .expect("cleanup view");
    conn.simple_query("DROP TABLE pg_ddl", 0)
        .await
        .expect("cleanup table");
    manager.close_session("pg-ddl").await;
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
    // 流式路径有类型信息：bigint 是 Int、numeric 是 Decimal，值仍是完整字符串。
    assert!(
        matches!(&rows[0][0], DbValue::Int { value, .. } if value == "9223372036854775807"),
        "bigint 精度丢失：{:?}",
        rows[0][0]
    );
    assert!(
        matches!(&rows[0][1], DbValue::Decimal { value } if value == "12345678901234567890.123456789"),
        "numeric 精度丢失：{:?}",
        rows[0][1]
    );
    assert_eq!(finished.as_deref(), Some("completed"));

    manager.close_session("pg-session").await;
    manager.close_profile("postgres-test").await;
    let _ = std::fs::remove_file(app_path);
}

/// 按表导出：能力矩阵里 `export` 标的就是这条链路（`limited`：只支持按表导出）。
/// 验证的是"重新分页查询 + 逐行写 CSV + 原子发布"，不是把界面上那几十行缓存倒出来。
#[tokio::test]
async fn postgres_export_writes_complete_csv() {
    let (app_path, app_conn) = temp_app_db();
    let out_path = std::env::temp_dir().join(format!("bls-pg-export-{}.csv", uuid::Uuid::new_v4()));
    let plan = driver::plan_from_profile(&app_conn, &profile(), Some(&password())).expect("plan");
    let manager = DatabaseManager::default();
    if let Err(error) = manager.open_session(plan, "pg-export").await {
        if std::env::var("BLS_TEST_PG_REQUIRED").as_deref() == Ok("1") {
            panic!("required PostgreSQL integration test cannot connect: {error}");
        }
        eprintln!("skip PostgreSQL export test: {error}");
        let _ = std::fs::remove_file(app_path);
        return;
    }

    let runtime = manager
        .runtime(
            driver::plan_from_profile(&app_conn, &profile(), Some(&password()))
                .expect("plan again"),
        )
        .await
        .expect("runtime");
    let conn = runtime.postgres().expect("postgres runtime").clone();
    conn.simple_query("DROP TABLE IF EXISTS it_export", 0)
        .await
        .expect("drop");
    conn.simple_query(
        "CREATE TABLE it_export (id bigserial PRIMARY KEY, name text NOT NULL, payload text)",
        0,
    )
    .await
    .expect("create table");
    conn.simple_query(
        "INSERT INTO it_export (name, payload) VALUES ('a', 'A'), ('b', 'B')",
        0,
    )
    .await
    .expect("seed");

    let cache = metadata::MetadataCache::default();
    let detail = metadata::table_detail(&runtime, &cache, "public", "it_export")
        .await
        .expect("table detail");

    let registry = export::ExportRegistry::default();
    let started = registry
        .start(
            runtime.clone(),
            ExportRequest {
                profile_id: "postgres-test".to_string(),
                sql: String::new(),
                database: Some("public".to_string()),
                target_path: out_path.to_string_lossy().to_string(),
                pagination: Some("auto".to_string()),
                page_size: None,
                sorts: None,
                filters: None,
                table: Some(ExportTableTarget {
                    database: "public".to_string(),
                    table: "it_export".to_string(),
                }),
                bom: Some(true),
                max_rows: None,
            },
            Some(detail),
        )
        .await
        .expect("start export");

    let mut state = String::new();
    for _ in 0..200 {
        tokio::time::sleep(Duration::from_millis(25)).await;
        let progress = registry.status(&started.export_id).await.expect("status");
        state = progress.state.clone();
        if matches!(state.as_str(), "completed" | "failed" | "cancelled") {
            break;
        }
    }
    assert_eq!(state, "completed", "导出没有走到 completed");

    let csv = std::fs::read_to_string(&out_path).expect("read csv");
    let body = csv.trim_start_matches('\u{feff}');
    let lines: Vec<&str> = body.lines().collect();
    assert_eq!(lines.len(), 3, "表头 + 2 行数据：{body}");
    assert_eq!(lines[0], "id,name,payload");
    assert!(
        lines[1].starts_with("1,") && lines[2].starts_with("2,"),
        "行必须按主键顺序完整写进 CSV：{body}"
    );

    conn.simple_query("DROP TABLE IF EXISTS it_export", 0)
        .await
        .expect("cleanup");
    manager.close_session("pg-export").await;
    manager.close_profile("postgres-test").await;
    let _ = std::fs::remove_file(out_path);
    let _ = std::fs::remove_file(app_path);
}

/// 只读连接必须是**服务器**拒绝写入，而不是界面/客户端拦一下就当"服务端只读"：
/// PostgreSQL 侧靠连接时的 `SET default_transaction_read_only = on`。
#[tokio::test]
async fn postgres_read_only_connection_is_enforced_by_the_server() {
    let (app_path, app_conn) = temp_app_db();
    let mut read_only_profile = profile();
    read_only_profile.read_only = true;
    let plan =
        driver::plan_from_profile(&app_conn, &read_only_profile, Some(&password())).expect("plan");
    let manager = DatabaseManager::default();
    let info = match manager.open_session(plan, "pg-ro").await {
        Ok(info) => info,
        Err(error) => {
            if std::env::var("BLS_TEST_PG_REQUIRED").as_deref() == Ok("1") {
                panic!("required PostgreSQL integration test cannot connect: {error}");
            }
            eprintln!("skip PostgreSQL read-only test: {error}");
            let _ = std::fs::remove_file(app_path);
            return;
        }
    };
    assert!(info.read_only, "会话状态必须如实报告只读");

    let runtime = manager
        .runtime(
            driver::plan_from_profile(&app_conn, &read_only_profile, Some(&password()))
                .expect("plan again"),
        )
        .await
        .expect("runtime");
    let conn = runtime.postgres().expect("postgres runtime").clone();

    // 读不受影响
    conn.simple_query("SELECT 1", 0)
        .await
        .expect("只读连接应能查询");

    // 写必须由服务器拒绝：SQLSTATE 25006 / "read-only transaction"
    let error = match conn
        .simple_query("CREATE TABLE pg_ro_probe (id int)", 0)
        .await
    {
        Ok(_) => panic!("只读连接不能建表"),
        Err(error) => error,
    };
    let text = error.to_string().to_ascii_lowercase();
    assert!(
        text.contains("read-only") || text.contains("25006"),
        "拒绝必须来自服务器的只读事务，而不是客户端兜底：{text}"
    );

    manager.close_session("pg-ro").await;
    manager.close_profile("postgres-test").await;
    let _ = std::fs::remove_file(app_path);
}
