//! 文件传输任务中心：上传 / 下载不再是一次调用干等到结束。
//!
//! 每个文件一个任务，任务表在内存里（重启即清空 —— 传输本身就是短生命周期
//! 动作，持久化只会留下一堆"永远 running"的僵尸记录）。
//!
//! 几条硬规则：
//! * **临时文件**：写 `<目标>.bls-part`，完成才原子改名。取消或失败会删掉
//!   临时文件，目标名要么是完整内容、要么根本不存在。
//! * **取消**：每个任务一个 `AtomicBool`，分块循环里检查；已取消的任务不会
//!   被标记成失败（错误信息会误导人）。运行中的取消只会把状态推进到
//!   `cancelling`，**最终是 cancelled 还是 completed 由执行器决定** —— 用户点了
//!   取消，但传输可能刚好已经改名完成，那它确实是完成了。
//! * **重试**：只有 failed / cancelled 可以重试；重置与重新入队在同一把锁里
//!   完成，连点两次只会有一次真正启动。
//! * **同名策略**：`overwrite` / `skip` / `rename`。默认走 `rename`，不静默
//!   覆盖别人的文件。
//!
//! 进度事件按**时间**节流（[`PROGRESS_INTERVAL`]），不是按字节：慢速链路上
//! 字节步长会让界面几秒不动，而快速链路上每几 MB 一条又会刷爆事件通道。
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::Semaphore;

use crate::state::AppState;

/// 任务状态变化事件；payload 是完整的 [`TransferTask`]，前端按
/// `(id, attempt, revision)` 合并 —— 迟到的旧快照绝不能把进度改回去。
pub const TRANSFER_EVENT: &str = "transfer-progress";
/// 同时进行的任务数。上传下载都吃带宽，再多只会互相拖慢。
const MAX_CONCURRENT: usize = 2;
/// 进度事件的最小时间间隔。约 4 次/秒：肉眼连续，又不至于把事件通道刷爆。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

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
    /// 字节已经传完，正在关闭句柄 / 原子改名。**还没成功**。
    Finalizing,
    Completed,
    Failed,
    Cancelled,
    /// 已请求取消，等执行器给出最终结果（cancelled 或 completed）。
    Cancelling,
    /// 同名且策略为 skip：没有传输，但也不是错误。
    Skipped,
}

impl TransferState {
    /// 还占着并发名额 / 还需要展示进度的状态。
    fn is_active(self) -> bool {
        matches!(
            self,
            TransferState::Queued
                | TransferState::Running
                | TransferState::Finalizing
                | TransferState::Cancelling
        )
    }

    /// 可以重新传输的状态。成功 / 跳过没有"重试"语义。
    fn is_retryable(self) -> bool {
        matches!(self, TransferState::Failed | TransferState::Cancelled)
    }

    /// 终态：同一轮尝试内不能再回到进行中。
    fn is_terminal(self) -> bool {
        !self.is_active()
    }
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
    /// 总大小是否已知（**空文件是"已知的 0"**，不能和"未知"混为一谈：
    /// 未知要显示不定进度，空文件应该直接完成）。
    pub size_known: bool,
    pub state: TransferState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 同一批次（一次多文件上传）共用一个批次号，界面据此折叠成摘要。
    pub batch_id: String,
    /// 第几次尝试，重试 +1。新一轮可以从零开始，旧一轮的进度事件不再生效。
    pub attempt: u32,
    /// 单调递增的版本号（每次写入 +1）。前端用它丢弃迟到的旧快照。
    pub revision: u64,
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

    fn insert(&self, task: TransferTask) {
        self.tasks.lock().unwrap().push(task);
    }

    /// 唯一的状态写入点：**每次都递增 `revision`**，前端据此丢弃迟到的快照。
    fn touch(&self, id: &str, update: impl FnOnce(&mut TransferTask)) -> Option<TransferTask> {
        let mut tasks = self.tasks.lock().unwrap();
        let task = tasks.iter_mut().find(|task| task.id == id)?;
        update(task);
        task.updated_at = now_ms();
        task.revision += 1;
        Some(task.clone())
    }

