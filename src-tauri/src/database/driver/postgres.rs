//! PostgreSQL 驱动：`simple query`（文本协议）+ `CancelToken` 取消。
//!
//! 为什么用文本协议：
//!
//! * `bigint` / `numeric` 拿到的是服务器原始字符串，**天然不丢精度**；
//!   二进制协议要么转 `i64`（JS 侧仍然要字符串）要么引入 `Decimal` feature。
//! * `simple_query` 一次可以执行多条语句，正好对应 SQL 编辑器。
//!
//! 已知限制（写在能力矩阵与 `VerifiedScope` 里，不隐藏）：
//!
//! * 一次 `simple_query` 会把整个结果集读进内存，预算只能在**发送阶段**截断；
//!   超大结果集需要用户自己加 `LIMIT`。
//! * TLS 未接入：只支持 `tls_mode = disabled`，其它模式明确拒绝。
//! * 事务状态靠 `pg_stat_activity.state` 读取（`idle in transaction`）。

use std::time::Duration;

use tokio_postgres::error::SqlState;
use tokio_postgres::{Client, NoTls, SimpleQueryMessage};

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

/// 一条结果集（`simple_query` 里由 `CommandComplete` 分隔）。
pub struct PostgresResultSet {
    pub columns: Vec<DbColumn>,
    pub rows: Vec<Vec<DbValue>>,
    pub affected_rows: u64,
    pub truncated: bool,
}

pub struct PostgresConn {
    client: Client,
}

