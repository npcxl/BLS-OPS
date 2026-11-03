//! 数据库/视图级 schema 变更。
//!
//! 所有标识符由后端引用；视图查询文本必须是单条只读 SELECT/WITH，
//! 不能让前端把第二条 DDL 拼进视图定义。

use std::time::Duration;

use mysql_async::prelude::Queryable;
use serde::{Deserialize, Serialize};

use super::adapter::AdapterSet;
use super::capability::DriverFamily;
use super::driver::map_error;
use super::model::DbErrorInfo;
use super::protocol::TransactionState;
use super::session::{SessionEntry, SessionKind};

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
    /// 目标主键（按顺序、用**新**字段名）。`None` 表示不动主键；空数组表示删掉主键。
    ///
    /// `columns` 的数组顺序同时就是目标字段顺序（前端上移/下移直接改数组）。
    #[serde(default)]
    pub primary_key: Option<Vec<String>>,
}

fn column_from_edit(edit: &ColumnEdit) -> NewColumn {
    NewColumn {
        name: edit.name.clone(),
        column_type: edit.column_type.clone(),
        nullable: edit.nullable,
        auto_increment: edit.auto_increment,
        default_value: edit.default_value.clone(),
        comment: edit.comment.clone(),
    }
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

/// DDL 生成的方言入口。
///
/// MySQL 与 SQLite 已有实现；两者差异是结构性的（`AUTO_INCREMENT` vs
/// `INTEGER PRIMARY KEY AUTOINCREMENT`、内联 `COMMENT`、`CHANGE COLUMN`、
/// 建库字符集、`USE db`、`CREATE OR REPLACE VIEW`）。PostgreSQL 仍未接入，
/// 会明确拒绝而不是生成"看起来能跑"的错语句。
struct Ddl<'a> {
    adapter: &'a AdapterSet,
}

impl<'a> Ddl<'a> {
    fn new(adapter: &'a AdapterSet) -> Self {
        Self { adapter }
    }

    fn quote(&self, name: &str) -> Result<String, DbErrorInfo> {
        self.adapter.dialect().quote(name)
    }

    fn literal(&self, value: &str) -> String {
        self.adapter.dialect().string_literal(value)
    }

    fn qualified(&self, schema: &str, name: &str) -> Result<String, DbErrorInfo> {
        self.adapter.dialect().qualified(Some(schema), name)
    }

    fn is_sqlite(&self) -> bool {
        self.adapter.family() == DriverFamily::Sqlite
    }

    fn is_postgres(&self) -> bool {
        self.adapter.family() == DriverFamily::Postgres
    }

    fn require_mysql(&self, feature: &str) -> Result<(), DbErrorInfo> {
        if self.adapter.family() == DriverFamily::MySql {
            return Ok(());
        }
        Err(DbErrorInfo::new(
            "unsupported",
            format!("{feature} 目前只支持 MySQL/MariaDB"),
        )
        .with_detail(
            "SQLite 没有这个对象（库/改表），PostgreSQL 的 DDL 生成会在驱动接入后提供；当前请用 SQL 编辑器直接执行。",
        ))
    }
}

fn create_table_sql(
    ddl: &Ddl<'_>,
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

    if ddl.is_sqlite() {
        return sqlite_create_table_sql(ddl, database, table, columns, primary_key);
    }

    if ddl.is_postgres() {
        return postgres_create_table_sql(ddl, database, table, columns, primary_key);
    }

    let defs = columns
        .iter()
        .map(|column| {
            let mut sql = format!("{} {}", ddl.quote(&column.name)?, column.column_type.trim());
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
                    sql.push_str(&format!(" DEFAULT {}", ddl.literal(default)));
                }
            }
            if column.auto_increment {
                sql.push_str(" AUTO_INCREMENT");
            }
            if !column.comment.trim().is_empty() {
                sql.push_str(&format!(" COMMENT {}", ddl.literal(&column.comment)));
            }
            Ok(sql)
        })
        .collect::<Result<Vec<_>, DbErrorInfo>>()?;
    let mut defs = defs;
    if !primary_key.is_empty() {
        let keys = primary_key
            .iter()
            .map(|name| ddl.quote(name))
            .collect::<Result<Vec<_>, _>>()?;
        defs.push(format!("PRIMARY KEY ({})", keys.join(", ")));
    }
    let mut sql = format!(
        "CREATE TABLE {}.{} (\n  {}\n)",
        ddl.quote(database)?,
        ddl.quote(table)?,
        defs.join(",\n  ")
    );
    if let Some(engine) = engine.filter(|value| !value.trim().is_empty()) {
        sql.push_str(&format!(" ENGINE={}", ddl.quote(engine)?));
    }
    if let Some(charset) = charset.filter(|value| !value.trim().is_empty()) {
        sql.push_str(&format!(" DEFAULT CHARSET={}", ddl.quote(charset)?));
    }
    if let Some(collation) = collation.filter(|value| !value.trim().is_empty()) {
        sql.push_str(&format!(" COLLATE={}", ddl.quote(collation)?));
    }
    Ok(sql)
}

