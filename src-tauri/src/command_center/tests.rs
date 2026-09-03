//! 检索与知识库完整性测试（固定样本，零 I/O）。

use std::collections::HashMap;

use super::model::{CommandCategory, ExecKind, RiskLevel};
use super::search::{search, SearchContext};
use super::{builtin_catalog, catalog as cat};

fn empty_ctx() -> SearchContext {
    SearchContext::default()
}

fn ids(hits: &[super::model::CommandSearchHit]) -> Vec<&str> {
    hits.iter().map(|hit| hit.id.as_str()).collect()
}

/// 知识库完整性：ID 唯一、字段非空、风险与可变性一致、删除类不入库。
#[test]
fn catalog_is_well_formed() {
    let catalog = builtin_catalog();
    assert!(
        (50..=400).contains(&catalog.len()),
        "首批规模 {} 不合理",
        catalog.len()
    );
    let mut seen = std::collections::HashSet::new();
    for entry in catalog {
        assert!(seen.insert(entry.id), "ID 重复：{}", entry.id);
        assert!(!entry.title.is_empty() && !entry.description.is_empty());
        assert!(!entry.syntax.is_empty());
        // 删除类命令第一批绝不收录（P4.4 软删除流程落地后才开放）。
        assert_ne!(entry.risk, RiskLevel::High, "{}：高风险未开放", entry.id);
        assert_ne!(
            entry.risk,
            RiskLevel::Destructive,
            "{}：删除类必须走软删除流程",
            entry.id
        );
        assert_ne!(entry.mutability, super::model::Mutability::Delete);
        // 修改型命令必须是 medium（带确认），只读命令不能标 change。
        if entry.mutability == super::model::Mutability::Read {
            assert_eq!(entry.risk, RiskLevel::ReadOnly, "{}", entry.id);
        } else {
            assert_eq!(entry.risk, RiskLevel::Medium, "{}", entry.id);
        }
        // 带参数的动作必须有参数说明。
        if entry.exec.required_params().is_empty() == false {
            assert!(
                entry.syntax.contains('<'),
                "{} 的语法应含参数占位符",
                entry.id
            );
        }
    }
    // docker 删除类命令不得以任何形式混进来。
    for banned in ["docker rm", "docker rmi", "system prune", "volume rm"] {
        assert!(
            !catalog.iter().any(|e| e.syntax.contains(banned)),
            "删除类命令 {banned} 不应出现在首批知识库"
        );
    }
}

/// 用户的核心用例：`doc` / `docker p` / 中文场景都能搜到 `docker ps -a`。
#[test]
fn docker_ps_is_findable_from_many_queries() {
    let catalog = builtin_catalog();
    for query in [
        "doc",
        "docker p",
        "docker",
        "所有容器",
        "容器列表",
        "查看停止容器",
    ] {
        let hits = search(&catalog, query, &empty_ctx(), 10);
        assert!(
            ids(&hits).contains(&"docker.ps.all"),
            "查询 {query:?} 必须命中 docker.ps.all，实际：{:?}",
            ids(&hits)
        );
    }
}

/// 前缀补全：`docker p` 的第一条应该是 docker ps 系（前缀分最高），
/// 且 `docker pull` 这类未收录条目不会占位。
#[test]
fn prefix_query_ranks_ps_first() {
    let catalog = builtin_catalog();
    let hits = search(&catalog, "docker p", &empty_ctx(), 5);
    assert!(!hits.is_empty());
    assert!(
        hits[0].syntax.starts_with("docker p"),
        "第一条应为 docker p 前缀命令：{}",
        hits[0].syntax
    );
}

/// 中文检索：别名与场景是主入口。
#[test]
fn chinese_aliases_and_scenarios_match() {
    let catalog = builtin_catalog();
    for (query, expected) in [
        ("磁盘", "df.h"),
        ("内存", "free.m"),
        ("端口占用", "ss.listen"),
        ("重启服务", "systemctl.restart"),
        ("nginx 校验", "nginx.test"),
    ] {
        let hits = search(&catalog, query, &empty_ctx(), 10);
        assert!(
            ids(&hits).contains(&expected),
            "查询 {query:?} 必须命中 {expected}，实际：{:?}",
            ids(&hits)
        );
    }
}

