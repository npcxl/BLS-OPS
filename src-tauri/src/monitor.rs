//! Read-only Linux server monitoring over a live SSH session.
//!
//! Design rules — every one of them is covered by a test:
//!
//! * **Fixed command table.** The frontend passes only a `session_id`; there is
//!   no way to inject a shell string through these commands.
//! * **No PTY.** Every command runs on its own `exec` channel, never through
//!   the interactive shell, so output can never mix with what a user is typing.
//!   Exec, PTY and SFTP channels coexist on the same connection.
//! * **One channel per command, always closed.** Monitoring never leaves a
//!   channel behind on the server.
//! * **Hard 5-second budget** per command.
//! * **No registry lock across `await`.** The session registry is only touched
//!   long enough to look a session up.
//! * **Disconnect cancels everything.** In-flight commands are dropped and the
//!   sample cache for that session is discarded.
//! * **No invented numbers.** Anything that cannot be measured is reported as
//!   an error or as "unsupported", never as a placeholder value.

use std::{
    cmp::Ordering,
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Result};
use serde::Serialize;
use tokio::sync::Mutex;

use crate::ssh::{ExecOutput, SshSessionManager};

/// Hard budget for one monitoring command.
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);

/// The only operating system this module knows how to read.
pub const SUPPORTED_OS: &str = "Linux";

/// How many processes a snapshot carries. Enough to find what is eating a
/// server, small enough to keep a 5-second poll cheap.
pub const PROCESS_LIMIT: usize = 100;

/// Window between the two samples taken on a session's very first collection.
/// Rates (CPU %, network speed) are deltas, so the first collection needs two
/// readings — without it the first point would have to be a made-up zero.
const BASELINE_DELAY: Duration = Duration::from_millis(200);

// -- The command table ------------------------------------------------------
//
// Fixed, read-only and boring on purpose: nothing here writes, nothing takes
// user input, and every command exists in any mainstream Linux distribution.

const CMD_UNAME: &str = "uname -srm";
const CMD_HOSTNAME: &str = "cat /proc/sys/kernel/hostname";
const CMD_UPTIME: &str = "cat /proc/uptime";
const CMD_LOADAVG: &str = "cat /proc/loadavg";
const CMD_CPU: &str = "cat /proc/stat";
const CMD_MEMORY: &str = "cat /proc/meminfo";
const CMD_DISKS: &str = "df -B1 -P -T";
const CMD_NETWORK: &str = "cat /proc/net/dev";
/// `comm` instead of `args`: a full command line carries passwords
/// (`--password=…`), tokens, database URLs and API keys — none of that may
/// reach the client. `comm` answers with the bare executable name.
const CMD_PROCESSES: &str = "ps -eo pid,user,pcpu,pmem,stat,lstart,comm";
/// `/etc/os-release` is the documented location; systemd also publishes it in
/// `/usr/lib/os-release` for distributions that treat `/etc` as editable.
const CMD_OS_RELEASE: &[&str] = &["cat /etc/os-release", "cat /usr/lib/os-release"];

// -- Data model -------------------------------------------------------------

/// Identity and OS of the machine being watched.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct SystemInfo {
    pub hostname: String,
    pub os_name: String,
    pub os_version: String,
    pub kernel: String,
    pub architecture: String,
    pub uptime_seconds: u64,
}

/// CPU utilisation plus the run-queue load average.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct CpuMetrics {
    pub usage_percent: f64,
    pub load_1: f64,
    pub load_5: f64,
    pub load_15: f64,
    pub logical_cores: u32,
}

/// Physical memory and swap, in bytes.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct MemoryMetrics {
    pub total: u64,
    pub used: u64,
    pub available: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    pub usage_percent: f64,
}

/// One mounted filesystem.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct DiskMetrics {
    pub device: String,
    pub mount_point: String,
    pub filesystem: String,
    pub total: u64,
    pub used: u64,
    pub available: u64,
    pub usage_percent: f64,
}

/// One network interface: lifetime counters plus the speed measured against
/// the previous collection (bytes/second).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct NetworkMetrics {
    pub interface: String,
    pub received_bytes: u64,
    pub transmitted_bytes: u64,
    pub receive_speed: f64,
    pub transmit_speed: f64,
}

/// One process from `ps`, sorted by CPU usage.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub user: String,
    pub cpu_percent: f64,
    pub memory_percent: f64,
    pub status: String,
    pub started_at: String,
    pub command: String,
}

/// Everything a monitoring page needs in a single IPC round trip.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct MonitorSnapshot {
    pub session_id: String,
    /// Unix seconds, when the collection ran.
    pub collected_at: i64,
    /// `false` when the remote OS is not Linux; `unsupported_reason` then says
    /// why and every metric list is deliberately empty.
    pub supported: bool,
    pub unsupported_reason: Option<String>,
    pub system: SystemInfo,
    pub cpu: CpuMetrics,
    pub memory: MemoryMetrics,
    pub disks: Vec<DiskMetrics>,
    pub network: Vec<NetworkMetrics>,
    pub processes: Vec<ProcessInfo>,
}

// -- Parsing ----------------------------------------------------------------
//
// Pure functions over fixed samples so every fixture is unit-testable without
// a server.

/// Aggregate jiffies read from one `/proc/stat` sample.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CpuSample {
    pub total: u64,
    pub idle: u64,
    pub logical_cores: u32,
}

/// Byte counters for one interface.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct NetSample {
    pub received: u64,
    pub transmitted: u64,
}

