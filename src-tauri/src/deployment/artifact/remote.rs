//! 远程侧：服务器已有目录的**只读**清单来源 + 制品上传的事务语义。
//!
//! # 为什么复用而不是另起一套
//!
//! 上传走的是既有的 [`SshSessionManager`] / SFTP 子系统（[`SshSessionManager::
//! sftp_upload_file_atomic`]），本模块只补两件部署特有的语义：
//!
//! 1. **`.part` → 校验 → 原子改名**：目标名要么是完整内容，要么不存在；
//!    哈希对不上就把已经传上去的文件删掉，绝不留下"看起来对、其实坏了"的制品。
//! 2. **服务器目录只读清点**：递归列目录有硬上限，**不下载内容**，
//!    因此指纹口径是 `RemoteListing`（路径 + 大小），密钥扫描只覆盖文件名。
//!    这一点必须如实写进识别结果，不能让用户以为内容被检查过了。

use std::path::Path;

use super::source::{ContentSource, SourceEntry};
use crate::ssh::{SshSessionManager, KIND_DIRECTORY, KIND_FILE, KIND_OTHER, KIND_SYMLINK};

/// 服务器上已有目录的只读清单来源。
///
/// **刻意无法读取内容**：清单是 SFTP 列目录的结果，`read_many` 永远返回空。
/// 这不是缺陷 —— 说好了"不下载"，就不该有一个能被悄悄用起来的读接口。
#[derive(Debug, Clone)]
pub struct RemoteListingSource {
    entries: Vec<SourceEntry>,
}

impl RemoteListingSource {
    pub fn new(entries: Vec<SourceEntry>) -> Self {
        Self { entries }
    }
}

impl ContentSource for RemoteListingSource {
    fn entries(&self) -> &[SourceEntry] {
        &self.entries
    }

    fn read_many(&self, _wanted: &[String], _limit: usize) -> Vec<(String, Vec<u8>)> {
        Vec::new()
    }
}

/// 递归列出一个远程目录（只读、广度优先、有条目数与深度上限）。
///
/// 服务器上的目录可能就是 `/`，所以上限不是可选项。
pub async fn list_remote_tree(
    ssh: &SshSessionManager,
    session_id: &str,
    root: &str,
    max_entries: usize,
    max_depth: usize,
) -> Result<Vec<SourceEntry>, String> {
    let normalized_root = root.trim_end_matches('/');
    let prefix = format!("{normalized_root}/");
    let mut queue: Vec<(String, usize)> = vec![(normalized_root.to_string(), 0)];
    let mut out: Vec<SourceEntry> = Vec::new();

    while let Some((directory, depth)) = queue.pop() {
        if out.len() >= max_entries {
            break;
        }
        let (_canonical, entries) = ssh
            .sftp_list_dir(session_id, Some(directory.clone()))
            .await
            .map_err(|error| error.to_string())?;
        for entry in entries {
            if out.len() >= max_entries {
                break;
            }
            let relative = entry
                .path
                .strip_prefix(&prefix)
                .unwrap_or(entry.path.as_str())
                .trim_start_matches('/')
                .replace('\\', "/");
            if relative.is_empty() {
                continue;
            }
            match entry.kind.as_str() {
                KIND_DIRECTORY => {
                    if depth >= max_depth {
                        continue;
                    }
                    out.push(SourceEntry {
                        path: relative,
                        size: 0,
                        is_dir: true,
                    });
                    queue.push((entry.path.clone(), depth + 1));
                }
                KIND_FILE => out.push(SourceEntry {
                    path: relative,
                    size: entry.size,
                    is_dir: false,
                }),
                // 符号链接与其它类型：只登记，绝不进入（跟着走就可能把 /etc 卷进来）。
                KIND_SYMLINK | KIND_OTHER => out.push(SourceEntry {
                    path: relative,
                    size: 0,
                    is_dir: false,
                }),
                _ => {}
            }
        }
    }
    out.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(out)
}

/// 上传制品并校验哈希。
///
/// 上传本身由 SFTP 层完成（`.part` → 流式 → 原子改名）。这里多做的唯一一件事
/// 是**把上传后的哈希与制品指纹比对**：不一致说明传输损坏或本地文件在确认之后
/// 又被改过，此时删掉刚传上去的文件并报错 —— 宁可重传，也不要留下坏制品。
#[allow(clippy::too_many_arguments)]
pub async fn upload_artifact(
    ssh: &SshSessionManager,
    session_id: &str,
    local_path: &Path,
    remote_dir: &str,
    file_name: &str,
    expected_sha256: Option<&str>,
    on_progress: &(dyn Fn(u64, u64) + Send + Sync),
) -> Result<crate::ssh::UploadOutcome, String> {
    let outcome = ssh
        .sftp_upload_file_atomic(session_id, local_path, remote_dir, file_name, on_progress)
        .await
        .map_err(|error| error.to_string())?;

    if let Some(expected) = expected_sha256 {
        if !expected.trim().is_empty() && !expected.eq_ignore_ascii_case(&outcome.sha256) {
            let _ = ssh.sftp_remove(session_id, &outcome.remote_path).await;
            return Err(
                "上传内容与制品指纹不一致（已删除远端文件），请重新分析后再上传".to_string(),
            );
        }
    }
    Ok(outcome)
}
