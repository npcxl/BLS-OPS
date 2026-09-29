//! P5.3 —— **运行编排**：把编译好的动作序列安全地跑完。
//!
//! # 流程（与设计逐条对应）
//!
//! ```text
//! 预检  →  锁定环境  →  创建 DeploymentRun  →  按 DAG 执行节点
//!   →  实时事件  →  健康检查（动作自带）  →  Promote  →  保存 Release  →  解锁
//! ```
//!
//! # 生产环境的六条硬规则（都在这里落地，不靠 UI 自觉）
//!
//! 1. **高风险节点单独确认**：`approval_required` 的步骤没被批准就停下，
//!    运行进入 `paused`，**不跳过、不代签**。
//! 2. **同一环境禁止并发**：[`EnvironmentLocks`] 以环境为键；运行中（含暂停中）
//!    持锁，终态才释放。
//! 3. **Nginx 写入前备份 / `nginx -t` 通过才 reload**：写在动作顺序（编译层）与
//!    执行器（`exec::steps`）两处，任何一层都拦得住。
//! 4. **DNS 未生效不发 HTTP-01 / 泛域名只走 DNS-01**：校验层 + 执行器双重判定。
//! 5. **Secret 不进日志与快照**：日志走 `SecretScrubber`；运行快照只存
//!    "批准了哪些节点、锁的键"这类元数据。
//! 6. **失败留现场**：失败**不自动回滚**。人可以选择"重试本节点"、"从该节点继续"
//!    或"回滚"；回滚是独立入口，且它自己也要审批。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use crate::db::{self, AppDb};
use crate::deployment::action::compile::{compile_graph, CompileContext};
use crate::deployment::action::model::ActionKind;
use crate::deployment::action::spec::{spec, ActionPhase};
use crate::deployment::action::CompiledPlan;
use crate::deployment::artifact::model::ArtifactImportTask;
use crate::deployment::exec::{self, ExecContext, KeyringSecrets, SecretResolver, SecretScrubber};
use crate::deployment::model::*;
use crate::deployment::proposal::model::SecurityPolicy;
use crate::deployment::proposal::rules::ServiceFacts;
use crate::project_readiness::CheckState;
use crate::ssh::SshSessionManager;

mod preflight;

pub use preflight::{preflight, PreflightCheck, PreflightInputs, PreflightReport};

/// 环境锁：`环境 id → 持有它的运行 id`。
///
/// 键是**环境**而不是计划：同一个环境里两份不同计划同时部署，同样是事故。
#[derive(Clone, Default)]
pub struct EnvironmentLocks {
    held: Arc<Mutex<HashMap<String, String>>>,
}

impl EnvironmentLocks {
    /// 加锁。已被别的运行持有时返回当前持有者，调用方可以把运行 id 报给用户。
    pub fn acquire(&self, environment_id: &str, run_id: &str) -> Result<(), String> {
        let mut held = self
            .held
            .lock()
            .map_err(|_| "环境锁不可用（内部状态异常）".to_string())?;
        match held.get(environment_id) {
            Some(holder) if holder != run_id => Err(format!(
                "该环境已有部署在进行中（运行 {holder}）。请等它结束，或先取消它。"
            )),
            _ => {
                held.insert(environment_id.to_string(), run_id.to_string());
                Ok(())
            }
        }
    }

    pub fn release(&self, environment_id: &str, run_id: &str) {
        if let Ok(mut held) = self.held.lock() {
            if held.get(environment_id).map(String::as_str) == Some(run_id) {
                held.remove(environment_id);
            }
        }
    }

    pub fn holder(&self, environment_id: &str) -> Option<String> {
        self.held
            .lock()
            .ok()
            .and_then(|held| held.get(environment_id).cloned())
    }
}

/// 内存里的运行态（取消位 + 里已批准节点）。**审批同时落库**，重启后仍可审计。
#[derive(Clone, Default)]
pub struct RunRegistry {
    cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    approvals: Arc<Mutex<HashMap<String, Vec<String>>>>,
}