/// Reads the aggregate `cpu` line and counts per-core lines.
///
/// `idle` folds in `iowait`, which is the conventional definition: time spent
/// waiting for I/O is time the CPU was free to do something else.
pub fn parse_cpu_stat(input: &str) -> Option<CpuSample> {
    let mut aggregate: Option<(u64, u64)> = None;
    let mut logical_cores = 0u32;

    for line in input.lines() {
        let rest = match line.strip_prefix("cpu") {
            Some(rest) => rest,
            None => continue,
        };
        if rest.starts_with(char::is_numeric) {
            logical_cores += 1;
            continue;
        }
        if aggregate.is_some() {
            continue;
        }
        let fields: Vec<u64> = rest
            .split_whitespace()
            .filter_map(|value| value.parse().ok())
            .collect();
        if fields.len() < 8 {
            continue;
        }
        let idle = fields[3] + fields[4];
        aggregate = Some((fields[..8].iter().sum(), idle));
    }

    let (total, idle) = aggregate?;
    Some(CpuSample {
        total,
        idle,
        logical_cores,
    })
}

/// CPU utilisation between two samples, in percent.
///
/// Returns 0 when no time passed in the kernel's accounting — that is a real
/// "no measurable activity", not a guess.
pub fn cpu_usage_percent(previous: &CpuSample, current: &CpuSample) -> f64 {
    let total = current.total.saturating_sub(previous.total);
    if total == 0 {
        return 0.0;
    }
    let idle = current.idle.saturating_sub(previous.idle);
    let busy = total.saturating_sub(idle).min(total);
    (busy as f64 / total as f64) * 100.0
}

fn percent(part: u64, total: u64) -> f64 {
    if total == 0 {
        return 0.0;
    }
    (part as f64 / total as f64) * 100.0
}

/// `/proc/meminfo` → bytes. `available` prefers `MemAvailable` and falls back
/// to the classic `free + buffers + cached` estimate.
pub fn parse_meminfo(input: &str) -> Option<MemoryMetrics> {
    let mut values: HashMap<&str, u64> = HashMap::new();
    for line in input.lines() {
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let Some(number) = rest.split_whitespace().next() else {
            continue;
        };
        let Ok(kb) = number.parse::<u64>() else {
            continue;
        };
        values.entry(key.trim()).or_insert(kb.saturating_mul(1024));
    }

    let total = *values.get("MemTotal")?;
    let available = values
        .get("MemAvailable")
        .copied()
        .or_else(|| {
            let free = values.get("MemFree").copied().unwrap_or(0);
            let buffers = values.get("Buffers").copied().unwrap_or(0);
            let cached = values.get("Cached").copied().unwrap_or(0);
            Some(free + buffers + cached)
        })
        .unwrap_or(0)
        .min(total);
    let used = total.saturating_sub(available);

    let swap_total = values.get("SwapTotal").copied().unwrap_or(0);
    let swap_free = values.get("SwapFree").copied().unwrap_or(0);
    let swap_used = swap_total.saturating_sub(swap_free.min(swap_total));

    Some(MemoryMetrics {
        total,
        used,
        available,
        swap_total,
        swap_used,
        usage_percent: percent(used, total),
    })
}

/// Pseudo filesystems that carry no disk capacity and would only add noise.
fn is_pseudo_filesystem(filesystem: &str) -> bool {
    matches!(filesystem, "tmpfs" | "devtmpfs")
}

/// Builds one row from `df -B1 -P -T`, where `rest` is
/// `[type, total, used, available, use%, mount…]`.
fn build_disk(device: &str, rest: &[&str]) -> Option<DiskMetrics> {
    let filesystem = rest[0].to_string();
    let total = rest[1].parse::<u64>().ok()?;
    let used = rest[2].parse::<u64>().ok()?;
    let available = rest[3].parse::<u64>().ok()?;
    let usage_percent = rest[4].trim_end_matches('%').parse::<f64>().unwrap_or(0.0);
    let mount_point = rest[5..].join(" ");

    if mount_point.is_empty() || total == 0 || is_pseudo_filesystem(&filesystem) {
        return None;
    }
    Some(DiskMetrics {
        device: device.to_string(),
        mount_point,
        filesystem,
        total,
        used,
        available,
        usage_percent,
    })
}

/// `df -B1 -P -T` → one entry per real filesystem.
///
/// Handles the POSIX quirk where a device name longer than the column is
/// printed on its own line ahead of the rest of the row.
pub fn parse_disk_usage(input: &str) -> Vec<DiskMetrics> {
    let mut disks = Vec::new();
    let mut wrapped_device: Option<String> = None;

    for line in input.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.is_empty() {
            continue;
        }

        if let Some(device) = wrapped_device.take() {
            // Continuation row: [type, total, used, available, use%, mount…]
            if fields.len() >= 6 {
                if let Some(disk) = build_disk(&device, &fields) {
                    disks.push(disk);
                }
            }
            continue;
        }

        if fields.len() == 1 {
            wrapped_device = Some(fields[0].to_string());
            continue;
        }

        if fields.len() >= 7 {
            // The header row fails to parse its size column, so it drops out.
            if let Some(disk) = build_disk(fields[0], &fields[1..]) {
                disks.push(disk);
            }
        }
    }

    disks
}

