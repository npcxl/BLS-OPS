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
pub struct ColumnEdit {
    /// 已存在字段的原名；新字段为 None。
    pub original_name: Option<String>,
    pub name: String,
    pub column_type: String,
    pub nullable: bool,
    pub auto_increment: bool,
    pub default_value: Option<String>,
    pub comment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexEdit {
    /// 已存在索引的原名；新索引为 None。PRIMARY 不参与编辑。
    pub original_name: Option<String>,
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlterTableRequest {
    pub database: String,
    pub table: String,
    pub columns: Vec<ColumnEdit>,
    pub indexes: Vec<IndexEdit>,
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

fn column_sql(column: &NewColumn) -> Result<String, DbErrorInfo> {
    if !valid_column_type(&column.column_type) {
        return Err(DbErrorInfo::new(
            "config",
            format!("字段 {} 的类型不合法或过于复杂", column.name),
        ));
    }
    let mut sql = format!(
        "{} {}",
        quote_identifier(&column.name)?,
        column.column_type.trim()
    );
    sql.push_str(if column.nullable {
        " NULL"
    } else {
        " NOT NULL"
    });
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
}

fn same_default(left: Option<&str>, right: Option<&str>) -> bool {
    let left = left.unwrap_or("").trim();
    let right = right.unwrap_or("").trim();
    left.eq_ignore_ascii_case(right)
}

fn alter_table_sql(
    detail: &super::model::DbTableDetail,
    request: &AlterTableRequest,
) -> Result<(Vec<String>, Option<String>, bool), DbErrorInfo> {
    if request.columns.is_empty() {
        return Err(DbErrorInfo::new("config", "表至少需要一个字段"));
    }
    let mut desired_names = std::collections::HashSet::new();
    for column in &request.columns {
        if !desired_names.insert(column.name.to_ascii_lowercase()) {
            return Err(DbErrorInfo::new(
                "config",
                format!("字段名重复：{}", column.name),
            ));
        }
        if !valid_column_type(&column.column_type) {
            return Err(DbErrorInfo::new(
                "config",
                format!("字段 {} 的类型不合法", column.name),
            ));
        }
    }

    let detail_by_name = detail
        .columns
        .iter()
        .map(|column| (column.name.to_ascii_lowercase(), column))
        .collect::<std::collections::HashMap<_, _>>();
    for column in &request.columns {
        if let Some(original) = column.original_name.as_deref() {
            if !detail_by_name.contains_key(&original.to_ascii_lowercase()) {
                return Err(DbErrorInfo::new(
                    "config",
                    format!("原字段不存在：{original}"),
                ));
            }
        }
    }
    for key in &detail.primary_key {
        if !request.columns.iter().any(|column| {
            column.name.eq_ignore_ascii_case(key)
                || column
                    .original_name
                    .as_deref()
                    .is_some_and(|name| name.eq_ignore_ascii_case(key))
        }) {
            return Err(DbErrorInfo::new(
                "permission",
                format!("主键字段 {key} 不能删除；请先处理主键"),
            ));
        }
    }

    let mut clauses = Vec::new();
    let mut destructive = false;
    let mut renames = std::collections::HashMap::new();
    for original in &detail.columns {
        let edit = request.columns.iter().find(|column| {
            column
                .original_name
                .as_deref()
                .is_some_and(|name| name.eq_ignore_ascii_case(&original.name))
        });
        let Some(edit) = edit else {
            if detail
                .primary_key
                .iter()
                .any(|key| key.eq_ignore_ascii_case(&original.name))
            {
                return Err(DbErrorInfo::new(
                    "permission",
                    format!("主键字段 {} 不能删除", original.name),
                ));
            }
            clauses.push(format!("DROP COLUMN {}", quote_identifier(&original.name)?));
            destructive = true;
            continue;
        };
        if !edit.name.eq_ignore_ascii_case(&original.name) {
            renames.insert(original.name.to_ascii_lowercase(), edit.name.clone());
        }
        let renamed = !edit.name.eq_ignore_ascii_case(&original.name);
        let changed = renamed
            || !edit
                .column_type
                .trim()
                .eq_ignore_ascii_case(original.column_type.trim())
            || edit.nullable != original.nullable
            || edit.auto_increment != original.auto_increment
            || !same_default(
                edit.default_value.as_deref(),
                original.default_value.as_deref(),
            )
            || edit.comment != original.comment;
        if changed {
            let definition = NewColumn {
                name: edit.name.clone(),
                column_type: edit.column_type.clone(),
                nullable: edit.nullable,
                auto_increment: edit.auto_increment,
                default_value: edit.default_value.clone(),
                comment: edit.comment.clone(),
            };
            clauses.push(format!(
                "CHANGE COLUMN {} {}",
                quote_identifier(&original.name)?,
                column_sql(&definition)?
            ));
        }
    }
    for column in request
        .columns
        .iter()
        .filter(|column| column.original_name.is_none())
    {
        let definition = NewColumn {
            name: column.name.clone(),
            column_type: column.column_type.clone(),
            nullable: column.nullable,
            auto_increment: column.auto_increment,
            default_value: column.default_value.clone(),
            comment: column.comment.clone(),
        };
        clauses.push(format!("ADD COLUMN {}", column_sql(&definition)?));
    }

    let desired_columns = request
        .columns
        .iter()
        .map(|column| column.name.to_ascii_lowercase())
        .collect::<std::collections::HashSet<_>>();
    for index in detail.indexes.iter().filter(|index| !index.primary) {
        let mapped_columns = index
            .columns
            .iter()
            .map(|column| {
                renames
                    .get(&column.name.to_ascii_lowercase())
                    .cloned()
                    .unwrap_or_else(|| column.name.clone())
            })
            .collect::<Vec<_>>();
        let edit = request.indexes.iter().find(|candidate| {
            candidate
                .original_name
                .as_deref()
                .is_some_and(|name| name.eq_ignore_ascii_case(&index.name))
        });
        let Some(edit) = edit else {
            clauses.push(format!("DROP INDEX {}", quote_identifier(&index.name)?));
            destructive = true;
            continue;
        };
        if edit.columns.is_empty()
            || edit
                .columns
                .iter()
                .any(|column| !desired_columns.contains(&column.to_ascii_lowercase()))
        {
            return Err(DbErrorInfo::new(
                "config",
                format!("索引 {} 引用了不存在的字段", edit.name),
            ));
        }
        let same_shape = edit.unique == index.unique && edit.columns == mapped_columns;
        if same_shape && !edit.name.eq_ignore_ascii_case(&index.name) {
            clauses.push(format!(
                "RENAME INDEX {} TO {}",
                quote_identifier(&index.name)?,
                quote_identifier(&edit.name)?
            ));
        } else if !same_shape || !edit.name.eq_ignore_ascii_case(&index.name) {
            clauses.push(format!("DROP INDEX {}", quote_identifier(&index.name)?));
            let unique = if edit.unique { "UNIQUE " } else { "" };
            let columns = edit
                .columns
                .iter()
                .map(|column| quote_identifier(column))
                .collect::<Result<Vec<_>, _>>()?;
            clauses.push(format!(
                "ADD {unique}INDEX {} ({})",
                quote_identifier(&edit.name)?,
                columns.join(", ")
            ));
            destructive = true;
        }
    }
    for index in request
        .indexes
        .iter()
        .filter(|index| index.original_name.is_none())
    {
        if index.columns.is_empty()
            || index
                .columns
                .iter()
                .any(|column| !desired_columns.contains(&column.to_ascii_lowercase()))
        {
            return Err(DbErrorInfo::new(
                "config",
                format!("索引 {} 引用了不存在的字段", index.name),
            ));
        }
        let unique = if index.unique { "UNIQUE " } else { "" };
        let columns = index
            .columns
            .iter()
            .map(|column| quote_identifier(column))
            .collect::<Result<Vec<_>, _>>()?;
        clauses.push(format!(
            "ADD {unique}INDEX {} ({})",
            quote_identifier(&index.name)?,
            columns.join(", ")
        ));
    }

    if clauses.is_empty() {
        return Err(DbErrorInfo::new("config", "表结构没有变化"));
    }
    let sql = format!(
        "ALTER TABLE {}.{} {}",
        quote_identifier(&request.database)?,
        quote_identifier(&request.table)?,
        clauses.join(",\n  ")
    );
    Ok((vec![sql], None, destructive))
}

pub fn alter_table_preview(
    detail: &super::model::DbTableDetail,
    request: &AlterTableRequest,
) -> Result<SchemaPreview, DbErrorInfo> {
    let (sql, warning, destructive) = alter_table_sql(detail, request)?;
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

async fn execute_statements(
    session: &SessionEntry,
    statements: &[String],
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
    let mut conn = session.acquire_conn().await?;
    for statement in statements {
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

pub async fn apply(
    session: &SessionEntry,
    change: &SchemaChange,
) -> Result<SchemaOutcome, DbErrorInfo> {
    let (statements, _, _) = build(change)?;
    execute_statements(session, &statements).await
}

pub async fn apply_alter_table(
    session: &SessionEntry,
    detail: &super::model::DbTableDetail,
    request: &AlterTableRequest,
) -> Result<SchemaOutcome, DbErrorInfo> {
    let (statements, _, _) = alter_table_sql(detail, request)?;
    execute_statements(session, &statements).await
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

#[cfg(test)]
mod alter_tests {
    use super::{alter_table_preview, AlterTableRequest, ColumnEdit, IndexEdit};
    use crate::database::model::{DbIndex, DbIndexColumn, DbTableColumn, DbTableDetail};

    fn detail() -> DbTableDetail {
        DbTableDetail {
            database: "db".to_string(),
            table: "users".to_string(),
            kind: "table".to_string(),
            engine: Some("InnoDB".to_string()),
            collation: None,
            estimated_rows: Some(1),
            comment: String::new(),
            create_sql: None,
            columns: vec![
                DbTableColumn {
                    name: "id".to_string(),
                    ordinal: 1,
                    data_type: "bigint".to_string(),
                    column_type: "bigint".to_string(),
                    nullable: false,
                    default_value: None,
                    default_expression: None,
                    primary_key: true,
                    auto_increment: true,
                    unsigned: false,
                    charset: None,
                    collation: None,
                    comment: String::new(),
                },
                DbTableColumn {
                    name: "name".to_string(),
                    ordinal: 2,
                    data_type: "varchar".to_string(),
                    column_type: "varchar(64)".to_string(),
                    nullable: false,
                    default_value: None,
                    default_expression: None,
                    primary_key: false,
                    auto_increment: false,
                    unsigned: false,
                    charset: None,
                    collation: None,
                    comment: String::new(),
                },
            ],
            indexes: vec![
                DbIndex {
                    name: "PRIMARY".to_string(),
                    unique: true,
                    primary: true,
                    kind: "BTREE".to_string(),
                    columns: vec![DbIndexColumn {
                        name: "id".to_string(),
                        seq: 1,
                        sub_part: None,
                        direction: None,
                    }],
                },
                DbIndex {
                    name: "idx_name".to_string(),
                    unique: false,
                    primary: false,
                    kind: "BTREE".to_string(),
                    columns: vec![DbIndexColumn {
                        name: "name".to_string(),
                        seq: 1,
                        sub_part: None,
                        direction: None,
                    }],
                },
            ],
            primary_key: vec!["id".to_string()],
            reliable_key: None,
        }
    }

    #[test]
    fn alter_generates_change_index_and_add_column() {
        let result = alter_table_preview(
            &detail(),
            &AlterTableRequest {
                database: "db".to_string(),
                table: "users".to_string(),
                columns: vec![
                    ColumnEdit {
                        original_name: Some("id".to_string()),
                        name: "user_id".to_string(),
                        column_type: "bigint".to_string(),
                        nullable: false,
                        auto_increment: true,
                        default_value: None,
                        comment: String::new(),
                    },
                    ColumnEdit {
                        original_name: Some("name".to_string()),
                        name: "name".to_string(),
                        column_type: "varchar(128)".to_string(),
                        nullable: true,
                        auto_increment: false,
                        default_value: None,
                        comment: "display".to_string(),
                    },
                    ColumnEdit {
                        original_name: None,
                        name: "created_at".to_string(),
                        column_type: "DATETIME".to_string(),
                        nullable: true,
                        auto_increment: false,
                        default_value: None,
                        comment: String::new(),
                    },
                ],
                indexes: vec![IndexEdit {
                    original_name: Some("idx_name".to_string()),
                    name: "idx_name".to_string(),
                    columns: vec!["name".to_string()],
                    unique: true,
                }],
            },
        )
        .unwrap();
        assert!(result.sql.contains("CHANGE COLUMN `id` `user_id`"));
        assert!(result.sql.contains("CHANGE COLUMN `name`"));
        assert!(result.sql.contains("ADD COLUMN `created_at`"));
        assert!(result.sql.contains("ADD UNIQUE INDEX `idx_name`"));
        assert!(result.destructive);
    }

    #[test]
    fn primary_column_cannot_be_dropped() {
        let error = alter_table_preview(
            &detail(),
            &AlterTableRequest {
                database: "db".to_string(),
                table: "users".to_string(),
                columns: vec![ColumnEdit {
                    original_name: Some("name".to_string()),
                    name: "name".to_string(),
                    column_type: "varchar(64)".to_string(),
                    nullable: false,
                    auto_increment: false,
                    default_value: None,
                    comment: String::new(),
                }],
                indexes: vec![],
            },
        )
        .unwrap_err();
        assert_eq!(error.stage, "permission");
    }
}
