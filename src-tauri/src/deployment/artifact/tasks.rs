//! 导入任务的注册表与流水线：**指纹 → 安全扫描 → 识别 → 等用户确认**。
//!
//! # 为什么注册表用 `std::sync::Mutex`
//!
//! 流水线本身是同步的（哈希与解压读盘），跑在阻塞线程池里；注册表只做
//! `HashMap` 的短临界区操作，没有 `await`。用同步锁可以让阻塞线程直接推进进度，
//! 不必为了"发一个进度"绕回async 运行时（那会引入一套 channel 转发）。
//! **锁内绝不做 I/O**，这条纪律保证不会阻塞运行时。
//!
//! # 取消是协作式的
//!
//! `cancel()` 只置一个 `AtomicBool`，流水线在**每个阶段边界**检查它。
//! 也就是说取消最多让当前阶段跑完，但绝不会把半成品写进模型。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use super::fingerprint;
use super::inspect;
use super::model::{
    ArtifactFingerprint, ArtifactImportTask, FingerprintBasis, ImportProgress, ImportSource,
    ImportStage, ImportStatus, SecurityFinding,
};
use super::secrets;
use super::source::{ArchiveFormat, ArchiveSource, ContentSource, DirectorySource, FileSource};
use crate::deployment::model::{ArtifactKind, ArtifactSourceKind};

/// 毫秒时间戳（与 `db::AppDb::now()` 同量纲）。
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// 任务状态变化时的通知（装配层用它往前端发事件）。
pub type TaskListener = Arc<dyn Fn(&ArtifactImportTask) + Send + Sync>;

// -- 注册表 -----------------------------------------------------------------