    fn cancel_flag(&self, id: &str) -> Arc<AtomicBool> {
        let mut cancels = self.cancels.lock().unwrap();
        cancels
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    /// 取消。
    ///
    /// * 排队中：还没有执行器在动它，直接落 `cancelled`（没有临时文件要清）。
    /// * 运行中 / 收尾中：只推进到 `cancelling` 并置位取消标志，**终态由执行器
    ///   写**。这样不会出现"界面说已取消，服务器上其实已经传完"的错觉。
    /// * 已结束：原样返回（重复点击是幂等的）。
    pub fn cancel(&self, id: &str) -> Option<TransferTask> {
        let updated = self.touch(id, |task| match task.state {
            TransferState::Queued => {
                task.state = TransferState::Cancelled;
                task.error = Some("已取消".to_string());
            }
            TransferState::Running | TransferState::Finalizing => {
                task.state = TransferState::Cancelling;
                task.error = None;
            }
            _ => {}
        });

        // 排队中的也要置位：它的执行器可能已经在等并发名额，拿到名额后
        // 必须先看到取消再做任何远端动作。
        let should_flag = updated
            .as_ref()
            .map(|task| {
                matches!(
                    task.state,
                    TransferState::Cancelled | TransferState::Cancelling
                )
            })
            .unwrap_or(false);
        if should_flag {
            if let Some(flag) = self.cancels.lock().unwrap().get(id) {
                flag.store(true, Ordering::Relaxed);
            }
        }
        updated
    }

    /// 重试：**在同一次加锁里**校验状态 + 重置 + 递增尝试号。
    ///
    /// 连点两次时，第二次看到的是 `queued`（第一次刚重置），直接报错返回，
    /// 绝不会启动第二个执行器。
    fn begin_retry(&self, id: &str) -> Result<TransferTask> {
        let task = {
            let mut tasks = self.tasks.lock().unwrap();
            let task = tasks
                .iter_mut()
                .find(|task| task.id == id)
                .ok_or_else(|| anyhow!("任务不存在"))?;
            if !task.state.is_terminal() {
                return Err(anyhow!("这个任务还在传输中，不能重复启动"));
            }
            if !task.state.is_retryable() {
                return Err(anyhow!("只有失败或已取消的任务可以重试"));
            }
            task.state = TransferState::Queued;
            task.transferred = 0;
            task.error = None;
            task.attempt += 1;
            task.updated_at = now_ms();
            task.revision += 1;
            task.clone()
        };
        if let Some(flag) = self.cancels.lock().unwrap().get(id) {
            flag.store(false, Ordering::Relaxed);
        }
        Ok(task)
    }

    /// 清理已结束的任务，返回移除条数。
    fn clear_finished(&self) -> usize {
        let mut tasks = self.tasks.lock().unwrap();
        let before = tasks.len();
        tasks.retain(|task| task.state.is_active());
        before - tasks.len()
    }
}

/// 进度事件的节流器：第一次调用放行，之后每 [`PROGRESS_INTERVAL`] 一次。
///
/// 用 `Mutex<Option<Instant>>` 而不是"上一次时间戳"：进程刚启动时不存在一个
/// 可以安全相减的基准。
#[derive(Default)]
struct ProgressPacer {
    last: Mutex<Option<Instant>>,
}

impl ProgressPacer {
    fn new() -> Self {
        Self {
            last: Mutex::new(None),
        }
    }

