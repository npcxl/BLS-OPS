//! 单表新增 / 修改 / 删除：显式提交、事务、影响行数校验、乐观并发。
//!
//! 规则（每一条都是"宁可拒绝，也不假装成功"）：
//!
//! * **没有可靠唯一键 → 拒绝写入**。视图、复杂查询结果、无主键表一律只读。
//! * **事务固定物理连接**：用会话独占的 `Conn`，绝不从池里临时取一条。
//! * 一条 UPDATE/DELETE 影响行数不是 1 → 回滚并报冲突（或键不再唯一）。
//! * 乐观并发用方言的 null-safe 等值比较读取时的值（MySQL `<=>`、标准 SQL
//!   `IS NOT DISTINCT FROM`）；远程已改 → 冲突。SQL 全部由 `AdapterSet` 生成，
//!   占位符编号与参数顺序由同一个 `Binder` 维护（PostgreSQL 用 `$n`）。
//! * 非事务引擎（MyISAM 等）默认拒绝；用户显式确认后才逐行执行，
//!   并明确写出"失败的行无法回滚"。
//! * `COMMIT` 期间断网 → `outcome_unknown`，不自动重试，给出重新核对入口。
//! * 开启 `client_found_rows`：UPDATE 即使值没变也算 1 行匹配，
//!   这样"0 行"就只可能是冲突/行不存在。

use std::time::{Duration, Instant};

use mysql_async::prelude::Queryable;
use mysql_async::{Conn, Params, Value};

use super::adapter::{AdapterSet, ParamBinder, SqlDialect};
use super::driver::map_error;
use super::model::{
    AssignValue, ColumnAssignment, DbErrorInfo, DbSessionInfo, DbTableDetail, MutationRequest,
    MutationResult, MutationRowOutcome, RowMutation,
};
use super::protocol::TransactionState;
use super::runtime::ProfileRuntime;
use super::session::{SessionEntry, SessionKind};

const TRANSACTIONAL_ENGINES: [&str; 3] = ["innodb", "ndbcluster", "ndb"];

