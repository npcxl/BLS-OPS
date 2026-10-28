//! 数据库/视图级 schema 变更。
//!
//! 所有标识符由后端引用；视图查询文本必须是单条只读 SELECT/WITH，
//! 不能让前端把第二条 DDL 拼进视图定义。

use std::time::Duration;

use mysql_async::prelude::Queryable;
use serde::{Deserialize, Serialize};

use super::driver::{map_error, quote_identifier};
use super::model::DbErrorInfo;
use super::session::SessionEntry;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewColumn {
    pub name: String,
    pub column_type: String,
    pub nullable: bool,
    pub auto_increment: bool,
    pub default_value: Option<String>,
    pub comment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum SchemaChange {
    CreateDatabase {
        name: String,
        charset: Option<String>,
        collation: Option<String>,
    },
    CreateTable {
        database: String,
        table: String,
        columns: Vec<NewColumn>,
        primary_key: Vec<String>,
        engine: Option<String>,
        charset: Option<String>,
        collation: Option<String>,
    },
    DropDatabase {
        name: String,
    },
    SaveView {
        database: String,
        view: String,
        select_sql: String,
        or_replace: bool,
    },
    DropView {
        database: String,
        view: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaPreview {
    pub sql: String,
    pub warning: Option<String>,
    pub destructive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaOutcome {
    pub sql: String,
}

/// 只允许常见的 MySQL 类型语法；ENUM/SET 等含引号的类型需要通过后续专门编辑器。
fn valid_column_type(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return false;
    }
    let mut depth = 0usize;
    let mut has_alpha = false;
    for ch in trimmed.chars() {
        match ch {
            'A'..='Z' | 'a'..='z' => has_alpha = true,
            '0'..='9' | '_' | ' ' => {}
            '(' => depth += 1,
            ')' => {
                if depth == 0 {
                    return false;
                }
                depth -= 1;
            }
            ',' => {
                if depth == 0 {
                    return false;
                }
            }
            _ => return false,
        }
    }
    has_alpha && depth == 0
}

fn sql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
}

fn create_table_sql(
    database: &str,
    table: &str,
    columns: &[NewColumn],
    primary_key: &[String],
    engine: Option<&str>,
    charset: Option<&str>,
    collation: Option<&str>,
) -> Result<String, DbErrorInfo> {
    if columns.is_empty() {
        return Err(DbErrorInfo::new("config", "至少需要一个字段"));
    }
    let mut seen = std::collections::HashSet::new();
    for column in columns {
        if !seen.insert(column.name.to_ascii_lowercase()) {
            return Err(DbErrorInfo::new(
                "config",
                format!("字段名重复：{}", column.name),
            ));
        }
        if !valid_column_type(&column.column_type) {
            return Err(DbErrorInfo::new(
                "config",
                format!("字段 {} 的类型不合法或过于复杂", column.name),
            ));
        }
    }
    for key in primary_key {
        if !columns.iter().any(|column| column.name == *key) {
            return Err(DbErrorInfo::new("config", format!("主键字段不存在：{key}")));
        }
    }

    let defs = columns
        .iter()
        .map(|column| {
            let mut sql = format!(
                "{} {}",
                quote_identifier(&column.name)?,
                column.column_type.trim()
            );
            if !column.nullable {
                sql.push_str(" NOT NULL");
            } else {
                sql.push_str(" NULL");
            }
            if let Some(default) = column
                .default_value
                .as_deref()
                .filter(|value| !value.is_empty())
            {
                if default.eq_ignore_ascii_case("CURRENT_TIMESTAMP") {
                    sql.push_str(" DEFAULT CURRENT_TIMESTAMP");
                } else {
                    sql.push_str(&format!(" DEFAULT {}", sql_literal(default)));
                }
            }
            if column.auto_increment {
                sql.push_str(" AUTO_INCREMENT");
            }
            if !column.comment.trim().is_empty() {
                sql.push_str(&format!(" COMMENT {}", sql_literal(&column.comment)));
            }
            Ok(sql)
        })
        .collect::<Result<Vec<_>, DbErrorInfo>>()?;
    let mut defs = defs;
    if !primary_key.is_empty() {
        let keys = primary_key
            .iter()
            .map(|name| quote_identifier(name))
            .collect::<Result<Vec<_>, _>>()?;
        defs.push(format!("PRIMARY KEY ({})", keys.join(", ")));
    }
    let mut sql = format!(
        "CREATE TABLE {}.{} (\n  {}\n)",
        quote_identifier(database)?,
        quote_identifier(table)?,
        defs.join(",\n  ")
    );
    if let Some(engine) = engine.filter(|value| !value.trim().is_empty()) {
        sql.push_str(&format!(" ENGINE={}", quote_identifier(engine)?));
    }
    if let Some(charset) = charset.filter(|value| !value.trim().is_empty()) {
        sql.push_str(&format!(" DEFAULT CHARSET={}", quote_identifier(charset)?));
    }
    if let Some(collation) = collation.filter(|value| !value.trim().is_empty()) {
        sql.push_str(&format!(" COLLATE={}", quote_identifier(collation)?));
    }
    Ok(sql)
}

fn validate_select(sql: &str) -> Result<String, DbErrorInfo> {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    if trimmed.is_empty() {
        return Err(DbErrorInfo::new("config", "视图定义不能为空"));
    }
    if trimmed.contains(';') {
        return Err(DbErrorInfo::new(
            "permission",
            "视图定义只允许一条 SELECT/WITH 语句，不能包含分号或第二条语句",
        ));
    }
    let lower = trimmed.to_ascii_lowercase();
    if !(lower.starts_with("select") || lower.starts_with("with")) {
        return Err(DbErrorInfo::new(
            "permission",
            "视图定义必须是只读 SELECT 或 WITH 查询",
        ));
    }
    Ok(trimmed.to_string())
}

fn build(change: &SchemaChange) -> Result<(Vec<String>, Option<String>, bool), DbErrorInfo> {
    match change {
        SchemaChange::CreateDatabase {
            name,
            charset,
            collation,
        } => {
            let db = quote_identifier(name)?;
            let mut sql = format!("CREATE DATABASE {db}");
            if let Some(charset) = charset.as_deref().filter(|value| !value.trim().is_empty()) {
                let charset = quote_identifier(charset)?;
                sql.push_str(&format!(" CHARACTER SET {charset}"));
            }
            if let Some(collation) = collation
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                let collation = quote_identifier(collation)?;
                sql.push_str(&format!(" COLLATE {collation}"));
            }
            Ok((vec![sql], None, false))
        }
        SchemaChange::CreateTable {
            database,
            table,
            columns,
            primary_key,
            engine,
            charset,
            collation,
        } => Ok((
            vec![create_table_sql(
                database,
                table,
                columns,
                primary_key,
                engine.as_deref(),
                charset.as_deref(),
                collation.as_deref(),
            )?],
            None,
            false,
        )),
        SchemaChange::DropDatabase { name } => Ok((
            vec![format!("DROP DATABASE {}", quote_identifier(name)?)],
            Some("删除数据库会永久删除其中的全部表和数据，无法撤销".to_string()),
            true,
        )),
        SchemaChange::SaveView {
            database,
            view,
            select_sql,
            or_replace,
        } => {
            let select = validate_select(select_sql)?;
            let verb = if *or_replace {
                "CREATE OR REPLACE VIEW"
            } else {
                "CREATE VIEW"
            };
            Ok((
                vec![format!(
                    "{verb} {}.{} AS {select}",
                    quote_identifier(database)?,
                    quote_identifier(view)?
                )],
                None,
                false,
            ))
        }
        SchemaChange::DropView { database, view } => Ok((
            vec![format!(
                "DROP VIEW {}.{}",
                quote_identifier(database)?,
                quote_identifier(view)?
            )],
            Some("删除视图会永久移除视图定义，但不会删除基表数据".to_string()),
            true,
        )),
    }
}

pub fn preview(change: &SchemaChange) -> Result<SchemaPreview, DbErrorInfo> {
    let (sql, warning, destructive) = build(change)?;
    Ok(SchemaPreview {
        sql: sql
            .iter()
            .map(|statement| format!("{statement};"))
            .collect::<Vec<_>>()
            .join("\n"),
        warning,
        destructive,
    })
}

pub async fn apply(
    session: &SessionEntry,
    change: &SchemaChange,
) -> Result<SchemaOutcome, DbErrorInfo> {
    if session.read_only {
        return Err(DbErrorInfo::new(
            "permission",
            "该会话是只读连接：不能执行 schema 修改",
        ));
    }
    let transaction = session.transaction().await;
    if matches!(
        transaction.as_str(),
        "in_transaction" | "in_transaction_read_only"
    ) {
        return Err(DbErrorInfo::new(
            "query",
            "当前会话有未提交事务：请先 COMMIT/ROLLBACK，schema 修改不会替你隐式提交",
        ));
    }
    let (statements, _, _) = build(change)?;
    let mut conn = session.acquire_conn().await?;
    for statement in &statements {
        match tokio::time::timeout(Duration::from_secs(30), conn.query_drop(statement.as_str()))
            .await
        {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                session.release_conn(conn, true).await;
                return Err(map_error(&error, "query"));
            }
            Err(_) => {
                session.release_conn(conn, false).await;
                return Err(DbErrorInfo::new(
                    "timeout",
                    "schema 操作超时：连接已丢弃，请检查对象是否已部分创建",
                ));
            }
        }
    }
    session.release_conn(conn, true).await;
    Ok(SchemaOutcome {
        sql: statements
            .iter()
            .map(|statement| format!("{statement};"))
            .collect::<Vec<_>>()
            .join("\n"),
    })
}

