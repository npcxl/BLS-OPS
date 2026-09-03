//! 输出适配引擎测试：通用解析器 + 专用解析器 + 注册表回落。
//!
//! 重点验证两件事：
//! 1. 各层解析出的结构符合统一协议（前端只认 view + 行契约）；
//! 2. **任何失败都回落 raw 且保留原始输出**，命令绝不因无 UI 而不可用。

use super::generic;
use super::model::{CommandMeta, RawOutput, ViewType};
use super::registry::{AdapterContext, AdapterRegistry};

fn ctx(title: &str, stdout: &str) -> AdapterContext {
    AdapterContext {
        title: title.to_string(),
        meta: CommandMeta {
            command: "test".into(),
            exit_code: Some(0),
            duration_ms: 1,
            truncated: false,
        },
        raw: RawOutput {
            stdout: stdout.to_string(),
            stderr: String::new(),
        },
    }
}

// ── 第二层：通用解析 ──

#[test]
fn key_value_parser_handles_colon_and_equals() {
    let rows = generic::key_value::parse_key_value_pairs(
        "Name: nginx\nMemoryLimit: infinity\nA = 1\nno-separator\n",
    );
    assert_eq!(rows.len(), 3, "认不出的行跳过");
    assert_eq!(rows[0]["key"], "Name");
    assert_eq!(rows[0]["value"], "nginx");
    assert_eq!(rows[2]["value"], "1");
}

#[test]
fn log_parser_strips_timestamp_and_detects_level() {
    let rows = generic::log::parse_log_lines(
        "2024-01-02 03:04:05 host ERROR disk full\nplain info line\n2024-01-02 03:04:06 WARN low memory\n",
        None,
    );
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0]["timestamp"], "2024-01-02 03:04:05");
    assert_eq!(rows[0]["level"], "3", "ERROR → priority 3");
    assert_eq!(rows[1]["timestamp"], "", "认不出时间戳就留空，不伪造");
    assert_eq!(rows[1]["level"], "6");
    assert_eq!(rows[2]["level"], "4", "WARN → priority 4");
    assert_eq!(generic::log::count_severe(&rows), 2);
}

#[test]
fn tree_parser_restores_depth() {
    let rows = generic::tree::parse_tree_lines(
        "/srv\n├── api\n│   └── node_modules\n└── web\n\n3 directories, 5 files\n",
    );
    assert_eq!(rows.len(), 4, "统计尾行不是节点");
    assert_eq!(rows[0]["label"], "/srv");
    assert_eq!(rows[0]["depth"], 0);
    assert_eq!(rows[1]["label"], "api");
    assert_eq!(rows[1]["depth"], 1);
    assert_eq!(rows[2]["depth"], 2, "嵌套越深 depth 越大");
}

#[test]
fn json_parser_handles_single_and_lines() {
    assert!(matches!(
        generic::json::parse_json(r#"{"a":1}"#),
        Some(generic::json::JsonShape::Single(_))
    ));
    let lines = generic::json::parse_json("{\"a\":1}\n{\"a\":2}\nbroken\n");
    match lines {
        Some(generic::json::JsonShape::Lines(values)) => assert_eq!(values.len(), 2, "坏行跳过"),
        other => panic!("应为 JSON Lines：{other:?}"),
    }
    assert!(generic::json::parse_json("not json at all").is_none());
}

#[test]
fn metrics_parser_reads_free_and_uptime() {
    let rows = generic::metrics::parse_free_metrics(
        "              total        used        free      shared  buff/cache   available\n\
         Mem:           7.8G       2.1G       3.2G       200M        2.5G        5.2G\n\
         Swap:          2.0G          0       2.0G\n",
    );
    assert_eq!(rows.len(), 6, "Mem + Swap 各 3 个指标");
    assert_eq!(rows[0]["label"], "内存 总量");
    assert_eq!(rows[0]["value"], "7.8G");

    let uptime = generic::metrics::parse_uptime_metrics(
        " 10:00:00 up 3 days,  2:00,  1 user,  load average: 0.10, 0.20, 0.30",
    );
    assert_eq!(uptime.len(), 3);
    assert_eq!(uptime[0]["value"], "3 days");
    assert_eq!(uptime[1]["value"], "0.10, 0.20, 0.30");
}

// ── 第三层：专用解析（迁移自旧 structure_output）──

#[test]
fn docker_ps_adapter_produces_table() {
    let stdout = "abc123def456|web|nginx:1.24|Up 2 hours|running|0.0.0.0:80->80/tcp|2 hours ago\n";
    let (view, columns, rows) = super::domain::docker::container_table(stdout);
    assert_eq!(view, ViewType::Table);
    assert!(!columns.is_empty());
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["name"], "web");
    assert_eq!(rows[0]["state"], "running");
    let summary = super::domain::docker::container_summary(&rows);
    assert_eq!(summary[1].value, "1", "1 个运行中");
}

#[test]
fn df_adapter_keeps_mount_point_with_spaces() {
    let stdout = "\
Filesystem Size Used Avail Use% Mounted on
/dev/sda1 50G 20G 30G 40% /
tmpfs 8G 0 8G 0% /dev/shm
";
    let rows = super::domain::linux::df_lines(stdout);
    assert_eq!(rows.len(), 2, "表头跳过");
    assert_eq!(rows[0]["use_percent"], "40%");
    assert_eq!(rows[0]["mounted_on"], "/");
    assert!(!super::domain::linux::df_columns().is_empty());
}

