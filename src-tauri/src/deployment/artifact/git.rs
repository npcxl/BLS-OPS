//! P5.6 **Git 项目来源** —— 公开 HTTPS 仓库优先，私有仓库凭据只来自 Keyring。
//!
//! # 安全边界（逐条对应要求）
//!
//! 1. **URL 禁止明文凭据**：[`validate_git_url`] 拒绝 `https://user:pass@host` 与
//!    `https://<token>@host`；SSH 的 `git@host:path`（只有用户名）允许。
//! 2. **凭据只从 Keyring 读**：用 `credential_ref` 指向钥匙串账户；通过
//!    **子进程环境变量**（`GIT_CONFIG_*` + `http.extraHeader`）注入，**不进进程参数、
//!    不写 `.git/config`、不进日志、不进数据库**。
//! 3. **结构化调用**：参数是 `Vec<OsString>`，**从不拼接 Shell 字符串**。
//! 4. **默认 shallow**：`--depth 1 --single-branch`。
//! 5. **默认禁用 submodule / hooks / LFS 自动执行**：不传 `--recurse-submodules`，
//!    并显式 `-c submodule.recurse=false`、`-c core.hooksPath=<空目录>`、
//!    `GIT_LFS_SKIP_SMUDGE=1`、`GIT_TERMINAL_PROMPT=0`。
//! 6. **克隆到应用专用缓存目录**：[`GitSourceSpec::cache_dir`]。

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, Context, Result};

use super::snapshot::{SourceOrigin, SourceSnapshot};
use super::source::{ContentSource, DirectorySource, SourceEntry};

/// Git revision 的三种形态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitRevision {
    Branch(String),
    Tag(String),
    Commit(String),
}

impl GitRevision {
    /// 用户表述（展示 / 指纹用）。
    pub fn as_text(&self) -> &str {
        match self {
            GitRevision::Branch(text) | GitRevision::Tag(text) | GitRevision::Commit(text) => text,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            GitRevision::Branch(_) => "branch",
            GitRevision::Tag(_) => "tag",
            GitRevision::Commit(_) => "commit",
        }
    }

    /// 解析用户输入：`refs/tags/v1` 视为 tag，40 位十六进制视为 commit，其余为 branch。
    pub fn parse(text: &str) -> Result<Self> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err(anyhow!("revision 不能为空"));
        }
        if trimmed.chars().any(|ch| {
            !ch.is_ascii_alphanumeric() && !matches!(ch, '.' | '_' | '-' | '/' | '@' | '+')
        }) {
            return Err(anyhow!("revision 含非法字符：{trimmed}"));
        }
        Ok(if trimmed.starts_with("refs/tags/") {
            GitRevision::Tag(trimmed.trim_start_matches("refs/tags/").to_string())
        } else if trimmed.len() == 40 && trimmed.chars().all(|ch| ch.is_ascii_hexdigit()) {
            GitRevision::Commit(trimmed.to_string())
        } else {
            GitRevision::Branch(trimmed.to_string())
        })
    }

    /// clone 时是否需要 `--branch`（commit 不能用）。
    pub fn clone_branch(&self) -> Option<&str> {
        match self {
            GitRevision::Branch(text) | GitRevision::Tag(text) => Some(text.as_str()),
            GitRevision::Commit(_) => None,
        }
    }
}

/// Git 来源的**入参**（跨 IPC 序列化）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct GitSourceSpec {
    pub url: String,
    /// branch / tag / commit（原文）。
    pub revision: String,
    #[serde(default)]
    pub subdirectory: Option<String>,
    /// 钥匙串账户名（**不是**凭据本身）。
    #[serde(default)]
    pub credential_ref: Option<String>,
    /// 默认 true。
    #[serde(default = "default_true")]
    pub shallow: bool,
    /// 默认 false。
    #[serde(default)]
    pub include_submodules: bool,
}

fn default_true() -> bool {
    true
}