    fn allow(&self) -> bool {
        let now = Instant::now();
        let mut last = self.last.lock().unwrap();
        match *last {
            Some(previous) if now.duration_since(previous) < PROGRESS_INTERVAL => false,
            _ => {
                *last = Some(now);
                true
            }
        }
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
    // 同一次多文件上传共用一个批次号：界面据此折叠成「已完成 8 / 12」。
    let batch_id = uuid::Uuid::new_v4().to_string();
    let mut created = Vec::new();

    for (local, relative) in files {
        let name = local
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .ok_or_else(|| anyhow!("文件名无效"))?;
        let size = local_size(&local);
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
                        &batch_id,
                        TransferKind::Upload,
                        &name,
                        &local.to_string_lossy(),
                        &target,
                        size,
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
            &batch_id,
            TransferKind::Upload,
            &name,
            &local.to_string_lossy(),
            &target,
            size,
            TransferState::Queued,
        );
        state.transfers.insert(task.clone());
        emit(app, &task);
        spawn_task(state.clone(), app.clone(), task.clone());
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
    // 总大小在入队时就查一次：进度条从第一帧起就有确定的分母，
    // 查不到（权限 / 服务器不报）则保持"未知"，界面显示不定进度。
    let remote_size = state
        .ssh
        .sftp_stat(&session_id, &remote_path)
        .await
        .ok()
        .map(|entry| entry.size);
    let batch_id = uuid::Uuid::new_v4().to_string();
    let mut target = local_path.clone();
    if std::fs::metadata(&target).is_ok() {
        match conflict {
            ConflictPolicy::Skip => {
                let task = new_task(
                    &session_id,
                    &batch_id,
                    TransferKind::Download,
                    &file_name(&remote_path),
                    &remote_path,
                    &target,
                    remote_size,
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
        &batch_id,
        TransferKind::Download,
        &file_name(&remote_path),
        &remote_path,
        &target,
        remote_size,
        TransferState::Queued,
    );
    state.transfers.insert(task.clone());
    emit(app, &task);
    spawn_task(state.clone(), app.clone(), task.clone());
    Ok(task)
}

/// 重试一个已结束（失败 / 取消）的任务。
///
/// 只重置状态并重新入队；真正的启动在 [`spawn_task`]。目标路径沿用原任务的
/// 结果（`rename` 策略当时算出的名字），不会在重试时再换一次名。
pub fn retry(state: &AppState, app: &AppHandle, id: &str) -> Result<TransferTask> {
    let task = state.transfers.begin_retry(id)?;
    emit(app, &task);
    spawn_task(state.clone(), app.clone(), task.clone());
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

fn spawn_task(state: AppState, app: AppHandle, task: TransferTask) {
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
        // 排队期间被取消的任务已经是终态，这里直接退出 —— 终态只能由
        // cancel() 写，不能被这里的 running 覆盖。
        if running.state != TransferState::Running {
            return;
        }
        emit(&app, &running);

        let cancel = state.transfers.cancel_flag(&task.id);
        // 本地路径由任务自身决定：上传读 source，下载写 target。以前靠调用方
        // 传参，下载重试时会把**远程路径**当成本地目标。
        let local = match task.kind {
            TransferKind::Upload => PathBuf::from(&task.source),
            TransferKind::Download => PathBuf::from(&task.target),
        };

        let progress_state = state.clone();
        let progress_app = app.clone();
        let progress_id = task.id.clone();
        let pacer = ProgressPacer::new();
        let on_progress = move |done: u64, total: u64| {
            // 字节数**每次都写进任务**（快照必须准确），事件按时间节流。
            let Some(updated) = progress_state.transfers.touch(&progress_id, |item| {
                item.transferred = item.transferred.max(done);
                if total > 0 {
                    item.total = total;
                    item.size_known = true;
                }
            }) else {
                return;
            };
            if pacer.allow() {
                emit(&progress_app, &updated);
            }
        };

        let finishing_state = state.clone();
        let finishing_app = app.clone();
        let finishing_id = task.id.clone();
        let on_finishing = move |done: u64| {
            // 字节写完但还没改名：状态切到 finalizing，界面显示「正在完成」。
            // 已经在 cancelling 的不要改回 finalizing（终态仍归执行器）。
            let Some(updated) = finishing_state.transfers.touch(&finishing_id, |item| {
                item.transferred = item.transferred.max(done);
                if item.state == TransferState::Running {
                    item.state = TransferState::Finalizing;
                }
            }) else {
                return;
            };
            emit(&finishing_app, &updated);
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
                        &on_finishing,
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
                        &on_finishing,
                    )
                    .await
            }
        };

        let cancelled = cancel.load(Ordering::Relaxed);
        let Some(final_task) = state.transfers.touch(&task.id, |item| match &result {
            Ok(bytes) => {
                // 成功：这是文件已经在目标名下的唯一时刻。
                item.transferred = *bytes;
                if !item.size_known {
                    item.total = *bytes;
                    item.size_known = true;
                }
                item.state = TransferState::Completed;
                item.error = None;
            }
            Err(error) => {
                // 取消标志只在传输真的因为取消而中止时才决定终态：用户点取消
                // 的同时传输已经完成，结果仍是 completed（上面那个分支）。
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
            // 落地后让文件面板刷新（沿用既有的事件约定）。
            let _ = app.emit(
                &format!("sftp-changed-{}", task.session_id),
                &final_task.target,
            );
        }
    });
}

#[allow(clippy::too_many_arguments)]
fn new_task(
    session_id: &str,
    batch_id: &str,
    kind: TransferKind,
    name: &str,
    source: &str,
    target: &str,
    total: Option<u64>,
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
        total: total.unwrap_or(0),
        transferred: 0,
        size_known: total.is_some(),
        state,
        error: None,
        batch_id: batch_id.to_string(),
        attempt: 1,
        revision: 1,
        created_at: stamp,
        updated_at: stamp,
    }
}

// ---------------------------------------------------------------------------
// 本地文件展开 / 同名处理
// ---------------------------------------------------------------------------

/// 本地文件大小；读不到元数据就是 `None`（界面显示"大小未知"）。
fn local_size(path: &Path) -> Option<u64> {
    std::fs::metadata(path).map(|meta| meta.len()).ok()
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

    fn task(state: TransferState) -> TransferTask {
        new_task(
            "s1",
            "batch-1",
            TransferKind::Upload,
            "a.txt",
            "/tmp/a.txt",
            "/var/www/a.txt",
            Some(1024),
            state,
        )
    }

    #[test]
    fn splits_extensions_without_eating_dotfiles() {
        assert_eq!(split_extension("app.tar.gz"), ("app.tar", "gz"));
        assert_eq!(split_extension("README"), ("README", ""));
        // `.env` 没有主干，整名就是"扩展名"→ 不做编号替换。
        assert_eq!(split_extension(".env"), (".env", ""));
    }

    #[test]
    fn empty_file_is_known_size_not_unknown() {
        let empty = new_task(
            "s1",
            "b",
            TransferKind::Upload,
            "empty.log",
            "/tmp/empty.log",
            "/var/www/empty.log",
            Some(0),
            TransferState::Queued,
        );
        assert!(empty.size_known);
        assert_eq!(empty.total, 0);

        let unknown = new_task(
            "s1",
            "b",
            TransferKind::Upload,
            "x",
            "/tmp/x",
            "/var/www/x",
            None,
            TransferState::Queued,
        );
        assert!(!unknown.size_known);
    }

    #[test]
    fn retry_refuses_active_and_finished_tasks() {
        let center = TransferCenter::new();

        let queued = task(TransferState::Queued);
        let queued_id = queued.id.clone();
        center.insert(queued);
        assert!(center.begin_retry(&queued_id).is_err());

        let completed = task(TransferState::Completed);
        let completed_id = completed.id.clone();
        center.insert(completed);
        assert!(center.begin_retry(&completed_id).is_err());
    }

    #[test]
    fn retry_starts_exactly_once_from_failed() {
        let center = TransferCenter::new();
        let failed = task(TransferState::Failed);
        let id = failed.id.clone();
        center.insert(failed);

        let retried = center.begin_retry(&id).unwrap();
        assert_eq!(retried.state, TransferState::Queued);
        assert_eq!(retried.attempt, 2);
        assert_eq!(retried.transferred, 0);

        // 连点第二次：第一次已经把状态推进到 queued，这里必须拒绝。
        assert!(center.begin_retry(&id).is_err());
        assert_eq!(center.list()[0].attempt, 2);
    }

    #[test]
    fn cancel_finalises_queued_but_waits_for_the_executor_when_running() {
        let center = TransferCenter::new();
        let queued = task(TransferState::Queued);
        let queued_id = queued.id.clone();
        center.insert(queued);
        assert_eq!(
            center.cancel(&queued_id).unwrap().state,
            TransferState::Cancelled
        );

        let running = task(TransferState::Running);
        let running_id = running.id.clone();
        center.insert(running);
        let cancelling = center.cancel(&running_id).unwrap();
        assert_eq!(cancelling.state, TransferState::Cancelling);
        // 传输刚好在此刻完成：执行器写的终态优先。
        let done = center
            .touch(&running_id, |item| item.state = TransferState::Completed)
            .unwrap();
        assert_eq!(done.state, TransferState::Completed);
    }

    #[test]
    fn clear_finished_keeps_every_active_state() {
        let center = TransferCenter::new();
        for state in [
            TransferState::Queued,
            TransferState::Running,
            TransferState::Finalizing,
            TransferState::Cancelling,
            TransferState::Completed,
            TransferState::Failed,
            TransferState::Cancelled,
            TransferState::Skipped,
        ] {
            center.insert(task(state));
        }
        assert_eq!(center.clear_finished(), 4);
        assert_eq!(center.list().len(), 4);
    }

    #[test]
    fn revision_increases_on_every_write() {
        let center = TransferCenter::new();
        let queued = task(TransferState::Queued);
        let id = queued.id.clone();
        center.insert(queued);
        let first = center.touch(&id, |item| item.transferred = 10).unwrap();
        let second = center.touch(&id, |item| item.transferred = 20).unwrap();
        assert!(second.revision > first.revision);
        assert!(second.updated_at >= first.updated_at);
    }

    #[test]
    fn progress_pacer_allows_first_then_throttles() {
        let pacer = ProgressPacer::new();
        assert!(pacer.allow());
        assert!(!pacer.allow());
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
