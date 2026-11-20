//! 运行中的 Agent 任务注册表。
//!
//! 它解决两件事：
//! 1. **跨 WebView 生命周期**：循环跑在 Rust 侧，前端收起 / 重进 / 刷新都不会
//!    中断；重进时用 [`AgentRegistry::snapshot`] 把卡片恢复到当前进度。
//! 2. **审批握手**：写 / 危险操作挂起在这里等 `agent_approve`，命令本身还没
//!    发出去 —— 用户不点，服务器就不会变。

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use super::protocol::{AgentOutcome, AgentStep, PendingApproval, MAX_TOTAL_SECONDS};
use super::runner::PruneReport;
use crate::deployment::ai::model::AiCancel;

/// 已结束的任务快照保留这么久，供前端重进时恢复（之后连同内存一起释放）。
const RETAIN: Duration = Duration::from_secs(10 * 60);

/// 非终态快照超过这么久没有任何进展 → 判定"执行循环已经不在"。
///
/// 比任务总上限（[`MAX_TOTAL_SECONDS`]，30 分钟）再多两分钟：正常循环最迟在
/// 总上限处结束并写终态，之后还停在 `running / waiting` 只能是异常退出
/// （panic、future 被丢弃、WebView 重载打断收尾）留下的僵尸句柄。
const STALE_AFTER_MS: i64 = (MAX_TOTAL_SECONDS as i64 + 120) * 1000;

/// 本任务累计用量：**每次模型请求相加**（同一段历史会在多次请求里重复计入）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    /// 已经发生的模型请求次数。
    pub requests: usize,
    /// 每次请求实际带入的输入 token 之和。
    pub input_tokens: usize,
    /// 每次请求返回的正文 + 工具参数 token 之和。
    pub output_tokens: usize,
}

/// 最近一次请求的构成（按角色归类）。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBreakdown {
    /// 系统提示（协议 / 强度 / 范围 / 环境）。
    pub system: usize,
    /// 用户与助手的对话历史。
    pub history: usize,
    /// 工具调用与结果。
    pub tools: usize,
}

/// 最近一轮的上下文用量（裁剪后**真正发给模型**的估算 token）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    /// 本次请求的输入预算（tokens）。
    pub budget: usize,
    /// 裁剪后实际占用（保守估算，见 `estimate_text_tokens`）。
    pub used: usize,
    /// 这一轮用了哪几级降级、各处理了多少。
    pub report: PruneReport,
    /// 本任务累计（跨多次请求相加）。
    pub cumulative: TokenUsage,
    /// 最近一次请求的构成。
    pub breakdown: ContextBreakdown,
    /// 用户目标：最后一条真人用户消息的首行（截断）。
    pub goal: String,
    /// 本任务累计执行的工具调用数。
    pub tool_calls: usize,
}

/// 前端重进 / 轮询时看到的状态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSnapshot {
    pub task_id: String,
    /// `running` / `waiting` / `success` / `failed` / `cancelled`。
    pub status: String,
    pub model: String,
    /// 终态时的模型正文（成功时有值）。
    pub content: String,
    pub error: Option<String>,
    /// 任务当前目录（每条命令执行后回读）。
    pub cwd: String,
    pub server: String,
    pub session_id: String,
    pub steps: Vec<AgentStep>,
    /// 正在等确认的那条操作（没有就是 `None`）。
    pub pending_approval: Option<PendingApproval>,
    /// 最近一轮的上下文用量；还没请求过模型时为 `None`。
    pub context: Option<ContextUsage>,
    /// 验证结论：`verified` / `partial` / `needs_info`；没执行过步骤时为 `None`。
    pub outcome: Option<AgentOutcome>,
    pub updated_at: i64,
}

