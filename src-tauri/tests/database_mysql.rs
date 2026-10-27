//! 真实 MySQL 集成测试（不是 mock）。
//!
//! 默认连接 `127.0.0.1:33306`（`bls-mysql-test` 容器），可用
//! `BLS_TEST_MYSQL_HOST` / `BLS_TEST_MYSQL_PORT` / `BLS_TEST_MYSQL_PASSWORD`
//! 覆盖。数据库不可达时**跳过**（打印原因），而不是用假数据通过。
//!
//! 覆盖：直连认证、类型协议、多结果集、keyset/OFFSET 分页、服务端取消、
//! 事务修改与冲突、CSV 导出。

use std::sync::Arc;
use std::time::Duration;

use mysql_async::prelude::Queryable;
use ops_workbench_lib::database::{
    driver, export::ExportRegistry, metadata, model::*, mutate, profiles, query, runtime::ProfileRuntime,
    session::SessionEntry, table, tunnel::TunnelRegistry,
};

fn env(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

fn profile() -> DatabaseProfile {
    let now = chrono::Utc::now().timestamp_millis();
    DatabaseProfile {
        id: "test-profile".to_string(),
        name: "integration".to_string(),
        engine: "mysql".to_string(),
        host: env("BLS_TEST_MYSQL_HOST", "127.0.0.1"),
        port: env("BLS_TEST_MYSQL_PORT", "33306").parse().unwrap_or(33306),
        username: env("BLS_TEST_MYSQL_USER", "root"),
        default_database: Some("ops_test".to_string()),
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
    }
}

fn password() -> String {
    env("BLS_TEST_MYSQL_PASSWORD", "bls_test_pw")
}

/// 临时 AppDb（真实 SQLite 文件），返回路径与连接。
fn temp_app_db() -> (std::path::PathBuf, rusqlite::Connection) {
    let path = std::env::temp_dir().join(format!("bls-db-test-{}.sqlite3", uuid::Uuid::new_v4()));
    let app = ops_workbench_lib::db::AppDb::new(path.clone());
    app.init().expect("init sqlite");
    let conn = app.open().expect("open sqlite");
    (path, conn)
}

async fn setup_schema(endpoint_opts: mysql_async::Opts) {
    let mut conn = driver::connect_once(endpoint_opts, Duration::from_secs(10))
        .await
        .expect("connect for schema");

    conn.query_drop(
        r#"
        CREATE DATABASE IF NOT EXISTS ops_test CHARACTER SET utf8mb4;
        USE ops_test;
        DROP TABLE IF EXISTS types_demo;
        CREATE TABLE types_demo (
            id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
            big_signed BIGINT,
            big_unsigned BIGINT UNSIGNED,
            amount DECIMAL(30,10),
            ratio DOUBLE,
            name VARCHAR(100),
            note LONGTEXT,
            payload JSON,
            blob_col BLOB,
            created_at DATETIME(6),
            d DATE,
            t TIME(6),
            flag BIT(8),
            empty_str VARCHAR(20),
            nullable VARCHAR(20),
            duplicate_a INT,
            duplicate_b INT
        ) ENGINE=InnoDB;

        DROP TABLE IF EXISTS no_pk;
        CREATE TABLE no_pk (a INT, b VARCHAR(20)) ENGINE=InnoDB;

        DROP TABLE IF EXISTS composite_pk;
        CREATE TABLE composite_pk (
            tenant INT NOT NULL,
            seq INT NOT NULL,
            label VARCHAR(30),
            PRIMARY KEY (tenant, seq)
        ) ENGINE=InnoDB;
        TRUNCATE TABLE composite_pk;
        "#,
    )
    .await
    .expect("schema");

    let long_note = "长文本".repeat(40_000); // 约 120 KB（UTF-8）
    conn.exec_drop(
        r#"
        INSERT INTO types_demo
            (big_signed, big_unsigned, amount, ratio, name, note, payload, blob_col,
             created_at, d, t, flag, empty_str, nullable, duplicate_a, duplicate_b)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, b'10101010', '', NULL, 7, 9)
        "#,
        (
            -9_223_372_036_854_775_807i64,
            18_446_744_073_709_551_615u64,
            "12345678901234567890.1234567890",
            1.25f64,
            "类型测试",
            long_note,
            r#"{"a":1,"b":["x","y"]}"#,
            vec![0u8, 1, 2, 255],
            "2024-02-29 12:34:56.123456",
            "1000-01-01",
            "838:59:59.000000",
        ),
    )
    .await
    .expect("insert types");

    conn.query_drop(
        r#"
        DROP TABLE IF EXISTS big_table;
        CREATE TABLE big_table (id BIGINT PRIMARY KEY, v INT) ENGINE=InnoDB;
        SET SESSION cte_max_recursion_depth = 300000;
        INSERT INTO big_table (id, v)
        WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 200000)
        SELECT n, n MOD 97 FROM seq;
        "#,
    )
    .await
    .expect("big table");
}

