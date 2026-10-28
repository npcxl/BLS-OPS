//! 单表新增 / 修改 / 删除：显式提交、事务、影响行数校验、乐观并发。
//!
//! 规则（每一条都是"宁可拒绝，也不假装成功"）：
//!
//! * **没有可靠唯一键 → 拒绝写入**。视图、复杂查询结果、无主键表一律只读。
//! * **事务固定物理连接**：用会话独占的 `Conn`，绝不从池里临时取一条。
//! * 一条 UPDATE/DELETE 影响行数不是 1 → 回滚并报冲突（或键不再唯一）。
//! * 乐观并发用 `<=>`（NULL-safe）比较读取时的值；远程已改 → 冲突。
//! * 非事务引擎（MyISAM 等）默认拒绝；用户显式确认后才逐行执行，
//!   并明确写出"失败的行无法回滚"。
//! * `COMMIT` 期间断网 → `outcome_unknown`，不自动重试，给出重新核对入口。
//! * 开启 `client_found_rows`：UPDATE 即使值没变也算 1 行匹配，
//!   这样"0 行"就只可能是冲突/行不存在。

use std::time::{Duration, Instant};

use mysql_async::prelude::Queryable;
use mysql_async::{Conn, Params, Value};

use super::driver::{map_error, quote_identifier};
use super::model::{
    AssignValue, ColumnAssignment, DbErrorInfo, DbSessionInfo, DbTableDetail, MutationRequest,
    MutationResult, MutationRowOutcome, RowMutation,
};
use super::runtime::ProfileRuntime;
use super::session::SessionEntry;

const TRANSACTIONAL_ENGINES: [&str; 3] = ["innodb", "ndbcluster", "ndb"];

