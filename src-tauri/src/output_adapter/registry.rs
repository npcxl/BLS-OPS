//! 适配器注册表 —— 替掉不断膨胀的 `match adapter`。
//!
//! 新增一个适配器 = 在 [`register_builtins`] 里加一行；没有注册过的
//! adapter id **不会**导致命令失败，而是走 [`adapt`] 的 raw 回落。
//!
//! # 三层解析策略
//!
//! 1. 机器可读格式（JSON / `--format`）→ `generic::json`；
//! 2. 通用文本（空白列分隔 / `key: value` / 缩进树）→ `generic::*`；
//! 3. 复杂产品语义（Docker 端口、systemd 状态、Nginx location）→ `domain::*`。
//!
//! 注册时显式指定用哪一层，**不做"万能解析器"硬猜**。

use std::collections::HashMap;

use super::model::{CommandMeta, RawOutput, StructuredCommandResult, SummaryItem, ViewType};

/// 一个输出适配器：原始 stdout → 统一协议。
pub type AdapterFn = fn(&str, &AdapterContext) -> AdapterOutcome;

/// 适配器上下文（元信息，供摘要与回落使用）。
pub struct AdapterContext {
    pub title: String,
    pub meta: CommandMeta,
    pub raw: RawOutput,
}

/// 适配结果：`Structured` = 解析成功；`Fallback` = 当作 raw 渲染
/// （**解析失败永远是回落，不是错误**）。
pub enum AdapterOutcome {
    Structured {
        view: ViewType,
        #[allow(clippy::type_complexity)]
        summary: Vec<SummaryItem>,
        columns: Vec<super::model::ColumnDefinition>,
        rows: Vec<serde_json::Value>,
        sections: Vec<super::model::ResultSection>,
        warnings: Vec<String>,
        json: Option<serde_json::Value>,
    },
    Fallback {
        reason: String,
    },
}

/// 适配器注册表。
pub struct AdapterRegistry {
    adapters: HashMap<&'static str, AdapterFn>,
}

impl AdapterRegistry {
    pub fn new() -> Self {
        Self {
            adapters: HashMap::new(),
        }
    }

    pub fn register(&mut self, id: &'static str, adapter: AdapterFn) {
        self.adapters.insert(id, adapter);
    }

    /// 内置适配器表 —— 新增命令的视图在这里登记一行。
    pub fn builtins() -> Self {
        let mut registry = Self::new();
        register_builtins(&mut registry);
        registry
    }

    /// 按 adapter id 适配；未注册或解析失败 → raw 回落（保留全部原始输出）。
    pub fn adapt(
        &self,
        adapter_id: &str,
        stdout: &str,
        ctx: &AdapterContext,
    ) -> StructuredCommandResult {
        let Some(adapter) = self.adapters.get(adapter_id) else {
            return StructuredCommandResult::raw_fallback(
                ctx.title.clone(),
                ctx.meta.clone(),
                ctx.raw.clone(),
            );
        };
        match adapter(stdout, ctx) {
            AdapterOutcome::Structured {
                view,
                summary,
                columns,
                rows,
                sections,
                warnings,
                json,
            } => StructuredCommandResult {
                view,
                title: ctx.title.clone(),
                summary,
                columns,
                rows,
                sections,
                warnings,
                meta: ctx.meta.clone(),
                raw: ctx.raw.clone(),
                json,
            },
            AdapterOutcome::Fallback { reason } => {
                let mut result = StructuredCommandResult::raw_fallback(
                    ctx.title.clone(),
                    ctx.meta.clone(),
                    ctx.raw.clone(),
                );
                // 回落的**原因要可见**（不是静默失败）。
                result.warnings.push(reason);
                result
            }
        }
    }
}

