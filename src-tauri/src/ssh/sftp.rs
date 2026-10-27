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

/// Maps SFTP client errors onto user-facing messages.
///
/// 服务器把协议错误码的名字当错误说明返回（`No such file` /
/// `Permission denied`），原样透给用户等于没说 —— 用户既不知道哪条路径，
/// 也不知道该怎么办。这里按状态码翻成人话，并带上**出错的远程路径**
/// （`path`）：报错时第一个要回答的问题永远是"哪个路径"。
///
/// 确实没有具体路径的调用（如关闭会话）传空串，消息里就不带路径段。
pub(crate) fn sftp_error(path: &str, error: russh_sftp::client::error::Error) -> anyhow::Error {
    use russh_sftp::client::error::Error as SftpError;
    let at = if path.is_empty() {
        String::new()
    } else {
        format!("：{path}")
    };
    match &error {
        SftpError::Status(status) => match status.status_code {
            SftpStatusCode::NoSuchFile => anyhow!("路径不存在或已被删除{at}"),
            SftpStatusCode::PermissionDenied => anyhow!("权限不足，无法访问{at}"),
            SftpStatusCode::OpUnsupported => anyhow!("服务器不支持该操作{at}"),
            SftpStatusCode::NoConnection | SftpStatusCode::ConnectionLost => {
                anyhow!("SFTP 连接已断开{at}")
            }
            SftpStatusCode::Failure => {
                anyhow!("服务器拒绝了该操作{at}（{}）", status.error_message)
            }
            _ => anyhow!("SFTP 错误{at}：{}", status.error_message),
        },
        _ => anyhow!("SFTP 错误{at}：{error}"),
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

/// 目录大小遍历专用的条目：只有遍历需要的三个字段。
///
/// 不复用 [`RemoteFileEntry`] 是有意的 —— 那会多算 permissions / modified /
/// hidden 等展示字段，还要为此做一次 `canonicalize`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WalkEntry {
    pub name: String,
    /// `KIND_DIRECTORY` / `KIND_FILE` / 其它（符号链接等，不跟随）。
    pub kind: String,
    /// 服务器未上报时为 `None`（普通文件会补查，目录不补）。
    pub size: Option<u64>,
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
        let meta = sftp
            .symlink_metadata(path)
            .await
            .map_err(|error| sftp_error(path, error))?;
        if meta.file_type() != FileType::Dir {
            sftp.remove_file(path)
                .await
                .map_err(|error| sftp_error(path, error))?;
            return Ok(());
        }
        for entry in sftp
            .read_dir(path)
            .await
            .map_err(|error| sftp_error(path, error))?
        {
            let child = posix_join(path, &entry.file_name());
            // Use lstat so a symlink inside the tree is unlinked, not followed.
            remove_recursive(sftp, &child).await?;
        }
        sftp.remove_dir(path)
            .await
            .map_err(|error| sftp_error(path, error))?;
        Ok(())
    })
}