impl RunRegistry {
    /// 登记一次运行，返回取消令牌（执行协程持有它）。
    pub fn register(&self, run_id: &str) -> Arc<AtomicBool> {
        let token = Arc::new(AtomicBool::new(false));
        if let Ok(mut cancels) = self.cancels.lock() {
            cancels.insert(run_id.to_string(), token.clone());
        }
        token
    }

    pub fn cancel(&self, run_id: &str) -> bool {
        self.cancels
            .lock()
            .ok()
            .and_then(|cancels| cancels.get(run_id).cloned())
            .map(|token| {
                token.store(true, Ordering::Relaxed);
                true
            })
            .unwrap_or(false)
    }

    pub fn token(&self, run_id: &str) -> Option<Arc<AtomicBool>> {
        self.cancels
            .lock()
            .ok()
            .and_then(|cancels| cancels.get(run_id).cloned())
    }

    pub fn forget(&self, run_id: &str) {
        if let Ok(mut cancels) = self.cancels.lock() {
            cancels.remove(run_id);
        }
        if let Ok(mut approvals) = self.approvals.lock() {
            approvals.remove(run_id);
        }
    }

    pub fn approve(&self, run_id: &str, node_key: &str) {
        if let Ok(mut approvals) = self.approvals.lock() {
            let entry = approvals.entry(run_id.to_string()).or_default();
            if !entry.iter().any(|key| key == node_key) {
                entry.push(node_key.to_string());
            }
        }
    }

    pub fn approvals(&self, run_id: &str) -> Vec<String> {
        self.approvals
            .lock()
            .ok()
            .and_then(|approvals| approvals.get(run_id).cloned())
            .unwrap_or_default()
    }

    pub fn is_approved(&self, run_id: &str, node_key: &str, persisted: &[String]) -> bool {
        persisted.iter().any(|key| key == node_key)
            || self.approvals(run_id).iter().any(|key| key == node_key)
    }
}

/// 运行的元数据（存在 `deployment_runs.snapshot_json`）。
///
/// **刻意只有这几个字段**：快照里不放配置值、不放密钥、不放服务器输出 ——
/// 那些属于日志（已脱敏），而快照是审计对象，越干净越好。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct RunMeta {
    /// 本次运行里被明确批准的高风险节点 key。
    #[serde(default)]
    pub approved_nodes: Vec<String>,
    /// 环境锁的键（环境 id）。
    #[serde(default)]
    pub lock_key: String,
    /// 已成功完成的节点 key（重试/继续时用来决定从哪里接着跑）。
    #[serde(default)]
    pub completed_nodes: Vec<String>,
    /// 结论性备注（例如"回滚自运行 x"）。
    #[serde(default)]
    pub note: String,
    /// 本次运行使用的版本标签（= 发布目录名）。重试/回滚必须沿用同一个标签，
    /// 否则会落到另一个目录上，回滚就对不上了。
    #[serde(default)]
    pub version_label: String,
}

pub fn read_meta(run: &DeploymentRun) -> RunMeta {
    run.snapshot_json
        .as_deref()
        .and_then(|json| serde_json::from_str(json).ok())
        .unwrap_or_default()
}

pub fn write_meta(run: &mut DeploymentRun, meta: &RunMeta) {
    run.snapshot_json = serde_json::to_string(meta).ok();
}

/// 一次运行需要的全部输入（**拥有数据**，因此可以搬进异步任务）。
#[derive(Clone)]
pub struct RunSetup {
    pub environment_kind: EnvironmentKind,
    pub deploy_root: String,
    pub version_label: String,
    pub image_namespace: String,
    pub services: Vec<ServiceUnit>,
    pub artifacts: Vec<ArtifactRecord>,
    pub domains: Vec<DomainBinding>,
    pub configs: Vec<ConfigDefinition>,
    pub facts: Vec<ServiceFacts>,
    pub secret_refs: Vec<SecretRef>,
    pub policy: SecurityPolicy,
}

