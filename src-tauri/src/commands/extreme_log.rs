//! 极核的**实时日志**：独立的 SSH 长连接，与问答任务互不影响。
//!
//! 与 Agent 的区别只有一点，但很关键：它不是"跑一条命令、拿结果"，而是一直
//! 读、一直推。因此：
//! * 命令用 `tail -F` / `journalctl -f` / `docker logs -f`，输出直接进 Channel；
//! * 停止时**杀掉远端进程**（`kill -TERM <pid>`），不是只关界面；
//! * 进程 pid 由第一条 `__BLS_LOG_PID__<pid>` 行回传 —— 那是 `exec` 的 shell
//!   自己的 pid（命令用 `exec` 顶替，所以它同时就是 tail 的 pid）。
//!
//! 归属由前端负责：一条流只属于打开它的 `workspaceId + serverId + sessionId`。

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Mutex;

use crate::ops_error::{OpsError, OpsResult};
use crate::ssh::utf8_stream::Utf8StreamDecoder;
use crate::ssh::ExecChunk;
use crate::state::AppState;

/// 日志来源：与前端 `LogSource` 一一对应。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LogSource {
    /// 直接写文件。
    File { path: String, label: String },
    /// systemd 服务。
    Journal { unit: String, label: String },
    /// Docker 容器。
    Docker { container: String, label: String },
    /// Kubernetes Pod（`kubectl logs -f`）。
    K8s {
        pod: String,
        #[serde(default)]
        namespace: Option<String>,
        #[serde(default)]
        container: Option<String>,
        label: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogStartRequest {
    pub stream_id: String,
    pub session_id: String,
    /// 服务器展示名 / id：只用于**核对这条会话属于哪台**，防止串机器。
    #[serde(default)]
    pub server: String,
    pub source: LogSource,
    /// 先回灌多少行历史。
    #[serde(default = "default_lines")]
    pub lines: u32,
}

fn default_lines() -> u32 {
    200
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEvent {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl LogEvent {
    fn line(text: impl Into<String>) -> Self {
        Self {
            kind: "line".to_string(),
            text: Some(text.into()),
            error: None,
        }
    }

    fn started() -> Self {
        Self {
            kind: "started".to_string(),
            text: None,
            error: None,
        }
    }

    fn closed() -> Self {
        Self {
            kind: "closed".to_string(),
            text: None,
            error: None,
        }
    }
}

/// 正在跑的日志流：停止时按它找远端进程。
struct LogHandle {
    session_id: String,
    /// 远端 tail 的 pid（第一条标记行回传）。
    pid: Mutex<Option<u32>>,
    /// 正在读这条 SSH 执行的异步任务。
    ///
    /// 启动时就存下来：停止时即使 pid 还没回来（tail 刚起、第一条标记还在
    /// 路上），也能 abort 读取任务把 SSH 通道关掉，而不是留一个远端孤儿。
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

fn registry() -> &'static Mutex<HashMap<String, std::sync::Arc<LogHandle>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, std::sync::Arc<LogHandle>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// 组装远端命令。
///
/// `exec` 让 shell 被目标进程顶替：**报出来的 pid 就是真正在读日志的那个进程**，
/// 停止时 `kill` 它即可，不会留下孤儿 `tail -F`。
fn build_command(source: &LogSource, lines: u32) -> Result<String, String> {
    let lines = lines.clamp(1, 5000);
    let tail = match source {
        LogSource::File { path, .. } => {
            if !path.starts_with('/') || path.contains("..") {
                return Err("日志路径必须是绝对路径，且不能包含 ..".to_string());
            }
            format!("tail -n {lines} -F {}", quote(path))
        }
        LogSource::Journal { unit, .. } => {
            if unit.is_empty() || unit.starts_with('-') {
                return Err("systemd 服务名不合法".to_string());
            }
            format!("journalctl -u {} -n {lines} -f --no-pager", quote(unit))
        }
        LogSource::Docker { container, .. } => {
            if container.is_empty() || container.starts_with('-') {
                return Err("容器名不合法".to_string());
            }
            format!("docker logs --tail {lines} -f {}", quote(container))
        }
        LogSource::K8s {
            pod,
            namespace,
            container,
            ..
        } => {
            if pod.is_empty() || pod.starts_with('-') {
                return Err("Pod 名不合法".to_string());
            }
            let mut extra = String::new();
            if let Some(namespace) = namespace.as_deref().filter(|value| !value.is_empty()) {
                if namespace.starts_with('-') {
                    return Err("命名空间不合法".to_string());
                }
                extra.push_str(&format!(" -n {}", quote(namespace)));
            }
            if let Some(container) = container.as_deref().filter(|value| !value.is_empty()) {
                if container.starts_with('-') {
                    return Err("容器名不合法".to_string());
                }
                extra.push_str(&format!(" -c {}", quote(container)));
            }
            format!("kubectl logs --tail {lines} -f{extra} {}", quote(pod))
        }
    };
    Ok(format!("echo __BLS_LOG_PID__$$; exec {tail} 2>&1"))
}

/// 开始一条日志流。立即返回，后续内容通过 Channel 推送。
#[tauri::command]
pub async fn extreme_log_start(
    state: State<'_, AppState>,
    request: LogStartRequest,
    on_event: Channel<LogEvent>,
) -> OpsResult<()> {
    if !state.ssh.is_connected(&request.session_id).await {
        return Err(OpsError::from_stage("io", "SSH 会话已断开，无法打开日志"));
    }
    let command = build_command(&request.source, request.lines)
        .map_err(|error| OpsError::from_stage("io", error))?;

    let handle = std::sync::Arc::new(LogHandle {
        session_id: request.session_id.clone(),
        pid: Mutex::new(None),
        task: Mutex::new(None),
    });
    registry()
        .lock()
        .await
        .insert(request.stream_id.clone(), handle.clone());

    let ssh = state.ssh.clone();
    let session_id = request.session_id.clone();
    let stream_id = request.stream_id.clone();
    let (sink, mut chunks) = tokio::sync::mpsc::unbounded_channel::<ExecChunk>();

    // 转发：分块 → 补 UTF-8 → Channel。日志是给人看的，不需要再截断。
    let forward_handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        let mut decoder = Utf8StreamDecoder::new();
        let mut first = true;
        while let Some(chunk) = chunks.recv().await {
            let bytes = match chunk {
                ExecChunk::Stdout(bytes) | ExecChunk::Stderr(bytes) => bytes,
            };
            let text = decoder.feed(&bytes);
            if text.is_empty() {
                continue;
            }
            if first {
                first = false;
                // 第一条是 pid 标记：记下来，供停止时 kill。
                let mut rest = String::new();
                for (index, line) in text.split_inclusive('\n').enumerate() {
                    if index == 0 {
                        if let Some(pid) = line
                            .trim()
                            .strip_prefix("__BLS_LOG_PID__")
                            .and_then(|value| value.parse::<u32>().ok())
                        {
                            *forward_handle.pid.lock().await = Some(pid);
                            let _ = on_event.send(LogEvent::started());
                            continue;
                        }
                    }
                    rest.push_str(line);
                }
                if !rest.is_empty() {
                    let _ = on_event.send(LogEvent::line(rest));
                }
                continue;
            }
            let _ = on_event.send(LogEvent::line(text));
        }
        // 流结束（被停止 / 远端断开）：告诉界面，并清掉注册表。
        let _ = on_event.send(LogEvent::closed());
        registry().lock().await.remove(&stream_id);
    });

    // 远端命令可能跑很久（一直跟着日志），这里只给它一个很宽的上限。
    let task_slot = handle.clone();
    let task = tauri::async_runtime::spawn(async move {
        if let Err(error) = ssh
            .exec_stream(&session_id, &command, Duration::from_secs(12 * 3600), sink)
            .await
        {
            // 会话断开等：通过同一条流把原因交给前端不太现实（sink 已移走），
            // 前端会从 `closed` 与连接状态看出来。
            let _ = error;
        }
    });
    *task_slot.task.lock().await = Some(task);

    Ok(())
}

/// 停止：杀掉远端进程，**释放服务器上的 tail**。
#[tauri::command]
pub async fn extreme_log_stop(state: State<'_, AppState>, stream_id: String) -> OpsResult<()> {
    // 先取句柄、**不要立刻摘掉**：pid 可能还在路上，摘早了这次停止就白停。
    let handle = registry().lock().await.get(&stream_id).cloned();
    let Some(handle) = handle else { return Ok(()) };

    // 等 pid（最多 2 秒）：tail 刚启动时第一条标记可能还没回来。
    let mut pid = *handle.pid.lock().await;
    for _ in 0..40 {
        if pid.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        pid = *handle.pid.lock().await;
    }
    if let Some(pid) = pid {
        let _ = state
            .ssh
            .exec(
                &handle.session_id,
                &format!("kill -TERM {pid} 2>/dev/null || true"),
                Duration::from_secs(8),
            )
            .await;
    }

    // 无论 pid 有没有拿到，都取消读取任务：SSH 通道关闭，远端进程收到 HUP，
    // 不会留下"界面显示已停止、远端还在跑"的孤儿。
    if let Some(task) = handle.task.lock().await.take() {
        task.abort();
    }
    registry().lock().await.remove(&stream_id);
    Ok(())
}
