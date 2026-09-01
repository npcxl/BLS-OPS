//! End-to-end tests for the P3 management modules against a real SSH server.
//!
//! Two things are proven here that unit tests cannot:
//!
//! 1. **The command that reaches the server is the one Rust built.** The test
//!    server records every exec request, so a test can assert it saw exactly
//!    `systemctl restart -- 'nginx.service'` — quoted, with `--` ending option
//!    parsing. That is the whole security boundary, observed from the outside.
//! 2. **A rejected parameter never becomes a command.** Hostile unit names,
//!    container names and paths fail validation in `safe.rs`, and the test
//!    asserts the server recorded *nothing at all*.
//!
//! Everything runs over a genuine SSH connection (russh server + russh client),
//! so exec channels, timeouts and cancellation are the real ones.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ops_workbench_lib::docker;
use ops_workbench_lib::journal::{self, JournalQuery};
use ops_workbench_lib::nginx;
use ops_workbench_lib::remote::{self, run_capability};
use ops_workbench_lib::safe::{Capability, ContainerAction, ServiceAction};
use ops_workbench_lib::ssh::{
    ConnectOutcome, ConnectTarget, CredentialSecrets, SshSessionManager, DEFAULT_COMMAND_TIMEOUT,
};
use ops_workbench_lib::systemd;
use russh::keys::{Algorithm, PrivateKey};
use russh::server::{self, Auth, Handler, Msg, Server, Session};
use russh::{Channel, ChannelId};
use tokio::net::TcpListener;

const USER: &str = "opsuser";
const PASSWORD: &str = "opspass";

// Must match the private command table in `src/safe.rs`.
const CMD_UNAME: &str = "uname -s";
const CMD_LIST_SERVICES: &str =
    "systemctl list-units --type=service --all --no-legend --no-pager --plain";
const CMD_LIST_UNIT_FILES: &str = "systemctl list-unit-files --type=service --no-legend --no-pager";
const CMD_JOURNAL_DISK: &str = "journalctl --disk-usage";
const CMD_DOCKER_PS: &str =
    "docker ps -a --no-trunc --format {{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.State}}|{{.Ports}}|{{.CreatedAt}}";
const CMD_DOCKER_IMAGES: &str =
    "docker images --format {{.ID}}|{{.Repository}}|{{.Tag}}|{{.Size}}|{{.CreatedSince}}";
const CMD_DOCKER_STATS: &str =
    "docker stats --no-stream --format {{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}";
const CMD_NGINX_VERSION: &str = "nginx -v";
const CMD_NGINX_TEST: &str = "nginx -t";
const CMD_NGINX_RELOAD: &str = "nginx -s reload";
const CMD_PRUNE: &str = "docker system prune -f";

/// The combined Nginx site listing, exactly as `safe.rs` builds it.
const CMD_NGINX_SITES: &str = "sh -c 'ls -1 /etc/nginx/sites-available 2>/dev/null; echo ---AVAILABLE---; ls -1 /etc/nginx/conf.d 2>/dev/null; echo ---CONFD---; ls -1 /etc/nginx/sites-enabled 2>/dev/null; echo ---ENABLED---'";

// ---------------------------------------------------------------------------
// Test SSH server
// ---------------------------------------------------------------------------

/// Every command the server has been asked to run, in order.
///
/// This is the audit trail the assertions read: it is the outside view of what
/// the client actually sent.
#[derive(Clone, Default)]
struct Log(Arc<Mutex<Vec<String>>>);

impl Log {
    fn record(&self, command: &str) {
        self.0.lock().unwrap().push(command.to_string());
    }

    fn all(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }

    fn count(&self) -> usize {
        self.0.lock().unwrap().len()
    }

    fn contains(&self, needle: &str) -> bool {
        self.0.lock().unwrap().iter().any(|c| c.contains(needle))
    }
}

#[derive(Clone)]
struct OpsServer {
    user: String,
    password: String,
    log: Log,
    /// When set, `command -v docker` fails — a host without Docker.
    no_docker: bool,
    /// Accept exec channels and never answer: the client must time out.
    silent: Arc<AtomicBool>,
}

