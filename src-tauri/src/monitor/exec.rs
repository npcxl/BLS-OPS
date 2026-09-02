//! Command execution for monitoring.
//!
//! Every command runs on its own `exec` channel — never through the interactive
//! shell — so output can never mix with what a user is typing. Each channel is
//! closed as soon as the command finishes.

use std::collections::HashMap;

use anyhow::{anyhow, Result};

use crate::ssh::{ExecOutput, SshSessionManager};

use super::model::{COMMAND_TIMEOUT, SUPPORTED_OS};
use super::parse::parse_uname;

/// A non-zero exit code is an error, not an empty result: silently turning a
/// failed `df` into "no disks" would read as "this server has no filesystems".
pub(crate) fn require_ok(command: &str, output: ExecOutput) -> Result<String> {
    match output.exit_code {
        Some(0) | None => Ok(output.stdout),
        Some(code) => {
            let detail = output.stderr.trim();
            if detail.is_empty() {
                Err(anyhow!("命令失败（退出码 {code}）：{command}"))
            } else {
                Err(anyhow!("命令失败（退出码 {code}）：{command} — {detail}"))
            }
        }
    }
}

/// Runs one command and returns its stdout, failing on a non-zero exit code.
pub(crate) async fn run(
    manager: &SshSessionManager,
    session_id: &str,
    command: &str,
) -> Result<String> {
    let output = manager.exec(session_id, command, COMMAND_TIMEOUT).await?;
    require_ok(command, output)
}

/// Runs the first command that succeeds. Used for `os-release`, whose location
/// differs between distributions.
pub(crate) async fn run_first(
    manager: &SshSessionManager,
    session_id: &str,
    commands: &[&'static str],
) -> Option<String> {
    for command in commands {
        if let Ok(output) = run(manager, session_id, command).await {
            return Some(output);
        }
    }
    None
}

/// Runs commands concurrently, each on its own exec channel.
///
/// A snapshot reads eight files; paying every round trip in series would make
/// a 5-second poll impossible over a high-latency link. The registry lock is
/// never held while these run.
pub(crate) async fn run_all(
    manager: &SshSessionManager,
    session_id: &str,
    commands: &[&'static str],
) -> HashMap<&'static str, Result<String>> {
    let mut tasks = Vec::with_capacity(commands.len());
    for &command in commands {
        let manager = manager.clone();
        let session_id = session_id.to_string();
        tasks.push(tokio::spawn(async move {
            let result = manager.exec(&session_id, command, COMMAND_TIMEOUT).await;
            (command, result)
        }));
    }

    let mut results = HashMap::with_capacity(commands.len());
    for (index, task) in tasks.into_iter().enumerate() {
        let command = commands[index];
        let value = match task.await {
            Ok((_, Ok(output))) => require_ok(command, output),
            Ok((_, Err(error))) => Err(error),
            Err(error) => Err(anyhow!("监控任务被中止：{error}")),
        };
        results.insert(command, value);
    }
    results
}

pub(crate) fn result_for(
    results: &HashMap<&'static str, Result<String>>,
    command: &str,
) -> Result<String> {
    match results.get(command) {
        Some(Ok(value)) => Ok(value.clone()),
        Some(Err(error)) => Err(anyhow!("{error}")),
        None => Err(anyhow!("命令未执行：{command}")),
    }
}

/// Rejects anything that is not Linux, with a message the UI can show as-is.
pub(crate) async fn require_linux(
    manager: &SshSessionManager,
    session_id: &str,
) -> Result<()> {
    let (system, _, _) = parse_uname(&run(manager, session_id, super::model::CMD_UNAME).await?);
    if system.eq_ignore_ascii_case(SUPPORTED_OS) {
        Ok(())
    } else {
        Err(unsupported_message(&system))
    }
}

pub(crate) fn unsupported_message(system: &str) -> anyhow::Error {
    let label = if system.is_empty() {
        "未知系统"
    } else {
        system
    };
    anyhow!("不支持的操作系统：{label}。BLS-OPS 目前只提供 {SUPPORTED_OS} 服务器的只读监控。")
}
