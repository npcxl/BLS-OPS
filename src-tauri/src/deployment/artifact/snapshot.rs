//! P5.6 **统一来源快照** —— Git 仓库 / 本地文件夹 / 压缩包归一到同一种不可变快照，
//! 之后才进入既有的安全扫描与项目识别。
//!
//! * **来源可核对**：Git 带 commit SHA，目录/压缩包带绝对路径；
//! * **内容可比对**：`content_fingerprint` 走既有 `fingerprint::hash_source`；
//! * **不含凭据**：Git URL 入库前已禁止携带用户名 / 密码 / Token。

use std::path::Path;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use super::fingerprint;
use super::source::{ArchiveSource, ContentSource, DirectorySource};

/// 来源身份（**不含凭据**）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceOrigin {
    Git {
        url: String,
        revision: String,
        #[serde(default)]
        subdirectory: Option<String>,
    },
    LocalFolder {
        path: String,
    },
    LocalArchive {
        path: String,
    },
}

impl SourceOrigin {
    pub fn kind(&self) -> &'static str {
        match self {
            SourceOrigin::Git { .. } => "git",
            SourceOrigin::LocalFolder { .. } => "local_folder",
            SourceOrigin::LocalArchive { .. } => "local_archive",
        }
    }

    pub fn display_name(&self) -> String {
        match self {
            SourceOrigin::Git { url, revision, .. } => {
                let name = url
                    .rsplit('/')
                    .next()
                    .unwrap_or(url)
                    .trim_end_matches(".git");
                format!("{name}@{revision}")
            }
            SourceOrigin::LocalFolder { path } | SourceOrigin::LocalArchive { path } => {
                path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
            }
        }
    }
}

/// 一份不可变的来源快照。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SourceSnapshot {
    pub id: String,
    pub origin: SourceOrigin,
    /// Git 才有：解析后的完整 commit SHA。
    #[serde(default)]
    pub commit_sha: Option<String>,
    pub content_fingerprint: String,
    pub entry_count: u64,
    pub total_bytes: u64,
    pub scanned_at: i64,
}

impl SourceSnapshot {
    pub fn from_directory(path: &Path, now: i64) -> Result<Self> {
        let source = DirectorySource::scan(path)?;
        Ok(Self::build(
            SourceOrigin::LocalFolder {
                path: path.display().to_string(),
            },
            None,
            &source,
            now,
        ))
    }

    pub fn from_archive(path: &Path, now: i64) -> Result<Self> {
        let source = ArchiveSource::open(path)?;
        Ok(Self::build(
            SourceOrigin::LocalArchive {
                path: path.display().to_string(),
            },
            None,
            &source,
            now,
        ))
    }

    pub fn for_git(
        url: String,
        revision: String,
        subdirectory: Option<String>,
        commit_sha: String,
        source: &dyn ContentSource,
        now: i64,
    ) -> Self {
        Self::build(
            SourceOrigin::Git {
                url,
                revision,
                subdirectory,
            },
            Some(commit_sha),
            source,
            now,
        )
    }

    fn build(
        origin: SourceOrigin,
        commit_sha: Option<String>,
        source: &dyn ContentSource,
        now: i64,
    ) -> Self {
        let (sha, bytes, entries) = fingerprint::hash_source(source, &mut |_| {});
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            origin,
            commit_sha,
            content_fingerprint: sha,
            entry_count: entries,
            total_bytes: bytes,
            scanned_at: now,
        }
    }

    pub fn display_name(&self) -> String {
        self.origin.display_name()
    }

    /// 内容锚点：Git 是 `commit:指纹`，其它只有指纹。
    pub fn content_anchor(&self) -> String {
        match &self.commit_sha {
            Some(commit) => format!("{commit}:{}", self.content_fingerprint),
            None => self.content_fingerprint.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "bls-ops-snapshot-{}-{}",
            uuid::Uuid::new_v4(),
            name
        ));
        std::fs::create_dir_all(&path).expect("mkdir");
        path
    }

    #[test]
    fn a_local_folder_becomes_a_snapshot_with_a_reproducible_fingerprint() {
        let root = temp_dir("folder");
        std::fs::write(root.join("package.json"), br#"{"name":"shop"}"#).unwrap();
        std::fs::write(root.join("index.js"), b"console.log(1)").unwrap();

        let snapshot = SourceSnapshot::from_directory(&root, 42).expect("快照");
        assert_eq!(snapshot.origin.kind(), "local_folder");
        assert!(snapshot.commit_sha.is_none());
        assert_eq!(snapshot.scanned_at, 42);
        assert_eq!(snapshot.entry_count, 2);
        assert_eq!(snapshot.content_fingerprint.len(), 64);

        let again = SourceSnapshot::from_directory(&root, 43).unwrap();
        assert_eq!(again.content_fingerprint, snapshot.content_fingerprint);
        assert_ne!(again.id, snapshot.id);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn git_snapshots_carry_the_commit_sha_as_the_content_anchor() {
        let root = temp_dir("git");
        std::fs::write(root.join("Dockerfile"), b"FROM node:22\n").unwrap();
        let source = DirectorySource::scan(&root).unwrap();
        let commit = "a".repeat(40);

        let snapshot = SourceSnapshot::for_git(
            "https://github.com/acme/shop.git".to_string(),
            "main".to_string(),
            None,
            commit.clone(),
            &source,
            7,
        );
        assert_eq!(snapshot.origin.kind(), "git");
        assert_eq!(snapshot.commit_sha.as_deref(), Some(commit.as_str()));
        assert!(snapshot.content_anchor().starts_with(&commit));
        assert_eq!(snapshot.display_name(), "shop@main");
        let json = serde_json::to_string(&snapshot).unwrap();
        assert!(!json.contains('@'), "快照不应含凭据形式的 URL：{json}");

        let _ = std::fs::remove_dir_all(root);
    }
}
