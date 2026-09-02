//! Unit tests for the pure parts of the transport (moved verbatim from
//! `ssh.rs`): target parsing, the timeout primitive, the host-key trust matrix,
//! remote POSIX paths and natural ordering.

use std::cmp::Ordering;
use std::time::Duration;
use tokio::sync::watch;

use anyhow::Result;

use super::paths::{natural_cmp, posix_join, posix_normalize};
use super::session::timed;
use super::{
    evaluate_host_key, parse_ssh_target, ConnectOutcome, ConnectTarget, CredentialSecrets,
    Endpoint, HostKeyInfo, HostKeyVerdict,
};

fn key(fingerprint: &str) -> HostKeyInfo {
    HostKeyInfo {
        fingerprint: fingerprint.to_string(),
        key_type: "ssh-ed25519".to_string(),
    }
}

fn secrets() -> CredentialSecrets {
    CredentialSecrets {
        credential_type: "password".to_string(),
        secret: "pw".to_string(),
        passphrase: None,
    }
}

fn target(host: &str, port: u16, known: Option<&str>) -> ConnectTarget {
    ConnectTarget {
        host: host.to_string(),
        port,
        username: "root".to_string(),
        secrets: secrets(),
        known_fingerprint: known.map(str::to_string),
        proxy_jump: None,
    }
}

#[test]
fn parses_user_host_port() {
    let (user, host, port) = parse_ssh_target("root@10.0.0.11:2222", 22).unwrap();
    assert_eq!(
        (user.as_str(), host.as_str(), port),
        ("root", "10.0.0.11", 2222)
    );
}

/// A command that outlives its budget must fail instead of hanging: this is
/// the primitive behind the 5-second monitoring timeout.
#[tokio::test]
async fn timed_aborts_once_the_deadline_passes() {
    let (_sender, mut receiver) = watch::channel(false);
    let started = tokio::time::Instant::now();
    let result: Result<()> = timed(
        async {
            tokio::time::sleep(Duration::from_secs(30)).await;
        },
        started + Duration::from_millis(30),
        &mut receiver,
        Duration::from_secs(5),
    )
    .await;

    let error = result.expect_err("a missed deadline must be an error");
    assert!(error.to_string().contains("超时"), "{error}");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "must not wait 30s"
    );
}

/// Disconnecting cancels work that is already waiting on the server.
#[tokio::test]
async fn timed_aborts_when_the_session_is_closed() {
    let (sender, mut receiver) = watch::channel(false);
    let handle = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        let _ = sender.send(true);
    });

    let result: Result<()> = timed(
        async {
            tokio::time::sleep(Duration::from_secs(30)).await;
        },
        tokio::time::Instant::now() + Duration::from_secs(30),
        &mut receiver,
        Duration::from_secs(5),
    )
    .await;

    let error = result.expect_err("a disconnect must cancel the command");
    assert!(error.to_string().contains("已断开"), "{error}");
    handle.abort();
}

#[tokio::test]
async fn timed_returns_the_value_when_it_finishes_in_time() {
    let (_sender, mut receiver) = watch::channel(false);
    let value: Result<u8> = timed(
        async { 7u8 },
        tokio::time::Instant::now() + Duration::from_secs(5),
        &mut receiver,
        Duration::from_secs(5),
    )
    .await;
    assert_eq!(value.expect("in time"), 7);
}

#[test]
fn falls_back_to_default_port() {
    let (user, host, port) = parse_ssh_target("deploy@example.com", 22).unwrap();
    assert_eq!(
        (user.as_str(), host.as_str(), port),
        ("deploy", "example.com", 22)
    );
}

#[test]
fn parses_ipv6_literal_with_port() {
    let (user, host, port) = parse_ssh_target("root@[2001:db8::1]:2200", 22).unwrap();
    assert_eq!(
        (user.as_str(), host.as_str(), port),
        ("root", "2001:db8::1", 2200)
    );
}

#[test]
fn parses_bare_ipv6_without_port() {
    let (user, host, port) = parse_ssh_target("root@2001:db8::1", 22).unwrap();
    assert_eq!(
        (user.as_str(), host.as_str(), port),
        ("root", "2001:db8::1", 22)
    );
}

#[test]
fn trims_surrounding_whitespace() {
    let (user, host, port) = parse_ssh_target("  root@host:22  ", 22).unwrap();
    assert_eq!((user.as_str(), host.as_str(), port), ("root", "host", 22));
}

#[test]
fn rejects_missing_user() {
    assert!(parse_ssh_target("10.0.0.11", 22).is_err());
}

#[test]
fn rejects_empty_input() {
    assert!(parse_ssh_target("   ", 22).is_err());
}

#[test]
fn rejects_invalid_port() {
    assert!(parse_ssh_target("root@host:99999", 22).is_err());
    assert!(parse_ssh_target("root@host:0", 22).is_err());
}

// -- host key trust matrix ------------------------------------------------