/// `/proc/net/dev` → per-interface byte counters. Loopback is skipped: it is
/// not a network link and would dominate any "total throughput" reading.
pub fn parse_net_dev(input: &str) -> Vec<(String, NetSample)> {
    let mut interfaces = Vec::new();
    for line in input.lines() {
        let Some((name, rest)) = line.split_once(':') else {
            continue;
        };
        let interface = name.trim().to_string();
        if interface.is_empty() || interface == "lo" {
            continue;
        }
        let fields: Vec<u64> = rest
            .split_whitespace()
            .filter_map(|value| value.parse().ok())
            .collect();
        // 8 receive fields, then 8 transmit fields; [8] is tx bytes.
        if fields.len() < 9 {
            continue;
        }
        interfaces.push((
            interface,
            NetSample {
                received: fields[0],
                transmitted: fields[8],
            },
        ));
    }
    interfaces.sort_by(|a, b| a.0.cmp(&b.0));
    interfaces
}

/// `ps -eo pid,user,pcpu,pmem,stat,lstart,comm` → processes sorted by CPU.
///
/// `lstart` is five whitespace-separated tokens (weekday, month, day, time,
/// year), and `comm` is a single token — the executable name. The command
/// column is therefore exactly `fields[10]`, and everything after it is
/// dropped on the floor: if a server ever answers with an old `args`-style
/// listing (passwords, tokens, database URLs inside), only the first token of
/// the executable path survives into the struct that reaches the frontend.
pub fn parse_processes(input: &str, limit: usize) -> Vec<ProcessInfo> {
    let mut processes = Vec::new();

    for line in input.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        // pid user pcpu pmem stat + 5 lstart tokens + ≥1 command word.
        if fields.len() < 11 {
            continue;
        }
        // Also drops the header row, whose "PID" is not a number.
        let Ok(pid) = fields[0].parse::<u32>() else {
            continue;
        };
        let Ok(cpu_percent) = fields[2].parse::<f64>() else {
            continue;
        };
        let Ok(memory_percent) = fields[3].parse::<f64>() else {
            continue;
        };

        processes.push(ProcessInfo {
            pid,
            user: fields[1].to_string(),
            cpu_percent,
            memory_percent,
            status: fields[4].to_string(),
            started_at: fields[5..10].join(" "),
            // `comm` is one token. Taking fields[10] and nothing else is the
            // safety net: arguments — where secrets live — are never copied.
            command: fields[10].to_string(),
        });
    }

    processes.sort_by(|a, b| {
        b.cpu_percent
            .partial_cmp(&a.cpu_percent)
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                b.memory_percent
                    .partial_cmp(&a.memory_percent)
                    .unwrap_or(Ordering::Equal)
            })
            .then_with(|| a.pid.cmp(&b.pid))
    });
    processes.truncate(limit);
    processes
}

/// `uname -srm` → (system name, kernel release, machine architecture).
pub fn parse_uname(input: &str) -> (String, String, String) {
    let mut fields = input.split_whitespace();
    (
        fields.next().unwrap_or_default().to_string(),
        fields.next().unwrap_or_default().to_string(),
        fields.next().unwrap_or_default().to_string(),
    )
}

/// `/proc/uptime` → whole seconds since boot.
pub fn parse_uptime(input: &str) -> u64 {
    let seconds = input
        .split_whitespace()
        .next()
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(0.0);
    if seconds > 0.0 {
        seconds as u64
    } else {
        0
    }
}

/// `/proc/loadavg` → (1m, 5m, 15m).
pub fn parse_loadavg(input: &str) -> Option<(f64, f64, f64)> {
    let mut fields = input.split_whitespace();
    let load_1 = fields.next()?.parse().ok()?;
    let load_5 = fields.next()?.parse().ok()?;
    let load_15 = fields.next()?.parse().ok()?;
    Some((load_1, load_5, load_15))
}

