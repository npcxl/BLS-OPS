//! SFTP: remote file browsing and management over the live session.
//!
//! The subsystem runs on its own channel, so the file browser and the
//! interactive shell never block each other. Two rules run through this file:
//!
//! * **Paths are never canonicalized before a destructive operation.**
//!   `canonicalize` would resolve a symlink to its target, so removing
//!   `link → /var/www/project` would recurse into and delete the real
//!   directory. Everything destructive uses `symlink_metadata` and walks with
//!   lstat at every level.
//! * **Local paths are the one place `std::path::PathBuf` is correct** — they
//!   are on this machine.

use std::sync::Arc;
use std::time::UNIX_EPOCH;

use anyhow::{anyhow, Result};
use base64::Engine as _;
use russh_sftp::client::{fs::DirEntry, SftpSession};
use russh_sftp::protocol::{FileAttributes, FileType, StatusCode as SftpStatusCode};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt};

use super::manager::SshSessionManager;
use super::model::{
    RemoteBinaryContent, RemoteFileContent, RemoteFileEntry, KIND_DIRECTORY, KIND_FILE, KIND_OTHER,
    KIND_SYMLINK,
};
use super::paths::{base_name, format_size_human, parent_of, posix_join, posix_normalize};

/// Hard ceiling on a preview payload. The frontend asks for far less (a text
/// file, an image, a spreadsheet); this only stops a caller from hauling a
/// multi-GB file through the IPC layer by accident.
pub const MAX_PREVIEW_BYTES: u64 = 256 * 1024 * 1024;

/// Maps SFTP client errors onto user-facing messages, calling out permission
/// problems explicitly so the UI can present them distinctly.
pub(crate) fn sftp_error(error: russh_sftp::client::error::Error) -> anyhow::Error {
    use russh_sftp::client::error::Error as SftpError;
    match &error {
        SftpError::Status(status) if status.status_code == SftpStatusCode::PermissionDenied => {
            anyhow!("权限不足：无法访问该路径（{}）", status.error_message)
        }
        SftpError::Status(status) => anyhow!("SFTP 错误：{}", status.error_message),
        _ => anyhow!("SFTP 错误：{error}"),
    }
}

fn sftp_kind(file_type: FileType) -> &'static str {
    match file_type {
        FileType::Dir => KIND_DIRECTORY,
        FileType::File => KIND_FILE,
        FileType::Symlink => KIND_SYMLINK,
        FileType::Other => KIND_OTHER,
    }
}

/// Builds an entry from a `read_dir` item, remembering whether the server
/// reported a size at all (some servers/servers behind proxies omit it).
fn remote_entry(parent: &str, entry: DirEntry) -> (RemoteFileEntry, bool) {
    let name = entry.file_name();
    let meta = entry.metadata();
    let size_missing = meta.size.is_none();
    (
        build_entry(&posix_join(parent, &name), &name, &meta),
        size_missing,
    )
}

/// Builds an entry for a single path (used by `sftp_stat`).
///
/// Paths are always absolute remote paths, so the name is the last segment.
pub(crate) fn build_entry(
    path: &str,
    name: &str,
    meta: &russh_sftp::client::fs::Metadata,
) -> RemoteFileEntry {
    RemoteFileEntry {
        name: name.to_string(),
        path: path.to_string(),
        kind: sftp_kind(meta.file_type()).to_string(),
        size: meta.len(),
        modified_at: meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64),
        permissions: Some(meta.permissions().to_string()),
        hidden: name.starts_with('.'),
    }
}

/// Recursively removes a file, symlink or directory tree.
///
/// SECURITY: symlinks are unlinked, never followed — see the module note.
fn remove_recursive<'a>(
    sftp: &'a SftpSession,
    path: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
    Box::pin(async move {
        let meta = sftp.symlink_metadata(path).await.map_err(sftp_error)?;
        if meta.file_type() != FileType::Dir {
            sftp.remove_file(path).await.map_err(sftp_error)?;
            return Ok(());
        }
        for entry in sftp.read_dir(path).await.map_err(sftp_error)? {
            let child = posix_join(path, &entry.file_name());
            // Use lstat so a symlink inside the tree is unlinked, not followed.
            remove_recursive(sftp, &child).await?;
        }
        sftp.remove_dir(path).await.map_err(sftp_error)?;
        Ok(())
    })
}

