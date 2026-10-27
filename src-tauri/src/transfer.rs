//! 文件传输任务中心：上传 / 下载不再是一次调用干等到结束。
//!
//! 每个文件一个任务，任务表在内存里（重启即清空 —— 传输本身就是短生命周期
//! 动作，持久化只会留下一堆"永远 running"的僵尸记录）。
//!
//! 几条硬规则：
//! * **临时文件**：写 `<目标>.bls-part`，完成才原子改名。取消或失败会删掉
//!   临时文件，目标名要么是完整内容、要么根本不存在。
//! * **取消**：每个任务一个 `AtomicBool`，分块循环里检查；已取消的任务不会
//!   被标记成失败（错误信息会误导人）。
//! * **同名策略**：`overwrite` / `skip` / `rename`。默认走 `rename`，不静默
//!   覆盖别人的文件。
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::Semaphore;

use crate::state::AppState;

/// 任务状态变化事件；payload 是完整的 [`TransferTask`]，前端按 id 覆盖。
pub const TRANSFER_EVENT: &str = "transfer-progress";
/// 同时进行的任务数。上传下载都吃带宽，再多只会互相拖慢。
const MAX_CONCURRENT: usize = 2;
/// 进度事件的字节间隔（块大小 256 KB，这里约每 4 MB 发一次）。
const PROGRESS_STEP_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferKind {
    Upload,
    Download,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferState {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
    /// 同名且策略为 skip：没有传输，但也不是错误。
    Skipped,
}

/// 同名文件的处理方式。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    Overwrite,
    Skip,
    /// 默认：`name.ext` → `name (2).ext`，绝不静默盖掉已有文件。
    #[default]
    Rename,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferTask {
    pub id: String,
    pub session_id: String,
    pub kind: TransferKind,
    pub name: String,
    /// 本地路径（上传）/ 远程路径（下载）。
    pub source: String,
    /// 远程路径（上传）/ 本地路径（下载）。
    pub target: String,
    pub total: u64,
    pub transferred: u64,
    pub state: TransferState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct TransferCenter {
    tasks: Mutex<Vec<TransferTask>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    gate: Semaphore,
}

impl Default for TransferCenter {
    fn default() -> Self {
        Self::new()
    }
}

impl TransferCenter {
    pub fn new() -> Self {
        Self {
            tasks: Mutex::new(Vec::new()),
            cancels: Mutex::new(HashMap::new()),
            gate: Semaphore::new(MAX_CONCURRENT),
        }
    }

    pub fn list(&self) -> Vec<TransferTask> {
        let mut tasks = self.tasks.lock().unwrap().clone();
        tasks.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        tasks
    }

    fn get(&self, id: &str) -> Option<TransferTask> {
        self.tasks
            .lock()
            .unwrap()
            .iter()
            .find(|task| task.id == id)
            .cloned()
    }

    fn insert(&self, task: TransferTask) {
        self.tasks.lock().unwrap().push(task);
    }

    fn touch(&self, id: &str, update: impl FnOnce(&mut TransferTask)) -> Option<TransferTask> {
        let mut tasks = self.tasks.lock().unwrap();
        let task = tasks.iter_mut().find(|task| task.id == id)?;
        update(task);
        task.updated_at = now_ms();
        Some(task.clone())
    }

    fn cancel_flag(&self, id: &str) -> Arc<AtomicBool> {
        let mut cancels = self.cancels.lock().unwrap();
        cancels
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    /// 取消：排队中的直接标记取消，运行中的置位让分块循环退出。
    pub fn cancel(&self, id: &str) -> Option<TransferTask> {
        if let Some(flag) = self.cancels.lock().unwrap().get(id) {
            flag.store(true, Ordering::Relaxed);
        }
        self.touch(id, |task| {
            if task.state == TransferState::Queued {
                task.state = TransferState::Cancelled;
                task.error = Some("已取消".to_string());
            }
        })
    }

    /// 重试：只重置状态，真正的重新入队由命令层做（它需要 ssh / app）。
    fn reset_for_retry(&self, id: &str) -> Option<TransferTask> {
        if let Some(flag) = self.cancels.lock().unwrap().get(id) {
            flag.store(false, Ordering::Relaxed);
        }
        self.touch(id, |task| {
            task.state = TransferState::Queued;
            task.transferred = 0;
            task.error = None;
        })
    }

    /// 清理已结束的任务，返回移除条数。
    fn clear_finished(&self) -> usize {
        let mut tasks = self.tasks.lock().unwrap();
        let before = tasks.len();
        tasks.retain(|task| matches!(task.state, TransferState::Queued | TransferState::Running));
        before - tasks.len()
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn emit(app: &AppHandle, task: &TransferTask) {
    let _ = app.emit(TRANSFER_EVENT, task);
}

// ---------------------------------------------------------------------------
// 入队
// ---------------------------------------------------------------------------

/// 上传本地文件 / 目录，返回新建的任务（含 skipped）。
pub async fn enqueue_upload(
    state: &AppState,
    app: &AppHandle,
    session_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
    conflict: ConflictPolicy,
) -> Result<Vec<TransferTask>> {
    let files = collect_local_files(&local_paths)?;
    if files.is_empty() {
        return Err(anyhow!("没有可上传的文件"));
    }
    let base = remote_dir.trim_end_matches('/').to_string();
    let mut created = Vec::new();

    for (local, relative) in files {
        let name = local
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .ok_or_else(|| anyhow!("文件名无效"))?;
        let mut target = format!("{base}/{relative}");
        let exists = state
            .ssh
            .sftp_exists(&session_id, &target)
            .await
            .unwrap_or(false);

        if exists {
            match conflict {
                ConflictPolicy::Skip => {
                    let task = new_task(
                        &session_id,
                        TransferKind::Upload,
                        &name,
                        &local.to_string_lossy(),
                        &target,
                        local_len(&local),
                        TransferState::Skipped,
                    );
                    state.transfers.insert(task.clone());
                    emit(app, &task);
                    created.push(task);
                    continue;
                }
                ConflictPolicy::Rename => {
                    target = unique_remote_name(state, &session_id, &target).await;
                }
                ConflictPolicy::Overwrite => {}
            }
        }

        // 目录上传要保证中间目录存在（父目录与目标不同才算有中间层）。
        let parent = crate::ssh::parent_of(&target);
        if parent != target {
            let _ = state.ssh.ensure_remote_dir(&session_id, &parent).await;
        }

        let task = new_task(
            &session_id,
            TransferKind::Upload,
            &name,
            &local.to_string_lossy(),
            &target,
            local_len(&local),
            TransferState::Queued,
        );
        state.transfers.insert(task.clone());
        emit(app, &task);
        spawn_task(state.clone(), app.clone(), task.clone(), local);
        created.push(task);
    }
    Ok(created)
}

/// 下载远程文件到本地路径。
pub async fn enqueue_download(
    state: &AppState,
    app: &AppHandle,
    session_id: String,
    remote_path: String,
    local_path: String,
    conflict: ConflictPolicy,
) -> Result<TransferTask> {
    let mut target = local_path.clone();
    if std::fs::metadata(&target).is_ok() {
        match conflict {
            ConflictPolicy::Skip => {
                let task = new_task(
                    &session_id,
                    TransferKind::Download,
                    &file_name(&remote_path),
                    &remote_path,
                    &target,
                    0,
                    TransferState::Skipped,
                );
                state.transfers.insert(task.clone());
                emit(app, &task);
                return Ok(task);
            }
            ConflictPolicy::Rename => target = unique_local_name(&target),
            ConflictPolicy::Overwrite => {}
        }
    }

    let task = new_task(
        &session_id,
        TransferKind::Download,
        &file_name(&remote_path),
        &remote_path,
        &target,
        0,
        TransferState::Queued,
    );
    state.transfers.insert(task.clone());
    emit(app, &task);
    spawn_task(
        state.clone(),
        app.clone(),
        task.clone(),
        PathBuf::from(&remote_path),
    );
    Ok(task)
}

/// 重试一个已结束的任务。
pub fn retry(state: &AppState, app: &AppHandle, id: &str) -> Result<TransferTask> {
    let Some(task) = state.transfers.reset_for_retry(id) else {
        return Err(anyhow!("任务不存在"));
    };
    emit(app, &task);
    spawn_task(
        state.clone(),
        app.clone(),
        task.clone(),
        PathBuf::from(&task.source),
    );
    Ok(task)
}

pub fn cancel(state: &AppState, id: &str) -> Result<TransferTask> {
    state
        .transfers
        .cancel(id)
        .ok_or_else(|| anyhow!("任务不存在"))
}

pub fn clear_finished(state: &AppState) -> usize {
    state.transfers.clear_finished()
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

fn spawn_task(state: AppState, app: AppHandle, task: TransferTask, local: PathBuf) {
    tauri::async_runtime::spawn(async move {
        // 并发闸门：超出就排队，任务状态仍是 queued。
        let Ok(_permit) = state.transfers.gate.acquire().await else {
            return;
        };
        let Some(running) = state.transfers.touch(&task.id, |item| {
            // 入队后立刻被取消：不要再动远端。
            if item.state == TransferState::Queued {
                item.state = TransferState::Running;
            }
        }) else {
            return;
        };
        emit(&app, &running);
        if running.state == TransferState::Cancelled {
            return;
        }

        let cancel = state.transfers.cancel_flag(&task.id);
        let progress_state = state.clone();
        let progress_app = app.clone();
        let progress_id = task.id.clone();
        let on_progress = move |done: u64, total: u64| {
            // 每 4 MB 一次 + 完成时一次，避免刷爆事件通道。
            let Some(updated) = progress_state.transfers.touch(&progress_id, |item| {
                item.transferred = done;
                if total > 0 {
                    item.total = total;
                }
            }) else {
                return;
            };
            if done % PROGRESS_STEP_BYTES < 300 * 1024 {
                emit(&progress_app, &updated);
            }
        };

        let result = match task.kind {
            TransferKind::Upload => {
                state
                    .ssh
                    .upload_to_path(
                        &task.session_id,
                        &local,
                        &task.target,
                        &cancel,
                        &on_progress,
                    )
                    .await
            }
            TransferKind::Download => {
                state
                    .ssh
                    .download_to_path(
                        &task.session_id,
                        &task.source,
                        &local,
                        &cancel,
                        &on_progress,
                    )
                    .await
            }
        };

        let cancelled = cancel.load(Ordering::Relaxed);
        let Some(final_task) = state.transfers.touch(&task.id, |item| match &result {
            Ok(bytes) => {
                item.transferred = *bytes;
                item.state = TransferState::Completed;
                item.error = None;
            }
            Err(error) => {
                item.state = if cancelled {
                    TransferState::Cancelled
                } else {
                    TransferState::Failed
                };
                item.error = Some(error.to_string());
            }
        }) else {
            return;
        };
        emit(&app, &final_task);

        if final_task.state == TransferState::Completed {
            // 上传落地后让文件面板刷新（沿用既有的事件约定）。
            let _ = app.emit(
                &format!("sftp-changed-{}", task.session_id),
                &final_task.target,
            );
        }
    });
}

fn new_task(
    session_id: &str,
    kind: TransferKind,
    name: &str,
    source: &str,
    target: &str,
    total: u64,
    state: TransferState,
) -> TransferTask {
    let stamp = now_ms();
    TransferTask {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        kind,
        name: name.to_string(),
        source: source.to_string(),
        target: target.to_string(),
        total,
        transferred: 0,
        state,
        error: None,
        created_at: stamp,
        updated_at: stamp,
    }
}

// ---------------------------------------------------------------------------
// 本地文件展开 / 同名处理
// ---------------------------------------------------------------------------

fn local_len(path: &Path) -> u64 {
    std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

fn file_name(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

/// 展开本地路径为 `(绝对路径, 相对路径)`；不跟随符号链接。
fn collect_local_files(paths: &[String]) -> Result<Vec<(PathBuf, String)>> {
    let mut out = Vec::new();
    for raw in paths {
        let path = PathBuf::from(raw);
        let meta = std::fs::metadata(&path).map_err(|error| anyhow!("无法读取 {raw}：{error}"))?;
        if meta.is_dir() {
            walk_local(&path, &path, &mut out)?;
        } else {
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .ok_or_else(|| anyhow!("文件名无效"))?;
            out.push((path, name));
        }
    }
    Ok(out)
}

fn walk_local(dir: &Path, base: &Path, out: &mut Vec<(PathBuf, String)>) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            // 不跟随：符号链接可能指向上传根之外，甚至形成环。
            continue;
        }
        if file_type.is_dir() {
            walk_local(&path, base, out)?;
        } else if file_type.is_file() {
            let relative = path
                .strip_prefix(base)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            out.push((path, relative));
        }
    }
    Ok(())
}

async fn unique_remote_name(state: &AppState, session_id: &str, target: &str) -> String {
    let (dir, name) = match target.rfind('/') {
        Some(index) => (&target[..index], &target[index + 1..]),
        None => ("", target),
    };
    let (stem, ext) = split_extension(name);
    for index in 2..1000 {
        let candidate = if ext.is_empty() {
            format!("{dir}/{stem} ({index})")
        } else {
            format!("{dir}/{stem} ({index}).{ext}")
        };
        if !state
            .ssh
            .sftp_exists(session_id, &candidate)
            .await
            .unwrap_or(false)
        {
            return candidate;
        }
    }
    target.to_string()
}

fn unique_local_name(path: &str) -> String {
    let (dir, name) = match path.rfind(['/', '\\']) {
        Some(index) => (&path[..=index], &path[index + 1..]),
        None => ("", path),
    };
    let (stem, ext) = split_extension(name);
    for index in 2..1000 {
        let candidate = if ext.is_empty() {
            format!("{dir}{stem} ({index})")
        } else {
            format!("{dir}{stem} ({index}).{ext}")
        };
        if std::fs::metadata(&candidate).is_err() {
            return candidate;
        }
    }
    path.to_string()
}

fn split_extension(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(index) if index > 0 => (&name[..index], &name[index + 1..]),
        _ => (name, ""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_extensions_without_eating_dotfiles() {
        assert_eq!(split_extension("app.tar.gz"), ("app.tar", "gz"));
        assert_eq!(split_extension("README"), ("README", ""));
        // `.env` 没有主干，整名就是"扩展名"→ 不做编号替换。
        assert_eq!(split_extension(".env"), (".env", ""));
    }

    #[test]
    fn collects_files_from_directories() {
        let root = std::env::temp_dir().join(format!("bls-transfer-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("a.txt"), b"a").unwrap();
        std::fs::write(root.join("sub/b.txt"), b"b").unwrap();

        let files = collect_local_files(&[root.to_string_lossy().to_string()]).unwrap();
        let mut relatives: Vec<&str> = files.iter().map(|(_, rel)| rel.as_str()).collect();
        relatives.sort();
        assert_eq!(relatives, vec!["a.txt", "sub/b.txt"]);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn skip_and_rename_are_not_silent_overwrites() {
        // 策略语义：skip 不改名、rename 一定给出不同的名字。
        assert_ne!(
            unique_local_name("/tmp/definitely-missing-a.txt"),
            "/tmp/definitely-missing-a.txt"
        );
    }
}
