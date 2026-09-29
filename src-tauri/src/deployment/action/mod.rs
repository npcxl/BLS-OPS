//! P5.3 —— **类型化 Workflow Engine** 的动作层。
//!
//! # 与 P5.0 / P5.2 的分工
//!
//! ```text
//! P5.2 方案      → 计划（DeploymentPlan + PlanNode/PlanEdge，粗粒度、给人看）
//! P5.3 本模块    → 编译（PlanNode → 类型化 DeploymentAction，细粒度、给机器跑）
//! P5.4 exec      → 执行（DeploymentAction → safe::Capability → 远程命令）
//! P5.3 run       → 编排（预检 → 加锁 → 运行 → 事件 → 提升 → 版本 → 解锁）
//! ```
//!
//! # 安全模型（与 P5.0 一脉相承，逐条可测）
//!
//! 1. **没有命令字段**。29 个动作的输入类型里不存在 `command`/`args`/`shell`；
//!    所有输入结构体都带 `deny_unknown_fields`，多写一个键就是错误。
//! 2. **两重校验**。[`validate`] 管语义与范围（路径在部署根下、泛域名不许 HTTP-01、
//!    后端容器不许发布端口…），[`crate::safe`] 管字符与引号。两层都过才执行。
//! 3. **没有"任意命令"的旁路**。旧 P3 的 `commands_json` 不参与本模块：编译器只吃
//!    `PlanNode`（其 `params_json` 保存时已被 `validate_params_json` 拒绝命令类键）。
//! 4. **Secret 只有引用**。运行配置里的密钥条目必须在钥匙串里有引用，明文密钥
//!    连模型都进不来。
//!
//! 元数据（风险 / 幂等性 / 超时 / 重试 / 可取消性 / 前置条件 / 补偿动作）
//! 集中在 [`spec`]，用穷尽 `match` 声明 —— 新增动作不填这张表就编译不过。

pub mod compile;
pub mod model;
pub mod spec;
pub mod validate;

#[cfg(test)]
mod tests;

pub use compile::{
    compile_graph, compile_node, layout, CompileContext, CompiledPlan, CompiledStep,
};
pub use model::{
    ActionKind, ArchiveFormat, BuildDockerImageInput, CertificateChallenge, CheckDependenciesInput,
    ComposeDownInput, ComposeServiceSpec, ComposeUpInput, DeploymentAction, EnsureDirectoryInput,
    ExtractArchiveInput, HttpHealthCheckInput, IssueCertificateInput, NginxSiteSpec,
    PrepareReleaseDirectoryInput, PromoteReleaseInput, PullDockerImageInput, RenewCertificateInput,
    RequireManualStepInput, RequiredTool, RestartSystemdUnitInput, RestoreNginxBackupInput,
    RollbackReleaseInput, RuntimeConfigEntry, StopPreviousReleaseInput, StopTarget,
    SwitchReleaseSymlinkInput, TcpHealthCheckInput, TestNginxConfigInput, UploadArtifactInput,
    VerifyChecksumInput, WaitContainerHealthyInput, WriteComposeFileInput, WriteNginxConfigInput,
    WriteRuntimeConfigInput,
};
pub use spec::{
    approval_required, spec, ActionPhase, ActionSpec, Idempotency, Precondition, RetryPolicy,
};
pub use validate::validate_action;
