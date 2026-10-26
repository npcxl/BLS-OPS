//! P5.6 **AI 部署规划器** —— 草案的形状、校验与"交给确定性编译器的输入"。
//!
//! 边界：AI 只能产出**结构化意图**；真正的动作仍由既有
//! `action::compile` 从 `PlanGraph` 生成，AI 无任何执行入口。

pub mod compile;
pub mod graph;
pub mod model;
pub mod prompt;
pub mod validate;

pub use compile::{compile_services, CompileIssue, CompiledService, RuntimeCatalog};
pub use graph::{as_inputs, to_workflow_plan, WorkflowPlan};
pub use model::{
    AiDeploymentDraft, DraftCapacity, DraftDependency, DraftDomain, DraftQuestion, DraftRisk,
    DraftRuntime, DraftService, DraftSsl,
};
pub use prompt::{build_draft_prompt, DraftPromptInput};
pub use validate::{
    to_plan_input, validate_draft, DraftContext, DraftRejection, PlanCompilerInput,
    FORBIDDEN_TARGETS,
};

#[cfg(test)]
mod tests;
