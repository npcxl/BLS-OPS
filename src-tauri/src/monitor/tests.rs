//! Parsing tests over fixed samples (moved verbatim from `monitor.rs`).

use std::collections::HashMap;
use std::time::Duration;

use super::exec::require_ok;
use super::model::COMMAND_TIMEOUT;
use super::parse::{
    cpu_usage_percent, network_metrics, parse_cpu_stat, parse_disk_usage, parse_loadavg,
    parse_meminfo, parse_net_dev, parse_os_release, parse_processes, parse_uname, parse_uptime,
};
use super::{NetSample, SystemInfo};
use crate::ssh::ExecOutput;

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
    let message = super::unsupported_message("Darwin").to_string();
    assert!(message.contains("不支持的操作系统"), "{message}");
    assert!(message.contains("Darwin"), "{message}");
}

#[test]
fn an_unsupported_snapshot_carries_no_metrics() {
    let snapshot = super::unsupported_snapshot("s1", "Darwin");
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

// Keeps the `SystemInfo` import honest: the struct is what reaches the UI.
#[test]
fn system_info_defaults_to_empty_strings() {
    let info = SystemInfo::default();
    assert!(info.hostname.is_empty());
    assert_eq!(info.uptime_seconds, 0);
}
