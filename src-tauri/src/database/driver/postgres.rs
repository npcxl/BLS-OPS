//! PostgreSQL 驱动：流式查询（`query_raw`）+ 独立控制连接判事务状态。
//!
//! 三条关键约束：
//!
//! * **事务状态不能用同一条连接查**：`SELECT state FROM pg_stat_activity
//!   WHERE pid = pg_backend_pid()` 在会话连接上执行时，自己必然是 `active`，
//!   永远判不出 `idle in transaction`。所以这里额外建一条控制连接，用它查
//!   会话连接的 backend pid。
//! * **SQL 编辑器走 `query_raw` 流式**：行/字节/单元格/时间预算都在流上执行，
//!   取消时 `CancelToken` 打断服务端查询，流被丢弃后连接可以复用。
//!   `query_raw` 是二进制协议，`numeric` 用 `rust_decimal`、`bigint` 用 `i64`
//!   再转字符串，精度不丢。
//! * `simple_query` 只保留给元数据、DDL 与导出的分页读取（需要多语句或文本语义）。
//!
//! TLS 未接入：只支持 `tls_mode = disabled`，其它模式在 runtime 里明确拒绝。

use std::time::Duration;

use base64::Engine;
use tokio_postgres::error::SqlState;
use tokio_postgres::{Client, Column, NoTls, Row, SimpleQueryMessage};

use super::super::model::{DbColumn, DbErrorInfo, DbValue};
use super::super::protocol::TransactionState;

/// 已解析的连接端点（PostgreSQL 不需要隧道之外的改写）。
pub struct PostgresEndpoint {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    pub database: String,
}

impl PostgresEndpoint {
    fn config(&self, timeout: Duration) -> tokio_postgres::Config {
        let mut config = tokio_postgres::Config::new();
        config
            .host(&self.host)
            .port(self.port)
            .user(&self.user)
            .dbname(&self.database)
            .application_name("BLS-OPS");
        if let Some(password) = &self.password {
            config.password(password);
        }
        config.connect_timeout(timeout);
        config
    }
}

/// 一条结果集（`simple_query` 里由 `CommandComplete` 分隔）。
pub struct PostgresResultSet {
    pub columns: Vec<DbColumn>,
    pub rows: Vec<Vec<DbValue>>,
    pub affected_rows: u64,
    pub truncated: bool,
}

pub struct PostgresConn {
    client: Client,
    /// 独立控制连接：只用来查 `pg_stat_activity`，不跑用户 SQL。
    control: Option<Client>,
    backend_pid: i32,
}

impl PostgresConn {
    /// 建立独占连接 + 一条控制连接。
    ///
    /// 控制连接失败不阻断主连接（用户仍然能查数据），但事务状态会变成
    /// `Unknown`，写操作入口会因此明确拒绝 —— 不拿"猜"代替事实。
    pub async fn connect(
        endpoint: &PostgresEndpoint,
        timeout: Duration,
    ) -> Result<Self, DbErrorInfo> {
        let (client, connection) =
            tokio::time::timeout(timeout, endpoint.config(timeout).connect(NoTls))
                .await
                .map_err(|_| {
                    DbErrorInfo::new("tcp", "PostgreSQL 连接超时")
                        .retryable(true)
                        .with_detail("请检查地址、端口、pg_hba.conf 与安全组。")
                })?
                .map_err(|error| map_error(&error, "tcp"))?;
        tokio::spawn(async move {
            if let Err(error) = connection.await {
                eprintln!("postgres connection closed: {error}");
            }
        });

        let backend_pid = read_backend_pid(&client).await.unwrap_or(0);
        let control =
            match tokio::time::timeout(timeout, endpoint.config(timeout).connect(NoTls)).await {
                Ok(Ok((control, connection))) => {
                    tokio::spawn(async move {
                        if let Err(error) = connection.await {
                            eprintln!("postgres control connection closed: {error}");
                        }
                    });
                    Some(control)
                }
                _ => None,
            };

        Ok(Self {
            client,
            control,
            backend_pid,
        })
    }

    pub fn cancel_token(&self) -> tokio_postgres::CancelToken {
        self.client.cancel_token()
    }

    pub fn is_closed(&self) -> bool {
        self.client.is_closed()
    }

    pub fn backend_pid(&self) -> Option<u32> {
        (self.backend_pid > 0).then_some(self.backend_pid as u32)
    }

