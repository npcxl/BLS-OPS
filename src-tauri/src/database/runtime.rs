//! 一条连接配置的运行时：隧道 + 交互池 + 导出池 + 取消控制通道。
//!
//! **池不是会话**：交互池只服务元数据、表浏览这类"跑完就忘"的查询；
//! SQL 编辑器的会话永远是独占连接（见 `session`）。
//!
//! **导出有独立池**：导出最多占 1 条连接，绝不可能把交互池占满。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use mysql_async::prelude::Queryable;
use mysql_async::{Conn, Opts, Pool};
use tokio::sync::Mutex;

use super::adapter::AdapterSet;
use super::capability::{CancelMode, MySqlProductProfile, MYSQL_STANDARD_PROFILE};
use super::driver::{self, EndpointPlan, ResolvedEndpoint, SqliteWorker};
use super::engine_registry;
use super::model::DbErrorInfo;
use super::protocol::CancelHandle;
use super::tunnel::TunnelRegistry;

pub struct ProfileRuntime {
    pub profile_id: String,
    pub generation: u64,
    pub endpoint: ResolvedEndpoint,
    /// 取消通道：`KILL QUERY <thread_id>`。与执行连接**分开**，
    /// 这样取消不会被自己正在跑的查询阻塞。
    control: Mutex<Option<Conn>>,
    /// MySQL 连接参数。SQLite 运行时没有这些。
    opts: Option<Opts>,
    interactive: Option<Pool>,
    export: Option<Pool>,
    /// SQLite：独占连接跑在专用阻塞线程上，取消走 `interrupt()`。
    sqlite: Option<std::sync::Arc<SqliteWorker>>,
    active_queries: AtomicUsize,
}

impl ProfileRuntime {
    pub async fn connect(
        tunnels: &TunnelRegistry,
        plan: EndpointPlan,
    ) -> Result<Self, DbErrorInfo> {
        let endpoint = driver::resolve_plan(tunnels, plan).await?;

        // SQLite 是本地文件：既没有隧道，也没有连接池。
        if endpoint.profile.engine.eq_ignore_ascii_case("sqlite") {
            return Self::connect_sqlite(endpoint);
        }

        let timeout = Duration::from_millis(endpoint.profile.connect_timeout_ms);

        let opts = driver::build_opts(&endpoint, true)?;

        // 控制连接：建立时就确认认证/TLS 可用，避免第一次取消才发现通道不通。
        let mut control = driver::connect_once(opts.clone(), timeout).await?;
        driver::apply_session_settings(
            &mut control,
            endpoint.read_only,
            mysql_product_of(&endpoint),
        )
        .await?;

        let interactive = driver::build_interactive_pool(opts.clone());
        let export_opts = driver::build_opts(&endpoint, false)?;
        let export = driver::build_export_pool(export_opts);

        Ok(Self {
            profile_id: endpoint.profile.id.clone(),
            generation: endpoint.generation,
            endpoint,
            control: Mutex::new(Some(control)),
            opts: Some(opts),
            interactive: Some(interactive),
            export: Some(export),
            sqlite: None,
            active_queries: AtomicUsize::new(0),
        })
    }

