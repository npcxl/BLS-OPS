use std::sync::Arc;

use crate::{
    database::DatabaseManager,
    db::AppDb,
    deployment::ai::model::AiReviewRegistry,
    deployment::artifact::tasks::TaskRegistry,
    deployment::run::{EnvironmentLocks, RunRegistry},
    dirsize::DirectorySizeRegistry,
    editor_sync::SyncRegistry,
    monitor::MonitorRegistry,
    project_discovery::ScanRegistry,
    ssh::SshSessionManager,
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
    /// 本地编辑器同步会话（编辑器保存 → SFTP 回传）。
    pub editor_syncs: SyncRegistry,
    /// P5.1 制品导入任务（指纹 / 安全扫描 / 识别），内存态 + 可取消。
    pub artifact_imports: TaskRegistry,
    /// P5.3 部署运行（取消位 + 本次运行已批准的节点）。
    pub runs: RunRegistry,
    /// P5.3 环境锁：**禁止两个部署同时改同一个环境**。
    pub env_locks: EnvironmentLocks,
    /// P5.5 AI 复核任务（取消位；任务状态本身在数据库里）。
    pub ai_reviews: AiReviewRegistry,
    /// 命令检索的收藏/使用快照：避免每次按键都开库查两张表。
    pub command_search: crate::command_center::CommandSearchCache,
    /// 文件传输任务中心（上传 / 下载队列，内存态 + 可取消）。
    pub transfers: Arc<crate::transfer::TransferCenter>,
    /// 数据库工作台：连接运行时、隧道、会话、查询与导出。
    pub database: DatabaseManager,
}

impl AppState {
    pub fn new(db: AppDb) -> Self {
        Self {
            db: Arc::new(db),
            ssh: SshSessionManager::default(),
            monitor: MonitorRegistry::default(),
            project_scans: ScanRegistry::default(),
            dir_sizes: Arc::new(DirectorySizeRegistry::default()),
            editor_syncs: SyncRegistry::default(),
            artifact_imports: TaskRegistry::default(),
            runs: RunRegistry::default(),
            env_locks: EnvironmentLocks::default(),
            ai_reviews: AiReviewRegistry::default(),
            command_search: crate::command_center::CommandSearchCache::default(),
            transfers: Arc::new(crate::transfer::TransferCenter::new()),
            database: DatabaseManager::default(),
        }
    }
}