async fn runtime_for(conn: &rusqlite::Connection) -> (Arc<ProfileRuntime>, Arc<SessionEntry>) {
    let profile = profile();
    let plan = driver::plan_from_profile(conn, &profile, Some(&password())).expect("plan");
    let runtime = Arc::new(
        ProfileRuntime::connect(&TunnelRegistry::default(), plan)
            .await
            .expect("runtime"),
    );
    let opts = driver::build_opts(&runtime.endpoint, false).expect("opts");
    let mut session_conn = driver::connect_once(opts, Duration::from_secs(10))
        .await
        .expect("session conn");
    driver::apply_session_settings(&mut session_conn, false)
        .await
        .expect("session settings");
    let tls = driver::read_tls_status(&mut session_conn).await;
    let session = Arc::new(SessionEntry::new(
        "test-session".to_string(),
        profile.id.clone(),
        1,
        session_conn,
        None,
        tls,
        false,
    ));
    (runtime, session)
}

async fn drain(
    registry: &query::QueryRegistry,
    query_id: &str,
) -> Vec<DbBatch> {
    let mut batches = Vec::new();
    for _ in 0..10_000 {
        let response = registry.next(query_id).await.expect("next batch");
        if let Some(batch) = response.batch {
            batches.push(batch);
        }
        if matches!(
            response.state.as_str(),
            "completed" | "cancelled" | "failed" | "outcome_unknown"
        ) {
            break;
        }
    }
    batches
}

