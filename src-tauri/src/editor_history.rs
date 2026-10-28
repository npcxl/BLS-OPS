//! 编辑器历史版本 —— 保存在**本机**，不落到用户服务器上。
//!
//! 每次覆盖远程文件之前留一份"被覆盖的内容"，保留最近 [`HISTORY_KEEP`] 份。
//! 位置：`<应用数据目录>/editor-history/<path-hash>/<时间戳>.txt`。
//!
//! 为什么不在服务器上建 `.history` 目录：运维工具不该往别人的机器上扔隐藏
//! 目录；而且历史属于"这个人本机的操作"，换台机器不该跟着走。
use anyhow::{anyhow, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// 每个文件保留的历史份数。
pub const HISTORY_KEEP: usize = 5;
/// 单份历史上限，超过的（本来也打不开编辑）不记录。
const MAX_ENTRY_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct EditorHistoryEntry {
    /// 文件名里的时间戳（毫秒），前端按它取用。
    pub id: String,
    pub saved_at: i64,
    pub size: u64,
}

/// 远程路径 → 固定的目录名。用哈希而不是原路径：路径里有 `/`、`..` 之类，
/// 直接当目录名会被穿越出去。
fn dir_for(root: &Path, remote_path: &str) -> PathBuf {
    root.join("editor-history").join(&hash(remote_path)[..16])
}

fn hash(value: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(value.as_bytes());
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 记录一次"保存前的内容"。`content` 是被覆盖的旧内容。
pub fn record(root: &Path, remote_path: &str, content: &str) -> Result<()> {
    if content.len() as u64 > MAX_ENTRY_BYTES {
        return Ok(());
    }
    let dir = dir_for(root, remote_path);
    std::fs::create_dir_all(&dir)?;
    // 同一毫秒内连续保存会撞文件名；顺序试探到空位，保证每份历史独立。
    let mut stamp = chrono::Utc::now().timestamp_millis();
    loop {
        let path = dir.join(format!("{stamp}.txt"));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
        {
            Ok(mut file) => {
                use std::io::Write;
                file.write_all(content.as_bytes())?;
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                stamp += 1;
            }
            Err(error) => return Err(error.into()),
        }
    }
    prune(&dir);
    Ok(())
}

pub fn list(root: &Path, remote_path: &str) -> Result<Vec<EditorHistoryEntry>> {
    let dir = dir_for(root, remote_path);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        // 没有历史不是错误：第一次编辑就该是空列表。
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(stem) = name.strip_suffix(".txt") else {
            continue;
        };
        let Ok(saved_at) = stem.parse::<i64>() else {
            continue;
        };
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        out.push(EditorHistoryEntry {
            id: stem.to_string(),
            saved_at,
            size: meta.len(),
        });
    }
    out.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    Ok(out)
}

pub fn read(root: &Path, remote_path: &str, id: &str) -> Result<String> {
    // id 只允许数字：它会被拼进文件名，任何别的字符都可能穿越目录。
    if id.is_empty() || !id.chars().all(|ch| ch.is_ascii_digit()) {
        return Err(anyhow!("历史版本标识无效"));
    }
    let file = dir_for(root, remote_path).join(format!("{id}.txt"));
    let meta = std::fs::metadata(&file)?;
    if meta.len() > MAX_ENTRY_BYTES {
        return Err(anyhow!("历史版本过大，无法在编辑器里打开"));
    }
    Ok(std::fs::read_to_string(file)?)
}

fn prune(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().map(|ext| ext == "txt").unwrap_or(false))
        .collect();
    if files.len() <= HISTORY_KEEP {
        return;
    }
    // 文件名是毫秒时间戳，字典序即时间序。
    files.sort();
    let drop_count = files.len() - HISTORY_KEEP;
    for stale in files.into_iter().take(drop_count) {
        let _ = std::fs::remove_file(stale);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("bls-ops-editor-history-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn records_lists_and_reads() {
        let root = temp_root();
        record(&root, "/etc/nginx/nginx.conf", "old-1").unwrap();

        let entries = list(&root, "/etc/nginx/nginx.conf").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            read(&root, "/etc/nginx/nginx.conf", &entries[0].id).unwrap(),
            "old-1"
        );

        // 别的路径看不见这份历史。
        assert!(list(&root, "/etc/nginx/sites-enabled/a.conf")
            .unwrap()
            .is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn keeps_only_the_latest_copies() {
        let root = temp_root();
        for index in 0..HISTORY_KEEP + 3 {
            record(&root, "/opt/app/a.conf", &format!("v{index}")).unwrap();
        }
        let entries = list(&root, "/opt/app/a.conf").unwrap();
        assert_eq!(entries.len(), HISTORY_KEEP);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_path_traversal_in_the_id() {
        let root = temp_root();
        record(&root, "/opt/app/a.conf", "x").unwrap();
        assert!(read(&root, "/opt/app/a.conf", "../../etc/passwd").is_err());
        assert!(read(&root, "/opt/app/a.conf", "").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn different_paths_never_share_a_directory() {
        let root = temp_root();
        record(&root, "/opt/a/conf", "a").unwrap();
        record(&root, "/opt/b/conf", "b").unwrap();
        assert_eq!(list(&root, "/opt/a/conf").unwrap().len(), 1);
        assert_eq!(list(&root, "/opt/b/conf").unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }
}