    /// 流式查询：返回列元数据（零行也有）+ 行流。
    ///
    /// 列信息来自 `Statement::columns()`（Describe 阶段返回），所以
    /// `SELECT ... WHERE false` 这种零行结果也有列，前端不会显示一张没表头的表。
    ///
    /// 只接受**单条语句**：`prepare` 不支持多语句，调用方负责按方言拆分。
    pub async fn query_stream(
        &self,
        sql: &str,
    ) -> Result<(Vec<DbColumn>, tokio_postgres::RowStream), DbErrorInfo> {
        let statement = self
            .client
            .prepare(sql)
            .await
            .map_err(|error| map_error(&error, "query"))?;
        let mut columns: Vec<DbColumn> = statement
            .columns()
            .iter()
            .enumerate()
            .map(|(index, column)| column_meta(index, column))
            .collect();
        let oids: Vec<u32> = statement
            .columns()
            .iter()
            .filter_map(|column| column.table_oid())
            .collect();
        if !oids.is_empty() {
            // Resolve protocol table/attribute identities, never infer a table from
            // a display alias or from the connection's current search_path.
            if let Ok(origins) = self.client.query(
                "SELECT c.oid, a.attnum, n.nspname, c.relname, a.attname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid WHERE c.oid=ANY($1) AND a.attnum>0 AND NOT a.attisdropped",
                &[&oids],
            ).await {
                for (index, column) in statement.columns().iter().enumerate() {
                    if let (Some(oid), Some(attnum)) = (column.table_oid(), column.column_id()) {
                        if let Some(origin) = origins.iter().find(|row| row.get::<_, u32>(0) == oid && row.get::<_, i16>(1) == attnum) {
                            columns[index].origin_database = Some(origin.get(2));
                            columns[index].org_table = origin.get(3);
                            columns[index].org_name = origin.get(4);
                        }
                    }
                }
            }
        }
        let stream = self
            .client
            .query_raw(&statement, std::iter::empty::<&str>())
            .await
            .map_err(|error| map_error(&error, "query"))?;
        Ok((columns, stream))
    }

    /// 执行一段 SQL（可含多条语句），返回按 `CommandComplete` 分隔的结果集。
    ///
    /// 用于元数据、DDL 与导出的分页读取：这些场景要么需要多语句，要么需要
    /// 文本语义，不适合走流式。
    pub async fn simple_query(
        &self,
        sql: &str,
        max_rows: u64,
    ) -> Result<Vec<PostgresResultSet>, DbErrorInfo> {
        let messages = self
            .client
            .simple_query(sql)
            .await
            .map_err(|error| map_error(&error, "query"))?;

        let mut sets: Vec<PostgresResultSet> = Vec::new();
        let mut current: Option<PostgresResultSet> = None;
        for message in messages {
            match message {
                SimpleQueryMessage::Row(row) => {
                    if current.is_none() {
                        let columns = row
                            .columns()
                            .iter()
                            .enumerate()
                            .map(|(index, column)| DbColumn {
                                origin_database: None,
                                index,
                                name: column.name().to_string(),
                                org_name: column.name().to_string(),
                                table: String::new(),
                                org_table: String::new(),
                                type_name: String::new(),
                                type_code: 0,
                                nullable: true,
                                unsigned: false,
                                binary: false,
                                primary_key: false,
                                auto_increment: false,
                                decimals: 0,
                                charset: 0,
                            })
                            .collect();
                        current = Some(PostgresResultSet {
                            columns,
                            rows: Vec::new(),
                            affected_rows: 0,
                            truncated: false,
                        });
                    }
                    if let Some(set) = &mut current {
                        if set.rows.len() as u64 >= max_rows {
                            set.truncated = true;
                        } else {
                            let values = (0..row.columns().len())
                                .map(|index| to_value("text", row.get(index)))
                                .collect();
                            set.rows.push(values);
                        }
                    }
                }
                SimpleQueryMessage::CommandComplete(affected) => {
                    if let Some(set) = current.take() {
                        sets.push(set);
                    } else {
                        sets.push(PostgresResultSet {
                            columns: Vec::new(),
                            rows: Vec::new(),
                            affected_rows: affected,
                            truncated: false,
                        });
                    }
                }
                _ => {}
            }
        }
        if let Some(set) = current.take() {
            sets.push(set);
        }
        Ok(sets)
    }

    pub async fn server_version(&self) -> Option<String> {
        let sets = self.simple_query("SHOW server_version", 1).await.ok()?;
        sets.first()
            .and_then(|set| set.rows.first())
            .and_then(|row| row.first())
            .and_then(|value| match value {
                DbValue::Text { value, .. } => Some(format!("PostgreSQL {value}")),
                _ => None,
            })
    }