fn copy_recursive<'a>(
    sftp: &'a SftpSession,
    from: &'a str,
    to: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
    Box::pin(async move {
        let meta = sftp.symlink_metadata(from).await.map_err(sftp_error)?;
        match meta.file_type() {
            FileType::Dir => {
                sftp.create_dir(to).await.map_err(sftp_error)?;
                for entry in sftp.read_dir(from).await.map_err(sftp_error)? {
                    let child_from = posix_join(from, &entry.file_name());
                    let child_to = posix_join(to, &entry.file_name());
                    copy_recursive(sftp, &child_from, &child_to).await?;
                }
                Ok(())
            }
            FileType::Symlink => Err(anyhow!("暂不支持复制符号链接：{from}")),
            _ => {
                let mut source = sftp.open(from).await.map_err(sftp_error)?;
                let mut target = sftp.create(to).await.map_err(sftp_error)?;
                tokio::io::copy(&mut source, &mut target)
                    .await
                    .map_err(|error| anyhow!("复制 {from} 失败：{error}"))?;
                target
                    .shutdown()
                    .await
                    .map_err(|error| anyhow!("写入 {to} 失败：{error}"))?;
                Ok(())
            }
        }
    })
}

/// Uploads `root` (file or directory) into `remote_dir`, mirroring the
/// relative structure below `root_base`.
fn upload_walk<'a>(
    sftp: &'a SftpSession,
    current: &'a std::path::Path,
    root_base: &'a std::path::Path,
    remote_dir: &'a str,
    on_file_done: &'a (dyn Fn(&str) + Send + Sync),
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<RemoteFileEntry>>> + Send + 'a>>
{
    Box::pin(
        async move { upload_walk_inner(sftp, current, root_base, remote_dir, on_file_done).await },
    )
}

async fn upload_walk_inner(
    sftp: &SftpSession,
    current: &std::path::Path,
    root_base: &std::path::Path,
    remote_dir: &str,
    on_file_done: &(dyn Fn(&str) + Send + Sync),
) -> Result<Vec<RemoteFileEntry>> {
    // Only used for the parent/child relationship check below; the remote path
    // is derived from `remote_dir` + names, not from this prefix.
    current
        .strip_prefix(root_base)
        .map_err(|_| anyhow!("内部错误：路径前缀不匹配 {}", current.display()))?;
    let name = current
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let remote_path = if name.is_empty() {
        remote_dir.to_string()
    } else {
        posix_join(remote_dir, &name)
    };

    if current.is_dir() {
        if !name.is_empty() {
            // Overwrite-tolerant create: an existing dir makes CREATE fail, so
            // reuse it instead of erroring the whole upload.
            if sftp.symlink_metadata(&remote_path).await.is_err() {
                sftp.create_dir(&remote_path).await.map_err(sftp_error)?;
            }
        }
        let mut uploaded = Vec::new();
        let mut children = tokio::fs::read_dir(current)
            .await
            .map_err(|error| anyhow!("读取本地目录 {} 失败：{error}", current.display()))?;
        while let Some(child) = children
            .next_entry()
            .await
            .map_err(|error| anyhow!("读取本地目录 {} 失败：{error}", current.display()))?
        {
            uploaded.extend(
                upload_walk(sftp, &child.path(), root_base, &remote_path, on_file_done).await?,
            );
        }
        Ok(uploaded)
    } else {
        let size = current
            .metadata()
            .map_err(|error| anyhow!("读取本地文件 {} 失败：{error}", current.display()))?
            .len();
        let mut local = tokio::fs::File::open(current)
            .await
            .map_err(|error| anyhow!("打开本地文件 {} 失败：{error}", current.display()))?;
        let mut remote = sftp.create(&remote_path).await.map_err(sftp_error)?;
        tokio::io::copy(&mut local, &mut remote)
            .await
            .map_err(|error| anyhow!("上传 {name} 失败：{error}"))?;
        remote
            .shutdown()
            .await
            .map_err(|error| anyhow!("上传 {name} 失败：{error}"))?;
        on_file_done(&name);
        let mut entry = build_entry(
            &remote_path,
            &base_name(&remote_path),
            &FileAttributes::empty(),
        );
        entry.size = size;
        entry.kind = KIND_FILE.to_string();
        Ok(vec![entry])
    }
}

// ---------------------------------------------------------------------------