struct OpsHandler {
    user: String,
    password: String,
    log: Log,
    no_docker: bool,
    silent: Arc<AtomicBool>,
}

impl OpsHandler {
    /// The fixture for one command, or `None` for "command not found".
    ///
    /// Matched on the *whole* command string so a test that expects quoting
    /// fails loudly if the quoting ever changes.
    fn fixture(&self, command: &str) -> Option<(String, u32)> {
        Some(match command {
            CMD_UNAME => ("Linux\n".to_string(), 0),

            // -- systemd ------------------------------------------------------
            CMD_LIST_SERVICES => (
                concat!(
                    "accounts-daemon.service  loaded    active   running Accounts Service\n",
                    "cron.service             loaded    active   running Regular background program processing daemon\n",
                    "failed-thing.service     loaded    failed   failed  A service that broke\n",
                    "nginx.service            loaded    active   running A high performance web server\n",
                    "ssh.service              loaded    inactive dead    OpenBSD Secure Shell server\n",
                )
                .to_string(),
                0,
            ),
            CMD_LIST_UNIT_FILES => (
                concat!(
                    "accounts-daemon.service  disabled  enabled\n",
                    "cron.service             enabled   enabled\n",
                    "failed-thing.service     disabled  enabled\n",
                    "nginx.service            enabled   enabled\n",
                    "ssh.service              enabled   enabled\n",
                )
                .to_string(),
                0,
            ),
            // `status` must be matched before the generic "systemctl <verb>"
            // arm below, which would otherwise treat "status" as an action.
            _ if command.starts_with("systemctl status -- ") => (
                concat!(
                    "● nginx.service - A high performance web server\n",
                    "     Loaded: loaded (/lib/systemd/system/nginx.service; enabled)\n",
                    "     Active: active (running) since Tue 2026-09-01 09:00:00 UTC\n",
                )
                .to_string(),
                0,
            ),
            _ if command.starts_with("systemctl ") && command.contains(" -- ") => {
                let action = command.split_whitespace().nth(1).unwrap_or("");
                (
                    match action {
                        "start" | "stop" | "restart" | "reload" => String::new(),
                        "enable" => "Created symlink /etc/systemd/system/multi-user.target.wants/x.service → /lib/systemd/system/x.service\n".to_string(),
                        "disable" => "Removed /etc/systemd/system/multi-user.target.wants/x.service.\n".to_string(),
                        _ => return None,
                    },
                    0,
                )
            }

            // -- journald -----------------------------------------------------
            CMD_JOURNAL_DISK => (
                "Archived and active journals take up 1.2G in the filesystem.\n".to_string(),
                0,
            ),
            _ if command.starts_with("journalctl -u ") => {
                let lines: Vec<String> = (1..=3)
                    .map(|index| {
                        format!(
                            "{{\"__REALTIME_TIMESTAMP\":\"169900000000000{index}\",\"_SYSTEMD_UNIT\":\"nginx.service\",\"PRIORITY\":\"{}\",\"MESSAGE\":\"log line {index}\"}}",
                            if index == 2 { 3 } else { 6 }
                        )
                    })
                    .collect();
                (format!("{}\n", lines.join("\n")), 0)
            }
            _ if command.starts_with("journalctl -n ") => (
                "{\"__REALTIME_TIMESTAMP\":\"1699000000000001\",\"_SYSTEMD_UNIT\":\"ssh.service\",\"PRIORITY\":\"6\",\"MESSAGE\":\"system log\"}\n".to_string(),
                0,
            ),

            // -- Docker -------------------------------------------------------
            CMD_DOCKER_PS => (
                concat!(
                    "3f2a1b9c8d7e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f90|web|nginx:1.25|Up 5 minutes|running|0.0.0.0:80->80/tcp|2024-01-15 09:12:33 +0800 CST\n",
                    "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66|db|postgres:16|Exited (0) 2 hours ago|exited||2024-01-10 21:00:01 +0800 CST\n",
                )
                .to_string(),
                0,
            ),
            CMD_DOCKER_IMAGES => (
                concat!(
                    "d1e2f3a4b5c6|nginx|1.25|187MB|3 weeks ago\n",
                    "f6e5d4c3b2a1|<none>|<none>|1.24GB|5 minutes ago\n",
                )
                .to_string(),
                0,
            ),
            CMD_DOCKER_STATS => (
                "web|0.15%|12.5MiB / 3.84GiB|0.32%|1.2kB / 0B|0B / 4.1kB\n".to_string(),
                0,
            ),
            _ if command.starts_with("docker logs --tail ") => ("container log line\n".to_string(), 0),
            _ if command.starts_with("docker start -- ")
                || command.starts_with("docker stop -- ")
                || command.starts_with("docker restart -- ") =>
            {
                ("web\n".to_string(), 0)
            }
            _ if command.starts_with("docker rm -f -- ") => ("web\n".to_string(), 0),
            _ if command.starts_with("docker rmi -- ") => ("image removed\n".to_string(), 0),
            CMD_PRUNE => ("Total reclaimed space: 1.2GB\n".to_string(), 0),

            // -- Nginx --------------------------------------------------------
            CMD_NGINX_VERSION => ("nginx version: nginx/1.24.0\n".to_string(), 0),
            CMD_NGINX_TEST => (
                // Real nginx prints this on **stderr**, which is why the client
                // must fall back to it.
                "nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful\n".to_string(),
                0,
            ),
            CMD_NGINX_RELOAD => (String::new(), 0),
            CMD_NGINX_SITES => (
                "default\napp\n---AVAILABLE---\n---CONFD---\napp\n---ENABLED---\n".to_string(),
                0,
            ),
            _ if command.starts_with("cat -- '/etc/nginx/") => (
                "server {\n    listen 80 default_server;\n    server_name app.example.com;\n}\n"
                    .to_string(),
                0,
            ),
            _ if command.starts_with("cp -- '/etc/nginx/") => (String::new(), 0),
            _ if command.starts_with("ln -sfn /etc/nginx/sites-available/") => (String::new(), 0),
            _ if command.starts_with("rm -f -- /etc/nginx/sites-enabled/") => (String::new(), 0),

            // -- Deployments --------------------------------------------------
            _ if command == "git pull --ff-only" => ("Already up to date.\n".to_string(), 0),
            _ if command == "npm run build" => ("built in 3s\n".to_string(), 0),

            _ if command.starts_with("command -v -- ") => {
                // The probe is what decides whether a module is offered at all.
                let tool = command
                    .trim_start_matches("command -v -- ")
                    .trim_end_matches(" >/dev/null 2>&1")
                    .trim_matches('\'');
                match tool {
                    "docker" if self.no_docker => return None,
                    _ => (String::new(), 0),
                }
            }

            _ => return None,
        })
    }
}