#[tokio::test]
async fn mysql_types_multi_result_and_cancel() {
    let (path, conn) = temp_app_db();
    let profile = profile();
    let plan = match driver::plan_from_profile(&conn, &profile, Some(&password())) {
        Ok(plan) => plan,
        Err(error) => {
            eprintln!("skip: {error}");
            let _ = std::fs::remove_file(path);
            return;
        }
    };
    let endpoint = match driver::resolve_plan(&TunnelRegistry::default(), plan).await {
        Ok(endpoint) => endpoint,
        Err(error) => {
            eprintln!("skip: {error}");
            let _ = std::fs::remove_file(path);
            return;
        }
    };
    let opts = driver::build_opts(&endpoint, false).expect("opts");
    setup_schema(opts).await;

    let (runtime, session) = runtime_for(&conn).await;
    let queries = query::QueryRegistry::default();

    // -- 类型 + 重复列名 + 多结果集 --------------------------------------
    let started = queries
        .start(query::StartQueryRequest {
            session: session.clone(),
            runtime: runtime.clone(),
            sql: "SELECT * FROM types_demo; SELECT duplicate_a AS id, duplicate_b AS id FROM types_demo;"
                .to_string(),
            budget: ResolvedBudget::resolve(None),
        })
        .await
        .expect("start");
    let batches = drain(&queries, &started.query_id).await;

    let result_sets: Vec<&DbBatch> = batches
        .iter()
        .filter(|batch| matches!(batch, DbBatch::ResultSet { .. }))
        .collect();
    assert_eq!(result_sets.len(), 2, "两个结果集必须分别上报");

    let first_columns = match result_sets[0] {
        DbBatch::ResultSet { columns, .. } => columns.clone(),
        _ => unreachable!(),
    };
    let rows: Vec<Vec<DbValue>> = batches
        .iter()
        .filter_map(|batch| match batch {
            DbBatch::Rows { rows, .. } => Some(rows.clone()),
            _ => None,
        })
        .flatten()
        .collect();
    assert!(!rows.is_empty(), "应有数据行");
    let row = &rows[0];

    // 无符号大整数不丢精度
    assert_eq!(
        row[2],
        DbValue::Int {
            value: "18446744073709551615".to_string(),
            unsigned: true
        }
    );
    // DECIMAL 是精确字符串
    assert_eq!(
        row[3],
        DbValue::Decimal {
            value: "12345678901234567890.1234567890".to_string()
        }
    );
    // NULL 与空串严格区分
    assert_eq!(row[14], DbValue::Null);
    assert!(matches!(&row[13], DbValue::Text { value, .. } if value.is_empty()));
    // JSON / BLOB / BIT 有明确类型
    assert!(matches!(row[7], DbValue::Json { .. }));
    assert!(matches!(row[8], DbValue::Binary { .. }));
    assert!(matches!(row[12], DbValue::Bit { .. }));
    // 长文本在结果里被截断，但真实字节数保留
    match &row[6] {
        DbValue::Text {
            bytes,
            truncated,
            ..
        } => {
            assert!(*truncated);
            assert!(*bytes > 64 * 1024);
        }
        other => panic!("长文本类型错误: {other:?}"),
    }
    assert_eq!(first_columns.len(), 17);

    // 重复列名：按序号区分，两个都保留
    let duplicate_columns = match result_sets[1] {
        DbBatch::ResultSet { columns, .. } => columns.clone(),
        _ => unreachable!(),
    };
    assert_eq!(duplicate_columns.len(), 2);
    assert_eq!(duplicate_columns[0].name, "id");
    assert_eq!(duplicate_columns[1].name, "id");
    let duplicate_rows: Vec<Vec<DbValue>> = batches
        .iter()
        .skip_while(|batch| {
            !matches!(batch, DbBatch::ResultSet { index, .. } if *index == 1)
        })
        .filter_map(|batch| match batch {
            DbBatch::Rows { rows, .. } => Some(rows.clone()),
            _ => None,
        })
        .flatten()
        .collect();
    assert!(matches!(duplicate_rows[0][0], DbValue::Int { .. }));
    assert!(matches!(duplicate_rows[0][1], DbValue::Int { .. }));

    let _ = queries.release(&started.query_id).await;

    // -- 服务端取消 ------------------------------------------------------
    let slow = queries
        .start(query::StartQueryRequest {
            session: session.clone(),
            runtime: runtime.clone(),
            sql: "SELECT SLEEP(20) AS slept".to_string(),
            budget: ResolvedBudget::resolve(None),
        })
        .await
        .expect("slow start");
    tokio::time::sleep(Duration::from_millis(400)).await;
    let cancel_state = queries.cancel(&slow.query_id).await.expect("cancel");
    assert_eq!(cancel_state, "cancelling");
    let slow_batches = drain(&queries, &slow.query_id).await;
    let final_state = slow_batches
        .iter()
        .find_map(|batch| match batch {
            DbBatch::Finished { state, .. } => Some(state.clone()),
            _ => None,
        })
        .unwrap_or_default();
    assert!(
        final_state == "cancelled" || final_state == "outcome_unknown",
        "取消必须有明确终态，收到 {final_state}"
    );
    let _ = queries.release(&slow.query_id).await;

    runtime.close().await;
    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn mysql_paging_mutation_and_export() {
    let (path, conn) = temp_app_db();
    let profile = profile();
    let plan = match driver::plan_from_profile(&conn, &profile, Some(&password())) {
        Ok(plan) => plan,
        Err(error) => {
            eprintln!("skip: {error}");
            let _ = std::fs::remove_file(path);
            return;
        }
    };
    let endpoint = match driver::resolve_plan(&TunnelRegistry::default(), plan).await {
        Ok(endpoint) => endpoint,
        Err(error) => {
            eprintln!("skip: {error}");
            let _ = std::fs::remove_file(path);
            return;
        }
    };
    setup_schema(driver::build_opts(&endpoint, false).expect("opts")).await;

    let (runtime, session) = runtime_for(&conn).await;
    let cache = metadata::MetadataCache::default();
    let detail = metadata::table_detail(&runtime, &cache, "ops_test", "composite_pk")
        .await
        .expect("detail");
    assert_eq!(detail.reliable_key.as_deref(), Some(["tenant".to_string(), "seq".to_string()].as_slice()));

    // 复合主键 keyset：插入 100 行，按 (tenant, seq) 翻页
    {
        let mut setup = driver::connect_once(
            driver::build_opts(&runtime.endpoint, false).expect("opts"),
            Duration::from_secs(10),
        )
        .await
        .expect("setup conn");
        setup
            .query_drop("SET SESSION cte_max_recursion_depth = 1000")
            .await
            .expect("cte");
        setup
            .query_drop(
                r#"
                INSERT INTO ops_test.composite_pk (tenant, seq, label)
                WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n < 100)
                SELECT (n-1) DIV 10, (n-1) MOD 10, CONCAT('row-', n) FROM s
                "#,
            )
            .await
            .expect("insert composite");
        let _ = tokio::time::timeout(Duration::from_secs(2), setup.disconnect()).await;
    }

    let page1 = table::browse(
        &runtime,
        &detail,
        &BrowseRequest {
            session_id: session.session_id.clone(),
            database: "ops_test".to_string(),
            table: "composite_pk".to_string(),
            page_size: Some(20),
            offset: Some(0),
            after: None,
            sorts: None,
            filters: None,
            pagination: Some("auto".to_string()),
            exact_count: Some(false),
        },
        &ResolvedBudget::resolve(None),
    )
    .await
    .expect("page1");
    assert_eq!(page1.pagination, "keyset");
    assert_eq!(page1.rows.len(), 20);
    let cursor = page1.next_cursor.clone().expect("cursor");

    let page2 = table::browse(
        &runtime,
        &detail,
        &BrowseRequest {
            session_id: session.session_id.clone(),
            database: "ops_test".to_string(),
            table: "composite_pk".to_string(),
            page_size: Some(20),
            offset: Some(0),
            after: Some(cursor),
            sorts: None,
            filters: None,
            pagination: Some("keyset".to_string()),
            exact_count: Some(false),
        },
        &ResolvedBudget::resolve(None),
    )
    .await
    .expect("page2");
    assert_eq!(page2.rows.len(), 20);
    assert_ne!(page1.rows[0], page2.rows[0]);

    // 无可靠键 + 非唯一排序 → OFFSET，并给出警告
    let types_detail = metadata::table_detail(&runtime, &cache, "ops_test", "no_pk")
        .await
        .expect("no_pk detail");
    assert!(types_detail.reliable_key.is_none());
    let offset_page = table::browse(
        &runtime,
        &types_detail,
        &BrowseRequest {
            session_id: session.session_id.clone(),
            database: "ops_test".to_string(),
            table: "no_pk".to_string(),
            page_size: Some(10),
            offset: Some(0),
            after: None,
            sorts: Some(vec![BrowseSort {
                column: "a".to_string(),
                direction: "desc".to_string(),
            }]),
            filters: None,
            pagination: Some("auto".to_string()),
            exact_count: Some(false),
        },
        &ResolvedBudget::resolve(None),
    )
    .await
    .expect("offset page");
    assert_eq!(offset_page.pagination, "offset");
    assert!(offset_page.warning.is_some());

    // -- 修改：事务 + 冲突 ----------------------------------------------
    let types_detail = metadata::table_detail(&runtime, &cache, "ops_test", "types_demo")
        .await
        .expect("types detail");
    let (result, _info) = mutate::apply(
        &runtime,
        &session,
        &types_detail,
        &MutationRequest {
            session_id: session.session_id.clone(),
            database: "ops_test".to_string(),
            table: "types_demo".to_string(),
            rows: vec![RowMutation {
                kind: "update".to_string(),
                key: Some(vec![AssignValue::Value {
                    value: "1".to_string(),
                }]),
                values: vec![ColumnAssignment {
                    column: "name".to_string(),
                    value: AssignValue::Value {
                        value: "已修改".to_string(),
                    },
                }],
                expected: Some(vec![ColumnAssignment {
                    column: "name".to_string(),
                    value: AssignValue::Value {
                        value: "类型测试".to_string(),
                    },
                }]),
            }],
            allow_non_transactional: None,
        },
    )
    .await
    .expect("mutate");
    assert_eq!(result.state, "committed");
    assert_eq!(result.committed_rows, 1);

    // 同一个期望值再用一次 → 0 行 → 冲突并回滚
    let (conflict, _info) = mutate::apply(
        &runtime,
        &session,
        &types_detail,
        &MutationRequest {
            session_id: session.session_id.clone(),
            database: "ops_test".to_string(),
            table: "types_demo".to_string(),
            rows: vec![RowMutation {
                kind: "update".to_string(),
                key: Some(vec![AssignValue::Value {
                    value: "1".to_string(),
                }]),
                values: vec![ColumnAssignment {
                    column: "name".to_string(),
                    value: AssignValue::Value {
                        value: "第二次".to_string(),
                    },
                }],
                expected: Some(vec![ColumnAssignment {
                    column: "name".to_string(),
                    value: AssignValue::Value {
                        value: "类型测试".to_string(),
                    },
                }]),
            }],
            allow_non_transactional: None,
        },
    )
    .await
    .expect("conflict");
    assert_eq!(conflict.state, "rolled_back");
    assert!(conflict.outcomes.iter().any(|outcome| outcome.status == "conflict"));

    // -- 导出 ------------------------------------------------------------
    let exports = ExportRegistry::default();
    let target = std::env::temp_dir().join(format!("bls-export-{}.csv", uuid::Uuid::new_v4()));
    let started = exports
        .start(
            runtime.clone(),
            ExportRequest {
                profile_id: profile.id.clone(),
                sql: "SELECT id, name, note FROM ops_test.types_demo".to_string(),
                database: Some("ops_test".to_string()),
                target_path: target.to_string_lossy().to_string(),
                pagination: None,
                page_size: None,
                sorts: None,
                filters: None,
                table: None,
                bom: Some(true),
                max_rows: None,
            },
            None,
        )
        .await
        .expect("export start");

    let mut outcome = None;
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let status = exports.status(&started.export_id).await.expect("status");
        if ["completed", "cancelled", "failed"].contains(&status.state.as_str()) {
            outcome = Some(exports.outcome(&started.export_id).await.expect("outcome"));
            break;
        }
    }
    let outcome = outcome.expect("export did not finish");
    assert_eq!(outcome.state, "completed", "{:?}", outcome.error);
    let content = std::fs::read_to_string(&target).expect("read export");
    assert!(content.starts_with('\u{feff}'));
    assert!(content.contains("id,name,note"));
    assert!(content.contains("已修改"));
    let _ = std::fs::remove_file(&target);

    runtime.close().await;
    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn profile_roundtrip_and_history() {
    let (path, conn) = temp_app_db();
    let profile = profile();
    let saved = profiles::save_profile(&conn, &profile, None).expect("save");
    assert!(!saved.has_password);
    let loaded = profiles::get_profile(&conn, &saved.id).expect("load").expect("exists");
    assert_eq!(loaded.host, profile.host);

    let entry = profiles::record_history_request(
        &conn,
        &profiles::HistoryWrite {
            profile_id: saved.id.clone(),
            session_id: None,
            sql: "SELECT 1".to_string(),
            succeeded: true,
            rows: 1,
            elapsed_ms: 3,
            error: None,
        },
    )
    .expect("history");
    assert_eq!(entry.sql, "SELECT 1");
    let list = profiles::list_history(&conn, &saved.id).expect("list");
    assert_eq!(list.len(), 1);
    profiles::clear_history(&conn, Some(&saved.id)).expect("clear");
    assert!(profiles::list_history(&conn, &saved.id).unwrap().is_empty());

    profiles::delete_profile(&conn, &saved.id).expect("delete");
    assert!(profiles::get_profile(&conn, &saved.id).unwrap().is_none());
    let _ = std::fs::remove_file(path);
}