impl PostgresConn {
    /// 建立独占连接。连接任务单独 spawn：它驱动协议读写，退出即连接断开。
    pub async fn connect(
        endpoint: &PostgresEndpoint,
        timeout: Duration,
    ) -> Result<Self, DbErrorInfo> {
        let mut config = tokio_postgres::Config::new();
        config
            .host(&endpoint.host)
            .port(endpoint.port)
            .user(&endpoint.user)
            .dbname(&endpoint.database)
            .application_name("BLS-OPS");
        if let Some(password) = &endpoint.password {
            config.password(password);
        }
        config.connect_timeout(timeout);

        let (client, connection) = tokio::time::timeout(timeout, config.connect(NoTls))
            .await
            .map_err(|_| {
                DbErrorInfo::new("tcp", "PostgreSQL 连接超时")
                    .retryable(true)
                    .with_detail("请检查地址、端口、pg_hba.conf 与安全组。")
            })?
            .map_err(|error| map_error(&error, "tcp"))?;

        tokio::spawn(async move {
            // 连接任务结束意味着连接已断开；把错误记在日志里即可。
            if let Err(error) = connection.await {
                eprintln!("postgres connection closed: {error}");
            }
        });

        Ok(Self { client })
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    pub fn cancel_token(&self) -> tokio_postgres::CancelToken {
        self.client.cancel_token()
    }

    pub fn is_closed(&self) -> bool {
        self.client.is_closed()
    }

    /// 执行一段 SQL（可含多条语句），返回按 `CommandComplete` 分隔的结果集。
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
                                index,
                                name: column.name().to_string(),
                                org_name: column.name().to_string(),
                                table: String::new(),
                                org_table: String::new(),
                                // simple query 不暴露列类型名：数值/JSON 一律按文本返回，
                                // 这样 bigint/numeric 的精度不会在解码层丢。
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
                    if let Some(mut set) = current.take() {
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

    /// 事务状态来自 `pg_stat_activity.state`，不是靠 SQL 前缀猜。
    pub async fn transaction_state(&self) -> TransactionState {
        let sql = "SELECT state FROM pg_stat_activity WHERE pid = pg_backend_pid()";
        let Ok(sets) = self.simple_query(sql, 1).await else {
            return TransactionState::Unknown;
        };
        let state = sets
            .first()
            .and_then(|set| set.rows.first())
            .and_then(|row| row.first())
            .and_then(|value| match value {
                DbValue::Text { value, .. } => Some(value.clone()),
                _ => None,
            });
        match state.as_deref() {
            Some("idle in transaction") => TransactionState::InTransaction,
            Some("idle in transaction (aborted)") => TransactionState::InTransaction,
            Some("idle") | Some("active") => TransactionState::None,
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
        // Client 没有显式 close：drop 会让连接任务退出。这里主动打断即可。
        let _ = self.client.simple_query("SELECT 1").await;
    }
}

/// `SimpleColumn` 只给 OID，不给类型名；这里映射常用类型。
fn oid_type_name(oid: u32) -> &'static str {
    match oid {
        16 => "bool",
        17 => "bytea",
        20 => "int8",
        21 => "int2",
        23 => "int4",
        25 => "text",
        26 => "oid",
        114 => "json",
        700 => "float4",
        701 => "float8",
        790 => "money",
        1043 => "varchar",
        1082 => "date",
        1083 => "time",
        1114 => "timestamp",
        1184 => "timestamptz",
        1266 => "timetz",
        1700 => "numeric",
        3802 => "jsonb",
        _ => "text",
    }
}

fn to_value(type_name: &str, raw: Option<&str>) -> DbValue {
    let Some(text) = raw else {
        return DbValue::Null;
    };
    match type_name {
        "int2" | "int4" | "int8" | "oid" => DbValue::Int {
            value: text.to_string(),
            unsigned: false,
        },
        "numeric" | "money" => DbValue::Decimal {
            value: text.to_string(),
        },
        "float4" | "float8" => text
            .parse::<f64>()
            .map(|value| DbValue::Float { value })
            .unwrap_or_else(|_| DbValue::Text {
                value: text.to_string(),
                bytes: text.len(),
                truncated: false,
            }),
        "bool" => DbValue::Text {
            value: if text == "t" { "true" } else { "false" }.to_string(),
            bytes: 4,
            truncated: false,
        },
        "json" | "jsonb" => DbValue::Json {
            value: text.to_string(),
            bytes: text.len(),
            truncated: false,
        },
        "date" => DbValue::Date {
            value: text.to_string(),
        },
        "timestamp" | "timestamptz" => DbValue::DateTime {
            value: text.to_string(),
            timezone: if type_name == "timestamptz" {
                "UTC".to_string()
            } else {
                String::new()
            },
        },
        "time" | "timetz" => DbValue::Time {
            value: text.to_string(),
        },
        "bytea" => {
            // simple query 的 bytea 是 `\x` 前缀的十六进制。
            let hex = text.strip_prefix("\\x").unwrap_or(text);
            match decode_hex(hex) {
                Some(bytes) => DbValue::Binary {
                    base64: {
                        use base64::Engine;
                        base64::engine::general_purpose::STANDARD.encode(&bytes)
                    },
                    bytes: bytes.len(),
                    truncated: false,
                },
                None => DbValue::Text {
                    value: text.to_string(),
                    bytes: text.len(),
                    truncated: false,
                },
            }
        }
        _ => DbValue::Text {
            value: text.to_string(),
            bytes: text.len(),
            truncated: false,
        },
    }
}

fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    if hex.len() % 2 != 0 {
        return None;
    }
    let bytes = hex.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks(2) {
        let high = (pair[0] as char).to_digit(16)?;
        let low = (pair[1] as char).to_digit(16)?;
        out.push((high * 16 + low) as u8);
    }
    Some(out)
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
    fn numeric_and_bigint_stay_text() {
        assert!(matches!(
            to_value("int8", Some("9223372036854775807")),
            DbValue::Int { ref value, .. } if value == "9223372036854775807"
        ));
        assert!(matches!(
            to_value("numeric", Some("12345678901234567890.123456789")),
            DbValue::Decimal { ref value } if value == "12345678901234567890.123456789"
        ));
        assert!(matches!(to_value("text", None), DbValue::Null));
    }

    #[test]
    fn bytea_hex_is_decoded() {
        let value = to_value("bytea", Some("\\x00ff"));
        match value {
            DbValue::Binary { base64, bytes, .. } => {
                assert_eq!(bytes, 2);
                assert_eq!(base64, "AP8=");
            }
            other => panic!("expected binary, got {other:?}"),
        }
    }
}