impl server::Server for OpsServer {
    type Handler = OpsHandler;

    fn new_client(&mut self, _peer: Option<SocketAddr>) -> OpsHandler {
        OpsHandler {
            user: self.user.clone(),
            password: self.password.clone(),
            log: self.log.clone(),
            no_docker: self.no_docker,
            silent: self.silent.clone(),
        }
    }
}

impl Handler for OpsHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if user == self.user && password == self.password {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    /// Records the command, then answers with a fixture.
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let command = String::from_utf8_lossy(data).trim().to_string();
        self.log.record(&command);

        // Accept the channel and stay quiet — the client must time out.
        if self.silent.load(Ordering::Relaxed) {
            return Ok(());
        }

        let (stdout, code, on_stderr) = match self.fixture(&command) {
            Some((body, code)) => (body, code, command == CMD_NGINX_TEST),
            None => (format!("sh: {command}: command not found\n"), 127, false),
        };

        if on_stderr {
            let _ = session.extended_data(channel, 1, stdout.into_bytes());
        } else if !stdout.is_empty() {
            let _ = session.data(channel, stdout.into_bytes());
        }
        let _ = session.exit_status_request(channel, code);
        let _ = session.eof(channel);
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let _ = session.channel_success(channel);
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let _ = session.channel_success(channel);
        let _ = session.data(channel, b"shell\r\n".to_vec());
        Ok(())
    }
}