/// PostgreSQL 建表：没有 ENGINE / CHARSET / COLLATE / 内联 COMMENT。
///
/// 自增用 `GENERATED BY DEFAULT AS IDENTITY`（PG 10+），只接受整数列且必须是
/// 单列主键：`bigserial` 是语法糖，这里显式写 IDENTITY，语义更清楚。
fn postgres_create_table_sql(
    ddl: &Ddl<'_>,
    database: &str,
    table: &str,
    columns: &[NewColumn],
    primary_key: &[String],
) -> Result<String, DbErrorInfo> {
    let mut defs: Vec<String> = Vec::new();
    for column in columns {
        let type_name = column.column_type.trim().to_ascii_lowercase();
        let mut sql = format!("{} {}", ddl.quote(&column.name)?, column.column_type.trim());
        if column.auto_increment {
            let integer = matches!(
                type_name.as_str(),
                "smallint" | "int" | "integer" | "bigint" | "int2" | "int4" | "int8"
            );
            if !integer {
                return Err(DbErrorInfo::new(
                    "config",
                    "PostgreSQL 的自增只支持整数列（smallint / int / bigint）",
                )
                .with_detail("把该列类型改成 bigint 或 int，或取消自增。"));
            }
            if primary_key.len() != 1 || primary_key[0] != column.name {
                return Err(DbErrorInfo::new(
                    "config",
                    "PostgreSQL 的 IDENTITY 自增只支持单列主键",
                )
                .with_detail("把自增列设为唯一主键，或取消自增。"));
            }
            sql.push_str(" GENERATED BY DEFAULT AS IDENTITY");
        }
        if !column.nullable {
            sql.push_str(" NOT NULL");
        }
        if let Some(default) = column
            .default_value
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            if default.eq_ignore_ascii_case("CURRENT_TIMESTAMP") {
                sql.push_str(" DEFAULT CURRENT_TIMESTAMP");
            } else {
                sql.push_str(&format!(" DEFAULT {}", ddl.literal(default)));
            }
        }
        defs.push(sql);
    }
    if !primary_key.is_empty() {
        let keys = primary_key
            .iter()
            .map(|name| ddl.quote(name))
            .collect::<Result<Vec<_>, _>>()?;
        defs.push(format!("PRIMARY KEY ({})", keys.join(", ")));
    }
    Ok(format!(
        "CREATE TABLE {} (\n  {}\n)",
        ddl.qualified(database, table)?,
        defs.join(",\n  ")
    ))
}

/// SQLite 建表：没有 ENGINE / CHARSET / COLLATE / 内联 COMMENT；
/// 自增只能是 `INTEGER PRIMARY KEY AUTOINCREMENT`（单列）。
fn sqlite_create_table_sql(
    ddl: &Ddl<'_>,
    database: &str,
    table: &str,
    columns: &[NewColumn],
    primary_key: &[String],
) -> Result<String, DbErrorInfo> {
    let mut defs: Vec<String> = Vec::new();
    for column in columns {
        let mut sql = format!("{} {}", ddl.quote(&column.name)?, column.column_type.trim());
        if !column.nullable {
            sql.push_str(" NOT NULL");
        }
        if let Some(default) = column
            .default_value
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            if default.eq_ignore_ascii_case("CURRENT_TIMESTAMP") {
                sql.push_str(" DEFAULT CURRENT_TIMESTAMP");
            } else {
                sql.push_str(&format!(" DEFAULT {}", ddl.literal(default)));
            }
        }
        defs.push(sql);
    }

    let auto_columns: Vec<&NewColumn> = columns.iter().filter(|item| item.auto_increment).collect();
    if auto_columns.len() > 1 {
        return Err(DbErrorInfo::new("config", "SQLite 只允许一个自增主键列"));
    }
    if let Some(column) = auto_columns.first() {
        // SQLite 的自增只存在于"单列 INTEGER 主键"上，别的位置直接拒绝。
        if primary_key.len() != 1 || primary_key[0] != column.name {
            return Err(
                DbErrorInfo::new("config", "SQLite 的自增只支持单列 INTEGER 主键")
                    .with_detail("请把自增列设为唯一主键，或取消自增。"),
            );
        }
        let type_name = column.column_type.trim().to_ascii_uppercase();
        if type_name != "INTEGER" && type_name != "INT" {
            return Err(
                DbErrorInfo::new("config", "SQLite 的 AUTOINCREMENT 要求列类型是 INTEGER")
                    .with_detail(
                        "把该列类型改成 INTEGER（SQLite 的 INTEGER PRIMARY KEY 即 rowid）。",
                    ),
            );
        }
        let index = columns
            .iter()
            .position(|item| item.name == column.name)
            .unwrap_or(0);
        defs[index].push_str(" PRIMARY KEY AUTOINCREMENT");
    } else if !primary_key.is_empty() {
        let keys = primary_key
            .iter()
            .map(|name| ddl.quote(name))
            .collect::<Result<Vec<_>, _>>()?;
        defs.push(format!("PRIMARY KEY ({})", keys.join(", ")));
    }

    Ok(format!(
        "CREATE TABLE {} (\n  {}\n)",
        ddl.qualified(database, table)?,
        defs.join(",\n  ")
    ))
}

