//! 远程回收站：删除默认"移动"，不是直接抹掉。
//!
//! 位置：`<登录目录>/.bls-ops-trash/<时间戳>/`
//! * `meta.json`：原路径、名称、删除时间、类型（**不含任何密钥**）
//! * `<name>`：被删的文件 / 目录本体
//!
//! 为什么留在服务器上：跨机备份大文件不现实，而"恢复"必须留住原文件。
//! 目录以 `.` 开头，与常见的 `.trash` 约定一致，不会混进项目目录列表。
//!
//! 拒绝回收的情况（跨文件系统、无权限、目标已存在）必须**明确报错**，
//! 绝不能静默改成永久删除 —— 那正是"以为能恢复、结果已经没了"的来源。
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

pub const TRASH_DIR_NAME: &str = ".bls-ops-trash";
pub const META_FILE: &str = "meta.json";
/// 回收区最多保留多少条（超出后最旧的先清理）。
pub const TRASH_KEEP: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrashEntry {
    /// 时间戳（毫秒），同时是目录名。
    pub id: String,
    pub name: String,
    pub original_path: String,
    pub deleted_at: i64,
    /// `file` / `directory` / `symlink` / `other`
    pub kind: String,
}

/// id 会被拼进远程路径，只允许数字，杜绝目录穿越。
pub fn validate_id(id: &str) -> Result<&str> {
    if id.is_empty() || !id.chars().all(|ch| ch.is_ascii_digit()) {
        return Err(anyhow!("回收站条目标识无效"));
    }
    Ok(id)
}

pub fn entry_dir(root: &str, id: &str) -> String {
    format!("{root}/{id}")
}

pub fn payload_path(root: &str, id: &str, name: &str) -> String {
    format!("{root}/{id}/{name}")
}

pub fn meta_path(root: &str, id: &str) -> String {
    format!("{root}/{id}/{META_FILE}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_numeric_ids_pass() {
        assert!(validate_id("1730000000000").is_ok());
        assert!(validate_id("../etc").is_err());
        assert!(validate_id("").is_err());
        assert!(validate_id("12a").is_err());
    }

    #[test]
    fn entry_paths_are_stable() {
        assert_eq!(
            entry_dir("/root/.bls-ops-trash", "42"),
            "/root/.bls-ops-trash/42"
        );
        assert_eq!(
            payload_path("/root/.bls-ops-trash", "42", "nginx.conf"),
            "/root/.bls-ops-trash/42/nginx.conf"
        );
    }

    #[test]
    fn meta_round_trips() {
        let entry = TrashEntry {
            id: "42".to_string(),
            name: "nginx.conf".to_string(),
            original_path: "/etc/nginx/nginx.conf".to_string(),
            deleted_at: 1_730_000_000_000,
            kind: "file".to_string(),
        };
        let text = serde_json::to_string(&entry).unwrap();
        let back: TrashEntry = serde_json::from_str(&text).unwrap();
        assert_eq!(back, entry);
    }
}
