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
struct SampleCache {
    cpu: CpuSample,
    net: HashMap<String, NetSample>,
    at: tokio::time::Instant,
}

/// Per-session rate baselines.
///
/// Its lock is only ever held for a map lookup — never across an `await` — so
/// a slow server cannot stall other sessions' monitoring.
#[derive(Clone, Default)]
pub struct MonitorRegistry {
    samples: Arc<Mutex<HashMap<String, SampleCache>>>,
}

impl MonitorRegistry {
    /// Drops a session's baseline. Called on disconnect so a reconnect starts
    /// from a fresh measurement instead of diffing across the outage.
    pub async fn forget(&self, session_id: &str) {
        self.samples.lock().await.remove(session_id);
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