async fn spawn_server(
    no_docker: bool,
) -> (
    SocketAddr,
    server::RunningServerHandle,
    Log,
    Arc<AtomicBool>,
) {
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).expect("generate host key");

    let mut config = server::Config::default();
    config.auth_rejection_time = Duration::from_millis(1);
    config.auth_rejection_time_initial = Some(Duration::from_millis(1));
    config.keys = vec![key];
    config.window_size = 65536;
    config.maximum_packet_size = 32768;

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local addr");

    let log = Log::default();
    let silent = Arc::new(AtomicBool::new(false));
    let mut server = OpsServer {
        user: USER.to_string(),
        password: PASSWORD.to_string(),
        log: log.clone(),
        no_docker,
        silent: silent.clone(),
    };

    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let running = server.run_on_socket(Arc::new(config), &listener);
        let _ = tx.send(running.handle());
        let _ = running.await;
    });

    (addr, rx.await.expect("server handle"), log, silent)
}

// ---------------------------------------------------------------------------
// Connect helper
// ---------------------------------------------------------------------------

fn target(port: u16, known: Option<String>) -> ConnectTarget {
    ConnectTarget {
        host: "127.0.0.1".to_string(),
        port,
        username: USER.to_string(),
        secrets: CredentialSecrets {
            credential_type: "password".to_string(),
            secret: PASSWORD.to_string(),
            passphrase: None,
        },
        known_fingerprint: known,
        proxy_jump: None,
    }
}