impl RunSetup {
    /// 编译（确定性：同一份输入两次编译得到同一条动作序列）。
    pub fn compile(&self, plan: &DeploymentPlanGraph) -> Result<CompiledPlan, String> {
        let context = CompileContext {
            environment_kind: self.environment_kind,
            deploy_root: self.deploy_root.clone(),
            version_label: self.version_label.clone(),
            image_namespace: self.image_namespace.clone(),
            services: &self.services,
            artifacts: &self.artifacts,
            domains: &self.domains,
            configs: &self.configs,
            facts: &self.facts,
        };
        compile_graph(plan, &context).map_err(|error| error.to_string())
    }
}

/// 开始一次运行的选项。
#[derive(Clone)]
pub struct StartOptions {
    pub session_id: String,
    pub trigger: RunTrigger,
    /// 本次运行**预先批准**的节点 key（供"我已经知道这个要部署"的场景）。
    pub approved_nodes: Vec<String>,
    /// 是否跳过预检（默认不跳；只有重试/继续时用）。
    pub skip_preflight: bool,
}

/// 执行器（可克隆，搬进异步任务）。
#[derive(Clone)]
pub struct RunExecutor {
    pub db: Arc<AppDb>,
    pub ssh: SshSessionManager,
    pub registry: RunRegistry,
    pub locks: EnvironmentLocks,
    pub setup: Arc<RunSetup>,
    pub plan: Arc<DeploymentPlanGraph>,
    pub secrets: Arc<dyn SecretResolver>,
    pub emit: Arc<dyn Fn(DeploymentRunDetail) + Send + Sync>,
    /// 本次运行使用的 SSH 会话（可换：重试/继续时用户会重新连接）。
    session_id: Arc<Mutex<String>>,
}

impl RunExecutor {
    pub fn with_keyring(
        db: Arc<AppDb>,
        ssh: SshSessionManager,
        registry: RunRegistry,
        locks: EnvironmentLocks,
        setup: RunSetup,
        plan: DeploymentPlanGraph,
        emit: Arc<dyn Fn(DeploymentRunDetail) + Send + Sync>,
    ) -> Self {
        Self {
            db,
            ssh,
            registry,
            locks,
            setup: Arc::new(setup),
            plan: Arc::new(plan),
            secrets: Arc::new(KeyringSecrets),
            emit,
            session_id: Arc::new(Mutex::new(String::new())),
        }
    }

    /// 指定本次执行使用的 SSH 会话。**没有会话就不可能执行任何动作**。
    pub fn with_session(self, session_id: &str) -> Self {
        if let Ok(mut current) = self.session_id.lock() {
            *current = session_id.to_string();
        }
        self
    }

    fn session(&self) -> String {
        self.session_id
            .lock()
            .map(|session| session.clone())
            .unwrap_or_default()
    }

    fn persistence(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        // 所有落库都串行化：SQLite 连接不是跨线程的，且顺序写才能保证
        // "事件里的状态 == 库里的状态"。
        static WRITE_LOCK: Mutex<()> = Mutex::new(());
        WRITE_LOCK.lock().map_err(|_| "持久化锁不可用".to_string())
    }

    /// 落库（命令层在恢复运行时用它把状态改回 Running）。
    pub fn save_run(&self, run: &DeploymentRun) {
        if let Ok(_guard) = self.persistence() {
            if let Ok(conn) = self.db.open() {
                let _ = db::upsert_run(&conn, run);
            }
        }
    }

    fn save_node(&self, node: &RunNode) {
        if let Ok(_guard) = self.persistence() {
            if let Ok(conn) = self.db.open() {
                let _ = db::upsert_run_node(&conn, node);
            }
        }
    }

    fn load_nodes(&self, run_id: &str) -> Vec<RunNode> {
        self.db
            .open()
            .ok()
            .and_then(|conn| db::list_run_nodes(&conn, run_id).ok())
            .unwrap_or_default()
    }

    fn emit_detail(&self, run: DeploymentRun) {
        let nodes = self.load_nodes(&run.id);
        (self.emit)(DeploymentRunDetail { run, nodes });
    }

