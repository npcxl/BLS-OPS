//! Deployment-step validation.
//!
//! A step is a single simple command: one allowlisted executable followed by
//! arguments. Chaining, redirection and command substitution are rejected, and
//! every absolute path in the step must live under the project's deploy
//! directory.

use anyhow::{anyhow, Result};

use super::validate::is_within;

/// Executables a deployment step may invoke.
///
/// Deliberately small: the set of things a sane deploy needs. Anything else is
/// rejected rather than allowed-and-audited, because an audit trail does not
/// un-delete a file.
const DEPLOY_ALLOWLIST: &[&str] = &[
    "git",
    "npm",
    "pnpm",
    "yarn",
    "bun",
    "node",
    "python3",
    "pip3",
    "go",
    "cargo",
    "mvn",
    "gradle",
    "make",
    "docker",
    "docker-compose",
    "systemctl",
    "nginx",
    "cp",
    "mv",
    "mkdir",
    "chmod",
    "chown",
    "ln",
    "tar",
    "unzip",
    "find",
    "rsync",
    "echo",
    "rm",
    "supervisorctl",
    "pm2",
];

/// Shell operators that would let one step become several.
const SHELL_OPERATORS: &[&str] = &[
    ";", "&&", "||", "|", ">", "<", "`", "$(", "${", "&", "\n", "\r", "\\",
];

/// Validates one deployment step.
///
/// `root` is the project's deploy directory: every absolute path in the step
/// must live under it, so a step cannot reach outside the project it belongs
/// to.
pub fn validate_deploy_step(step: &str, root: &str) -> Result<()> {
    let trimmed = step.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("部署步骤不能为空"));
    }
    if trimmed.len() > 512 {
        return Err(anyhow!("部署步骤过长（最多 512 个字符）"));
    }
    if trimmed.chars().any(|ch| ch.is_control()) {
        return Err(anyhow!("部署步骤不能包含控制字符"));
    }
    for operator in SHELL_OPERATORS {
        if trimmed.contains(operator) {
            return Err(anyhow!(
                "部署步骤不允许包含 shell 操作符 {operator:?}：{trimmed}"
            ));
        }
    }

    let mut parts = trimmed.split_whitespace();
    let program = parts.next().unwrap_or_default();
    if !DEPLOY_ALLOWLIST.contains(&program) {
        return Err(anyhow!(
            "部署步骤使用了不在白名单内的命令 {program:?}：{trimmed}"
        ));
    }

    for argument in parts {
        // Quoted arguments are permitted (paths with spaces), so only the
        // dangerous metacharacters are checked here.
        if argument
            .chars()
            .any(|ch| matches!(ch, '`' | '$' | '\\') || ch.is_control())
        {
            return Err(anyhow!("部署步骤的参数包含不允许的字符：{argument}"));
        }
        let unquoted = argument.trim_matches('"').trim_matches('\'');
        if unquoted.starts_with('/') && !is_within(unquoted, root) {
            return Err(anyhow!(
                "部署步骤引用了项目目录之外的路径：{unquoted}（允许范围：{root}）"
            ));
        }
        // `rm` is the one allowlisted command that can destroy things, so it
        // is held to the deploy directory even when given a relative path.
        if program == "rm" && unquoted.contains("..") {
            return Err(anyhow!("部署步骤中的 rm 不能使用 ..：{trimmed}"));
        }
    }

    Ok(())
}