impl GitSourceSpec {
    pub fn parsed_revision(&self) -> Result<GitRevision> {
        GitRevision::parse(&self.revision)
    }

    /// 规范化后的 URL（**已确认不含凭据**）。
    pub fn clean_url(&self) -> Result<String> {
        validate_git_url(&self.url)
    }

    /// 应用专用缓存目录：`cache_root/repos/<hash>`。
    ///
    /// 用 URL + revision 的哈希做目录名，**不把 URL 原文写进路径**
    /// （免得带 token 的历史 URL 留在磁盘上）。
    pub fn cache_dir(&self, cache_root: &Path) -> Result<PathBuf> {
        let url = self.clean_url()?;
        let revision = self.parsed_revision()?;
        let key = format!("{}#{}", url, revision.as_text());
        Ok(cache_root.join("repos").join(short_hash(&key)))
    }
}

fn short_hash(text: &str) -> String {
    super::fingerprint::hash_bytes(text.as_bytes())[..16].to_string()
}

/// 校验仓库地址：**禁止明文凭据**，只允许可核对的协议。
pub fn validate_git_url(url: &str) -> Result<String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("仓库地址不能为空"));
    }
    if trimmed.chars().any(|ch| {
        ch.is_control()
            || matches!(
                ch,
                '`' | '$' | ';' | '|' | '&' | '<' | '>' | '"' | '\'' | ' ' | '\\'
            )
    }) {
        return Err(anyhow!("仓库地址含非法字符（可能存在命令注入风险）"));
    }
    if trimmed.contains("://") {
        let (scheme, rest) = trimmed.split_once("://").expect("已确认含 ://");
        let scheme = scheme.to_ascii_lowercase();
        if !matches!(scheme.as_str(), "https" | "http" | "ssh" | "git") {
            return Err(anyhow!("不支持的协议 {scheme}://（建议 https 或 ssh）"));
        }
        let (userinfo, host_part) = match rest.split_once('@') {
            Some((userinfo, host)) => (Some(userinfo), host),
            None => (None, rest),
        };
        if let Some(userinfo) = userinfo {
            if userinfo.contains(':') {
                return Err(anyhow!("仓库地址里不能带密码（请用钥匙串凭据）"));
            }
            if matches!(scheme.as_str(), "https" | "http" | "git") {
                // HTTPS 的 `user@host` 一定是 token / 用户名冒充，GitHub 等一律拒绝。
                return Err(anyhow!(
                    "HTTPS 仓库地址里不能带用户名或 Token（请用钥匙串凭据或 SSH）"
                ));
            }
        }
        if host_part.trim().is_empty() {
            return Err(anyhow!("仓库地址缺少主机名"));
        }
    } else if trimmed.contains('@') {
        // scp 形式 `git@host:path` —— 只有用户名，合法。
        let (user, host) = trimmed.split_once('@').expect("已确认含 @");
        if user.contains(':') || host.trim().is_empty() {
            return Err(anyhow!("SSH 仓库地址格式不正确（应为 user@host:path）"));
        }
    } else if trimmed.contains(':') {
        return Err(anyhow!("仓库地址格式不正确（应为 https://host/path.git）"));
    }
    Ok(trimmed.to_string())
}