impl AgentSnapshot {
    pub fn new(task_id: &str, server: &str, session_id: &str, cwd: &str, model: &str) -> Self {
        Self {
            task_id: task_id.to_string(),
            status: "running".to_string(),
            model: model.to_string(),
            content: String::new(),
            error: None,
            cwd: cwd.to_string(),
            server: server.to_string(),
            session_id: session_id.to_string(),
            steps: Vec::new(),
            pending_approval: None,
            context: None,
            outcome: None,
            updated_at: crate::db::AppDb::now(),
        }
    }

    pub fn terminal(&self) -> bool {
        matches!(self.status.as_str(), "success" | "failed" | "cancelled")
    }
}

/// 单个任务的运行句柄。
pub struct AgentHandle {
    snapshot: Mutex<AgentSnapshot>,
    cancel: AiCancel,
    /// callId → 等待审批的回复通道。
    approvals: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    /**
     * 运行中用户补充的指令（「更新当前任务」）。
     *
     * 循环在 Rust 侧，前端不能直接改 `conversation`；这里只排队，由 `run_loop`
     * 在**下一步开始前**取走并作为一条 user 消息交给模型。取走即清空，
     * 同一条指令不会重复生效。
     */
    steers: Mutex<Vec<String>>,
    /**
     * 因补充指令而**撤回**的待确认调用（callId）。
     *
     * 撤回与「用户拒绝」在循环里必须区分：拒绝要记进 decided_ops（换写法也不再问），
     * 撤回只是按新要求重新评估，不能把这一操作永久判死。
     */
    withdrawn: Mutex<HashSet<String>>,
    finished_at: Mutex<Option<Instant>>,
}

impl AgentHandle {
    pub(crate) fn new(snapshot: AgentSnapshot, cancel: AiCancel) -> Self {
        Self {
            snapshot: Mutex::new(snapshot),
            cancel,
            approvals: Mutex::new(HashMap::new()),
            steers: Mutex::new(Vec::new()),
            withdrawn: Mutex::new(HashSet::new()),
            finished_at: Mutex::new(None),
        }
    }

    pub fn snapshot(&self) -> AgentSnapshot {
        self.snapshot
            .lock()
            .map(|snapshot| snapshot.clone())
            .unwrap_or_else(|poison| poison.into_inner().clone())
    }

    pub fn update<F: FnOnce(&mut AgentSnapshot)>(&self, change: F) {
        if let Ok(mut snapshot) = self.snapshot.lock() {
            change(&mut snapshot);
            snapshot.updated_at = crate::db::AppDb::now();
        }
    }

    /// 追加一步（新步骤开始时调用）。
    pub fn push_step(&self, step: AgentStep) {
        self.update(|snapshot| snapshot.steps.push(step));
    }

    /// 就地更新某一步。
    pub fn patch_step<F: FnOnce(&mut AgentStep)>(&self, index: u32, change: F) {
        self.update(|snapshot| {
            if let Some(step) = snapshot.steps.iter_mut().find(|step| step.index == index) {
                change(step);
            }
        });
    }

    pub fn step(&self, index: u32) -> Option<AgentStep> {
        self.snapshot()
            .steps
            .iter()
            .find(|step| step.index == index)
            .cloned()
    }

    pub fn set_cwd(&self, cwd: &str) {
        self.update(|snapshot| snapshot.cwd = cwd.to_string());
    }

    pub fn cancel(&self) -> &AiCancel {
        &self.cancel
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.is_cancelled()
    }

    /// 登记一次审批等待；返回的接收端被 drop 时按"拒绝"处理。
    pub fn wait_approval(&self, call_id: &str) -> oneshot::Receiver<bool> {
        let (sender, receiver) = oneshot::channel();
        if let Ok(mut approvals) = self.approvals.lock() {
            approvals.insert(call_id.to_string(), sender);
        }
        receiver
    }

    pub fn resolve_approval(&self, call_id: &str, allow: bool) -> bool {
        let sender = self
            .approvals
            .lock()
            .ok()
            .and_then(|mut approvals| approvals.remove(call_id));
        match sender {
            Some(sender) => sender.send(allow).is_ok(),
            None => false,
        }
    }