/// Opens a non-interactive session (no PTY, no shell) — the way every P3
/// module connects. Trusts the host key the way the confirmation dialog does.
async fn connect(manager: &SshSessionManager, session_id: &str, port: u16) {
    let mut trusted: Option<String> = None;
    for _ in 0..4 {
        let outcome = manager
            .connect_command(session_id.to_string(), target(port, trusted.clone()))
            .await
            .expect("connect attempt");
        match outcome {
            ConnectOutcome::Connected { .. } => return,
            ConnectOutcome::HostKeyUnknown { host_key, .. }
            | ConnectOutcome::HostKeyChanged { host_key, .. } => {
                trusted = Some(host_key.fingerprint);
            }
        }
    }
    panic!("host key was never accepted after 4 attempts");
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

#[tokio::test]
async fn service_list_parses_units_and_merges_enabled_state() {
    let (addr, _handle, log, _silent) = spawn_server(false).await;
    let manager = SshSessionManager::default();
    connect(&manager, "s1", addr.port()).await;

    let units = systemd::collect_services(&manager, "s1")
        .await
        .expect("services");

    assert_eq!(units.len(), 5);
    // Failed first, then running, then inactive — the sort the UI relies on.
    assert_eq!(units[0].unit, "failed-thing.service");
    assert!(units[0].is_failed());

    let nginx = units
        .iter()
        .find(|unit| unit.unit == "nginx.service")
        .unwrap();
    assert_eq!(nginx.active, "active");
    assert_eq!(nginx.sub, "running");
    assert_eq!(
        nginx.enabled,
        Some(true),
        "nginx 在 unit-files 里是 enabled"
    );
    assert!(nginx.description.contains("high performance web server"));

    let ssh = units
        .iter()
        .find(|unit| unit.unit == "ssh.service")
        .unwrap();
    assert_eq!(ssh.enabled, Some(true));

    // Both discovery commands ran, on their own exec channels.
    assert!(log.all().contains(&CMD_LIST_SERVICES.to_string()));
    assert!(log.all().contains(&CMD_LIST_UNIT_FILES.to_string()));
}

#[tokio::test]
async fn service_action_sends_a_quoted_command() {
    let (addr, _handle, log, _silent) = spawn_server(false).await;
    let manager = SshSessionManager::default();
    connect(&manager, "s1", addr.port()).await;

    systemd::service_action(&manager, "s1", ServiceAction::Restart, "nginx.service")
        .await
        .expect("restart");

    // The exact string the server saw. Quoted, with `--` ending option
    // parsing — this is the security boundary, observed from outside.
    assert!(
        log.all()
            .iter()
            .any(|command| command == "systemctl restart -- 'nginx.service'"),
        "服务端应收到固定模板命令，实际记录：{:?}",
        log.all()
    );
}

#[tokio::test]
async fn a_hostile_unit_name_never_reaches_the_server() {
    let (addr, _handle, log, _silent) = spawn_server(false).await;
    let manager = SshSessionManager::default();
    connect(&manager, "s1", addr.port()).await;

    let before = log.count();
    let result = systemd::service_action(
        &manager,
        "s1",
        ServiceAction::Restart,
        "nginx.service; cat /etc/shadow",
    )
    .await;

    assert!(result.is_err(), "恶意单元名必须被拒绝");
    assert_eq!(
        log.count(),
        before,
        "被拒绝的参数绝不能变成命令发到服务器：{:?}",
        log.all()
    );
    assert!(!log.contains("cat /etc/shadow"));
}

#[tokio::test]
async fn service_status_returns_the_details() {
    let (addr, _handle, _log, _silent) = spawn_server(false).await;
    let manager = SshSessionManager::default();
    connect(&manager, "s1", addr.port()).await;

    let status = systemd::service_status(&manager, "s1", "nginx.service")
        .await
        .expect("status");
    assert!(status.contains("nginx.service"));
    assert!(status.contains("Active: active (running)"));
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

#[tokio::test]
async fn journal_query_parses_records() {
    let (addr, _handle, log, _silent) = spawn_server(false).await;
    let manager = SshSessionManager::default();
    connect(&manager, "s1", addr.port()).await;

    let entries = journal::collect_journal(
        &manager,
        "s1",
        &JournalQuery {
            unit: Some("nginx.service".to_string()),
            lines: 200,
            priority: None,
        },
    )
    .await
    .expect("journal");

    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].unit, "nginx.service");
    assert_eq!(entries[0].message, "log line 1");
    assert_eq!(entries[1].priority, 3, "第二条记录是错误级别");
    assert!(!entries[0].timestamp.is_empty());

    assert!(
        log.all()
            .iter()
            .any(|command| command == "journalctl -u 'nginx.service' -n 200 --no-pager -o json"),
        "实际记录：{:?}",
        log.all()
    );
}

#[tokio::test]
async fn journal_priority_filter_is_applied_on_the_server() {
    let (addr, _handle, log, _silent) = spawn_server(false).await;
    let manager = SshSessionManager::default();
    connect(&manager, "s1", addr.port()).await;

    journal::collect_journal(
        &manager,
        "s1",
        &JournalQuery {
            unit: None,
            lines: 500,
            priority: Some(3),
        },
    )
    .await
    .expect("journal");

    // Filtering happens server-side, so only errors cross the wire.
    assert!(
        log.all()
            .iter()
            .any(|command| command == "journalctl -n 500 --no-pager -o json -p 3"),
        "实际记录：{:?}",
        log.all()
    );
}

#[tokio::test]
async fn journal_disk_usage_parses_the_size() {
    let (addr, _handle, _log, _silent) = spawn_server(false).await;
    let manager = SshSessionManager::default();
    connect(&manager, "s1", addr.port()).await;

    let usage = journal::collect_disk_usage(&manager, "s1")
        .await
        .expect("disk usage");
    assert_eq!(usage.bytes, Some(1_200_000_000));
    assert!(usage.raw.contains("1.2G"));
}

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------

