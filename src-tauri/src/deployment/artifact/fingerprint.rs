//! 内容指纹：Artifact 与内容哈希绑定，文件一变分析立即失效。
//!
//! # 三种来源，三种"内容"的定义
//!
//! | 来源 | 哈希对象 | 为什么 |
//! | --- | --- | --- |
//! | 单个文件（zip/jar/二进制） | 文件字节 | 最简单也最强：字节变一点就不同 |
//! | 目录 | 排序后的"清单"（每条：相对路径 + 大小 + 该文件自身的 SHA-256） | 目录没有单一字节流，清单是对内容完全确定的摘要；mtime 不参与（重新 checkout 不该让分析失效） |
//! | 镜像引用 | 引用字符串本身 | 我们**不去查 registry**，所以只能对"引用"负责；`basis` 字段会如实说明，UI 显示"镜像 digest 尚未确认" |
//!
//! 远程目录（服务器已有目录）用的是**清单**口径：只列路径 + 大小（不下载内容），
//! 因此 `basis = RemoteListing` —— 说明"这次比对的是目录结构"，不是内容。

use std::fs::File;
use std::io::Read;
use std::path::Path;

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

use super::limits;
use super::model::{ArtifactFingerprint, FingerprintBasis};
use super::source::{ContentSource, SourceEntry};

/// 计算一个文件的 SHA-256（流式，分块读）。
///
/// 大文件不会整块进内存：每块 [`limits::HASH_CHUNK_BYTES`]，
/// 顺便通过 `on_progress` 把已处理字节推给任务进度。
pub fn hash_file(path: &Path, on_progress: &mut dyn FnMut(u64)) -> Result<(String, u64)> {
    let mut file = File::open(path).with_context(|| format!("无法读取：{}", path.display()))?;
    hash_reader(&mut file, on_progress)
}

/// 流式计算任意 reader 的 SHA-256，返回（十六进制摘要，字节数）。
pub fn hash_reader(
    reader: &mut dyn Read,
    on_progress: &mut dyn FnMut(u64),
) -> Result<(String, u64)> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; limits::HASH_CHUNK_BYTES];
    let mut total: u64 = 0;
    loop {
        let read = reader.read(&mut buffer).context("读取制品内容失败")?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
        on_progress(total);
    }
    Ok((hex(&hasher.finalize()), total))
}

/// 字节数组的 SHA-256（掩码证据、清单条目用）。
pub fn hash_bytes(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 目录 / 归档的清单指纹。
///
/// 归档：直接哈希压缩包字节（最有说服力 —— 用户手里那个文件是什么就是什么）。
/// 目录：逐文件算哈希，再对"路径 + 大小 + 文件哈希"的规范化串求整体哈希。
pub fn hash_source(
    source: &dyn ContentSource,
    on_progress: &mut dyn FnMut(u64),
) -> (String, u64, u64) {
    let entries = source.entries();
    let mut manifest = Sha256::new();
    let mut bytes_processed: u64 = 0;

    // 目录来源：按路径排序后再算，保证同一份内容在任何机器上得到同一个指纹。
    let mut sorted: Vec<&SourceEntry> = entries.iter().filter(|entry| !entry.is_dir).collect();
    sorted.sort_by(|left, right| left.path.cmp(&right.path));

    for entry in sorted {
        // 逐个文件读内容：只读前 MAX_FILE_BYTES（清点时已保证不超），
        // 单文件超上限的情况由 inventory 的 Critical 发现兜住。
        let contents = source.read_many(&[entry.path.clone()], usize::MAX.min(i32::MAX as usize));
        let Some((_, bytes)) = contents.into_iter().next() else {
            // 读不到（权限 / 归档里加密）：**不假装它没变** —— 把路径与大小写进清单，
            // 并在整体哈希里标记为 unreadable，这样该文件一旦可读，指纹必然变化。
            manifest.update(format!("unreadable\0{}\0{}\n", entry.path, entry.size).as_bytes());
            continue;
        };
        let file_hash = hash_bytes(&bytes);
        manifest.update(format!("{}\0{}\0{}\n", entry.path, entry.size, file_hash).as_bytes());
        bytes_processed += bytes.len() as u64;
        on_progress(bytes_processed);
    }

    (
        hex(&manifest.finalize()),
        bytes_processed,
        entries.len() as u64,
    )
}

/// 整装指纹。
pub fn fingerprint_for(
    basis: FingerprintBasis,
    sha256: String,
    size_bytes: u64,
    entry_count: u64,
    newest_mtime_ms: Option<i64>,
    now: i64,
) -> ArtifactFingerprint {
    ArtifactFingerprint {
        sha256,
        size_bytes,
        entry_count,
        newest_mtime_ms,
        computed_at: now,
        algorithm: "sha256".to_string(),
        basis,
    }
}

/// 镜像引用 / 远程清单的"引用型"指纹（不做内容读取）。
pub fn reference_fingerprint(
    reference: &str,
    basis: FingerprintBasis,
    now: i64,
) -> ArtifactFingerprint {
    fingerprint_for(
        basis,
        hash_bytes(reference.as_bytes()),
        reference.len() as u64,
        0,
        None,
        now,
    )
}

/// 目录里最新的 mtime（用于展示"这是什么时候的产物"，不参与指纹判定）。
pub fn newest_mtime(root: &Path) -> Option<i64> {
    let mut newest: Option<i64> = None;
    let walker = walk(root, 0, &mut newest);
    let _ = walker;
    newest
}

fn walk(dir: &Path, depth: usize, newest: &mut Option<i64>) -> Option<()> {
    if depth > limits::MAX_DEPTH {
        return None;
    }
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            walk(&path, depth + 1, newest);
            continue;
        }
        if let Ok(modified) = meta.modified() {
            if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
                let millis = duration.as_millis() as i64;
                if newest.is_none_or(|current| millis > current) {
                    *newest = Some(millis);
                }
            }
        }
    }
    Some(())
}