    fn finish(&self, run: &mut DeploymentRun, status: RunStatus, error: Option<String>, now: i64) {
        run.status = status;
        run.finished_at = Some(now);
        if let Some(started) = run.started_at {
            run.duration_ms = Some(now.saturating_sub(started));
        }
        if let Some(message) = error {
            run.error_message = Some(message);
        }
        // 终态才解锁：暂停中的运行仍然占着环境，避免第二个部署插进来。
        if !matches!(
            status,
            RunStatus::Running | RunStatus::Paused | RunStatus::Pending
        ) {
            self.locks.release(&run.environment_id, &run.id);
            self.registry.forget(&run.id);
        }
        self.save_run(run);
        self.emit_detail(run.clone());
    }

    /// 建好运行与节点行（但不执行）。
    pub fn prepare(&self, options: &StartOptions) -> Result<DeploymentRun, String> {
        let compiled = self.setup.compile(&self.plan)?;
        if compiled.steps.len() > MAX_STEPS {
            return Err(format!(
                "计划展开出 {} 个动作步骤，超过上限 {MAX_STEPS}：请拆分计划",
                compiled.steps.len()
            ));
        }
        let now = AppDb::now();
        let run_id = uuid::Uuid::new_v4().to_string();
        // **先加锁再建运行**：拿不到锁就直接失败，不会留下"半启动"的运行记录。
        // 键是环境 id —— 同一个环境不允许两个部署同时进行。
        self.locks
            .acquire(&self.plan.plan.environment_id, &run_id)?;

        let mut run = DeploymentRun {
            id: run_id.clone(),
            plan_id: self.plan.plan.id.clone(),
            application_id: self.plan.plan.application_id.clone(),
            environment_id: self.plan.plan.environment_id.clone(),
            server_id: String::new(),
            server_name: String::new(),
            status: RunStatus::Running,
            trigger_source: options.trigger,
            plan_version: self.plan.plan.version,
            started_at: Some(now),
            finished_at: None,
            duration_ms: None,
            log: String::new(),
            error_message: None,
            snapshot_json: None,
            release_id: None,
            created_at: now,
        };
        let mut meta = RunMeta {
            approved_nodes: options.approved_nodes.clone(),
            lock_key: run.environment_id.clone(),
            completed_nodes: Vec::new(),
            note: String::new(),
            version_label: self.setup.version_label.clone(),
        };
        write_meta(&mut run, &meta);

        self.registry.register(&run_id);
        self.save_run(&run);
        for (index, step) in compiled.steps.iter().enumerate() {
            let node = RunNode {
                id: format!("{run_id}:{index}"),
                run_id: run_id.clone(),
                node_id: Some(step.node_key.clone()),
                node_key: step.node_key.clone(),
                title: step.title.clone(),
                action: step.action.kind().as_str().to_string(),
                risk_level: step.risk_level,
                status: RunNodeStatus::Pending,
                attempt: 1,
                started_at: None,
                finished_at: None,
                duration_ms: None,
                exit_code: None,
                output: String::new(),
                error_message: None,
                created_at: now,
            };
            // 已经批准过的节点直接标为 Blocked（等待），让 UI 一眼看到卡在哪。
            self.save_node(&node);
        }
        meta.note = format!("编译出 {} 个动作步骤", compiled.steps.len());
        write_meta(&mut run, &meta);
        self.save_run(&run);
        Ok(run)
    }

