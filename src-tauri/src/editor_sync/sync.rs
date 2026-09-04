//! 同步会话的建立与上传任务。
//!
//! 打开流程（`open_sync_session`）：校验 → SFTP 下载副本 → 启动编辑器 →
//! 注册 OS 文件监听 → 启动防抖上传任务 → emit 状态事件。任何一步失败都
//! 清理临时目录后把错误交回前端。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

use notify::{RecursiveMode, Watcher};
use tauri::Emitter;
use tokio::sync::{mpsc, watch};

use tokio::io::AsyncWriteExt as _;

use super::model::{EditorSyncScope, EditorSyncStatus, SyncSessionInfo};
use super::{
    is_temp_artifact, upload_file_to, upload_mapped, SyncEntry, SyncRegistry, MAX_DIR_BYTES,
    MAX_DIR_DEPTH, MAX_DIR_FILES, QUIET_WINDOW, SKIP_DIR_NAMES,
};
use crate::ssh::{base_name, posix_join, sftp_error, SshSessionManager};
use anyhow::{anyhow, Result};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileType;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// 下载
// ---------------------------------------------------------------------------

/// 目录下载预算：任一上限触达即整体失败，错误信息明确告诉用户差多少。
struct DownloadBudget {
    files: u64,
    bytes: u64,
}

/// 单文件下载（文件模式）。
async fn download_file(sftp: &SftpSession, remote_path: &str, local_path: &Path) -> Result<()> {
    let mut remote = sftp.open(remote_path).await.map_err(sftp_error)?;
    let mut local = tokio::fs::File::create(local_path)
        .await
        .map_err(|error| anyhow!("创建本地副本失败：{error}"))?;
    tokio::io::copy(&mut remote, &mut local)
        .await
        .map_err(|error| anyhow!("下载副本失败：{error}"))?;
    local
        .shutdown()
        .await
        .map_err(|error| anyhow!("写入本地副本失败：{error}"))?;
    Ok(())
}

