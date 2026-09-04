//! 本地编辑器同步：把远程文件/目录下载到本地临时工作区，用本机编辑器
//! （VSCode、Cursor 等 AI 编辑器）打开，编辑器每次保存后自动经 SFTP 回传。
//!
//! 与 `safe.rs` 的关系：本模块**不执行任何远程 shell 命令**，全部远程操作
//! 都走 SFTP 协议（读写、mkdir），因此不涉及 Capability 白名单——这与
//! `ssh/sftp.rs` 的既有定位一致。
//!
//! 同步语义（安全默认，勿回退）：
//! * **只上行，不下行**：初始建立时从服务器下载一份副本；之后只有"本地保存
//!   → 上传覆盖远程"一个方向。本地删除的文件**绝不**在服务器上删除。
//! * 防抖上传：编辑器保存通常是临时文件改名替换，事件风暴在静默窗口
//!   （`QUIET_WINDOW`）结束后一次性上传。
//! * 会话状态每次变化都推 `editor-sync-update` 事件（载荷 camelCase），
//!   前端文件面板据此显示长连接状态；SSH 断开后第一次上传失败即转
//!   `error`，用户可见"保存未同步"，不会静默失效。
//! * 本地工作区在临时目录 `bls-ops-editor-sync/<sync_id>`，关闭时清理。

mod locator;
mod model;
mod registry;
mod sync;

pub use locator::{find_editor, list_editors};
pub use model::{
    EditorInfo, EditorSyncEventPayload, EditorSyncScope, EditorSyncStatus, SyncSessionInfo,
    EDITOR_SYNC_EVENT,
};
pub use registry::SyncRegistry;
pub(crate) use registry::SyncEntry;
pub(crate) use sync::{close_sync_session, open_sync_session};

use crate::ssh::{posix_join, posix_normalize, sftp_error, SshSessionManager};
use anyhow::{anyhow, Result};
use russh_sftp::client::SftpSession;
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt as _;

/// 目录模式下载的上限：超过任何一个直接报错，避免把服务器整站拖到本地。
pub(crate) const MAX_DIR_FILES: u64 = 4000;
pub(crate) const MAX_DIR_BYTES: u64 = 512 * 1024 * 1024;
/// 递归最大深度。
pub(crate) const MAX_DIR_DEPTH: usize = 16;
/// 目录模式下跳过的本地开发产物目录名（不会出现在服务器部署目录里也能兜底）。
pub(crate) const SKIP_DIR_NAMES: &[&str] = &["node_modules", "__pycache__", ".venv", "venv", ".cache"];

/// 上传前静默窗口：编辑器保存常见"临时文件 + 改名替换"，多事件在窗口内合并。
pub(crate) const QUIET_WINDOW: std::time::Duration = std::time::Duration::from_millis(700);

/// 所有同步会话共用的本地临时根目录。
pub(crate) fn sync_root() -> PathBuf {
    std::env::temp_dir().join("bls-ops-editor-sync")
}

/// 远程路径校验：必须以 `/` 开头的绝对路径（文件面板传入的即服务器绝对路径）。
pub(crate) fn validate_remote_path(path: &str) -> Result<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("远程路径不能为空"));
    }
    let normalized = posix_normalize(trimmed);
    if !normalized.starts_with('/') || normalized == "/" {
        return Err(anyhow!("远程路径必须是绝对路径"));
    }
    Ok(normalized)
}

/// 计算 `local_path` 相对工作区根的 POSIX 相对路径，并拒绝越界（`..`）。
pub(crate) fn relative_posix_path(workspace: &Path, local_path: &Path) -> Result<String> {
    let rel = local_path
        .strip_prefix(workspace)
        .map_err(|_| anyhow!("本地文件不在同步工作区内：{}", local_path.display()))?;
    let mut segments = Vec::new();
    for component in rel.components() {
        match component {
            std::path::Component::Normal(part) => segments.push(part.to_string_lossy().to_string()),
            std::path::Component::ParentDir | std::path::Component::Prefix(_) => {
                return Err(anyhow!("非法的本地同步路径：{}", local_path.display()));
            }
            _ => return Err(anyhow!("非法的本地同步路径：{}", local_path.display())),
        }
    }
    if segments.is_empty() {
        return Err(anyhow!("本地路径为空"));
    }
    Ok(segments.join("/"))
}