fn is_transactional(engine: &Option<String>) -> bool {
    engine
        .as_deref()
        .map(|value| TRANSACTIONAL_ENGINES.contains(&value.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
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

fn assignment_sql(assignment: &ColumnAssignment) -> Result<(String, Option<Value>), DbErrorInfo> {
    let quoted = quote_identifier(&assignment.column)?;
    match &assignment.value {
        AssignValue::Null => Ok((format!("{quoted} = NULL"), None)),
        AssignValue::Default => Ok((format!("{quoted} = DEFAULT"), None)),
        AssignValue::Value { value } => Ok((
            format!("{quoted} = ?"),
            Some(Value::Bytes(value.clone().into_bytes())),
        )),
    }
}

fn expected_sql(assignment: &ColumnAssignment) -> Result<(String, Option<Value>), DbErrorInfo> {
    let quoted = quote_identifier(&assignment.column)?;
    match &assignment.value {
        AssignValue::Null => Ok((format!("{quoted} <=> NULL"), None)),
        AssignValue::Default => Err(DbErrorInfo::new(
            "query",
            "DEFAULT 不能作为乐观并发比较的期望值",
        )),
        AssignValue::Value { value } => Ok((
            format!("{quoted} <=> ?"),
            Some(Value::Bytes(value.clone().into_bytes())),
        )),
    }
}

fn key_sql(key: &[AssignValue], columns: &[String]) -> Result<(String, Vec<Value>), DbErrorInfo> {
    if key.len() != columns.len() {
        return Err(DbErrorInfo::new("query", "行定位键与表的主键列数量不一致"));
    }
    let mut clauses = Vec::new();
    let mut params = Vec::new();
    for (index, column) in columns.iter().enumerate() {
        match &key[index] {
            AssignValue::Value { value } => {
                clauses.push(format!("{} = ?", quote_identifier(column)?));
                params.push(Value::Bytes(value.clone().into_bytes()));
            }
            AssignValue::Null => clauses.push(format!("{} IS NULL", quote_identifier(column)?)),
            AssignValue::Default => {
                return Err(DbErrorInfo::new("query", "定位键不能是 DEFAULT"));
            }
        }
    }
    Ok((clauses.join(" AND "), params))
}

pub async fn apply(
    profile: &ProfileRuntime,
    session: &SessionEntry,
    detail: &DbTableDetail,
    request: &MutationRequest,
) -> Result<(MutationResult, DbSessionInfo), DbErrorInfo> {
    let started = Instant::now();

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

    let transactional = is_transactional(&detail.engine);
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
    if matches!(
        session_transaction.as_str(),
        "in_transaction" | "in_transaction_read_only"
    ) {
        return Err(DbErrorInfo::new(
            "query",
            "当前会话有未提交事务：请先 COMMIT 或 ROLLBACK，再应用表格修改；本工具不会替你隐式提交",
        ));
    }

    let conn = session.acquire_conn().await?;
    let mut conn = conn;

    if transactional {
        if let Err(error) = conn.query_drop("START TRANSACTION").await {
            session.release_conn(conn, true).await;
            return Err(map_error(&error, "query"));
        }
    }

    let mut outcomes: Vec<MutationRowOutcome> = Vec::new();
    let mut failure: Option<DbErrorInfo> = None;
    let mut unknown = false;

    for (index, row) in request.rows.iter().enumerate() {
        match execute_row(&mut conn, detail, &key_columns, row).await {
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
                                "影响行数为 0：远程数据已变化（或行已被删除）"
                            } else {
                                "影响行数超过 1：唯一键不再唯一，已停止"
                            },
                        )),
                    });
                    failure = Some(DbErrorInfo::new(
                        "query",
                        if affected == 0 {
                            "单行修改影响了 0 行：可能是并发修改或被删除"
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
                    verify_hint: Some(verify_hint(detail, request)),
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
                verify_hint: failure.map(|_| verify_hint(detail, request)),
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
                        verify_hint: Some(verify_hint(detail, request)),
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
                        verify_hint: Some(verify_hint(detail, request)),
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

async fn execute_row(
    conn: &mut Conn,
    detail: &DbTableDetail,
    key_columns: &[String],
    row: &RowMutation,
) -> Result<u64, DbErrorInfo> {
    let quoted_database = quote_identifier(&detail.database)?;
    let quoted_table = quote_identifier(&detail.table)?;

    match row.kind.as_str() {
        "insert" => {
            let mut columns = Vec::new();
            let mut placeholders = Vec::new();
            let mut params: Vec<Value> = Vec::new();
            for assignment in &row.values {
                columns.push(quote_identifier(&assignment.column)?);
                match &assignment.value {
                    AssignValue::Null => placeholders.push("NULL".to_string()),
                    AssignValue::Default => placeholders.push("DEFAULT".to_string()),
                    AssignValue::Value { value } => {
                        placeholders.push("?".to_string());
                        params.push(Value::Bytes(value.clone().into_bytes()));
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
                "INSERT INTO {quoted_database}.{quoted_table} ({}) VALUES ({})",
                columns.join(", "),
                placeholders.join(", ")
            );
            conn.exec_drop(sql, Params::Positional(params))
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
            let mut set_parts = Vec::new();
            let mut params: Vec<Value> = Vec::new();
            for assignment in &row.values {
                let (sql, param) = assignment_sql(assignment)?;
                set_parts.push(sql);
                if let Some(param) = param {
                    params.push(param);
                }
            }
            let (key_clause, key_params) = key_sql(key, key_columns)?;
            params.extend(key_params);

            let mut where_parts = vec![key_clause];
            if let Some(expected) = &row.expected {
                for assignment in expected {
                    let (sql, param) = expected_sql(assignment)?;
                    where_parts.push(sql);
                    if let Some(param) = param {
                        params.push(param);
                    }
                }
            }

            // 刻意不加 `LIMIT 1`：唯一键若已损坏，影响行数会 > 1，
            // 上层的“必须恰好 1 行”检查会回滚，而不是偷偷改一行。
            let sql = format!(
                "UPDATE {quoted_database}.{quoted_table} SET {} WHERE {}",
                set_parts.join(", "),
                where_parts.join(" AND ")
            );
            conn.exec_drop(sql, Params::Positional(params))
                .await
                .map_err(|error| map_error(&error, "query"))?;
            Ok(conn.affected_rows())
        }
        "delete" => {
            let key = row
                .key
                .as_ref()
                .ok_or_else(|| DbErrorInfo::new("query", "删除缺少行定位键"))?;
            let (key_clause, mut params) = key_sql(key, key_columns)?;
            let mut where_parts = vec![key_clause];
            if let Some(expected) = &row.expected {
                for assignment in expected {
                    let (sql, param) = expected_sql(assignment)?;
                    where_parts.push(sql);
                    if let Some(param) = param {
                        params.push(param);
                    }
                }
            }
            let sql = format!(
                "DELETE FROM {quoted_database}.{quoted_table} WHERE {}",
                where_parts.join(" AND ")
            );
            conn.exec_drop(sql, Params::Positional(params))
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
fn verify_hint(detail: &DbTableDetail, request: &MutationRequest) -> String {
    let keys = detail.reliable_key.clone().unwrap_or_default();
    let mut hints = Vec::new();
    for row in request.rows.iter().take(5) {
        if let Some(key) = &row.key {
            let mut parts = Vec::new();
            for (index, column) in keys.iter().enumerate() {
                if let Some(AssignValue::Value { value }) = key.get(index) {
                    parts.push(format!("{} = '{}'", column, value.replace('\'', "''")));
                }
            }
            if !parts.is_empty() {
                hints.push(format!(
                    "SELECT * FROM {}.{} WHERE {};",
                    detail.database,
                    detail.table,
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
