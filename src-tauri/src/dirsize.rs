//! On-demand directory size calculation.
//!
//! SFTP only reports a directory's own metadata size (commonly 4096 B), never
//! the total of its contents — so a file browser that lists folders next to
//! files cannot show how big a folder is without actually walking it. The file
//! panel triggers a scan for every visible subdirectory each time it lists a
//! folder (自动计算，无手动按钮)；本模块对此的唯一保护是每会话最多
//! [`MAX_CONCURRENT_SCANS`] 个并发扫描、超时与取消信号。
//!
//! Strategy, best first:
//! 1. `du` when the remote has it — GNU `du -sb` (bytes) or BusyBox/BSD
//!    `du -sk` (KB, ×1024). One process, the server does the walking.
//! 2. SFTP recursive walk as a fallback (no `du`, or `du` failed). Slower, but
//!    it streams progress and honours a cancel signal at every step.
//!
//! Either way the result is cached by `session_id + path` so re-entering the
//! directory replays the cached numbers instead of recomputing them.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use serde::Serialize;
use tokio::sync::{watch, Semaphore};

use crate::ssh::{self, SshSessionManager};

/// 每个 SSH 会话同时允许的 `du` / SFTP 遍历数量。
///
/// 真正的并发上限必须在后端：`directory_size_start` 只是"启动后台任务并立刻
/// 返回"，前端队列再怎么节流也只能控制 IPC 调用速度，控制不了后台扫描。没有
/// 这道闸，一次"计算全部"就会在同一条 SSH 连接上同时跑几十个 `du`。
pub const MAX_CONCURRENT_SCANS: usize = 2;

/// 单次批量状态查询（watchdog 兜底）允许的路径上限。
///
/// 面板一屏可见的文件夹远少于这个数；上限只是防御性约束，防止调用方误把
/// 全目录树塞进一次 IPC。
pub const MAX_STATUS_BATCH: usize = 20;

/// Pushed to the frontend as a computation progresses. The command layer owns
/// the `tauri::AppHandle` and turns this into a Tauri event; keeping that here
/// would drag `tauri`'s native loader into every test binary, so we only take a
/// plain closure.
pub type EmitFn = Arc<dyn Fn(DirectorySizeResult) + Send + Sync>;

/// Event name pushed to the frontend as a calculation progresses.
pub const DIR_SIZE_EVENT: &str = "directory-size-update";

/// Lifecycle of a single directory-size computation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DirectorySizeStatus {
    /// Queued, work has not started yet.
    Pending,
    /// Walking the tree / running `du`.
    Computing,
    /// Finished, all entries were summed.
    Completed,
    /// Finished, but some entries were skipped (permission denied, etc.).
    Partial,
    /// Could not read the directory at all (permission denied at the root).
    PermissionDenied,
    /// The user cancelled before completion.
    Cancelled,
    /// The computation timed out.
    TimedOut,
    /// The session went away mid-computation.
    SessionGone,
    /// `du` and SFTP both failed to produce a number.
    Failed,
}

impl DirectorySizeStatus {
    /// 终态判定：`complete` 标志的权威来源。completed / partial /
    /// permission_denied / cancelled / timed_out / session_gone / failed 都是
    /// 终点；只有 pending（排队）与 computing（计算中）不是。
    pub fn is_terminal(self) -> bool {
        !matches!(
            self,
            DirectorySizeStatus::Pending | DirectorySizeStatus::Computing
        )
    }
}

/// Result of a directory-size computation, pushed over [`DIR_SIZE_EVENT`] and
/// returned by [`crate::commands::directory_size_status`].
///
/// 序列化契约（勿改）：前端 `src/api/types/sftp.ts` 的 `DirectorySizeResult`
/// 全部字段是 camelCase，本结构是命令返回值与事件的**同一份**载荷，必须
/// `rename_all = "camelCase"`。`DirectorySizeStatus` 枚举值保持 snake_case
/// （`permission_denied` 等），与前端 `DirectorySizeStatus` 联合类型一致。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySizeResult {
    pub session_id: String,
    pub path: String,
    /// Total bytes of regular files under `path` (excluding symlink targets).
    pub size_bytes: u64,
    pub file_count: u64,
    pub directory_count: u64,
    /// Entries skipped because of an error (permission denied, unreadable, …).
    pub skipped_count: u64,
    pub status: DirectorySizeStatus,
    /// `true` once the computation has reached a terminal state.
    pub complete: bool,
    pub calculated_at: u64,
}