#[cfg(test)]
mod tests {
    use super::{preview, NewColumn, SchemaChange};

    #[test]
    fn view_definition_rejects_second_statement() {
        let error = preview(&SchemaChange::SaveView {
            database: "db".to_string(),
            view: "v".to_string(),
            select_sql: "SELECT 1; DROP TABLE users".to_string(),
            or_replace: true,
        })
        .unwrap_err();
        assert_eq!(error.stage, "permission");
    }

    #[test]
    fn view_definition_must_be_select() {
        let error = preview(&SchemaChange::SaveView {
            database: "db".to_string(),
            view: "v".to_string(),
            select_sql: "DELETE FROM users".to_string(),
            or_replace: false,
        })
        .unwrap_err();
        assert_eq!(error.stage, "permission");
    }

    #[test]
    fn create_table_rejects_unsafe_column_type() {
        let error = preview(&SchemaChange::CreateTable {
            database: "db".to_string(),
            table: "t".to_string(),
            columns: vec![NewColumn {
                name: "id".to_string(),
                column_type: "INT); DROP TABLE users; --".to_string(),
                nullable: false,
                auto_increment: false,
                default_value: None,
                comment: String::new(),
            }],
            primary_key: vec![],
            engine: None,
            charset: None,
            collation: None,
        })
        .unwrap_err();
        assert_eq!(error.stage, "config");
    }

