//! 文件变更审阅的端到端用例（跑真实的 `run_loop`）。
//!
//! 只测纯函数看不出"确认 → 版本核对 → 写入 → 回读"的先后顺序，所以这里用一份
//! 内存假服务器：`read_snapshot` 读它、`exec` 真的把 base64 内容写回去。

use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use tokio::sync::mpsc::UnboundedSender;

use super::super::changes::{ChangeRegistry, DiffKind, FileSnapshot};
use super::super::runner::{run_loop, AgentInput, AgentIo, AgentTurn, IoFuture};
use super::super::state::{AgentHandle, AgentSnapshot};
use super::super::AgentEvent;
use crate::deployment::ai::model::AiCancel;
use crate::deployment::ai::{AiProviderError, ToolReply};
use crate::ssh::{ExecChunk, ExecOutput};

const PATH: &str = "/etc/nginx/conf.d/ops.conf";
const BEFORE: &str = "server {\n    listen 80;\n}\n";
const AFTER: &str = "server {\n    listen 8080;\n    server_name ops.local;\n}\n";
/// 另一个会话在用户确认前改出来的内容。
const RIVAL: &str = "# 别人刚改过\nserver {\n    listen 81;\n}\n";

fn write_call(content: &str) -> String {
    format!(
        "<tool name=\"write_file\">{}</tool>",
        json!({ "path": PATH, "content": content })
    )
}

const READ_CALL: &str = "<tool name=\"run_shell\">{\"command\":\"uname -a\"}</tool>";

/// `shell_quote` 的反向：测试里的路径不含特殊字符，去掉一层单引号即可。
fn unquote(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2 && value.starts_with('\'') && value.ends_with('\'') {
        value[1..value.len() - 1].replace("'\\''", "'")
    } else {
        value.to_string()
    }
}

fn line_value(command: &str, prefix: &str) -> Option<String> {
    command
        .lines()
        .find_map(|line| line.strip_prefix(prefix).map(unquote))
}

