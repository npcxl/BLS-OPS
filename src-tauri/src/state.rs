use std::sync::Arc;

use crate::{
    db::AppDb, dirsize::DirectorySizeRegistry, monitor::MonitorRegistry,
    project_discovery::ScanRegistry, ssh::SshSessionManager,
};

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<AppDb>,
    pub ssh: SshSessionManager,
    /// Rate baselines for monitoring, one per session. Disconnecting a session
    /// forgets it so a reconnect measures from scratch.
    pub monitor: MonitorRegistry,
    pub project_scans: ScanRegistry,
    /// On-demand directory-size computations, one per session + path.
    pub dir_sizes: Arc<DirectorySizeRegistry>,
}

impl AppState {
    pub fn new(db: AppDb) -> Self {
        Self {
            db: Arc::new(db),
            ssh: SshSessionManager::default(),
            monitor: MonitorRegistry::default(),
            project_scans: ScanRegistry::default(),
            dir_sizes: Arc::new(DirectorySizeRegistry::default()),
        }
    }
}