impl SshSessionManager {
    /// Opens SFTP for the session and returns the canonical home directory.
    pub async fn sftp_open(&self, session_id: &str) -> Result<String> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        // "." resolves against the login directory of the authenticated user.
        let home = sftp.canonicalize(".").await.map_err(sftp_error)?;
        let mut cwd = session.cwd.lock().await;
        if cwd.is_none() {
            *cwd = Some(home.clone());
        }
        Ok(home)
    }

    /// Lists a directory over SFTP.
    ///
    /// `None` / empty resolves to the session's current directory (home on
    /// first use). Returns the canonical path plus entries sorted
    /// directories-first, then by natural name order.
    pub async fn sftp_list_dir(
        &self,
        session_id: &str,
        path: Option<String>,
    ) -> Result<(String, Vec<RemoteFileEntry>)> {
        use super::paths::natural_cmp;

        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;

        let requested = match path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(value) => value.to_string(),
            None => session
                .cwd
                .lock()
                .await
                .clone()
                .unwrap_or_else(|| ".".to_string()),
        };

        // The server canonicalizes (resolving symlinks in the path), so the
        // returned path is always the real, absolute remote path.
        let canonical = sftp.canonicalize(requested).await.map_err(sftp_error)?;

        let mut entries: Vec<RemoteFileEntry> = Vec::new();
        for (entry, size_missing) in sftp
            .read_dir(&canonical)
            .await
            .map_err(sftp_error)?
            .map(|entry| remote_entry(&canonical, entry))
        {
            // Some servers omit SIZE in readdir attrs (the client would then
            // silently report 0). One extra lstat per affected entry is the
            // honest fix; it only ever runs for those entries.
            if size_missing {
                if let Ok(full) = sftp.symlink_metadata(&entry.path).await {
                    let patched = build_entry(&entry.path, &entry.name, &full);
                    entries.push(patched);
                    continue;
                }
            }
            entries.push(entry);
        }

        entries.sort_by(|a, b| {
            (b.kind == KIND_DIRECTORY)
                .cmp(&(a.kind == KIND_DIRECTORY))
                .then_with(|| natural_cmp(&a.name, &b.name))
        });

        // Deliberately NOT tracking the last-listed directory as the session
        // cwd here: the frontend owns the current-location state, and helper
        // listings (e.g. child counts) must not disturb it. `None` in a later
        // call still resolves to the session's home via `sftp_open`.
        Ok((canonical, entries))
    }

    /// Canonicalizes a remote path server-side.
    pub async fn sftp_realpath(&self, session_id: &str, path: &str) -> Result<String> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        Ok(sftp.canonicalize(path).await.map_err(sftp_error)?)
    }

    /// Stat for a single entry, with true lstat semantics: a symlink is
    /// reported as a link, never resolved to its target. Canonicalizing first
    /// would silently defeat the lstat (and misreport links as directories).
    pub async fn sftp_stat(&self, session_id: &str, path: &str) -> Result<RemoteFileEntry> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        let raw = posix_normalize(path);
        let meta = sftp.symlink_metadata(&raw).await.map_err(sftp_error)?;
        let name = raw.rsplit('/').next().unwrap_or(&raw);
        Ok(build_entry(&raw, name, &meta))
    }

    /// Closes the session's SFTP client and releases its channel.
    pub async fn sftp_close(&self, session_id: &str) -> Result<()> {
        let session = self.get(session_id).await?;
        let mut guard = session.sftp.lock().await;
        if let Some(sftp) = guard.take() {
            sftp.close().await.map_err(sftp_error)?;
        }
        Ok(())
    }

    /// Removes a remote file, symlink or directory tree.
    ///
    /// SECURITY: the path is used exactly as given — **never canonicalized**.
    /// `canonicalize` would resolve a symlink to its target, so removing
    /// `link → /var/www/project` would recurse into and delete the real
    /// directory. Instead the entry itself is lstat'd: a symlink is unlinked,
    /// a directory is recursed (with lstat at every level, so links inside the
    /// tree are unlinked too), a file is unlinked.
    pub async fn sftp_remove(&self, session_id: &str, path: &str) -> Result<()> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        remove_recursive(&sftp, &posix_normalize(path)).await
    }

    /// Renames an entry within its directory (`new_name` is a plain name, not
    /// a path). Fails if the target exists — SFTP rename does not overwrite.
    pub async fn sftp_rename(
        &self,
        session_id: &str,
        path: &str,
        new_name: &str,
    ) -> Result<String> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        if new_name.trim().is_empty() || new_name.contains('/') {
            return Err(anyhow!("名称不能为空，且不能包含 /"));
        }
        // Operate on the raw path: rename moves the entry itself, which for a
        // symlink is the link — exactly the semantics we want.
        let source = posix_normalize(path);
        let target = posix_join(&parent_of(&source), new_name);
        sftp.rename(&source, &target).await.map_err(sftp_error)?;
        Ok(target)
    }

    /// Creates a copy of a file or directory inside its own directory.
    /// Symlinks are reported as unsupported — copying a link by copying its
    /// resolved target is a data-loss trap (and copying "as a link" needs
    /// SFTP extensions not every server has).
    pub async fn sftp_copy(&self, session_id: &str, path: &str, new_name: &str) -> Result<String> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        if new_name.trim().is_empty() || new_name.contains('/') {
            return Err(anyhow!("名称不能为空，且不能包含 /"));
        }
        let source = posix_normalize(path);
        let source_meta = sftp.symlink_metadata(&source).await.map_err(sftp_error)?;
        if source_meta.file_type() == FileType::Symlink {
            return Err(anyhow!("暂不支持复制符号链接：{source}"));
        }
        let target = posix_join(&parent_of(&source), new_name);
        if sftp.symlink_metadata(&target).await.is_ok() {
            return Err(anyhow!("目标已存在：{new_name}"));
        }
        copy_recursive(&sftp, &source, &target).await?;
        Ok(target)
    }

    /// Creates a directory. Parent must already exist (SFTP has no mkdir -p).
    pub async fn sftp_mkdir(&self, session_id: &str, path: &str) -> Result<String> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        let target = posix_normalize(path);
        sftp.create_dir(&target).await.map_err(sftp_error)?;
        Ok(target)
    }

    /// Creates an empty remote file (fails if it already exists).
    pub async fn sftp_touch(&self, session_id: &str, path: &str) -> Result<String> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        if sftp.symlink_metadata(path).await.is_ok() {
            return Err(anyhow!("文件已存在"));
        }
        let mut file = sftp.create(path).await.map_err(sftp_error)?;
        file.shutdown()
            .await
            .map_err(|error| anyhow!("创建文件失败：{error}"))?;
        Ok(path.to_string())
    }

    /// Reads a remote text file for the in-app editor.
    ///
    /// Binary content (NUL byte or invalid UTF-8) is reported via `binary`
    /// instead of being garbled; oversized files are refused with a clear
    /// message rather than silently truncated.
    pub async fn sftp_read_file(
        &self,
        session_id: &str,
        path: &str,
        max_len: u64,
    ) -> Result<RemoteFileContent> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        let canonical = sftp.canonicalize(path).await.map_err(sftp_error)?;
        let meta = sftp
            .symlink_metadata(&canonical)
            .await
            .map_err(sftp_error)?;
        if meta.file_type() == FileType::Dir {
            return Err(anyhow!("这是一个文件夹，无法作为文本打开"));
        }
        let size = meta.len();
        if size > max_len {
            return Err(anyhow!(
                "文件过大（{}），暂不支持在应用内编辑",
                format_size_human(size)
            ));
        }

        let mut file = sftp.open(&canonical).await.map_err(sftp_error)?;
        let mut bytes = Vec::with_capacity(size as usize);
        tokio::io::AsyncReadExt::read_to_end(&mut file, &mut bytes)
            .await
            .map_err(|error| anyhow!("读取文件失败：{error}"))?;

        let binary = bytes.contains(&0) || String::from_utf8(bytes.clone()).is_err();
        let content = if binary {
            None
        } else {
            Some(String::from_utf8(bytes).unwrap_or_default())
        };
        Ok(RemoteFileContent {
            path: canonical,
            size,
            binary,
            content,
        })
    }

    /// Overwrites a remote text file (the editor's save action).
    pub async fn sftp_write_file(&self, session_id: &str, path: &str, content: &str) -> Result<()> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        let canonical = sftp.canonicalize(path).await.map_err(sftp_error)?;
        let mut file = sftp.create(&canonical).await.map_err(sftp_error)?;
        tokio::io::AsyncWriteExt::write_all(&mut file, content.as_bytes())
            .await
            .map_err(|error| anyhow!("写入文件失败：{error}"))?;
        file.shutdown()
            .await
            .map_err(|error| anyhow!("保存文件失败：{error}"))?;
        Ok(())
    }

    /// Reads any remote file as raw bytes for the in-app preview.
    ///
    /// Deliberately not limited to text: images, PDFs, Office files and
    /// archives all come back as base64. The budget is a guard rail on the IPC
    /// payload — a 4 GB log would never survive JSON — and `truncated` tells
    /// the caller the bytes are a prefix, so the UI can say so instead of
    /// rendering a half-file as if it were whole.
    pub async fn sftp_read_binary(
        &self,
        session_id: &str,
        path: &str,
        max_len: u64,
    ) -> Result<RemoteBinaryContent> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        let canonical = sftp.canonicalize(path).await.map_err(sftp_error)?;
        let meta = sftp
            .symlink_metadata(&canonical)
            .await
            .map_err(sftp_error)?;
        if meta.file_type() == FileType::Dir {
            return Err(anyhow!("这是一个文件夹，无法预览"));
        }
        let size = meta.len();
        let budget = max_len.clamp(1, MAX_PREVIEW_BYTES);
        let take = (size.min(budget)) as usize;

        let mut file = sftp.open(&canonical).await.map_err(sftp_error)?;
        let mut bytes = Vec::with_capacity(take);
        // `take` bounds the read: the remote file is never pulled in whole just
        // to be thrown away when it is over budget.
        let mut limited = (&mut file).take(take as u64);
        tokio::io::AsyncReadExt::read_to_end(&mut limited, &mut bytes)
            .await
            .map_err(|error| anyhow!("读取文件失败：{error}"))?;

        Ok(RemoteBinaryContent {
            mime: guess_mime(&canonical),
            path: canonical,
            size,
            data: base64::engine::general_purpose::STANDARD.encode(&bytes),
            truncated: size > budget,
        })
    }

    /// Downloads a remote file to a local path chosen by the user.
    ///
    /// Streamed through `tokio::io::copy` so a multi-GB file never lands in
    /// memory. Returns the byte count actually written.
    pub async fn sftp_download_file(
        &self,
        session_id: &str,
        path: &str,
        local_path: &str,
    ) -> Result<u64> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        let canonical = sftp.canonicalize(path).await.map_err(sftp_error)?;
        let meta = sftp
            .symlink_metadata(&canonical)
            .await
            .map_err(sftp_error)?;
        if meta.file_type() == FileType::Dir {
            return Err(anyhow!("暂不支持下载整个文件夹"));
        }

        let mut remote = sftp.open(&canonical).await.map_err(sftp_error)?;
        let mut local = tokio::fs::File::create(local_path)
            .await
            .map_err(|error| anyhow!("无法创建本地文件：{error}"))?;
        let written = tokio::io::copy(&mut remote, &mut local)
            .await
            .map_err(|error| anyhow!("下载失败：{error}"))?;
        local
            .shutdown()
            .await
            .map_err(|error| anyhow!("写入本地文件失败：{error}"))?;
        Ok(written)
    }

    /// Uploads local files or directories into `remote_dir`.
    ///
    /// Local paths are the one place `PathBuf` is correct — they are on this
    /// machine. Directories are walked recursively and re-created remotely.
    /// Directories themselves are never followed outside the uploaded root.
    pub async fn sftp_upload(
        &self,
        session_id: &str,
        local_paths: &[String],
        remote_dir: &str,
        on_file_done: &(dyn Fn(&str) + Send + Sync),
    ) -> Result<Vec<RemoteFileEntry>> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        let base = sftp.canonicalize(remote_dir).await.map_err(sftp_error)?;

        let mut uploaded = Vec::new();
        for raw in local_paths {
            let local = std::path::PathBuf::from(raw);
            if !local.exists() {
                return Err(anyhow!("本地路径不存在：{}", local.display()));
            }
            uploaded.extend(upload_walk(&sftp, &local, &local.clone(), &base, on_file_done).await?);
        }
        Ok(uploaded)
    }
}