/// 下载目录树（目录模式，迭代栈避免 async 递归）。symlink 一律跳过
/// （防止循环与越权），跳过 `SKIP_DIR_NAMES` 中的构建产物目录。
async fn download_tree(
    sftp: &SftpSession,
    remote_root: &str,
    local_root: &Path,
    budget: &mut DownloadBudget,
) -> Result<()> {
    let mut stack: Vec<(String, PathBuf, usize)> =
        vec![(remote_root.to_string(), local_root.to_path_buf(), 0)];
    while let Some((remote_dir, local_dir, depth)) = stack.pop() {
        if depth > MAX_DIR_DEPTH {
            return Err(anyhow!("目录嵌套超过 {} 层，请缩小范围", MAX_DIR_DEPTH));
        }
        tokio::fs::create_dir_all(&local_dir)
            .await
            .map_err(|error| anyhow!("创建本地目录失败：{error}"))?;

        for entry in sftp.read_dir(&remote_dir).await.map_err(sftp_error)? {
            let name = entry.file_name();
            let meta = entry.metadata();
            let child_remote = posix_join(&remote_dir, &name);
            let child_local = local_dir.join(&name);
            match meta.file_type() {
                FileType::Symlink => continue,
                FileType::Dir => {
                    if SKIP_DIR_NAMES.contains(&name.as_str()) {
                        continue;
                    }
                    stack.push((child_remote, child_local, depth + 1));
                }
                _ => {
                    budget.files += 1;
                    budget.bytes += meta.len();
                    if budget.files > MAX_DIR_FILES {
                        return Err(anyhow!(
                            "目录包含超过 {MAX_DIR_FILES} 个文件，不适合整目录同步；请改为单个文件打开"
                        ));
                    }
                    if budget.bytes > MAX_DIR_BYTES {
                        return Err(anyhow!(
                            "目录总大小超过 {} MB，不适合整目录同步；请缩小范围",
                            MAX_DIR_BYTES / (1024 * 1024)
                        ));
                    }
                    download_file(sftp, &child_remote, &child_local).await?;
                }
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 监听与上传
// ---------------------------------------------------------------------------

/// notify 事件路径规范化：去掉 Windows 扩展路径前缀（`\\?\` / `\\?\UNC\`），
/// 便于与工作区根做 `strip_prefix` 匹配。
pub(crate) fn normalize_event_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

/// 建立文件监听，返回（watcher, 事件接收端）。watcher 必须保活。
fn create_watcher(workspace: &Path, scope: EditorSyncScope) -> Result<(notify::RecommendedWatcher, std::sync::mpsc::Receiver<std::result::Result<notify::Event, notify::Error>>)> {
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = notify::recommended_watcher(tx)
        .map_err(|error| anyhow!("无法监听本地目录：{error}"))?;
    let mode = match scope {
        EditorSyncScope::File => RecursiveMode::NonRecursive,
        EditorSyncScope::Directory => RecursiveMode::Recursive,
    };
    watcher
        .watch(workspace, mode)
        .map_err(|error| anyhow!("无法监听本地目录：{error}"))?;
    Ok((watcher, rx))
}

/// 单次批量上传到远程后的状态更新回调（emit 由调用方负责）。
pub(crate) struct SyncTaskDeps {
    pub app: tauri::AppHandle,
    pub registry: SyncRegistry,
    pub ssh: SshSessionManager,
    pub info: SyncSessionInfo,
}

/// 启动上传任务：std mpsc → tokio mpsc 桥接 + 防抖上传循环。
///
/// 退出条件（任一）：事件通道关闭（watcher 被 drop，即用户关闭同步）、
/// 关闭信号触发。任务结束前把会话标记为 closed 并 emit。
pub(crate) fn spawn_sync_task(deps: SyncTaskDeps, rx: std::sync::mpsc::Receiver<std::result::Result<notify::Event, notify::Error>>, close_rx: watch::Receiver<bool>) {
    tokio::spawn(async move {
        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<PathBuf>();
        // 桥接线程：notify 回调在自家线程里触发，这里转成 tokio 世界的事件流。
        tokio::task::spawn_blocking(move || {
            for result in rx {
                if let Ok(event) = result {
                    for path in event.paths {
                        if event_tx.send(normalize_event_path(path)).is_err() {
                            return;
                        }
                    }
                }
            }
        });

        let SyncTaskDeps {
            app,
            registry,
            ssh,
            info,
        } = deps;
        let sync_id = info.id.clone();
        let session_id = info.session_id.clone();
        let remote_root = info.remote_path.clone();
        let workspace = PathBuf::from(&info.local_path);
        let scope = info.scope;
        // 单文件模式的上传源/目标恒定：编辑器用任何临时文件名保存，最后
        // 都按工作区里那个目标文件的内容、覆盖到原来的远程路径。
        let file_target = match scope {
            EditorSyncScope::File => Some(workspace.join(base_name(&remote_root))),
            EditorSyncScope::Directory => None,
        };

        let mut pending: HashMap<PathBuf, Instant> = HashMap::new();
        let mut ticker = tokio::time::interval(Duration::from_millis(250));
        let mut close_rx = close_rx;
        loop {
            tokio::select! {
                maybe = event_rx.recv() => {
                    match maybe {
                        Some(path) => {
                            match scope {
                                EditorSyncScope::File => {
                                    pending.insert(file_target.clone().expect("file target"), Instant::now());
                                }
                                EditorSyncScope::Directory => {
                                    // 编辑器/系统的探针与锁文件不上传。
                                    if is_temp_artifact(&path) {
                                        continue;
                                    }
                                    pending.insert(path, Instant::now());
                                }
                            }
                        }
                        None => break,
                    }
                }
                _ = ticker.tick() => {
                    let now = Instant::now();
                    let due: Vec<PathBuf> = pending
                        .iter()
                        .filter(|(_, at)| now.duration_since(**at) >= QUIET_WINDOW)
                        .map(|(path, _)| path.clone())
                        .collect();
                    if due.is_empty() {
                        continue;
                    }
                    for path in &due {
                        pending.remove(path);
                    }
                    // 会话已被用户关闭：停止上传（临时目录即将被清理）。
                    if !registry.contains(&sync_id).await {
                        return;
                    }
                    for path in due {
                        let outcome = match scope {
                            EditorSyncScope::File => {
                                let target = file_target.clone().expect("file target");
                                upload_file_to(&ssh, &session_id, &remote_root, &target).await
                            }
                            EditorSyncScope::Directory => {
                                upload_mapped(&ssh, &session_id, &remote_root, &workspace, &path).await
                            }
                        };
                        let message = match outcome {
                            Ok(true) => None,
                            Ok(false) => None, // 文件已消失/是目录：无内容需要同步
                            Err(error) => Some(format!("保存未同步：{error:#}")),
                        };
                        if let Some(message) = message {
                            if let Some(updated) = registry
                                .update(&sync_id, |info| {
                                    info.status = EditorSyncStatus::Error;
                                    info.message = Some(message);
                                })
                                .await
                            {
                                let _ = app.emit(super::EDITOR_SYNC_EVENT, super::model::EditorSyncEventPayload::upsert(updated));
                            }
                        } else if let Some(updated) = registry
                            .update(&sync_id, |info| {
                                info.status = EditorSyncStatus::Active;
                                info.message = None;
                                info.sync_count += 1;
                                info.last_sync_at = now_ms();
                            })
                            .await
                        {
                            let _ = app.emit(super::EDITOR_SYNC_EVENT, super::model::EditorSyncEventPayload::upsert(updated));
                        }
                    }
                }
                _ = close_rx.changed() => break,
            }
        }

        // 终态：closed 只在用户主动关闭时出现（连接断开保持 error，让
        // 用户看见"保存失效"）。emit 失败无所谓——前端已经不在了。
        if let Some(updated) = registry
            .update(&sync_id, |info| {
                info.status = EditorSyncStatus::Closed;
            })
            .await
        {
            let _ = app.emit(super::EDITOR_SYNC_EVENT, super::model::EditorSyncEventPayload::upsert(updated));
        }
    });
}

// ---------------------------------------------------------------------------
// 打开 / 关闭
// ---------------------------------------------------------------------------

/// 打开一个同步会话：下载副本 → 启动编辑器 → 挂监听 → 起上传任务。
/// 返回初始会话信息（status=active）。出错时清理临时目录。
pub(crate) async fn open_sync_session(
    app: &tauri::AppHandle,
    registry: &SyncRegistry,
    ssh: &SshSessionManager,
    session_id: &str,
    remote_path: &str,
    editor: (String, String, PathBuf), // (editor_id, editor_name, exe)
) -> Result<SyncSessionInfo> {
    let (editor_id, editor_name, editor_exe) = editor;

    let session = ssh.get(session_id).await?;
    let sftp = session.sftp_client().await?;
    let canonical = sftp.canonicalize(remote_path).await.map_err(sftp_error)?;
    let meta = sftp.symlink_metadata(&canonical).await.map_err(sftp_error)?;
    let scope = match meta.file_type() {
        FileType::Dir => EditorSyncScope::Directory,
        FileType::Symlink => return Err(anyhow!("不支持同步符号链接")),
        _ => EditorSyncScope::File,
    };

    let sync_id = uuid::Uuid::new_v4().to_string();
    let workspace = super::sync_root().join(&sync_id);
    tokio::fs::create_dir_all(&workspace)
        .await
        .map_err(|error| anyhow!("创建本地工作区失败：{error}"))?;

    let local_target: PathBuf = match scope {
        EditorSyncScope::File => workspace.join(base_name(&canonical)),
        EditorSyncScope::Directory => workspace.clone(),
    };

    let download = async {
        match scope {
            EditorSyncScope::File => download_file(&sftp, &canonical, &local_target).await,
            EditorSyncScope::Directory => {
                let mut budget = DownloadBudget { files: 0, bytes: 0 };
                download_tree(&sftp, &canonical, &local_target, &mut budget).await
            }
        }
    };
    if let Err(error) = download.await {
        let _ = tokio::fs::remove_dir_all(&workspace).await;
        return Err(error);
    }

    let editor_target = match scope {
        EditorSyncScope::File => local_target.clone(),
        EditorSyncScope::Directory => workspace.clone(),
    };
    if let Err(message) = super::locator::spawn_editor(&editor_exe, &editor_target) {
        let _ = tokio::fs::remove_dir_all(&workspace).await;
        return Err(anyhow!(message));
    }

    // 注意：监听在工作区目录上（单文件模式监听其所在目录），这样编辑器用
    // "临时文件 + 改名替换"方式保存也能收到事件。
    let (watcher, rx) = match create_watcher(&workspace, scope) {
        Ok(pair) => pair,
        Err(error) => {
            let _ = tokio::fs::remove_dir_all(&workspace).await;
            return Err(error);
        }
    };

    let info = SyncSessionInfo {
        id: sync_id,
        session_id: session_id.to_string(),
        scope,
        remote_path: canonical,
        local_path: workspace.to_string_lossy().to_string(),
        editor_id,
        editor_name,
        status: EditorSyncStatus::Active,
        message: None,
        sync_count: 0,
        last_sync_at: 0,
        opened_at: now_ms(),
    };

    let (close_tx, close_rx) = watch::channel(false);
    registry
        .insert(SyncEntry {
            info: info.clone(),
            close_tx,
            _watcher: watcher,
        })
        .await;

    spawn_sync_task(
        SyncTaskDeps {
            app: app.clone(),
            registry: registry.clone(),
            ssh: ssh.clone(),
            info: info.clone(),
        },
        rx,
        close_rx,
    );

    let _ = app.emit(
        super::EDITOR_SYNC_EVENT,
        super::model::EditorSyncEventPayload::upsert(info.clone()),
    );
    Ok(info)
}

/// 关闭同步会话：停监听、终止上传任务、清理本地工作区。返回被关闭会话
/// 的最终状态（供命令层 emit）。
pub(crate) async fn close_sync_session(
    registry: &SyncRegistry,
    sync_id: &str,
) -> Result<SyncSessionInfo> {
    let entry = registry
        .remove(sync_id)
        .await
        .ok_or_else(|| anyhow!("同步会话不存在或已关闭"))?;
    // drop watcher 停掉 OS 监听并让桥接线程自然退出。
    let SyncEntry {
        mut info,
        close_tx,
        _watcher,
    } = entry;
    let _ = close_tx.send(true);
    drop(_watcher);
    info.status = EditorSyncStatus::Closed;
    let _ = tokio::fs::remove_dir_all(&info.local_path).await;
    Ok(info)
}