#[derive(Clone, Default)]
pub struct TaskRegistry {
    tasks: Arc<Mutex<HashMap<String, ArtifactImportTask>>>,
    cancel: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl TaskRegistry {
    /// 登记任务并返回取消令牌。
    pub fn insert(&self, task: ArtifactImportTask) -> Arc<AtomicBool> {
        let token = Arc::new(AtomicBool::new(false));
        if let Ok(mut cancel) = self.cancel.lock() {
            cancel.insert(task.id.clone(), token.clone());
        }
        if let Ok(mut tasks) = self.tasks.lock() {
            tasks.insert(task.id.clone(), task);
        }
        token
    }

    /// 请求取消。`false` = 任务不存在或已经结束（没有可取消的东西）。
    pub fn cancel(&self, id: &str) -> bool {
        match self
            .cancel
            .lock()
            .ok()
            .and_then(|guard| guard.get(id).cloned())
        {
            Some(token) => {
                token.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    pub fn snapshot(&self, id: &str) -> Option<ArtifactImportTask> {
        self.tasks.lock().ok()?.get(id).cloned()
    }

    pub fn list_for_application(&self, application_id: &str) -> Vec<ArtifactImportTask> {
        let mut tasks: Vec<ArtifactImportTask> = self
            .tasks
            .lock()
            .map(|guard| {
                guard
                    .values()
                    .filter(|task| task.application_id.as_deref() == Some(application_id))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        tasks.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        tasks
    }

    pub fn remove(&self, id: &str) {
        if let Ok(mut tasks) = self.tasks.lock() {
            tasks.remove(id);
        }
        if let Ok(mut cancel) = self.cancel.lock() {
            cancel.remove(id);
        }
    }

    /// 释放取消令牌（任务结束时必须调用，否则重试会拿到已置位的令牌）。
    pub fn release(&self, id: &str) {
        if let Ok(mut cancel) = self.cancel.lock() {
            cancel.remove(id);
        }
    }

    /// 重试：只允许失败 / 取消的任务；清掉上一次的错误与结果。
    pub fn prepare_retry(&self, id: &str) -> Result<(ArtifactImportTask, Arc<AtomicBool>), String> {
        let mut tasks = self.tasks.lock().map_err(|_| "任务表不可用".to_string())?;
        let task = tasks
            .get_mut(id)
            .ok_or_else(|| "导入任务不存在（应用可能已重启）".to_string())?;
        if !matches!(task.status, ImportStatus::Failed | ImportStatus::Cancelled) {
            return Err("只有失败或已取消的任务可以重试".to_string());
        }
        task.stage = ImportStage::Queued;
        task.status = ImportStatus::Running;
        task.progress = ImportProgress::queued();
        task.fingerprint = None;
        task.security = None;
        task.inspection = None;
        task.error = None;
        task.can_cancel = true;
        task.attempt += 1;
        task.updated_at = now_ms();
        task.finished_at = None;
        let task = task.clone();
        drop(tasks);

        let token = Arc::new(AtomicBool::new(false));
        if let Ok(mut cancel) = self.cancel.lock() {
            cancel.insert(task.id.clone(), token.clone());
        }
        Ok((task, token))
    }

    /// 修改内存里的任务（装配层确认导入后用它标记完成）。
    pub fn update(&self, id: &str, action: impl FnOnce(&mut ArtifactImportTask)) {
        if let Ok(mut tasks) = self.tasks.lock() {
            if let Some(task) = tasks.get_mut(id) {
                action(task);
            }
        }
    }
}

// -- 已准备好的来源 ---------------------------------------------------------

/// 已经打开并清点完毕的来源。
///
/// 之所以把"打开来源"与"跑流水线"分开：远程目录的清单要用 SFTP 异步读，
/// 而流水线是同步的。异步的部分在装配层做完，这里只接收结果。
pub struct PreparedSource {
    pub source: Box<dyn ContentSource>,
    /// 清点阶段的结构性发现（ZIP Slip / 符号链接 / 压缩炸弹…）。
    pub structural: Vec<SecurityFinding>,
    pub truncated: bool,
    pub basis: FingerprintBasis,
    /// 有实体文件时用它做字节哈希（归档与单文件）。
    pub hash_file: Option<PathBuf>,
    /// 镜像引用（没有实体文件，指纹哈希的是引用字符串）。
    pub reference: Option<String>,
}

/// 打开一个本地来源（目录 / 归档 / 单文件）。
pub fn prepare_local(source: &ImportSource) -> Result<PreparedSource, String> {
    match source {
        ImportSource::LocalFolder { path } => {
            let directory =
                DirectorySource::scan(Path::new(path)).map_err(|error| error.to_string())?;
            let inventory = directory.inventory().clone();
            Ok(PreparedSource {
                source: Box::new(directory),
                structural: inventory.findings,
                truncated: inventory.truncated,
                basis: FingerprintBasis::DirectoryManifest,
                hash_file: None,
                reference: None,
            })
        }
        ImportSource::LocalArchive { path } => {
            let archive =
                ArchiveSource::open(Path::new(path)).map_err(|error| error.to_string())?;
            let inventory = archive.inventory().clone();
            Ok(PreparedSource {
                source: Box::new(archive),
                structural: inventory.findings,
                truncated: inventory.truncated,
                basis: FingerprintBasis::ArchiveBytes,
                hash_file: Some(PathBuf::from(path)),
                reference: None,
            })
        }
        ImportSource::LocalFile {
            path,
            artifact_kind,
        } => {
            if *artifact_kind == ArtifactKind::Jar {
                // JAR 就是 ZIP：走归档清点才能看到里面的内容。
                let archive =
                    ArchiveSource::open(Path::new(path)).map_err(|error| error.to_string())?;
                let inventory = archive.inventory().clone();
                return Ok(PreparedSource {
                    source: Box::new(archive),
                    structural: inventory.findings,
                    truncated: inventory.truncated,
                    basis: FingerprintBasis::ArchiveBytes,
                    hash_file: Some(PathBuf::from(path)),
                    reference: None,
                });
            }
            let file = FileSource::open(Path::new(path)).map_err(|error| error.to_string())?;
            Ok(PreparedSource {
                source: Box::new(file),
                structural: Vec::new(),
                truncated: false,
                basis: FingerprintBasis::FileBytes,
                hash_file: Some(PathBuf::from(path)),
                reference: None,
            })
        }
        ImportSource::DockerImageRef { reference } => Ok(PreparedSource {
            source: Box::new(EmptySource::default()),
            structural: Vec::new(),
            truncated: false,
            basis: FingerprintBasis::ImageReference,
            hash_file: None,
            reference: Some(reference.clone()),
        }),
        ImportSource::RemoteDirectory { .. } => Err(
            "服务器目录来源需要先通过 SFTP 读取清单（见 deployment_artifact_import_start）"
                .to_string(),
        ),
    }
}

/// 镜像引用没有可清点的内容 —— 用空来源表达"没有文件"，而不是假装有。
#[derive(Debug, Clone, Default)]
pub struct EmptySource {
    entries: Vec<super::source::SourceEntry>,
}

impl ContentSource for EmptySource {
    fn entries(&self) -> &[super::source::SourceEntry] {
        &self.entries
    }

    fn read_many(&self, _wanted: &[String], _limit: usize) -> Vec<(String, Vec<u8>)> {
        Vec::new()
    }
}

/// 远程目录的清单来源（SFTP 读好之后交进来）。
pub fn prepare_remote(entries: Vec<super::source::SourceEntry>) -> PreparedSource {
    PreparedSource {
        source: Box::new(super::remote::RemoteListingSource::new(entries)),
        structural: Vec::new(),
        truncated: false,
        basis: FingerprintBasis::RemoteListing,
        hash_file: None,
        reference: None,
    }
}

// -- 流水线 -----------------------------------------------------------------

enum RunError {
    Cancelled,
    Failed(String),
}

/// 跑完一次导入分析（同步，调用方负责扔进阻塞线程）。
pub fn run(
    task: ArtifactImportTask,
    prepared: PreparedSource,
    registry: TaskRegistry,
    cancel: Arc<AtomicBool>,
    listener: Option<TaskListener>,
) {
    let reporter = Reporter {
        id: task.id.clone(),
        registry: registry.clone(),
        listener,
    };
    let outcome = execute(&task, &prepared, &reporter, &cancel);
    match outcome {
        Ok(()) => reporter.finish(ImportStatus::Succeeded, None),
        Err(RunError::Cancelled) => {
            reporter.finish(ImportStatus::Cancelled, None);
        }
        Err(RunError::Failed(message)) => reporter.finish(ImportStatus::Failed, Some(message)),
    }
    registry.release(&task.id);
}

fn execute(
    task: &ArtifactImportTask,
    prepared: &PreparedSource,
    reporter: &Reporter,
    cancel: &AtomicBool,
) -> Result<(), RunError> {
    let check = || -> Result<(), RunError> {
        if cancel.load(Ordering::Relaxed) {
            Err(RunError::Cancelled)
        } else {
            Ok(())
        }
    };

    // ---- 阶段 1：指纹（SHA-256）----
    check()?;
    reporter.stage(ImportStage::Hashing);
    let now = now_ms();
    let fingerprint = build_fingerprint(prepared, reporter, cancel, now)?;

    // ---- 阶段 2：安全扫描 ----
    check()?;
    reporter.stage(ImportStage::SecurityScan);
    let content = secrets::scan_source(prepared.source.as_ref());
    let mut report = secrets::merge(prepared.structural.clone(), content);
    if prepared.truncated {
        // 清点被上限截断 = 扫描覆盖不全，必须如实标出去。
        report.truncated = true;
    }

    // ---- 阶段 3：识别 ----
    check()?;
    reporter.stage(ImportStage::Inspecting);
    let artifact_kind = artifact_kind_of(&task.source);
    let inspection = inspect::inspect(
        prepared.source.as_ref(),
        artifact_kind,
        source_kind_of(&task.source),
        &task.display_name,
        now_ms(),
        report.truncated,
    );

    // ---- 阶段 4：等用户确认 ----
    reporter.update(|task| {
        task.fingerprint = Some(fingerprint);
        task.security = Some(report);
        task.inspection = Some(inspection);
        task.stage = ImportStage::AwaitingConfirmation;
        task.progress.processed_entries = task.progress.total_entries;
        task.progress.percent = 100;
        task.updated_at = now_ms();
    });
    reporter.emit();
    Ok(())
}

fn build_fingerprint(
    prepared: &PreparedSource,
    reporter: &Reporter,
    cancel: &AtomicBool,
    now: i64,
) -> Result<ArtifactFingerprint, RunError> {
    // 进度节流：每 1 MiB 报一次，避免事件流被 64 KiB 的分块刷爆。
    let last_reported = std::cell::Cell::new(0u64);
    let mut report = |processed: u64, total: u64| {
        let step = 1024 * 1024;
        if processed >= total || processed.saturating_sub(last_reported.get()) >= step {
            last_reported.set(processed);
            reporter.progress(ImportStage::Hashing, processed, total, 0, 0);
        }
    };

    if let Some(reference) = &prepared.reference {
        return Ok(fingerprint::reference_fingerprint(
            reference,
            prepared.basis,
            now,
        ));
    }

    if let Some(path) = &prepared.hash_file {
        let total = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
        report(0, total);
        let (sha256, size_bytes) = fingerprint::hash_file(path, &mut |processed| {
            if cancel.load(Ordering::Relaxed) {
                return;
            }
            report(processed, total);
        })
        .map_err(|error| RunError::Failed(error.to_string()))?;
        return Ok(fingerprint::fingerprint_for(
            prepared.basis,
            sha256,
            size_bytes,
            0,
            None,
            now,
        ));
    }

    let (sha256, content_bytes, entry_count) =
        fingerprint::hash_source(prepared.source.as_ref(), &mut |processed| {
            if cancel.load(Ordering::Relaxed) {
                return;
            }
            let total = prepared.source.total_bytes();
            report(processed, total);
        });
    Ok(fingerprint::fingerprint_for(
        prepared.basis,
        sha256,
        content_bytes,
        entry_count,
        None,
        now,
    ))
}

/// 重新计算指纹（确认前复核用）。返回 `None` = 该来源无法在本地复核。
pub fn revalidate(task: &ArtifactImportTask) -> Result<Option<ArtifactFingerprint>, String> {
    let prepared = match &task.source {
        ImportSource::DockerImageRef { reference } => {
            return Ok(Some(fingerprint::reference_fingerprint(
                reference,
                FingerprintBasis::ImageReference,
                now_ms(),
            )))
        }
        ImportSource::RemoteDirectory { .. } => return Ok(None),
        _ => prepare_local(&task.source)?,
    };
    let now = now_ms();
    if let Some(path) = &prepared.hash_file {
        let (sha256, size_bytes) =
            fingerprint::hash_file(path, &mut |_| {}).map_err(|error| error.to_string())?;
        return Ok(Some(fingerprint::fingerprint_for(
            prepared.basis,
            sha256,
            size_bytes,
            0,
            None,
            now,
        )));
    }
    let (sha256, bytes, entries) = fingerprint::hash_source(prepared.source.as_ref(), &mut |_| {});
    Ok(Some(fingerprint::fingerprint_for(
        prepared.basis,
        sha256,
        bytes,
        entries,
        None,
        now,
    )))
}

/// 制品类型（任务级）。
pub fn artifact_kind_of(source: &ImportSource) -> ArtifactKind {
    match source {
        ImportSource::LocalFile { artifact_kind, .. } => *artifact_kind,
        ImportSource::LocalArchive { path } => match ArchiveFormat::from_path(Path::new(path)) {
            Some(ArchiveFormat::Tar) => ArtifactKind::Tar,
            Some(ArchiveFormat::TarGz) => ArtifactKind::TarGz,
            _ => ArtifactKind::Zip,
        },
        ImportSource::DockerImageRef { .. } => ArtifactKind::DockerImage,
        ImportSource::LocalFolder { .. } | ImportSource::RemoteDirectory { .. } => {
            ArtifactKind::Folder
        }
    }
}

/// 制品来源类型（任务级）。
pub fn source_kind_of(source: &ImportSource) -> ArtifactSourceKind {
    match source {
        ImportSource::DockerImageRef { .. } => ArtifactSourceKind::DockerRegistry,
        ImportSource::RemoteDirectory { .. } => ArtifactSourceKind::ServerExistingDir,
        _ => ArtifactSourceKind::LocalPath,
    }
}

// -- 报告器 -----------------------------------------------------------------

struct Reporter {
    id: String,
    registry: TaskRegistry,
    listener: Option<TaskListener>,
}

impl Reporter {
    fn update(&self, action: impl FnOnce(&mut ArtifactImportTask)) {
        self.registry.update(&self.id, action);
    }

    fn emit(&self) {
        if let Some(listener) = &self.listener {
            if let Some(task) = self.registry.snapshot(&self.id) {
                listener(&task);
            }
        }
    }

    fn stage(&self, stage: ImportStage) {
        self.update(|task| {
            task.stage = stage;
            task.status = ImportStatus::Running;
            task.updated_at = now_ms();
        });
        self.emit();
    }

    fn progress(
        &self,
        stage: ImportStage,
        processed_bytes: u64,
        total_bytes: u64,
        processed_entries: u64,
        total_entries: u64,
    ) {
        self.update(|task| {
            task.stage = stage;
            task.progress.processed_bytes = processed_bytes;
            task.progress.total_bytes = total_bytes;
            if total_entries > 0 {
                task.progress.processed_entries = processed_entries;
                task.progress.total_entries = total_entries;
            }
            task.progress.recompute();
            task.updated_at = now_ms();
        });
        self.emit();
    }

    fn finish(&self, status: ImportStatus, error: Option<String>) {
        self.update(|task| {
            task.status = status;
            task.error = error;
            task.can_cancel = false;
            task.updated_at = now_ms();
            task.finished_at = Some(now_ms());
        });
        self.emit();
    }
}