/// 构造 `git clone` 的参数（**纯函数**，便于单测"没有 shell、没有 hooks"）。
pub fn clone_args(
    spec: &GitSourceSpec,
    destination: &Path,
    hooks_dir: &Path,
) -> Result<Vec<OsString>> {
    let url = spec.clean_url()?;
    let revision = spec.parsed_revision()?;
    let mut args: Vec<OsString> = Vec::new();
    // 结构化配置项：禁 hooks、禁子模块递归、禁交互式凭据助手。
    args.push(OsString::from("-c"));
    args.push(OsString::from(format!(
        "core.hooksPath={}",
        hooks_dir.display()
    )));
    args.push(OsString::from("-c"));
    args.push(OsString::from("submodule.recurse=false"));
    args.push(OsString::from("-c"));
    args.push(OsString::from("credential.helper="));
    args.push(OsString::from("clone"));
    if spec.shallow {
        args.push(OsString::from("--depth"));
        args.push(OsString::from("1"));
        args.push(OsString::from("--single-branch"));
        args.push(OsString::from("--no-tags"));
    }
    if let Some(branch) = revision.clone_branch() {
        args.push(OsString::from("--branch"));
        args.push(OsString::from(branch));
    }
    if spec.include_submodules {
        args.push(OsString::from("--recurse-submodules"));
    }
    args.push(OsString::from(&url));
    args.push(destination.as_os_str().to_os_string());
    Ok(args)
}

/// 注入给子进程的环境（**凭据只走这里**）。
pub fn git_env(credential: Option<&str>) -> BTreeMap<OsString, OsString> {
    let mut env: BTreeMap<OsString, OsString> = BTreeMap::new();
    // 永远不弹交互式提示（否则会挂住界面）。
    env.insert(OsString::from("GIT_TERMINAL_PROMPT"), OsString::from("0"));
    // LFS 指针文件不自动下载（避免任意大文件与外部进程）。
    env.insert(OsString::from("GIT_LFS_SKIP_SMUDGE"), OsString::from("1"));
    env.insert(OsString::from("GIT_CONFIG_NOSYSTEM"), OsString::from("1"));
    if let Some(token) = credential {
        // 通过环境变量注入 Authorization 头：不进参数、不写 .git/config、不进日志。
        env.insert(OsString::from("GIT_CONFIG_COUNT"), OsString::from("2"));
        env.insert(
            OsString::from("GIT_CONFIG_KEY_0"),
            OsString::from("credential.helper"),
        );
        env.insert(OsString::from("GIT_CONFIG_VALUE_0"), OsString::from(""));
        env.insert(
            OsString::from("GIT_CONFIG_KEY_1"),
            OsString::from("http.https://github.com/.extraheader"),
        );
        env.insert(
            OsString::from("GIT_CONFIG_VALUE_1"),
            OsString::from(format!("Authorization: Bearer {token}")),
        );
    }
    env
}

/// 已检出的 Git 仓库（只读地作为 [`ContentSource`] 使用）。
pub struct GitCheckout {
    root: PathBuf,
    /// 有 subdirectory 时指向子目录。
    content_root: PathBuf,
    source: DirectorySource,
    snapshot: SourceSnapshot,
}

impl GitCheckout {
    pub fn snapshot(&self) -> &SourceSnapshot {
        &self.snapshot
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 解析 HEAD 的完整 commit SHA。
    pub fn resolve_commit(&self) -> Result<String> {
        let output = Command::new("git")
            .current_dir(&self.root)
            .args(["rev-parse", "HEAD"])
            .output()
            .context("无法读取 git 提交号")?;
        if !output.status.success() {
            return Err(anyhow!("无法解析 git 提交号"));
        }
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.len() != 40 || !text.chars().all(|ch| ch.is_ascii_hexdigit()) {
            return Err(anyhow!("git 返回了非预期的提交号"));
        }
        Ok(text)
    }
}

impl ContentSource for GitCheckout {
    fn entries(&self) -> &[SourceEntry] {
        self.source.entries()
    }

