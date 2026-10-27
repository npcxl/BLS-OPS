//! 连接运行时注册表 + 会话/查询/导出编排。
//!
//! **锁纪律**：`runtimes` 的全局锁只在查表/插入时短暂持有，
//! 绝不在 SSH 握手、TCP 连接、认证或 SQL 执行期间持有。
//! 同一个 profile 的并发首次连接最多多建一条连接（随后丢弃），
//! 换来的是"一个卡住的服务器不会阻塞别的连接配置"。
//!
//! **SQLite 不跨 await**：命令层先用同步块读出 `EndpointPlan`，
//! 再把 plan 交给这里的 async 方法。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use rusqlite::Connection;
use tokio::sync::Mutex;

use super::driver::{self, EndpointPlan};
use super::export::ExportRegistry;
use super::metadata::MetadataCache;
use super::model::{ConnectionTestResult, DbErrorInfo, DbSessionInfo, ProfileRuntimeStatus};
use super::profiles;
use super::query::QueryRegistry;
use super::runtime::ProfileRuntime;
use super::session::{SessionEntry, SessionRegistry};
use super::tunnel::TunnelRegistry;

#[derive(Clone, Default)]
pub struct DatabaseManager {
    pub tunnels: TunnelRegistry,
    pub sessions: SessionRegistry,
    pub queries: QueryRegistry,
    pub exports: ExportRegistry,
    pub metadata: MetadataCache,
    runtimes: Arc<Mutex<HashMap<String, Arc<ProfileRuntime>>>>,
}

impl DatabaseManager {
    /// 取得（或建立）一条连接配置的运行时。
    pub async fn runtime(&self, plan: EndpointPlan) -> Result<Arc<ProfileRuntime>, DbErrorInfo> {
        let profile_id = plan.profile.id.clone();
        if let Some(existing) = self.runtimes.lock().await.get(&profile_id).cloned() {
            return Ok(existing);
        }

        // 锁外建立：SSH + TCP + 认证可能需要几十秒。
        let runtime = Arc::new(ProfileRuntime::connect(&self.tunnels, plan).await?);

        let mut runtimes = self.runtimes.lock().await;
        if let Some(existing) = runtimes.get(&profile_id).cloned() {
            // 并发首次连接：保留先到的，丢弃后到的（避免两条 SSH 隧道）。
            drop(runtimes);
            runtime.close().await;
            return Ok(existing);
        }
        runtimes.insert(profile_id, runtime.clone());
        Ok(runtime)
    }

    /// 配置变更/删除/手动断开：先停任务，再关会话，最后关池与隧道。
    pub async fn close_profile(&self, profile_id: &str) {
        let runtime = self.runtimes.lock().await.remove(profile_id);
        self.queries.release_profile(profile_id).await;
        self.exports.remove_profile(profile_id).await;
        self.sessions.close_profile(profile_id).await;
        self.metadata.invalidate(Some(profile_id)).await;
        if let Some(runtime) = runtime {
            runtime.close().await;
        }
    }

    pub async fn profile_status(&self, profile_id: &str) -> ProfileRuntimeStatus {
        let runtime = self.runtimes.lock().await.get(profile_id).cloned();
        let open_sessions = self.sessions.count_for_profile(profile_id).await;
        match runtime {
            Some(runtime) => ProfileRuntimeStatus {
                profile_id: profile_id.to_string(),
                generation: runtime.generation,
                connected: true,
                tunnel_active: runtime.endpoint.tunnel.is_some(),
                tunnel_local_port: runtime.endpoint.tunnel_local_port(),
                open_sessions,
                active_queries: runtime.active_queries(),
                server_version: None,
            },
            None => ProfileRuntimeStatus {
                profile_id: profile_id.to_string(),
                generation: 0,
                connected: false,
                tunnel_active: false,
                tunnel_local_port: None,
                open_sessions,
                active_queries: 0,
                server_version: None,
            },
        }
    }

    pub async fn open_session(
        &self,
        plan: EndpointPlan,
        session_id: &str,
    ) -> Result<DbSessionInfo, DbErrorInfo> {
        let profile_id = plan.profile.id.clone();
        let runtime = self.runtime(plan).await?;
        let timeout = Duration::from_millis(runtime.endpoint.profile.connect_timeout_ms);
        let opts = driver::build_opts(&runtime.endpoint, false)?;

        let mut conn = driver::connect_once(opts, timeout).await?;
        driver::apply_session_settings(&mut conn, runtime.endpoint.read_only).await?;

        let version = driver::server_version(&mut conn).await;
        let tls = driver::read_tls_status(&mut conn).await;
        let current_database = driver::current_database(&mut conn).await;

        let entry = Arc::new(SessionEntry::new(
            session_id.to_string(),
            profile_id,
            runtime.generation,
            conn,
            version,
            tls,
            runtime.endpoint.read_only,
        ));
        entry.set_current_database(current_database).await;

        // 同 id 的旧会话必须先关掉，否则它的连接会泄漏。
        if let Some(old) = self.sessions.remove(session_id).await {
            self.queries.release_session(session_id).await;
            old.close().await;
        }
        self.sessions.insert(entry.clone()).await;
        Ok(entry.info().await)
    }

