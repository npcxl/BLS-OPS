//! SQLite 驱动：专用阻塞线程 + `interrupt()` 取消。
//!
//! 为什么不是"在 async 里直接调 rusqlite"：`rusqlite::Connection` 是 `!Sync`，
//! 且每次调用都会阻塞。这里把连接固定在一条**普通线程**上，async 侧只发任务、
//! 等 `oneshot`；取消通过 `InterruptHandle` 从任意线程打断正在执行的语句。
//!
//! 打开语义（必须严格遵守）：
//!
//! * 只打开**已存在**的文件：不加 `SQLITE_OPEN_CREATE`，路径错误就明确报错。
//!   新建数据库是独立操作，不能因为路径拼错就悄悄建一个空库。
//! * 只读连接用 `SQLITE_OPEN_READ_ONLY` 打开，写语句由 SQLite 自己拒绝。
//! * 用户库与应用的配置库（`AppDb`）是两份文件，互不影响。

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, ErrorCode, InterruptHandle, OpenFlags};
use tokio::sync::{mpsc, oneshot};

use super::super::model::{DbColumn, DbErrorInfo, DbValue};

/// 一次写入的结果。`in_transaction` 来自 SQLite 自己的 autocommit 状态，
/// 不是靠 SQL 前缀猜的。
pub struct ExecuteAnswer {
    pub affected_rows: i64,
    pub in_transaction: bool,
}

/// 一次查询的结果（已在 worker 内按预算截断）。
pub struct QueryAnswer {
    pub columns: Vec<DbColumn>,
    pub rows: Vec<Vec<DbValue>>,
    pub affected_rows: i64,
    pub truncated: bool,
    /// 执行完这条语句后是否仍在事务中（SQLite 的 autocommit 取反）。
    pub in_transaction: bool,
}

enum Job {
    Query {
        sql: String,
        max_rows: u64,
        max_bytes: usize,
        reply: oneshot::Sender<Result<QueryAnswer, DbErrorInfo>>,
    },
    Execute {
        sql: String,
        reply: oneshot::Sender<Result<ExecuteAnswer, DbErrorInfo>>,
    },
    Close {
        reply: oneshot::Sender<()>,
    },
}

/// 一条独占的 SQLite 连接（请求走 channel，连接留在工作线程里）。
pub struct SqliteWorker {
    tx: mpsc::UnboundedSender<Job>,
    interrupt: InterruptHandle,
    path: PathBuf,
    read_only: bool,
    version: String,
}

impl SqliteWorker {
    /// 打开**已有**的数据库文件。文件不存在时返回 `config` 错误，不会创建。
    pub fn open(path: &Path, read_only: bool) -> Result<Self, DbErrorInfo> {
        if !path.is_absolute() {
            return Err(DbErrorInfo::new("config", "SQLite 路径必须是绝对路径")
                .with_detail("相对路径会随应用工作目录漂移，导致打开到另一个文件。"));
        }
        if !path.is_file() {
            return Err(DbErrorInfo::new(
                "database",
                format!("SQLite 数据库文件不存在：{}", path.display()),
            )
            .with_detail("打开已有库不会自动创建文件；新建数据库请使用「新建 SQLite 数据库」。"));
        }

        let flags = if read_only {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        } else {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        };
        let conn = Connection::open_with_flags(path, flags | OpenFlags::SQLITE_OPEN_NO_MUTEX)
            .map_err(|error| map_error(&error, "database"))?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|error| map_error(&error, "config"))?;

        let version: String = conn
            .query_row("SELECT sqlite_version()", [], |row| row.get(0))
            .map_err(|error| map_error(&error, "query"))?;

        let interrupt = conn.get_interrupt_handle();
        let (tx, mut rx) = mpsc::unbounded_channel::<Job>();

        std::thread::Builder::new()
            .name(format!("sqlite-{}", path.display()))
            .spawn(move || {
                while let Some(job) = rx.blocking_recv() {
                    match job {
                        Job::Query {
                            sql,
                            max_rows,
                            max_bytes,
                            reply,
                        } => {
                            let _ = reply.send(run_query(&conn, &sql, max_rows, max_bytes));
                        }
                        Job::Execute { sql, reply } => {
                            let _ = reply.send(
                                conn.execute(&sql, [])
                                    .map(|affected| ExecuteAnswer {
                                        affected_rows: affected as i64,
                                        in_transaction: !conn.is_autocommit(),
                                    })
                                    .map_err(|error| map_error(&error, "query")),
                            );
                        }
                        Job::Close { reply } => {
                            let _ = reply.send(());
                            break;
                        }
                    }
                }
            })
            .map_err(|error| {
                DbErrorInfo::new("config", format!("无法启动 SQLite 工作线程：{error}"))
            })?;

