//! 右栏「手动终端」：在**已有 SSH 连接**上再开一个 PTY shell 通道。
//!
//! 和 `ssh_exec` 的区别：
//! - `ssh_exec` 每条命令开一个 exec 通道、命令结束就关，`cd` 不延续；
//! - 这里开的是一个持久 shell：`cd`、提示符、交互式命令都和真实终端一致。
//!
//! 通道按 `shell_id`（前端生成）管理，与主线交互终端互不干扰；关闭时只
//! 释放这一条通道，不动 SSH 连接本身。

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, OnceLock};

use anyhow::{anyhow, Result};
use russh::{client, ChannelMsg, ChannelWriteHalf};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use super::decoder::{OutputDecoder, SessionEncoding};
use super::session::SshSession;

pub(crate) const OUTPUT_EVENT_PREFIX: &str = "ssh-shell-output-";
pub(crate) const CLOSED_EVENT_PREFIX: &str = "ssh-shell-closed-";

struct ShellHandle {
    write: Mutex<Option<ChannelWriteHalf<client::Msg>>>,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

static SHELLS: OnceLock<Mutex<HashMap<String, Arc<ShellHandle>>>> = OnceLock::new();

/// 每条通道最近的输出行（给 AI 读"用户刚跑了什么、返回了什么"）。
static BUFFERS: OnceLock<Mutex<HashMap<String, VecDeque<String>>>> = OnceLock::new();

/// 每条通道保留的最大行数。
const TAIL_LINES: usize = 2000;

fn registry() -> &'static Mutex<HashMap<String, Arc<ShellHandle>>> {
    SHELLS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn buffers() -> &'static Mutex<HashMap<String, VecDeque<String>>> {
    BUFFERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn append_buffer(shell_id: &str, text: &str) {
    let Ok(mut guard) = buffers().try_lock() else {
        return;
    };
    let buffer = guard.entry(shell_id.to_string()).or_default();
    for line in text.split_inclusive('\n') {
        buffer.push_back(line.trim_end_matches(['\r', '\n']).to_string());
    }
    while buffer.len() > TAIL_LINES {
        buffer.pop_front();
    }
}

/// 最近若干行（含提示符与命令回显），供 AI 读取。
pub(crate) async fn tail(shell_id: &str, lines: usize) -> String {
    let lines = lines.clamp(1, TAIL_LINES);
    let guard = buffers().lock().await;
    let Some(buffer) = guard.get(shell_id) else {
        return String::new();
    };
    let start = buffer.len().saturating_sub(lines);
    buffer
        .iter()
        .skip(start)
        .cloned()
        .collect::<Vec<_>>()
        .join("\n")
}

/// 在已连接的会话上开一个 PTY shell。
pub(crate) async fn open(
    app: &AppHandle,
    session: &SshSession,
    shell_id: &str,
    cols: u32,
    rows: u32,
) -> Result<()> {
    let mut channel = session
        .handle
        .channel_open_session()
        .await
        .map_err(|error| anyhow!("SSH 通道创建失败：{error}"))?;
    channel
        .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
        .await
        .map_err(|error| anyhow!("远端拒绝分配 PTY：{error}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|error| anyhow!("远端拒绝打开 shell：{error}"))?;

    let (mut read, write) = channel.split();
    let handle = Arc::new(ShellHandle {
        write: Mutex::new(Some(write)),
        task: Mutex::new(None),
    });

    // 同一个 shell_id 重复打开：先收掉旧通道，避免两条 shell 抢同一个面板。
    close(shell_id).await;
    registry()
        .lock()
        .await
        .insert(shell_id.to_string(), handle.clone());

    let app = app.clone();
    let key = shell_id.to_string();
    let task_slot = handle.clone();
    let task = tauri::async_runtime::spawn(async move {
        // 与主终端同一套解码：SSH 的块边界不等于字符边界，中文不能按块切。
        let mut decoder = OutputDecoder::new(SessionEncoding::Auto);
        while let Some(message) = read.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    let text = decoder.feed(&data);
                    if !text.is_empty() {
                        append_buffer(&key, &text);
                        let _ = app.emit(&format!("{OUTPUT_EVENT_PREFIX}{key}"), text);
                    }
                }
                ChannelMsg::Eof | ChannelMsg::Close { .. } => break,
                _ => continue,
            }
        }
        let tail = decoder.flush();
        if !tail.is_empty() {
            let _ = app.emit(&format!("{OUTPUT_EVENT_PREFIX}{key}"), tail);
        }
        let _ = app.emit(&format!("{CLOSED_EVENT_PREFIX}{key}"), "closed");
        // 自己退出：只清 writer 与注册表，不要 abort 自己。
        *task_slot.write.lock().await = None;
        registry().lock().await.remove(&key);
    });
    *handle.task.lock().await = Some(task);
    Ok(())
}

pub(crate) async fn input(shell_id: &str, data: &[u8]) -> Result<()> {
    let handle = registry()
        .lock()
        .await
        .get(shell_id)
        .cloned()
        .ok_or_else(|| anyhow!("终端通道已关闭"))?;
    let mut guard = handle.write.lock().await;
    let write = guard.as_mut().ok_or_else(|| anyhow!("终端通道已关闭"))?;
    write.data_bytes(data.to_vec()).await?;
    Ok(())
}

pub(crate) async fn resize(shell_id: &str, cols: u32, rows: u32) -> Result<()> {
    let handle = registry()
        .lock()
        .await
        .get(shell_id)
        .cloned()
        .ok_or_else(|| anyhow!("终端通道已关闭"))?;
    let mut guard = handle.write.lock().await;
    let write = guard.as_mut().ok_or_else(|| anyhow!("终端通道已关闭"))?;
    write.window_change(cols, rows, 0, 0).await?;
    Ok(())
}

/// 关闭通道（不动 SSH 连接）。
pub(crate) async fn close(shell_id: &str) {
    let handle = registry().lock().await.remove(shell_id);
    if let Some(handle) = handle {
        if let Some(task) = handle.task.lock().await.take() {
            task.abort();
        }
        *handle.write.lock().await = None;
    }
}