    /// 执行（含审批门、重试、补偿记录、提升与版本保存）。
    ///
    /// `resume_from` 为 `None` 时从头跑；给了节点 key 则从它开始
    /// （之前的成功节点跳过 —— 这就是"重试节点"与"从节点继续"的同一个实现）。
    pub async fn execute(
        &self,
        mut run: DeploymentRun,
        resume_from: Option<String>,
    ) -> Result<DeploymentRun, String> {
        let compiled = self.setup.compile(&self.plan)?;
        let cancel = self
            .registry
            .token(&run.id)
            .unwrap_or_else(|| self.registry.register(&run.id));
        let scrubber = SecretScrubber::default();
        let persisted = read_meta(&run).approved_nodes.clone();

        let nodes = self.load_nodes(&run.id);
        let mut completed: Vec<String> = read_meta(&run).completed_nodes;
        let mut skipping = resume_from.is_some();
        let resume_key = resume_from.clone();
        let session = self.session();
        if session.trim().is_empty() {
            return Err("没有可用的 SSH 会话，无法执行部署".to_string());
        }

        for step in compiled.steps.clone() {
            // "从节点继续"：跳过错过的节点（它们的执行记录已经在库里）。
            if skipping {
                match resume_key.as_deref() {
                    Some(key) if key == step.node_key => skipping = false,
                    _ => {
                        let done = nodes.iter().any(|node| {
                            node.node_key == step.node_key
                                && matches!(
                                    node.status,
                                    RunNodeStatus::Succeeded | RunNodeStatus::Skipped
                                )
                        });
                        if done && !completed.iter().any(|key| key == &step.node_key) {
                            completed.push(step.node_key.clone());
                        }
                        continue;
                    }
                }
            }

            if cancel.load(Ordering::Relaxed) {
                run.log.push_str("运行被取消。\n");
                self.finish(&mut run, RunStatus::Cancelled, None, AppDb::now());
                return Ok(run);
            }

            // ---- 审批门：高风险节点没被批准就停在这里 ----
            if step.approval_required
                && !self
                    .registry
                    .is_approved(&run.id, &step.node_key, &persisted)
            {
                let mut node = self.node_row(&run.id, &step, RunNodeStatus::Blocked, 1);
                node.output = format!(
                    "等待人工确认：{}（风险：{:?}）。确认后由“继续”从本节点接着执行。",
                    step.title, step.risk_level
                );
                self.save_node(&node);
                run.log
                    .push_str(&format!("已暂停：节点 {} 需要单独确认。\n", step.node_key));
                self.finish(&mut run, RunStatus::Paused, None, AppDb::now());
                return Ok(run);
            }

            // ---- 执行（按重试策略）----
            let action_spec = spec(step.action.kind());
            let mut attempt = 1u32;
            let mut outcome = None;
            let mut last_error: Option<String> = None;
            while attempt <= action_spec.retry.max_attempts {
                if cancel.load(Ordering::Relaxed) {
                    break;
                }
                let started = AppDb::now();
                let mut lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
                let collector = lines.clone();
                let log = move |line: &str| {
                    if let Ok(mut lines) = collector.lock() {
                        lines.push(line.to_string());
                    }
                };
                let context = ExecContext {
                    ssh: &self.ssh,
                    session_id: &session,
                    environment_kind: self.setup.environment_kind,
                    secrets: self.secrets.as_ref(),
                    secret_refs: &self.setup.secret_refs,
                    scrubber: &scrubber,
                    cancel: &cancel,
                    log: &log,
                };
                match exec::execute(&step.action, &context).await {
                    Ok(result) => {
                        let finished = AppDb::now();
                        let mut node =
                            self.node_row(&run.id, &step, RunNodeStatus::Succeeded, attempt as i64);
                        node.started_at = Some(started);
                        node.finished_at = Some(finished);
                        node.duration_ms = Some(finished.saturating_sub(started));
                        node.output = lines.lock().map(|l| l.join("\n")).unwrap_or_default();
                        if !node.output.is_empty() {
                            node.output.push('\n');
                        }
                        node.output.push_str(&result.summary);
                        if result.needs_acknowledgement {
                            node.status = RunNodeStatus::Blocked;
                            self.save_node(&node);
                            run.log.push_str(&format!(
                                "已暂停：{} 需要人工完成后确认。\n",
                                step.node_key
                            ));
                            self.finish(&mut run, RunStatus::Paused, None, AppDb::now());
                            return Ok(run);
                        }
                        self.save_node(&node);
                        completed.push(step.node_key.clone());
                        let mut meta = read_meta(&run);
                        meta.completed_nodes = completed.clone();
                        write_meta(&mut run, &meta);
                        self.save_run(&run);
                        self.emit_detail(run.clone());

                        // 提升成功 → 立刻落一条版本记录（"Promote → 保存 Release"）。
                        if step.action.kind() == ActionKind::PromoteRelease {
                            self.save_release(&mut run, &step);
                        }
                        outcome = Some(result);
                        break;
                    }
                    Err(error) => {
                        last_error = Some(scrubber.scrub(&error));
                        let retryable = action_spec.idempotency.allows_automatic_retry()
                            && attempt < action_spec.retry.max_attempts;
                        let mut node =
                            self.node_row(&run.id, &step, RunNodeStatus::Failed, attempt as i64);
                        node.started_at = Some(started);
                        node.finished_at = Some(AppDb::now());
                        node.duration_ms = Some(AppDb::now().saturating_sub(started));
                        node.output = lines.lock().map(|l| l.join("\n")).unwrap_or_default();
                        node.error_message = last_error.clone();
                        self.save_node(&node);
                        self.emit_detail(run.clone());
                        if !retryable {
                            break;
                        }
                        attempt += 1;
                        tokio::time::sleep(action_spec.retry.backoff).await;
                    }
                }
            }

            if outcome.is_none() {
                let message = last_error.unwrap_or_else(|| "动作未执行".to_string());
                let compensation = action_spec
                    .compensation
                    .map(|kind| format!("可补偿动作：{}", kind.label()))
                    .unwrap_or_else(|| "该动作无需补偿".to_string());
                run.log.push_str(&format!(
                    "节点 {} 失败：{}\n{}。现场已保留，可重试本节点、从该节点继续，或执行回滚。\n",
                    step.node_key, message, compensation
                ));
                self.finish(&mut run, RunStatus::Failed, Some(message), AppDb::now());
                return Ok(run);
            }
        }

        let now = AppDb::now();
        self.finish(&mut run, RunStatus::Succeeded, None, now);
        Ok(run)
    }