    pub fn forget_approval(&self, call_id: &str) {
        if let Ok(mut approvals) = self.approvals.lock() {
            approvals.remove(call_id);
        }
    }

    /**
     * 运行中收到一条补充指令。
     *
     * 如果这一步正在等确认，**先撤回**：用户刚说"只查容器里的"，再执行原来那条
     * 写操作就是违背新要求。撤回后模型会带着这条指令重新评估（见 `take_withdrawn`）。
     */
    pub fn push_steer(&self, text: &str) {
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        if let Ok(mut queue) = self.steers.lock() {
            queue.push(text.to_string());
        }
        self.withdraw_pending_approval();
    }

    /**
     * 撤回当前待确认操作（如果有）。
     *
     * 循环"登记等待"与"推送指令"之间有极小的窗口：登记前推来的指令看不到
     * pending，就会一直等到超时。所以循环在真正 `wait_approval` 之前也会调
     * 一次这里，两边都安全。
     */
    pub fn withdraw_pending_approval(&self) -> bool {
        let Some(call_id) = self.pending_approval() else {
            return false;
        };
        if let Ok(mut withdrawn) = self.withdrawn.lock() {
            withdrawn.insert(call_id.clone());
        }
        self.resolve_approval(&call_id, false)
    }

    /// 取走全部待生效指令（取走即清空）。
    pub fn take_steers(&self) -> Vec<String> {
        self.steers
            .lock()
            .map(|mut queue| std::mem::take(&mut *queue))
            .unwrap_or_default()
    }

    /// 是否有待生效指令（执行器在每条命令前用它决定"还要不要继续按旧计划跑"）。
    pub fn has_steers(&self) -> bool {
        self.steers
            .lock()
            .map(|queue| !queue.is_empty())
            .unwrap_or(false)
    }

    /// 这个调用是不是被补充指令撤回的（与用户主动拒绝区分）。
    pub fn take_withdrawn(&self, call_id: &str) -> bool {
        self.withdrawn
            .lock()
            .map(|mut set| set.remove(call_id))
            .unwrap_or(false)
    }

    /// 有等待中的审批时返回它的 callId（快照里 `waiting` 状态用得上）。
    pub fn pending_approval(&self) -> Option<String> {
        self.approvals
            .lock()
            .ok()
            .and_then(|approvals| approvals.keys().next().cloned())
    }

    pub fn mark_finished(&self) {
        if let Ok(mut slot) = self.finished_at.lock() {
            *slot = Some(Instant::now());
        }
    }

    /**
     * 非终态但已经超过总时长上限没有任何进展：收敛成 `failed`。
     *
     * 这种句柄**不可能**再推进（循环已经不在），但前端重进时看到 `running`
     * 会显示一个停不掉的「执行中」。这里按"失联"收尾，让界面能正常结束。
     * 返回是否真的收敛过。
     */
    pub fn reap_if_stale(&self) -> bool {
        let now = crate::db::AppDb::now();
        let mut reaped = false;
        if let Ok(mut snapshot) = self.snapshot.lock() {
            if !snapshot.terminal() && now.saturating_sub(snapshot.updated_at) > STALE_AFTER_MS {
                snapshot.status = "failed".to_string();
                snapshot.error = Some(
                    "任务失联：超过任务总时长上限没有进展，已停止跟踪。\
                     服务器上已经发出的命令可能仍在执行，请先核对再重试。"
                        .to_string(),
                );
                snapshot.pending_approval = None;
                snapshot.updated_at = now;
                reaped = true;
            }
        }
        if reaped {
            self.mark_finished();
        }
        reaped
    }