        Ok(Self {
            tx,
            interrupt,
            path: path.to_path_buf(),
            read_only,
            version,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn read_only(&self) -> bool {
        self.read_only
    }

    pub fn version(&self) -> &str {
        &self.version
    }

    /// 打断工作线程上正在执行的语句。注意它不会关闭连接。
    pub fn interrupt(&self) {
        self.interrupt.interrupt();
    }

    pub async fn query(
        &self,
        sql: &str,
        max_rows: u64,
        max_bytes: usize,
    ) -> Result<QueryAnswer, DbErrorInfo> {
        let (reply, answer) = oneshot::channel();
        self.tx
            .send(Job::Query {
                sql: sql.to_string(),
                max_rows,
                max_bytes,
                reply,
            })
            .map_err(|_| DbErrorInfo::new("query", "SQLite 连接已关闭"))?;
        answer
            .await
            .map_err(|_| DbErrorInfo::new("query", "SQLite 工作线程已退出"))?
    }

    pub async fn execute(&self, sql: &str) -> Result<ExecuteAnswer, DbErrorInfo> {
        let (reply, answer) = oneshot::channel();
        self.tx
            .send(Job::Execute {
                sql: sql.to_string(),
                reply,
            })
            .map_err(|_| DbErrorInfo::new("query", "SQLite 连接已关闭"))?;
        answer
            .await
            .map_err(|_| DbErrorInfo::new("query", "SQLite 工作线程已退出"))?
    }

    pub async fn close(&self) {
        let (reply, done) = oneshot::channel();
        if self.tx.send(Job::Close { reply }).is_ok() {
            let _ = tokio::time::timeout(Duration::from_secs(2), done).await;
        }
    }
}

fn run_query(
    conn: &Connection,
    sql: &str,
    max_rows: u64,
    max_bytes: usize,
) -> Result<QueryAnswer, DbErrorInfo> {
    let mut stmt = conn
        .prepare(sql)
        .map_err(|error| map_error(&error, "query"))?;
    let column_count = stmt.column_count();
    if column_count == 0 {
        drop(stmt);
        let affected = conn
            .execute(sql, [])
            .map_err(|error| map_error(&error, "query"))?;
        return Ok(QueryAnswer {
            columns: Vec::new(),
            rows: Vec::new(),
            affected_rows: affected as i64,
            truncated: false,
            in_transaction: !conn.is_autocommit(),
        });
    }

    let columns: Vec<DbColumn> = (0..column_count)
        .map(|index| {
            let name = stmt.column_name(index).unwrap_or_default().to_string();
            // SQLite 的结果列没有可靠的声明类型（表达式/聚合都没有），
            // 留空比编一个 `TEXT` 更诚实；前端按值类型展示。
            let type_name = String::new();
            DbColumn {
                index,
                name: name.clone(),
                org_name: name,
                table: String::new(),
                org_table: String::new(),
                type_name,
                // SQLite 没有协议层类型码：0 表示"没有码"，前端按 type_name 显示。
                type_code: 0,
                nullable: true,
                unsigned: false,
                binary: false,
                primary_key: false,
                auto_increment: false,
                decimals: 0,
                charset: 0,
            }
        })
        .collect();

    let mut rows: Vec<Vec<DbValue>> = Vec::new();
    let mut bytes = 0usize;
    let mut truncated = false;
    let mut cursor = stmt.query([]).map_err(|error| map_error(&error, "query"))?;
    while let Some(row) = cursor.next().map_err(|error| map_error(&error, "query"))? {
        let mut values = Vec::with_capacity(column_count);
        for index in 0..column_count {
            let raw = row
                .get_ref(index)
                .map_err(|error| map_error(&error, "query"))?;
            let value = to_value(raw);
            bytes += approximate_bytes(&value);
            values.push(value);
        }
        rows.push(values);
        if rows.len() as u64 >= max_rows || bytes >= max_bytes {
            truncated = true;
            break;
        }
    }

    Ok(QueryAnswer {
        columns,
        rows,
        affected_rows: 0,
        truncated,
        in_transaction: !conn.is_autocommit(),
    })
}

fn to_value(raw: ValueRef<'_>) -> DbValue {
    match raw {
        ValueRef::Null => DbValue::Null,
        ValueRef::Integer(number) => DbValue::Int {
            value: number.to_string(),
            unsigned: false,
        },
        ValueRef::Real(number) => DbValue::Float { value: number },
        ValueRef::Text(bytes) => DbValue::Text {
            value: String::from_utf8_lossy(bytes).into_owned(),
            bytes: bytes.len(),
            truncated: false,
        },
        ValueRef::Blob(bytes) => DbValue::Binary {
            base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            bytes: bytes.len(),
            truncated: false,
        },
    }
}

fn approximate_bytes(value: &DbValue) -> usize {
    match value {
        DbValue::Null => 8,
        DbValue::Int { value, .. } | DbValue::Decimal { value } => value.len() + 24,
        DbValue::Float { .. } => 32,
        DbValue::Text { value, .. } | DbValue::Json { value, .. } => value.len() + 24,
        DbValue::Date { value } => value.len() + 24,
        DbValue::DateTime { value, .. } => value.len() + 40,
        DbValue::Time { value } => value.len() + 24,
        DbValue::Binary { base64, .. } => base64.len() + 40,
        DbValue::Bit { bits, .. } => bits.len() + 24,
        DbValue::Unsupported { preview, .. } => preview.len() + 48,
    }
}

/// 结构化错误映射。`OperationInterrupted` 归为 `cancelled`，`Busy/Locked`
/// 标可重试；**不把任何错误说成成功**。
pub fn map_error(error: &rusqlite::Error, stage_hint: &str) -> DbErrorInfo {
    match error {
        rusqlite::Error::SqliteFailure(code, message) => {
            let stage = match code.code {
                ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => "tcp",
                ErrorCode::ReadOnly => "permission",
                ErrorCode::OperationInterrupted => "cancelled",
                ErrorCode::CannotOpen => "database",
                ErrorCode::DatabaseCorrupt => "outcome_unknown",
                _ => stage_hint,
            };
            let retryable = matches!(
                code.code,
                ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked
            );
            DbErrorInfo {
                stage: stage.to_string(),
                code: Some(code.extended_code as u32),
                sql_state: None,
                message: message.clone().unwrap_or_else(|| error.to_string()),
                detail: None,
                retryable,
            }
        }
        rusqlite::Error::SqliteSingleThreadedMode => {
            DbErrorInfo::new("config", "SQLite 连接被跨线程使用（内部错误）")
        }
        other => DbErrorInfo::new(stage_hint, other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("bls-sqlite-{name}-{}.db", uuid::Uuid::new_v4()));
        let conn = Connection::open(&path).expect("create");
        conn.execute_batch("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, blob BLOB);")
            .expect("schema");
        drop(conn);
        path
    }

    #[tokio::test]
    async fn opens_existing_file_and_reads_typed_values() {
        let path = temp_db("read");
        let worker = SqliteWorker::open(&path, false).expect("open");
        worker
            .execute("INSERT INTO items (name, blob) VALUES ('a', x'00ff')")
            .await
            .expect("insert");

        let answer = worker
            .query("SELECT id, name, blob FROM items", 100, 1_000_000)
            .await
            .expect("query");
        assert_eq!(answer.columns.len(), 3);
        assert_eq!(answer.rows.len(), 1);
        assert!(matches!(answer.rows[0][0], DbValue::Int { .. }));
        assert!(matches!(answer.rows[0][1], DbValue::Text { .. }));
        assert!(matches!(answer.rows[0][2], DbValue::Binary { .. }));
        worker.close().await;

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn missing_file_is_an_error_and_is_not_created() {
        let path =
            std::env::temp_dir().join(format!("bls-sqlite-missing-{}.db", uuid::Uuid::new_v4()));
        match SqliteWorker::open(&path, false) {
            Ok(_) => panic!("缺少文件时不能打开成功"),
            Err(error) => assert_eq!(error.stage, "database"),
        }
        assert!(!path.exists(), "打开失败不能顺手创建空库");
    }

    #[tokio::test]
    async fn read_only_connection_rejects_writes() {
        let path = temp_db("readonly");
        let worker = SqliteWorker::open(&path, true).expect("open readonly");
        let error = worker
            .execute("INSERT INTO items (name) VALUES ('x')")
            .await
            .unwrap_err();
        assert_eq!(error.stage, "permission");
        worker.close().await;

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn budget_truncates_rows() {
        let path = temp_db("budget");
        let worker = SqliteWorker::open(&path, false).expect("open");
        worker
            .execute("WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n<50) INSERT INTO items (name) SELECT 'x' || n FROM s")
            .await
            .expect("seed");
        let answer = worker
            .query("SELECT id, name FROM items", 10, 1_000_000)
            .await
            .expect("query");
        assert_eq!(answer.rows.len(), 10);
        assert!(answer.truncated);
        worker.close().await;

        let _ = std::fs::remove_file(path);
    }
}
