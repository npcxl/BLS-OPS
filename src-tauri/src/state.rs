use std::sync::Arc;

use crate::db::AppDb;

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<AppDb>,
}

impl AppState {
    pub fn new(db: AppDb) -> Self {
        Self { db: Arc::new(db) }
    }
}
