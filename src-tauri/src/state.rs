use std::sync::Arc;

use crate::{db::AppDb, ssh::SshSessionManager};

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<AppDb>,
    pub ssh: SshSessionManager,
}

impl AppState {
    pub fn new(db: AppDb) -> Self {
        Self { db: Arc::new(db), ssh: SshSessionManager::default() }
    }
}
