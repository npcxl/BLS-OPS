//! 表的 DDL 对象操作：重命名、复制、删除、清空。
//!
//! 只接受明确的表对象和枚举动作；SQL 由后端按 `AdapterSet`（引擎族 + 方言）生成，
//! 前端不能传 SQL。执行前检查连接只读、对象类型、会话事务；DDL 不自动重试。
//!
//! 引擎差异（`RENAME TABLE` vs `ALTER TABLE … RENAME TO`、SQLite 没有
//! `TRUNCATE`）全部在 `adapter::AdapterSet` 里，这里只负责校验与执行。

use std::time::Duration;

use mysql_async::prelude::Queryable;
use serde::{Deserialize, Serialize};

use super::adapter::AdapterSet;
use super::driver::map_error;
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
    adapter: &AdapterSet,
    detail: &DbTableDetail,
    request: &TableOperationRequest,
) -> Result<(Vec<String>, Option<String>, bool), DbErrorInfo> {
    let is_view = detail.kind == "view";
    let plan = match &request.kind {
        TableOperationKind::Rename => adapter.rename_object(
            &request.database,
            &detail.table,
            target_name(request)?,
            is_view,
        )?,
        TableOperationKind::CopyStructure | TableOperationKind::CopyData => adapter.copy_table(
            &request.database,
            &detail.table,
            target_name(request)?,
            matches!(&request.kind, TableOperationKind::CopyData),
        )?,
        TableOperationKind::Drop => {
            adapter.drop_object(&request.database, &detail.table, is_view)?
        }
        TableOperationKind::Truncate => adapter.truncate_table(&request.database, &detail.table)?,
    };

    let (warning, destructive) = match &request.kind {
        TableOperationKind::Rename => (None, false),
        TableOperationKind::CopyStructure => (
            Some("只复制结构，不复制数据和外键引用关系".to_string()),
            false,
        ),
        TableOperationKind::CopyData => (
            Some(
                "复制结构和数据期间如果 INSERT 失败，新表可能已经创建但数据不完整；请检查后手动处理"
                    .to_string(),
            ),
            false,
        ),
        TableOperationKind::Drop => (
            Some(
                if is_view {
                    "删除视图不会删除基表数据，但会永久移除视图定义"
                } else {
                    "删除表会永久删除结构和数据，无法撤销"
                }
                .to_string(),
            ),
            true,
        ),
        TableOperationKind::Truncate => (
            Some("清空表会删除全部行，但保留表结构".to_string()),
            true,
        ),
    };

    // 引擎特有偏差必须让用户看到（SQLite 复制表不保留约束等）。
    let warning = match (warning, plan.note) {
        (Some(base), Some(note)) => Some(format!("{base}；{note}")),
        (None, Some(note)) => Some(note),
        (base, None) => base,
    };
    Ok((plan.statements, warning, destructive))
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
    adapter: &AdapterSet,
    detail: &DbTableDetail,
    request: &TableOperationRequest,
) -> Result<TableOperationPreview, DbErrorInfo> {
    validate_kind(detail, request)?;
    let (sql, warning, destructive) = statements(adapter, detail, request)?;
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
    adapter: &AdapterSet,
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

    let (sql, warning, _) = statements(adapter, detail, request)?;
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
    use crate::database::adapter::AdapterSet;
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

    fn mysql() -> AdapterSet {
        AdapterSet::mysql()
    }

    #[test]
    fn rename_escapes_identifiers() {
        let result = preview(
            &mysql(),
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
            preview(
                &mysql(),
                &detail("table"),
                &request(TableOperationKind::Drop, None)
            )
            .unwrap()
            .destructive
        );
        assert!(
            preview(
                &mysql(),
                &detail("table"),
                &request(TableOperationKind::Truncate, None)
            )
            .unwrap()
            .destructive
        );
    }

    #[test]
    fn views_support_rename_and_drop_only() {
        let drop = preview(
            &mysql(),
            &detail("view"),
            &request(TableOperationKind::Drop, None),
        )
        .unwrap();
        assert_eq!(drop.sql, "DROP VIEW `db`.`orders`;");

        let error = preview(
            &mysql(),
            &detail("view"),
            &request(TableOperationKind::Truncate, None),
        )
        .unwrap_err();
        assert_eq!(error.stage, "permission");
    }

    #[test]
    fn preview_follows_the_engine_dialect() {
        let pg = AdapterSet::of("postgres").expect("pg registered");
        let rename = preview(
            &pg,
            &detail("table"),
            &request(TableOperationKind::Rename, Some("orders_new")),
        )
        .unwrap();
        assert_eq!(
            rename.sql,
            "ALTER TABLE \"db\".\"orders\" RENAME TO \"orders_new\";"
        );

        let copy = preview(
            &pg,
            &detail("table"),
            &request(TableOperationKind::CopyData, Some("orders_copy")),
        )
        .unwrap();
        assert_eq!(
            copy.sql,
            "CREATE TABLE \"db\".\"orders_copy\" (LIKE \"db\".\"orders\" INCLUDING ALL);\nINSERT INTO \"db\".\"orders_copy\" SELECT * FROM \"db\".\"orders\";"
        );

        // SQLite 只支持连数据一起复制，拒绝"只复制结构"。
        let sqlite = AdapterSet::of("sqlite").expect("sqlite registered");
        let error = preview(
            &sqlite,
            &detail("table"),
            &request(TableOperationKind::CopyStructure, Some("orders_copy")),
        )
        .unwrap_err();
        assert_eq!(error.stage, "unsupported");
    }
}
