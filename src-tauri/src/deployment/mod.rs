//! P5.0 智能部署中心 —— 领域模型与校验（**不执行任何部署**）。
//!
//! # 定位
//!
//! 这一层只回答"我要部署什么、部署到哪、依赖什么"，并把答案变成**结构化事实**。
//! 它不产生 shell 文本、不建立 SSH 连接、不调用 [`crate::safe::Capability`] ——
//! 真正把方案编译成动作并执行是 P5.1 及以后的事（Workflow Engine + 部署动作）。
//!
//! # 安全模型（P5.0 核心，勿绕过）
//!
//! 1. **模型里没有任何自由文本命令字段**。服务的启动方式是 [`ServiceRuntime`]
//!    这类**带类型的枚举**（systemd 单元名 / 镜像+标签+容器名 / 结构化入口与参数），
//!    计划节点的参数是 `params_json`，而它必须通过
//!    [`validate::validate_params_json`]：禁止 `command` / `cmd` / `shell` /
//!    `script` / `exec` 这类键，且**任何字符串值都不允许出现 shell 元字符**。
//!    也就是说：想往库里塞一条可以直接喂给 shell 的命令，在保存阶段就会被拒绝。
//! 2. **Secret 只存引用**（[`SecretRef`]）：Keyring 账户名或运行时临时文件路径模板，
//!    **没有 value 字段**，前端也永远读不到明文。
//! 3. **路径必须是绝对路径且落在允许的根下**：服务目录必须在环境的 `deploy_root`
//!    内（见 [`validate::validate_under_root`]），临时密钥文件只允许 `/run`、
//!    `/dev/shm`。
//! 4. **图必须是有向无环图**：节点 key 唯一、无自环、无重复边、无环 ——
//!    [`validate::validate_plan_graph`] 在保存计划时统一校验。
//!
//! # 与旧代码的关系
//!
//! P3 的 `projects` / `deployments`（`commands_json` 那套）**保留但标记 legacy**，
//! 不做扩展：新模型不引用它，只有 [`ServiceUnit`] 通过
//! `confirmed_project_id` / `confirmed_project_path` 关联 P3.8 的已确认项目，
//! 用来回答"这个服务对应服务器上哪个目录"。详见
//! `docs/P5_DEPLOYMENT_CENTER_DESIGN.md`。

pub mod action;
pub mod ai;
pub mod artifact;
pub mod exec;
pub mod knowledge;
pub mod model;
/// P5.2 部署方案生成：确定性规则引擎 + 离线知识库 + **可选**的 AI 增强。
///
/// AI 不是决策来源：方案由规则引擎算出来，AI 只能以 `Recommendation` 等级
/// 补充说明，且要过与规则引擎同一套校验（见 [`proposal::ai`]）。
pub mod proposal;
pub mod run;
pub mod validate;

pub use model::*;

#[cfg(test)]
mod tests;