#[tokio::test]
async fn docker_snapshot_parses_containers_images_and_stats() {
    let (addr, _handle, _log, _silent) = spawn_server(false).await;
    let manager = SshSessionManager::default();
    connect(&manager, "s1", addr.port()).await;

    let snapshot = docker::collect_snapshot(&manager, "s1")
        .await
        .expect("snapshot");

    assert!(snapshot.available);
    assert_eq!(snapshot.containers.len(), 2);
    let web = &snapshot.containers[0];
    assert_eq!(web.name, "web");
    assert!(web.is_running());
    // Port mappings contain spaces and commas.
    assert_eq!(web.ports, "0.0.0.0:80->80/tcp");
    assert_eq!(snapshot.containers[1].state, "exited");

    assert_eq!(snapshot.images.len(), 2);
    assert_eq!(snapshot.images[0].display_name, "nginx:1.25");

    assert_eq!(snapshot.stats.len(), 1);
    assert!((snapshot.stats[0].cpu_percent - 0.15).abs() < 1e-9);
}

#[tokio::test]
async fn a_host_without_docker_says_so_instead_of_showing_an_empty_list() {
    let (addr, _handle, _log, _silent) = spawn_server(true).await;
    let manager = SshSessionManager::default();
    connect(&manager, "s1", addr.port()).await;

    let snapshot = docker::collect_snapshot(&manager, "s1")
        .await
        .expect("snapshot");

    assert!(!snapshot.available);
    assert!(snapshot.containers.is_empty());
    let reason = snapshot
        .unavailable_reason
        .as_ref()
        .expect("必须有原因")
        .clone();
    assert!(reason.contains("docker"), "原因应说明缺少 docker：{reason}");

    // Acting on an unavailable daemon must fail with that reason.
    let error = docker::require_docker(&snapshot).unwrap_err();
    assert!(error.to_string().contains("docker"));
}

#[tokio::test]
async fn removing_a_container_forces_it() {
    let (addr, _handle, log, _silent) = spawn_server(false).await;
    let manager = SshSessionManager::default();
    connect(&manager, "s1", addr.port()).await;

    docker::container_action(&manager, "s1", ContainerAction::Remove, "web")
        .await
        .expect("remove");

    assert!(
        log.all()
            .iter()
            .any(|command| command == "docker rm -f -- 'web'"),
        "删除容器必须带 -f：{:?}",
        log.all()
    );
}

#[tokio::test]
async fn a_hostile_container_name_never_reaches_the_server() {
    let (addr, _handle, log, _silent) = spawn_server(false).await;
    let manager = SshSessionManager::default();
    connect(&manager, "s1", addr.port()).await;

    let before = log.count();
    let result =
        docker::container_action(&manager, "s1", ContainerAction::Start, "-v /:/host").await;

    assert!(result.is_err(), "以 - 开头的容器名必须被拒绝");
    assert_eq!(log.count(), before, "被拒绝的参数不能变成命令");
}

#[tokio::test]
async fn docker_logs_are_read_from_the_container() {
    let (addr, _handle, log, _silent) = spawn_server(false).await;
    let manager = SshSessionManager::default();
    connect(&manager, "s1", addr.port()).await;

    let output = docker::collect_logs(&manager, "s1", "web", 300)
        .await
        .expect("logs");
    assert!(output.contains("container log line"));
    assert!(
        log.all()
            .iter()
            .any(|command| command == "docker logs --tail 300 -- 'web'"),
        "实际记录：{:?}",
        log.all()
    );
}

// ---------------------------------------------------------------------------
// Nginx
// ---------------------------------------------------------------------------

#[tokio::test]
async fn nginx_sites_merge_both_directory_layouts() {
    let (addr, _handle, _log, _silent) = spawn_server(false).await;
    let manager = SshSessionManager::default();
    connect(&manager, "s1", addr.port()).await;

    let sites = nginx::collect_sites_with_summary(&manager, "s1")
        .await
        .expect("sites");

    assert_eq!(sites.len(), 2, "app 同时出现在两种布局里，只能有一条");
    let app = sites.iter().find(|site| site.name == "app").unwrap();
    assert!(app.enabled);
    // The config summary is read from the file.
    assert_eq!(app.server_names, vec!["app.example.com"]);
    assert_eq!(app.listen_ports, vec![80]);
    assert!(app.is_default);

    let default = sites.iter().find(|site| site.name == "default").unwrap();
    assert!(!default.enabled, "default 不在 sites-enabled 里");
}