    /// 事务状态：**在控制连接上**查会话连接的 `pg_stat_activity.state`。
    ///
    /// 会话连接空闲时：
    /// * `idle` → 没有打开的事务；
    /// * `idle in transaction` / `idle in transaction (aborted)` → 有事务；
    /// * `active` 或控制连接不可用 → `Unknown`（写入会被拒绝，不猜）。
    pub async fn transaction_state(&self) -> TransactionState {
        let Some(control) = &self.control else {
            return TransactionState::Unknown;
        };
        if control.is_closed() || self.backend_pid <= 0 {
            return TransactionState::Unknown;
        }
        let sql = format!(
            "SELECT state FROM pg_stat_activity WHERE pid = {}",
            self.backend_pid
        );
        let Ok(messages) = control.simple_query(&sql).await else {
            return TransactionState::Unknown;
        };
        let state = messages.into_iter().find_map(|message| match message {
            SimpleQueryMessage::Row(row) => row.get(0).map(str::to_string),
            _ => None,
        });
        match state.as_deref() {
            Some("idle") => TransactionState::None,
            Some("idle in transaction") | Some("idle in transaction (aborted)") => {
                TransactionState::InTransaction
            }
            // `active` 表示会话连接正在执行语句，此刻的事务状态无法确认。
            _ => TransactionState::Unknown,
        }
    }

    /// 取消当前连接的查询（走独立的 cancel 请求连接）。
    pub async fn cancel(&self) -> Result<(), DbErrorInfo> {
        self.client
            .cancel_token()
            .cancel_query(NoTls)
            .await
            .map_err(|error| DbErrorInfo::new("cancelled", format!("取消请求失败：{error}")))
    }

    pub async fn close(&self) {
        let _ = self.client.simple_query("SELECT 1").await;
    }
}

async fn read_backend_pid(client: &Client) -> Option<i32> {
    let messages = client
        .simple_query("SELECT pg_backend_pid() AS pid")
        .await
        .ok()?;
    messages.into_iter().find_map(|message| match message {
        SimpleQueryMessage::Row(row) => row.get(0).and_then(|value| value.parse().ok()),
        _ => None,
    })
}

fn column_meta(index: usize, column: &Column) -> DbColumn {
    DbColumn {
        origin_database: None,
        index,
        name: column.name().to_string(),
        org_name: column.name().to_string(),
        // `Column` 只给 table_oid，不给表名；这里的 table 用于展示来源，
        // 留空由前端按 SQL 显示，不编一个 OID 当表名。
        table: String::new(),
        org_table: String::new(),
        type_name: column.type_().name().to_string(),
        type_code: 0,
        nullable: true,
        unsigned: false,
        binary: false,
        primary_key: false,
        auto_increment: false,
        decimals: 0,
        charset: 0,
    }
}

/// PostgreSQL `numeric` 的二进制解码。
///
/// `tokio-postgres` 没有 decimal feature，而 `numeric` 一旦走 `f64` 就会把
/// `12345678901234567890.123456789` 悄悄改掉。这里按协议格式自己解：
/// `int16 ndigits | int16 weight | uint16 sign | uint16 dscale | int16 digits[]`
/// （digit 是 base 10000）。
struct NumericText(String);

impl<'a> tokio_postgres::types::FromSql<'a> for NumericText {
    fn from_sql(
        _ty: &tokio_postgres::types::Type,
        raw: &'a [u8],
    ) -> Result<Self, Box<dyn std::error::Error + Sync + Send>> {
        numeric_to_string(raw)
            .map(NumericText)
            .map_err(|error| error.into())
    }

    fn accepts(ty: &tokio_postgres::types::Type) -> bool {
        *ty == tokio_postgres::types::Type::NUMERIC
    }
}

