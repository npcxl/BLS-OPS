//! Collection functions — the public surface used by the Tauri commands.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Result};

use crate::ssh::SshSessionManager;

use super::exec::{require_linux, result_for, run, run_all, run_first, unsupported_message};
use super::model::{
    BASELINE_DELAY, CMD_CPU, CMD_DISKS, CMD_HOSTNAME, CMD_LOADAVG, CMD_MEMORY, CMD_NETWORK,
    CMD_OS_RELEASE, CMD_PROCESSES, CMD_UNAME, CMD_UPTIME, PROCESS_LIMIT, SUPPORTED_OS, CpuMetrics,
    CpuSample, DiskMetrics, MemoryMetrics, MonitorSnapshot, NetSample, NetworkMetrics, ProcessInfo,
    Rates, SystemInfo,
};
use super::parse::{
    cpu_usage_percent, network_metrics, parse_cpu_stat, parse_disk_usage, parse_loadavg,
    parse_meminfo, parse_net_dev, parse_os_release, parse_processes, parse_uname, parse_uptime,
};
use super::registry::MonitorRegistry;

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs() as i64)
        .unwrap_or(0)
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
) -> Result<Vec<super::model::DiskMetrics>> {
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
) -> Result<Vec<super::model::NetworkMetrics>> {
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
) -> Result<Vec<super::model::ProcessInfo>> {
    require_linux(manager, session_id).await?;
    let output = run(manager, session_id, CMD_PROCESSES).await?;
    Ok(parse_processes(&output, super::model::PROCESS_LIMIT))
}

/// Everything the monitoring page shows, in one round trip.
///
/// A non-Linux host is reported through `supported: false` rather than as an
/// error, so the page can still show which machine it is talking to.
pub async fn collect_snapshot(
    manager: &SshSessionManager,
    registry: &MonitorRegistry,
    session_id: &str,
) -> Result<super::model::MonitorSnapshot> {
    use super::model::{
        CpuMetrics, MonitorSnapshot, PROCESS_LIMIT, SystemInfo,
    };

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