    /// 回滚：执行计划里的回滚链（独立入口，自身也按审批门跑）。
    pub async fn rollback(
        &self,
        mut run: DeploymentRun,
        session_id: &str,
    ) -> Result<DeploymentRun, String> {
        let compiled = self.setup.compile(&self.plan)?;
        if compiled.rollback_steps.is_empty() {
            return Err("这份计划没有回滚节点，无法自动回滚".to_string());
        }
        let cancel = self
            .registry
            .token(&run.id)
            .unwrap_or_else(|| self.registry.register(&run.id));
        let scrubber = SecretScrubber::default();
        let persisted = read_meta(&run).approved_nodes.clone();

        for step in compiled.rollback_steps.clone() {
            if step.approval_required
                && !self
                    .registry
                    .is_approved(&run.id, &step.node_key, &persisted)
            {
                let mut node = self.node_row(&run.id, &step, RunNodeStatus::Blocked, 1);
                node.output = format!("回滚步骤等待确认：{}", step.title);
                self.save_node(&node);
                self.finish(&mut run, RunStatus::Paused, None, AppDb::now());
                return Ok(run);
            }
            let mut lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
            let collector = lines.clone();
            let log = move |line: &str| {
                if let Ok(mut lines) = collector.lock() {
                    lines.push(line.to_string());
                }
            };
            let context = ExecContext {
                ssh: &self.ssh,
                session_id,
                environment_kind: self.setup.environment_kind,
                secrets: self.secrets.as_ref(),
                secret_refs: &self.setup.secret_refs,
                scrubber: &scrubber,
                cancel: &cancel,
                log: &log,
            };
            let started = AppDb::now();
            match exec::execute(&step.action, &context).await {
                Ok(result) => {
                    let mut node = self.node_row(&run.id, &step, RunNodeStatus::Succeeded, 1);
                    node.started_at = Some(started);
                    node.finished_at = Some(AppDb::now());
                    node.duration_ms = Some(AppDb::now().saturating_sub(started));
                    node.output = lines.lock().map(|l| l.join("\n")).unwrap_or_default();
                    node.output.push_str(&result.summary);
                    self.save_node(&node);
                    self.emit_detail(run.clone());
                }
                Err(error) => {
                    let message = scrubber.scrub(&error);
                    let mut node = self.node_row(&run.id, &step, RunNodeStatus::Failed, 1);
                    node.error_message = Some(message.clone());
                    node.output = lines.lock().map(|l| l.join("\n")).unwrap_or_default();
                    self.save_node(&node);
                    self.finish(&mut run, RunStatus::Failed, Some(message), AppDb::now());
                    return Ok(run);
                }
            }
        }
        // 回滚完成：把当前生效的版本标记为已回滚。
        if let Ok(conn) = self.db.open() {
            if let Some(service_id) = compiled
                .rollback_steps
                .iter()
                .find_map(|step| step.service_unit_id.clone())
            {
                let _ = db::mark_release_rolled_back(&conn, &service_id, AppDb::now());
            }
        }
        let mut meta = read_meta(&run);
        meta.note = "已回滚到上一版本".to_string();
        write_meta(&mut run, &meta);
        self.finish(&mut run, RunStatus::RolledBack, None, AppDb::now());
        Ok(run)
    }

