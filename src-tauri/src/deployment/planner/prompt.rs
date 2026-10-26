//! 组装"让模型产出**部署草案**"的提示词（纯函数，全部有单测）。
//!
//! # 边界（与 `proposal::ai` 的复核提示词同源，但目的不同）
//!
//! 复核提示词给 AI 的是**已经定好的方案**，让它挑毛病；这里给 AI 的是
//! **用户意图 + 项目分析 + 可引用范围**，让它产出"打算怎么部署"。
//!
//! 三条硬边界写进 system 提示，并且**都有代码侧的兜底**（提示词不是唯一防线）：
//!
//! 1. **只输出结构化意图**：不许出现任何 shell 命令、可执行脚本、
//!    `approval` / `execute` 之类的越权目标（`validate_draft` 会逐条拒）。
//! 2. **引用必须真实**：`memory_refs` / `knowledge_refs` 只能来自本次
//!    检索给它的清单，凭空引用会被 [`super::validate_draft`] 判为伪造引用。
//! 3. **不确定就写进 `assumptions`**：不许把猜测写成事实，更不许编造服务器能力。
//!
//! # 不进提示词的东西
//!
//! API Key、SSH 凭据、证书私钥、DNS Token、`.env` 内容、制品原文、
//! 数据库密码、服务器文件内容 —— 一个字节都不会出现在 `payload` 里。

use serde_json::json;

use crate::deployment::proposal::ai::AiPrompt;
use crate::deployment::proposal::model::TopologyKind;

use super::validate::FORBIDDEN_TARGETS;

/// 组装草案提示词所需的输入（全部由调用方从数据库/分析结果拼好）。
pub struct DraftPromptInput<'a> {
    /// 用户自己写的需求描述（**可信**，是用户意图）。
    pub user_description: &'a str,
    /// 项目静态分析结果（来自 `SourceSnapshot`，**不含文件原文**）。
    pub analysis: Option<&'a crate::deployment::analysis::ProjectAnalysis>,
    /// 本次检索命中、允许引用的 Memory（形如 `memory:<id>`）。
    pub memory_refs: &'a [String],
    /// 本次检索命中、允许引用的 Knowledge（形如 `knowledge:<id>@<version>`）。
    pub knowledge_refs: &'a [String],
    /// **本产品形态支持**的拓扑全集（不在清单内的会被 `validate_draft` 拒）。
    ///
    /// 注意这里**不是**"这台机器装了什么"：数据库里没有持久化的能力画像，
    /// 真实能力要连上服务器才知道。把机器能力塞进来就得靠现场探测，而探测失败时
    /// 绝不能让 AI 猜 —— 所以这里给全集，让 AI 表达**意图**，
    /// "这台机器到底行不行"由 [`crate::deployment::session::confirm`] 的预检门禁
    /// 在服务器上核实并阻断。
    pub supported_topologies: &'a [TopologyKind],
    /// 环境 `deploy_root`（所有路径必须落在它里面）。
    pub deploy_root: &'a str,
}

/// 组装草案提示词。
///
/// 纯函数：同样的输入永远得到同样的提示词（便于事后用哈希复现"当时发了什么"）。
pub fn build_draft_prompt(input: &DraftPromptInput<'_>) -> AiPrompt {
    AiPrompt {
        system: system_prompt(),
        payload: json!({
            "task": "design_deployment_plan",
            "user_description": input.user_description,
            "server": {
                "deploy_root": input.deploy_root,
                "supported_topologies": input.supported_topologies
                    .iter()
                    .map(|topology| format!("{topology:?}"))
                    .collect::<Vec<_>>(),
            },
            // 静态分析**可能没有**（用户没导入项目就手写需求）。
            // 缺了就明说"没有"，让模型把不确定的地方写进 assumptions。
            "project_analysis": input.analysis,
            "allowed_memory_refs": input.memory_refs,
            "allowed_knowledge_refs": input.knowledge_refs,
        }),
    }
}