    /// 打开一个已存在的 SQLite 文件。**不会创建**：路径错误就是错误。
    fn connect_sqlite(endpoint: ResolvedEndpoint) -> Result<Self, DbErrorInfo> {
        let path = endpoint
            .profile
            .engine_options
            .path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                DbErrorInfo::new("config", "SQLite 连接缺少数据库文件路径")
                    .with_detail("在连接配置里填写绝对路径；路径不存在时不会自动创建文件。")
            })?;
        let worker = SqliteWorker::open(std::path::Path::new(path), endpoint.read_only)?;
        Ok(Self {
            profile_id: endpoint.profile.id.clone(),
            generation: endpoint.generation,
            endpoint,
            control: Mutex::new(None),
            opts: None,
            interactive: None,
            export: None,
            sqlite: Some(std::sync::Arc::new(worker)),
            active_queries: AtomicUsize::new(0),
        })
    }

    /// SQLite 运行时（非 SQLite 返回 `None`）。
    pub fn sqlite(&self) -> Option<&std::sync::Arc<SqliteWorker>> {
        self.sqlite.as_ref()
    }

    /// 这条运行时对应的引擎适配器（方言 + SQL 模板）。
    ///
    /// 上层模块不再自己判断 `engine == "mysql"`；拿到适配器后按它生成语句。
    pub fn adapter(&self) -> Result<AdapterSet, DbErrorInfo> {
        AdapterSet::of(&self.endpoint.profile.engine)
    }

    /// 当前产品的 MySQL 执行差异（会话初始化 / 只读 / 取消）。
    ///
    /// 非 MySQL 引擎走不到 MySQL 驱动；回退标准档只是为了不把 `Option`
    /// 散到每个调用点。
    pub fn mysql_product(&self) -> &'static MySqlProductProfile {
        mysql_product_of(&self.endpoint)
    }

    pub fn interactive_pool(&self) -> Result<&Pool, DbErrorInfo> {
        self.interactive.as_ref().ok_or_else(|| {
            DbErrorInfo::new(
                "unsupported",
                "该引擎没有 MySQL 连接池：结构浏览/表数据暂未接入",
            )
        })
    }

    pub fn export_pool(&self) -> Result<&Pool, DbErrorInfo> {
        self.export
            .as_ref()
            .ok_or_else(|| DbErrorInfo::new("unsupported", "该引擎的导出连接尚未接入"))
    }

    pub fn begin_query(&self) {
        self.active_queries.fetch_add(1, Ordering::AcqRel);
    }

    pub fn end_query(&self) {
        self.active_queries.fetch_sub(1, Ordering::AcqRel);
    }

    pub fn active_queries(&self) -> usize {
        self.active_queries.load(Ordering::Acquire)
    }

    /// 按取消令牌中止正在执行的语句。
    ///
    /// MySQL 协议：在**独立控制连接**上发 `KILL QUERY <thread_id>`，参数是
    /// 驱动给的数值 id（不是字符串拼接）。不支持的驱动返回带原因的失败，
    /// 绝不假装取消成功。
    pub async fn cancel(&self, handle: &CancelHandle) -> Result<(), DbErrorInfo> {
        // SQLite：用 interrupt handle 打断工作线程上的语句（真正的取消）。
        if let Some(worker) = &self.sqlite {
            worker.interrupt();
            return Ok(());
        }
        // 产品级取消能力优先：Doris/StarRocks 按 query id 取消，
        // 拿连接 id 发 KILL QUERY 是没有意义的（甚至报错），如实拒绝。
        if let CancelMode::Unsupported { reason } = self.mysql_product().cancel {
            return Err(DbErrorInfo::new("cancelled", reason));
        }
        let CancelHandle::MySqlThread { thread_id } = handle else {
            return Err(DbErrorInfo::new(
                "cancelled",
                handle
                    .reason()
                    .unwrap_or("该驱动不支持服务端取消")
                    .to_string(),
            ));
        };
        let thread_id = *thread_id;
        let mut guard = self.control.lock().await;

        // 控制连接可能被服务器关掉（wait_timeout / 网络中断）：
        // 重建一次再试，仍然失败就如实返回 —— 取消不是"尽力而为"的接口。
        if guard.as_ref().map(Conn::is_disconnected).unwrap_or(true) {
            let timeout = Duration::from_millis(self.endpoint.profile.connect_timeout_ms);
            let opts = self
                .opts
                .clone()
                .ok_or_else(|| DbErrorInfo::new("config", "缺少 MySQL 连接参数"))?;
            let mut conn = driver::connect_once(opts, timeout).await?;
            driver::apply_session_settings(
                &mut conn,
                self.endpoint.read_only,
                self.mysql_product(),
            )
            .await?;
            *guard = Some(conn);
        }

        let conn = guard
            .as_mut()
            .ok_or_else(|| DbErrorInfo::new("cancelled", "取消控制连接不可用"))?;

        let statement = format!("KILL QUERY {thread_id}");
        match tokio::time::timeout(Duration::from_secs(5), conn.query_drop(statement)).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(driver::map_error(&error, "cancelled")),
            Err(_) => {
                Err(DbErrorInfo::new("cancelled", "取消控制连接在 5 秒内没有响应").retryable(true))
            }
        }
    }

    /// 轻量探活：元数据请求失败时用来区分"服务器挂了"还是"这条 SQL 错了"。
    pub async fn ping(&self) -> Result<(), DbErrorInfo> {
        if let Some(worker) = &self.sqlite {
            worker.query("SELECT 1", 1, 64).await?;
            return Ok(());
        }
        let mut guard = self.control.lock().await;
        let conn = guard
            .as_mut()
            .ok_or_else(|| DbErrorInfo::new("tcp", "控制连接不可用"))?;
        conn.ping()
            .await
            .map_err(|error| driver::map_error(&error, "tcp"))
    }

    pub async fn close(&self) {
        if let Some(worker) = &self.sqlite {
            worker.close().await;
            return;
        }
        if let Some(interactive) = &self.interactive {
            interactive.clone().disconnect().await.ok();
        }
        if let Some(export) = &self.export {
            export.clone().disconnect().await.ok();
        }
        let conn = {
            let mut guard = self.control.lock().await;
            guard.take()
        };
        if let Some(conn) = conn {
            let _ = tokio::time::timeout(Duration::from_secs(2), conn.disconnect()).await;
        }
    }

    pub fn opened_at(&self) -> Instant {
        Instant::now()
    }
}

fn mysql_product_of(endpoint: &ResolvedEndpoint) -> &'static MySqlProductProfile {
    engine_registry::mysql_product(&endpoint.profile.engine).unwrap_or(&MYSQL_STANDARD_PROFILE)
}
