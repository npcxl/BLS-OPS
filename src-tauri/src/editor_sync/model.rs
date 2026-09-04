//! 同步会话的数据模型。载荷字段 camelCase、枚举值 snake_case，与前端
//! `src/api/types/editor-sync.ts` 逐字一致（事件与命令共用同一结构）。

use serde::Serialize;

/// Tauri 事件名：每次同步会话状态变化推送一条 `SyncSessionInfo`。
pub const EDITOR_SYNC_EVENT: &str = "editor-sync-update";

/// 一个本地编辑器（探测结果，可能未安装）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorInfo {
    /// 稳定 id（`vscode` / `cursor` / …），前端用它回传。
    pub id: String,
    /// 展示名。
    pub name: String,
    /// 本机是否找到了可执行文件。
    pub available: bool,
    /// 找到时的可执行文件绝对路径。
    pub path: Option<String>,
}

/// 同步范围：单文件或整个目录。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EditorSyncScope {
    File,
    Directory,
}

/// 同步会话生命周期状态。
///
/// * `starting` 仅在下载/启动编辑器的极短窗口内出现。
/// * `error` 表示最近一次保存未能同步（如 SSH 断开）——这正是用户要的
///   "保存失效可见"；下一次保存成功会自动回到 `active`。
/// * `closed` 是用户主动关闭后的终态（registry 已移除，仅为快照完整保留）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EditorSyncStatus {
    Starting,
    Active,
    Error,
    Closed,
}

/// 一条同步会话的完整状态（事件载荷 + 命令返回值）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSessionInfo {
    pub id: String,
    /// 所属 SSH 会话。
    pub session_id: String,
    pub scope: EditorSyncScope,
    /// 服务器上的根（文件或目录的绝对路径）。
    pub remote_path: String,
    /// 本地工作区绝对路径（单文件模式下是文件自身）。
    pub local_path: String,
    pub editor_id: String,
    pub editor_name: String,
    pub status: EditorSyncStatus,
    /// `error` 状态下的失败原因；其余状态为 `None`。
    pub message: Option<String>,
    /// 累计成功同步次数（0 = 编辑器保存后还没有回传过）。
    pub sync_count: u32,
    /// 最近一次成功同步的毫秒时间戳；0 = 从未。
    pub last_sync_at: i64,
    pub opened_at: i64,
}

/// 事件包了一层 `kind`，前端可以一眼分辨快照与增量（当前只有 upsert）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSyncEventPayload {
    pub kind: String,
    pub session: SyncSessionInfo,
}

impl EditorSyncEventPayload {
    pub fn upsert(session: SyncSessionInfo) -> Self {
        Self {
            kind: "upsert".to_string(),
            session,
        }
    }
}