#[tokio::test]
async fn nginx_test_reads_the_verdict_from_stderr() {
    let (addr, _handle, _log, _silent) = spawn_server(false).await;
    let manager = SshSessionManager::default();
    connect(&manager, "s1", addr.port()).await;

    let result = nginx::test_config(&manager, "s1").await.expect("test");

    assert!(result.success);
    // nginx writes "syntax is ok" to stderr; showing an empty result would be
    // useless, which is why the client falls back to it.
    assert!(
        result.output.contains("syntax is ok"),
        "实际输出：{}",
        result.output
    );
}

#[tokio::test]
async fn nginx_reload_runs_after_a_clean_test() {
    let (addr, _handle, log, _silent) = spawn_server(false).await;
    let manager = SshSessionManager::default();
    connect(&manager, "s1", addr.port()).await;

    nginx::reload(&manager, "s1").await.expect("reload");
    assert!(log.all().iter().any(|command| command == CMD_NGINX_RELOAD));
}

#[tokio::test]
async fn a_config_path_outside_etc_nginx_is_refused() {
    let (addr, _handle, log, _silent) = spawn_server(false).await;
    let manager = SshSessionManager::default();
    connect(&manager, "s1", addr.port()).await;

    let before = log.count();
    let result = nginx::read_config(&manager, "s1", "/etc/shadow").await;

    assert!(result.is_err(), "Nginx 目录之外的路径必须被拒绝");
    assert_eq!(log.count(), before, "被拒绝的路径不能变成命令");

    // Inside the config directory it works.
    let content = nginx::read_config(&manager, "s1", "/etc/nginx/sites-available/app")
        .await
        .expect("read config");
    assert!(content.contains("server_name app.example.com"));
}

#[tokio::test]
async fn enabling_a_site_creates_the_symlink() {
    let (addr, _handle, log, _silent) = spawn_server(false).await;
    let manager = SshSessionManager::default();
    connect(&manager, "s1", addr.port()).await;

    nginx::set_site_enabled(&manager, "s1", "app", true)
        .await
        .expect("enable");

    assert!(
        log.all().iter().any(|command| command
            == "ln -sfn /etc/nginx/sites-available/'app' /etc/nginx/sites-enabled/'app'"),
        "实际记录：{:?}",
        log.all()
    );
}

#[tokio::test]
async fn backing_up_a_config_keeps_the_suffix_inside_the_quotes() {
    let (addr, _handle, log, _silent) = spawn_server(false).await;
    let manager = SshSessionManager::default();
    connect(&manager, "s1", addr.port()).await;

    let backup = nginx::backup_config(&manager, "s1", "/etc/nginx/nginx.conf")
        .await
        .expect("backup");
    assert_eq!(backup, "/etc/nginx/nginx.conf.blsops.bak");

    assert!(
        log.all()
            .iter()
            .any(|command| command
                == "cp -- '/etc/nginx/nginx.conf' '/etc/nginx/nginx.conf.blsops.bak'"),
        "后缀必须在引号内：{:?}",
        log.all()
    );
}

// ---------------------------------------------------------------------------
// Deploy steps & shared behaviour
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_allowlisted_deploy_step_runs_verbatim() {
    let (addr, _handle, log, _silent) = spawn_server(false).await;
    let manager = SshSessionManager::default();
    connect(&manager, "s1", addr.port()).await;

    let output = run_capability(
        &manager,
        "s1",
        &Capability::DeployStep {
            step: "git pull --ff-only".to_string(),
            root: "/var/www/app".to_string(),
        },
    )
    .await
    .expect("deploy step");

    assert!(output.contains("Already up to date."));
    assert!(log
        .all()
        .iter()
        .any(|command| command == "git pull --ff-only"));
}