#[test]
fn ss_adapter_reads_only_listen_rows() {
    let stdout = concat!(
        "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process\n",
        "LISTEN 0      128    0.0.0.0:80         0.0.0.0:*          users:((\"nginx\",pid=912,fd=6))\n",
        "ESTAB  0      0      10.0.0.2:22        10.0.0.1:5000\n",
    );
    let rows = super::domain::linux::ss_lines(stdout);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["port"], "80");
    assert_eq!(rows[0]["process"], "nginx");
    assert_eq!(rows[0]["pid"], "912");
}

#[test]
fn journal_json_adapter_keeps_priority() {
    let stdout = concat!(
        r#"{"__REALTIME_TIMESTAMP":"1699000000123456","_SYSTEMD_UNIT":"nginx.service","PRIORITY":"6","MESSAGE":"Started Nginx."}"#,
        "\n",
        r#"{"__REALTIME_TIMESTAMP":"1699000001000000","_SYSTEMD_UNIT":"nginx.service","PRIORITY":"3","MESSAGE":"bind() failed"}"#,
        "\n",
        "not-json-line\n",
        r#"{"MESSAGE":"no-timestamp-line"}"#,
        "\n",
    );
    let rows = super::domain::systemd::journal_json_lines(stdout);
    assert_eq!(rows.len(), 3, "坏行跳过但保留缺字段的行");
    assert_eq!(rows[0]["level"], "6");
    assert_eq!(rows[1]["level"], "3");
    assert_eq!(rows[1]["message"], "bind() failed");
    assert_eq!(rows[2]["unit"], "—");
}

// ── 注册表与回落（核心契约）──

#[test]
fn registry_dispatches_known_adapters() {
    let registry = AdapterRegistry::builtins();
    let stdout = "LISTEN 0 128 0.0.0.0:80 0.0.0.0:* users:((\"nginx\",pid=912,fd=6))\n";
    let result = registry.adapt("port-listener-table", stdout, &ctx("监听端口", stdout));
    assert_eq!(result.view, ViewType::Table);
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.title, "监听端口");
}

#[test]
fn unknown_adapter_falls_back_to_raw_and_keeps_output() {
    let registry = AdapterRegistry::builtins();
    let stdout = "some raw text\n";
    let result = registry.adapt("made-up-adapter", stdout, &ctx("标题", stdout));
    assert_eq!(result.view, ViewType::Raw);
    assert_eq!(result.raw.stdout, stdout, "原始输出必须完整保留");
    assert_eq!(result.meta.command, "test");
}

#[test]
fn parse_failure_falls_back_with_visible_reason() {
    let registry = AdapterRegistry::builtins();
    let stdout = "not json at all";
    let result = registry.adapt("json-viewer", stdout, &ctx("JSON", stdout));
    assert_eq!(result.view, ViewType::Raw, "解析失败按 raw 渲染");
    assert_eq!(result.raw.stdout, stdout);
    assert!(
        result.warnings.iter().any(|w| w.contains("JSON")),
        "回落原因必须可见，不能静默：{:?}",
        result.warnings
    );
}

#[test]
fn docker_images_and_stats_adapters_produce_tables() {
    let registry = AdapterRegistry::builtins();

    let images = "abc123def456|nginx|1.24|187MB|3 weeks ago|nginx:1.24\n";
    let result = registry.adapt("docker-image-table", images, &ctx("镜像", images));
    assert_eq!(result.view, ViewType::Table);
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0]["repository"], "nginx");
    assert_eq!(result.rows[0]["tag"], "1.24");

    let stats = "web|0.15|1.2GiB / 3.8GiB|31.58|1.2kB / 0B|0B / 0B\n";
    let result = registry.adapt("docker-stats-table", stats, &ctx("资源", stats));
    assert_eq!(result.view, ViewType::Table);
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0]["name"], "web");
    assert_eq!(result.rows[0]["cpu_percent"], "0.15");
    // CPU/内存列带阈值着色配置（前端据此着色）。
    let cpu = result
        .columns
        .iter()
        .find(|c| c.key == "cpu_percent")
        .expect("CPU 列");
    assert!(cpu.numeric && cpu.thresholds.is_some());
}

#[test]
fn key_value_adapter_groups_sections() {
    let registry = AdapterRegistry::builtins();
    let stdout =
        "Server Version: 24.0.7\nStorage Driver: overlay2\n[Security Options]\nname: apparmor\n";
    let result = registry.adapt("key-value", stdout, &ctx("属性", stdout));
    assert_eq!(result.view, ViewType::KeyValue);
    // `[Security Options]` 分块 + 分块前的平铺属性 → 两个分区。
    assert_eq!(result.sections.len(), 2);
    let total: usize = result.sections.iter().map(|s| s.rows.len()).sum();
    assert_eq!(total, 3);
}

#[test]
fn lsblk_adapter_parses_devices() {
    let registry = AdapterRegistry::builtins();
    let stdout =
        "NAME MAJ:MIN RM SIZE RO TYPE MOUNTPOINT\nsda 8:0 0 50G 0 disk\nsda1 8:1 0 50G 0 part /\n";
    let result = registry.adapt("lsblk-table", stdout, &ctx("磁盘", stdout));
    assert_eq!(result.view, ViewType::Table);
    assert_eq!(result.rows.len(), 2, "表头跳过");
    assert_eq!(result.rows[0]["name"], "sda");
    assert_eq!(result.rows[1]["mountpoint"], "/");
}

#[test]
fn empty_output_is_a_valid_result_not_an_error() {
    // "没有容器" 是事实，不是错误 —— 不能回落成 raw。
    let registry = AdapterRegistry::builtins();
    let result = registry.adapt("docker-container-table", "", &ctx("容器", ""));
    assert_eq!(result.view, ViewType::Table, "空输出仍是有效表格");
    assert!(result.is_empty());
}