impl DirectorySizeResult {
    fn now() -> u64 {
        UNIX_EPOCH
            .elapsed()
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0)
    }

    /// 已排队，正在等同一会话的并发名额（前端显示"排队中"）。
    fn pending(session_id: &str, path: &str) -> Self {
        DirectorySizeResult {
            session_id: session_id.to_string(),
            path: path.to_string(),
            size_bytes: 0,
            file_count: 0,
            directory_count: 0,
            skipped_count: 0,
            status: DirectorySizeStatus::Pending,
            complete: false,
            calculated_at: Self::now(),
        }
    }

    fn computing(session_id: &str, path: &str) -> Self {
        DirectorySizeResult {
            session_id: session_id.to_string(),
            path: path.to_string(),
            size_bytes: 0,
            file_count: 0,
            directory_count: 0,
            skipped_count: 0,
            status: DirectorySizeStatus::Computing,
            complete: false,
            calculated_at: Self::now(),
        }
    }

    fn terminal(mut self, status: DirectorySizeStatus) -> Self {
        self.status = status;
        self.complete = status.is_terminal();
        self.calculated_at = Self::now();
        self
    }
}

/// Which `du` dialect the remote server speaks, detected once per session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DuFlavor {
    /// GNU coreutils: `du -sb` prints bytes.
    Bytes,
    /// BusyBox / BSD: `du -sk` prints 1024-byte blocks.
    Kibibytes,
}

/// Outcome of one `du` invocation.
///
/// 必须把"取消"和"`du` 不可用"分开：前者不能再回退到 SFTP（用户已经叫停了），
/// 后者才需要走递归遍历。
enum DuRun {
    /// `du` 给出了可用的结论（completed / partial / permission_denied）。
    Done(DirectorySizeResult),
    /// 用户取消了：结果作废，直接报 cancelled。
    Cancelled(DirectorySizeResult),
    /// `du` 没有产出可用数字，回退到 SFTP 递归。
    Unavailable,
}

/// Resolves as soon as `cancel` flips to `true`; also resolves (rather than
/// hanging) if the sender is dropped, letting the caller re-check the flag.
async fn wait_cancel(cancel: &watch::Receiver<bool>) {
    let mut rx = cancel.clone();
    loop {
        if *rx.borrow() {
            return;
        }
        if rx.changed().await.is_err() {
            return;
        }
    }
}

/// One in-flight (or finished) computation.
struct DirectorySizeTask {
    cancel: watch::Sender<bool>,
    state: Mutex<DirectorySizeResult>,
}

impl DirectorySizeTask {
    fn snapshot(&self) -> DirectorySizeResult {
        self.state.lock().unwrap().clone()
    }

    fn update(&self, emit: &Option<EmitFn>, next: DirectorySizeResult) {
        *self.state.lock().unwrap() = next.clone();
        // A fire-and-forget emit is fine: the worst case is a dropped event
        // for a transient state, and the terminal event is also replayable via
        // `directory_size_status`. When no emitter is available (tests) we skip
        // it but still cache the result.
        if let Some(emit) = emit {
            emit(next);
        }
    }
}

/// Per-session directory-size state: in-flight tasks (one per path), the
/// cached `du` flavour probe, and the per-session concurrency gate.
#[derive(Default)]
pub struct DirectorySizeRegistry {
    tasks: Mutex<HashMap<(String, String), Arc<DirectorySizeTask>>>,
    du_flavor: Mutex<HashMap<String, Option<DuFlavor>>>,
    /// 每个会话一个信号量：同时最多 [`MAX_CONCURRENT_SCANS`] 个后台扫描。
    /// 会话断开时随 `forget_session` 一起丢弃。
    gates: Mutex<HashMap<String, Arc<Semaphore>>>,
    /// Emit closure, stashed on first `start`, used to push updates to the
    /// frontend. `None` only in tests, where the result is still cached.
    emit: Mutex<Option<EmitFn>>,
}

impl DirectorySizeRegistry {
    pub fn forget_session(&self, session_id: &str) {
        let tasks = self.tasks.lock().unwrap();
        for ((sid, _), task) in tasks.iter() {
            if sid == session_id {
                let _ = task.cancel.send(true);
            }
        }
        drop(tasks);
        self.tasks
            .lock()
            .unwrap()
            .retain(|(sid, _), _| sid != session_id);
        self.du_flavor.lock().unwrap().remove(session_id);
        // 丢弃旧信号量：仍在等待的任务会因取消信号退出，之后新会话拿到全新的闸。
        self.gates.lock().unwrap().remove(session_id);
    }

