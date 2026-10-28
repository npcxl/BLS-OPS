//! 表的 DDL 对象操作：重命名、复制、删除、清空。
//!
//! 只接受明确的表对象和枚举动作；SQL 由后端按标识符转义生成，前端不能传 SQL。
//! 执行前检查连接只读、对象类型、会话事务；DDL 不自动重试。

use std::time::Duration;

use mysql_async::prelude::Queryable;
use serde::{Deserialize, Serialize};

use super::driver::{map_error, quote_identifier};
use super::model::{DbErrorInfo, DbTableDetail};
use super::session::SessionEntry;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TableOperationKind {
    Rename,
    CopyStructure,
    CopyData,
    Drop,
    Truncate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableOperationRequest {
    pub kind: TableOperationKind,
    pub database: String,
    pub table: String,
    pub new_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableOperationPreview {
    pub sql: String,
    pub warning: Option<String>,
    pub destructive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableOperationOutcome {
    pub sql: String,
    pub warning: Option<String>,
}

fn target_name(request: &TableOperationRequest) -> Result<&str, DbErrorInfo> {
    let name = request
        .new_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| DbErrorInfo::new("config", "请输入新对象名"))?;
    if name == request.table {
        return Err(DbErrorInfo::new("config", "新名称不能与原名称相同"));
    }
    Ok(name)
}

fn statements(
    detail: &DbTableDetail,
    request: &TableOperationRequest,
) -> Result<(Vec<String>, Option<String>, bool), DbErrorInfo> {
    let database = quote_identifier(&request.database)?;
    let table = quote_identifier(&detail.table)?;
    let qualified = format!("{database}.{table}");

    match request.kind {
        TableOperationKind::Rename => {
            let new_name = quote_identifier(target_name(request)?)?;
            Ok((
                vec![format!("RENAME TABLE {qualified} TO {database}.{new_name}")],
                None,
                false,
            ))
        }
        TableOperationKind::CopyStructure | TableOperationKind::CopyData => {
            let new_name = quote_identifier(target_name(request)?)?;
            let new_qualified = format!("{database}.{new_name}");
            let mut sql = vec![format!("CREATE TABLE {new_qualified} LIKE {qualified}")];
            if matches!(request.kind, TableOperationKind::CopyData) {
                sql.push(format!(
                    "INSERT INTO {new_qualified} SELECT * FROM {qualified}"
                ));
            }
            Ok((
                sql,
                Some(if matches!(request.kind, TableOperationKind::CopyData) {
                    "复制结构和数据期间如果 INSERT 失败，新表可能已经创建但数据不完整；请检查后手动处理"
                } else {
                    "只复制结构，不复制数据和外键引用关系"
                }
                .to_string()),
                false,
            ))
        }
        TableOperationKind::Drop => {
            let object = if detail.kind == "view" {
                "VIEW"
            } else {
                "TABLE"
            };
            Ok((
                vec![format!("DROP {object} {qualified}")],
                Some(
                    if detail.kind == "view" {
                        "删除视图不会删除基表数据，但会永久移除视图定义"
                    } else {
                        "删除表会永久删除结构和数据，无法撤销"
                    }
                    .to_string(),
                ),
                true,
            ))
        }
        TableOperationKind::Truncate => Ok((
            vec![format!("TRUNCATE TABLE {qualified}")],
            Some("清空表会删除全部行，但保留表结构".to_string()),
            true,
        )),
    }
}

fn validate_kind(
    detail: &DbTableDetail,
    request: &TableOperationRequest,
) -> Result<(), DbErrorInfo> {
    match detail.kind.as_str() {
        "table" => Ok(()),
        "view"
            if matches!(
                request.kind,
                TableOperationKind::Rename | TableOperationKind::Drop
            ) =>
        {
            Ok(())
        }
        "view" => Err(DbErrorInfo::new(
            "permission",
            "视图只支持重命名和删除；复制/清空请对基表操作",
        )),
        _ => Err(DbErrorInfo::new(
            "permission",
            "当前对象不是可操作的表或视图",
        )),
    }
}

pub fn preview(
    detail: &DbTableDetail,
    request: &TableOperationRequest,
) -> Result<TableOperationPreview, DbErrorInfo> {
    validate_kind(detail, request)?;
    let (sql, warning, destructive) = statements(detail, request)?;
    Ok(TableOperationPreview {
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
    detail: &DbTableDetail,
    request: &TableOperationRequest,
) -> Result<TableOperationOutcome, DbErrorInfo> {
    validate_kind(detail, request)?;
    if session.read_only {
        return Err(DbErrorInfo::new(
            "permission",
            "该会话是只读连接：不能执行对象修改",
        ));
    }
    let transaction = session.transaction().await;
    if matches!(
        transaction.as_str(),
        "in_transaction" | "in_transaction_read_only"
    ) {
        return Err(DbErrorInfo::new(
            "query",
            "当前会话有未提交事务：请先 COMMIT/ROLLBACK，DDL 不会替你隐式提交",
        ));
    }

    let (sql, warning, _) = statements(detail, request)?;
    let mut conn = session.acquire_conn().await?;
    let mut executed = Vec::new();
    let mut result_warning = warning;
    for (index, statement) in sql.iter().enumerate() {
        match tokio::time::timeout(Duration::from_secs(30), conn.query_drop(statement.as_str()))
            .await
        {
            Ok(Ok(())) => executed.push(statement.clone()),
            Ok(Err(error)) => {
                session.release_conn(conn, true).await;
                let mut mapped = map_error(&error, "query");
                if index > 0 {
                    mapped.detail = Some(format!(
                        "前 {} 条 DDL 已执行，当前语句失败；对象可能处于部分完成状态",
                        index
                    ));
                }
                return Err(mapped);
            }
            Err(_) => {
                session.release_conn(conn, false).await;
                return Err(DbErrorInfo::new(
                    "timeout",
                    "对象操作超时：连接已丢弃，请重新检查对象状态",
                ));
            }
        }
    }
    session.release_conn(conn, true).await;
    if executed.len() > 1 {
        result_warning = Some(format!(
            "{}；共执行 {} 条语句",
            result_warning.unwrap_or_default(),
            executed.len()
        ));
    }
    Ok(TableOperationOutcome {
        sql: executed
            .iter()
            .map(|statement| format!("{statement};"))
            .collect::<Vec<_>>()
            .join("\n"),
        warning: result_warning,
    })
}

#[cfg(test)]
mod tests {
    use super::{preview, TableOperationKind, TableOperationRequest};
    use crate::database::model::DbTableDetail;

    fn detail(kind: &str) -> DbTableDetail {
        DbTableDetail {
            database: "db".to_string(),
            table: "orders".to_string(),
            kind: kind.to_string(),
            engine: Some("InnoDB".to_string()),
            collation: None,
            estimated_rows: Some(1),
            comment: String::new(),
            create_sql: None,
            columns: vec![],
            indexes: vec![],
            primary_key: vec![],
            reliable_key: None,
        }
    }

    fn request(kind: TableOperationKind, new_name: Option<&str>) -> TableOperationRequest {
        TableOperationRequest {
            kind,
            database: "db".to_string(),
            table: "orders".to_string(),
            new_name: new_name.map(str::to_string),
        }
    }

    #[test]
    fn rename_escapes_identifiers() {
        let result = preview(
            &detail("table"),
            &request(TableOperationKind::Rename, Some("new`orders")),
        )
        .unwrap();
        assert_eq!(
            result.sql,
            "RENAME TABLE `db`.`orders` TO `db`.`new``orders`;"
        );
        assert!(!result.destructive);
    }

    #[test]
    fn destructive_operations_are_marked() {
        assert!(
            preview(&detail("table"), &request(TableOperationKind::Drop, None))
                .unwrap()
                .destructive
        );
        assert!(
            preview(
                &detail("table"),
                &request(TableOperationKind::Truncate, None)
            )
            .unwrap()
            .destructive
        );
    }

    #[test]
    fn views_support_rename_and_drop_only() {
        let drop = preview(&detail("view"), &request(TableOperationKind::Drop, None)).unwrap();
        assert_eq!(drop.sql, "DROP VIEW `db`.`orders`;");

        let error = preview(
            &detail("view"),
            &request(TableOperationKind::Truncate, None),
        )
        .unwrap_err();
        assert_eq!(error.stage, "permission");
    }
}