fn shell_unquote(value: &str) -> String {
    let trimmed = value.trim();
    for quote in ['"', '\''] {
        if trimmed.len() >= 2 && trimmed.starts_with(quote) && trimmed.ends_with(quote) {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

/// `os-release` → (pretty name, version). Either may be absent.
pub fn parse_os_release(input: &str) -> (Option<String>, Option<String>) {
    let mut values: HashMap<&str, String> = HashMap::new();
    for line in input.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        values
            .entry(key.trim())
            .or_insert_with(|| shell_unquote(value));
    }

    let pick = |keys: [&str; 2]| -> Option<String> {
        keys.iter()
            .find_map(|key| values.get(key).cloned())
            .filter(|value| !value.is_empty())
    };

    (
        pick(["PRETTY_NAME", "NAME"]),
        pick(["VERSION_ID", "VERSION"]),
    )
}

/// Turns byte counters into speeds by comparing against the previous reading.
fn network_metrics(
    current: &[(String, NetSample)],
    previous: Option<(&HashMap<String, NetSample>, Duration)>,
) -> Vec<NetworkMetrics> {
    let elapsed = previous
        .map(|(_, duration)| duration.as_secs_f64())
        .unwrap_or(0.0);

    current
        .iter()
        .map(|(interface, sample)| {
            // A brand-new interface has no baseline, so its speed is genuinely
            // unknown for this interval — reported as 0, never interpolated.
            let (receive_speed, transmit_speed) = match previous {
                Some((baseline, _)) if elapsed > 0.0 => match baseline.get(interface) {
                    Some(old) => (
                        sample.received.saturating_sub(old.received) as f64 / elapsed,
                        sample.transmitted.saturating_sub(old.transmitted) as f64 / elapsed,
                    ),
                    None => (0.0, 0.0),
                },
                _ => (0.0, 0.0),
            };

            NetworkMetrics {
                interface: interface.clone(),
                received_bytes: sample.received,
                transmitted_bytes: sample.transmitted,
                receive_speed,
                transmit_speed,
            }
        })
        .collect()
}

// -- Sample cache -----------------------------------------------------------

/// The previous reading for one session. Rates are deltas, so a collection
/// needs somewhere to diff against.
struct SampleCache {
    cpu: CpuSample,
    net: HashMap<String, NetSample>,
    at: tokio::time::Instant,
}

/// Per-session rate baselines.
///
/// Its lock is only ever held for a map lookup — never across an `await` — so
/// a slow server cannot stall other sessions' monitoring.
#[derive(Clone, Default)]
pub struct MonitorRegistry {
    samples: Arc<Mutex<HashMap<String, SampleCache>>>,
}

impl MonitorRegistry {
    /// Drops a session's baseline. Called on disconnect so a reconnect starts
    /// from a fresh measurement instead of diffing across the outage.
    pub async fn forget(&self, session_id: &str) {
        self.samples.lock().await.remove(session_id);
    }

    async fn take(&self, session_id: &str) -> Option<SampleCache> {
        self.samples.lock().await.remove(session_id)
    }

    async fn store(&self, session_id: &str, cpu: CpuSample, net: Vec<(String, NetSample)>) {
        self.samples.lock().await.insert(
            session_id.to_string(),
            SampleCache {
                cpu,
                net: net.into_iter().collect(),
                at: tokio::time::Instant::now(),
            },
        );
    }
}

/// CPU usage and network speeds for one collection.
struct Rates {
    usage_percent: f64,
    network: Vec<NetworkMetrics>,
}

// -- Command execution ------------------------------------------------------

fn require_ok(command: &str, output: ExecOutput) -> Result<String> {
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
async fn run(manager: &SshSessionManager, session_id: &str, command: &str) -> Result<String> {
    let output = manager.exec(session_id, command, COMMAND_TIMEOUT).await?;
    require_ok(command, output)
}

/// Runs the first command that succeeds. Used for `os-release`, whose location
/// differs between distributions.
async fn run_first(
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
async fn run_all(
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

fn result_for(results: &HashMap<&'static str, Result<String>>, command: &str) -> Result<String> {
    match results.get(command) {
        Some(Ok(value)) => Ok(value.clone()),
        Some(Err(error)) => Err(anyhow!("{error}")),
        None => Err(anyhow!("命令未执行：{command}")),
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0)
}

/// Rejects anything that is not Linux, with a message the UI can show as-is.
async fn require_linux(manager: &SshSessionManager, session_id: &str) -> Result<()> {
    let (system, _, _) = parse_uname(&run(manager, session_id, CMD_UNAME).await?);
    if system.eq_ignore_ascii_case(SUPPORTED_OS) {
        Ok(())
    } else {
        Err(unsupported_message(&system))
    }
}

fn unsupported_message(system: &str) -> anyhow::Error {
    let label = if system.is_empty() {
        "未知系统"
    } else {
        system
    };
    anyhow!("不支持的操作系统：{label}。BLS-OPS 目前只提供 {SUPPORTED_OS} 服务器的只读监控。")
}

/// A snapshot that says "we cannot monitor this" instead of showing zeroes.
fn unsupported_snapshot(session_id: &str, system: &str) -> MonitorSnapshot {
    let label = if system.is_empty() {
        "未知系统"
    } else {
        system
    };
    MonitorSnapshot {
        session_id: session_id.to_string(),
        collected_at: now_secs(),
        supported: false,
        unsupported_reason: Some(unsupported_message(system).to_string()),
        system: SystemInfo {
            os_name: label.to_string(),
            ..SystemInfo::default()
        },
        ..MonitorSnapshot::default()
    }
}

// -- Collection -------------------------------------------------------------

/// Resolves CPU usage and network speeds against the previous collection.
///
/// Rates are deltas, so a session's first collection takes a second sample
/// after a short window: the first point is a real measurement, not a
/// stand-in. `cpu` / `net` are `None` when a caller only collected one of
/// them — the untouched half then inherits the previous baseline instead of
/// being clobbered by an empty one.
async fn resolve_rates(
    manager: &SshSessionManager,
    registry: &MonitorRegistry,
    session_id: &str,
    cpu: Option<CpuSample>,
    net: Option<Vec<(String, NetSample)>>,
) -> Result<Rates> {
    let previous = registry.take(session_id).await;

    let (usage_percent, network, latest_cpu, latest_net) = match previous {
        Some(previous) => {
            let elapsed = previous.at.elapsed();
            let current_cpu = cpu.unwrap_or(previous.cpu);
            let current_net = net.unwrap_or_else(|| {
                previous
                    .net
                    .iter()
                    .map(|(name, sample)| (name.clone(), *sample))
                    .collect()
            });
            (
                cpu_usage_percent(&previous.cpu, &current_cpu),
                network_metrics(&current_net, Some((&previous.net, elapsed))),
                current_cpu,
                current_net,
            )
        }
        None => {
            // Nothing to diff against yet: read both counters a second time.
            tokio::time::sleep(BASELINE_DELAY).await;
            let second = run_all(manager, session_id, &[CMD_CPU, CMD_NETWORK]).await;
            let second_cpu = parse_cpu_stat(&result_for(&second, CMD_CPU)?)
                .ok_or_else(|| anyhow!("无法解析 /proc/stat"))?;
            let second_net = parse_net_dev(&result_for(&second, CMD_NETWORK)?);

            let sampled_net = net.is_some();
            let baseline: HashMap<String, NetSample> =
                net.unwrap_or_default().into_iter().collect();
            // A caller that did not read the counters gets 0 speeds rather
            // than a number derived from a reading it never took.
            let network = network_metrics(
                &second_net,
                sampled_net.then_some((&baseline, BASELINE_DELAY)),
            );
            let usage = cpu
                .map(|first| cpu_usage_percent(&first, &second_cpu))
                .unwrap_or(0.0);

            (usage, network, second_cpu, second_net)
        }
    };

    // The newest reading becomes the baseline for the next collection.
    registry.store(session_id, latest_cpu, latest_net).await;

    Ok(Rates {
        usage_percent,
        network,
    })
}

/// Host identity and OS only.
pub async fn collect_system_info(
    manager: &SshSessionManager,
    session_id: &str,
) -> Result<SystemInfo> {
    require_linux(manager, session_id).await?;

    let outputs = run_all(manager, session_id, &[CMD_UNAME, CMD_HOSTNAME, CMD_UPTIME]).await;
    let (_, kernel, architecture) = parse_uname(&result_for(&outputs, CMD_UNAME)?);

    let (os_name, os_version) = run_first(manager, session_id, CMD_OS_RELEASE)
        .await
        .as_deref()
        .map(parse_os_release)
        .unwrap_or((None, None));

    Ok(SystemInfo {
        hostname: result_for(&outputs, CMD_HOSTNAME)?.trim().to_string(),
        os_name: os_name.unwrap_or_else(|| SUPPORTED_OS.to_string()),
        os_version: os_version.unwrap_or_default(),
        kernel,
        architecture,
        uptime_seconds: parse_uptime(&result_for(&outputs, CMD_UPTIME)?),
    })
}

/// CPU utilisation, load average and core count.
pub async fn collect_cpu(
    manager: &SshSessionManager,
    registry: &MonitorRegistry,
    session_id: &str,
) -> Result<CpuMetrics> {
    require_linux(manager, session_id).await?;

    let outputs = run_all(manager, session_id, &[CMD_CPU, CMD_LOADAVG]).await;
    let (load_1, load_5, load_15) = parse_loadavg(&result_for(&outputs, CMD_LOADAVG)?)
        .ok_or_else(|| anyhow!("无法解析 /proc/loadavg"))?;
    let sample = parse_cpu_stat(&result_for(&outputs, CMD_CPU)?)
        .ok_or_else(|| anyhow!("无法解析 /proc/stat"))?;

    // Only the CPU is read here; the network baseline is left untouched.
    let rates = resolve_rates(manager, registry, session_id, Some(sample), None).await?;

    Ok(CpuMetrics {
        usage_percent: rates.usage_percent,
        load_1,
        load_5,
        load_15,
        logical_cores: sample.logical_cores,
    })
}

/// Physical memory and swap.
pub async fn collect_memory(
    manager: &SshSessionManager,
    session_id: &str,
) -> Result<MemoryMetrics> {
    require_linux(manager, session_id).await?;
    let output = run(manager, session_id, CMD_MEMORY).await?;
    parse_meminfo(&output).ok_or_else(|| anyhow!("无法解析 /proc/meminfo"))
}

/// Real filesystems, pseudo filesystems excluded.
pub async fn collect_disks(
    manager: &SshSessionManager,
    session_id: &str,
) -> Result<Vec<DiskMetrics>> {
    require_linux(manager, session_id).await?;
    Ok(parse_disk_usage(
        &run(manager, session_id, CMD_DISKS).await?,
    ))
}

/// Per-interface counters and speeds.
pub async fn collect_network(
    manager: &SshSessionManager,
    registry: &MonitorRegistry,
    session_id: &str,
) -> Result<Vec<NetworkMetrics>> {
    require_linux(manager, session_id).await?;

    let sample = parse_net_dev(&run(manager, session_id, CMD_NETWORK).await?);
    // Only the counters are read here; the CPU baseline is left untouched.
    let rates = resolve_rates(manager, registry, session_id, None, Some(sample)).await?;
    Ok(rates.network)
}

/// Top processes by CPU usage.
pub async fn collect_processes(
    manager: &SshSessionManager,
    session_id: &str,
) -> Result<Vec<ProcessInfo>> {
    require_linux(manager, session_id).await?;
    let output = run(manager, session_id, CMD_PROCESSES).await?;
    Ok(parse_processes(&output, PROCESS_LIMIT))
}

/// Everything the monitoring page shows, in one round trip.
///
/// A non-Linux host is reported through `supported: false` rather than as an
/// error, so the page can still show which machine it is talking to.
pub async fn collect_snapshot(
    manager: &SshSessionManager,
    registry: &MonitorRegistry,
    session_id: &str,
) -> Result<MonitorSnapshot> {
    let (system, kernel, architecture) = parse_uname(&run(manager, session_id, CMD_UNAME).await?);
    if !system.eq_ignore_ascii_case(SUPPORTED_OS) {
        return Ok(unsupported_snapshot(session_id, &system));
    }

    let outputs = run_all(
        manager,
        session_id,
        &[
            CMD_HOSTNAME,
            CMD_UPTIME,
            CMD_LOADAVG,
            CMD_CPU,
            CMD_MEMORY,
            CMD_DISKS,
            CMD_NETWORK,
            CMD_PROCESSES,
            CMD_OS_RELEASE[0],
        ],
    )
    .await;

    let hostname = result_for(&outputs, CMD_HOSTNAME)?.trim().to_string();
    let uptime_seconds = parse_uptime(&result_for(&outputs, CMD_UPTIME)?);
    let (load_1, load_5, load_15) = parse_loadavg(&result_for(&outputs, CMD_LOADAVG)?)
        .ok_or_else(|| anyhow!("无法解析 /proc/loadavg"))?;

    let cpu_sample = parse_cpu_stat(&result_for(&outputs, CMD_CPU)?)
        .ok_or_else(|| anyhow!("无法解析 /proc/stat"))?;
    let logical_cores = cpu_sample.logical_cores;
    let net_sample = parse_net_dev(&result_for(&outputs, CMD_NETWORK)?);

    let memory = parse_meminfo(&result_for(&outputs, CMD_MEMORY)?)
        .ok_or_else(|| anyhow!("无法解析 /proc/meminfo"))?;
    let disks = parse_disk_usage(&result_for(&outputs, CMD_DISKS)?);
    let processes = parse_processes(&result_for(&outputs, CMD_PROCESSES)?, PROCESS_LIMIT);

    let rates = resolve_rates(
        manager,
        registry,
        session_id,
        Some(cpu_sample),
        Some(net_sample),
    )
    .await?;

    // `/etc/os-release` is optional; only fall back when it is missing.
    let (os_name, os_version) = match outputs.get(CMD_OS_RELEASE[0]) {
        Some(Ok(text)) => parse_os_release(text),
        _ => run_first(manager, session_id, CMD_OS_RELEASE)
            .await
            .as_deref()
            .map(parse_os_release)
            .unwrap_or((None, None)),
    };

    Ok(MonitorSnapshot {
        session_id: session_id.to_string(),
        collected_at: now_secs(),
        supported: true,
        unsupported_reason: None,
        system: SystemInfo {
            hostname,
            os_name: os_name.unwrap_or_else(|| SUPPORTED_OS.to_string()),
            os_version: os_version.unwrap_or_default(),
            kernel,
            architecture,
            uptime_seconds,
        },
        cpu: CpuMetrics {
            usage_percent: rates.usage_percent,
            load_1,
            load_5,
            load_15,
            logical_cores,
        },
        memory,
        disks,
        network: rates.network,
        processes,
    })
}

// ---------------------------------------------------------------------------
// Tests — parsing over fixed samples
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const STAT_FIRST: &str = "\
cpu  1000 20 300 5000 10 0 5 0 0 0
cpu0 500 10 150 2500 5 0 2 0 0 0
cpu1 500 10 150 2500 5 0 3 0 0 0
intr 123456 1 2 3
ctxt 987654
btime 1700000000
processes 4321
procs_running 2
procs_blocked 0
";

    const STAT_SECOND: &str = "\
cpu  1060 20 360 5040 10 0 5 0 0 0
cpu0 530 10 180 2520 5 0 2 0 0 0
cpu1 530 10 180 2520 5 0 3 0 0 0
intr 123999 1 2 3
ctxt 988111
";

    const MEMINFO: &str = "\
MemTotal:        8000000 kB
MemFree:         1000000 kB
MemAvailable:    3000000 kB
Buffers:          200000 kB
Cached:          1500000 kB
SwapCached:            0 kB
SwapTotal:       2000000 kB
SwapFree:        1500000 kB
Shmem:             50000 kB
";

    const DF: &str = "\
Filesystem     Type 1B-blocks         Used    Available Use% Mounted on
/dev/sda1      ext4 107374182400 53687091200 48318385152  53% /
tmpfs          tmpfs   1073741824           0  1073741824   0% /dev/shm
/dev/sdb1      xfs  2199023255552 1099511627776 1099511627776  50% /data
";

    const DF_WRAPPED: &str = "\
Filesystem     Type 1B-blocks         Used    Available Use% Mounted on
/dev/mapper/very-long-volume-name
               ext4   1073741824   536870912   536870912  50% /mnt/long
";

    const NET_DEV: &str = "\
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:    1000      10    0    0    0     0          0         0     2000      20    0    0    0     0       0          0
  eth0: 1000000    5000    0    0    0     0          0         0  2000000    4000    0    0    0     0       0          0
  eth1:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0
";

    const PS: &str = "\
  PID USER     %CPU %MEM STAT                  STARTED COMMAND
    1 root      0.0  0.1 Ss   Tue Aug 31 10:00:00 2026 init
   42 www-data 12.5  3.2 S    Mon Sep  1 09:15:30 2026 nginx
    7 root      0.5  0.0 R    Tue Aug 31 10:00:05 2026 ps
";

    const OS_RELEASE: &str = "\
NAME=\"Ubuntu\"
VERSION=\"22.04.3 LTS (Jammy Jellyfish)\"
ID=ubuntu
VERSION_ID=\"22.04\"
PRETTY_NAME=\"Ubuntu 22.04.3 LTS\"
";

    #[test]
    fn cpu_stat_reads_the_aggregate_line_and_counts_cores() {
        let sample = parse_cpu_stat(STAT_FIRST).expect("parse /proc/stat");
        assert_eq!(
            sample.total, 6335,
            "user+nice+system+idle+iowait+irq+softirq+steal"
        );
        assert_eq!(sample.idle, 5010, "idle + iowait");
        assert_eq!(sample.logical_cores, 2);
    }

    /// The headline requirement: usage comes from two samples, never one.
    #[test]
    fn cpu_usage_is_the_delta_between_two_samples() {
        let first = parse_cpu_stat(STAT_FIRST).expect("first");
        let second = parse_cpu_stat(STAT_SECOND).expect("second");

        // 160 jiffies elapsed, 40 of them idle → 75% busy.
        assert_eq!(cpu_usage_percent(&first, &second), 75.0);
    }

    #[test]
    fn cpu_usage_is_zero_when_no_time_passed() {
        let first = parse_cpu_stat(STAT_FIRST).expect("first");
        assert_eq!(cpu_usage_percent(&first, &first), 0.0);
    }

    #[test]
    fn cpu_stat_without_an_aggregate_line_is_rejected() {
        assert!(parse_cpu_stat("intr 1 2 3\nctxt 4\n").is_none());
        assert!(parse_cpu_stat("").is_none());
    }

    #[test]
    fn meminfo_is_converted_to_bytes() {
        let memory = parse_meminfo(MEMINFO).expect("parse /proc/meminfo");
        assert_eq!(memory.total, 8_000_000 * 1024);
        assert_eq!(memory.available, 3_000_000 * 1024);
        assert_eq!(memory.used, 5_000_000 * 1024);
        assert_eq!(memory.swap_total, 2_000_000 * 1024);
        assert_eq!(memory.swap_used, 500_000 * 1024);
        assert_eq!(memory.usage_percent, 62.5);
    }

    #[test]
    fn meminfo_falls_back_to_free_plus_cached_when_available_is_missing() {
        let memory =
            parse_meminfo("MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 250 kB\n")
                .expect("parse");
        assert_eq!(memory.available, 400 * 1024);
        assert_eq!(memory.used, 600 * 1024);
        assert_eq!(memory.usage_percent, 60.0);
    }

    #[test]
    fn meminfo_without_a_total_is_rejected() {
        assert!(parse_meminfo("MemFree: 100 kB\n").is_none());
    }

    #[test]
    fn disks_skip_the_header_and_pseudo_filesystems() {
        let disks = parse_disk_usage(DF);
        assert_eq!(disks.len(), 2, "tmpfs must be filtered out: {disks:?}");

        assert_eq!(disks[0].device, "/dev/sda1");
        assert_eq!(disks[0].filesystem, "ext4");
        assert_eq!(disks[0].mount_point, "/");
        assert_eq!(disks[0].total, 107_374_182_400);
        assert_eq!(disks[0].used, 53_687_091_200);
        assert_eq!(disks[0].available, 48_318_385_152);
        assert_eq!(disks[0].usage_percent, 53.0);

        assert_eq!(disks[1].mount_point, "/data");
        assert_eq!(disks[1].filesystem, "xfs");
    }

    /// `df -P` puts an over-long device name on a line of its own.
    #[test]
    fn disks_handle_wrapped_device_names() {
        let disks = parse_disk_usage(DF_WRAPPED);
        assert_eq!(disks.len(), 1, "{disks:?}");
        assert_eq!(disks[0].device, "/dev/mapper/very-long-volume-name");
        assert_eq!(disks[0].mount_point, "/mnt/long");
        assert_eq!(disks[0].usage_percent, 50.0);
    }

    #[test]
    fn disks_ignore_unparseable_rows() {
        assert!(parse_disk_usage("").is_empty());
        assert!(parse_disk_usage("not a df output at all\n").is_empty());
    }

    #[test]
    fn net_dev_reads_byte_counters_and_skips_loopback() {
        let interfaces = parse_net_dev(NET_DEV);
        assert_eq!(interfaces.len(), 2, "lo must be skipped: {interfaces:?}");

        let (name, sample) = &interfaces[0];
        assert_eq!(name, "eth0");
        assert_eq!(sample.received, 1_000_000);
        assert_eq!(sample.transmitted, 2_000_000);

        assert_eq!(interfaces[1].0, "eth1");
        assert_eq!(interfaces[1].1.received, 0);
    }

    #[test]
    fn network_speeds_come_from_the_previous_sample() {
        let current = parse_net_dev(NET_DEV);
        let mut baseline = HashMap::new();
        baseline.insert(
            "eth0".to_string(),
            NetSample {
                received: 500_000,
                transmitted: 1_500_000,
            },
        );

        let metrics = network_metrics(&current, Some((&baseline, Duration::from_secs(2))));
        let eth0 = metrics
            .iter()
            .find(|entry| entry.interface == "eth0")
            .expect("eth0");

        // 500 000 bytes in 2 s = 250 000 B/s in each direction.
        assert_eq!(eth0.receive_speed, 250_000.0);
        assert_eq!(eth0.transmit_speed, 250_000.0);
        assert_eq!(eth0.received_bytes, 1_000_000);

        // No baseline for eth1 → the speed is unknown, reported as 0.
        let eth1 = metrics
            .iter()
            .find(|entry| entry.interface == "eth1")
            .expect("eth1");
        assert_eq!(eth1.receive_speed, 0.0);
    }

    #[test]
    fn network_speeds_are_zero_without_a_baseline() {
        let metrics = network_metrics(&parse_net_dev(NET_DEV), None);
        assert!(metrics.iter().all(|entry| entry.receive_speed == 0.0));
    }

    #[test]
    fn processes_are_parsed_and_sorted_by_cpu() {
        let processes = parse_processes(PS, 10);
        assert_eq!(processes.len(), 3, "header must be skipped: {processes:?}");

        assert_eq!(processes[0].pid, 42);
        assert_eq!(processes[0].user, "www-data");
        assert_eq!(processes[0].cpu_percent, 12.5);
        assert_eq!(processes[0].memory_percent, 3.2);
        assert_eq!(processes[0].status, "S");
        assert_eq!(processes[0].started_at, "Mon Sep 1 09:15:30 2026");
        // `comm` output: the bare executable name, one token.
        assert_eq!(processes[0].command, "nginx");

        assert_eq!(processes[1].pid, 7);
        assert_eq!(processes[2].pid, 1);
        assert_eq!(processes[2].command, "init");
    }

    /// The safety net: if a server answers with an old `args`-style listing —
    /// command lines carrying passwords, tokens and database URLs — the parser
    /// must keep only the executable's first token. Nothing after it may reach
    /// the serialized struct that goes to the frontend.
    #[test]
    fn process_listing_never_carries_command_line_secrets() {
        let args_style = "\
  PID USER     %CPU %MEM STAT                  STARTED COMMAND
   42 www-data 12.5  3.2 S    Mon Sep  1 09:15:30 2026 /usr/sbin/nginx --password=hunter2 --token=tok_abc postgresql://ops:hunter2@db.internal/ops
    7 root      0.5  0.0 R    Tue Aug 31 10:00:05 2026 ps -eo pid,user,pcpu,pmem,stat,lstart,args
";
        let processes = parse_processes(args_style, 10);
        assert_eq!(processes.len(), 2, "{processes:?}");

        // The whole structure is serialized the same way Tauri hands it to
        // the WebView — the secrets must not be in there, under any field.
        let serialized = serde_json::to_string(&processes).expect("serialize");
        assert!(!serialized.contains("hunter2"), "{serialized}");
        assert!(!serialized.contains("tok_abc"), "{serialized}");
        assert!(!serialized.contains("postgresql://"), "{serialized}");
        assert!(!serialized.contains("db.internal"), "{serialized}");
        assert!(!serialized.contains("--password"), "{serialized}");

        // The executable name itself is still usable.
        assert_eq!(processes[0].command, "/usr/sbin/nginx");
        assert_eq!(processes[1].command, "ps");
    }

    #[test]
    fn process_list_is_capped() {
        let processes = parse_processes(PS, 2);
        assert_eq!(processes.len(), 2);
        assert_eq!(processes[0].pid, 42);
    }

    #[test]
    fn process_rows_that_are_too_short_are_ignored() {
        let processes = parse_processes("1 root 0.0 0.0 S\n", 10);
        assert!(processes.is_empty(), "{processes:?}");
    }

    #[test]
    fn uname_splits_into_system_release_and_machine() {
        assert_eq!(
            parse_uname("Linux 5.15.0-91-generic x86_64\n"),
            (
                "Linux".to_string(),
                "5.15.0-91-generic".to_string(),
                "x86_64".to_string()
            )
        );
        // A non-Linux host is recognised by its system name.
        assert_eq!(
            parse_uname("Darwin 22.6.0 arm64\n"),
            (
                "Darwin".to_string(),
                "22.6.0".to_string(),
                "arm64".to_string()
            )
        );
    }

    #[test]
    fn uptime_is_the_first_field_as_whole_seconds() {
        assert_eq!(parse_uptime("12345.67 98765.43\n"), 12345);
        assert_eq!(parse_uptime(""), 0);
        assert_eq!(parse_uptime("garbage"), 0);
    }

    #[test]
    fn loadavg_reads_all_three_values() {
        assert_eq!(
            parse_loadavg("0.12 0.34 0.56 1/234 12345\n"),
            Some((0.12, 0.34, 0.56))
        );
        assert_eq!(parse_loadavg("0.12 0.34\n"), None);
    }

    #[test]
    fn os_release_prefers_pretty_name_and_version_id() {
        let (name, version) = parse_os_release(OS_RELEASE);
        assert_eq!(name.as_deref(), Some("Ubuntu 22.04.3 LTS"));
        assert_eq!(version.as_deref(), Some("22.04"));
    }

    #[test]
    fn os_release_falls_back_to_name_and_version() {
        let (name, version) = parse_os_release("NAME=CentOS Stream\nVERSION=9\n");
        assert_eq!(name.as_deref(), Some("CentOS Stream"));
        assert_eq!(version.as_deref(), Some("9"));
    }

    #[test]
    fn a_failed_command_becomes_an_error_not_empty_output() {
        let failure = ExecOutput {
            stdout: String::new(),
            stderr: "df: /nope: No such file or directory\n".to_string(),
            exit_code: Some(1),
        };
        let error = require_ok("df -B1 -P -T", failure).expect_err("must fail");
        assert!(error.to_string().contains("退出码 1"), "{error}");
        assert!(error.to_string().contains("No such file"), "{error}");
    }

    #[test]
    fn a_successful_command_returns_its_stdout() {
        let output = ExecOutput {
            stdout: "ok\n".to_string(),
            stderr: String::new(),
            exit_code: Some(0),
        };
        assert_eq!(require_ok("true", output).expect("ok"), "ok\n");
    }

    #[test]
    fn command_timeout_is_five_seconds() {
        assert_eq!(COMMAND_TIMEOUT, Duration::from_secs(5));
    }

    #[test]
    fn unsupported_message_names_the_offending_system() {
        let message = unsupported_message("Darwin").to_string();
        assert!(message.contains("不支持的操作系统"), "{message}");
        assert!(message.contains("Darwin"), "{message}");
    }

    #[test]
    fn an_unsupported_snapshot_carries_no_metrics() {
        let snapshot = unsupported_snapshot("s1", "Darwin");
        assert!(!snapshot.supported);
        assert_eq!(snapshot.system.os_name, "Darwin");
        assert!(snapshot.disks.is_empty());
        assert!(snapshot.network.is_empty());
        assert!(snapshot.processes.is_empty());
        assert!(snapshot
            .unsupported_reason
            .as_deref()
            .unwrap_or_default()
            .contains("不支持"));
    }
}
