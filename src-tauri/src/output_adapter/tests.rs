//! 输出适配引擎测试：通用解析器 + 专用解析器 + 注册表回落。
//!
//! 重点验证两件事：
//! 1. 各层解析出的结构符合统一协议（前端只认 view + 行契约）；
//! 2. **任何失败都回落 raw 且保留原始输出**，命令绝不因无 UI 而不可用。

use super::auto;
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
fn json_parser_handles_single_and_strict_lines() {
    assert!(matches!(
        generic::json::parse_json(r#"{"a":1}"#),
        Some(generic::json::JsonShape::Single(_))
    ));
    // 每行都是合法 JSON（允许结构空行）→ JSON Lines。
    let lines = generic::json::parse_json("{\"a\":1}\n\n{\"a\":2}\n");
    match lines {
        Some(generic::json::JsonShape::Lines(values)) => assert_eq!(values.len(), 2, "两行全保留"),
        other => panic!("应为 JSON Lines：{other:?}"),
    }
    // 有一行不是合法 JSON → 整体不识别，不允许“跳过坏行部分成功”。
    assert!(
        generic::json::parse_json("{\"a\":1}\n{\"a\":2}\nbroken\n").is_none(),
        "坏行必须让整体失败"
    );
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

// ── 统一自动识别（adapt_auto）──

/** 走完整链路（hint → auto → raw）拿结果。 */
fn auto_adapt(hint: Option<&str>, command: &str, stdout: &str) -> super::StructuredCommandResult {
    let ctx = AdapterContext {
        title: command.to_string(),
        meta: CommandMeta {
            command: command.to_string(),
            exit_code: Some(0),
            duration_ms: 42,
            truncated: false,
        },
        raw: RawOutput {
            stdout: stdout.to_string(),
            stderr: String::new(),
        },
    };
    super::adapt_auto(hint, stdout, &ctx)
}

#[test]
fn auto_detects_a_plain_table_without_any_specialized_adapter() {
    // 关键验收项：知识库里**没有**专用适配器的标准表格，也要自动生成表格。
    let stdout = concat!(
        "PID   COMMAND      CPU   MEM\n",
        "1     /sbin/init   0.0   0.1\n",
        "912   nginx        1.2   3.4\n",
        "1204  node         12.5  8.0\n",
    );
    let result = auto_adapt(None, "some-tool list", stdout);
    assert_eq!(
        result.view,
        ViewType::Table,
        "describe={}",
        auto::describe(stdout)
    );
    assert_eq!(result.rows.len(), 3);
    assert_eq!(result.rows[0]["command"], "/sbin/init");
    assert_eq!(result.rows[2]["cpu"], "12.5");
    // 表头当列名（ASCII 化 + 去重），不做语义猜测。
    let keys: Vec<&str> = result.columns.iter().map(|c| c.key.as_str()).collect();
    assert_eq!(keys, vec!["pid", "command", "cpu", "mem"]);
    // 原始输出永久留档。
    assert_eq!(result.raw.stdout, stdout);
}

#[test]
fn auto_detects_key_value_pairs() {
    let stdout = concat!(
        "Server Version: 24.0.7\n",
        "Storage Driver: overlay2\n",
        "Logging Driver: json-file\n",
    );
    let result = auto_adapt(None, "docker info", stdout);
    assert_eq!(
        result.view,
        ViewType::KeyValue,
        "{}",
        auto::describe(stdout)
    );
    let total: usize = result.sections.iter().map(|s| s.rows.len()).sum();
    assert_eq!(total, 3);
    assert_eq!(result.sections[0].rows[0]["key"], "Server Version");
}

#[test]
fn auto_detects_json_and_json_lines() {
    let single = r#"{"Name":"web","State":"running"}"#;
    let result = auto_adapt(None, "docker inspect web", single);
    assert_eq!(result.view, ViewType::Json);
    assert_eq!(
        result.json.as_ref().and_then(|v| v["Name"].as_str()),
        Some("web")
    );

    let lines = "{\"a\":1}\n{\"a\":2}\n{\"a\":3}\n";
    let result = auto_adapt(None, "journalctl -o json", lines);
    assert_eq!(result.view, ViewType::Json);
    assert_eq!(
        result
            .json
            .as_ref()
            .and_then(|v| v.as_array())
            .map(Vec::len),
        Some(3)
    );
}

#[test]
fn auto_detects_log_metrics_and_tree() {
    let log = concat!(
        "2024-01-02 10:00:01 INFO  started\n",
        "2024-01-02 10:00:02 ERROR disk full\n",
        "2024-01-02 10:00:03 WARN  low memory\n",
    );
    assert_eq!(auto::describe(log), "log");
    let result = auto_adapt(None, "journalctl -u nginx", log);
    assert_eq!(result.view, ViewType::Log);

    let uptime = " 10:00:00 up 3 days,  2:00,  1 user,  load average: 0.10, 0.20, 0.30\n";
    assert_eq!(auto::describe(uptime), "metrics");

    let tree = "/srv\n├── api\n│   └── node_modules\n└── web\n";
    assert_eq!(auto::describe(tree), "tree");
}

#[test]
fn plain_text_falls_back_to_text_or_raw() {
    // 短文本 → 识别成"纯文本"（一等公民，不是"解析失败"）。
    let short = "v1.24.7\n";
    let result = auto_adapt(None, "cat VERSION", short);
    assert_eq!(result.view, ViewType::Text, "{}", auto::describe(short));

    // 超长无结构文本 → raw（交给原始输出视图翻页）。
    let huge = "x".repeat(9_000);
    assert_eq!(auto::describe(&huge), "raw");

    // 任何情况下原始输出都不丢。
    assert_eq!(auto_adapt(None, "x", &huge).raw.stdout, huge);
}

#[test]
fn generic_table_is_conservative_never_invents_tables() {
    let detect = generic::table::detect_table;

    // 1. 只有一行 → 不是表格。
    assert!(detect("NAME   STATE\n").is_none());
    // 2. 列数不稳定 → 不是表格。
    assert!(detect("A  B  C\nd  e\nf  g  h\n").is_none());
    // 3. 列没对齐（散文） → 不是表格。
    assert!(detect("hello world foo\nbar baz qux something\n").is_none());
    // 4. 首行是时间戳/数字 → 不像表头。
    assert!(detect("2024-01-02 10:00:00\n2024-01-02 10:00:01\n").is_none());
    // 5. 两行散文（即便碰巧对齐） → 不是表格。
    assert!(detect("hello world\nfoo    bar\n").is_none());
    // 6. 空输出 → 不是表格。
    assert!(detect("").is_none() && detect("\n\n").is_none());

    // 正向：稳定表格（连续空格分列）与 Tab 分列都要认出来。
    let spaced = "PID   COMM       CPU\n1     systemd    0.0\n912   nginx      1.2\n";
    let table = detect(spaced).expect("连续空格表格");
    assert_eq!(table.header, vec!["PID", "COMM", "CPU"]);
    assert_eq!(table.rows.len(), 2);

    let tabbed = "PID\tCOMM\tCPU\n1\tsystemd\t0.0\n912\tnginx\t1.2\n";
    let table = detect(tabbed).expect("Tab 分列表格");
    assert_eq!(table.rows[1], vec!["912", "nginx", "1.2"]);
}

#[test]
fn auto_columns_mark_numeric_columns_only() {
    let stdout = concat!(
        "NAME        CPU     MEM\n",
        "web         1.20    512Mi\n",
        "api         0.30    1.2Gi\n",
        "worker-01   12.5    256Mi\n",
    );
    let result = auto_adapt(None, "tool stats", stdout);
    let numeric: Vec<&str> = result
        .columns
        .iter()
        .filter(|c| c.numeric)
        .map(|c| c.key.as_str())
        .collect();
    assert_eq!(
        numeric,
        vec!["cpu", "mem"],
        "数值列自动标 numeric（右对齐）"
    );
}

#[test]
fn shell_operators_disable_the_specialized_hint() {
    assert!(auto::has_shell_operator("df -h | grep /dev"));
    assert!(auto::has_shell_operator("ls > out.txt"));
    assert!(auto::has_shell_operator("make && make install"));
    assert!(auto::has_shell_operator("cat a; cat b"));
    // 引号里的符号不是操作符（`awk` 的字段引用）。
    assert!(!auto::has_shell_operator("awk '{print $1}'"));
    assert!(!auto::has_shell_operator(
        "docker ps --format \"{{.Names}}\""
    ));
    assert!(!auto::has_shell_operator("df -h"));
}

#[test]
fn specialized_adapter_wins_when_it_recognizes_the_output() {
    // 专用适配器认得出来 → 用它（比通用猜更准）。
    let stdout = "LISTEN 0 128 0.0.0.0:80 0.0.0.0:* users:((\"nginx\",pid=912,fd=6))\n";
    let result = auto_adapt(Some("port-listener-table"), "ss -tulnp", stdout);
    assert_eq!(result.view, ViewType::Table);
    assert_eq!(result.rows[0]["process"], "nginx");
    assert!(result.warnings.is_empty(), "专用适配器命中时不该有提示");
}

#[test]
fn specialized_adapter_failure_continues_into_auto() {
    // 专用适配器（`json-viewer`）拿到的是一张标准表格 → 认不出 → **继续 auto**，
    // 最终按真实形态（表格）渲染，而不是直接 raw。
    let stdout = concat!(
        "PID   COMMAND      CPU   MEM\n",
        "1     /sbin/init   0.0   0.1\n",
        "912   nginx        1.2   3.4\n",
        "1204  node         12.5  8.0\n",
    );
    let result = auto_adapt(Some("json-viewer"), "some-tool list", stdout);
    assert_eq!(result.view, ViewType::Table, "失败后必须继续自动识别");
    assert_eq!(result.rows[1]["command"], "nginx");
    assert!(
        result.warnings.iter().any(|w| w.contains("自动识别")),
        "回落原因必须可见：{:?}",
        result.warnings
    );
}

#[test]
fn header_with_one_extra_column_is_still_a_table() {
    // `df -h` 的 `Mounted on`、`lsblk` 的空白 `MOUNTPOINT`：表头比数据多一列。
    let stdout = concat!(
        "Filesystem      Size  Used Avail Use% Mounted on\n",
        "/dev/sda1       458G  100G  335G  23% /\n",
        "tmpfs            16G    0B   16G   0% /dev/shm\n",
    );
    let table = generic::table::detect_table(stdout).expect("表头多一列也要认出来");
    assert_eq!(table.header.last().map(String::as_str), Some("Mounted on"));
    assert_eq!(table.rows[0][5], "/");
    assert_eq!(table.rows[1][5], "/dev/shm");
}