    fn node_row(
        &self,
        run_id: &str,
        step: &crate::deployment::action::CompiledStep,
        status: RunNodeStatus,
        attempt: i64,
    ) -> RunNode {
        RunNode {
            id: format!("{run_id}:{}", step.node_key),
            run_id: run_id.to_string(),
            node_id: Some(step.node_key.clone()),
            node_key: step.node_key.clone(),
            title: step.title.clone(),
            action: step.action.kind().as_str().to_string(),
            risk_level: step.risk_level,
            status,
            attempt,
            started_at: None,
            finished_at: None,
            duration_ms: None,
            exit_code: None,
            output: String::new(),
            error_message: None,
            created_at: AppDb::now(),
        }
    }

    /// 提升成功 → 写一条 ReleaseRecord（一个服务一条）。
    fn save_release(
        &self,
        run: &mut DeploymentRun,
        step: &crate::deployment::action::CompiledStep,
    ) {
        let Some(service_unit_id) = step.service_unit_id.clone() else {
            return;
        };
        let now = AppDb::now();
        let artifact_id = self
            .setup
            .services
            .iter()
            .find(|service| service.id == service_unit_id)
            .and_then(|service| service.artifact_id.clone());
        let release = ReleaseRecord {
            id: uuid::Uuid::new_v4().to_string(),
            application_id: run.application_id.clone(),
            environment_id: run.environment_id.clone(),
            service_unit_id: Some(service_unit_id.clone()),
            run_id: Some(run.id.clone()),
            version_label: self.setup.version_label.clone(),
            artifact_id,
            is_active: true,
            activated_at: Some(now),
            replaced_release_id: self
                .db
                .open()
                .ok()
                .and_then(|conn| db::active_release(&conn, &service_unit_id).ok().flatten())
                .map(|active| active.id),
            nginx_backup_path: None,
            image_digest: None,
            config_snapshot_json: None,
            status: ReleaseStatus::Active,
            notes: format!("由运行 {} 提升", run.id),
            created_at: now,
            updated_at: now,
        };
        if let Ok(_guard) = self.persistence() {
            if let Ok(conn) = self.db.open() {
                if db::upsert_release(&conn, &release).is_ok() {
                    run.release_id = Some(release.id.clone());
                    self.save_run(run);
                }
            }
        }
    }
}

/// 从导入任务里取服务事实（P5.1 → P5.2 → P5.3 的同一套连接键）。
pub fn facts_from_tasks(
    services: &[ServiceUnit],
    artifacts: &[ArtifactRecord],
    tasks: &[ArtifactImportTask],
    deploy_root: Option<&str>,
) -> Vec<ServiceFacts> {
    crate::deployment::proposal::derive_service_facts(services, artifacts, tasks, deploy_root)
}

/// 本次运行最多执行多少个动作步骤（防止一张失控的图把服务器跑穿）。
pub const MAX_STEPS: usize = 200;

/// 动作步骤的执行顺序是编译期确定的（`CompiledPlan.steps`）。
pub fn step_phases(plan: &CompiledPlan) -> Vec<ActionPhase> {
    plan.steps
        .iter()
        .map(|step| spec(step.action.kind()).phase)
        .collect()
}

/// 运行与节点（IPC 载荷）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DeploymentRunDetail {
    pub run: DeploymentRun,
    pub nodes: Vec<RunNode>,
}

#[cfg(test)]
mod tests;