fn hash_of(text: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

struct ChangeIo {
    registry: ChangeRegistry,
    /// 服务器上的文件（路径 → 内容）。
    files: Arc<Mutex<HashMap<String, String>>>,
    /// 回读直接失败的路径（模拟无权限 / 非普通文件）。
    unreadable: Mutex<Vec<String>>,
    /// 写入命令返回失败（模拟权限不足）。
    fail_write: Mutex<bool>,
    /// 写入**之后**的回读失败（模拟文件被别的进程锁住 / 权限被收回）。
    fail_readback: Mutex<bool>,
    replies: Mutex<VecDeque<String>>,
    executed: Mutex<Vec<String>>,
    events: Arc<Mutex<Vec<super::super::AgentEvent>>>,
}

impl ChangeIo {
    fn new(before: Option<&str>, replies: &[&str]) -> Self {
        let mut files = HashMap::new();
        if let Some(content) = before {
            files.insert(PATH.to_string(), content.to_string());
        }
        Self {
            registry: ChangeRegistry::default(),
            files: Arc::new(Mutex::new(files)),
            unreadable: Mutex::new(Vec::new()),
            fail_write: Mutex::new(false),
            fail_readback: Mutex::new(false),
            replies: Mutex::new(replies.iter().map(|item| item.to_string()).collect()),
            executed: Mutex::new(Vec::new()),
            events: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn executed(&self) -> Vec<String> {
        self.executed.lock().map(|list| list.clone()).unwrap_or_default()
    }

    /// 真正发出去的 `write_file` 命令条数（回读不走 `exec`）。
    fn writes(&self) -> usize {
        self.executed()
            .iter()
            .filter(|command| command.contains("__bls_target="))
            .count()
    }

    fn change_events(&self) -> usize {
        self.events
            .lock()
            .map(|list| list.iter().filter(|event| event.kind == "file_change").count())
            .unwrap_or(0)
    }
}

impl AgentIo for ChangeIo {
    fn emit(&self, event: AgentEvent) {
        if let Ok(mut list) = self.events.lock() {
            list.push(event);
        }
    }

    fn sink(&self) -> Arc<dyn Fn(AgentEvent) + Send + Sync> {
        let events = self.events.clone();
        Arc::new(move |event| {
            if let Ok(mut list) = events.lock() {
                list.push(event);
            }
        })
    }

    fn connected<'a>(&'a self, _session_id: &'a str) -> IoFuture<'a, bool> {
        Box::pin(async move { true })
    }

    fn verify_server(&self, _session_id: &str, _server: &str) -> Result<(), String> {
        Ok(())
    }

    fn exec<'a>(
        &'a self,
        _session_id: &'a str,
        command: &'a str,
        _timeout: Duration,
        _sink: UnboundedSender<ExecChunk>,
    ) -> IoFuture<'a, Result<ExecOutput, String>> {
        Box::pin(async move {
            if let Ok(mut list) = self.executed.lock() {
                list.push(command.to_string());
            }
            if command.contains("__bls_target=") {
                if *self.fail_write.lock().unwrap() {
                    return Ok(ExecOutput {
                        stdout: String::new(),
                        stderr: "permission denied".to_string(),
                        exit_code: Some(1),
                        truncated: false,
                    });
                }
                // 按命令里真正的 base64 内容落盘：预览与实际写入必须同源。
                let target = line_value(command, "__bls_target=").unwrap_or_default();
                let encoded = command
                    .split("printf %s '")
                    .nth(1)
                    .and_then(|rest| rest.split("' | base64 -d").next())
                    .unwrap_or("");
                use base64::Engine as _;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded.as_bytes())
                    .unwrap_or_default();
                let content = String::from_utf8_lossy(&bytes).to_string();
                let existed = {
                    let mut files = self.files.lock().unwrap();
                    let existed = files.contains_key(&target);
                    files.insert(target.clone(), content);
                    existed
                };
                let stdout = if existed {
                    format!("\n__BLS_BACKUP__{target}.bls-bak.1\n__BLS_WROTE__{target}\n")
                } else {
                    format!("\n__BLS_WROTE__{target}\n")
                };
                // 回读失败只能在写入之后发生：从这里把路径标成不可读。
                if *self.fail_readback.lock().unwrap() {
                    self.unreadable.lock().unwrap().push(target.clone());
                }
                return Ok(ExecOutput {
                    stdout,
                    stderr: String::new(),
                    exit_code: Some(0),
                    truncated: false,
                });
            }
            Ok(ExecOutput {
                stdout: format!("ok: {command}\n"),
                stderr: String::new(),
                exit_code: Some(0),
                truncated: false,
            })
        })
    }

    fn chat<'a>(
        &'a self,
        _messages: Vec<serde_json::Value>,
        _tools: serde_json::Value,
        _cancel: &'a AiCancel,
        on_delta: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> IoFuture<'a, Result<ToolReply, AiProviderError>> {
        Box::pin(async move {
            let reply = self
                .replies
                .lock()
                .ok()
                .and_then(|mut queue| queue.pop_front());
            match reply {
                Some(content) => {
                    on_delta(&content);
                    Ok(ToolReply {
                        message: json!({ "role": "assistant", "content": content }),
                        content,
                        tool_calls: Vec::new(),
                    })
                }
                None => Err(AiProviderError::Http {
                    status: 500,
                    detail: "假模型没有更多回复".to_string(),
                }),
            }
        })
    }

    fn changes(&self) -> ChangeRegistry {
        self.registry.clone()
    }

    fn read_snapshot<'a>(
        &'a self,
        _session_id: &'a str,
        path: &'a str,
    ) -> IoFuture<'a, Result<Option<FileSnapshot>, String>> {
        Box::pin(async move {
            if self
                .unreadable
                .lock()
                .map(|list| list.iter().any(|item| item == path))
                .unwrap_or(false)
            {
                return Err("permission denied".to_string());
            }
            let content = self.files.lock().unwrap().get(path).cloned();
            Ok(Some(match content {
                None => FileSnapshot::absent(path),
                Some(text) => FileSnapshot {
                    exists: true,
                    path: path.to_string(),
                    sha: hash_of(&text),
                    size: text.len() as u64,
                    binary: false,
                    too_large: false,
                    is_dir: false,
                    redacted: false,
                    content: text,
                    note: None,
                },
            }))
        })
    }
}

fn input() -> AgentInput {
    AgentInput {
        task_id: "task-change".to_string(),
        session_id: "ssh-1".to_string(),
        server: "prod".to_string(),
        server_id: Some("server-1".to_string()),
        workspace_id: Some("workspace-1".to_string()),
        cwd: "/root".to_string(),
        messages: vec![AgentTurn {
            role: "user".to_string(),
            content: "改一下 nginx 配置".to_string(),
        }],
        provider_id: None,
        locale: None,
        reasoning_effort: None,
        context_budget: None,
        capability: None,
        carry_usage: None,
        allow_sudo: false,
        auto_approve_writes: false,
        max_rounds: None,
        carry_steps: Vec::new(),
    }
}

fn snapshot() -> AgentSnapshot {
    AgentSnapshot::new("task-change", "prod", "ssh-1", "/root", "test-model")
}

fn decide_later(handle: Arc<AgentHandle>, call_id: &'static str, allow: bool) {
    tokio::spawn(async move {
        for _ in 0..400 {
            tokio::time::sleep(Duration::from_millis(5)).await;
            if handle.resolve_approval(call_id, allow) {
                return;
            }
        }
    });
}

