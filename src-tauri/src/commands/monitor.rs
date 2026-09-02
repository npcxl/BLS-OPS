//! Server monitoring commands — read-only Linux metrics over the live session.
//!
//! Every command here takes only a `session_id`: the commands that run on the
//! server are a fixed table inside `monitor.rs`, so the WebView cannot ask for
//! an arbitrary shell string.

use tauri::State;

use crate::monitor::{
    CpuMetrics, DiskMetrics, MemoryMetrics, MonitorSnapshot, NetworkMetrics, ProcessInfo,
    SystemInfo,
};
use crate::state::AppState;

#[tauri::command]
pub async fn monitor_system_info(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SystemInfo, String> {
    crate::monitor::collect_system_info(&state.ssh, &session_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_cpu(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<CpuMetrics, String> {
    crate::monitor::collect_cpu(&state.ssh, &state.monitor, &session_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_memory(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<MemoryMetrics, String> {
    crate::monitor::collect_memory(&state.ssh, &session_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_disks(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<DiskMetrics>, String> {
    crate::monitor::collect_disks(&state.ssh, &session_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_network(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<NetworkMetrics>, String> {
    crate::monitor::collect_network(&state.ssh, &state.monitor, &session_id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn monitor_processes(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<ProcessInfo>, String> {
    crate::monitor::collect_processes(&state.ssh, &session_id)
        .await
        .map_err(|error| error.to_string())
}

/// The one call the monitoring page is built around: every headline metric in
/// a single round trip.
#[tauri::command]
pub async fn monitor_snapshot(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<MonitorSnapshot, String> {
    crate::monitor::collect_snapshot(&state.ssh, &state.monitor, &session_id)
        .await
        .map_err(|error| error.to_string())
}