    /// The session's concurrency gate, created on first use.
    fn gate(&self, session_id: &str) -> Arc<Semaphore> {
        self.gates
            .lock()
            .unwrap()
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Semaphore::new(MAX_CONCURRENT_SCANS)))
            .clone()
    }

    /// Returns the cached result if a computation already finished for this
    /// path, or `None` if it is still running / never started.
    pub fn cached(&self, session_id: &str, path: &str) -> Option<DirectorySizeResult> {
        let tasks = self.tasks.lock().unwrap();
        tasks
            .get(&(session_id.to_string(), path.to_string()))
            .map(|task| task.snapshot())
            .filter(|result| result.complete)
    }

    /// Starts computing the size of `path` in the background and pushes
    /// updates through `emit` (the command layer turns each into a Tauri
    /// event). A second call for the same `session_id + path` replays the
    /// current (possibly finished) state instead of launching a duplicate
    /// task. `emit` may be `None` (tests), in which case the result is still
    /// cached but nothing is pushed.
    pub fn start(
        self: &Arc<Self>,
        emit: Option<EmitFn>,
        manager: Arc<SshSessionManager>,
        session_id: String,
        path: String,
        timeout: Duration,
        force: bool,
    ) -> DirectorySizeResult {
        let key = (session_id.clone(), path.clone());
        if force {
            if let Some(existing) = self.tasks.lock().unwrap().remove(&key) {
                let _ = existing.cancel.send(true);
            }
        } else {
            let tasks = self.tasks.lock().unwrap();
            if let Some(existing) = tasks.get(&key) {
                if let Some(emit) = &emit {
                    emit(existing.snapshot());
                }
                return existing.snapshot();
            }
        }

        let (cancel_tx, cancel_rx) = watch::channel(false);
        let task = Arc::new(DirectorySizeTask {
            cancel: cancel_tx,
            // 新任务一律从 `pending` 开始：拿到并发名额后才会变成 `computing`。
            state: Mutex::new(DirectorySizeResult::pending(&session_id, &path)),
        });
        self.tasks.lock().unwrap().insert(key, task.clone());
        let initial = task.snapshot();
        if let Some(emit) = &emit {
            emit(initial.clone());
        }

        let registry = Arc::clone(self);
        registry.set_emit(emit.clone());
        tauri::async_runtime::spawn(async move {
            let task_handle = Arc::clone(&task);
            let result = async {
                // 等名额期间也响应取消：排队中的任务不该占着位置。
                if *cancel_rx.borrow() {
                    return DirectorySizeResult::pending(&session_id, &path)
                        .terminal(DirectorySizeStatus::Cancelled);
                }
                let gate = registry.gate(&session_id);
                let permit = tokio::select! {
                    acquired = gate.acquire_owned() => match acquired {
                        Ok(permit) => permit,
                        Err(_) => return DirectorySizeResult::pending(&session_id, &path)
                            .terminal(DirectorySizeStatus::Failed),
                    },
                    _ = wait_cancel(&cancel_rx) => {
                        return DirectorySizeResult::pending(&session_id, &path)
                            .terminal(DirectorySizeStatus::Cancelled);
                    }
                };
                if *cancel_rx.borrow() {
                    drop(permit);
                    return DirectorySizeResult::pending(&session_id, &path)
                        .terminal(DirectorySizeStatus::Cancelled);
                }
                // 拿到名额 → 真的在算了。
                task.update(
                    &registry.emit_fn(),
                    DirectorySizeResult::computing(&session_id, &path),
                );
                let flavor = registry.detect_flavor(&manager, &session_id).await;
                let outcome = registry
                    .compute(&manager, &session_id, &path, flavor, timeout, &cancel_rx)
                    .await;
                // 计算/失败/取消后释放名额，等着的下一个任务才能进来。
                drop(permit);
                outcome
            }
            .await;
            task_handle.update(&registry.emit_fn(), result);
            // Leave the finished task in the map so `cached`/`status` can replay
            // it; it is only evicted when the session is forgotten.
        });
        initial
    }

    /// Asks a running computation to stop. The task decides how to honour it
    /// (the SFTP walk checks the signal each step; a single `du` invocation is
    /// dropped on arrival once cancelled).
    pub fn cancel(&self, session_id: &str, path: &str) {
        if let Some(task) = self
            .tasks
            .lock()
            .unwrap()
            .get(&(session_id.to_string(), path.to_string()))
        {
            let _ = task.cancel.send(true);
        }
    }

    /// Snapshot of the current (or last) computation for a path.
    pub fn status(&self, session_id: &str, path: &str) -> Option<DirectorySizeResult> {
        self.tasks
            .lock()
            .unwrap()
            .get(&(session_id.to_string(), path.to_string()))
            .map(|task| task.snapshot())
    }

    /// Batched read-only snapshot for the file panel's low-frequency watchdog
    /// (the event stream stays the primary update channel; this only recovers
    /// lost events).
    ///
    /// 只读取 registry 已有状态：绝不启动新任务、不做 SFTP 递归、不阻塞 SSH。
    /// 最多 [`MAX_STATUS_BATCH`] 条（超出整体拒绝）、去重、拒绝空路径。
    /// 没有对应任务的路径直接不出现（前端不会为它写入缓存）。
    pub fn status_many(
        &self,
        session_id: &str,
        paths: &[String],
    ) -> Result<Vec<DirectorySizeResult>, String> {
        if paths.len() > MAX_STATUS_BATCH {
            return Err(format!(
                "directory_size_status_many accepts at most {MAX_STATUS_BATCH} paths per call"
            ));
        }
        let mut seen = HashSet::new();
        let tasks = self.tasks.lock().unwrap();
        let mut results = Vec::new();
        for path in paths {
            if path.trim().is_empty() {
                return Err("directory_size_status_many rejects empty paths".to_string());
            }
            if !seen.insert(path.as_str()) {
                continue;
            }
            if let Some(task) = tasks.get(&(session_id.to_string(), path.to_string())) {
                results.push(task.snapshot());
            }
        }
        Ok(results)
    }

    /// Detects the remote `du` flavour once per session, caching the outcome
    /// (including "none"). The probe is one cheap `du --version` (GNU only) and
    /// a small-file `du -sb` smoke test that tolerates a non-zero exit.
    async fn detect_flavor(
        &self,
        manager: &SshSessionManager,
        session_id: &str,
    ) -> Option<DuFlavor> {
        if let Some(cached) = self.du_flavor.lock().unwrap().get(session_id).copied() {
            return cached;
        }
        // GNU prints its version; BusyBox/BSD answer with a usage line to
        // `--version` (or error), so the presence of a version line is a
        // reliable "supports -b" signal. We still validate with a real run.
        let gnu = manager
            .exec(
                session_id,
                "du --version 2>&1 | head -n1",
                Duration::from_secs(5),
            )
            .await
            .map(|out| out.stdout.contains("GNU coreutils"))
            .unwrap_or(false);

        let flavor = if gnu {
            Some(DuFlavor::Bytes)
        } else {
            // BusyBox / BSD: try the byte form anyway (some build it), then KB.
            match manager
                .exec(
                    session_id,
                    "du -sb -- /etc/hostname 2>/dev/null | head -n1",
                    Duration::from_secs(5),
                )
                .await
            {
                Ok(out) if parse_du_bytes(&out.stdout).is_some() => Some(DuFlavor::Bytes),
                _ => Some(DuFlavor::Kibibytes),
            }
        };

        self.du_flavor
            .lock()
            .unwrap()
            .insert(session_id.to_string(), flavor);
        flavor
    }

    /// Runs the actual computation: prefer `du`, fall back to SFTP recursion.
    async fn compute(
        &self,
        manager: &SshSessionManager,
        session_id: &str,
        path: &str,
        flavor: Option<DuFlavor>,
        timeout: Duration,
        cancel: &watch::Receiver<bool>,
    ) -> DirectorySizeResult {
        // Try `du` first.
        if let Some(flavor) = flavor {
            match self
                .compute_du(manager, session_id, path, flavor, timeout, cancel)
                .await
            {
                // 拿到数字（completed / partial / permission_denied）或明确取消，
                // 都不再回退到 SFTP。
                DuRun::Done(result) | DuRun::Cancelled(result) => return result,
                DuRun::Unavailable => { /* fall through to SFTP */ }
            }
        }

        if *cancel.borrow() {
            return DirectorySizeResult::computing(session_id, path)
                .terminal(DirectorySizeStatus::Cancelled);
        }

        // SFTP recursive fallback.
        match self
            .compute_sftp(manager, session_id, path, timeout, cancel)
            .await
        {
            Ok(result) => result,
            Err(status) => {
                // 失败/取消/超时/根目录读不到：不留下任何"看起来算完了"的数字。
                let mut base = DirectorySizeResult::computing(session_id, path);
                base.size_bytes = 0;
                base.terminal(status)
            }
        }
    }

    fn emit_fn(&self) -> Option<EmitFn> {
        self.emit.lock().unwrap().clone()
    }

    /// Stash the emit closure (if any) so in-task updates can reach the
    /// frontend. Set once; never overwritten.
    fn set_emit(&self, emit: Option<EmitFn>) {
        let mut guard = self.emit.lock().unwrap();
        if guard.is_none() {
            *guard = emit;
        }
    }

    /// Runs `du` and parses the single summary line.
    ///
    /// `du` 是一次性的 exec，中途无法被打断，因此取消只在**前后**检查：
    /// 开始前已取消就直接返回 `Cancelled`；运行结束后若已被取消，则**丢弃
    /// 结果**并返回 `Cancelled`（绝不能报 completed）。
    async fn compute_du(
        &self,
        manager: &SshSessionManager,
        session_id: &str,
        path: &str,
        flavor: DuFlavor,
        timeout: Duration,
        cancel: &watch::Receiver<bool>,
    ) -> DuRun {
        if *cancel.borrow() {
            return DuRun::Cancelled(
                DirectorySizeResult::computing(session_id, path)
                    .terminal(DirectorySizeStatus::Cancelled),
            );
        }
        let cmd = match flavor {
            DuFlavor::Bytes => format!("du -sb -- {}", shell_quote(path)),
            DuFlavor::Kibibytes => format!("du -sk -- {}", shell_quote(path)),
        };
        let output = match manager.exec(session_id, &cmd, timeout).await {
            Ok(output) => output,
            Err(_) => return DuRun::Unavailable,
        };
        // 取消信号可能在 `du` 运行期间到达：此时结果已经没有意义，必须丢掉。
        if *cancel.borrow() {
            return DuRun::Cancelled(
                DirectorySizeResult::computing(session_id, path)
                    .terminal(DirectorySizeStatus::Cancelled),
            );
        }
        // `du` 遇到读不到的子目录会往 stderr 写警告（GNU 仍然退出 0），所以
        // "有数字"不等于"算全了"。
        let (size_bytes, _line) = match flavor {
            DuFlavor::Bytes => match parse_du_bytes(&output.stdout) {
                Some(parsed) => parsed,
                None => return DuRun::Unavailable,
            },
            DuFlavor::Kibibytes => match parse_du_kibibytes(&output.stdout) {
                Some(parsed) => parsed,
                None => return DuRun::Unavailable,
            },
        };
        // stderr 里一行就是一处没读到的目录 —— 这是"跳过了多少"的估计值。
        let skipped = output
            .stderr
            .lines()
            .filter(|line| !line.trim().is_empty())
            .count() as u64;

        let mut result = DirectorySizeResult::computing(session_id, path);
        result.size_bytes = size_bytes;
        result.skipped_count = skipped;
        DuRun::Done(result.terminal(classify_du(
            size_bytes,
            skipped,
            matches!(output.exit_code, Some(0)),
        )))
    }

    /// Recursive SFTP walk with cancellation and no symlink following.
    async fn compute_sftp(
        &self,
        manager: &SshSessionManager,
        session_id: &str,
        path: &str,
        timeout: Duration,
        cancel: &watch::Receiver<bool>,
    ) -> Result<DirectorySizeResult, DirectorySizeStatus> {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut result = DirectorySizeResult::computing(session_id, path);
        match self
            .walk(manager, session_id, path, &mut result, &deadline, cancel)
            .await
        {
            Ok(()) => {
                let status = if result.skipped_count > 0 {
                    DirectorySizeStatus::Partial
                } else {
                    DirectorySizeStatus::Completed
                };
                Ok(result.terminal(status))
            }
            Err(status) => Err(status),
        }
    }

    /// Recursively sums regular-file sizes under `root`. Returns `Err` only on
    /// a hard stop (cancel / timeout / root unreadable); skipped children are
    /// accumulated into `result.skipped_count` and reported as `Partial`.
    #[allow(clippy::too_many_arguments)]
    async fn walk(
        &self,
        manager: &SshSessionManager,
        session_id: &str,
        root: &str,
        result: &mut DirectorySizeResult,
        deadline: &tokio::time::Instant,
        cancel: &watch::Receiver<bool>,
    ) -> Result<(), DirectorySizeStatus> {
        if *cancel.borrow() {
            return Err(DirectorySizeStatus::Cancelled);
        }
        if tokio::time::Instant::now() >= *deadline {
            return Err(DirectorySizeStatus::TimedOut);
        }

        let entries = match manager
            .sftp_list_dir(session_id, Some(root.to_string()))
            .await
        {
            Ok((_, entries)) => entries,
            Err(_) => return Err(DirectorySizeStatus::PermissionDenied),
        };

        for entry in entries {
            if *cancel.borrow() {
                return Err(DirectorySizeStatus::Cancelled);
            }
            if tokio::time::Instant::now() >= *deadline {
                return Err(DirectorySizeStatus::TimedOut);
            }
            match entry.kind.as_str() {
                ssh::KIND_DIRECTORY => {
                    let child = format!("{}/{}", root.trim_end_matches('/'), entry.name);
                    if let Err(status) =
                        Box::pin(self.walk(manager, session_id, &child, result, deadline, cancel))
                            .await
                    {
                        match status {
                            DirectorySizeStatus::Cancelled | DirectorySizeStatus::TimedOut => {
                                return Err(status)
                            }
                            // A child we cannot read does not abort the whole
                            // tree — it makes the result partial.
                            DirectorySizeStatus::PermissionDenied => result.skipped_count += 1,
                            _ => result.skipped_count += 1,
                        }
                    }
                }
                // Files and everything else funnel through `record_entry`,
                // which sums sizes, counts directories, and skips symlinks.
                _ => {
                    record_entry(result, &entry.kind, entry.size);
                }
            }
        }
        Ok(())
    }
}