fn column_sql(ddl: &Ddl<'_>, column: &NewColumn) -> Result<String, DbErrorInfo> {
    if !valid_column_type(&column.column_type) {
        return Err(DbErrorInfo::new(
            "config",
            format!("字段 {} 的类型不合法或过于复杂", column.name),
        ));
    }
    let mut sql = format!("{} {}", ddl.quote(&column.name)?, column.column_type.trim());
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
            sql.push_str(&format!(" DEFAULT {}", ddl.literal(default)));
        }
    }
    if column.auto_increment {
        sql.push_str(" AUTO_INCREMENT");
    }
    if !column.comment.trim().is_empty() {
        sql.push_str(&format!(" COMMENT {}", ddl.literal(&column.comment)));
    }
    Ok(sql)
}

fn same_default(left: Option<&str>, right: Option<&str>) -> bool {
    let left = left.unwrap_or("").trim();
    let right = right.unwrap_or("").trim();
    left.eq_ignore_ascii_case(right)
}

fn alter_table_sql(
    ddl: &Ddl<'_>,
    detail: &super::model::DbTableDetail,
    request: &AlterTableRequest,
) -> Result<(Vec<String>, Option<String>, bool), DbErrorInfo> {
    ddl.require_mysql("修改表结构")?;
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
    let mut reordered = false;
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
            clauses.push(format!("DROP COLUMN {}", ddl.quote(&original.name)?));
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
                ddl.quote(&original.name)?,
                column_sql(ddl, &definition)?
            ));
        }
    }
    // 字段顺序：MySQL 只能用 `MODIFY COLUMN ... AFTER` / `ADD COLUMN ... AFTER`
    // 表达位置，所以按请求数组顺序重放一遍，只对"位置不对"的列发语句。
    // 用户没上移/下移时不产生任何额外语句。
    let mut simulated = detail
        .columns
        .iter()
        .filter_map(|original| {
            request
                .columns
                .iter()
                .find(|column| {
                    column
                        .original_name
                        .as_deref()
                        .is_some_and(|name| name.eq_ignore_ascii_case(&original.name))
                })
                .map(|column| column.name.to_ascii_lowercase())
        })
        .collect::<Vec<String>>();
    let mut previous: Option<String> = None;
    for column in &request.columns {
        let lower = column.name.to_ascii_lowercase();
        let tail = match previous.as_deref() {
            Some(name) => format!(" AFTER {}", ddl.quote(name)?),
            None => " FIRST".to_string(),
        };
        if column.original_name.is_some() {
            let Some(position) = simulated.iter().position(|name| *name == lower) else {
                previous = Some(column.name.clone());
                continue;
            };
            let current_previous = if position == 0 {
                None
            } else {
                Some(simulated[position - 1].clone())
            };
            let expected_previous = previous.as_ref().map(|name| name.to_ascii_lowercase());
            let in_place = match (current_previous.as_deref(), expected_previous.as_deref()) {
                (None, None) => true,
                (Some(left), Some(right)) => left == right,
                _ => false,
            };
            if !in_place {
                clauses.push(format!(
                    "MODIFY COLUMN {}{}",
                    column_sql(ddl, &column_from_edit(column))?,
                    tail
                ));
                reordered = true;
                simulated.remove(position);
                let insert_at = expected_previous
                    .as_deref()
                    .and_then(|name| simulated.iter().position(|candidate| candidate == name))
                    .map(|index| index + 1)
                    .unwrap_or(0);
                simulated.insert(insert_at, lower);
            }
        } else {
            clauses.push(format!(
                "ADD COLUMN {}{}",
                column_sql(ddl, &column_from_edit(column))?,
                tail
            ));
            let insert_at = previous
                .as_deref()
                .and_then(|name| {
                    simulated
                        .iter()
                        .position(|candidate| candidate.eq_ignore_ascii_case(name))
                })
                .map(|index| index + 1)
                .unwrap_or(0);
            simulated.insert(insert_at, lower);
        }
        previous = Some(column.name.clone());
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
            clauses.push(format!("DROP INDEX {}", ddl.quote(&index.name)?));
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
                ddl.quote(&index.name)?,
                ddl.quote(&edit.name)?
            ));
        } else if !same_shape || !edit.name.eq_ignore_ascii_case(&index.name) {
            clauses.push(format!("DROP INDEX {}", ddl.quote(&index.name)?));
            let unique = if edit.unique { "UNIQUE " } else { "" };
            let columns = edit
                .columns
                .iter()
                .map(|column| ddl.quote(column))
                .collect::<Result<Vec<_>, _>>()?;
            clauses.push(format!(
                "ADD {unique}INDEX {} ({})",
                ddl.quote(&edit.name)?,
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
            .map(|column| ddl.quote(column))
            .collect::<Result<Vec<_>, _>>()?;
        clauses.push(format!(
            "ADD {unique}INDEX {} ({})",
            ddl.quote(&index.name)?,
            columns.join(", ")
        ));
    }

    if let Some(primary_key) = request.primary_key.as_ref() {
        for key in primary_key {
            let Some(column) = request
                .columns
                .iter()
                .find(|column| column.name.eq_ignore_ascii_case(key))
            else {
                return Err(DbErrorInfo::new("config", format!("主键字段不存在：{key}")));
            };
            if column.nullable {
                return Err(DbErrorInfo::new(
                    "config",
                    format!("主键字段 {} 不能允许 NULL", column.name),
                ));
            }
        }
        // 自增列必须是键：从主键里摘掉自增列时 MySQL 会直接报错，先挡住。
        for column in request
            .columns
            .iter()
            .filter(|column| column.auto_increment)
        {
            if !primary_key
                .iter()
                .any(|key| key.eq_ignore_ascii_case(&column.name))
            {
                return Err(DbErrorInfo::new(
                    "config",
                    format!("自增字段 {} 必须保留在主键中，或先取消自增", column.name),
                ));
            }
        }
        let unchanged = detail.primary_key.len() == primary_key.len()
            && detail
                .primary_key
                .iter()
                .zip(primary_key.iter())
                .all(|(left, right)| left.eq_ignore_ascii_case(right));
        if !unchanged {
            if !detail.primary_key.is_empty() {
                clauses.push("DROP PRIMARY KEY".to_string());
                destructive = true;
            }
            if !primary_key.is_empty() {
                let names = primary_key
                    .iter()
                    .map(|name| ddl.quote(name))
                    .collect::<Result<Vec<_>, _>>()?;
                clauses.push(format!("ADD PRIMARY KEY ({})", names.join(", ")));
            }
        }
    }

    if clauses.is_empty() {
        return Err(DbErrorInfo::new("config", "表结构没有变化"));
    }
    let sql = format!(
        "ALTER TABLE {}.{} {}",
        ddl.quote(&request.database)?,
        ddl.quote(&request.table)?,
        clauses.join(",\n  ")
    );
    // MySQL 没有"移动列"的轻量语法，只能 MODIFY 重写整列定义，字符集/排序
    // 规则这类不在 COLUMN_TYPE 里的属性会回落到表默认值，先提醒一句。
    let warning = reordered.then(|| {
        "字段顺序调整会用 MODIFY COLUMN 重写列定义，列的字符集/排序规则会回到表默认值；请确认预览 SQL。"
            .to_string()
    });
    Ok((vec![sql], warning, destructive))
}

pub fn alter_table_preview(
    adapter: &AdapterSet,
    detail: &super::model::DbTableDetail,
    request: &AlterTableRequest,
) -> Result<SchemaPreview, DbErrorInfo> {
    let ddl = Ddl::new(adapter);
    let (sql, warning, destructive) = alter_table_sql(&ddl, detail, request)?;
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

fn build(
    ddl: &Ddl<'_>,
    change: &SchemaChange,
) -> Result<(Vec<String>, Option<String>, bool), DbErrorInfo> {
    match change {
        SchemaChange::CreateDatabase {
            name,
            charset,
            collation,
        } => {
            // SQLite 没有"库"：`main` 就是文件本身。
            ddl.require_mysql("建库")?;
            let db = ddl.quote(name)?;
            let mut sql = format!("CREATE DATABASE {db}");
            if let Some(charset) = charset.as_deref().filter(|value| !value.trim().is_empty()) {
                let charset = ddl.quote(charset)?;
                sql.push_str(&format!(" CHARACTER SET {charset}"));
            }
            if let Some(collation) = collation
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                let collation = ddl.quote(collation)?;
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
        } => {
            let sql = create_table_sql(
                ddl,
                database,
                table,
                columns,
                primary_key,
                engine.as_deref(),
                charset.as_deref(),
                collation.as_deref(),
            )?;
            // SQLite 忽略表选项时必须说出来，不能静默丢掉用户填的值。
            let has_table_options = [engine.as_deref(), charset.as_deref(), collation.as_deref()]
                .iter()
                .any(|value| value.map(|text| !text.trim().is_empty()).unwrap_or(false));
            let warning =
                ((ddl.is_sqlite() || ddl.is_postgres()) && has_table_options).then(|| {
                    format!(
                        "{} 没有 ENGINE / CHARSET / COLLATE：这些表选项已被忽略",
                        if ddl.is_sqlite() {
                            "SQLite"
                        } else {
                            "PostgreSQL"
                        }
                    )
                });
            Ok((vec![sql], warning, false))
        }
        SchemaChange::DropDatabase { name } => {
            ddl.require_mysql("删库")?;
            Ok((
                vec![format!("DROP DATABASE {}", ddl.quote(name)?)],
                Some("删除数据库会永久删除其中的全部表和数据，无法撤销".to_string()),
                true,
            ))
        }
        SchemaChange::SaveView {
            database,
            view,
            select_sql,
            or_replace,
        } => {
            let select = validate_select(select_sql)?;
            if ddl.is_sqlite() {
                // SQLite 没有 CREATE OR REPLACE VIEW，也没有 USE。
                let qualified = ddl.qualified(database, view)?;
                let mut sql = Vec::new();
                if *or_replace {
                    sql.push(format!("DROP VIEW IF EXISTS {qualified}"));
                }
                sql.push(format!("CREATE VIEW {qualified} AS {select}"));
                return Ok((sql, None, false));
            }
            if ddl.is_postgres() {
                // PostgreSQL 支持 CREATE OR REPLACE VIEW，也不需要 USE；
                // schema 由限定名给出。
                let qualified = ddl.qualified(database, view)?;
                let verb = if *or_replace {
                    "CREATE OR REPLACE VIEW"
                } else {
                    "CREATE VIEW"
                };
                return Ok((vec![format!("{verb} {qualified} AS {select}")], None, false));
            }
            let verb = if *or_replace {
                "CREATE OR REPLACE VIEW"
            } else {
                "CREATE VIEW"
            };
            let database = ddl.quote(database)?;
            Ok((
                vec![
                    // 视图定义里的表往往不写库名；先切到目标库，
                    // 否则共享会话没有 current database 时会报 1046。
                    format!("USE {database}"),
                    format!("{verb} {database}.{} AS {select}", ddl.quote(view)?),
                ],
                None,
                false,
            ))
        }
        SchemaChange::DropView { database, view } => Ok((
            vec![format!("DROP VIEW {}", ddl.qualified(database, view)?)],
            Some("删除视图会永久移除视图定义，但不会删除基表数据".to_string()),
            true,
        )),
    }
}

pub fn preview(adapter: &AdapterSet, change: &SchemaChange) -> Result<SchemaPreview, DbErrorInfo> {
    let ddl = Ddl::new(adapter);
    let (sql, warning, destructive) = build(&ddl, change)?;
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

fn ddl_error(index: usize, fatal: bool, mut mapped: DbErrorInfo) -> DbErrorInfo {
    if fatal {
        mapped.stage = "outcome_unknown".to_string();
        mapped.retryable = false;
    }
    let partial = if index > 0 {
        format!("前 {index} 条 DDL 已执行；MySQL DDL 可能隐式提交，对象可能部分完成")
    } else if fatal {
        "连接在 DDL 执行中断开；该语句是否生效未知".to_string()
    } else {
        String::new()
    };
    if !partial.is_empty() {
        mapped.detail = Some(match mapped.detail {
            Some(existing) => format!("{existing}；{partial}"),
            None => partial,
        });
    }
    mapped
}

async fn execute_statements(
    session: &SessionEntry,
    statements: &[String],
) -> Result<SchemaOutcome, DbErrorInfo> {
    if session.kind == SessionKind::Sqlite {
        return execute_sqlite_statements(session, statements).await;
    }

    if session.kind == SessionKind::Postgres {
        return execute_postgres_statements(session, statements).await;
    }
    if session.read_only {
        return Err(DbErrorInfo::new(
            "permission",
            "该会话是只读连接：不能执行 schema 修改",
        ));
    }
    let transaction = session.transaction().await;
    // 事务状态未知时同样不能执行：DDL 不能赌进一个未知事务。
    if matches!(transaction, TransactionState::Unknown) && session.kind == SessionKind::Postgres {
        return Err(
            DbErrorInfo::new("query", "事务状态未知，已拒绝执行 schema 修改")
                .with_detail("无法确认会话是否处于事务中；请重新连接后再试。"),
        );
    }
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
    for (index, statement) in statements.iter().enumerate() {
        match tokio::time::timeout(Duration::from_secs(30), conn.query_drop(statement.as_str()))
            .await
        {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                let fatal = error.is_fatal();
                // 断连后协议状态不可信，绝不能把连接放回会话复用。
                session.release_conn(conn, !fatal).await;
                return Err(ddl_error(index, fatal, map_error(&error, "query")));
            }
            Err(_) => {
                session.release_conn(conn, false).await;
                return Err(DbErrorInfo::new(
                    "timeout",
                    "schema 操作超时：连接已丢弃，语句结果未知，请重新检查对象状态",
                )
                .with_detail(format!(
                    "第 {} 条语句执行中超时；前 {} 条可能已完成",
                    index + 1,
                    index
                )));
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

/// SQLite 的 DDL 在事务里可以回滚（这一点比 MySQL 强），所以整批用
/// `BEGIN`/`COMMIT` 包住：失败就 `ROLLBACK`，不会留下"执行了一半"的结构。
async fn execute_sqlite_statements(
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
    // 事务状态未知时同样不能执行：DDL 不能赌进一个未知事务。
    if matches!(transaction, TransactionState::Unknown) && session.kind == SessionKind::Postgres {
        return Err(
            DbErrorInfo::new("query", "事务状态未知，已拒绝执行 schema 修改")
                .with_detail("无法确认会话是否处于事务中；请重新连接后再试。"),
        );
    }
    if matches!(
        transaction.as_str(),
        "in_transaction" | "in_transaction_read_only"
    ) {
        return Err(DbErrorInfo::new(
            "query",
            "当前会话有未提交事务：请先 COMMIT/ROLLBACK，schema 修改不会替你隐式提交",
        ));
    }

    let worker = session.acquire_sqlite().await?;
    if let Err(error) = worker.execute("BEGIN").await {
        session
            .release_sqlite(worker, true, TransactionState::None)
            .await;
        return Err(error);
    }
    for (index, statement) in statements.iter().enumerate() {
        if let Err(error) = worker.execute(statement).await {
            let _ = worker.execute("ROLLBACK").await;
            session
                .release_sqlite(worker, true, TransactionState::None)
                .await;
            return Err(ddl_error(index, false, error));
        }
    }
    if let Err(error) = worker.execute("COMMIT").await {
        session
            .release_sqlite(worker, false, TransactionState::Unknown)
            .await;
        return Err(
            DbErrorInfo::new("outcome_unknown", format!("DDL 提交结果未知：{error}"))
                .with_detail("不要自动重试；请重新打开结构浏览器确认对象状态。"),
        );
    }
    session
        .release_sqlite(worker, true, TransactionState::None)
        .await;
    Ok(SchemaOutcome {
        sql: statements
            .iter()
            .map(|statement| format!("{statement};"))
            .collect::<Vec<_>>()
            .join("\n"),
    })
}

/// PostgreSQL 的 DDL 也能回滚，所以整批用 `BEGIN`/`COMMIT` 包住。
async fn execute_postgres_statements(
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
    // 事务状态未知时同样不能执行：DDL 不能赌进一个未知事务。
    if matches!(transaction, TransactionState::Unknown) && session.kind == SessionKind::Postgres {
        return Err(
            DbErrorInfo::new("query", "事务状态未知，已拒绝执行 schema 修改")
                .with_detail("无法确认会话是否处于事务中；请重新连接后再试。"),
        );
    }
    if matches!(
        transaction.as_str(),
        "in_transaction" | "in_transaction_read_only"
    ) {
        return Err(DbErrorInfo::new(
            "query",
            "当前会话有未提交事务：请先 COMMIT/ROLLBACK，schema 修改不会替你隐式提交",
        ));
    }

    let conn = session.acquire_postgres().await?;
    if let Err(error) = conn.simple_query("BEGIN", 0).await {
        session
            .release_postgres(conn, true, TransactionState::None)
            .await;
        return Err(error);
    }
    for (index, statement) in statements.iter().enumerate() {
        if let Err(error) = conn.simple_query(statement, 0).await {
            let _ = conn.simple_query("ROLLBACK", 0).await;
            session
                .release_postgres(conn, true, TransactionState::None)
                .await;
            return Err(ddl_error(index, false, error));
        }
    }
    if let Err(error) = conn.simple_query("COMMIT", 0).await {
        session
            .release_postgres(conn, false, TransactionState::Unknown)
            .await;
        return Err(
            DbErrorInfo::new("outcome_unknown", format!("DDL 提交结果未知：{error}"))
                .with_detail("不要自动重试；请重新打开结构浏览器确认对象状态。"),
        );
    }
    session
        .release_postgres(conn, true, TransactionState::None)
        .await;
    Ok(SchemaOutcome {
        sql: statements
            .iter()
            .map(|statement| format!("{statement};"))
            .collect::<Vec<_>>()
            .join("\n"),
    })
}

pub async fn apply(
    adapter: &AdapterSet,
    session: &SessionEntry,
    change: &SchemaChange,
) -> Result<SchemaOutcome, DbErrorInfo> {
    let ddl = Ddl::new(adapter);
    let (statements, _, _) = build(&ddl, change)?;
    execute_statements(session, &statements).await
}

pub async fn apply_alter_table(
    adapter: &AdapterSet,
    session: &SessionEntry,
    detail: &super::model::DbTableDetail,
    request: &AlterTableRequest,
) -> Result<SchemaOutcome, DbErrorInfo> {
    let ddl = Ddl::new(adapter);
    let (statements, _, _) = alter_table_sql(&ddl, detail, request)?;
    execute_statements(session, &statements).await
}

#[cfg(test)]
mod tests {
    use super::{preview as preview_with_adapter, NewColumn, SchemaChange};
    use crate::database::adapter::AdapterSet;

    /// 这些测试锁的是 MySQL 生成的 DDL 文本。
    fn preview(change: &SchemaChange) -> Result<super::SchemaPreview, super::DbErrorInfo> {
        preview_with_adapter(&AdapterSet::mysql(), change)
    }

    #[test]
    fn non_mysql_engines_are_rejected_with_a_reason() {
        let pg = AdapterSet::of("postgres").expect("pg registered");
        // `DROP VIEW` 是标准 SQL，PostgreSQL 也能用；用"建库"验证拒绝路径。
        let error = preview_with_adapter(
            &pg,
            &SchemaChange::CreateDatabase {
                name: "x".to_string(),
                charset: None,
                collation: None,
            },
        )
        .unwrap_err();
        assert_eq!(error.stage, "unsupported");
        assert!(
            error.detail.is_some(),
            "拒绝必须带后续动作说明，不能只给一句话"
        );
    }

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
    use super::{
        alter_table_preview as alter_table_preview_with_adapter, AlterTableRequest, ColumnEdit,
        IndexEdit,
    };
    use crate::database::adapter::AdapterSet;
    use crate::database::model::{DbIndex, DbIndexColumn, DbTableColumn, DbTableDetail};

    fn alter_table_preview(
        detail: &DbTableDetail,
        request: &AlterTableRequest,
    ) -> Result<super::SchemaPreview, super::DbErrorInfo> {
        alter_table_preview_with_adapter(&AdapterSet::mysql(), detail, request)
    }

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
                primary_key: None,
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
                primary_key: None,
            },
        )
        .unwrap_err();
        assert_eq!(error.stage, "permission");
    }

    fn base_columns() -> Vec<ColumnEdit> {
        vec![
            ColumnEdit {
                original_name: Some("id".to_string()),
                name: "id".to_string(),
                column_type: "bigint".to_string(),
                nullable: false,
                auto_increment: true,
                default_value: None,
                comment: String::new(),
            },
            ColumnEdit {
                original_name: Some("name".to_string()),
                name: "name".to_string(),
                column_type: "varchar(64)".to_string(),
                nullable: false,
                auto_increment: false,
                default_value: None,
                comment: String::new(),
            },
        ]
    }

    fn index_edits() -> Vec<IndexEdit> {
        vec![IndexEdit {
            original_name: Some("idx_name".to_string()),
            name: "idx_name".to_string(),
            columns: vec!["name".to_string()],
            unique: false,
        }]
    }

    #[test]
    fn reordering_columns_emits_modify_with_position() {
        let mut columns = base_columns();
        columns.swap(0, 1);
        let result = alter_table_preview(
            &detail(),
            &AlterTableRequest {
                database: "db".to_string(),
                table: "users".to_string(),
                columns,
                indexes: index_edits(),
                primary_key: None,
            },
        )
        .unwrap();
        assert!(result.sql.contains("MODIFY COLUMN `name`"));
        assert!(result.sql.contains("FIRST"));
        assert!(!result.sql.contains("MODIFY COLUMN `id`"));
    }

    #[test]
    fn adding_column_in_the_middle_uses_after() {
        let mut columns = base_columns();
        columns.insert(
            1,
            ColumnEdit {
                original_name: None,
                name: "created_at".to_string(),
                column_type: "datetime".to_string(),
                nullable: true,
                auto_increment: false,
                default_value: None,
                comment: String::new(),
            },
        );
        let result = alter_table_preview(
            &detail(),
            &AlterTableRequest {
                database: "db".to_string(),
                table: "users".to_string(),
                columns,
                indexes: index_edits(),
                primary_key: None,
            },
        )
        .unwrap();
        assert!(result
            .sql
            .contains("ADD COLUMN `created_at` datetime NULL AFTER `id`"));
    }

    #[test]
    fn dropping_primary_key_is_destructive() {
        let mut columns = base_columns();
        // 自增列必须留在主键里，这里先去掉自增再删主键。
        columns[0].auto_increment = false;
        let result = alter_table_preview(
            &detail(),
            &AlterTableRequest {
                database: "db".to_string(),
                table: "users".to_string(),
                columns,
                indexes: index_edits(),
                primary_key: Some(vec![]),
            },
        )
        .unwrap();
        assert!(result.sql.contains("DROP PRIMARY KEY"));
        assert!(result.destructive);
    }

    #[test]
    fn changing_primary_key_replaces_it() {
        let mut columns = base_columns();
        // 自增列必须留在主键里，这里先去掉自增，模拟"把主键换成 name"。
        columns[0].auto_increment = false;
        let result = alter_table_preview(
            &detail(),
            &AlterTableRequest {
                database: "db".to_string(),
                table: "users".to_string(),
                columns,
                indexes: index_edits(),
                primary_key: Some(vec!["name".to_string()]),
            },
        )
        .unwrap();
        assert!(result.sql.contains("DROP PRIMARY KEY"));
        assert!(result.sql.contains("ADD PRIMARY KEY (`name`)"));
    }

    #[test]
    fn auto_increment_column_must_stay_in_primary_key() {
        let error = alter_table_preview(
            &detail(),
            &AlterTableRequest {
                database: "db".to_string(),
                table: "users".to_string(),
                columns: base_columns(),
                indexes: index_edits(),
                primary_key: Some(vec!["name".to_string()]),
            },
        )
        .unwrap_err();
        assert_eq!(error.stage, "config");
    }

    #[test]
    fn nullable_primary_key_column_is_rejected() {
        let mut columns = base_columns();
        columns[1].nullable = true;
        let error = alter_table_preview(
            &detail(),
            &AlterTableRequest {
                database: "db".to_string(),
                table: "users".to_string(),
                columns,
                indexes: index_edits(),
                primary_key: Some(vec!["name".to_string()]),
            },
        )
        .unwrap_err();
        assert_eq!(error.stage, "config");
    }
}

#[cfg(test)]
mod ddl_error_tests {
    use super::ddl_error;
    use crate::database::model::DbErrorInfo;

    #[test]
    fn fatal_error_is_outcome_unknown_and_not_retryable() {
        let mapped = ddl_error(
            0,
            true,
            DbErrorInfo::new("tcp", "connection reset").retryable(true),
        );
        assert_eq!(mapped.stage, "outcome_unknown");
        assert!(!mapped.retryable);
        assert!(mapped
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("是否生效未知")));
    }

    #[test]
    fn partial_failure_keeps_executed_count() {
        let mapped = ddl_error(1, false, DbErrorInfo::new("query", "bad view"));
        assert_eq!(mapped.stage, "query");
        assert!(mapped
            .detail
            .as_deref()
            .is_some_and(|detail| detail.contains("前 1 条")));
    }

    #[test]
    fn first_non_fatal_failure_has_no_partial_detail() {
        let mapped = ddl_error(0, false, DbErrorInfo::new("query", "bad ddl"));
        assert!(mapped.detail.is_none());
    }
}