fn is_transactional(adapter: &AdapterSet, engine: &Option<String>) -> bool {
    // 方言能直接回答的（PostgreSQL/SQLite/…）不用再看存储引擎。
    if adapter.transactional_writes() {
        return true;
    }
    engine
        .as_deref()
        .map(|value| TRANSACTIONAL_ENGINES.contains(&value.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// 位置参数的唯一来源（占位符编号与参数顺序由 `ParamBinder` 保证）。
type Binder<'a> = ParamBinder<'a, Value>;

/// 文本值统一走同一个绑定入口：列值、定位键、期望值都是文本。
fn bind_text(binder: &mut Binder<'_>, value: &str) -> String {
    binder.bind(Value::Bytes(value.as_bytes().to_vec()))
}

/// 这些类型不能用普通文本编辑器的字符串直接绑定；否则 BIT/BINARY 会被写成
/// 原始字节串，看起来成功、实际值已经损坏。
fn is_binary_type(data_type: &str) -> bool {
    matches!(
        data_type.to_ascii_lowercase().as_str(),
        "bit"
            | "binary"
            | "varbinary"
            | "tinyblob"
            | "blob"
            | "mediumblob"
            | "longblob"
            | "geometry"
            | "point"
            | "linestring"
            | "polygon"
            | "multipoint"
            | "multilinestring"
            | "multipolygon"
            | "geometrycollection"
    )
}

fn validate_assignment(
    detail: &DbTableDetail,
    assignment: &ColumnAssignment,
) -> Result<(), DbErrorInfo> {
    if !matches!(assignment.value, AssignValue::Value { .. }) {
        return Ok(());
    }
    let Some(column) = detail
        .columns
        .iter()
        .find(|column| column.name.eq_ignore_ascii_case(&assignment.column))
    else {
        return Ok(());
    };
    if is_binary_type(&column.data_type) {
        return Err(DbErrorInfo::new(
            "unsupported",
            format!(
                "字段 {} 是 {} 类型，不能用文本直接写入；请使用只读查看，后续会提供二进制编辑器",
                column.name, column.data_type
            ),
        ));
    }
    Ok(())
}

fn assignment_sql(
    dialect: &SqlDialect,
    assignment: &ColumnAssignment,
    binder: &mut Binder<'_>,
) -> Result<String, DbErrorInfo> {
    let quoted = dialect.quote(&assignment.column)?;
    Ok(match &assignment.value {
        AssignValue::Null => format!("{quoted} = NULL"),
        AssignValue::Default => format!("{quoted} = DEFAULT"),
        AssignValue::Value { value } => {
            let placeholder = bind_text(binder, value);
            format!("{quoted} = {placeholder}")
        }
    })
}

fn expected_sql(
    adapter: &AdapterSet,
    assignment: &ColumnAssignment,
    binder: &mut Binder<'_>,
) -> Result<String, DbErrorInfo> {
    let quoted = adapter.dialect().quote(&assignment.column)?;
    Ok(match &assignment.value {
        AssignValue::Null => adapter.null_safe_equal(&quoted, "NULL"),
        AssignValue::Default => {
            return Err(DbErrorInfo::new(
                "query",
                "DEFAULT 不能作为乐观并发比较的期望值",
            ))
        }
        AssignValue::Value { value } => {
            let placeholder = bind_text(binder, value);
            adapter.null_safe_equal(&quoted, &placeholder)
        }
    })
}

fn key_sql(
    dialect: &SqlDialect,
    key: &[AssignValue],
    columns: &[String],
    binder: &mut Binder<'_>,
) -> Result<String, DbErrorInfo> {
    if key.len() != columns.len() {
        return Err(DbErrorInfo::new("query", "行定位键与表的主键列数量不一致"));
    }
    let mut clauses = Vec::new();
    for (index, column) in columns.iter().enumerate() {
        match &key[index] {
            AssignValue::Value { value } => {
                let placeholder = bind_text(binder, value);
                clauses.push(format!("{} = {placeholder}", dialect.quote(column)?));
            }
            AssignValue::Null => clauses.push(format!("{} IS NULL", dialect.quote(column)?)),
            AssignValue::Default => {
                return Err(DbErrorInfo::new("query", "定位键不能是 DEFAULT"));
            }
        }
    }
    Ok(clauses.join(" AND "))
}

pub async fn apply(
    profile: &ProfileRuntime,
    session: &SessionEntry,
    detail: &DbTableDetail,
    request: &MutationRequest,
) -> Result<(MutationResult, DbSessionInfo), DbErrorInfo> {
    let started = Instant::now();
    let adapter = profile.adapter()?;
    let adapter = &adapter;

    if profile.endpoint.read_only {
        return Err(DbErrorInfo::new(
            "permission",
            "该连接配置为只读：服务器已设置 SET SESSION TRANSACTION READ ONLY，写入会被拒绝",
        ));
    }
    if detail.kind != "table" {
        return Err(DbErrorInfo::new(
            "permission",
            "视图默认只读：请直接在基表上修改",
        ));
    }
    let key_columns = detail.reliable_key.clone().ok_or_else(|| {
        DbErrorInfo::new(
            "permission",
            "该表没有可靠唯一键（主键/唯一非空键）：无法安全定位单行，已拒绝写入",
        )
    })?;

    let transactional = is_transactional(adapter, &detail.engine);
    if !transactional && !request.allow_non_transactional.unwrap_or(false) {
        return Err(DbErrorInfo::new(
            "unsupported",
            format!(
                "表引擎 {} 不支持事务：失败的行无法回滚。确认风险后可显式允许非事务写入",
                detail.engine.clone().unwrap_or_else(|| "未知".to_string())
            ),
        ));
    }

    // 校验列名：只能来自这次读取到的元数据。
    let known_columns: Vec<&str> = detail
        .columns
        .iter()
        .map(|column| column.name.as_str())
        .collect();
    for row in &request.rows {
        for assignment in row
            .values
            .iter()
            .chain(row.expected.as_deref().unwrap_or(&[]).iter())
        {
            if !known_columns.contains(&assignment.column.as_str()) {
                return Err(DbErrorInfo::new(
                    "query",
                    format!("列不存在或已被修改：{}", assignment.column),
                ));
            }
            validate_assignment(detail, assignment)?;
        }
    }

    // **绝不隐式提交 SQL 编辑器的事务**：
    // `START TRANSACTION` 会隐式提交同一连接上已打开的事务，用户会以为
    // SQL 里的改动还在，实际已经落库。这里直接拒绝，让用户先显式
    // COMMIT/ROLLBACK，或继续在 SQL 编辑器里操作。
    let session_transaction = session.transaction().await;
    // 事务状态未知时禁止自动写入：不能把表格修改赌进一个未知的事务。
    if matches!(session_transaction, TransactionState::Unknown)
        && session.kind == SessionKind::Postgres
    {
        return Err(DbErrorInfo::new("query", "事务状态未知，已禁止自动写入").with_detail(
            "无法确认会话是否处于事务中；请重新连接后重试，避免把表格修改提交到编辑器里未提交的事务。",
        ));
    }
    if matches!(
        session_transaction.as_str(),
        "in_transaction" | "in_transaction_read_only"
    ) {
        return Err(DbErrorInfo::new(
            "query",
            "当前会话有未提交事务：请先 COMMIT 或 ROLLBACK，再应用表格修改；本工具不会替你隐式提交",
        ));
    }

    // SQLite：执行阶段走 worker（没有协议池），前面的校验完全共用。
    // PostgreSQL：字面量路径 + `IS NOT DISTINCT FROM` 的乐观并发。
    if session.kind == SessionKind::Postgres {
        return apply_postgres(
            profile,
            session,
            detail,
            &key_columns,
            request,
            started,
            transactional,
        )
        .await;
    }

    if session.kind == SessionKind::Sqlite {
        return apply_sqlite(
            profile,
            session,
            detail,
            &key_columns,
            request,
            started,
            transactional,
        )
        .await;
    }

    let conn = session.acquire_conn().await?;
    let mut conn = conn;

    if transactional {
        if let Err(error) = conn.query_drop(adapter.begin_transaction()).await {
            session.release_conn(conn, true).await;
            return Err(map_error(&error, "query"));
        }
    }

    let mut outcomes: Vec<MutationRowOutcome> = Vec::new();
    let mut failure: Option<DbErrorInfo> = None;
    let mut unknown = false;

    for (index, row) in request.rows.iter().enumerate() {
        match execute_row(adapter, &mut conn, detail, &key_columns, row).await {
            Ok(affected) => {
                if affected != 1 {
                    outcomes.push(MutationRowOutcome {
                        index,
                        kind: row.kind.clone(),
                        affected_rows: affected,
                        status: "conflict".to_string(),
                        error: Some(DbErrorInfo::new(
                            "query",
                            if affected == 0 {
                                "没有匹配到这一行：可能已被其他会话修改/删除，或并发校验列的值已变化（可重试「跳过并发校验」）"
                            } else {
                                "影响行数超过 1：唯一键不再唯一，已停止"
                            },
                        )),
                    });
                    failure = Some(DbErrorInfo::new(
                        "query",
                        if affected == 0 {
                            "单行修改没有匹配到目标行：可能是并发修改/删除，或并发校验列已变化"
                        } else {
                            "单行修改影响多行：唯一键约束可能已损坏"
                        },
                    ));
                    break;
                }
                outcomes.push(MutationRowOutcome {
                    index,
                    kind: row.kind.clone(),
                    affected_rows: affected,
                    status: "applied".to_string(),
                    error: None,
                });
            }
            Err(error) => {
                let network = matches!(error.stage.as_str(), "tcp" | "tls");
                unknown = unknown || network;
                outcomes.push(MutationRowOutcome {
                    index,
                    kind: row.kind.clone(),
                    affected_rows: 0,
                    status: "failed".to_string(),
                    error: Some(error.clone()),
                });
                failure = Some(error);
                break;
            }
        }
    }

    let committed_rows = outcomes
        .iter()
        .filter(|outcome| outcome.status == "applied")
        .count() as u64;

    let warning = if !transactional {
        Some("非事务表：已执行的行无法回滚；失败行的后续操作已停止".to_string())
    } else {
        None
    };

    if failure.is_some() || unknown {
        if transactional && !unknown {
            match tokio::time::timeout(Duration::from_secs(10), conn.query_drop("ROLLBACK")).await {
                Ok(Ok(())) => {}
                _ => unknown = true,
            }
        }
        for outcome in &mut outcomes {
            if outcome.status == "applied" {
                outcome.status = "rolled_back".to_string();
            }
        }

        if unknown {
            session.release_conn(conn, false).await;
            return Ok((
                MutationResult {
                    state: "outcome_unknown".to_string(),
                    outcomes,
                    committed_rows: 0,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    transactional,
                    warning: Some(
                        "事务状态未知：网络在提交/回滚期间中断，服务器可能已经写入。不要自动重试，请按主键重新查询核对"
                            .to_string(),
                    ),
                    verify_hint: Some(verify_hint(adapter.dialect(), detail, request)),
                },
                session.info().await,
            ));
        }
        session.release_conn(conn, true).await;
        return Ok((
            MutationResult {
                state: "rolled_back".to_string(),
                outcomes,
                committed_rows: 0,
                elapsed_ms: started.elapsed().as_millis() as u64,
                transactional,
                warning,
                verify_hint: failure.map(|_| verify_hint(adapter.dialect(), detail, request)),
            },
            session.info().await,
        ));
    }

    if transactional {
        match tokio::time::timeout(Duration::from_secs(15), conn.query_drop("COMMIT")).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                // COMMIT 返回错误时事务可能已提交，也可能没有：不能猜。
                session.release_conn(conn, false).await;
                return Ok((
                    MutationResult {
                        state: "outcome_unknown".to_string(),
                        outcomes,
                        committed_rows: 0,
                        elapsed_ms: started.elapsed().as_millis() as u64,
                        transactional,
                        warning: Some(format!(
                            "COMMIT 失败（{}）：事务结果未知，不要自动重试",
                            error
                        )),
                        verify_hint: Some(verify_hint(adapter.dialect(), detail, request)),
                    },
                    session.info().await,
                ));
            }
            Err(_) => {
                session.release_conn(conn, false).await;
                return Ok((
                    MutationResult {
                        state: "outcome_unknown".to_string(),
                        outcomes,
                        committed_rows: 0,
                        elapsed_ms: started.elapsed().as_millis() as u64,
                        transactional,
                        warning: Some(
                            "COMMIT 超过 15 秒没有响应：事务结果未知，不要自动重试".to_string(),
                        ),
                        verify_hint: Some(verify_hint(adapter.dialect(), detail, request)),
                    },
                    session.info().await,
                ));
            }
        }
    }

    session.release_conn(conn, true).await;
    let info = session.info().await;
    Ok((
        MutationResult {
            state: "committed".to_string(),
            outcomes,
            committed_rows,
            elapsed_ms: started.elapsed().as_millis() as u64,
            transactional,
            warning,
            verify_hint: None,
        },
        info,
    ))
}

fn sqlite_literal(dialect: &SqlDialect, value: &str) -> String {
    dialect.string_literal(value)
}

fn sqlite_key_clause(
    dialect: &SqlDialect,
    key: &[AssignValue],
    columns: &[String],
) -> Result<String, DbErrorInfo> {
    if key.len() != columns.len() {
        return Err(DbErrorInfo::new("query", "行定位键与表的主键列数量不一致"));
    }
    let mut clauses = Vec::new();
    for (index, column) in columns.iter().enumerate() {
        let quoted = dialect.quote(column)?;
        clauses.push(match &key[index] {
            AssignValue::Value { value } => {
                format!("{quoted} = {}", sqlite_literal(dialect, value))
            }
            AssignValue::Null => format!("{quoted} IS NULL"),
            AssignValue::Default => {
                return Err(DbErrorInfo::new("query", "定位键不能是 DEFAULT"));
            }
        });
    }
    Ok(clauses.join(" AND "))
}

/// 写入语句（无参数绑定路径）：值按方言字面量转义后内联。
///
/// SQLite 与 PostgreSQL 的会话连接不接受 `mysql_async` 的参数类型，因此这条
/// 路径全部用字面量。乐观并发比较走 `AdapterSet::null_safe_equal`
/// （MySQL 是 `<=>`、标准 SQL 是 `IS NOT DISTINCT FROM`），不在这里写死运算符。
fn literal_row_sql(
    adapter: &AdapterSet,
    qualified: &str,
    key_columns: &[String],
    row: &RowMutation,
) -> Result<String, DbErrorInfo> {
    let dialect = adapter.dialect();
    match row.kind.as_str() {
        "insert" => {
            let mut columns = Vec::new();
            let mut values = Vec::new();
            for assignment in &row.values {
                columns.push(dialect.quote(&assignment.column)?);
                values.push(match &assignment.value {
                    AssignValue::Null => "NULL".to_string(),
                    AssignValue::Default => "DEFAULT".to_string(),
                    AssignValue::Value { value } => sqlite_literal(dialect, value),
                });
            }
            if columns.is_empty() {
                return Err(DbErrorInfo::new(
                    "query",
                    "新增行没有任何列值：请使用 DEFAULT VALUES 之外的显式列",
                ));
            }
            Ok(format!(
                "INSERT INTO {qualified} ({}) VALUES ({})",
                columns.join(", "),
                values.join(", ")
            ))
        }
        "update" => {
            let key = row
                .key
                .as_ref()
                .ok_or_else(|| DbErrorInfo::new("query", "更新缺少行定位键"))?;
            if row.values.is_empty() {
                return Err(DbErrorInfo::new("query", "更新没有任何列值"));
            }
            let mut set_parts = Vec::new();
            for assignment in &row.values {
                let quoted = dialect.quote(&assignment.column)?;
                set_parts.push(match &assignment.value {
                    AssignValue::Null => format!("{quoted} = NULL"),
                    AssignValue::Default => format!("{quoted} = DEFAULT"),
                    AssignValue::Value { value } => {
                        format!("{quoted} = {}", sqlite_literal(dialect, value))
                    }
                });
            }
            let mut where_parts = vec![sqlite_key_clause(dialect, key, key_columns)?];
            if let Some(expected) = &row.expected {
                for assignment in expected {
                    let quoted = dialect.quote(&assignment.column)?;
                    where_parts.push(match &assignment.value {
                        AssignValue::Null => adapter.null_safe_equal(&quoted, "NULL"),
                        AssignValue::Default => {
                            return Err(DbErrorInfo::new(
                                "query",
                                "DEFAULT 不能作为乐观并发比较的期望值",
                            ))
                        }
                        AssignValue::Value { value } => {
                            adapter.null_safe_equal(&quoted, &sqlite_literal(dialect, value))
                        }
                    });
                }
            }
            Ok(format!(
                "UPDATE {qualified} SET {} WHERE {}",
                set_parts.join(", "),
                where_parts.join(" AND ")
            ))
        }
        "delete" => {
            let key = row
                .key
                .as_ref()
                .ok_or_else(|| DbErrorInfo::new("query", "删除缺少行定位键"))?;
            let mut where_parts = vec![sqlite_key_clause(dialect, key, key_columns)?];
            if let Some(expected) = &row.expected {
                for assignment in expected {
                    let quoted = dialect.quote(&assignment.column)?;
                    where_parts.push(match &assignment.value {
                        AssignValue::Null => adapter.null_safe_equal(&quoted, "NULL"),
                        AssignValue::Default => {
                            return Err(DbErrorInfo::new(
                                "query",
                                "DEFAULT 不能作为乐观并发比较的期望值",
                            ))
                        }
                        AssignValue::Value { value } => {
                            adapter.null_safe_equal(&quoted, &sqlite_literal(dialect, value))
                        }
                    });
                }
            }
            Ok(format!(
                "DELETE FROM {qualified} WHERE {}",
                where_parts.join(" AND ")
            ))
        }
        other => Err(DbErrorInfo::new(
            "query",
            format!("不支持的修改类型：{other}"),
        )),
    }
}

async fn pg_exec(conn: &super::driver::PostgresConn, sql: &str) -> Result<u64, DbErrorInfo> {
    let sets = conn.simple_query(sql, 0).await?;
    Ok(sets.iter().map(|set| set.affected_rows).sum())
}

/// PostgreSQL 写入：`BEGIN` → 逐行 → `COMMIT`；影响行数不是 1 就回滚。
#[allow(clippy::too_many_arguments)]
async fn apply_postgres(
    profile: &ProfileRuntime,
    session: &SessionEntry,
    detail: &DbTableDetail,
    key_columns: &[String],
    request: &MutationRequest,
    started: std::time::Instant,
    transactional: bool,
) -> Result<(MutationResult, DbSessionInfo), DbErrorInfo> {
    let adapter = profile.adapter()?;
    let dialect = adapter.dialect();
    let qualified = dialect.qualified(Some(&detail.database), &detail.table)?;
    let conn = session.acquire_postgres().await?;

    if transactional {
        if let Err(error) = pg_exec(&conn, "BEGIN").await {
            session
                .release_postgres(conn, true, TransactionState::None)
                .await;
            return Err(error);
        }
    }

    let mut outcomes: Vec<MutationRowOutcome> = Vec::new();
    let mut failure: Option<DbErrorInfo> = None;

    for (index, row) in request.rows.iter().enumerate() {
        let sql = match literal_row_sql(&adapter, &qualified, key_columns, row) {
            Ok(sql) => sql,
            Err(error) => {
                failure = Some(error);
                break;
            }
        };
        match pg_exec(&conn, &sql).await {
            Ok(affected) => {
                if affected != 1 {
                    outcomes.push(MutationRowOutcome {
                        index,
                        kind: row.kind.clone(),
                        affected_rows: affected,
                        status: "conflict".to_string(),
                        error: Some(DbErrorInfo::new(
                            "query",
                            if affected == 0 {
                                "没有匹配到这一行：可能已被其他会话修改/删除，或并发校验列的值已变化（可重试「跳过并发校验」）"
                            } else {
                                "影响行数超过 1：唯一键不再唯一，已停止"
                            },
                        )),
                    });
                    failure = Some(DbErrorInfo::new(
                        "query",
                        if affected == 0 {
                            "单行修改没有匹配到目标行：可能是并发修改/删除，或并发校验列已变化"
                        } else {
                            "单行修改影响多行：唯一键约束可能已损坏"
                        },
                    ));
                    break;
                }
                outcomes.push(MutationRowOutcome {
                    index,
                    kind: row.kind.clone(),
                    affected_rows: affected,
                    status: "applied".to_string(),
                    error: None,
                });
            }
            Err(error) => {
                outcomes.push(MutationRowOutcome {
                    index,
                    kind: row.kind.clone(),
                    affected_rows: 0,
                    status: "failed".to_string(),
                    error: Some(error.clone()),
                });
                failure = Some(error);
                break;
            }
        }
    }

    let committed_rows = outcomes
        .iter()
        .filter(|outcome| outcome.status == "applied")
        .count() as u64;

    if failure.is_some() {
        let rollback_failed = if transactional {
            pg_exec(&conn, "ROLLBACK").await.is_err()
        } else {
            false
        };
        if rollback_failed {
            // 回滚失败：事务可能还开着，绝不能报告"已回滚"。
            session
                .release_postgres(conn, false, TransactionState::Unknown)
                .await;
            return Ok((
                MutationResult {
                    state: "outcome_unknown".to_string(),
                    outcomes,
                    committed_rows: 0,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    transactional,
                    warning: Some(
                        "ROLLBACK 失败：事务可能仍未结束，结果未知；已丢弃会话，请重新连接后核对数据"
                            .to_string(),
                    ),
                    verify_hint: Some(verify_hint(dialect, detail, request)),
                },
                session.info().await,
            ));
        }
        for outcome in &mut outcomes {
            if outcome.status == "applied" {
                outcome.status = "rolled_back".to_string();
            }
        }
        let transaction = conn.transaction_state().await;
        session.release_postgres(conn, true, transaction).await;
        return Ok((
            MutationResult {
                state: "rolled_back".to_string(),
                outcomes,
                committed_rows: 0,
                elapsed_ms: started.elapsed().as_millis() as u64,
                transactional,
                warning: None,
                verify_hint: Some(verify_hint(dialect, detail, request)),
            },
            session.info().await,
        ));
    }

    if transactional {
        if let Err(error) = pg_exec(&conn, "COMMIT").await {
            session
                .release_postgres(conn, false, TransactionState::Unknown)
                .await;
            return Ok((
                MutationResult {
                    state: "outcome_unknown".to_string(),
                    outcomes,
                    committed_rows: 0,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    transactional,
                    warning: Some(format!(
                        "COMMIT 失败（{error}）：事务结果未知，不要自动重试"
                    )),
                    verify_hint: Some(verify_hint(dialect, detail, request)),
                },
                session.info().await,
            ));
        }
    }

    let transaction = conn.transaction_state().await;
    session.release_postgres(conn, true, transaction).await;
    Ok((
        MutationResult {
            state: "committed".to_string(),
            outcomes,
            committed_rows,
            elapsed_ms: started.elapsed().as_millis() as u64,
            transactional,
            warning: None,
            verify_hint: None,
        },
        session.info().await,
    ))
}

/// SQLite 写入：`BEGIN` → 逐行执行 → `COMMIT`；影响行数不是 1 就回滚。
#[allow(clippy::too_many_arguments)]
async fn apply_sqlite(
    profile: &ProfileRuntime,
    session: &SessionEntry,
    detail: &DbTableDetail,
    key_columns: &[String],
    request: &MutationRequest,
    started: std::time::Instant,
    transactional: bool,
) -> Result<(MutationResult, DbSessionInfo), DbErrorInfo> {
    let adapter = profile.adapter()?;
    let dialect = adapter.dialect();
    let qualified = dialect.qualified(Some(&detail.database), &detail.table)?;
    let worker = session.acquire_sqlite().await?;

    if transactional {
        if let Err(error) = worker.execute("BEGIN").await {
            session
                .release_sqlite(worker, true, TransactionState::None)
                .await;
            return Err(error);
        }
    }

    let mut outcomes: Vec<MutationRowOutcome> = Vec::new();
    let mut failure: Option<DbErrorInfo> = None;

    for (index, row) in request.rows.iter().enumerate() {
        let sql = match literal_row_sql(&adapter, &qualified, key_columns, row) {
            Ok(sql) => sql,
            Err(error) => {
                failure = Some(error);
                break;
            }
        };
        match worker.execute(&sql).await {
            Ok(answer) => {
                if answer.affected_rows != 1 {
                    outcomes.push(MutationRowOutcome {
                        index,
                        kind: row.kind.clone(),
                        affected_rows: answer.affected_rows.max(0) as u64,
                        status: "conflict".to_string(),
                        error: Some(DbErrorInfo::new(
                            "query",
                            if answer.affected_rows == 0 {
                                "没有匹配到这一行：可能已被其他会话修改/删除，或并发校验列的值已变化（可重试「跳过并发校验」）"
                            } else {
                                "影响行数超过 1：唯一键不再唯一，已停止"
                            },
                        )),
                    });
                    failure = Some(DbErrorInfo::new(
                        "query",
                        if answer.affected_rows == 0 {
                            "单行修改没有匹配到目标行：可能是并发修改/删除，或并发校验列已变化"
                        } else {
                            "单行修改影响多行：唯一键约束可能已损坏"
                        },
                    ));
                    break;
                }
                outcomes.push(MutationRowOutcome {
                    index,
                    kind: row.kind.clone(),
                    affected_rows: answer.affected_rows as u64,
                    status: "applied".to_string(),
                    error: None,
                });
            }
            Err(error) => {
                outcomes.push(MutationRowOutcome {
                    index,
                    kind: row.kind.clone(),
                    affected_rows: 0,
                    status: "failed".to_string(),
                    error: Some(error.clone()),
                });
                failure = Some(error);
                break;
            }
        }
    }

    let committed_rows = outcomes
        .iter()
        .filter(|outcome| outcome.status == "applied")
        .count() as u64;

    if failure.is_some() {
        let rollback_failed = if transactional {
            worker.execute("ROLLBACK").await.is_err()
        } else {
            false
        };
        if rollback_failed {
            // 回滚失败：事务可能还开着，绝不能报告"已回滚"。
            session
                .release_sqlite(worker, false, TransactionState::Unknown)
                .await;
            return Ok((
                MutationResult {
                    state: "outcome_unknown".to_string(),
                    outcomes,
                    committed_rows: 0,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    transactional,
                    warning: Some(
                        "ROLLBACK 失败：事务可能仍未结束，结果未知；已丢弃会话，请重新连接后核对数据"
                            .to_string(),
                    ),
                    verify_hint: Some(verify_hint(dialect, detail, request)),
                },
                session.info().await,
            ));
        }
        for outcome in &mut outcomes {
            if outcome.status == "applied" {
                outcome.status = "rolled_back".to_string();
            }
        }
        session
            .release_sqlite(worker, true, TransactionState::None)
            .await;
        return Ok((
            MutationResult {
                state: "rolled_back".to_string(),
                outcomes,
                committed_rows: 0,
                elapsed_ms: started.elapsed().as_millis() as u64,
                transactional,
                warning: None,
                verify_hint: Some(verify_hint(dialect, detail, request)),
            },
            session.info().await,
        ));
    }

    if transactional {
        if let Err(error) = worker.execute("COMMIT").await {
            // COMMIT 失败时事务可能已提交，也可能没有：不能猜。
            session
                .release_sqlite(worker, false, TransactionState::Unknown)
                .await;
            return Ok((
                MutationResult {
                    state: "outcome_unknown".to_string(),
                    outcomes,
                    committed_rows: 0,
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    transactional,
                    warning: Some(format!(
                        "COMMIT 失败（{error}）：事务结果未知，不要自动重试"
                    )),
                    verify_hint: Some(verify_hint(dialect, detail, request)),
                },
                session.info().await,
            ));
        }
    }

    session
        .release_sqlite(worker, true, TransactionState::None)
        .await;
    Ok((
        MutationResult {
            state: "committed".to_string(),
            outcomes,
            committed_rows,
            elapsed_ms: started.elapsed().as_millis() as u64,
            transactional,
            warning: None,
            verify_hint: None,
        },
        session.info().await,
    ))
}

async fn execute_row(
    adapter: &AdapterSet,
    conn: &mut Conn,
    detail: &DbTableDetail,
    key_columns: &[String],
    row: &RowMutation,
) -> Result<u64, DbErrorInfo> {
    let dialect = adapter.dialect();
    let qualified = dialect.qualified(Some(&detail.database), &detail.table)?;

    match row.kind.as_str() {
        "insert" => {
            let mut columns = Vec::new();
            let mut placeholders = Vec::new();
            let mut binder = Binder::new(dialect);
            for assignment in &row.values {
                columns.push(dialect.quote(&assignment.column)?);
                match &assignment.value {
                    AssignValue::Null => placeholders.push("NULL".to_string()),
                    AssignValue::Default => placeholders.push("DEFAULT".to_string()),
                    AssignValue::Value { value } => {
                        placeholders.push(bind_text(&mut binder, value));
                    }
                }
            }
            if columns.is_empty() {
                return Err(DbErrorInfo::new(
                    "query",
                    "新增行没有任何列值：请使用 DEFAULT VALUES 之外的显式列",
                ));
            }
            let sql = format!(
                "INSERT INTO {qualified} ({}) VALUES ({})",
                columns.join(", "),
                placeholders.join(", ")
            );
            conn.exec_drop(sql, Params::Positional(binder.params))
                .await
                .map_err(|error| map_error(&error, "query"))?;
            Ok(conn.affected_rows())
        }
        "update" => {
            let key = row
                .key
                .as_ref()
                .ok_or_else(|| DbErrorInfo::new("query", "更新缺少行定位键"))?;
            if row.values.is_empty() {
                return Err(DbErrorInfo::new("query", "更新没有任何列值"));
            }
            let mut binder = Binder::new(dialect);
            let mut set_parts = Vec::new();
            for assignment in &row.values {
                set_parts.push(assignment_sql(dialect, assignment, &mut binder)?);
            }
            let key_clause = key_sql(dialect, key, key_columns, &mut binder)?;

            let mut where_parts = vec![key_clause];
            if let Some(expected) = &row.expected {
                for assignment in expected {
                    where_parts.push(expected_sql(adapter, assignment, &mut binder)?);
                }
            }

            // 刻意不加 `LIMIT 1`：唯一键若已损坏，影响行数会 > 1，
            // 上层的“必须恰好 1 行”检查会回滚，而不是偷偷改一行。
            let sql = format!(
                "UPDATE {qualified} SET {} WHERE {}",
                set_parts.join(", "),
                where_parts.join(" AND ")
            );
            conn.exec_drop(sql, Params::Positional(binder.params))
                .await
                .map_err(|error| map_error(&error, "query"))?;
            Ok(conn.affected_rows())
        }
        "delete" => {
            let key = row
                .key
                .as_ref()
                .ok_or_else(|| DbErrorInfo::new("query", "删除缺少行定位键"))?;
            let mut binder = Binder::new(dialect);
            let key_clause = key_sql(dialect, key, key_columns, &mut binder)?;
            let mut where_parts = vec![key_clause];
            if let Some(expected) = &row.expected {
                for assignment in expected {
                    where_parts.push(expected_sql(adapter, assignment, &mut binder)?);
                }
            }
            let sql = format!(
                "DELETE FROM {qualified} WHERE {}",
                where_parts.join(" AND ")
            );
            conn.exec_drop(sql, Params::Positional(binder.params))
                .await
                .map_err(|error| map_error(&error, "query"))?;
            Ok(conn.affected_rows())
        }
        other => Err(DbErrorInfo::new(
            "query",
            format!("不支持的修改类型：{other}"),
        )),
    }
}

/// 结果未知时给用户的核对语句（**不自动执行**）。
fn verify_hint(dialect: &SqlDialect, detail: &DbTableDetail, request: &MutationRequest) -> String {
    let keys = detail.reliable_key.clone().unwrap_or_default();
    let qualified = dialect
        .qualified(Some(&detail.database), &detail.table)
        .unwrap_or_else(|_| format!("{}.{}", detail.database, detail.table));
    let mut hints = Vec::new();
    for row in request.rows.iter().take(5) {
        if let Some(key) = &row.key {
            let mut parts = Vec::new();
            for (index, column) in keys.iter().enumerate() {
                let Some(AssignValue::Value { value }) = key.get(index) else {
                    continue;
                };
                let Ok(quoted) = dialect.quote(column) else {
                    continue;
                };
                // 字面量必须按方言转义：MySQL 下反斜杠是转义符。
                parts.push(format!("{quoted} = {}", dialect.string_literal(value)));
            }
            if !parts.is_empty() {
                hints.push(format!(
                    "SELECT * FROM {qualified} WHERE {};",
                    parts.join(" AND ")
                ));
            }
        }
    }
    if hints.is_empty() {
        format!(
            "请重新打开 {}.{} 并刷新，确认这次修改是否已经生效",
            detail.database, detail.table
        )
    } else {
        hints.join("\n")
    }
}

/// 每个连接配置的只读开关在连接时就落到服务器端；
/// 这个函数只是 UI 的文案依据，不参与安全判断。
pub fn read_only_notice(read_only: bool) -> Option<&'static str> {
    read_only.then_some("只读连接：服务器会拒绝一切写语句")
}
