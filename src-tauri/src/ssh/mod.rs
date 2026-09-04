//! SSH transport: sessions, exec channels, SFTP and the handshake.
//!
//! Split by concern during the modularisation pass. The re-exports below keep
//! every existing `crate::ssh::xxx` path working, so the domain modules
//! (`monitor`, `docker`, `nginx`, `systemd`, `journal`, `dirsize`,
//! `capability_probe`, `deployment_collector`) and `commands/*` are untouched.
//!
//! Guarantees that hold across all submodules:
//!
//! * **No PTY for non-interactive work.** Monitoring runs each command on its
//!   own short-lived exec channel, so output can never mix with what a user is
//!   typing. Exec, PTY and SFTP channels coexist on one connection.
//! * **Every command is bounded** by [`DEFAULT_COMMAND_TIMEOUT`] and cancelled
//!   the moment the session disconnects (see [`session::timed`]).
//! * **The registry lock is never held across `await`.**
//! * **Host keys are never accepted silently.** A challenge names the hop that
//!   presented the key — with ProxyJump that is the jump host.
//! * **Destructive SFTP operations never canonicalize first** (see
//!   [`sftp`] for why that would follow a symlink and delete its target).

mod handshake;
mod host_key;
mod manager;
mod model;
mod paths;
mod session;
mod sftp;
pub mod utf8_stream;

pub use host_key::{evaluate_host_key, HostKeyVerdict};
pub use manager::SshSessionManager;
pub use model::{
    parse_ssh_target, ConnectOutcome, ConnectTarget, CredentialSecrets, Endpoint, ExecOutput,
    HostKeyInfo, RemoteBinaryContent, RemoteFileContent, RemoteFileEntry, DEFAULT_COMMAND_TIMEOUT,
    DEFAULT_KEEPALIVE_SECS, KIND_DIRECTORY, KIND_FILE, KIND_OTHER, KIND_SYMLINK, SFTP_SUBSYSTEM,
};
pub use paths::{format_size_human, natural_cmp, posix_join, posix_normalize};
pub use utf8_stream::Utf8StreamDecoder;

#[cfg(test)]
mod tests;
