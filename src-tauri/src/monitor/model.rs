//! Monitoring data model and the fixed command table.
//!
//! The command table is the whole security story for this module: the frontend
//! passes only a `session_id`, every command below is a constant, and nothing
//! here writes or takes user input.

use serde::Serialize;

/// Hard budget for one monitoring command.
pub const COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// The only operating system this module knows how to read.
pub const SUPPORTED_OS: &str = "Linux";

/// How many processes a snapshot carries. Enough to find what is eating a
/// server, small enough to keep a 5-second poll cheap.
pub const PROCESS_LIMIT: usize = 100;

/// Window between the two samples taken on a session's very first collection.
/// Rates (CPU %, network speed) are deltas, so the first collection needs two
/// readings — without it the first point would have to be a made-up zero.
pub const BASELINE_DELAY: std::time::Duration = std::time::Duration::from_millis(200);

// -- The command table ------------------------------------------------------
//
// Fixed, read-only and boring on purpose: nothing here writes, nothing takes
// user input, and every command exists in any mainstream Linux distribution.

pub(crate) const CMD_UNAME: &str = "uname -srm";
pub(crate) const CMD_HOSTNAME: &str = "cat /proc/sys/kernel/hostname";
pub(crate) const CMD_UPTIME: &str = "cat /proc/uptime";
pub(crate) const CMD_LOADAVG: &str = "cat /proc/loadavg";
pub(crate) const CMD_CPU: &str = "cat /proc/stat";
pub(crate) const CMD_MEMORY: &str = "cat /proc/meminfo";
pub(crate) const CMD_DISKS: &str = "df -B1 -P -T";
pub(crate) const CMD_NETWORK: &str = "cat /proc/net/dev";
/// `comm` instead of `args`: a full command line carries passwords
/// (`--password=…`), tokens, database URLs and API keys — none of that may
/// reach the client. `comm` answers with the bare executable name.
pub(crate) const CMD_PROCESSES: &str = "ps -eo pid,user,pcpu,pmem,stat,lstart,comm";
/// `/etc/os-release` is the documented location; systemd also publishes it in
/// `/usr/lib/os-release` for distributions that treat `/etc` as editable.
pub(crate) const CMD_OS_RELEASE: &[&str] = &["cat /etc/os-release", "cat /usr/lib/os-release"];
/// 有没有 NVIDIA 工具链：**只探一次**（按会话缓存）。`nvidia-smi` 冷启动要
/// 加载 NVML（100~200ms），每轮都跑一遍纯属浪费；探不到就永久跳过 GPU。
pub(crate) const CMD_PROBE_GPU: &str = "command -v nvidia-smi";
/// 只要需要的那几个字段，不用默认表格输出。`nounits` 去掉 `MiB`/`%` 后缀。
pub(crate) const CMD_GPU: &str = "nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits";

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

/// 一块 NVIDIA GPU 的实时状态（`nvidia-smi` 只读查询）。
///
/// 没有 NVIDIA 驱动 / 没有 `nvidia-smi` 的机器上这个列表恒为空 —— 不报错、
/// 不显示空卡片，避免把"没有 GPU"渲染成"GPU 异常"。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct GpuMetrics {
    pub index: u32,
    pub name: String,
    /// 0–100（`utilization.gpu`）。
    pub utilization_percent: f64,
    pub memory_used: u64,
    pub memory_total: u64,
    pub temperature_c: f64,
    /// 部分卡（虚拟化/受限驱动）不报功耗，此时为 0。
    pub power_watts: f64,
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
    /// 没有 NVIDIA 工具链时为空（不是错误）。
    #[serde(default)]
    pub gpus: Vec<GpuMetrics>,
}

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

/// CPU usage and network speeds for one collection.
pub(crate) struct Rates {
    pub usage_percent: f64,
    pub network: Vec<NetworkMetrics>,
}