impl Default for AdapterRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// 登记全部内置适配器。
fn register_builtins(registry: &mut AdapterRegistry) {
    // ── 第三层：专用语义解析 ──
    registry.register("docker-container-table", |stdout, ctx| {
        let (view, columns, rows) = super::domain::docker::container_table(stdout);
        AdapterOutcome::Structured {
            view,
            summary: super::domain::docker::container_summary(&rows),
            columns,
            rows,
            sections: Vec::new(),
            warnings: Vec::new(),
            json: None,
        }
    });
    registry.register("systemd-unit-table", |stdout, _ctx| {
        let (view, columns, rows) = super::domain::systemd::list_units_table(stdout);
        AdapterOutcome::Structured {
            view,
            summary: super::domain::systemd::list_units_summary(&rows),
            columns,
            rows,
            sections: Vec::new(),
            warnings: Vec::new(),
            json: None,
        }
    });
    registry.register("journal-log-viewer", |stdout, _ctx| {
        let rows = super::domain::systemd::journal_json_lines(stdout);
        let severe = super::generic::log::count_severe(&rows);
        AdapterOutcome::Structured {
            view: ViewType::Log,
            summary: vec![
                SummaryItem {
                    label: "日志".into(),
                    value: rows.len().to_string(),
                    tone: None,
                },
                SummaryItem {
                    label: "错误与警告".into(),
                    value: severe.to_string(),
                    tone: if severe > 0 {
                        Some("danger".into())
                    } else {
                        None
                    },
                },
            ],
            columns: Vec::new(),
            rows,
            sections: Vec::new(),
            warnings: Vec::new(),
            json: None,
        }
    });
    registry.register("nginx-config-tree", |stdout, _ctx| {
        let (view, columns, rows) = super::domain::nginx::site_table(stdout);
        AdapterOutcome::Structured {
            view,
            summary: super::domain::nginx::site_summary(&rows),
            columns,
            rows,
            sections: Vec::new(),
            warnings: Vec::new(),
            json: None,
        }
    });
    registry.register("process-table", |stdout, _ctx| {
        let rows = super::domain::linux::process_lines(stdout);
        AdapterOutcome::Structured {
            view: ViewType::Table,
            summary: vec![SummaryItem {
                label: "进程".into(),
                value: rows.len().to_string(),
                tone: None,
            }],
            columns: super::domain::linux::process_columns(),
            rows,
            sections: Vec::new(),
            warnings: Vec::new(),
            json: None,
        }
    });
    registry.register("disk-usage-table", |stdout, _ctx| {
        let rows = super::domain::linux::df_lines(stdout);
        AdapterOutcome::Structured {
            view: ViewType::Table,
            summary: vec![SummaryItem {
                label: "文件系统".into(),
                value: rows.len().to_string(),
                tone: None,
            }],
            columns: super::domain::linux::df_columns(),
            rows,
            sections: Vec::new(),
            warnings: Vec::new(),
            json: None,
        }
    });
    registry.register("port-listener-table", |stdout, _ctx| {
        let rows = super::domain::linux::ss_lines(stdout);
        AdapterOutcome::Structured {
            view: ViewType::Table,
            summary: vec![SummaryItem {
                label: "监听端口".into(),
                value: rows.len().to_string(),
                tone: None,
            }],
            columns: super::domain::linux::ss_columns(),
            rows,
            sections: Vec::new(),
            warnings: Vec::new(),
            json: None,
        }
    });

    // ── 第一层：机器可读格式 ──
    registry.register(
        "json-viewer",
        |stdout, _ctx| match super::generic::json::parse_json(stdout) {
            Some(super::generic::json::JsonShape::Single(value)) => AdapterOutcome::Structured {
                view: ViewType::Json,
                summary: Vec::new(),
                columns: Vec::new(),
                rows: Vec::new(),
                sections: Vec::new(),
                warnings: Vec::new(),
                json: Some(value),
            },
            Some(super::generic::json::JsonShape::Lines(lines)) => AdapterOutcome::Structured {
                view: ViewType::Json,
                summary: vec![SummaryItem {
                    label: "记录".into(),
                    value: lines.len().to_string(),
                    tone: None,
                }],
                columns: Vec::new(),
                rows: Vec::new(),
                sections: Vec::new(),
                warnings: Vec::new(),
                json: Some(serde_json::Value::Array(lines)),
            },
            None => AdapterOutcome::Fallback {
                reason: "输出不是合法 JSON，已按原始输出显示".into(),
            },
        },
    );

    // ── 第二层：通用文本解析 ──
    registry.register("generic-table", |stdout, _ctx| {
        // 通用表格没有列定义（不知道命令语义），用首行当表头是猜测 ——
        // 这里拒绝猜测，直接回落，避免"看起来对其实错"的表格。
        let _ = stdout;
        AdapterOutcome::Fallback {
            reason: "通用表格需要列定义（请在注册表里登记专用适配器）".into(),
        }
    });
    registry.register("key-value", |stdout, _ctx| {
        let rows = super::generic::key_value::parse_key_value_pairs(stdout);
        if rows.is_empty() {
            return AdapterOutcome::Fallback {
                reason: "没有解析出 key: value 行".into(),
            };
        }
        AdapterOutcome::Structured {
            view: ViewType::KeyValue,
            summary: vec![SummaryItem {
                label: "属性".into(),
                value: rows.len().to_string(),
                tone: None,
            }],
            columns: Vec::new(),
            rows,
            sections: Vec::new(),
            warnings: Vec::new(),
            json: None,
        }
    });
    registry.register("tree", |stdout, _ctx| {
        let rows = super::generic::tree::parse_tree_lines(stdout);
        if rows.is_empty() {
            return AdapterOutcome::Fallback {
                reason: "没有解析出树状结构".into(),
            };
        }
        AdapterOutcome::Structured {
            view: ViewType::Tree,
            summary: vec![SummaryItem {
                label: "节点".into(),
                value: rows.len().to_string(),
                tone: None,
            }],
            columns: Vec::new(),
            rows,
            sections: Vec::new(),
            warnings: Vec::new(),
            json: None,
        }
    });
    registry.register("log", |stdout, _ctx| {
        let rows = super::generic::log::parse_log_lines(stdout, None);
        let severe = super::generic::log::count_severe(&rows);
        AdapterOutcome::Structured {
            view: ViewType::Log,
            summary: vec![
                SummaryItem {
                    label: "行".into(),
                    value: rows.len().to_string(),
                    tone: None,
                },
                SummaryItem {
                    label: "错误与警告".into(),
                    value: severe.to_string(),
                    tone: if severe > 0 {
                        Some("danger".into())
                    } else {
                        None
                    },
                },
            ],
            columns: Vec::new(),
            rows,
            sections: Vec::new(),
            warnings: Vec::new(),
            json: None,
        }
    });
    registry.register("free-metrics", |stdout, _ctx| {
        let rows = super::generic::metrics::parse_free_metrics(stdout);
        if rows.is_empty() {
            return AdapterOutcome::Fallback {
                reason: "不是 free 的输出格式".into(),
            };
        }
        AdapterOutcome::Structured {
            view: ViewType::Metrics,
            summary: Vec::new(),
            columns: Vec::new(),
            rows,
            sections: Vec::new(),
            warnings: Vec::new(),
            json: None,
        }
    });
    registry.register("uptime-metrics", |stdout, _ctx| {
        let rows = super::generic::metrics::parse_uptime_metrics(stdout);
        if rows.is_empty() {
            return AdapterOutcome::Fallback {
                reason: "不是 uptime 的输出格式".into(),
            };
        }
        AdapterOutcome::Structured {
            view: ViewType::Metrics,
            summary: Vec::new(),
            columns: Vec::new(),
            rows,
            sections: Vec::new(),
            warnings: Vec::new(),
            json: None,
        }
    });
}
