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

use super::driver::{self, EndpointPlan, ResolvedEndpoint};
use super::model::DbErrorInfo;
use super::tunnel::TunnelRegistry;

pub struct ProfileRuntime {
    pub profile_id: String,
    pub generation: u64,
    pub endpoint: ResolvedEndpoint,
    /// 取消通道：`KILL QUERY <thread_id>`。与执行连接**分开**，
    /// 这样取消不会被自己正在跑的查询阻塞。
    control: Mutex<Option<Conn>>,
    opts: Opts,
    interactive: Pool,
    export: Pool,
    active_queries: AtomicUsize,
}

impl ProfileRuntime {
    pub async fn connect(
        tunnels: &TunnelRegistry,
        plan: EndpointPlan,
    ) -> Result<Self, DbErrorInfo> {
        let endpoint = driver::resolve_plan(tunnels, plan).await?;
        let timeout = Duration::from_millis(endpoint.profile.connect_timeout_ms);

        let opts = driver::build_opts(&endpoint, true)?;

        // 控制连接：建立时就确认认证/TLS 可用，避免第一次取消才发现通道不通。
        let mut control = driver::connect_once(opts.clone(), timeout).await?;
        driver::apply_session_settings(&mut control, endpoint.read_only).await?;

        let interactive = driver::build_interactive_pool(opts.clone());
        let export_opts = driver::build_opts(&endpoint, false)?;
        let export = driver::build_export_pool(export_opts);

        Ok(Self {
            profile_id: endpoint.profile.id.clone(),
            generation: endpoint.generation,
            endpoint,
            control: Mutex::new(Some(control)),
            opts,
            interactive,
            export,
            active_queries: AtomicUsize::new(0),
        })
    }

    pub fn interactive_pool(&self) -> &Pool {
        &self.interactive
    }

    pub fn export_pool(&self) -> &Pool {
        &self.export
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

    /// 发一条 `KILL QUERY`。只接受来自本模块的 thread id（u32），
    /// 没有字符串拼接注入面。
    pub async fn kill_query(&self, thread_id: u32) -> Result<(), DbErrorInfo> {
        let mut guard = self.control.lock().await;

        // 控制连接可能被服务器关掉（wait_timeout / 网络中断）：
        // 重建一次再试，仍然失败就如实返回 —— 取消不是"尽力而为"的接口。
        if guard.as_ref().map(Conn::is_disconnected).unwrap_or(true) {
            let timeout = Duration::from_millis(self.endpoint.profile.connect_timeout_ms);
            let mut conn = driver::connect_once(self.opts.clone(), timeout).await?;
            driver::apply_session_settings(&mut conn, self.endpoint.read_only).await?;
            *guard = Some(conn);
        }

        let conn = guard
            .as_mut()
            .ok_or_else(|| DbErrorInfo::new("cancelled", "取消控制连接不可用"))?;

        let statement = format!("KILL QUERY {thread_id}");
        match tokio::time::timeout(Duration::from_secs(5), conn.query_drop(statement)).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(driver::map_error(&error, "cancelled")),
            Err(_) => Err(DbErrorInfo::new(
                "cancelled",
                "取消控制连接在 5 秒内没有响应",
            )
            .retryable(true)),
        }
    }

    /// 轻量探活：元数据请求失败时用来区分"服务器挂了"还是"这条 SQL 错了"。
    pub async fn ping(&self) -> Result<(), DbErrorInfo> {
        let mut guard = self.control.lock().await;
        let conn = guard
            .as_mut()
            .ok_or_else(|| DbErrorInfo::new("tcp", "控制连接不可用"))?;
        conn.ping()
            .await
            .map_err(|error| driver::map_error(&error, "tcp"))
    }

    pub async fn close(&self) {
        self.interactive.clone().disconnect().await.ok();
        self.export.clone().disconnect().await.ok();
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
