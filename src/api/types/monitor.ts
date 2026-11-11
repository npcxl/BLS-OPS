/**
 * Server monitoring — read-only Linux metrics over the live session.
 *
 * The commands run on the server are a fixed table inside Rust: these calls
 * take only a `session_id`, so the WebView can never pass a shell string.
 */

export interface SystemInfo {
  hostname: string;
  os_name: string;
  os_version: string;
  kernel: string;
  architecture: string;
  uptime_seconds: number;
}

export interface CpuMetrics {
  usage_percent: number;
  load_1: number;
  load_5: number;
  load_15: number;
  logical_cores: number;
}

/** Memory and swap, in bytes. */
export interface MemoryMetrics {
  total: number;
  used: number;
  available: number;
  swap_total: number;
  swap_used: number;
  usage_percent: number;
}

export interface DiskMetrics {
  device: string;
  mount_point: string;
  filesystem: string;
  total: number;
  used: number;
  available: number;
  usage_percent: number;
}

export interface NetworkMetrics {
  interface: string;
  received_bytes: number;
  transmitted_bytes: number;
  /** Bytes per second, measured against the previous sample. */
  receive_speed: number;
  transmit_speed: number;
}

export interface ProcessInfo {
  pid: number;
  user: string;
  cpu_percent: number;
  memory_percent: number;
  status: string;
  started_at: string;
  /** Executable name only (`ps … comm`). Startup arguments never leave the server. */
  command: string;
}

/** 一块 NVIDIA GPU。没有 `nvidia-smi` 的机器上 `gpus` 恒为空数组。 */
export interface GpuMetrics {
  index: number;
  name: string;
  /** 0–100. */
  utilization_percent: number;
  memory_used: number;
  memory_total: number;
  temperature_c: number;
  /** 受限驱动/虚拟化下为 0（`[N/A]`）。 */
  power_watts: number;
}

export interface MonitorSnapshot {
  session_id: string;
  /** Unix seconds of the collection. */
  collected_at: number;
  /** `false` when the remote OS is not Linux — no metrics are invented. */
  supported: boolean;
  unsupported_reason: string | null;
  system: SystemInfo;
  cpu: CpuMetrics;
  memory: MemoryMetrics;
  disks: DiskMetrics[];
  network: NetworkMetrics[];
  processes: ProcessInfo[];
  /** 没有 NVIDIA 工具链时为空（不是错误）。 */
  gpus: GpuMetrics[];
}