/// Records one directory entry into the running total. Returns `true` when
/// the entry is a directory that must be recursed into (the SFTP fallback's
/// recursive walk relies on this). Symlinks are never followed and never add
/// to the byte total — they are tallied as skipped, matching `du`'s default
/// behaviour.
fn record_entry(result: &mut DirectorySizeResult, kind: &str, size: u64) -> bool {
    match kind {
        ssh::KIND_FILE => {
            result.size_bytes += size;
            result.file_count += 1;
            false
        }
        ssh::KIND_DIRECTORY => {
            result.directory_count += 1;
            true
        }
        _ => {
            // Symlinks and other special files: do not follow, do not sum.
            result.skipped_count += 1;
            false
        }
    }
}

/// Decides what one `du` run is worth.
///
/// `du` 遇到读不到的子目录时仍会退出 0 并给出合计，只是往 stderr 写警告 ——
/// 所以"有数字"不等于"算全了"：跳过任何条目都必须报 `partial`，一个字节都没
/// 读到又伴随报错才是 `permission_denied`。**绝不把不完整的结果报成 completed。**
fn classify_du(size_bytes: u64, skipped: u64, clean_exit: bool) -> DirectorySizeStatus {
    let degraded = skipped > 0 || !clean_exit;
    match (size_bytes, degraded) {
        // 空目录（真的一字节都没有、也没有报错）算完整。
        (0, false) => DirectorySizeStatus::Completed,
        // 一点都没读到，还报错了：是进不去，不是"空目录"。
        (0, true) => DirectorySizeStatus::PermissionDenied,
        (_, true) => DirectorySizeStatus::Partial,
        (_, false) => DirectorySizeStatus::Completed,
    }
}