    /**
     * 用户强制结束：不再等后端确认，直接收敛成 `cancelled`。
     *
     * 只能停掉"跟踪"，无法撤回已经发到服务器上的命令 —— 原因写在 `error`
     * 里，界面必须原样告诉用户，不能显示成一个干净的「已停止」。
     */
    pub fn abandon(&self, reason: &str) -> AgentSnapshot {
        self.cancel.cancel();
        self.update(|snapshot| {
            snapshot.pending_approval = None;
            if !snapshot.terminal() {
                snapshot.status = "cancelled".to_string();
                snapshot.error = Some(reason.to_string());
            }
        });
        self.mark_finished();
        self.snapshot()
    }

    fn expired(&self) -> bool {
        self.finished_at
            .lock()
            .ok()
            .and_then(|slot| *slot)
            .is_some_and(|at| at.elapsed() > RETAIN)
    }
}

/// 全部运行中的任务。
#[derive(Clone, Default)]
pub struct AgentRegistry {
    runs: Arc<Mutex<HashMap<String, Arc<AgentHandle>>>>,
}

impl AgentRegistry {
    /// 登记一个新任务。同一个 taskId 还在跑时返回 `None`（不允许并行两份）。
    pub fn register(&self, snapshot: AgentSnapshot, cancel: AiCancel) -> Option<Arc<AgentHandle>> {
        let mut runs = self.runs.lock().ok()?;
        runs.retain(|_, handle| !handle.expired());
        if let Some(existing) = runs.get(&snapshot.task_id) {
            if !existing.snapshot().terminal() {
                return None;
            }
        }
        let handle = Arc::new(AgentHandle::new(snapshot, cancel));
        runs.insert(handle.snapshot().task_id, handle.clone());
        Some(handle)
    }

    pub fn get(&self, task_id: &str) -> Option<Arc<AgentHandle>> {
        let handle = self
            .runs
            .lock()
            .ok()
            .and_then(|runs| runs.get(task_id).cloned())?;
        // 顺带收敛失联句柄：`agent_resume` / `extreme_task_delete` 都通过它
        // 判断"还在执行"，不收敛就会永远拒绝恢复、也永远删不掉。
        handle.reap_if_stale();
        Some(handle)
    }

    pub fn snapshot(&self, task_id: &str) -> Option<AgentSnapshot> {
        self.get(task_id).map(|handle| handle.snapshot())
    }

    /// 强制结束（用户明确选择，不再等后端确认）。没有句柄时返回 `None`。
    pub fn abandon(&self, task_id: &str, reason: &str) -> Option<AgentSnapshot> {
        let handle = self.get(task_id)?;
        Some(handle.abandon(reason))
    }

    /// 结束：保留句柄供快照查询，但标记完成时间（超时后清掉）。
    pub fn finish(&self, task_id: &str) {
        if let Some(handle) = self.get(task_id) {
            handle.mark_finished();
            handle.update(|snapshot| {
                // 结束了就不该再有"等你确认"：否则重进会画出一个点不动的确认条。
                snapshot.pending_approval = None;
                if !snapshot.terminal() {
                    snapshot.status = "cancelled".to_string();
                }
            });
        }
    }

    pub fn remove(&self, task_id: &str) {
        if let Ok(mut runs) = self.runs.lock() {
            runs.remove(task_id);
        }
    }

