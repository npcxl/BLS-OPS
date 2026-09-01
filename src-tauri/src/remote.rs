//! Shared helpers for running fixed commands on a live session.
//!
//! Every command in P3 goes through [`run`] (or [`run_tolerated`]) so that
//! timeouts, exit-code checks and cancellation behave identically everywhere.

use std::time::Duration;

use anyhow::{anyhow, Result};

use crate::safe::Capability;
use crate::ssh::{ExecOutput, SshSessionManager};

/// Default budget for one remote command. Management actions that legitimately
/// take longer (image pulls, package installs) opt into a bigger one.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);

/// Turned into an error unless the command exited 0.
///
/// A missing exit code is tolerated: some servers close the channel without
/// sending a status even though the command produced output.
pub fn require_ok(command: &str, output: ExecOutput) -> Result<String> {
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
pub async fn run(
    manager: &SshSessionManager,
    session_id: &str,
    command: &str,
    timeout: Duration,
) -> Result<String> {
    let output = manager.exec(session_id, command, timeout).await?;
    require_ok(command, output)
}

/// Runs a command that is allowed to fail (a probe for an optional directory,
/// a binary that may not be installed). Used only for read-only discovery.
pub async fn run_tolerated(
    manager: &SshSessionManager,
    session_id: &str,
    command: &str,
    timeout: Duration,
) -> Option<String> {
    run(manager, session_id, command, timeout).await.ok()
}

/// Runs a [`Capability`]: validates its parameters, builds the command, then
/// executes it on its own exec channel.
///
/// This is the only way a management action reaches a server — going through
/// it means a rejected parameter never becomes shell text.
pub async fn run_capability(
    manager: &SshSessionManager,
    session_id: &str,
    capability: &Capability,
) -> Result<String> {
    let command = capability.command()?;
    let timeout = capability.timeout();
    run(manager, session_id, &command, timeout).await
}

/// Validates a capability, then runs it on a Linux host.
///
/// The order matters: [`Capability::command`] is pure and local, so a bad
/// parameter is rejected *before* the `uname` round trip. Checking the OS
/// first would spend a network request on a request that was never going to
/// run.
pub async fn run_on_linux(
    manager: &SshSessionManager,
    session_id: &str,
    capability: &Capability,
) -> Result<String> {
    let command = capability.command()?;
    require_linux(manager, session_id).await?;
    run(manager, session_id, &command, capability.timeout()).await
}

/// Refuses non-Linux hosts with a message the UI can show as-is.
///
/// Every P3 module manages Linux services, so acting on anything else would
/// silently produce nonsense.
pub async fn require_linux(manager: &SshSessionManager, session_id: &str) -> Result<()> {
    let system = run_capability(manager, session_id, &Capability::Uname)
        .await?
        .trim()
        .to_string();
    if system.eq_ignore_ascii_case("linux") {
        Ok(())
    } else {
        let label = if system.is_empty() {
            "未知系统"
        } else {
            &system
        };
        Err(anyhow!(
            "不支持的操作系统：{label}。BLS-OPS 目前只提供 Linux 服务器的服务、日志、容器与网关管理。"
        ))
    }
}

/// True when the remote side has a given tool on `PATH`.
pub async fn has_tool(
    manager: &SshSessionManager,
    session_id: &str,
    tool: crate::safe::ProbeTool,
) -> bool {
    run_capability(manager, session_id, &Capability::Probe(tool))
        .await
        .is_ok()
}