/// 无关查询不产生结果（没有「什么都行」的兜底噪声）。
#[test]
fn unrelated_query_matches_nothing() {
    let catalog = builtin_catalog();
    let hits = search(&catalog, "zzzz不存在的命令", &empty_ctx(), 10);
    assert!(hits.is_empty(), "不应有噪声命中：{:?}", ids(&hits));
}

/// 收藏与使用记录参与排序：收藏的排前面。
#[test]
fn favorites_boost_ranking() {
    let catalog = builtin_catalog();
    let ctx = SearchContext {
        favorites: vec!["df.h".to_string()],
        usage: HashMap::new(),
    };
    let hits = search(&catalog, "df", &ctx, 10);
    assert_eq!(hits.first().map(|h| h.id.as_str()), Some("df.h"));
    assert!(hits.first().unwrap().favorite);
}

/// 子序列模糊：`dps` 命中 docker ps。
#[test]
fn subsequence_query_hits_docker_ps() {
    let catalog = builtin_catalog();
    let hits = search(&catalog, "dps", &empty_ctx(), 10);
    assert!(
        ids(&hits).contains(&"docker.ps.all") || ids(&hits).contains(&"docker.ps.running"),
        "dps 应命中 docker ps：{:?}",
        ids(&hits)
    );
}

/// 空查询只返回收藏 / 用过的命令（个性化默认列表）。
#[test]
fn empty_query_returns_only_personalized() {
    let catalog = builtin_catalog();
    let hits = search(&catalog, "", &empty_ctx(), 20);
    assert!(hits.is_empty(), "无收藏无使用时空查询应返回空");
}

/// 分类覆盖：首批必须覆盖全部 7 个分类（用户第一批清单范围）。
#[test]
fn all_categories_present() {
    let catalog = builtin_catalog();
    for category in CommandCategory::ORDERED {
        assert!(
            catalog.iter().any(|e| e.category == category),
            "分类 {:?} 没有条目",
            category
        );
    }
}

/// 每个可执行条目的 ExecKind 都能从结构化参数组装出动作（含缺参报错）。
#[test]
fn exec_kind_builds_from_params() {
    use super::model::{build_exec, CommandParams};

    let catalog = builtin_catalog();
    for entry in catalog {
        if !entry.executable_now() {
            continue;
        }
        // 组装全默认参数：需要参数的动作应报"缺少参数"，不 panic。
        let empty = CommandParams::default();
        if entry.exec.required_params().is_empty() {
            assert!(
                build_exec(entry.exec, &empty, entry.requires).is_ok(),
                "{} 无参数动作应能组装",
                entry.id
            );
        } else {
            let error = build_exec(entry.exec, &empty, entry.requires)
                .err()
                .expect("缺参数必须报错");
            assert!(error.to_string().contains("缺少参数"));
        }
    }
    // docker logs 带容器名可以组装。
    let hit = builtin_catalog()
        .iter()
        .find(|e| e.id == "docker.logs")
        .expect("docker.logs 存在");
    let exec = build_exec(
        hit.exec,
        &CommandParams {
            container: Some("web-1".to_string()),
            ..Default::default()
        },
        hit.requires,
    )
    .expect("带容器名应组装成功");
    assert!(format!("{exec:?}").contains("web-1"));
}

/// 模块引用完整性（防 catalog.rs 里的 ExecKind 拼写漂移）。
#[test]
fn catalog_only_references_known_exec_kinds() {
    // 由编译器保证（EK 枚举类型），这里断言数量稳定以防意外缩水。
    let catalog = cat::CATALOG;
    let executable = catalog.iter().filter(|e| e.executable_now()).count();
    assert!(
        executable >= 25,
        "可执行条目数 {executable} 异常偏少（应 ≥25）"
    );
}
