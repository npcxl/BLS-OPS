//! Pure parsers over fixed command output.
//!
//! Every function here takes a sample string and returns typed values, with no
//! I/O — which is what makes the whole command table unit-testable without a
//! server (see `tests.rs`).

use std::collections::HashMap;
use std::time::Duration;

use super::model::{CpuSample, DiskMetrics, MemoryMetrics, NetSample, NetworkMetrics, ProcessInfo};

fn percent(part: u64, total: u64) -> f64 {
    if total == 0 {
        return 0.0;
    }
    (part as f64 / total as f64) * 100.0
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
    use std::cmp::Ordering;

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
pub(crate) fn network_metrics(
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
