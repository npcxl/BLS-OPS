//! Per-session rate baselines.
//!
//! CPU % and network speed are *deltas*: they only exist by comparing two
//! readings. This module keeps the previous reading for each session so the
//! next collection has something to diff against.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use super::model::{CpuSample, NetSample};

/// The previous reading for one session.
pub(crate) struct SampleCache {
    pub(crate) cpu: CpuSample,
    pub(crate) net: HashMap<String, NetSample>,
    pub(crate) at: tokio::time::Instant,
}

/// 一个连接内**不会变**的主机信息。
///
/// `uname` 与 `/etc/os-release` 每次快照都重新执行是纯浪费：同一个 SSH 会话里
/// 系统、内核、架构、发行版不会变。缓存到断开为止，每次快照省两次 exec。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostInfo {
    pub system: String,
    pub kernel: String,
    pub architecture: String,
    pub os_name: Option<String>,
    pub os_version: Option<String>,
}

/// Per-session rate baselines.
///
/// Its lock is only ever held for a map lookup — never across an `await` — so
/// a slow server cannot stall other sessions' monitoring.
#[derive(Clone, Default)]
pub struct MonitorRegistry {
    samples: Arc<Mutex<HashMap<String, SampleCache>>>,
    /// 主机静态信息（会话生命周期内有效）。
    hosts: Arc<Mutex<HashMap<String, HostInfo>>>,
}

impl MonitorRegistry {
    /// Drops a session's baseline. Called on disconnect so a reconnect starts
    /// from a fresh measurement instead of diffing across the outage.
    pub async fn forget(&self, session_id: &str) {
        self.samples.lock().await.remove(session_id);
        self.hosts.lock().await.remove(session_id);
    }

    /// 取该会话缓存的主机静态信息（没有就是 `None`）。
    pub async fn host_info(&self, session_id: &str) -> Option<HostInfo> {
        self.hosts.lock().await.get(session_id).cloned()
    }

    /// 记下主机静态信息；同会话只写一次（重连会先 `forget`）。
    pub async fn store_host_info(&self, session_id: &str, info: HostInfo) {
        self.hosts
            .lock()
            .await
            .entry(session_id.to_string())
            .or_insert(info);
    }

    pub(crate) async fn take(&self, session_id: &str) -> Option<SampleCache> {
        self.samples.lock().await.remove(session_id)
    }

    pub(crate) async fn store(
        &self,
        session_id: &str,
        cpu: CpuSample,
        net: Vec<(String, NetSample)>,
    ) {
        self.samples.lock().await.insert(
            session_id.to_string(),
            SampleCache {
                cpu,
                net: net.into_iter().collect(),
                at: tokio::time::Instant::now(),
            },
        );
    }
}