/// 等循环挂起后**先改服务器上的文件**，再点允许（模拟另一个会话抢先改了）。
fn mutate_then_allow(
    handle: Arc<AgentHandle>,
    files: Arc<Mutex<HashMap<String, String>>>,
    call_id: &'static str,
) {
    tokio::spawn(async move {
        for _ in 0..400 {
            tokio::time::sleep(Duration::from_millis(5)).await;
            if handle.pending_approval().as_deref() == Some(call_id) {
                files
                    .lock()
                    .unwrap()
                    .insert(PATH.to_string(), RIVAL.to_string());
                handle.resolve_approval(call_id, true);
                return;
            }
        }
    });
}

#[tokio::test]
async fn preview_and_actual_diff_come_from_the_server() {
    let io = ChangeIo::new(
        Some(BEFORE),
        &[&write_call(AFTER), "已写入。", READ_CALL, "完成。"],
    );
    let handle = Arc::new(AgentHandle::new(snapshot(), AiCancel::new()));
    decide_later(handle.clone(), "call-0-0", true);

    let result = run_loop(&handle, &input(), &io, None).await;
    assert!(result.is_ok(), "{result:?}");

    let list = io.registry.list(Some("workspace-1"), Some("task-change"));
    assert_eq!(list.len(), 1, "一次 write_file 对应一条变更记录");
    let summary = &list[0];
    assert_eq!(summary.status, "written");
    assert_eq!(summary.stage, "actual");
    assert_eq!(summary.additions, 2);
    assert_eq!(summary.deletions, 1);
    assert!(summary.can_open, "写入后目标文件确认存在");
    assert!(summary.backup_verified, "写入前确实落了备份");

    let detail = io.registry.detail(&summary.id).unwrap();
    // 正文与计数一致：把 hunk 里的增删行数出来比对。
    let adds = detail
        .diff
        .hunks
        .iter()
        .flat_map(|hunk| hunk.lines.iter())
        .filter(|line| line.kind == DiffKind::Add)
        .count() as i64;
    let dels = detail
        .diff
        .hunks
        .iter()
        .flat_map(|hunk| hunk.lines.iter())
        .filter(|line| line.kind == DiffKind::Del)
        .count() as i64;
    assert_eq!(adds, detail.summary.additions);
    assert_eq!(dels, detail.summary.deletions);
    assert!(detail
        .diff
        .hunks
        .iter()
        .any(|hunk| hunk.lines.iter().any(|line| line.text.contains("listen 8080"))));

    // 步骤上带着变更标识：执行结果能定位到这条记录。
    assert_eq!(
        handle.snapshot().steps[0].change_id.as_deref(),
        Some(summary.id.as_str())
    );
    assert!(io.change_events() >= 2, "预览与回读各一次摘要事件");
}

#[tokio::test]
async fn an_external_change_before_approval_forces_a_new_preview() {
    let io = ChangeIo::new(
        Some(BEFORE),
        &[&write_call(AFTER), "已写入。", READ_CALL, "完成。"],
    );
    let files = io.files.clone();
    let handle = Arc::new(AgentHandle::new(snapshot(), AiCancel::new()));
    mutate_then_allow(handle.clone(), files, "call-0-0");
    // 旧确认被拦下之后，会按当前内容生成新预览并重新等确认。
    decide_later(handle.clone(), "call-0-0-r1", true);

    let result = run_loop(&handle, &input(), &io, None).await;
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(io.writes(), 1, "旧预览没有执行，新预览批准后才写一次");

    let list = io.registry.list(Some("workspace-1"), None);
    assert_eq!(list.len(), 2, "作废的旧预览 + 新预览各一条");
    let stale = list
        .iter()
        .find(|item| item.status == "stale")
        .expect("旧预览要标成已作废");
    let written = list
        .iter()
        .find(|item| item.status == "written")
        .expect("新预览执行完成");
    assert_eq!(written.call_id, "call-0-0-r1", "新版本用新的 callId 等确认");
    assert_ne!(stale.id, written.id);
    assert!(
        stale.note.as_deref().unwrap_or("").contains("外部修改"),
        "{:?}",
        stale.note
    );

    // 新预览的 before 是**别人改过之后**的内容：Diff 里会删掉那行注释。
    let detail = io.registry.detail(&written.id).unwrap();
    assert!(detail.summary.deletions >= 2, "{:?}", detail.summary);
    assert!(
        detail
            .diff
            .hunks
            .iter()
            .flat_map(|hunk| hunk.lines.iter())
            .any(|line| line.kind == DiffKind::Del && line.text.contains("别人刚改过")),
        "实际 Diff 必须基于最新的原文"
    );
}