/// system 提示：角色 + 硬约束 + 顶层字段清单。
fn system_prompt() -> String {
    let forbidden = FORBIDDEN_TARGETS.join("`, `");
    format!(
        r#"你是部署规划助手。根据用户需求与项目分析，输出一份**部署草案**。

# 输出格式
只输出**一个 JSON 对象**，不要任何解释文字，不要 Markdown 代码围栏。
顶层字段（一个都不能多，一个都不能少）：
- `summary`：一段话说明打算怎么部署
- `topology`：从 server.supported_topologies 里选一个
- `services`：服务数组，每个含 `name`（小写字母/数字/下划线）、`service_kind`、
  `runtime`、`port`、`health_path`（以 / 开头）
- `dependency_decisions`：服务依赖，含 `from_service`、`to_service`、`kind`、
  `required`、`external`
- `domain_intent`（可空）：`domain`、`service_name`、`listen_port`、`path_prefix`、`ssl_mode`
- `ssl_intent`（可空）：`mode`、`dns_provider`、`dns_records`
- `capacity_suggestions`：`expected_qps`、`expected_concurrency`、`memory_mb`、`disk_gb`
- `risks`：数组，每项含 `id`、`title`、`severity`、`mitigation`
- `assumptions`：你**不得不假设**的每一件事（不确定就写这里，不许当成事实）
- `questions`：真正**阻塞**部署的问题（能靠假设推进的就别问）
- `memory_refs` / `knowledge_refs`：只能引用 allowed_*_refs 里出现过的 id

# 硬约束（违反会被直接拒绝，不是"扣分"）
1. **禁止命令**：不要写任何 shell 命令、脚本、systemd 单元或可执行片段。
   你只描述意图，具体命令由确定性编译器生成。
2. **禁止越权目标**：不得出现 `{forbidden}` 之类的字段或目标。
   审批、批准、执行永远由人来做。
3. **引用必须真实**：`memory_refs` / `knowledge_refs` 只能从上面给出的清单里选，
   凭空引用会被判为伪造引用，整份草案作废。
4. **不许编造事实**：端口、健康检查路径、镜像引用必须是项目分析里真实存在的；
   分析里没有的，写进 `assumptions`。
5. **路径必须在 `server.deploy_root` 之内**，不得越界到其它目录。

# 边界
你只做建议。是否部署、是否批准，永远由用户决定。"#
    )
}

// __TESTS__
#[cfg(test)]
mod tests {
    use super::*;
    use crate::deployment::proposal::model::TopologyKind;

    fn input<'a>(
        description: &'a str,
        analysis: Option<&'a crate::deployment::analysis::ProjectAnalysis>,
        memory: &'a [String],
        knowledge: &'a [String],
    ) -> DraftPromptInput<'a> {
        DraftPromptInput {
            user_description: description,
            analysis,
            memory_refs: memory,
            knowledge_refs: knowledge,
            supported_topologies: &[TopologyKind::DockerCompose],
            deploy_root: "/srv/apps/shop",
        }
    }

    #[test]
    fn the_prompt_carries_the_intent_the_analysis_and_the_reference_allowlist() {
        let memory = vec!["memory:db-layout".to_string()];
        let knowledge = vec!["knowledge:nginx-basics@2".to_string()];
        let prompt = build_draft_prompt(&input(
            "前后端分离，峰值 100 QPS",
            None,
            &memory,
            &knowledge,
        ));
        let payload = &prompt.payload;

        assert_eq!(payload["task"], "design_deployment_plan");
        assert_eq!(payload["user_description"], "前后端分离，峰值 100 QPS");
        assert_eq!(payload["server"]["deploy_root"], "/srv/apps/shop");
        assert_eq!(
            payload["server"]["supported_topologies"][0], "DockerCompose",
            "拓扑必须来自能力快照，不能让模型自选"
        );
        assert_eq!(payload["allowed_memory_refs"][0], "memory:db-layout");
        assert_eq!(
            payload["allowed_knowledge_refs"][0],
            "knowledge:nginx-basics@2"
        );
    }

    #[test]
    fn the_system_prompt_states_the_three_hard_boundaries() {
        let prompt = build_draft_prompt(&input("要 HTTPS", None, &[], &[]));
        // 1. 禁止命令
        assert!(prompt.system.contains("禁止命令"));
        // 2. 越权目标被逐个点名（不是泛泛而谈"不许越权"）：
        //    清单里新增任何一个词，提示词必须自动带上，否则这里会红。
        for target in FORBIDDEN_TARGETS {
            assert!(
                prompt.system.contains(target),
                "越权目标 {target} 必须出现在提示词里"
            );
        }
        // 3. 引用必须真实 + 不许编造
        assert!(prompt.system.contains("凭空引用"));
        assert!(prompt.system.contains("assumptions"));
        // 边界声明
        assert!(prompt.system.contains("永远由用户决定"));
    }

    #[test]
    fn a_missing_analysis_is_reported_as_null_rather_than_invented() {
        let prompt = build_draft_prompt(&input("随便说说", None, &[], &[]));
        assert!(
            prompt.payload["project_analysis"].is_null(),
            "没有分析就说没有，模型不能误以为分析过"
        );
    }

    #[test]
    fn the_prompt_never_carries_credentials() {
        let prompt = build_draft_prompt(&input("部署商城，数据库密码是 hunter2", None, &[], &[]));
        let text = format!("{:?}", prompt.payload);
        // 用户自己把密码写进描述是他的选择，但**结构字段**里不该出现任何
        // 形如 api_key / token / password 的取值通道。
        assert!(!text.contains("api_key"));
        assert!(!text.contains("\"token\""));
        assert!(!text.contains("\"password\""));
    }

    #[test]
    fn the_same_input_always_produces_the_same_prompt() {
        let memory = vec!["memory:db-layout".to_string()];
        let first = build_draft_prompt(&input("同样的需求", None, &memory, &[]));
        let second = build_draft_prompt(&input("同样的需求", None, &memory, &[]));
        // 事后要能复现"当时到底发了什么"，所以提示词组装必须是纯函数。
        assert_eq!(first.system, second.system);
        assert_eq!(first.payload, second.payload);
    }
}