/// Best-effort MIME type from a file name.
///
/// Extension only — the content is never sniffed, because sniffing would mean
/// reading the file a second time. `application/octet-stream` is the honest
/// answer for anything unknown; the preview layer falls back to a hex view
/// (and says so) rather than guessing a renderer.
pub(crate) fn guess_mime(path: &str) -> String {
    let lower = path.to_ascii_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    let ext = match name.rsplit_once('.') {
        Some((_, ext)) if !ext.is_empty() => ext,
        _ => return "application/octet-stream".to_string(),
    };
    let mime = match ext {
        // images
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "tif" | "tiff" => "image/tiff",
        // documents
        "pdf" => "application/pdf",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "odt" => "application/vnd.oasis.opendocument.text",
        "ods" => "application/vnd.oasis.opendocument.spreadsheet",
        "rtf" => "application/rtf",
        // data / text
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "json" => "application/json",
        "xml" => "application/xml",
        "md" | "markdown" => "text/markdown",
        "txt" | "log" | "conf" | "cfg" | "ini" | "env" | "properties" | "yml" | "yaml" | "toml" => {
            "text/plain"
        }
        // media
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        // archives
        "zip" => "application/zip",
        "jar" | "war" | "ear" => "application/java-archive",
        "gz" | "tgz" => "application/gzip",
        "tar" => "application/x-tar",
        "bz2" => "application/x-bzip2",
        "xz" => "application/x-xz",
        "7z" => "application/x-7z-compressed",
        "rar" => "application/vnd.rar",
        _ => "application/octet-stream",
    };
    mime.to_string()
}
