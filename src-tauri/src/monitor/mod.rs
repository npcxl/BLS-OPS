//! Read-only Linux server monitoring over a live SSH session.
//!
//! Split by concern during the modularisation pass (阶段 E/F): the re-exports
//! below keep every existing `crate::monitor::xxx` path working, so
//! `commands/monitor.rs` and the e2e tests are untouched.
//!
//! Design rules — every one of them is covered by a test:
//!
//! * **Fixed command table** (`model.rs`). The frontend passes only a
//!   `session_id`; there is no way to inject a shell string through these
//!   commands.
//! * **No PTY.** Every command runs on its own `exec` channel, never through
//!   the interactive shell, so output can never mix with what a user is
//!   typing. Exec, PTY and SFTP channels coexist on the same connection.
//! * **One channel per command, always closed** (`exec.rs`). Monitoring never
//!   leaves a channel behind on the server.
//! * **Hard 5-second budget** per command.
//! * **No registry lock across `await`** (`registry.rs`). The session registry
//!   is only touched long enough to look a session up.
//! * **Disconnect cancels everything.** In-flight commands are dropped and the
//!   sample cache for that session is discarded.
//! * **No invented numbers.** Anything that cannot be measured is reported as
//!   an error or as "unsupported", never as a placeholder value.

mod collect;
mod exec;
mod model;
mod parse;
mod registry;

pub use collect::*;
pub use model::*;
pub use registry::*;

// Re-exported for the unit tests, which live next to this module.
#[cfg(test)]
pub(crate) use collect::unsupported_snapshot;
#[cfg(test)]
pub(crate) use exec::unsupported_message;

/// Parsers are re-exported at their old paths: the e2e tests call them
/// directly to assert on real command output.
pub use parse::{
    cpu_usage_percent, parse_cpu_stat, parse_disk_usage, parse_loadavg, parse_meminfo,
    parse_net_dev, parse_os_release, parse_processes, parse_uname, parse_uptime,
};

#[cfg(test)]
mod tests;
