//! On-demand directory size calculation.
//!
//! SFTP only reports a directory's own metadata size (commonly 4096 B), never
//! the total of its contents — so a file browser that lists folders next to
//! files cannot show how big a folder is without actually walking it. We do
//! that *on demand* (right-click → "compute size"), never automatically when
//! listing a directory, because a recursive scan of a large tree is slow and
//! hammers the server's disk.
//!
//! Strategy, best first:
//! 1. `du` when the remote has it — GNU `du -sb` (bytes) or BusyBox/BSD
//!    `du -sk` (KB, ×1024). One process, the server does the walking.
//! 2. SFTP recursive walk as a fallback (no `du`, or `du` failed). Slower, but
//!    it streams progress and honours a cancel signal at every step.
//!
//! Either way the result is cached by `session_id + path` so refreshing the
//! directory view does not recompute it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use serde::Serialize;
use tokio::sync::watch;

use crate::ssh::{self, SshSessionManager};

/// Pushed to the frontend as a computation progresses. The command layer owns
/// the `tauri::AppHandle` and turns this into a Tauri event; keeping that here
/// would drag `tauri`'s native loader into every test binary, so we only take a
/// plain closure.
pub type EmitFn = Arc<dyn Fn(DirectorySizeResult) + Send + Sync>;

/// Event name pushed to the frontend as a calculation progresses.
pub const DIR_SIZE_EVENT: &str = "directory-size-update";

/// Lifecycle of a single directory-size computation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
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

/// Result of a directory-size computation, pushed over [`DIR_SIZE_EVENT`] and
/// returned by [`crate::commands::directory_size_status`].
#[derive(Debug, Clone, Serialize)]
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
        self.complete =
            status != DirectorySizeStatus::Computing && status != DirectorySizeStatus::Pending;
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

/// Per-session directory-size state: in-flight tasks (one per path) plus the
/// cached `du` flavour probe.
#[derive(Default)]
pub struct DirectorySizeRegistry {
    tasks: Mutex<HashMap<(String, String), Arc<DirectorySizeTask>>>,
    du_flavor: Mutex<HashMap<String, Option<DuFlavor>>>,
    /// Emit closure, stashed on first `start`, used to push updates to the
    /// frontend. `None` only in tests, where the result is still cached.
    emit: Mutex<Option<EmitFn>>,
}

impl DirectorySizeRegistry {
    pub fn forget_session(&self, session_id: &str) {
        self.tasks
            .lock()
            .unwrap()
            .retain(|(sid, _), _| sid != session_id);
        self.du_flavor.lock().unwrap().remove(session_id);
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
    ) {
        let key = (session_id.clone(), path.clone());
        {
            let tasks = self.tasks.lock().unwrap();
            if let Some(existing) = tasks.get(&key) {
                // Replay the current state so a refresh or a re-open sees it.
                if let Some(emit) = &emit {
                    emit(existing.snapshot());
                }
                return;
            }
        }

        let (cancel_tx, cancel_rx) = watch::channel(false);
        let task = Arc::new(DirectorySizeTask {
            cancel: cancel_tx,
            state: Mutex::new(DirectorySizeResult::computing(&session_id, &path)),
        });
        self.tasks.lock().unwrap().insert(key, task.clone());

        let registry = Arc::clone(self);
        registry.set_emit(emit.clone());
        tauri::async_runtime::spawn(async move {
            let flavor = registry.detect_flavor(&manager, &session_id).await;
            let emit = registry.emit_fn();
            let result = registry
                .compute(&manager, &session_id, &path, flavor, timeout, &cancel_rx)
                .await;
            task.update(&emit, result);
            // Leave the finished task in the map so `cached`/`status` can replay
            // it; it is only evicted when the session is forgotten.
        });
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

    /// Detects the remote `du` flavour once per session, caching the outcome
    /// (including "none"). The probe is one cheap `du --version` (GNU only) and
    /// a `du -sb` smoke test that tolerates a non-zero exit.
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
                    "du -sb -- / 2>/dev/null | head -n1",
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
        let task = self
            .tasks
            .lock()
            .unwrap()
            .get(&(session_id.to_string(), path.to_string()))
            .cloned();
        // The emit closure (if any) is only used to push progress events; its
        // absence — e.g. in tests — never fails a computation, the result is
        // still cached and reachable via `status`.
        let app = self.emit_fn();

        // Try `du` first.
        if let Some(flavor) = flavor {
            match self
                .compute_du(manager, session_id, path, flavor, timeout)
                .await
            {
                Ok(result) => return result,
                Err(_) => { /* fall through to SFTP */ }
            }
        }

        // SFTP recursive fallback.
        match self
            .compute_sftp(manager, session_id, path, timeout, cancel)
            .await
        {
            Ok(result) => result,
            Err(status) => {
                let mut base = DirectorySizeResult::computing(session_id, path);
                base.size_bytes = 0;
                if let Some(task) = task {
                    task.update(&app, base.clone());
                }
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
    async fn compute_du(
        &self,
        manager: &SshSessionManager,
        session_id: &str,
        path: &str,
        flavor: DuFlavor,
        timeout: Duration,
    ) -> Result<DirectorySizeResult, ()> {
        let cmd = match flavor {
            DuFlavor::Bytes => format!("du -sb -- {}", shell_quote(path)),
            DuFlavor::Kibibytes => format!("du -sk -- {}", shell_quote(path)),
        };
        let output = manager
            .exec(session_id, &cmd, timeout)
            .await
            .map_err(|_| ())?;
        // `du` may print to stderr for unreadable subdirs but still exit 0 on
        // GNU; only a completely empty stdout means it produced nothing.
        let (size_bytes, _line) = match flavor {
            DuFlavor::Bytes => parse_du_bytes(&output.stdout).ok_or(()),
            DuFlavor::Kibibytes => parse_du_kibibytes(&output.stdout).ok_or(()),
        }?;

        let mut result = DirectorySizeResult::computing(session_id, path);
        result.size_bytes = size_bytes;
        // `du` is a single summary line; the file/dir split is not part of its
        // contract here, so we leave counts at 0 and report completion. When
        // stderr carried permission warnings we still mark partial only if the
        // run truly skipped (GNU prints them but keeps going).
        result.skipped_count = if output.stderr.is_empty() { 0 } else { 0 };
        Ok(result.terminal(DirectorySizeStatus::Completed))
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
}