    pub async fn close_session(&self, session_id: &str) {
        self.queries.release_session(session_id).await;
        if let Some(entry) = self.sessions.remove(session_id).await {
            entry.close().await;
        }
    }

    /// 切换逻辑会话的当前库（`USE`），并把这个事实记在会话上。
    pub async fn use_database(
        &self,
        session_id: &str,
        database: &str,
    ) -> Result<DbSessionInfo, DbErrorInfo> {
        use mysql_async::prelude::Queryable;

        let entry = self
            .sessions
            .get(session_id)
            .await
            .ok_or_else(|| DbErrorInfo::new("config", "会话不存在或已断开"))?;

        let mut conn = entry.acquire_conn().await?;
        let statement = format!("USE {}", driver::quote_identifier(database)?);
        match conn.query_drop(statement).await {
            Ok(()) => {
                entry.set_current_database(Some(database.to_string())).await;
                entry.release_conn(conn, true).await;
                Ok(entry.info().await)
            }
            Err(error) => {
                entry.release_conn(conn, !error.is_fatal()).await;
                Err(driver::map_error(&error, "database"))
            }
        }
    }

    pub async fn session(&self, session_id: &str) -> Result<Arc<SessionEntry>, DbErrorInfo> {
        self.sessions
            .get(session_id)
            .await
            .ok_or_else(|| DbErrorInfo::new("config", "会话不存在或已断开"))
    }

    /// 只读测试：用**表单里的**配置（可能是未保存的）建立一次连接。
    pub async fn test_connection(&self, plan: EndpointPlan) -> ConnectionTestResult {
        let started = std::time::Instant::now();
        let read_only = plan.profile.read_only;
        let timeout = Duration::from_millis(plan.profile.connect_timeout_ms);

        let endpoint = match driver::resolve_plan(&self.tunnels, plan).await {
            Ok(endpoint) => endpoint,
            Err(error) => {
                return ConnectionTestResult {
                    ok: false,
                    stage: error.stage.clone(),
                    error: Some(error),
                    latency_ms: started.elapsed().as_millis() as u64,
                    server_version: None,
                    connection_id: None,
                    tls: None,
                    tunnel_local_port: None,
                    read_only,
                }
            }
        };

        let opts = match driver::build_opts(&endpoint, false) {
            Ok(opts) => opts,
            Err(error) => {
                return ConnectionTestResult {
                    ok: false,
                    stage: error.stage.clone(),
                    error: Some(error),
                    latency_ms: started.elapsed().as_millis() as u64,
                    server_version: None,
                    connection_id: None,
                    tls: None,
                    tunnel_local_port: endpoint.tunnel_local_port(),
                    read_only,
                }
            }
        };

        let mut conn = match driver::connect_once(opts, timeout).await {
            Ok(conn) => conn,
            Err(error) => {
                return ConnectionTestResult {
                    ok: false,
                    stage: error.stage.clone(),
                    error: Some(error),
                    latency_ms: started.elapsed().as_millis() as u64,
                    server_version: None,
                    connection_id: None,
                    tls: None,
                    tunnel_local_port: endpoint.tunnel_local_port(),
                    read_only,
                }
            }
        };

        if let Err(error) = driver::apply_session_settings(&mut conn, endpoint.read_only).await {
            let tunnel_local_port = endpoint.tunnel_local_port();
            let _ = tokio::time::timeout(Duration::from_secs(2), conn.disconnect()).await;
            return ConnectionTestResult {
                ok: false,
                stage: error.stage.clone(),
                error: Some(error),
                latency_ms: started.elapsed().as_millis() as u64,
                server_version: None,
                connection_id: None,
                tls: None,
                tunnel_local_port,
                read_only,
            };
        }

        let version = driver::server_version(&mut conn).await;
        let tls = driver::read_tls_status(&mut conn).await;
        let connection_id = Some(conn.id());
        let tunnel_local_port = endpoint.tunnel_local_port();
        let _ = tokio::time::timeout(Duration::from_secs(2), conn.disconnect()).await;

        ConnectionTestResult {
            ok: true,
            stage: "ready".to_string(),
            error: None,
            latency_ms: started.elapsed().as_millis() as u64,
            server_version: version,
            connection_id,
            tls: Some(tls),
            tunnel_local_port,
            read_only: endpoint.read_only,
        }
    }

    /// 连接配置所引用的 SSH 服务器被删除/修改时清理隧道。
    pub async fn close_tunnels_for_server(&self, server_id: &str) {
        self.tunnels.close_for_server(server_id).await;
    }

    pub fn load_profile(
        &self,
        db: &Connection,
        profile_id: &str,
    ) -> Result<super::model::DatabaseProfile, DbErrorInfo> {
        profiles::get_profile(db, profile_id)
            .map_err(|error| DbErrorInfo::new("config", error.to_string()))?
            .ok_or_else(|| DbErrorInfo::new("config", "连接配置不存在"))
    }
}

/// 会话的 generation 校验：旧响应必须被丢弃。
pub fn check_generation(expected: u64, actual: u64) -> Result<(), DbErrorInfo> {
    if expected != actual {
        return Err(DbErrorInfo::new(
            "query",
            "会话已重新连接：旧查询的响应已被丢弃",
        ));
    }
    Ok(())
}