#[test]
fn untrusted_endpoint_is_unknown() {
    let verdict = evaluate_host_key(
        Endpoint {
            host: "a",
            port: 22,
        },
        None,
        &key("SHA256:new"),
    );
    assert_eq!(
        verdict,
        HostKeyVerdict::Unknown {
            challenge_host: "a".to_string(),
            challenge_port: 22
        }
    );
}

#[test]
fn matching_fingerprint_is_trusted() {
    let verdict = evaluate_host_key(
        Endpoint {
            host: "a",
            port: 22,
        },
        Some("SHA256:same"),
        &key("SHA256:same"),
    );
    assert_eq!(verdict, HostKeyVerdict::Trusted);
}

#[test]
fn differing_fingerprint_is_changed() {
    let verdict = evaluate_host_key(
        Endpoint {
            host: "a",
            port: 2222,
        },
        Some("SHA256:old"),
        &key("SHA256:new"),
    );
    assert_eq!(
        verdict,
        HostKeyVerdict::Changed {
            challenge_host: "a".to_string(),
            challenge_port: 2222,
            known_fingerprint: "SHA256:old".to_string(),
        }
    );
}

/// The regression this file exists for: the challenge must name the hop
/// that presented the key, never the final destination.
#[test]
fn challenge_names_the_failing_hop_not_the_target() {
    let jump = target("jump.internal", 2022, None);
    let mut dest = target("db.internal", 22, None);
    dest.proxy_jump = Some(Box::new(jump));

    assert_eq!(dest.label(), "db.internal:22");
    assert_eq!(dest.endpoint().label(), "db.internal:22");

    let jump_hop = dest.proxy_jump.as_ref().expect("jump hop");
    let verdict = evaluate_host_key(
        jump_hop.endpoint(),
        jump_hop.known_fingerprint.as_deref(),
        &key("SHA256:jump"),
    );

    match verdict {
        HostKeyVerdict::Unknown {
            challenge_host,
            challenge_port,
        } => {
            assert_eq!(challenge_host, "jump.internal");
            assert_eq!(challenge_port, 2022);
        }
        other => panic!("expected Unknown for the jump host, got {other:?}"),
    }
}

#[test]
fn outcome_challenge_label_points_at_the_untrusted_endpoint() {
    let unknown = ConnectOutcome::HostKeyUnknown {
        host_key: key("SHA256:jump"),
        challenge_host: "jump.internal".to_string(),
        challenge_port: 2022,
    };
    assert_eq!(
        unknown.challenge_label().as_deref(),
        Some("jump.internal:2022")
    );

    let changed = ConnectOutcome::HostKeyChanged {
        host_key: key("SHA256:jump2"),
        known_fingerprint: "SHA256:jump".to_string(),
        challenge_host: "jump.internal".to_string(),
        challenge_port: 2022,
    };
    assert_eq!(
        changed.challenge_label().as_deref(),
        Some("jump.internal:2022")
    );

    let connected = ConnectOutcome::Connected {
        host_key: key("SHA256:ok"),
    };
    assert_eq!(connected.challenge_label(), None);
}

// -- remote POSIX paths ---------------------------------------------------

#[test]
fn posix_join_keeps_absolute_names() {
    assert_eq!(posix_join("/var/log", "/etc/passwd"), "/etc/passwd");
    assert_eq!(posix_join("/var/log", "nginx"), "/var/log/nginx");
    assert_eq!(posix_join("/var/log", "./nginx"), "/var/log/nginx");
    assert_eq!(posix_join("/var/log", "../etc"), "/var/etc");
    assert_eq!(posix_join("/", "srv"), "/srv");
}

#[test]
fn posix_normalize_collapses_components() {
    assert_eq!(posix_normalize("/a//b/./c"), "/a/b/c");
    assert_eq!(posix_normalize("/a/b/../c"), "/a/c");
    assert_eq!(posix_normalize("/.."), "/");
    assert_eq!(posix_normalize("/"), "/");
}

// -- natural ordering -----------------------------------------------------

#[test]
fn natural_order_compares_numbers_by_value() {
    assert_eq!(natural_cmp("file2.txt", "file10.txt"), Ordering::Less);
    assert_eq!(natural_cmp("file10.txt", "file2.txt"), Ordering::Greater);
    assert_eq!(natural_cmp("file2.txt", "file2.txt"), Ordering::Equal);
}

#[test]
fn natural_order_handles_cjk_and_spaces() {
    // Same prefix, embedded numbers still numeric.
    assert_eq!(natural_cmp("日志 2", "日志 10"), Ordering::Less);
    // Different first characters order by character value; determinism is
    // what matters for a listing, not locale collation.
    assert_eq!(natural_cmp("日志", "文档"), Ordering::Greater);
    assert_eq!(natural_cmp("a b", "a-c"), Ordering::Less);
}

#[test]
fn natural_order_mixed_digit_text_chunks() {
    assert_eq!(natural_cmp("2.txt", "a.txt"), Ordering::Less);
    assert_eq!(natural_cmp("10", "9a"), Ordering::Greater);
}
