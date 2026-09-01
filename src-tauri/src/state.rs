use std::sync::Arc;

use crate::{
    db::AppDb, monitor::MonitorRegistry, project_discovery::ScanRegistry, ssh::SshSessionManager,
};

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<AppDb>,
    pub ssh: SshSessionManager,
    /// Rate baselines for monitoring, one per session. Disconnecting a session
    /// forgets it so a reconnect measures from scratch.
    pub monitor: MonitorRegistry,
    pub project_scans: ScanRegistry,
}

impl AppState {
    pub fn new(db: AppDb) -> Self {
        Self {
            db: Arc::new(db),
            ssh: SshSessionManager::default(),
            monitor: MonitorRegistry::default(),
            project_scans: ScanRegistry::default(),
        }
    }
}