fn copy_recursive<'a>(
    sftp: &'a SftpSession,
    from: &'a str,
    to: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
    Box::pin(async move {
        let meta = sftp
            .symlink_metadata(from)
            .await
            .map_err(|error| sftp_error(from, error))?;
        match meta.file_type() {
            FileType::Dir => {
                sftp.create_dir(to)
                    .await
                    .map_err(|error| sftp_error(to, error))?;
                for entry in sftp
                    .read_dir(from)
                    .await
                    .map_err(|error| sftp_error(from, error))?
                {
                    let child_from = posix_join(from, &entry.file_name());
                    let child_to = posix_join(to, &entry.file_name());
                    copy_recursive(sftp, &child_from, &child_to).await?;
                }
                Ok(())
            }
            FileType::Symlink => Err(anyhow!("暂不支持复制符号链接：{from}")),
            _ => {
                let mut source = sftp
                    .open(from)
                    .await
                    .map_err(|error| sftp_error(from, error))?;
                let mut target = sftp
                    .create(to)
                    .await
                    .map_err(|error| sftp_error(to, error))?;
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
                sftp.create_dir(&remote_path)
                    .await
                    .map_err(|error| sftp_error(&remote_path, error))?;
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
        let mut remote = sftp
            .create(&remote_path)
            .await
            .map_err(|error| sftp_error(&remote_path, error))?;
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
        let home = sftp
            .canonicalize(".")
            .await
            .map_err(|error| sftp_error(".", error))?;
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
        let canonical = sftp
            .canonicalize(requested.as_str())
            .await
            .map_err(|error| sftp_error(&requested, error))?;

        let mut entries: Vec<RemoteFileEntry> = Vec::new();
        // 缺失 SIZE 的条目下标。先收集、再并发补查 —— 以前是边读边逐个
        // `await`，N 个缺失就是 N 次**串行**往返，首屏被放大成 N × RTT。
        let mut missing_sizes: Vec<usize> = Vec::new();
        for (entry, size_missing) in sftp
            .read_dir(&canonical)
            .await
            .map_err(|error| sftp_error(&canonical, error))?
            .map(|entry| remote_entry(&canonical, entry))
        {
            if size_missing {
                missing_sizes.push(entries.len());
            }
            entries.push(entry);
        }

        // 有限并发补查：每批 8 个，批间串行。
        // 不无限并发 —— 同一条 SFTP 通道上打满请求反而会让交互变慢。
        const STAT_CONCURRENCY: usize = 8;
        for chunk in missing_sizes.chunks(STAT_CONCURRENCY) {
            let mut set = tokio::task::JoinSet::new();
            for &index in chunk {
                let sftp = Arc::clone(&sftp);
                let path = entries[index].path.clone();
                let name = entries[index].name.clone();
                set.spawn(async move {
                    let meta = sftp.symlink_metadata(&path).await;
                    (index, path, name, meta)
                });
            }
            while let Some(joined) = set.join_next().await {
                // 单个条目查不到就保留原样（大小未知），不影响整份列表。
                let Ok((index, path, name, Ok(meta))) = joined else {
                    continue;
                };
                entries[index] = build_entry(&path, &name, &meta);
            }
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
        Ok(sftp
            .canonicalize(path)
            .await
            .map_err(|error| sftp_error(path, error))?)
    }

    /// Stat for a single entry, with true lstat semantics: a symlink is
    /// reported as a link, never resolved to its target. Canonicalizing first
    /// would silently defeat the lstat (and misreport links as directories).
    pub async fn sftp_stat(&self, session_id: &str, path: &str) -> Result<RemoteFileEntry> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        let raw = posix_normalize(path);
        let meta = sftp
            .symlink_metadata(&raw)
            .await
            .map_err(|error| sftp_error(&raw, error))?;
        let name = raw.rsplit('/').next().unwrap_or(&raw);
        Ok(build_entry(&raw, name, &meta))
    }

    /// Closes the session's SFTP client and releases its channel.
    pub async fn sftp_close(&self, session_id: &str) -> Result<()> {
        let session = self.get(session_id).await?;
        let mut guard = session.sftp.lock().await;
        if let Some(sftp) = guard.take() {
            // 关闭会话通道没有"目标路径"可报，传空串。
            sftp.close().await.map_err(|error| sftp_error("", error))?;
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
        sftp.rename(&source, &target)
            .await
            .map_err(|error| sftp_error(&source, error))?;
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
        let source_meta = sftp
            .symlink_metadata(&source)
            .await
            .map_err(|error| sftp_error(&source, error))?;
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
        sftp.create_dir(&target)
            .await
            .map_err(|error| sftp_error(&target, error))?;
        Ok(target)
    }

    /// 列出目录，**只取大小遍历需要的字段**。
    ///
    /// 与 [`Self::sftp_list_dir`] 相比省掉的活：
    /// * 不 `canonicalize`（调用方给的是拼接出来的真实路径）；
    /// * 不构建 `RemoteFileEntry`（permissions / modified / hidden）；
    /// * **不排序** —— 遍历不需要顺序，排序是 O(n log n)；
    /// * **不对缺失 size 的目录做 lstat** —— 目录本身的大小对求和没用。
    ///
    /// 唯一保留的额外请求：缺失 size 的**普通文件**补一次 `symlink_metadata`，
    /// 否则会少算字节。符号链接不跟随、不补查。
    pub async fn sftp_walk_dir(&self, session_id: &str, path: &str) -> Result<Vec<WalkEntry>> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        let mut out: Vec<WalkEntry> = Vec::with_capacity(32);
        let mut missing: Vec<usize> = Vec::new();

        for entry in sftp
            .read_dir(path)
            .await
            .map_err(|error| sftp_error(path, error))?
        {
            let name = entry.file_name();
            let meta = entry.metadata();
            let kind = sftp_kind(meta.file_type()).to_string();
            let size = meta.size;
            if size.is_none() && kind == KIND_FILE {
                missing.push(out.len());
            }
            out.push(WalkEntry { name, kind, size });
        }

        // 普通文件补 size：与列目录一样按批并发。
        const STAT_CONCURRENCY: usize = 8;
        for chunk in missing.chunks(STAT_CONCURRENCY) {
            let mut set = tokio::task::JoinSet::new();
            for &index in chunk {
                let sftp = Arc::clone(&sftp);
                let full = posix_join(path, &out[index].name);
                set.spawn(async move {
                    let size = sftp
                        .symlink_metadata(&full)
                        .await
                        .map(|meta| meta.len())
                        .ok();
                    (index, size)
                });
            }
            while let Some(joined) = set.join_next().await {
                if let Ok((index, Some(size))) = joined {
                    out[index].size = Some(size);
                }
            }
        }
        Ok(out)
    }

    /// Creates an empty remote file (fails if it already exists).
    pub async fn sftp_touch(&self, session_id: &str, path: &str) -> Result<String> {
        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        if sftp.symlink_metadata(path).await.is_ok() {
            return Err(anyhow!("文件已存在"));
        }
        let mut file = sftp
            .create(path)
            .await
            .map_err(|error| sftp_error(path, error))?;
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
        let canonical = sftp
            .canonicalize(path)
            .await
            .map_err(|error| sftp_error(path, error))?;
        let meta = sftp
            .symlink_metadata(&canonical)
            .await
            .map_err(|error| sftp_error(&canonical, error))?;
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

        let mut file = sftp
            .open(&canonical)
            .await
            .map_err(|error| sftp_error(&canonical, error))?;
        let mut bytes = Vec::with_capacity(size as usize);
        // `take(max_len + 1)`：元数据可能在检查之后过期（文件正在被写），
        // 单靠 size 判断不能阻止 `read_to_end` 把增长后的内容全部读进内存。
        let mut limited = tokio::io::AsyncReadExt::take(&mut file, max_len + 1);
        tokio::io::AsyncReadExt::read_to_end(&mut limited, &mut bytes)
            .await
            .map_err(|error| anyhow!("读取文件失败：{error}"))?;
        if bytes.len() as u64 > max_len {
            return Err(anyhow!(
                "文件在读取期间变大了（超过 {}），已中止读取",
                format_size_human(max_len)
            ));
        }

        // 借用校验，**不克隆**整份内容：以前 `String::from_utf8(bytes.clone())`
        // 为了判 UTF-8 复制了一遍文件，大文件直接双倍内存。
        let binary = bytes.contains(&0) || std::str::from_utf8(&bytes).is_err();
        let content = if binary {
            None
        } else {
            // 上面已验证是合法 UTF-8，这里 move 进去，不会再分配。
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
        let canonical = sftp
            .canonicalize(path)
            .await
            .map_err(|error| sftp_error(path, error))?;
        atomic_write(&sftp, &canonical, content.as_bytes()).await
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
        let canonical = sftp
            .canonicalize(path)
            .await
            .map_err(|error| sftp_error(path, error))?;
        let meta = sftp
            .symlink_metadata(&canonical)
            .await
            .map_err(|error| sftp_error(&canonical, error))?;
        if meta.file_type() == FileType::Dir {
            return Err(anyhow!("这是一个文件夹，无法预览"));
        }
        let size = meta.len();
        let budget = max_len.clamp(1, MAX_PREVIEW_BYTES);
        let take = (size.min(budget)) as usize;

        let mut file = sftp
            .open(&canonical)
            .await
            .map_err(|error| sftp_error(&canonical, error))?;
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
        let canonical = sftp
            .canonicalize(path)
            .await
            .map_err(|error| sftp_error(path, error))?;
        let meta = sftp
            .symlink_metadata(&canonical)
            .await
            .map_err(|error| sftp_error(&canonical, error))?;
        if meta.file_type() == FileType::Dir {
            return Err(anyhow!("暂不支持下载整个文件夹"));
        }

        let mut remote = sftp
            .open(&canonical)
            .await
            .map_err(|error| sftp_error(&canonical, error))?;
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
        let base = sftp
            .canonicalize(remote_dir)
            .await
            .map_err(|error| sftp_error(remote_dir, error))?;

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

    /// 上传单个文件：**`.part` 临时文件 → 流式写入 → 关闭 → 同目录原子改名**。
    ///
    /// 这是制品导入需要的事务语义：中途失败绝不在目标目录留下半截文件 ——
    /// 目标名要么是完整内容，要么根本不存在。返回实际写入的字节数与
    /// SHA-256，由调用方与制品指纹比对（哈希不符就不改名，说明传输坏了）。
    ///
    /// 流式分块（[`UPLOAD_CHUNK_BYTES`]）而不是一次性读入内存：制品动辄几百
    /// 兆，整份驻留内存没有意义。
    pub async fn sftp_upload_file_atomic(
        &self,
        session_id: &str,
        local_path: &std::path::Path,
        remote_dir: &str,
        file_name: &str,
        on_progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> Result<UploadOutcome> {
        use sha2::{Digest, Sha256};

        let name = file_name.trim();
        if name.is_empty() || name.contains('/') || name.contains('\\') {
            return Err(anyhow!("文件名不能为空，且不能包含路径分隔符"));
        }
        if name.chars().any(|ch| ch.is_control()) {
            return Err(anyhow!("文件名不能包含控制字符"));
        }
        crate::safe::validate_abs_path(remote_dir, "目标目录")?;

        let session = self.get(session_id).await?;
        let sftp = session.sftp_client().await?;
        let directory = remote_dir.trim_end_matches('/');
        let part_path = format!("{directory}/{name}.part");
        let final_path = format!("{directory}/{name}");
        let total = tokio::fs::metadata(local_path)
            .await
            .map(|meta| meta.len())
            .unwrap_or(0);

        let mut local = tokio::fs::File::open(local_path)
            .await
            .map_err(|error| anyhow!("无法读取本地文件：{error}"))?;
        let mut remote = sftp
            .create(&part_path)
            .await
            .map_err(|error| sftp_error(&part_path, error))?;

        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; UPLOAD_CHUNK_BYTES];
        let mut written: u64 = 0;
        loop {
            let read = match local.read(&mut buffer).await {
                Ok(0) => break,
                Ok(read) => read,
                Err(error) => {
                    let _ = sftp.remove_file(&part_path).await;
                    return Err(anyhow!("读取本地文件失败（已清理临时文件）：{error}"));
                }
            };
            hasher.update(&buffer[..read]);
            if let Err(error) =
                tokio::io::AsyncWriteExt::write_all(&mut remote, &buffer[..read]).await
            {
                let _ = sftp.remove_file(&part_path).await;
                return Err(anyhow!("上传失败（已清理临时文件）：{error}"));
            }
            written += read as u64;
            on_progress(written, total);
        }
        if let Err(error) = remote.shutdown().await {
            let _ = sftp.remove_file(&part_path).await;
            return Err(anyhow!("上传未完成（已清理临时文件）：{error}"));
        }

        let digest = hasher.finalize();
        let mut sha256 = String::with_capacity(64);
        for byte in digest.as_slice() {
            sha256.push_str(&format!("{byte:02x}"));
        }

        // 只有完整写完才改名 —— 改名前目标名不存在，所以这一步是原子的。
        if let Err(error) = sftp.rename(&part_path, &final_path).await {
            let _ = sftp.remove_file(&part_path).await;
            return Err(sftp_error(&part_path, error));
        }
        Ok(UploadOutcome {
            remote_path: final_path,
            sha256,
            size_bytes: written,
        })
    }
}

/// 把内容**原子地**写到 `canonical`。
///
/// # 为什么不能直接 `create()` 写
///
/// `create()` 对已存在的文件会**先截断**。改 `nginx.conf` 时断网，原文件
/// 就变成空文件或半截文件 —— 这不是"保存失败"，是"原配置被破坏"。
///
/// # 顺序（跨 SFTP 服务器都成立）
///
/// 1. 写到同目录临时文件（写坏只坏临时文件）；
/// 2. 校验字节数；
/// 3. 原文件改名 `.bls-bak`（原子），临时文件改名目标（原子）；
/// 4. 成功后删备份；任一步失败都把备份改回原名。
///
/// 不能"直接 rename 覆盖目标"：SFTP v3 的 rename 不覆盖已存在文件
/// （见 [`SshSessionManager::sftp_rename`] 的说明）。
///
/// 最坏情况下原内容仍在 `.bls-bak` 里，不会凭空消失。
async fn atomic_write(sftp: &SftpSession, canonical: &str, content: &[u8]) -> Result<()> {
    // **唯一**的临时名与备份名：两个编辑器同时保存同一个文件时，固定名字
    // 会让它们互相覆盖对方正在写的临时文件。
    //
    // 代价：进程崩溃可能留下 `.bls-tmp-<uuid>` 残留文件。这不影响正确性
    // （下次保存用新名字），但会占空间 —— 清理是运维层面的事，不做自动删除
    // 以免误删别的会话正在写的文件。
    let unique = uuid::Uuid::new_v4();
    let temp = format!("{canonical}.bls-tmp-{unique}");
    let backup = format!("{canonical}.bls-bak-{unique}");

    // 同一个 uuid 不可能重复，但保守起见先清一次（重试时留下的）。
    let _ = sftp.remove_file(&temp).await;

    let written: Result<()> = async {
        let mut file = sftp
            .create(&temp)
            .await
            .map_err(|error| sftp_error(&temp, error))?;
        if let Err(error) = tokio::io::AsyncWriteExt::write_all(&mut file, content).await {
            let _ = file.shutdown().await;
            return Err(anyhow!("写入临时文件失败：{error}"));
        }
        if let Err(error) = file.shutdown().await {
            return Err(anyhow!("写入临时文件失败：{error}"));
        }
        let meta = sftp
            .metadata(&temp)
            .await
            .map_err(|error| sftp_error(&temp, error))?;
        if meta.len() != content.len() as u64 {
            return Err(anyhow!(
                "写入不完整（{} / {} 字节），原文件未改动",
                meta.len(),
                content.len()
            ));
        }
        Ok(())
    }
    .await;

    if let Err(error) = written {
        let _ = sftp.remove_file(&temp).await;
        return Err(error);
    }

    // 原文件属性：既用来判断"是否存在"，也用来把权限复制到临时文件。
    let original = sftp.symlink_metadata(canonical).await.ok();
    let had_target = original.is_some();
    if had_target {
        // rename 保留的是**临时文件**的权限。不显式复制，0600 的私钥 / 配置
        // 会被换成新建文件的默认权限（通常 0644）—— 这是一次静默的提权。
        if let Some(permissions) = original.as_ref().and_then(|meta| meta.permissions) {
            let attrs = russh_sftp::protocol::FileAttributes {
                permissions: Some(permissions),
                ..Default::default()
            };
            if sftp.set_metadata(&temp, attrs).await.is_err() {
                // 严格权限（如 0600 私钥 / 0700 脚本）绝不能被静默放宽：
                // 宁可不保存，也不能把"只有所有者可读"变成"所有人可读"。
                // 组/其他本来就有权限的文件，放宽风险小，继续保存。
                if permissions & 0o077 == 0 {
                    let _ = sftp.remove_file(&temp).await;
                    return Err(anyhow!(
                        "无法保留原文件权限（{:04o}），已取消保存",
                        permissions
                    ));
                }
            }
        }
        let _ = sftp.remove_file(&backup).await;
        if let Err(error) = sftp.rename(canonical, &backup).await {
            let _ = sftp.remove_file(&temp).await;
            return Err(anyhow!("无法替换原文件（原内容未改动）：{error}"));
        }
    }

    if let Err(error) = sftp.rename(&temp, canonical).await {
        if had_target {
            // 把原文件改回去：宁可这次保存失败，也不能让配置消失。
            let _ = sftp.rename(&backup, canonical).await;
        }
        let _ = sftp.remove_file(&temp).await;
        return Err(anyhow!("替换文件失败（已恢复原内容）：{error}"));
    }

    if had_target {
        let _ = sftp.remove_file(&backup).await;
    }
    Ok(())
}

/// 上传分块大小。
const UPLOAD_CHUNK_BYTES: usize = 64 * 1024;

/// 一次原子上传的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadOutcome {
    /// 目标文件的最终远程绝对路径。
    pub remote_path: String,
    /// 实际上传内容的 SHA-256（十六进制小写）。
    pub sha256: String,
    pub size_bytes: u64,
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