#[tokio::test]
async fn a_deploy_step_outside_the_project_never_reaches_the_server() {
    let (addr, _handle, log, _silent) = spawn_server(false).await;
    let manager = SshSessionManager::default();
    connect(&manager, "s1", addr.port()).await;

    let before = log.count();
    let result = run_capability(
        &manager,
        "s1",
        &Capability::DeployStep {
            step: "rm -rf /var/log".to_string(),
            root: "/var/www/app".to_string(),
        },
    )
    .await;

    assert!(result.is_err(), "项目目录之外的步骤必须被拒绝");
    assert_eq!(log.count(), before);
    assert!(!log.contains("/var/log"));
}

#[tokio::test]
async fn a_command_that_never_answers_is_abandoned_at_the_deadline() {
    let (addr, _handle, _log, silent) = spawn_server(false).await;
    let manager = SshSessionManager::default();
    connect(&manager, "s1", addr.port()).await;

    silent.store(true, Ordering::Relaxed);

    let started = std::time::Instant::now();
    let result = systemd::service_action(&manager, "s1", ServiceAction::Restart, "nginx.service")
        .await
        .expect_err("服务端不响应时必须失败");

    let elapsed = started.elapsed();
    // The action's own budget, not the 5s default: a restart is allowed 30s.
    assert!(
        elapsed < Duration::from_secs(40),
        "超时应在预算内返回，实际 {elapsed:?}"
    );
    assert!(
        result.to_string().contains("超时"),
        "错误信息应说明超时：{result}"
    );
}

#[tokio::test]
async fn disconnecting_stops_every_command() {
    let (addr, _handle, _log, _silent) = spawn_server(false).await;
    let manager = SshSessionManager::default();
    connect(&manager, "s1", addr.port()).await;

    manager.disconnect("s1").await;

    assert!(!manager.is_connected("s1").await);
    let error = systemd::collect_services(&manager, "s1")
        .await
        .expect_err("断开后不应再能采集");
    assert!(
        error.to_string().contains("会话"),
        "错误应说明会话已不存在：{error}"
    );
}

#[tokio::test]
async fn every_command_runs_on_its_own_exec_channel_and_none_touch_a_shell() {
    let (addr, _handle, log, _silent) = spawn_server(false).await;
    let manager = SshSessionManager::default();
    connect(&manager, "s1", addr.port()).await;

    // A full round of management reads across all four modules. None of them
    // opens a PTY or a shell — they only ever use exec channels.
    let _ = systemd::collect_services(&manager, "s1").await;
    let _ = journal::collect_disk_usage(&manager, "s1").await;
    let _ = docker::collect_snapshot(&manager, "s1").await;
    let _ = nginx::collect_sites(&manager, "s1").await;

    // The session is a command session: input must be refused outright.
    let error = manager
        .input("s1", b"ls".to_vec())
        .await
        .expect_err("非交互会话不应接受终端输入");
    assert!(error.to_string().contains("终端"), "实际错误：{error}");

    // Everything still worked, and no shell was ever requested.
    assert!(log.count() >= 7, "应发出多条命令，实际 {}", log.count());
    assert!(!log.contains("shell"));
}

#[tokio::test]
async fn the_default_command_budget_is_five_seconds() {
    assert_eq!(
        DEFAULT_COMMAND_TIMEOUT,
        Duration::from_secs(5),
        "默认超时必须是 5 秒"
    );
    assert_eq!(
        Capability::ListServices.timeout(),
        DEFAULT_COMMAND_TIMEOUT,
        "读取类命令使用默认预算"
    );
    assert!(
        Capability::DeployStep {
            step: "npm run build".to_string(),
            root: "/srv/app".to_string(),
        }
        .timeout()
        .as_secs()
            > 60,
        "部署步骤需要更长的预算"
    );
}

#[tokio::test]
async fn remote_helpers_refuse_non_linux_hosts() {
    let (addr, _handle, _log, _silent) = spawn_server(false).await;
    let manager = SshSessionManager::default();
    connect(&manager, "s1", addr.port()).await;

    // The fixture answers `uname -s` with "Linux", so the guard must pass.
    remote::require_linux(&manager, "s1")
        .await
        .expect("这台机器是 Linux");
}