#[tokio::test]
async fn a_rejected_preview_keeps_the_file_untouched() {
    let io = ChangeIo::new(Some(BEFORE), &[&write_call(AFTER), "好的，不改。"]);
    let handle = Arc::new(AgentHandle::new(snapshot(), AiCancel::new()));
    decide_later(handle.clone(), "call-0-0", false);

    let result = run_loop(&handle, &input(), &io, None).await;
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(io.writes(), 0, "拒绝后绝不写服务器");

    let list = io.registry.list(None, None);
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].status, "rejected");
    assert_eq!(list[0].stage, "proposed", "拒绝也要能看到当时准备改什么");
    assert_eq!(
        io.files
            .lock()
            .unwrap()
            .get(PATH)
            .cloned()
            .unwrap_or_default(),
        BEFORE
    );
}

#[tokio::test]
async fn a_failed_write_is_reported_without_a_fake_after() {
    let io = ChangeIo::new(
        Some(BEFORE),
        &[&write_call(AFTER), "写入失败。", READ_CALL, "完成。"],
    );
    *io.fail_write.lock().unwrap() = true;
    let handle = Arc::new(AgentHandle::new(snapshot(), AiCancel::new()));
    decide_later(handle.clone(), "call-0-0", true);

    let _ = run_loop(&handle, &input(), &io, None).await;
    let list = io.registry.list(None, None);
    assert_eq!(list[0].status, "write_failed");
    assert_eq!(list[0].stage, "proposed", "没有实际回读就不冒充实际变更");
    assert!(list[0].note.as_deref().unwrap_or("").contains("写入失败"));
    assert_eq!(
        io.files
            .lock()
            .unwrap()
            .get(PATH)
            .cloned()
            .unwrap_or_default(),
        BEFORE
    );
}

#[tokio::test]
async fn a_readback_failure_is_reported_without_pretending_it_succeeded() {
    let io = ChangeIo::new(
        Some(BEFORE),
        &[&write_call(AFTER), "已写入。", READ_CALL, "完成。"],
    );
    *io.fail_readback.lock().unwrap() = true;
    let handle = Arc::new(AgentHandle::new(snapshot(), AiCancel::new()));
    decide_later(handle.clone(), "call-0-0", true);

    let _ = run_loop(&handle, &input(), &io, None).await;
    let list = io.registry.list(None, None);
    let record = list.first().expect("写入之后要留一条记录");
    assert_eq!(record.status, "readback_failed");
    assert_eq!(record.stage, "none", "回读失败不能显示成实际变更");
    assert!(!record.diff_ready);
    assert!(
        record.note.as_deref().unwrap_or("").contains("回读失败"),
        "{:?}",
        record.note
    );
}

#[tokio::test]
async fn an_unreadable_file_is_not_rendered_as_a_fake_diff() {
    let io = ChangeIo::new(
        Some(BEFORE),
        &[&write_call(AFTER), "先不改。", READ_CALL, "完成。"],
    );
    io.unreadable.lock().unwrap().push(PATH.to_string());
    let handle = Arc::new(AgentHandle::new(snapshot(), AiCancel::new()));
    decide_later(handle.clone(), "call-0-0", true);

    let _ = run_loop(&handle, &input(), &io, None).await;
    let list = io.registry.list(None, None);
    let record = list.first().expect("读不到原文也要留一条说明");
    assert_eq!(record.status, "unavailable");
    assert_eq!(record.stage, "none");
    assert!(!record.diff_ready);
    let detail = io.registry.detail(&record.id).unwrap();
    assert!(detail.diff.hunks.is_empty(), "不能凭空生成全新增");
    assert!(detail.limits.iter().any(|item| item.contains("未能读取")));
}

#[tokio::test]
async fn a_shell_write_is_marked_as_uncollected() {
    let io = ChangeIo::new(
        Some(BEFORE),
        &[
            "<tool name=\"run_shell\">{\"command\":\"systemctl restart nginx\"}</tool>",
            "已重启。",
            READ_CALL,
            "完成。",
        ],
    );
    let handle = Arc::new(AgentHandle::new(snapshot(), AiCancel::new()));
    decide_later(handle.clone(), "call-0-0", true);

    let _ = run_loop(&handle, &input(), &io, None).await;
    let list = io.registry.list(None, None);
    let shell = list
        .iter()
        .find(|item| item.status == "uncollected")
        .expect("普通 shell 写操作要如实标注未采集");
    assert!(shell.uncollected);
    assert!(shell.note.as_deref().unwrap_or("").contains("未采集"));
    assert!(!shell.diff_ready);
}