    fn read_many(&self, wanted: &[String], limit: usize) -> Vec<(String, Vec<u8>)> {
        self.source.read_many(wanted, limit)
    }
}

/// 克隆一个仓库到应用缓存目录，并产出统一快照。
pub fn clone_repository(
    spec: &GitSourceSpec,
    cache_root: &Path,
    credential: Option<&str>,
    now: i64,
) -> Result<GitCheckout> {
    let destination = spec.cache_dir(cache_root)?;
    let hooks_dir = cache_root.join("no-hooks");
    std::fs::create_dir_all(&hooks_dir).ok();

    if !destination.join(".git").exists() {
        let args = clone_args(spec, &destination, &hooks_dir)?;
        let mut command = Command::new("git");
        command.args(&args);
        for (key, value) in git_env(credential) {
            command.env(key, value);
        }
        let output = command
            .output()
            .map_err(|error| anyhow!("无法执行 git（请确认系统已安装 Git）：{error}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // 只回**脱敏后**的最后几行：git 的错误里可能带 URL。
            let tail: Vec<&str> = stderr.lines().rev().take(3).collect();
            let mut message: Vec<&str> = tail.into_iter().rev().collect();
            if let Some(scheme_at) = message.iter().position(|line| line.contains("://")) {
                message[scheme_at] = "<仓库地址已脱敏>";
            }
            return Err(anyhow!("git clone 失败：{}", message.join(" / ")));
        }
    }

    let root = destination.clone();
    let content_root = match &spec.subdirectory {
        Some(sub) => {
            let trimmed = sub.trim_matches('/');
            if trimmed.is_empty() || trimmed.contains("..") {
                return Err(anyhow!("subdirectory 不合法"));
            }
            let candidate = root.join(trimmed);
            if !candidate.is_dir() {
                return Err(anyhow!("仓库里没有子目录 {trimmed}"));
            }
            candidate
        }
        None => root.clone(),
    };

    let source = DirectorySource::scan(&content_root)?;
    let commit = {
        let probe = GitCheckout {
            root: root.clone(),
            content_root: content_root.clone(),
            snapshot: snapshot::placeholder(),
            source: DirectorySource::scan(&content_root)?,
        };
        probe.resolve_commit()?
    };

    let snapshot = SourceSnapshot::for_git(
        spec.clean_url()?,
        spec.revision.trim().to_string(),
        spec.subdirectory.clone(),
        commit,
        &source,
        now,
    );
    Ok(GitCheckout {
        root,
        content_root,
        source,
        snapshot,
    })
}

mod snapshot {
    use super::*;

    /// 探测提交号期间的占位快照（随即被真正的快照替换）。
    pub(super) fn placeholder() -> SourceSnapshot {
        SourceSnapshot {
            id: String::new(),
            origin: SourceOrigin::LocalFolder {
                path: String::new(),
            },
            commit_sha: None,
            content_fingerprint: String::new(),
            entry_count: 0,
            total_bytes: 0,
            scanned_at: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> GitSourceSpec {
        GitSourceSpec {
            url: "https://github.com/acme/shop.git".to_string(),
            revision: "main".to_string(),
            subdirectory: None,
            credential_ref: None,
            shallow: true,
            include_submodules: false,
        }
    }

    fn args_of(spec: &GitSourceSpec) -> Vec<String> {
        let hooks = Path::new("/tmp/no-hooks");
        clone_args(spec, Path::new("/tmp/dest"), hooks)
            .expect("参数应当可构造")
            .iter()
            .map(|value| value.to_string_lossy().to_string())
            .collect()
    }

    #[test]
    fn git_urls_with_embedded_credentials_are_rejected() {
        for hostile in [
            "https://user:pass@github.com/acme/shop.git",
            "https://ghp_token@github.com/acme/shop.git",
            "https://x-oauth-basic:abc@github.com/acme/shop.git",
            "git@host:path; rm -rf /",
            "https://github.com/acme/shop.git && curl evil",
            "https://github.com/acme/shop.git`id`",
        ] {
            assert!(validate_git_url(hostile).is_err(), "{hostile} 必须被拒绝");
        }
        // 合法的公开地址与 SSH（只含用户名）。
        assert!(validate_git_url("https://github.com/acme/shop.git").is_ok());
        assert!(validate_git_url("ssh://git@github.com/acme/shop.git").is_ok());
        assert!(validate_git_url("git@github.com:acme/shop.git").is_ok());
    }

    #[test]
    fn revisions_are_parsed_into_branch_tag_or_commit() {
        assert!(matches!(
            GitRevision::parse("main").unwrap(),
            GitRevision::Branch(_)
        ));
        assert!(matches!(
            GitRevision::parse("refs/tags/v1.2.3").unwrap(),
            GitRevision::Tag(_)
        ));
        let commit = "a".repeat(40);
        assert!(matches!(
            GitRevision::parse(&commit).unwrap(),
            GitRevision::Commit(_)
        ));
        assert!(GitRevision::parse("bad revision!").is_err());
        assert!(GitRevision::parse("  ").is_err());
    }

    #[test]
    fn clone_arguments_are_shallow_hookless_and_submodule_free() {
        let args = args_of(&spec());
        let joined = args.join(" ");

        // 结构化调用：没有任何 shell 拼接痕迹，也没有 URL 里的凭据。
        assert!(!joined.contains("&&"), "{joined}");
        assert!(joined.contains("--depth 1"), "默认 shallow：{joined}");
        assert!(joined.contains("--single-branch"), "{joined}");
        assert!(joined.contains("--branch main"), "{joined}");
        // hooks 与子模块默认关闭。
        assert!(joined.contains("core.hooksPath="), "{joined}");
        assert!(joined.contains("submodule.recurse=false"), "{joined}");
        assert!(!joined.contains("--recurse-submodules"), "{joined}");
        assert!(args.iter().any(|value| value == "credential.helper="));
        assert!(args.contains(&"https://github.com/acme/shop.git".to_string()));
    }

    #[test]
    fn submodules_only_when_explicitly_requested() {
        let mut with_submodules = spec();
        with_submodules.include_submodules = true;
        assert!(args_of(&with_submodules).contains(&"--recurse-submodules".to_string()));

        // commit 不能用 --branch；tag 可以。
        let mut by_commit = spec();
        by_commit.revision = "b".repeat(40);
        assert!(!args_of(&by_commit).contains(&"--branch".to_string()));

        let mut by_tag = spec();
        by_tag.revision = "refs/tags/v1".to_string();
        assert!(args_of(&by_tag).contains(&"--branch".to_string()));
    }

    #[test]
    fn deep_clone_is_only_used_when_asked() {
        let mut full = spec();
        full.shallow = false;
        let args = args_of(&full);
        assert!(!args.contains(&"--depth".to_string()));
    }

    #[test]
    fn credentials_travel_only_through_the_environment() {
        let env = git_env(Some("ghp_secret"));
        assert_eq!(
            env.get(&OsString::from("GIT_CONFIG_VALUE_1"))
                .map(|value| value.to_string_lossy().to_string()),
            Some("Authorization: Bearer ghp_secret".to_string())
        );
        // 不允许交互式提示，也不允许 LFS 自动拉取。
        assert_eq!(
            env.get(&OsString::from("GIT_TERMINAL_PROMPT"))
                .map(|value| value.to_string_lossy().to_string()),
            Some("0".to_string())
        );
        assert_eq!(
            env.get(&OsString::from("GIT_LFS_SKIP_SMUDGE"))
                .map(|value| value.to_string_lossy().to_string()),
            Some("1".to_string())
        );
        // 没有凭据时完全不注入 Authorization。
        let plain = git_env(None);
        assert!(!plain.contains_key(&OsString::from("GIT_CONFIG_VALUE_1")));
    }

    #[test]
    fn the_cache_directory_never_contains_the_url() {
        let mut spec = spec();
        spec.revision = "main".to_string();
        let dir = spec.cache_dir(Path::new("/cache")).expect("缓存目录");
        let text = dir.to_string_lossy().to_string();
        assert!(
            !text.contains("github.com"),
            "路径里不应出现仓库地址：{text}"
        );
        assert!(!text.contains("shop.git"), "{text}");
    }
}