fn numeric_to_string(raw: &[u8]) -> Result<String, String> {
    if raw.len() < 8 {
        return Err("numeric 数据长度不足".to_string());
    }
    let ndigits = i16::from_be_bytes([raw[0], raw[1]]);
    let weight = i16::from_be_bytes([raw[2], raw[3]]);
    let sign = u16::from_be_bytes([raw[4], raw[5]]);
    let dscale = u16::from_be_bytes([raw[6], raw[7]]) as usize;
    match sign {
        0xC000 => return Ok("NaN".to_string()),
        0xD000 => return Ok("Infinity".to_string()),
        0xF000 => return Ok("-Infinity".to_string()),
        _ => {}
    }
    if ndigits < 0 {
        return Err("numeric 位数非法".to_string());
    }

    let mut digits = Vec::with_capacity(ndigits as usize);
    for index in 0..ndigits as usize {
        let offset = 8 + index * 2;
        if offset + 2 > raw.len() {
            return Err("numeric 数字段不完整".to_string());
        }
        digits.push(i16::from_be_bytes([raw[offset], raw[offset + 1]]) as i32);
    }

    let fraction_groups = dscale.div_ceil(4);
    let mut integer_part = String::new();
    let mut fraction_part = String::new();
    if weight >= 0 {
        for group in 0..=weight as usize {
            let value = digits.get(group).copied().unwrap_or(0);
            if group == 0 {
                integer_part.push_str(&value.to_string());
            } else {
                integer_part.push_str(&format!("{value:04}"));
            }
        }
        for group in 0..fraction_groups {
            let value = digits
                .get(weight as usize + 1 + group)
                .copied()
                .unwrap_or(0);
            fraction_part.push_str(&format!("{value:04}"));
        }
    } else {
        integer_part.push('0');
        // weight < -1 时，小数前面还有空组，必须补足位数。
        for _ in 0..(-weight - 1) as usize {
            fraction_part.push_str("0000");
        }
        for group in 0..fraction_groups {
            let value = digits.get(group).copied().unwrap_or(0);
            fraction_part.push_str(&format!("{value:04}"));
        }
    }
    fraction_part.truncate(dscale);

    let mut out = integer_part;
    if !fraction_part.is_empty() {
        out.push('.');
        out.push_str(&fraction_part);
    }
    if sign == 0x4000 {
        out.insert(0, '-');
    }
    Ok(out)
}

fn unsupported(type_name: &str) -> DbValue {
    DbValue::Unsupported {
        type_name: type_name.to_string(),
        preview: format!("<{type_name}>"),
        bytes: 0,
    }
}

fn text_cell(value: String, preview_bytes: usize) -> DbValue {
    let bytes = value.len();
    if preview_bytes > 0 && bytes > preview_bytes {
        let mut end = preview_bytes;
        while end > 0 && !value.is_char_boundary(end) {
            end -= 1;
        }
        DbValue::Text {
            value: value[..end].to_string(),
            bytes,
            truncated: true,
        }
    } else {
        DbValue::Text {
            value,
            bytes,
            truncated: false,
        }
    }
}

/// 按列类型解码一个单元格（流式路径）。
///
/// 二进制协议下 `numeric` 必须走 `Decimal`（不能用 f64），`bigint` 用 `i64`
/// 再转字符串 —— 这样前端拿到的仍然是精确值。
pub fn decode_cell(row: &Row, index: usize, preview_bytes: usize) -> DbValue {
    let type_name = row.columns()[index].type_().name();
    macro_rules! cell {
        ($ty:ty, $map:expr) => {
            match row.try_get::<_, Option<$ty>>(index) {
                Ok(Some(value)) => ($map)(value),
                Ok(None) => DbValue::Null,
                Err(_) => unsupported(type_name),
            }
        };
    }

    match type_name {
        "bool" => cell!(bool, |value: bool| DbValue::Text {
            value: if value { "true" } else { "false" }.to_string(),
            bytes: 4,
            truncated: false,
        }),
        "int2" => cell!(i16, |value: i16| DbValue::Int {
            value: value.to_string(),
            unsigned: false,
        }),
        "int4" => cell!(i32, |value: i32| DbValue::Int {
            value: value.to_string(),
            unsigned: false,
        }),
        "int8" => cell!(i64, |value: i64| DbValue::Int {
            value: value.to_string(),
            unsigned: false,
        }),
        "oid" => cell!(u32, |value: u32| DbValue::Int {
            value: value.to_string(),
            unsigned: true,
        }),
        "float4" => cell!(f32, |value: f32| DbValue::Float {
            value: value as f64,
        }),
        "float8" => cell!(f64, |value: f64| DbValue::Float { value }),
        "numeric" => cell!(NumericText, |value: NumericText| DbValue::Decimal {
            value: value.0,
        }),
        // money 的二进制是 i64（最小货币单位），按 Decimal 展示。
        "money" => cell!(i64, |value: i64| DbValue::Decimal {
            value: value.to_string(),
        }),
        "text" | "varchar" | "bpchar" | "char" | "name" | "citext" | "unknown" => {
            cell!(String, |value: String| text_cell(value, preview_bytes))
        }
        "json" | "jsonb" => cell!(serde_json::Value, |value: serde_json::Value| {
            let text = value.to_string();
            let mut cell = text_cell(text, preview_bytes);
            if let DbValue::Text {
                value,
                bytes,
                truncated,
            } = cell
            {
                cell = DbValue::Json {
                    value,
                    bytes,
                    truncated,
                };
            }
            cell
        }),
        "bytea" => cell!(Vec<u8>, |value: Vec<u8>| {
            let bytes = value.len();
            let truncated = preview_bytes > 0 && bytes > preview_bytes;
            let slice = if truncated {
                &value[..preview_bytes.min(bytes)]
            } else {
                &value[..]
            };
            DbValue::Binary {
                base64: base64::engine::general_purpose::STANDARD.encode(slice),
                bytes,
                truncated,
            }
        }),
        "date" => cell!(chrono::NaiveDate, |value: chrono::NaiveDate| {
            DbValue::Date {
                value: value.to_string(),
            }
        }),
        "timestamp" => cell!(chrono::NaiveDateTime, |value: chrono::NaiveDateTime| {
            DbValue::DateTime {
                value: value.to_string(),
                timezone: String::new(),
            }
        }),
        "timestamptz" => cell!(chrono::DateTime<chrono::Utc>, |value: chrono::DateTime<
            chrono::Utc,
        >| {
            DbValue::DateTime {
                value: value.to_rfc3339(),
                timezone: "UTC".to_string(),
            }
        }),
        "time" => cell!(chrono::NaiveTime, |value: chrono::NaiveTime| {
            DbValue::Time {
                value: value.to_string(),
            }
        }),
        _ => unsupported(type_name),
    }
}

