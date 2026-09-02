//! Host-key trust decisions.
//!
//! Deliberately pure and network-free: the whole trust matrix is unit-testable
//! without a server, and the ProxyJump regression (trusting the jump host's key
//! under the destination's name) is covered by a test that names the failing
//! hop.

use super::model::{Endpoint, HostKeyInfo};

/// Verdict on the key a server presented during the handshake.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyVerdict {
    /// Matches the fingerprint we already trust.
    Trusted,
    /// No fingerprint on record for this endpoint.
    Unknown {
        challenge_host: String,
        challenge_port: u16,
    },
    /// On record, but different — possible machine-in-the-middle.
    Changed {
        challenge_host: String,
        challenge_port: u16,
        known_fingerprint: String,
    },
}

/// Decides whether an observed host key is acceptable.
///
/// `challenge_host` / `challenge_port` always name the endpoint that actually
/// presented the key — with ProxyJump that is the jump host.
pub fn evaluate_host_key(
    endpoint: Endpoint<'_>,
    trusted_fingerprint: Option<&str>,
    observed: &HostKeyInfo,
) -> HostKeyVerdict {
    match trusted_fingerprint {
        None => HostKeyVerdict::Unknown {
            challenge_host: endpoint.host.to_string(),
            challenge_port: endpoint.port,
        },
        Some(known) if known == observed.fingerprint => HostKeyVerdict::Trusted,
        Some(known) => HostKeyVerdict::Changed {
            challenge_host: endpoint.host.to_string(),
            challenge_port: endpoint.port,
            known_fingerprint: known.to_string(),
        },
    }
}