    /// 正在跑的任务数（测试用）。
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.runs.lock().map(|runs| runs.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> AgentSnapshot {
        AgentSnapshot::new("task-1", "prod", "ssh-1", "/root", "test-model")
    }

    #[test]
    fn same_task_cannot_run_twice() {
        let registry = AgentRegistry::default();
        let first = registry.register(snapshot(), AiCancel::new());
        assert!(first.is_some());
        let second = registry.register(snapshot(), AiCancel::new());
        assert!(second.is_none(), "同一个 taskId 不允许并行两份");
    }

    #[test]
    fn finished_task_allows_a_new_run_and_keeps_the_snapshot() {
        let registry = AgentRegistry::default();
        let handle = registry.register(snapshot(), AiCancel::new()).unwrap();
        handle.update(|snapshot| snapshot.status = "success".to_string());
        registry.finish("task-1");
        assert_eq!(registry.snapshot("task-1").unwrap().status, "success");
        assert!(registry.register(snapshot(), AiCancel::new()).is_some());
    }

    #[test]
    fn approval_handshake_resolves_once() {
        let handle = AgentHandle::new(snapshot(), AiCancel::new());
        let _receiver = handle.wait_approval("call-1");
        assert_eq!(handle.pending_approval().as_deref(), Some("call-1"));
        assert!(handle.resolve_approval("call-1", false));
        assert!(handle.pending_approval().is_none());
        // 第二次没有等待者，返回 false（不会误成功）。
        assert!(!handle.resolve_approval("call-1", true));
    }

    #[test]
    fn steer_withdraws_a_pending_approval_and_is_taken_once() {
        let handle = AgentHandle::new(snapshot(), AiCancel::new());
        let mut receiver = handle.wait_approval("call-1");

        handle.push_steer("只看容器里的");
        // 撤回的是"这次待确认"，不是整个任务：接收端按拒绝收到 false。
        assert!(matches!(receiver.try_recv(), Ok(false)));
        assert!(handle.take_withdrawn("call-1"));
        assert_eq!(handle.take_steers(), vec!["只看容器里的".to_string()]);
        // 取走后清空，不会重复生效；撤回标记也只消费一次。
        assert!(!handle.has_steers());
        assert!(handle.take_steers().is_empty());
        assert!(!handle.take_withdrawn("call-1"));
    }

    #[test]
    fn stale_running_task_is_reaped_so_it_can_run_again() {
        let registry = AgentRegistry::default();
        let handle = registry.register(snapshot(), AiCancel::new()).unwrap();
        // 超过总时长上限没有任何进展：循环已经不可能还在跑。
        // 直接改快照字段（`update` 会把 updated_at 刷新成"现在"）。
        handle.snapshot.lock().unwrap().updated_at =
            crate::db::AppDb::now() - STALE_AFTER_MS - 1000;
        let reaped = registry.snapshot("task-1").unwrap();
        assert_eq!(reaped.status, "failed");
        assert!(reaped.error.unwrap().contains("失联"));
        // 收敛之后同一个 taskId 允许重新启动；以前会永远卡在"还在执行"。
        assert!(registry.register(snapshot(), AiCancel::new()).is_some());
    }

    #[test]
    fn abandon_marks_a_running_task_cancelled() {
        let registry = AgentRegistry::default();
        registry.register(snapshot(), AiCancel::new()).unwrap();
        let snapshot = registry.abandon("task-1", "用户强制结束").unwrap();
        assert_eq!(snapshot.status, "cancelled");
        assert_eq!(snapshot.error.as_deref(), Some("用户强制结束"));
        assert!(snapshot.pending_approval.is_none());
    }

    #[test]
    fn abandon_without_a_handle_returns_none() {
        let registry = AgentRegistry::default();
        assert!(registry.abandon("missing", "用户强制结束").is_none());
    }

    #[test]
    fn empty_steer_is_ignored() {
        let handle = AgentHandle::new(snapshot(), AiCancel::new());
        handle.push_steer("   ");
        assert!(!handle.has_steers());
        assert!(handle.take_steers().is_empty());
    }

    #[test]
    fn patch_step_only_touches_its_own_index() {
        let handle = AgentHandle::new(snapshot(), AiCancel::new());
        handle.push_step(AgentStep {
            index: 0,
            state: "running".to_string(),
            ..Default::default()
        });
        handle.push_step(AgentStep {
            index: 1,
            state: "running".to_string(),
            ..Default::default()
        });
        handle.patch_step(1, |step| step.state = "success".to_string());
        let steps = handle.snapshot().steps;
        assert_eq!(steps[0].state, "running");
        assert_eq!(steps[1].state, "success");
    }
}