fn to_value(_type_name: &str, raw: Option<&str>) -> DbValue {
    let Some(text) = raw else {
        return DbValue::Null;
    };
    DbValue::Text {
        value: text.to_string(),
        bytes: text.len(),
        truncated: false,
    }
}

/// 结构化错误映射。SQLSTATE 决定阶段，不把连接错误说成查询错误。
pub fn map_error(error: &tokio_postgres::Error, stage_hint: &str) -> DbErrorInfo {
    if let Some(db) = error.as_db_error() {
        let code = db.code();
        let stage = if *code == SqlState::INVALID_PASSWORD
            || *code == SqlState::INVALID_AUTHORIZATION_SPECIFICATION
        {
            "auth"
        } else if *code == SqlState::INVALID_CATALOG_NAME {
            "database"
        } else if *code == SqlState::INSUFFICIENT_PRIVILEGE {
            "permission"
        } else if *code == SqlState::QUERY_CANCELED {
            "cancelled"
        } else {
            stage_hint
        };
        return DbErrorInfo {
            stage: stage.to_string(),
            code: Some(db.code().code().parse().unwrap_or(0)),
            sql_state: Some(db.code().code().to_string()),
            message: db.message().to_string(),
            detail: None,
            retryable: false,
        };
    }
    if error.is_closed() {
        return DbErrorInfo::new("tcp", "PostgreSQL 连接已断开").retryable(true);
    }
    DbErrorInfo::new(stage_hint, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_decoding_keeps_precision() {
        // 1.23：ndigits=2, weight=0, sign=0, dscale=2, digits=[1, 2300]
        assert_eq!(
            numeric_to_string(&[0, 2, 0, 0, 0, 0, 0, 2, 0, 1, 8, 252]).unwrap(),
            "1.23"
        );
        // -0.5：ndigits=1, weight=-1, sign=0x4000, dscale=1, digits=[5000]
        assert_eq!(
            numeric_to_string(&[0, 1, 255, 255, 64, 0, 0, 1, 19, 136]).unwrap(),
            "-0.5"
        );
        // NaN 必须原样给出，不能变成 0。
        assert_eq!(
            numeric_to_string(&[0, 0, 0, 0, 192, 0, 0, 0]).unwrap(),
            "NaN"
        );
        // 长度不足必须报错，不能返回一个看起来正常的数字。
        assert!(numeric_to_string(&[0, 1]).is_err());
    }

    #[test]
    fn text_cell_truncates_on_char_boundary() {
        let cell = text_cell("中文内容".to_string(), 4);
        match cell {
            DbValue::Text {
                value,
                bytes,
                truncated,
            } => {
                assert_eq!(bytes, 12);
                assert!(truncated);
                assert_eq!(value, "中");
            }
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn text_cell_keeps_short_values() {
        match text_cell("ok".to_string(), 64) {
            DbValue::Text {
                value, truncated, ..
            } => {
                assert_eq!(value, "ok");
                assert!(!truncated);
            }
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn unknown_type_is_reported_not_guessed() {
        match unsupported("interval") {
            DbValue::Unsupported { type_name, .. } => assert_eq!(type_name, "interval"),
            other => panic!("expected unsupported, got {other:?}"),
        }
    }
}
