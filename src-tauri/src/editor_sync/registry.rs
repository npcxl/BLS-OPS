//! 同步会话注册表：内存态（重启即清空——本地临时工作区同样如此）。
//!
//! 锁纪律与 `ssh/manager.rs` 一致：锁只在查找/更新时短暂持有，绝不跨
//! 网络 I/O。每次状态变化由调用方拿返回的快照去 emit 事件。

use std::collections::HashMap;
use std::sync::Arc;

use notify::RecommendedWatcher;
use tokio::sync::{watch, Mutex};

use super::model::{EditorSyncStatus, SyncSessionInfo};

/// 注册表里的一条会话。`_watcher` 必须保活——drop 它就等于停掉 OS 级
/// 文件监听；`close_tx` 用于主动终止上传任务。
pub(crate) struct SyncEntry {
    pub info: SyncSessionInfo,
    pub close_tx: watch::Sender<bool>,
    pub _watcher: RecommendedWatcher,
}

#[derive(Clone, Default)]
pub struct SyncRegistry {
    sessions: Arc<Mutex<HashMap<String, SyncEntry>>>,
}

impl SyncRegistry {
    /// 插入新会话（同 id 重复插入覆盖旧值——uuid 冲突即内部错误）。
    pub async fn insert(&self, entry: SyncEntry) {
        self.sessions.lock().await.insert(entry.info.id.clone(), entry);
    }

    /// 移除并返回会话（调用方负责发关闭信号 + 清理临时目录）。
    pub async fn remove(&self, sync_id: &str) -> Option<SyncEntry> {
        self.sessions.lock().await.remove(sync_id)
    }

    /// 判断会话是否仍然存在（上传任务在每次批量上传前检查）。
    pub async fn contains(&self, sync_id: &str) -> bool {
        self.sessions.lock().await.contains_key(sync_id)
    }

    /// 全量快照（面板打开时恢复显示）。
    pub async fn snapshot(&self) -> Vec<SyncSessionInfo> {
        self.sessions
            .lock()
            .await
            .values()
            .map(|entry| entry.info.clone())
            .collect()
    }

    /// 某个 SSH 会话下的快照。
    pub async fn snapshot_for_session(&self, session_id: &str) -> Vec<SyncSessionInfo> {
        self.sessions
            .lock()
            .await
            .values()
            .filter(|entry| entry.info.session_id == session_id)
            .map(|entry| entry.info.clone())
            .collect()
    }

    /// 原地更新一条会话并返回更新后的快照；会话已关闭返回 `None`。
    /// 关闭后的会话不再接受更新（迟到的上传结果不得复活它）。
    pub async fn update(
        &self,
        sync_id: &str,
        f: impl FnOnce(&mut SyncSessionInfo),
    ) -> Option<SyncSessionInfo> {
        let mut sessions = self.sessions.lock().await;
        let entry = sessions.get_mut(sync_id)?;
        if entry.info.status == EditorSyncStatus::Closed {
            return None;
        }
        f(&mut entry.info);
        Some(entry.info.clone())
    }
}