/// Parses a `du -sb` line: `<bytes>\t<path>`.
fn parse_du_bytes(line: &str) -> Option<(u64, &str)> {
    let line = line.lines().next()?;
    let (num, rest) = line.split_once('\t')?;
    let bytes = num.trim().parse::<u64>().ok()?;
    Some((bytes, rest))
}

/// Parses a `du -sk` line: `<kb>\t<path>`, converting to bytes.
fn parse_du_kibibytes(line: &str) -> Option<(u64, &str)> {
    let line = line.lines().next()?;
    let (num, rest) = line.split_once('\t')?;
    let kb = num.trim().parse::<u64>().ok()?;
    Some((kb.saturating_mul(1024), rest))
}

/// Single-quotes a path for the shell, escaping any inner single quote.
fn shell_quote(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_gnu_du_bytes() {
        assert_eq!(
            parse_du_bytes("1234567\t/var/www/project\n"),
            Some((1234567, "/var/www/project"))
        );
        assert_eq!(parse_du_bytes("0\t/\n"), Some((0, "/")));
    }

    #[test]
    fn parses_busybox_du_kibibytes() {
        // 800 MiB → 819200 KiB → 838860800 bytes.
        assert_eq!(
            parse_du_kibibytes("819200\t/var/www/node_modules\n"),
            Some((838860800, "/var/www/node_modules"))
        );
    }

    #[test]
    fn du_parser_ignores_garbage() {
        assert_eq!(parse_du_bytes("not a number\tpath"), None);
        assert_eq!(parse_du_bytes(""), None);
    }

    #[test]
    fn shell_quote_escapes_inner_quotes() {
        assert_eq!(shell_quote("/a/b"), "'/a/b'");
        assert_eq!(shell_quote("/a'b"), "'/a'\\''b'");
    }

    #[test]
    fn a_queued_task_is_pending_and_not_complete() {
        let queued = DirectorySizeResult::pending("s", "/x");
        assert_eq!(queued.status, DirectorySizeStatus::Pending);
        assert!(!queued.complete, "排队中不能算完成");
    }

    #[test]
    fn du_warnings_are_never_reported_as_completed() {
        // 干净的一跑（含真正的空目录）才算完整。
        assert_eq!(classify_du(0, 0, true), DirectorySizeStatus::Completed);
        assert_eq!(classify_du(4_096, 0, true), DirectorySizeStatus::Completed);
        // 有数字但跳过了一部分 → partial，绝不 completed。
        assert_eq!(classify_du(4_096, 3, true), DirectorySizeStatus::Partial);
        assert_eq!(classify_du(4_096, 0, false), DirectorySizeStatus::Partial);
        // 一点都没读到并且报错 → 权限不足，不是"0 字节已完成"。
        assert_eq!(
            classify_du(0, 2, true),
            DirectorySizeStatus::PermissionDenied
        );
        assert_eq!(
            classify_du(0, 0, false),
            DirectorySizeStatus::PermissionDenied
        );
    }

    #[test]
    fn terminal_state_is_complete() {
        let done =
            DirectorySizeResult::computing("s", "/x").terminal(DirectorySizeStatus::Completed);
        assert!(done.complete);
        assert_eq!(done.status, DirectorySizeStatus::Completed);

        let running = DirectorySizeResult::computing("s", "/x");
        assert!(!running.complete);
    }

    #[test]
    fn record_entry_sums_files_and_counts_directories() {
        let mut result = DirectorySizeResult::computing("s", "/x");
        assert!(!record_entry(&mut result, ssh::KIND_FILE, 100));
        assert!(!record_entry(&mut result, ssh::KIND_FILE, 250));
        // A directory is reported as "recurse into me" and counted, but adds no
        // bytes on its own (only its contents do).
        assert!(record_entry(&mut result, ssh::KIND_DIRECTORY, 4096));
        // Symlinks are skipped: no bytes, no follow, counted as skipped.
        assert!(!record_entry(&mut result, ssh::KIND_SYMLINK, 0));

        assert_eq!(result.size_bytes, 350);
        assert_eq!(result.file_count, 2);
        assert_eq!(result.directory_count, 1);
        assert_eq!(result.skipped_count, 1);
    }

    // -- 前端序列化契约（命令返回值与 directory-size-update 事件共用） --------

    #[test]
    fn directory_size_result_serializes_for_frontend() {
        let result = DirectorySizeResult::computing("session-1", "/srv/app");
        let value = serde_json::to_value(result).unwrap();

        assert_eq!(value["sessionId"], "session-1");
        assert_eq!(value["path"], "/srv/app");
        assert!(value.get("sizeBytes").is_some());
        assert!(value.get("fileCount").is_some());
        assert!(value.get("calculatedAt").is_some());

        assert!(value.get("session_id").is_none());
        assert!(value.get("size_bytes").is_none());
    }

    #[test]
    fn directory_size_status_stays_snake_case() {
        // 前端 DirectorySizeStatus 联合类型按 snake_case 匹配，枚举值绝不能跟
        // 结构体字段一起被改成 camelCase。
        let pending = serde_json::to_value(DirectorySizeStatus::Pending).unwrap();
        assert_eq!(pending, "pending");
        let denied = serde_json::to_value(DirectorySizeStatus::PermissionDenied).unwrap();
        assert_eq!(denied, "permission_denied");
        let partial = serde_json::to_value(DirectorySizeStatus::Partial).unwrap();
        assert_eq!(partial, "partial");
        let completed = serde_json::to_value(DirectorySizeStatus::Completed).unwrap();
        assert_eq!(completed, "completed");
    }

    #[test]
    fn terminal_states_are_complete_and_transient_states_are_not() {
        for status in [
            DirectorySizeStatus::Completed,
            DirectorySizeStatus::Partial,
            DirectorySizeStatus::PermissionDenied,
            DirectorySizeStatus::Cancelled,
            DirectorySizeStatus::TimedOut,
            DirectorySizeStatus::SessionGone,
            DirectorySizeStatus::Failed,
        ] {
            let result = DirectorySizeResult::computing("s", "/x").terminal(status);
            assert!(result.complete, "{status:?} 必须是终态");
        }
        for status in [DirectorySizeStatus::Pending, DirectorySizeStatus::Computing] {
            let result = DirectorySizeResult::computing("s", "/x").terminal(status);
            assert!(!result.complete, "{status:?} 不是终态");
        }
    }

    // -- 批量状态查询（watchdog 兜底） -----------------------------------------

    #[test]
    fn status_many_caps_dedupes_and_rejects_bad_input() {
        let registry = DirectorySizeRegistry::default();

        // 超过单轮上限整体拒绝。
        let too_many: Vec<String> = (0..MAX_STATUS_BATCH + 1)
            .map(|index| format!("/dir-{index}"))
            .collect();
        assert!(registry.status_many("s1", &too_many).is_err());

        // 空路径拒绝。
        assert!(registry
            .status_many("s1", &["/ok".to_string(), "   ".to_string()])
            .is_err());
        assert!(registry
            .status_many("s1", &["/ok".to_string(), String::new()])
            .is_err());

        // 没有任何任务的路径：去重后返回空，不报错。
        let paths = vec![
            "/a".to_string(),
            "/a".to_string(),
            "/b".to_string(),
            "/b".to_string(),
        ];
        assert_eq!(registry.status_many("s1", &paths).unwrap(), Vec::new());
    }

    #[test]
    fn status_many_only_reads_the_registry_and_never_starts_a_task() {
        let registry = Arc::new(DirectorySizeRegistry::default());

        let paths = vec!["/var/www".to_string(), "/opt".to_string()];
        let results = registry.status_many("s1", &paths).unwrap();
        assert!(results.is_empty());

        // 只读语义：没有任务被创建，也没有会话级并发闸被分配。
        assert!(registry.tasks.lock().unwrap().is_empty());
        assert!(registry.gates.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn two_sessions_with_the_same_path_do_not_cross() {
        let registry = Arc::new(DirectorySizeRegistry::default());
        // 无 SSH 会话：exec 与 SFTP 都会失败，任务落到终态 permission_denied。
        let manager = Arc::new(SshSessionManager::default());
        registry.start(
            None,
            manager.clone(),
            "s1".to_string(),
            "/srv/app".to_string(),
            Duration::from_secs(5),
            false,
        );
        registry.start(
            None,
            manager,
            "s2".to_string(),
            "/srv/app".to_string(),
            Duration::from_secs(5),
            false,
        );

        for session in ["s1", "s2"] {
            let mut done = false;
            for _ in 0..100 {
                if let Some(result) = registry.status(session, "/srv/app") {
                    if result.complete {
                        assert_eq!(result.session_id, session);
                        done = true;
                        break;
                    }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            assert!(done, "{session} 的任务未在限时内到达终态");
        }

        // 两个会话各自持有独立任务：结果互不覆盖。
        let s1 = registry.status("s1", "/srv/app").unwrap();
        let s2 = registry.status("s2", "/srv/app").unwrap();
        assert_eq!(s1.session_id, "s1");
        assert_eq!(s2.session_id, "s2");
        assert_eq!(s1.status, DirectorySizeStatus::PermissionDenied);
        assert_eq!(s2.status, DirectorySizeStatus::PermissionDenied);
    }
}