    #[test]
    fn create_table_builds_quoted_ddl() {
        let preview = preview(&SchemaChange::CreateTable {
            database: "ops".to_string(),
            table: "orders".to_string(),
            columns: vec![
                NewColumn {
                    name: "id".to_string(),
                    column_type: "BIGINT".to_string(),
                    nullable: false,
                    auto_increment: true,
                    default_value: None,
                    comment: "主键".to_string(),
                },
                NewColumn {
                    name: "note".to_string(),
                    column_type: "VARCHAR(255)".to_string(),
                    nullable: true,
                    auto_increment: false,
                    default_value: Some("it's".to_string()),
                    comment: String::new(),
                },
            ],
            primary_key: vec!["id".to_string()],
            engine: Some("InnoDB".to_string()),
            charset: Some("utf8mb4".to_string()),
            collation: None,
        })
        .unwrap();
        assert!(preview.sql.contains("`id` BIGINT NOT NULL AUTO_INCREMENT"));
        assert!(preview.sql.contains("DEFAULT 'it''s'"));
        assert!(preview.sql.contains("PRIMARY KEY (`id`)"));
        assert!(preview.sql.contains("ENGINE=`InnoDB`"));
    }

    #[test]
    fn database_names_are_quoted() {
        let result = preview(&SchemaChange::CreateDatabase {
            name: "ops`test".to_string(),
            charset: Some("utf8mb4".to_string()),
            collation: None,
        })
        .unwrap();
        assert_eq!(
            result.sql,
            "CREATE DATABASE `ops``test` CHARACTER SET `utf8mb4`;"
        );
    }
}