/// 编辑器保存时留下的临时产物不上传（VSCode/Emacs/vim 的探针与锁文件）。
pub(crate) fn is_temp_artifact(path: &Path) -> bool {
    let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
        return true;
    };
    name.starts_with(".#")
        || name.starts_with("#") && name.ends_with("#")
        || name.ends_with('~')
        || name.ends_with(".swp")
        || name.ends_with(".swx")
        || name.ends_with(".tmp")
        || name == "4913"
}

/// 确保远程父目录存在（逐段 create_dir，已存在时忽略错误），仅在直接
/// 创建文件失败后的重试路径上调用——正常路径零额外往返。
async fn ensure_remote_dir(sftp: &SftpSession, dir: &str) {
    let mut current = String::new();
    for segment in dir.split('/').filter(|s| !s.is_empty()) {
        if current.is_empty() {
            current.push('/');
        } else if !current.ends_with('/') {
            current.push('/');
        }
        current.push_str(segment);
        if sftp.metadata(&current).await.is_ok() {
            continue;
        }
        // 已存在/权限不足等错误留给真正的写入步骤去暴露。
        let _ = sftp.create_dir(&current).await;
    }
}

/// 把一个本地文件上传覆盖到**指定**远程路径（文件模式用：无论编辑器用什么
/// 临时文件名保存，目标恒为原来的远程文件）。本地文件已消失返回 Ok(false)。
pub(crate) async fn upload_file_to(
    ssh: &SshSessionManager,
    session_id: &str,
    remote_path: &str,
    local_path: &Path,
) -> Result<bool> {
    let meta = match tokio::fs::metadata(local_path).await {
        Ok(meta) => meta,
        Err(_) => return Ok(false), // 编辑器侧已删除，不同步删除
    };
    if meta.is_dir() {
        return Ok(false);
    }
    write_local_to_remote(ssh, session_id, remote_path, local_path).await?;
    Ok(true)
}

/// 目录模式上传：把 `local_path`（必须位于 `workspace` 之内）映射为
/// `remote_root` 下的同相对路径并覆盖。新增的本地文件会创建（父目录
/// 不存在时自动补建）；本地删除**绝不**同步删除。
pub(crate) async fn upload_mapped(
    ssh: &SshSessionManager,
    session_id: &str,
    remote_root: &str,
    workspace: &Path,
    local_path: &Path,
) -> Result<bool> {
    let meta = match tokio::fs::metadata(local_path).await {
        Ok(meta) => meta,
        Err(_) => return Ok(false),
    };
    if meta.is_dir() {
        return Ok(false);
    }
    let rel = relative_posix_path(workspace, local_path)?;
    let remote_path = posix_join(remote_root, &rel);
    write_local_to_remote(ssh, session_id, &remote_path, local_path).await?;
    Ok(true)
}

/// 打开本地文件 → SFTP create 写入（父目录缺失时补建并重试一次）。
async fn write_local_to_remote(
    ssh: &SshSessionManager,
    session_id: &str,
    remote_path: &str,
    local_path: &Path,
) -> Result<()> {
    let session = ssh.get(session_id).await?;
    let sftp = session.sftp_client().await?;

    let mut local = tokio::fs::File::open(local_path)
        .await
        .map_err(|error| anyhow!("打开本地文件 {} 失败：{error}", local_path.display()))?;
    let mut remote = match sftp.create(remote_path).await {
        Ok(file) => file,
        Err(_) => {
            // 父目录可能尚未存在（目录模式新增子目录文件）：补建后重试一次。
            if let Some((parent, _)) = remote_path.rsplit_once('/') {
                ensure_remote_dir(&sftp, parent).await;
            }
            sftp.create(remote_path).await.map_err(sftp_error)?
        }
    };
    tokio::io::copy(&mut local, &mut remote)
        .await
        .map_err(|error| anyhow!("上传 {} 失败：{error}", local_path.display()))?;
    remote
        .shutdown()
        .await
        .map_err(|error| anyhow!("上传 {} 失败：{error}", local_path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests;
