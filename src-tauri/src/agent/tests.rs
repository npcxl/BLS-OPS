use serde_json::json;

use super::protocol::{
    looks_like_tool_call, parse_tool_calls, redact, strip_tool_calls, tail_truncate, Lang,
    StepCategory, ToolRisk, MODEL_OUTPUT_LIMIT,
};
use super::tools::{
    absolute_path, classify_shell, describe_impact, describe_impact_lang, has_sudo, plan_tool,
    plan_tool_for_locale, plan_write_backup, shell_may_write, shell_write_targets, strip_markers,
    BackupPolicy, BACKUP_MARKER, PWD_MARKER,
};

fn has_chinese(text: &str) -> bool {
    text.chars()
        .any(|ch| ('\u{4e00}'..='\u{9fa5}').contains(&ch))
}

/// 模型不按我们的 `<tool>` 写、而用它自己的调用标记时，也必须识别出来。
///
/// 这是线上真实遇到过的形态：deepseek 系模型返回
/// `<|DSL|calls><|DSL|invoke name="run_shell">{"command":"pwd"}`，
/// 之前整段被当普通回答显示，卡片显示"完成 0 步"。
#[test]
fn recognises_the_models_own_tool_call_markup() {
    let text =
        "<|DSL|calls><|DSL|invoke name=\"run_shell\">\n{\"command\":\"pwd && ls -la /root\"}";
    let calls = parse_tool_calls(text);
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].name, "run_shell");
    assert_eq!(calls[0].body, "{\"command\":\"pwd && ls -la /root\"}");

    // 展示给用户时这些标记必须消失，否则气泡里就是一堆 DSL。
    assert_eq!(strip_tool_calls(text), "");
    assert!(looks_like_tool_call(text));
    assert!(!looks_like_tool_call("这台机器磁盘用了 67%。"));
}

/// `cd ... && cp 备份 && sed -i 目标`：要跟踪 `cd`、跳过备份副本，只留真实目标。
#[test]
fn shell_write_targets_follow_cd_and_skip_backup_copies() {
    let targets = shell_write_targets(
        "cd /opt/bls-ops/dist && cp -a index.html index.html.bak-1795145023 && \
         sed -i 's|<div id=\"root\">|<div id=\"root\"><p style=\"padding:12px\">hi</p>|' index.html",
        "/root",
    );
    assert_eq!(targets, vec!["/opt/bls-ops/dist/index.html"]);
}

/// 显式 `cd` 之后的相对路径，按 `cd` 的目标解析。
#[test]
fn shell_write_targets_resolve_relative_after_cd() {
    let targets = shell_write_targets("cd /srv/app && sed -i 's|a|b|' ./conf/app.conf", "/root");
    assert_eq!(targets, vec!["/srv/app/conf/app.conf"]);
}

/// 命令先 `cp` 备份、后面是脚本时，从 `cp` 的**源文件**拿到真实目标。
#[test]
fn shell_write_targets_uses_cp_backup_source() {
    let targets = shell_write_targets(
        "cd /opt/app && cp -a site.conf site.conf.bak-1 && ./patch.sh",
        "/root",
    );
    assert_eq!(targets, vec!["/opt/app/site.conf"]);
}

#[test]
fn read_commands_run_without_confirmation() {
    for command in [
        "uname -a; df -h; docker ps",
        "ls -la /var/www",
        "cat /etc/nginx/nginx.conf",
        "ps aux | grep nginx",
        "ss -ltnp",
        "systemctl status nginx.service",
        "git status",
        "curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1/",
        "test -e /var/www/app/index.html && echo yes",
    ] {
        assert_eq!(
            classify_shell(command),
            ToolRisk::Read,
            "应当是只读：{command}"
        );
    }
}

/// `cd` 只切工作目录，不该把只读查询拖进写入分支。
#[test]
fn cd_prefix_is_not_a_write() {
    for command in [
        "cd /opt/app && docker ps",
        "cd /var/log && tail -n 50 syslog",
        "cd /root; ps aux",
    ] {
        assert_eq!(
            classify_shell(command),
            ToolRisk::Read,
            "应当是只读：{command}"
        );
    }
}

#[test]
fn write_commands_require_a_confirmation() {
    for command in [
        "rm -f /tmp/a.txt",
        "mv /var/www/a /var/www/b",
        "cp -a /a /b",
        "echo hi > /tmp/x",
        "docker compose up -d",
        "docker compose restart",
        "nginx -s reload",
        "systemctl restart nginx.service",
        "sed -i 's/a/b/' /var/www/app/index.html",
        "find /tmp -name '*.log' -delete",
        "git pull",
        "./deploy.sh --prod",
    ] {
        assert!(
            classify_shell(command).needs_approval(),
            "应当需要确认：{command}"
        );
    }
}

#[test]
fn dangerous_commands_are_flagged() {
    for command in [
        "rm -rf /",
        "mkfs.ext4 /dev/sdb1",
        "iptables -F",
        "shutdown -h now",
        "cp /tmp/passwd /etc/passwd",
        "dd if=/dev/zero of=/dev/sda",
    ] {
        assert_eq!(
            classify_shell(command),
            ToolRisk::Danger,
            "应当判定为危险：{command}"
        );
    }
}

#[test]
fn reading_secrets_from_shell_requires_confirmation() {
    for command in [
        "cat /etc/shadow",
        "cat /root/.ssh/id_rsa",
        "cat /srv/app/.env",
    ] {
        assert_eq!(
            classify_shell(command),
            ToolRisk::Write,
            "读敏感文件也要确认：{command}"
        );
    }
    // 服务账号密码只是字符串参数，不涉及敏感文件。
    assert_eq!(classify_shell("grep user /var/log/app.log"), ToolRisk::Read);
}

#[test]
fn interpreter_escapes_are_never_treated_as_read() {
    // 首词都是只读命令，但能在内部执行任意命令。
    for command in [
        "awk 'BEGIN{system(\"rm -rf /tmp/x\")}'",
        "ls $(rm -rf /tmp/x)",
        "find . -name '*.log' -exec rm {} \\;",
        "grep root /etc/passwd | sh",
        "eval 'systemctl stop nginx'",
    ] {
        assert!(
            classify_shell(command) != ToolRisk::Read,
            "这条命令不能自动执行：{command}"
        );
    }
    /*
     * 命令替换**逐层检查真正执行的命令**（用户裁决 2026-11-25）：
     * 里面是纯只读就放行 —— `` cat `id` `` 只打印 `id` 的输出，什么都没改；
     * 以前一律按"执行了任意命令"拦下，等于让用户为一次彻底只读的查询点确认。
     */
    for command in ["cat `id`", "echo \"$(sha256sum /x)\"", "cat <(docker ps)"] {
        assert_eq!(
            classify_shell(command),
            ToolRisk::Read,
            "纯只读的替换不该被拦：{command}"
        );
    }
    // 正常的只读查询不受影响。
    assert_eq!(
        classify_shell("awk '{print $1}' /var/log/app.log"),
        ToolRisk::Read
    );
    assert_eq!(
        classify_shell("find /var/www -name '*.log'"),
        ToolRisk::Read
    );
}

#[test]
fn http_clients_and_databases_are_judged_by_arguments() {
    // 只读用法：GET / HEAD，输出到终端或黑洞。
    for command in [
        "curl https://example.com/health",
        "curl -sS -X GET http://127.0.0.1:8080/api",
        "curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1/",
        "curl -I https://example.com",
    ] {
        assert_eq!(
            classify_shell(command),
            ToolRisk::Read,
            "应当是只读：{command}"
        );
    }
    // 写用法：改方法、带请求体、上传、写文件。
    for command in [
        "curl -X POST http://127.0.0.1:8080/api -d '{\"a\":1}'",
        "curl --request PUT https://example.com/item/1",
        "curl -F file=@/tmp/a.png https://example.com/upload",
        "curl -o /tmp/out.html https://example.com",
        "curl --data-raw 'x=1' https://example.com",
    ] {
        assert_eq!(
            classify_shell(command),
            ToolRisk::Write,
            "写请求必须确认：{command}"
        );
    }

    // redis：只读子命令白名单，其余（含交互式）都要确认。
    for command in [
        "redis-cli ping",
        "redis-cli -n 0 get foo",
        "redis-cli info memory",
    ] {
        assert_eq!(
            classify_shell(command),
            ToolRisk::Read,
            "应当是只读：{command}"
        );
    }
    for command in [
        "redis-cli FLUSHALL",
        "redis-cli -n 0 set foo bar",
        "redis-cli del foo",
        "redis-cli config set maxmemory 0",
        "redis-cli",
    ] {
        assert_eq!(
            classify_shell(command),
            ToolRisk::Write,
            "写命令必须确认：{command}"
        );
    }

    // SQL：查询只读，写语句要确认。
    assert_eq!(classify_shell("mysql -e 'select 1'"), ToolRisk::Read);
    assert_eq!(
        classify_shell("mysql -e 'delete from orders where id=1'"),
        ToolRisk::Write
    );
    assert_eq!(classify_shell("psql -c 'select now()'"), ToolRisk::Read);
    assert_eq!(classify_shell("psql -c 'drop table t'"), ToolRisk::Write);
}

#[test]
fn crlf_is_normalized_before_execution() {
    let planned = plan_tool(
        "run_shell",
        &json!({ "command": "uname -a\r\ndf -h\r\n" }),
        "/root",
        1,
    )
    .unwrap();
    assert!(!planned.command.contains('\r'), "{}", planned.command);
    assert!(planned.command.contains("uname -a\ndf -h"));
}

#[test]
fn output_redirection_to_dev_null_is_not_a_write() {
    assert_eq!(
        classify_shell("ls -la /var/www 2>/dev/null"),
        ToolRisk::Read
    );
    assert_eq!(classify_shell("my-script 2>&1"), ToolRisk::Write);
}

/// 只"看"的命令不进文件变更：`nl` / `sed -n` / `curl -D -` 都是排查配置的常规手法。
#[test]
fn read_only_inspection_does_not_leave_a_change_record() {
    for command in [
        "echo '=== 5. 宿主配置 ==='; nl -ba /etc/nginx/conf.d/ehs-web.conf | sed -n '30,80p'; ls -l /etc/nginx/conf.d/*.bls-bak* 2>/dev/null",
        "curl -s -o /dev/null -D - -m 10 https://glsz.sz369zhan.com/ehs-api/ 2>&1 | head -n 12",
        "F=/etc/nginx/conf.d/ehs-web.conf; echo \"$(stat -c '%s' \"$F\")\"; nl -ba $F | sed -n '1,30p'",
    ] {
        assert!(!shell_may_write(command), "不该记变更：{command}");
    }
    for command in [
        "sed -i 's/a/b/' /etc/nginx/nginx.conf",
        "cat > /etc/nginx/conf.d/x.conf <<'EOF'",
        "rm -f /tmp/x",
    ] {
        assert!(shell_may_write(command), "应当记变更：{command}");
    }
}

#[test]
fn inspection_commands_with_plain_redirects_stay_read() {
    // `nl` 之前不在只读名单里，整条命令被当成写操作。
    assert_eq!(
        classify_shell("nl -ba /etc/nginx/conf.d/ehs-web.conf | sed -n '30,80p'"),
        ToolRisk::Read
    );
    // `curl -D -` 是把响应头打到 stdout，没有写文件。
    assert_eq!(
        classify_shell("curl -s -o /dev/null -D - -m 10 https://example.com/ 2>&1 | head -n 12"),
        ToolRisk::Read
    );
}

#[test]
fn pipes_and_fd_redirects_do_not_turn_reads_into_writes() {
    // 截图里的组合：`ls` / `docker ps` / `ss` 拼在一起，带管道和 `2>&1`。
    for command in [
        "ls -la /var/log/nginx | head -20",
        "docker ps 2>&1",
        "docker ps 2>&1 | grep nginx",
        "docker ps --format '{{.Names}}\t{{.Ports}}' 2>&1 | sort",
        "ss -tlnp 2>&1 | head -5",
        "systemctl status nginx --no-pager 2>&1 | head -5",
        // 管道符 / 重定向符出现在引号里是普通字符。
        "grep \"error|warn\" /var/log/nginx/error.log",
        "printf '%s\\n' \"a > b\"",
        // `&&` 串联的只读命令。
        "ls /var/www && docker ps 2>&1 && ss -ltnp",
    ] {
        assert_eq!(
            classify_shell(command),
            ToolRisk::Read,
            "应当是只读：{command}"
        );
    }
}

#[test]
fn docker_exec_is_judged_by_the_command_it_runs() {
    /*
     * 用户的原始反馈：这条只是把容器里的 nginx 配置 grep 出来看，却被标成
     * 「危险 · 修改系统配置（/etc 下的文件）」，每次都要点「允许本次」。
     * `docker exec` 本身不改任何东西，改不改看容器里跑的那条命令。
     */
    assert_eq!(
        classify_shell(
            "docker exec bls-edge-nginx sh -c 'grep -rhE \"server_name|listen|proxy_pass|root\" /etc/nginx/conf.d /etc/nginx/nginx.conf 2>/dev/null' | head -n 80"
        ),
        ToolRisk::Read
    );

    for command in [
        "docker exec web cat /etc/nginx/nginx.conf",
        "docker exec -i web ls -la /var/www",
        "docker exec -u root web tail -n 20 /var/log/nginx/error.log",
        "docker exec web sh -c 'ps aux | head -5'",
        "docker exec --env FOO=1 web grep -c error /var/log/app.log",
    ] {
        assert_eq!(
            classify_shell(command),
            ToolRisk::Read,
            "容器里的只读命令：{command}"
        );
    }

    // 容器里真的在改东西：照样按写的档位算（写 /etc 仍是危险）。
    // `/etc` 不再一律升级危险：明确的应用配置修改按写入处理，仍要确认。
    assert_eq!(
        classify_shell("docker exec web sh -c 'sed -i s/a/b/ /etc/nginx/nginx.conf'"),
        ToolRisk::Write
    );
    assert_eq!(
        classify_shell("docker exec web rm -rf /var/www/cache"),
        ToolRisk::Write
    );
    // 只给了 shell（没给命令）：等于"不知道要做什么"，必须确认。
    assert_eq!(classify_shell("docker exec -it web bash"), ToolRisk::Write);
    assert_eq!(
        classify_shell("docker exec -it web sh -c 'rm -rf /data'"),
        ToolRisk::Write
    );
}

#[test]
fn a_stray_quote_before_the_verb_does_not_promote_a_read() {
    /*
     * `sh -c '…'` 里再嵌一层 `sed 's/…/'`：单引号提前闭合，切段后段首残留一个
     * 引号（`'grep`）。以前只读白名单按字面比较，`'grep` 匹配不上就成了"不认识的
     * 写操作"，再叠 /etc 规则直接升到危险档 —— 用户看到的就是「什么都标红」。
     */
    assert_eq!(
        classify_shell(
            "docker exec bls-edge-nginx sh -c 'grep -rHE \"server_name|listen|proxy_pass|root\" /etc/nginx/nginx.conf 2>/dev/null 2>&1 | sed 's/[:space:]//' | head -n 80'"
        ),
        ToolRisk::Read
    );
    // 段首带引号的动词按原动词判。
    assert_eq!(
        classify_shell("'grep -n foo /etc/nginx/nginx.conf'"),
        ToolRisk::Read
    );
    // 段首带引号的 sudo 仍然是提权。
    assert_eq!(classify_shell("'sudo rm -rf /var/www'"), ToolRisk::Danger);
}

#[test]
fn compose_options_do_not_hide_a_writing_subcommand() {
    /*
     * `docker compose -f x.yml up -d` 是最常见的写法，但固定串匹配会被中间的
     * `-f …` 绕过去，整条落进只读白名单 —— 这是漏判，比误报危险。
     */
    for command in [
        "docker compose -f docker-compose.yml up -d",
        "docker compose --project-name bls -f x.yml restart",
        "docker compose -p bls stop",
    ] {
        assert!(
            classify_shell(command).needs_approval(),
            "带选项的写子命令仍要确认：{command}"
        );
    }
    for command in [
        "docker compose ps",
        "docker compose -f x.yml logs --tail 50",
        "docker compose config",
    ] {
        assert_eq!(
            classify_shell(command),
            ToolRisk::Read,
            "只读子命令：{command}"
        );
    }
}

#[test]
fn unclear_punctuation_does_not_claim_etc_is_written() {
    // 拆不开的命令仍要确认，但不能给出与事实相反的"修改系统配置"。
    let impact = describe_impact(
        "docker exec web sh -c 'grep a /etc/nginx/x 2>&1 | sed 's/a/b/'",
        ToolRisk::Write,
    );
    let impact = impact.unwrap_or_default();
    assert!(!impact.contains("修改系统配置"), "{impact}");
}

#[test]
fn shell_loops_are_judged_by_the_commands_inside() {
    /*
     * 用户的原始反馈：这条只是挨个域名 curl 一下看状态码，却被标成
     * 「执行 for · 影响未知」，还得手点「允许本次」。
     */
    assert_eq!(
        classify_shell(
            "for h in ops.xlcig.cn admin.xlcig.cn api.xlcig.cn; do printf \"%-18s \" \"$h\"; curl -sk -o /dev/null -w \"code=%{http_code} size=%{size_download}\\n\" --max-time 5 -H \"Host: $h\" https://127.0.0.1:8080; curl -s -o /dev/null -w \"code=%{http_code} size=%{size_download}\\n\" --max-time 5 -H \"Host: ops.xlcig.cn\" http://127.0.0.1:8088/; done"
        ),
        ToolRisk::Read
    );

    for command in [
        "for f in /var/log/nginx/*.log; do echo $f; done",
        "if [ -f /etc/nginx/nginx.conf ]; then echo ok; fi",
        "while read line; do echo \"$line\"; done < /tmp/list.txt",
        "! grep -q error /var/log/app.log",
        "{ uptime; df -h; }",
    ] {
        assert_eq!(
            classify_shell(command),
            ToolRisk::Read,
            "循环 / 条件 / 分组里的只读命令：{command}"
        );
    }

    // 循环体里真的有写：照样按写算（路径在循环头里，所以是"写"而不是"危险"，
    // 一样需要确认）。
    assert_eq!(
        classify_shell("for f in /var/www/*.log; do rm -f $f; done"),
        ToolRisk::Write
    );
    assert_eq!(
        classify_shell("for f in /etc/nginx/conf.d/*.conf; do sed -i s/a/b/ $f; done"),
        ToolRisk::Write
    );
    // 明确的 Nginx 配置修改按写入处理；只有 SSH / 防火墙等关键配置才危险。
    assert_eq!(
        classify_shell("sed -i s/a/b/ /etc/nginx/nginx.conf"),
        ToolRisk::Write
    );
    assert_eq!(
        classify_shell("sed -i s/a/b/ /etc/ssh/sshd_config"),
        ToolRisk::Danger
    );
    // 循环头里藏命令替换：不能因为"只是 for 头"就放过去。
    assert_eq!(
        classify_shell("for x in $(rm -rf /tmp/x); do echo $x; done"),
        ToolRisk::Write
    );
    // 输出重定向仍然算写。
    assert_eq!(
        classify_shell("for f in *.log; do echo $f >> /tmp/all.log; done"),
        ToolRisk::Write
    );
}

#[test]
fn impact_only_mentions_etc_when_it_is_really_written() {
    // 只读：连确认都不需要，更没有"修改系统配置"。
    assert!(describe_impact("grep -rn foo /etc/nginx/nginx.conf", ToolRisk::Read).is_none());
    // 读 /etc、写 /tmp：提到 /etc 只是参数，不能说成"修改系统配置"。
    let impact = describe_impact(
        "cp /etc/nginx/nginx.conf /tmp/nginx.conf.bak",
        ToolRisk::Write,
    )
    .expect("写文件要给影响说明");
    assert!(!impact.contains("/etc"), "{impact}");
    // 真的写 /etc：说清楚。
    let impact = describe_impact("sed -i 's/a/b/' /etc/nginx/nginx.conf", ToolRisk::Danger)
        .expect("危险操作要给影响说明");
    assert!(impact.contains("/etc"), "{impact}");
    let impact = describe_impact("echo 'x' > /etc/profile.d/x.sh", ToolRisk::Danger)
        .expect("危险操作要给影响说明");
    assert!(impact.contains("/etc"), "{impact}");
}

#[test]
fn real_redirections_and_unbalanced_quotes_need_approval() {
    for command in [
        "ls -la /var/www > /tmp/list.txt",
        "echo hi >> /var/log/app.log",
        "nginx -T 2> /tmp/nginx.err",
        "cmd &> /tmp/out.log",
        "printf x >| /tmp/forced.log",
    ] {
        assert!(
            classify_shell(command).needs_approval(),
            "写真实文件必须确认：{command}"
        );
    }
    // 引号没闭合 = 解析不确定：宁可多问一次，也不能放行。
    assert!(classify_shell("grep 'error /var/log/app.log").needs_approval());
}

/// 英文界面下，确认卡上的摘要 / 影响必须是英文：这些字符串由后端
/// 直接序列化给界面，前端 `t()` 查不到就会原样显示中文。
#[test]
fn english_locale_plans_have_english_summary_and_impact() {
    let planned = plan_tool_for_locale(
        "run_shell",
        &json!({ "command": "systemctl restart nginx" }),
        "/root",
        1,
        &BackupPolicy::default(),
        Lang::En,
    )
    .expect("plan");
    let summary = planned.summary.expect("summary");
    assert_eq!(summary, "Restart service nginx");
    assert!(!has_chinese(&summary));

    let impact = describe_impact_lang(
        "unzip -o dist.zip -d /var/www && systemctl restart nginx",
        ToolRisk::Write,
        Lang::En,
    )
    .expect("impact");
    assert!(impact.to_ascii_lowercase().contains("extract"));
    assert!(!has_chinese(&impact));

    let write = plan_tool_for_locale(
        "write_file",
        &json!({ "path": "/etc/nginx/conf.d/site.conf", "content": "x" }),
        "/root",
        1,
        &BackupPolicy::default(),
        Lang::En,
    )
    .expect("write plan");
    assert!(!has_chinese(&write.summary.unwrap_or_default()));
    assert!(!has_chinese(&write.impact.unwrap_or_default()));
    assert!(!has_chinese(&write.display));
}

/// 英文界面的工具清单不能夹中文描述：模型会顺着描述的语言写计划与解释。
#[test]
fn english_tool_schemas_are_fully_english() {
    let schemas = super::tools::tool_schemas_lang(true, Lang::En);
    let text = schemas.to_string();
    assert!(!has_chinese(&text), "{text}");
    assert!(text.contains("Submit or update this turn's execution plan"));
    let zh = super::tools::tool_schemas_lang(true, Lang::Zh).to_string();
    assert!(has_chinese(&zh));
}

#[test]
fn approval_exposes_readable_command_summary_and_impact() {
    let planned = plan_tool(
        "run_shell",
        &json!({ "command": "systemctl restart nginx" }),
        "/root",
        1,
    )
    .unwrap();
    // 首屏给的是模型写的那条，不是带 cd 包装 / 退出码回传的脚本。
    assert_eq!(planned.display, "systemctl restart nginx");
    assert!(planned.command.contains("__bls_rc"));
    let summary = planned.summary.clone().unwrap_or_default();
    assert!(summary.contains("nginx"), "摘要要指出动了谁：{summary}");
    // 影响说明只讲后果，不复制命令。
    let impact = planned.impact.clone().unwrap_or_default();
    assert!(
        !impact.contains("systemctl restart nginx"),
        "影响不要复制命令：{impact}"
    );
}

#[test]
fn nginx_reload_has_a_concrete_impact() {
    let planned = plan_tool(
        "run_shell",
        &json!({ "command": "nginx -t && nginx -s reload" }),
        "/root",
        1,
    )
    .unwrap();
    // 校验 + 重载是写操作（会重载服务），但影响说得清，不能落到"未知"。
    assert!(planned.call.risk.needs_approval());
    let impact = planned.impact.clone().unwrap_or_default();
    assert!(impact.contains("Nginx"), "{impact}");
    assert!(!impact.contains("未知"), "{impact}");
    assert_eq!(planned.summary.clone().unwrap_or_default(), "重载 Nginx");
}

#[test]
fn writes_argue_their_own_summary_from_the_target_file() {
    let planned = plan_tool(
        "write_file",
        &json!({ "path": "/etc/nginx/conf.d/ops-access-log.conf", "content": "log_format" }),
        "/root",
        1,
    )
    .unwrap();
    let summary = planned.summary.clone().unwrap_or_default();
    assert!(summary.contains("Nginx"), "按文件用途说人话：{summary}");
    assert_eq!(
        planned.display,
        "写入 /etc/nginx/conf.d/ops-access-log.conf"
    );
    assert!(planned.backup_path.is_some());
    assert!(planned.rollback.is_some());
}

#[test]
fn sudo_is_detected_everywhere() {
    assert!(has_sudo("sudo ls /root"));
    assert!(has_sudo("ls /root; sudo cat /etc/shadow"));
    assert!(!has_sudo("ls /root"));
    // 参数里出现 sudo 这个词不算（避免误报）。
    assert!(!has_sudo("grep sudo /var/log/auth.log"));
}

#[test]
fn secrets_are_masked_per_line() {
    let raw = [
        "DB_PASSWORD=hunter2 host=10.0.0.1",
        "{\"api_key\": \"sk-live-123\", \"name\": \"demo\"}",
        "Authorization: Bearer abc.def.ghi",
        "mysql --password swordfish -h db",
        "keyboard: wired",
        "tokenizer=bert",
    ]
    .join("\n");
    let clean = redact(&raw);
    assert!(!clean.contains("hunter2"), "{clean}");
    assert!(clean.contains("host=10.0.0.1"), "{clean}");
    assert!(!clean.contains("sk-live-123"), "{clean}");
    assert!(!clean.contains("abc.def.ghi"), "{clean}");
    assert!(!clean.contains("swordfish"), "{clean}");
    // 不含赋值 / 不是敏感键的词不能被误伤。
    assert!(clean.contains("keyboard: wired"), "{clean}");
    assert!(
        clean.contains("tokenizer=bert") || clean.contains("tokenizer=***"),
        "{clean}"
    );
}

#[test]
fn tail_truncation_keeps_the_end_and_respects_utf8() {
    let text = "前".repeat(40_000);
    let (cut, truncated) = tail_truncate(&text, MODEL_OUTPUT_LIMIT);
    assert!(truncated);
    assert!(cut.len() <= MODEL_OUTPUT_LIMIT + 64);
    assert!(cut.starts_with("…（前 "));
    assert!(cut.ends_with('前'));
    let (short, unchanged) = tail_truncate("ok", 10);
    assert_eq!(short, "ok");
    assert!(!unchanged);
}

#[test]
fn parses_every_tool_block_in_one_reply() {
    let reply = r#"先看一下机器。
<tool name="run_shell">{"command":"uname -a"}</tool>
<tool name="write_file">{"path":"/var/www/app/index.html","content":"<h1>{\"a\":1}</h1>"}</tool>
"#;
    let calls = parse_tool_calls(reply);
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].name, "run_shell");
    assert_eq!(calls[0].body, r#"{"command":"uname -a"}"#);
    assert!(calls[1].body.contains("<h1>"));
    let body = strip_tool_calls(reply);
    assert_eq!(body, "先看一下机器。");
}

#[test]
fn unclosed_tool_block_does_not_echo_arguments_to_the_user() {
    let reply = "看目录\n<tool name=\"list_dir\">{\"path\":\"/var/www\"}";
    assert_eq!(strip_tool_calls(reply), "看目录");
    assert_eq!(parse_tool_calls(reply).len(), 1);
}

#[test]
fn backup_path_follows_the_shared_naming_rule() {
    let backup = plan_write_backup("/var/www/app/index.html", 20260102030405);
    assert_eq!(
        backup.path,
        "/var/www/app/index.html.bls-bak.20260102030405"
    );
    assert_eq!(
        backup.command,
        "cp -a '/var/www/app/index.html' '/var/www/app/index.html.bls-bak.20260102030405'"
    );
    assert_eq!(
        backup.rollback,
        "cp -a '/var/www/app/index.html.bls-bak.20260102030405' '/var/www/app/index.html'"
    );
}

#[test]
fn run_shell_is_wrapped_with_cwd_and_pwd_marker() {
    let planned = plan_tool("run_shell", &json!({ "command": "ls -la" }), "/var/www", 1).unwrap();
    assert!(
        planned.command.contains("cd '/var/www'"),
        "{}",
        planned.command
    );
    assert!(planned.command.contains(PWD_MARKER), "{}", planned.command);
    assert!(
        planned.command.contains("\nls -la\n"),
        "{}",
        planned.command
    );
    assert_eq!(planned.call.risk, ToolRisk::Read);
}

#[test]
fn write_file_backs_up_before_writing() {
    let planned = plan_tool(
        "write_file",
        &json!({ "path": "/var/www/app/index.html", "content": "<h1>hi</h1>\n" }),
        "/root",
        42,
    )
    .unwrap();
    assert_eq!(planned.call.risk, ToolRisk::Write);
    assert!(
        planned.command.contains("bls-bak.42"),
        "{}",
        planned.command
    );
    assert!(
        planned.command.contains(BACKUP_MARKER),
        "{}",
        planned.command
    );
    assert!(planned.command.contains("base64 -d"), "{}", planned.command);
    // 备份失败时必须在写之前退出。
    let exit = planned.command.find("exit 97").unwrap();
    let write = planned.command.find("base64 -d").unwrap();
    assert!(exit < write, "备份失败要中止写入：{}", planned.command);
    assert_eq!(
        planned.backup_path.as_deref(),
        Some("/var/www/app/index.html.bls-bak.42")
    );
    assert!(planned.rollback.unwrap().starts_with("cp -a "));
}

#[test]
fn writing_into_etc_is_dangerous() {
    let planned = plan_tool(
        "write_file",
        &json!({ "path": "/etc/nginx/conf.d/site.conf", "content": "x" }),
        "/root",
        1,
    )
    .unwrap();
    assert_eq!(planned.call.risk, ToolRisk::Danger);
    assert!(planned.impact.unwrap().contains("系统目录"));
}

#[test]
fn reading_a_private_key_requires_confirmation() {
    let planned = plan_tool(
        "read_file",
        &json!({ "path": "/root/.ssh/id_rsa" }),
        "/root",
        1,
    )
    .unwrap();
    assert_eq!(planned.call.risk, ToolRisk::Write);
}

#[test]
fn relative_paths_are_rejected() {
    assert!(absolute_path("var/www", "path").is_err());
    assert!(absolute_path("/var/../etc/passwd", "path").is_err());
    assert!(absolute_path("/var/www/app", "path").is_ok());
    let error = plan_tool("list_dir", &json!({ "path": "var/www" }), "/", 1).unwrap_err();
    assert!(error.contains("绝对路径"), "{error}");
}

#[test]
fn read_file_uses_a_bounded_line_range() {
    let planned = plan_tool(
        "read_file",
        &json!({ "path": "/etc/hosts", "offset": 5, "limit": 20 }),
        "/",
        1,
    )
    .unwrap();
    assert!(
        planned.command.contains("NR>=5 && NR<=24"),
        "{}",
        planned.command
    );
    assert_eq!(planned.path.as_deref(), Some("/etc/hosts"));
}

#[test]
fn markers_are_parsed_out_of_the_output() {
    let stdout = format!("total 0\r\ndrwxr-xr-x\r\n\n{PWD_MARKER}/var/www/app\n");
    let marked = strip_markers(&stdout);
    assert_eq!(marked.stdout, "total 0\r\ndrwxr-xr-x\r");
    assert_eq!(marked.cwd.as_deref(), Some("/var/www/app"));

    let written = strip_markers(&format!("{BACKUP_MARKER}/a.bls-bak.1\n__BLS_WROTE__/a\n"));
    assert_eq!(written.backup.as_deref(), Some("/a.bls-bak.1"));
    assert!(written.wrote);
}

#[test]
fn changed_directory_is_reported_back() {
    let stdout = format!("{PWD_MARKER}/srv/app\n");
    let marked = strip_markers(&stdout);
    assert_eq!(marked.cwd.as_deref(), Some("/srv/app"));
    assert!(marked.stdout.is_empty());
}

/*
 * 上下文按 token 预算裁剪：**工具调用与结果必须成对保留**。
 *
 * 只留一半（assistant 的 tool_calls 或 role: tool）会让下一轮请求直接 400，
 * 而这类错误在界面上只表现为"模型突然失败"，极难定位。
 */
mod budget_tests {
    use serde_json::{json, Value};

    use super::super::runner::{estimate_tokens, prune_conversation};

    fn conversation() -> Vec<serde_json::Value> {
        vec![
            json!({"role": "system", "content": "系统提示"}),
            json!({"role": "user", "content": "旧问题"}),
            json!({
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "c1",
                    "type": "function",
                    "function": {"name": "run_shell", "arguments": "{}"},
                }],
            }),
            json!({"role": "tool", "tool_call_id": "c1", "content": "旧结果"}),
            json!({"role": "assistant", "content": "旧回答"}),
            json!({"role": "user", "content": "新问题"}),
            json!({
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "c2",
                    "type": "function",
                    "function": {"name": "run_shell", "arguments": "{}"},
                }],
            }),
            json!({"role": "tool", "tool_call_id": "c2", "content": "新结果"}),
        ]
    }

    /// 预算只够 system + 最后一问 + 最后一组工具调用。
    #[test]
    fn keeps_the_last_tool_round_intact() {
        let mut messages = conversation();
        let budget = estimate_tokens(&messages[0])
            + estimate_tokens(&messages[5])
            + estimate_tokens(&messages[6])
            + estimate_tokens(&messages[7]);
        prune_conversation(&mut messages, budget);

        let roles: Vec<&str> = messages
            .iter()
            .filter_map(|message| message["role"].as_str())
            .collect();
        assert_eq!(roles, ["system", "user", "assistant", "tool"]);
        assert_eq!(messages[2]["tool_calls"][0]["id"], "c2");
        assert_eq!(messages[3]["tool_call_id"], "c2");
        // 更早的那一轮整体丢弃，不是只删掉结果留一个悬空的 tool_calls。
        assert!(!messages
            .iter()
            .any(|message| message["tool_call_id"] == "c1"));
    }

    /// 预算连最新一组都放不下：截断正文，但**绝不拆散**配对。
    ///
    /// L3 新增「最后一条 user 永久保留」后，结果比旧实现多保留一个 user：
    /// 历史（旧问 / 旧调用 / 旧回答）折进 system 摘要，最新一问与最新一组保留。
    #[test]
    fn clamps_oversized_round_without_breaking_pairing() {
        let mut messages = conversation();
        let budget = estimate_tokens(&messages[0]) + 1;
        prune_conversation(&mut messages, budget);

        let roles: Vec<&str> = messages
            .iter()
            .filter_map(|message| message["role"].as_str())
            .collect();
        assert_eq!(roles, ["system", "user", "assistant", "tool"]);
        assert!(messages[3]["content"].as_str().unwrap_or_default().len() <= 1024 + 32);
    }

    /// 预算充足时不动任何东西。
    #[test]
    fn keeps_everything_when_budget_is_enough() {
        let mut messages = conversation();
        prune_conversation(&mut messages, 1_000_000);
        assert_eq!(messages.len(), conversation().len());
    }

    /* ---------------- L1 / L2 / L3 ---------------- */

    fn long_tool_result(lines: usize) -> String {
        (0..lines)
            .map(|index| format!("line {index} {}", "x".repeat(40)))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// 配对校验：`assistant(tool_calls)` 与它后面连续的 `role: tool` 必须同进同出。
    fn assert_tool_pairs(messages: &[Value]) {
        let mut pending: Vec<String> = Vec::new();
        for message in messages {
            match message["role"].as_str() {
                Some("assistant") => {
                    assert!(
                        pending.is_empty(),
                        "上一条 assistant 的 tool 结果没接上：{message}"
                    );
                    if let Some(calls) = message["tool_calls"].as_array() {
                        pending = calls
                            .iter()
                            .map(|call| call["id"].as_str().unwrap_or("").to_string())
                            .collect();
                    }
                }
                Some("tool") => {
                    let id = message["tool_call_id"].as_str().unwrap_or("");
                    let at = pending.iter().position(|item| item == id);
                    assert!(at.is_some(), "孤立的 tool 消息：{message}");
                    pending.remove(at.unwrap());
                }
                _ => assert!(pending.is_empty(), "tool 结果被别的消息拆散了"),
            }
        }
        assert!(pending.is_empty(), "assistant(tool_calls) 后面缺 tool 结果");
    }

    /// L1：只瘦身**旧的**工具结果；最近 4 个单元保持原样。
    #[test]
    fn l1_slims_only_old_tool_results() {
        let old = long_tool_result(60);
        let middle = long_tool_result(60);
        let recent = long_tool_result(60);
        let mut messages = vec![
            json!({"role": "system", "content": "系统提示"}),
            json!({"role": "user", "content": "旧问题"}),
            json!({"role": "assistant", "content": "", "tool_calls": [
                {"id": "c1", "type": "function", "function": {"name": "run_shell", "arguments": "{}"}}
            ]}),
            json!({"role": "tool", "tool_call_id": "c1", "content": old}),
            json!({"role": "assistant", "content": "旧回答"}),
            json!({"role": "user", "content": "中间问题"}),
            json!({"role": "assistant", "content": "", "tool_calls": [
                {"id": "c2", "type": "function", "function": {"name": "run_shell", "arguments": "{}"}}
            ]}),
            json!({"role": "tool", "tool_call_id": "c2", "content": middle}),
            json!({"role": "assistant", "content": "中间回答"}),
            json!({"role": "user", "content": "新问题"}),
            json!({"role": "assistant", "content": "", "tool_calls": [
                {"id": "c3", "type": "function", "function": {"name": "run_shell", "arguments": "{}"}}
            ]}),
            json!({"role": "tool", "tool_call_id": "c3", "content": recent}),
        ];
        let before: usize = messages.iter().map(estimate_tokens).sum();
        let report = prune_conversation(&mut messages, before - 20);

        assert_eq!(report.slimmed, 1, "只该瘦身最旧的那条工具结果");
        let slimmed = messages[3]["content"].as_str().unwrap();
        assert!(slimmed.contains("省略"));
        assert!(slimmed.lines().count() <= 21);
        // 最近 4 个单元（中间与最新工具结果）不瘦身。
        assert_eq!(messages[7]["content"].as_str().unwrap(), middle);
        assert_eq!(messages[11]["content"].as_str().unwrap(), recent);
        assert_eq!(report.folded, 0);
        assert_eq!(report.dropped_units, 0);
    }

    /// L2/L3：任何预算下都不产生孤立 tool；报告与实际估算一致。
    #[test]
    fn folding_and_dropping_keep_pairs_and_report() {
        let big = long_tool_result(120);
        let mut messages = vec![
            json!({"role": "system", "content": "系统提示"}),
            json!({"role": "user", "content": "最初的需求"}),
            json!({"role": "assistant", "content": "", "tool_calls": [
                {"id": "c1", "type": "function", "function": {"name": "run_shell", "arguments": "{\"command\":\"uname -a\"}"}}
            ]}),
            json!({"role": "tool", "tool_call_id": "c1", "content": big}),
            json!({"role": "assistant", "content": "第一轮结论", "tool_calls": [
                {"id": "c2", "type": "function", "function": {"name": "run_shell", "arguments": "{\"command\":\"df -h\"}"}}
            ]}),
            json!({"role": "tool", "tool_call_id": "c2", "content": big}),
            json!({"role": "user", "content": "继续"}),
            json!({"role": "assistant", "content": "", "tool_calls": [
                {"id": "c3", "type": "function", "function": {"name": "run_shell", "arguments": "{}"}}
            ]}),
            json!({"role": "tool", "tool_call_id": "c3", "content": big}),
            json!({"role": "user", "content": "最新问题"}),
            json!({"role": "assistant", "content": "", "tool_calls": [
                {"id": "c4", "type": "function", "function": {"name": "run_shell", "arguments": "{}"}}
            ]}),
            json!({"role": "tool", "tool_call_id": "c4", "content": big}),
        ];
        for budget in [1_000_000usize, 20_000, 5_000, 2_000] {
            let mut copy = messages.clone();
            let report = prune_conversation(&mut copy, budget);
            assert_tool_pairs(&copy);
            assert_eq!(
                report.after_tokens,
                copy.iter().map(estimate_tokens).sum::<usize>(),
                "afterTokens 必须等于裁剪后序列的估算"
            );
            assert_eq!(copy[0]["role"], "system");
            assert!(
                copy.iter()
                    .any(|message| message["role"] == "user" && message["content"] == "最新问题"),
                "最后一条 user 必须保留"
            );
        }
        // 预算很紧时确实走到了折叠（摘要写进 system）。
        let mut tight = messages.clone();
        let report = prune_conversation(&mut tight, 2_000);
        assert!(report.folded + report.dropped_units > 0);
        let system = tight[0]["content"].as_str().unwrap_or("");
        assert!(system.contains("【早期摘要】"));
        assert!(system.contains("uname -a") || system.contains("df -h"));
    }

    /// 16K 下限：system 与最后一条 user 仍在，序列可被接口接受（无孤立 tool）。
    #[test]
    fn tiny_budget_keeps_system_and_last_user() {
        let big = long_tool_result(400);
        let mut messages = vec![json!({"role": "system", "content": "系统提示"})];
        for index in 0..6 {
            messages.push(json!({"role": "user", "content": format!("问题 {index}")}));
            messages.push(json!({
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": format!("c{index}"),
                    "type": "function",
                    "function": {"name": "run_shell", "arguments": "{}"},
                }],
            }));
            messages
                .push(json!({"role": "tool", "tool_call_id": format!("c{index}"), "content": big}));
        }
        messages.push(json!({"role": "user", "content": "最新问题"}));
        messages.push(json!({"role": "assistant", "content": "好的"}));

        let budget = crate::deployment::ai::capability::MIN_INPUT_TOKENS as usize;
        let report = prune_conversation(&mut messages, budget);
        assert_tool_pairs(&messages);
        assert_eq!(messages[0]["role"], "system");
        assert!(messages[0]["content"]
            .as_str()
            .unwrap_or("")
            .contains("系统提示"));
        assert_eq!(
            messages
                .iter()
                .filter(|message| message["role"] == "user")
                .next_back()
                .and_then(|message| message["content"].as_str()),
            Some("最新问题")
        );
        assert!(report.before_tokens >= report.after_tokens);
    }

    /// L1 同时瘦身旧的文本协议 `<tool_result>` 与历史 `操作记录（` 块，避免多轮历史撑爆上下文。
    #[test]
    fn l1_slims_old_text_tool_results_and_historical_session_facts() {
        let long_fact = format!(
            "操作记录（成功）：nginx -T\n标准输出：\n{}",
            long_tool_result(60)
        );
        let long_xml = format!(
            "<tool_result name=\"run_shell\" exit=\"0\">\n{}\n</tool_result>",
            long_tool_result(60)
        );
        let mut messages = vec![
            json!({"role": "system", "content": "系统提示"}),
            json!({"role": "user", "content": "第一轮"}),
            json!({"role": "assistant", "content": long_fact}),
            json!({"role": "user", "content": long_xml}),
            json!({"role": "assistant", "content": "中间总结"}),
            json!({"role": "user", "content": "第二轮"}),
            json!({"role": "assistant", "content": "第二轮回复"}),
            json!({"role": "user", "content": "第三轮"}),
            json!({"role": "assistant", "content": "第三轮回复"}),
            json!({"role": "user", "content": "最新问题"}),
        ];
        let before: usize = messages.iter().map(estimate_tokens).sum();
        let report = prune_conversation(&mut messages, before - 50);
        assert_eq!(report.slimmed, 2);
        assert!(messages[2]["content"].as_str().unwrap().contains("省略"));
        assert!(messages[3]["content"].as_str().unwrap().contains("省略"));
    }

    /// L2 折叠连续单元时使用递增段号（第1-1段、第2-2段…），不再重复写死第2-2段。
    #[test]
    fn l2_fold_uses_sequential_segment_numbers() {
        let long_a = long_tool_result(40);
        let long_b = long_tool_result(40);
        let mut messages = vec![
            json!({"role": "system", "content": "系统提示"}),
            json!({"role": "user", "content": format!("第一轮需求\n{long_a}")}),
            json!({"role": "assistant", "content": format!("第一轮分析\n{long_b}")}),
            json!({"role": "user", "content": "最新问题"}),
            json!({"role": "assistant", "content": "最新回复"}),
        ];
        let report = prune_conversation(&mut messages, 300);
        assert!(report.folded >= 2);
        let system = messages[0]["content"].as_str().unwrap_or("");
        assert!(system.contains("第1-1段"), "{system}");
        assert!(system.contains("第2-2段"), "{system}");
    }
}

/*
 * 思考强度 → 行为段：四档各自命中，未知档走默认。
 *
 * 行为段只写"怎么做"，权限与审批完全不受影响（这里用 ToolRisk 与常量锁住）。
 */
mod thinking_tests {
    use super::super::protocol::{
        intent_guidance, reply_language_rule, thinking_guidance, tool_prompt, Lang, ToolRisk,
        MAX_ROUNDS,
    };

    #[test]
    fn each_effort_has_its_own_block() {
        for (effort, marker) in [
            ("low", "思考强度：低"),
            ("medium", "思考强度：中"),
            ("high", "思考强度：高"),
            ("max", "思考强度：最高"),
        ] {
            let text = thinking_guidance(Some(effort), Lang::Zh);
            assert!(text.contains(marker), "{effort} 应命中自己的行为段");
        }
        // 大小写 / 前后空白不影响。
        assert!(thinking_guidance(Some(" MAX "), Lang::Zh).contains("思考强度：最高"));
    }

    #[test]
    fn unknown_effort_falls_back_to_default() {
        let default = thinking_guidance(None, Lang::Zh);
        assert!(default.contains("思考强度：默认"));
        assert_eq!(default, thinking_guidance(Some("auto"), Lang::Zh));
        assert_eq!(default, thinking_guidance(Some("N/A"), Lang::Zh));
    }

    /// 只查询 → 只读：即使开了完全权限也不顺手改；命令用途不明确先换工具。
    #[test]
    fn intent_guidance_keeps_queries_read_only() {
        let text = intent_guidance(Lang::Zh);
        assert!(text.contains("只查询"));
        assert!(text.contains("完全权限"), "要写明完全权限也不改变查询范围");
        assert!(text.contains("只读"));
        assert!(text.contains("用途不明确"));
        assert!(text.contains("实际错误"));
    }

    /**
     * 英文界面下四段提示词必须**整段英文**：只要混进中文，模型就会顺着
     * 中文继续回答 —— 这正是"切英文还是满屏中文"的根因。
     */
    #[test]
    fn english_locale_switches_every_prompt_block() {
        for effort in ["low", "medium", "high", "max", "auto"] {
            let text = thinking_guidance(Some(effort), Lang::En);
            assert!(
                !text.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)),
                "{effort} 的英文段里不能有中文"
            );
        }
        for text in [
            intent_guidance(Lang::En),
            tool_prompt(Lang::En),
            reply_language_rule(Lang::En),
        ] {
            assert!(
                !text.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)),
                "英文段里不能有中文"
            );
        }
        assert!(reply_language_rule(Lang::En).contains("English only"));
        let zh = reply_language_rule(Lang::Zh);
        assert!(zh.contains("只用简体中文"));
        assert!(zh.contains("不要中英混写"));
        // 语言判定：`en` / `en-US` 走英文，其余（含未传）走中文。
        assert_eq!(Lang::from_locale(Some("en")), Lang::En);
        assert_eq!(Lang::from_locale(Some("en-US")), Lang::En);
        assert_eq!(Lang::from_locale(Some("zh-CN")), Lang::Zh);
        assert_eq!(Lang::from_locale(None), Lang::Zh);
    }

    /// 低档只是"直接做"，不改风险分级、审批门槛与轮数上限。
    #[test]
    fn effort_does_not_touch_risk_or_limits() {
        let low = thinking_guidance(Some("low"), Lang::Zh);
        assert!(low.contains("读原文"), "低档也必须先读原文再改");
        assert!(!low.contains("无需确认"));

        assert!(!ToolRisk::Read.needs_approval());
        assert!(ToolRisk::Write.needs_approval(), "低档下写操作仍要确认");
        assert!(ToolRisk::Danger.needs_approval(), "低档下危险操作仍要确认");
        assert_eq!(MAX_ROUNDS, 40, "档位不放大轮数上限");
    }
}

/*
 * 用户可见表达只维护**一份**：工具协议说"怎么做"，表达规则说"哪些内容
 * 进对话"。这里锁住收敛结果，防止要求又散回多个提示词里互相打架。
 */
mod expression_tests {
    use super::super::protocol::{
        intent_guidance, preamble_guidance, preamble_text, tool_prompt, Lang, StepCategory,
    };

    #[test]
    fn expression_rules_keep_internal_mechanics_out_of_the_reply() {
        let zh = preamble_guidance(Lang::Zh);
        assert!(zh.contains("用户表达规则"), "要有唯一的一份表达规则");
        for needle in ["intent", "taskId", "计划登记", "平台识别错了"] {
            assert!(
                zh.contains(needle),
                "内部机制默认不进对话，规则里要明确点名：{needle}"
            );
        }
        assert!(zh.contains("尚不能确认"), "结果未知时必须如实写不确定");
        // 权限与风险披露不能被"简洁"吞掉。
        assert!(zh.contains("影响与确认"));
    }

    #[test]
    fn internal_correction_rules_are_not_repeated_in_scope_guidance() {
        let zh = intent_guidance(Lang::Zh);
        assert!(
            !zh.contains("平台识别错了"),
            "内部纠错不播报只写在表达规则里，不要两处重复"
        );
        // 范围约束本身仍然保留。
        assert!(zh.contains("只查询"));
        assert!(zh.contains("用途不明确"));
    }

    #[test]
    fn tool_protocol_does_not_demand_a_sentence_per_failure() {
        let zh = tool_prompt(Lang::Zh);
        assert!(
            !zh.contains("先用一句话说明你判断到的原因"),
            "失败时是否说明、说多少由表达规则决定，工具协议不再强制逐条播报"
        );
        assert!(zh.contains("用户表达规则"), "失败叙事要指回唯一来源");
        assert!(
            !zh.contains("下一步建议。") || zh.contains("确实还有需要用户做的下一步"),
            "收尾不再固定附加下一步建议"
        );
    }

    #[test]
    fn preamble_fallback_does_not_repeat_a_template_tail() {
        let text = preamble_text(Lang::Zh, None, "run_shell", None, "docker ps");
        assert_eq!(text, "先执行 docker ps");
        assert!(!text.contains("确认结果后再继续"), "不要模板化的固定尾巴");
        assert_eq!(
            preamble_text(
                Lang::Zh,
                None,
                "read_file",
                Some("/etc/nginx/nginx.conf"),
                ""
            ),
            "先读取 /etc/nginx/nginx.conf"
        );
    }

    /// 历史 / 快照恢复要靠它把类别带回来；认不出时必须保守放弃，不能猜。
    #[test]
    fn step_category_round_trips_from_history() {
        assert_eq!(
            StepCategory::from_code("internal"),
            Some(StepCategory::Internal)
        );
        assert_eq!(
            StepCategory::from_code(" DENIED "),
            Some(StepCategory::Denied)
        );
        assert_eq!(
            StepCategory::from_code("executed"),
            Some(StepCategory::Executed)
        );
        assert_eq!(StepCategory::from_code(""), None);
        assert_eq!(StepCategory::from_code("bogus"), None);
    }
}

/*
 * 多轮循环本身：用假 IO 驱动，不碰真 SSH / 真模型。
 *
 * 这里验证的是"循环行为"——拒绝后绝不执行、确认前服务器无变化、取消停在当前
 * 命令、轮数上限、sudo 默认禁用。它们只靠编译是看不出来的。
 */
mod loop_tests {
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use serde_json::Value;
    use tokio::sync::mpsc::UnboundedSender;

    use super::super::protocol::{AgentEvent, Lang};
    use super::super::runner::{
        evaluate_outcome, is_query_only, run_loop, AgentIo, AgentServerRef, IoFuture, StopReason,
    };
    use super::super::state::{AgentHandle, AgentSnapshot};
    use super::*;
    use crate::agent::TokenUsage;
    use crate::agent::{AgentInput, AgentTurn};
    use crate::deployment::ai::model::AiCancel;
    use crate::deployment::ai::{AiProviderError, NativeToolCall, ToolReply};
    use crate::ssh::{ExecChunk, ExecOutput};

    fn loop_input(max_rounds: Option<u32>) -> AgentInput {
        AgentInput {
            task_id: "task-loop".to_string(),
            session_id: "ssh-1".to_string(),
            server: "prod".to_string(),
            server_id: None,
            workspace_id: None,
            cwd: "/root".to_string(),
            messages: vec![AgentTurn {
                role: "user".to_string(),
                // 中性表述：不带"查 / 看"这类查询词，默认就是修改范围，
                // 写入 / 危险操作的用例才不会被查询边界挡住。
                content: "处理这台机器".to_string(),
            }],
            provider_id: None,
            locale: None,
            reply_language: None,
            reasoning_effort: None,
            context_budget: None,
            capability: None,
            carry_usage: None,
            allow_sudo: false,
            auto_approve_writes: false,
            permission_mode: crate::agent::PermissionMode::Ask,
            backup_before_write: true,
            backup_before_delete: true,
            backup_retention_days: 30,
            mcp_tools: Vec::new(),
            servers: Vec::new(),
            enabled_builtins: None,
            db: None,
            plan_required: false,
            carry_plan: None,
            max_rounds,
            carry_steps: Vec::new(),
            child_run: false,
        }
    }

    fn loop_snapshot() -> AgentSnapshot {
        AgentSnapshot::new("task-loop", "prod", "ssh-1", "/root", "test-model")
    }

    /// 一轮模型回复：正文，或原生的 `tool_calls`。
    enum FakeReply {
        Text(String),
        Native {
            id: String,
            name: String,
            arguments: String,
        },
    }

    /// 假 IO：模型回复按顺序取，执行过的命令记下来，事件收进 Vec。
    struct FakeIo {
        replies: Mutex<VecDeque<FakeReply>>,
        executed: Mutex<Vec<String>>,
        events: Arc<Mutex<Vec<AgentEvent>>>,
        /// 每次请求带过去的消息（测试据此断言 `role: tool` 回灌）。
        sent: Mutex<Vec<Vec<Value>>>,
        connected: bool,
        server_ok: bool,
        /// 下一次命中这些子串的命令返回失败（只消耗一次）。
        failures: Mutex<Vec<String>>,
    }

    impl FakeIo {
        fn new(replies: &[&str]) -> Self {
            Self {
                replies: Mutex::new(
                    replies
                        .iter()
                        .map(|reply| FakeReply::Text(reply.to_string()))
                        .collect(),
                ),
                executed: Mutex::new(Vec::new()),
                events: Arc::new(Mutex::new(Vec::new())),
                sent: Mutex::new(Vec::new()),
                connected: true,
                server_ok: true,
                failures: Mutex::new(Vec::new()),
            }
        }

        fn executed(&self) -> Vec<String> {
            self.executed
                .lock()
                .map(|list| list.clone())
                .unwrap_or_default()
        }

        fn kinds(&self) -> Vec<String> {
            self.events
                .lock()
                .map(|list| list.iter().map(|event| event.kind.clone()).collect())
                .unwrap_or_default()
        }

        /// 最后一次请求里的消息角色（用来确认 `role: tool` 真的回灌了）。
        fn last_roles(&self) -> Vec<String> {
            self.sent
                .lock()
                .ok()
                .and_then(|list| list.last().cloned())
                .map(|messages| {
                    messages
                        .iter()
                        .filter_map(|message| message["role"].as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default()
        }

        /// 最后一次请求的完整消息（用来断言"补充要求进了下一轮对话"）。
        fn last_messages(&self) -> Vec<Value> {
            self.sent
                .lock()
                .ok()
                .and_then(|list| list.last().cloned())
                .unwrap_or_default()
        }
    }

    impl AgentIo for FakeIo {
        fn emit(&self, event: AgentEvent) {
            if let Ok(mut list) = self.events.lock() {
                list.push(event);
            }
        }

        fn sink(&self) -> Arc<dyn Fn(AgentEvent) + Send + Sync> {
            let events = self.events.clone();
            Arc::new(move |event| {
                if let Ok(mut list) = events.lock() {
                    list.push(event);
                }
            })
        }

        fn connected<'a>(&'a self, _session_id: &'a str) -> IoFuture<'a, bool> {
            Box::pin(async move { self.connected })
        }

        fn verify_server(&self, _session_id: &str, _server: &str) -> Result<(), String> {
            if self.server_ok {
                Ok(())
            } else {
                Err("会话属于「prod」，不是「stage」；已拒绝执行".to_string())
            }
        }

        fn exec<'a>(
            &'a self,
            _session_id: &'a str,
            command: &'a str,
            _timeout: Duration,
            _sink: UnboundedSender<ExecChunk>,
        ) -> IoFuture<'a, Result<ExecOutput, String>> {
            Box::pin(async move {
                if let Ok(mut list) = self.executed.lock() {
                    list.push(command.to_string());
                }
                /*
                 * `io:<片段>`：模拟 SSH 传输层中断（**没有退出码**），
                 * 用来验证"结果不确定的写操作不能自动重放"。
                 */
                let disconnected = self
                    .failures
                    .lock()
                    .ok()
                    .and_then(|mut list| {
                        list.iter()
                            .position(|needle| {
                                needle
                                    .strip_prefix("io:")
                                    .is_some_and(|inner| command.contains(inner))
                            })
                            .map(|at| list.remove(at))
                    })
                    .is_some();
                if disconnected {
                    return Err("SSH 连接中断".to_string());
                }
                let failed = self
                    .failures
                    .lock()
                    .ok()
                    .and_then(|mut list| {
                        list.iter()
                            .position(|needle| command.contains(needle))
                            .map(|at| list.remove(at))
                    })
                    .is_some();
                if failed {
                    return Ok(ExecOutput {
                        stdout: String::new(),
                        stderr: "模拟失败：解压中断".to_string(),
                        exit_code: Some(1),
                        truncated: false,
                    });
                }
                Ok(ExecOutput {
                    stdout: format!("ok: {command}\n"),
                    stderr: String::new(),
                    exit_code: Some(0),
                    truncated: false,
                })
            })
        }

        fn chat<'a>(
            &'a self,
            messages: Vec<Value>,
            _tools: Value,
            _cancel: &'a AiCancel,
            on_delta: Arc<dyn Fn(&str) + Send + Sync>,
        ) -> IoFuture<'a, Result<ToolReply, AiProviderError>> {
            Box::pin(async move {
                if let Ok(mut sent) = self.sent.lock() {
                    sent.push(messages);
                }
                // 假数据没有分片：整段当一次增量发出去，验证"增量事件会被推出去"。
                let _ = &on_delta;
                let reply = self
                    .replies
                    .lock()
                    .ok()
                    .and_then(|mut queue| queue.pop_front());
                match reply {
                    Some(FakeReply::Text(content)) => {
                        // 真实实现是一段段回调；假数据把整段当一次增量。
                        on_delta(&content);
                        Ok(ToolReply {
                            message: serde_json::json!({ "role": "assistant", "content": content }),
                            content,
                            tool_calls: Vec::new(),
                        })
                    }
                    Some(FakeReply::Native {
                        id,
                        name,
                        arguments,
                    }) => Ok(ToolReply {
                        content: String::new(),
                        message: serde_json::json!({
                            "role": "assistant",
                            "content": null,
                            "tool_calls": [{
                                "id": id,
                                "type": "function",
                                "function": { "name": name, "arguments": arguments },
                            }],
                        }),
                        tool_calls: vec![NativeToolCall {
                            id,
                            name,
                            arguments,
                        }],
                    }),
                    None => Err(AiProviderError::Http {
                        status: 500,
                        detail: "假模型没有更多回复".to_string(),
                    }),
                }
            })
        }
    }

    fn parallel_input() -> AgentInput {
        static TEST_SERVER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let mut input = loop_input(None);
        input.server_id = Some(format!(
            "test-server-{}",
            TEST_SERVER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        input
    }

    struct ParallelIo {
        base: FakeIo,
        barrier: tokio::sync::Barrier,
        dependent: bool,
        use_mcp: bool,
        scripted_parent: bool,
        mcp_calls: Mutex<Vec<String>>,
    }
    impl AgentIo for ParallelIo {
        fn emit(&self, event: AgentEvent) {
            self.base.emit(event);
        }
        fn sink(&self) -> Arc<dyn Fn(AgentEvent) + Send + Sync> {
            self.base.sink()
        }
        fn connected<'a>(&'a self, id: &'a str) -> IoFuture<'a, bool> {
            self.base.connected(id)
        }
        fn verify_server(&self, id: &str, server: &str) -> Result<(), String> {
            self.base.verify_server(id, server)
        }
        fn exec<'a>(
            &'a self,
            id: &'a str,
            command: &'a str,
            timeout: Duration,
            sink: UnboundedSender<ExecChunk>,
        ) -> IoFuture<'a, Result<ExecOutput, String>> {
            Box::pin(async move {
                tokio::time::timeout(Duration::from_secs(3), self.barrier.wait())
                    .await
                    .map_err(|_| "child operations did not overlap".to_string())?;
                self.base.exec(id, command, timeout, sink).await
            })
        }
        fn call_mcp<'a>(
            &'a self,
            binding: &'a crate::mcp::McpBinding,
            _args: &'a Value,
        ) -> IoFuture<'a, Result<String, String>> {
            Box::pin(async move {
                self.mcp_calls.lock().unwrap().push(binding.tool.clone());
                Ok("mock evidence".into())
            })
        }
        fn chat<'a>(
            &'a self,
            messages: Vec<Value>,
            tools: Value,
            cancel: &'a AiCancel,
            delta: Arc<dyn Fn(&str) + Send + Sync>,
        ) -> IoFuture<'a, Result<ToolReply, AiProviderError>> {
            Box::pin(async move {
                let text = serde_json::to_string(&messages).unwrap();
                let has_result = text.contains("<tool_result");
                let child = text.contains("Assigned read-only investigation:");
                if self.scripted_parent && !child {
                    return self.base.chat(messages, tools, cancel, delta).await;
                }
                let content = if self.use_mcp && child {
                    if has_result {
                        "checked with MCP"
                    } else {
                        r#"<tool name="mcp__selected__inspect">{}</tool>"#
                    }
                } else if text.contains("Assigned read-only investigation: check disk") {
                    if has_result {
                        "disk checked"
                    } else {
                        r#"<tool name="run_shell">{"command":"df -h"}</tool>"#
                    }
                } else if text.contains("Assigned read-only investigation: check memory") {
                    if has_result {
                        "memory checked"
                    } else {
                        r#"<tool name="run_shell">{"command":"free -h"}</tool>"#
                    }
                } else if has_result {
                    "checks finished"
                } else if self.dependent {
                    r#"<tool name="parallel_readonly_agents">{"tasks":[{"id":"disk","title":"disk","goal":"check disk"},{"id":"memory","title":"memory","goal":"check memory","depends_on":["disk"]}]}</tool>"#
                } else {
                    r#"<tool name="parallel_readonly_agents">{"tasks":[{"title":"disk","goal":"check disk"},{"title":"memory","goal":"check memory"}]}</tool>"#
                };
                Ok(ToolReply {
                    message: json!({"role":"assistant","content":content}),
                    content: content.to_string(),
                    tool_calls: Vec::new(),
                })
            })
        }
    }

    #[tokio::test]
    async fn parallel_children_are_separate_read_only_runs() {
        let io = ParallelIo {
            base: FakeIo::new(&[]),
            barrier: tokio::sync::Barrier::new(2),
            dependent: false,
            use_mcp: false,
            scripted_parent: false,
            mcp_calls: Mutex::new(Vec::new()),
        };
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let result = run_loop(&handle, &parallel_input(), &io, None).await;
        assert!(result.is_ok(), "{result:?}");
        let commands = io.base.executed();
        assert!(commands.iter().any(|c| c.contains("df -h")), "{commands:?}");
        assert!(
            commands.iter().any(|c| c.contains("free -h")),
            "{commands:?}"
        );
        let children: Vec<_> = handle
            .snapshot()
            .steps
            .into_iter()
            .filter(|s| s.tool == "child_agent")
            .collect();
        assert_eq!(children.len(), 2);
        assert!(
            children.iter().all(|s| s.state == "success"),
            "{children:?}"
        );
        assert!(
            children.iter().all(|s| s
                .child_usage
                .as_ref()
                .is_some_and(|usage| usage.requests >= 2)),
            "child usage should be retained: {children:?}"
        );
    }

    #[tokio::test]
    async fn child_delegation_is_reconsidered_before_serial_probes_start() {
        let io = ParallelIo {
            base: FakeIo::new(&[
                r#"<tool name="submit_plan">{"steps":[{"id":"disk","title":"磁盘","action":"查磁盘","verify":"使用量","kind":"probe"},{"id":"memory","title":"内存","action":"查内存","verify":"使用量","kind":"probe"}]}</tool>"#,
                r#"<tool name="run_shell">{"step":"disk","command":"df -h"}</tool><tool name="run_shell">{"step":"memory","command":"free -h"}</tool>"#,
                r#"<tool name="submit_plan">{"steps":[{"id":"health","title":"健康检查","action":"核查磁盘和内存","verify":"各项有输出","kind":"probe"}]}</tool>"#,
                r#"<tool name="parallel_readonly_agents">{"step":"health","tasks":[{"title":"磁盘","goal":"check disk"},{"title":"内存","goal":"check memory"}]}</tool>"#,
                "健康检查完成。",
            ]),
            barrier: tokio::sync::Barrier::new(2),
            dependent: false,
            use_mcp: false,
            scripted_parent: true,
            mcp_calls: Mutex::new(Vec::new()),
        };
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let mut input = parallel_input();
        input.plan_required = true;
        input.messages = vec![AgentTurn {
            role: "user".into(),
            content: "看看这台服务器最近稳不稳".into(),
        }];

        let result = run_loop(&handle, &input, &io, None).await;
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(io.base.executed().len(), 2);
        let snapshot = handle.snapshot();
        assert_eq!(
            snapshot
                .steps
                .iter()
                .filter(|step| step.tool == "child_agent" && step.state == "success")
                .count(),
            2
        );
        assert_eq!(
            snapshot
                .steps
                .iter()
                .filter(|step| step.category == Some(crate::agent::StepCategory::Internal))
                .count(),
            2
        );
        assert_eq!(snapshot.plan.unwrap().step("health").unwrap().state, "done");
    }

    #[tokio::test]
    async fn child_delegation_review_allows_serial_fallback_after_one_round() {
        let lookup = r#"<tool name="run_shell">{"step":"service","command":"systemctl status nginx"}</tool>"#;
        let io = FakeIo::new(&[
            r#"<tool name="submit_plan">{"steps":[{"id":"service","title":"定位服务","action":"获取服务信息","verify":"找到服务","kind":"probe"},{"id":"logs","title":"查日志","action":"读取已定位服务的日志","verify":"取得日志","kind":"probe"}]}</tool>"#,
            lookup,
            lookup,
            r#"<tool name="run_shell">{"step":"logs","command":"journalctl -u nginx -n 10"}</tool>"#,
            "已定位服务并读取日志。",
        ]);
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let mut input = parallel_input();
        input.plan_required = true;

        let result = run_loop(&handle, &input, &io, None).await;
        assert!(result.is_ok(), "{result:?}");
        let commands = io.executed();
        assert_eq!(commands.len(), 2, "{commands:?}");
        assert!(commands[0].contains("systemctl status nginx"));
        assert!(commands[1].contains("journalctl -u nginx"));
        assert!(!handle
            .snapshot()
            .steps
            .iter()
            .any(|step| step.tool == "child_agent"));
    }

    #[tokio::test]
    async fn selected_read_only_mcp_is_available_to_child_agents() {
        let io = ParallelIo {
            base: FakeIo::new(&[]),
            barrier: tokio::sync::Barrier::new(2),
            dependent: false,
            use_mcp: true,
            scripted_parent: false,
            mcp_calls: Mutex::new(Vec::new()),
        };
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let mut input = parallel_input();
        input.mcp_tools = vec![crate::mcp::McpBinding {
            exposed_name: "mcp__selected__inspect".into(),
            server_id: "selected".into(),
            server_name: "selected".into(),
            tool: "inspect".into(),
            description: "read-only inspection".into(),
            input_schema: json!({"type":"object"}),
            read_only: true,
            config: crate::mcp::McpServerConfig::default(),
        }];
        assert!(run_loop(&handle, &input, &io, None).await.is_ok());
        assert_eq!(io.mcp_calls.lock().unwrap().len(), 2);
        assert!(handle
            .snapshot()
            .steps
            .iter()
            .filter(|s| s.tool == "child_agent")
            .all(|s| s.state == "success"));
    }

    #[tokio::test]
    async fn child_agents_cannot_invoke_write_mcp_even_in_full_mode() {
        let io = ParallelIo {
            base: FakeIo::new(&[]),
            barrier: tokio::sync::Barrier::new(2),
            dependent: false,
            use_mcp: true,
            scripted_parent: false,
            mcp_calls: Mutex::new(Vec::new()),
        };
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let mut input = parallel_input();
        input.permission_mode = crate::agent::PermissionMode::Full;
        input.auto_approve_writes = true;
        input.mcp_tools = vec![crate::mcp::McpBinding {
            exposed_name: "mcp__selected__inspect".into(),
            server_id: "selected".into(),
            server_name: "selected".into(),
            tool: "inspect".into(),
            description: "write operation".into(),
            input_schema: json!({"type":"object"}),
            read_only: false,
            config: crate::mcp::McpServerConfig::default(),
        }];
        let _ = run_loop(&handle, &input, &io, None).await;
        assert!(io.mcp_calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn child_dependencies_wait_and_failure_blocks_dependents() {
        let io = ParallelIo {
            base: FakeIo::new(&[]),
            barrier: tokio::sync::Barrier::new(1),
            dependent: true,
            use_mcp: false,
            scripted_parent: false,
            mcp_calls: Mutex::new(Vec::new()),
        };
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let mut input = parallel_input();
        input.carry_steps.push(crate::agent::AgentStep {
            tool: "child_agent".into(),
            state: "success".into(),
            child_id: Some("disk".into()),
            child_goal: Some("check disk".into()),
            server_id: input.server_id.clone(),
            stdout: "historical disk report".into(),
            stale: true,
            ..Default::default()
        });
        assert!(run_loop(&handle, &input, &io, None).await.is_ok());
        let commands = io.base.executed();
        let disk = commands.iter().position(|c| c.contains("df -h")).unwrap();
        let memory = commands.iter().position(|c| c.contains("free -h")).unwrap();
        assert!(disk < memory);

        let io = ParallelIo {
            base: FakeIo::new(&[]),
            barrier: tokio::sync::Barrier::new(1),
            dependent: true,
            use_mcp: false,
            scripted_parent: false,
            mcp_calls: Mutex::new(Vec::new()),
        };
        io.base.failures.lock().unwrap().push("df -h".into());
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let _ = run_loop(&handle, &parallel_input(), &io, None).await;
        assert!(!io.base.executed().iter().any(|c| c.contains("free -h")));
        assert!(handle
            .snapshot()
            .steps
            .iter()
            .any(|s| s.tool == "child_agent" && s.state == "skipped"));
    }

    #[tokio::test]
    async fn parallel_child_failure_is_not_reported_as_success() {
        let io = ParallelIo {
            base: FakeIo::new(&[]),
            barrier: tokio::sync::Barrier::new(2),
            dependent: false,
            use_mcp: false,
            scripted_parent: false,
            mcp_calls: Mutex::new(Vec::new()),
        };
        io.base.failures.lock().unwrap().push("free -h".to_string());
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let _ = run_loop(&handle, &parallel_input(), &io, None).await;
        let snapshot = handle.snapshot();
        let aggregate = snapshot
            .steps
            .iter()
            .find(|s| s.tool == "parallel_readonly_agents")
            .unwrap();
        assert_eq!(aggregate.state, "failed");
        let children: Vec<_> = snapshot
            .steps
            .iter()
            .filter(|s| s.tool == "child_agent")
            .collect();
        assert_eq!(children.len(), 2);
        assert!(children.iter().any(|s| s.state == "failed"));
        assert!(children.iter().any(|s| s.state == "success"));
    }

    #[tokio::test]
    async fn cancelling_parent_propagates_to_running_children() {
        let io = ParallelIo {
            base: FakeIo::new(&[]),
            barrier: tokio::sync::Barrier::new(3),
            dependent: false,
            use_mcp: false,
            scripted_parent: false,
            mcp_calls: Mutex::new(Vec::new()),
        };
        let cancel = AiCancel::new();
        let handle = AgentHandle::new(loop_snapshot(), cancel.clone());
        let input = parallel_input();
        let (result, _) = tokio::join!(run_loop(&handle, &input, &io, None), async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            cancel.cancel();
        });
        assert!(matches!(result, Err(StopReason::Cancelled(_))));
        assert!(io.base.executed().is_empty());
        assert!(handle
            .snapshot()
            .steps
            .iter()
            .filter(|s| s.tool == "child_agent")
            .all(|s| s.state == "skipped"));
    }

    struct McpIo {
        base: FakeIo,
        calls: Mutex<Vec<String>>,
        fail: bool,
    }
    impl McpIo {
        fn new(replies: &[&str], fail: bool) -> Self {
            Self {
                base: FakeIo::new(replies),
                calls: Mutex::new(Vec::new()),
                fail,
            }
        }
    }
    impl AgentIo for McpIo {
        fn emit(&self, event: AgentEvent) {
            self.base.emit(event);
        }
        fn sink(&self) -> Arc<dyn Fn(AgentEvent) + Send + Sync> {
            self.base.sink()
        }
        fn connected<'a>(&'a self, id: &'a str) -> IoFuture<'a, bool> {
            self.base.connected(id)
        }
        fn verify_server(&self, id: &str, server: &str) -> Result<(), String> {
            self.base.verify_server(id, server)
        }
        fn exec<'a>(
            &'a self,
            id: &'a str,
            command: &'a str,
            timeout: Duration,
            sink: UnboundedSender<ExecChunk>,
        ) -> IoFuture<'a, Result<ExecOutput, String>> {
            self.base.exec(id, command, timeout, sink)
        }
        fn chat<'a>(
            &'a self,
            messages: Vec<Value>,
            tools: Value,
            cancel: &'a AiCancel,
            delta: Arc<dyn Fn(&str) + Send + Sync>,
        ) -> IoFuture<'a, Result<ToolReply, AiProviderError>> {
            self.base.chat(messages, tools, cancel, delta)
        }
        fn call_mcp<'a>(
            &'a self,
            binding: &'a crate::mcp::McpBinding,
            _args: &'a Value,
        ) -> IoFuture<'a, Result<String, String>> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(binding.tool.clone());
                if self.fail {
                    Err("transport closed while calling tools/call".to_string())
                } else {
                    Ok("mock mcp output".to_string())
                }
            })
        }
    }

    fn mcp_binding(tool: &str, read_only: bool) -> crate::mcp::McpBinding {
        crate::mcp::McpBinding {
            exposed_name: format!("mcp__selected__{tool}"),
            server_id: "selected".into(),
            server_name: "demo".into(),
            tool: tool.into(),
            description: "".into(),
            input_schema: json!({"type":"object"}),
            read_only,
            config: crate::mcp::McpServerConfig::default(),
        }
    }

    #[tokio::test]
    async fn a_write_mcp_tool_asks_even_under_full_permissions() {
        let call =
            r#"<tool name="mcp__selected__write_file">{"path":"/tmp/x","content":"a"}</tool>"#;
        // 写后要求一次只读验证，再收尾（与现有写操作流程一致）。
        let io = McpIo::new(
            &[
                call,
                r#"<tool name="run_shell">{"command":"cat /tmp/x"}</tool>"#,
                "done",
            ],
            false,
        );
        let handle = Arc::new(AgentHandle::new(loop_snapshot(), AiCancel::new()));
        let mut input = loop_input(None);
        input.permission_mode = crate::agent::PermissionMode::Full;
        input.auto_approve_writes = true;
        input.mcp_tools = vec![mcp_binding("write_file", false)];
        decide_later(handle.clone(), "call-0-0", true);
        let result = run_loop(&handle, &input, &io, None).await;
        assert!(result.is_ok(), "{result:?}");
        assert!(
            io.base.kinds().contains(&"approval_required".to_string()),
            "MCP writes must still be confirmed under full permissions"
        );
        assert_eq!(io.calls.lock().unwrap().len(), 1);
        assert_eq!(handle.snapshot().steps[0].state, "success");
    }

    #[tokio::test]
    async fn an_unknown_effect_mcp_tool_is_not_executed_without_confirmation() {
        // readOnlyHint=true，但工具名是 delete_*：只能按"影响未知"处理。
        let call = r#"<tool name="mcp__selected__delete_file">{"path":"/tmp/x"}</tool>"#;
        let io = McpIo::new(&[call, "skipped"], false);
        let handle = Arc::new(AgentHandle::new(loop_snapshot(), AiCancel::new()));
        let mut input = loop_input(None);
        input.permission_mode = crate::agent::PermissionMode::Full;
        input.auto_approve_writes = true;
        input.mcp_tools = vec![mcp_binding("delete_file", true)];
        cancel_later(handle.clone());
        let result = run_loop(&handle, &input, &io, None).await;
        assert!(
            matches!(result, Err(StopReason::Cancelled(_))),
            "{result:?}"
        );
        assert!(io.base.kinds().contains(&"approval_required".to_string()));
        assert!(
            io.calls.lock().unwrap().is_empty(),
            "unknown effect must not run without an explicit decision"
        );
    }

    #[tokio::test]
    async fn a_real_mcp_transport_error_is_not_reported_as_a_permission_error() {
        let call = r#"<tool name="mcp__selected__inspect">{}</tool>"#;
        let io = McpIo::new(&[call, "failed"], true);
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let mut input = loop_input(None);
        input.mcp_tools = vec![mcp_binding("inspect", true)];
        let _ = run_loop(&handle, &input, &io, None).await;
        let step = &handle.snapshot().steps[0];
        assert_eq!(step.state, "failed");
        assert!(step.stderr.contains("MCP 调用失败"), "{}", step.stderr);
        assert_eq!(
            step.blocked, None,
            "transport failures are not permission denials"
        );
        assert_eq!(step.category, Some(StepCategory::Executed));
        assert!(!io.base.kinds().contains(&"approval_required".to_string()));
    }

    #[tokio::test]
    async fn child_agents_cannot_create_more_child_agents() {
        let io = FakeIo::new(&[
            r#"<tool name="parallel_readonly_agents">{"tasks":[{"title":"a","goal":"x"},{"title":"b","goal":"y"}]}</tool>"#,
            "no delegation",
        ]);
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let mut input = parallel_input();
        input.child_run = true;
        input.permission_mode = crate::agent::PermissionMode::ReadOnly;
        let _ = run_loop(&handle, &input, &io, None).await;
        let steps = handle.snapshot().steps;
        assert!(steps.iter().all(|step| step.tool != "child_agent"));
        let returned = serde_json::to_string(&io.last_messages()).unwrap();
        assert!(
            returned.contains("cannot create child agents"),
            "{returned}"
        );
    }

    #[tokio::test]
    async fn child_retries_unclassified_queries_as_separate_read_only_calls() {
        let io = FakeIo::new(&[
            r#"<tool name="run_shell">{"command":"df -h; frobnicate --stats; ss -lnt"}</tool>"#,
            r#"<tool name="run_shell">{"command":"df -h"}</tool><tool name="run_shell">{"command":"ss -lnt"}</tool>"#,
            "Disk and listening ports checked.",
        ]);
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let mut input = parallel_input();
        input.child_run = true;
        input.permission_mode = crate::agent::PermissionMode::ReadOnly;

        let result = run_loop(&handle, &input, &io, None).await;
        assert!(result.is_ok(), "{result:?}");
        let commands = io.executed();
        assert_eq!(commands.len(), 2, "{commands:?}");
        assert!(commands.iter().any(|command| command.contains("df -h")));
        assert!(commands.iter().any(|command| command.contains("ss -lnt")));
        assert!(commands
            .iter()
            .all(|command| !command.contains("frobnicate")));
        assert!(!io.kinds().contains(&"approval_required".to_string()));

        let steps = handle.snapshot().steps;
        let retry = steps
            .iter()
            .find(|step| step.command.contains("frobnicate"))
            .unwrap();
        assert_eq!(retry.state, "skipped");
        assert_eq!(retry.category, Some(crate::agent::StepCategory::Internal));
        let feedback = serde_json::to_string(&io.last_messages()).unwrap();
        assert!(feedback.contains("frobnicate"), "{feedback}");
        assert!(!feedback.contains("WRITE_REQUEST"), "{feedback}");
    }

    #[tokio::test]
    async fn child_read_only_scope_blocks_writes_without_user_prompt() {
        let io = FakeIo::new(&[
            r#"<tool name="run_shell">{"command":"rm -rf /tmp/demo"}</tool>"#,
            "无法进行写入",
        ]);
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let mut input = parallel_input();
        input.child_run = true;
        input.permission_mode = crate::agent::PermissionMode::ReadOnly;
        input.auto_approve_writes = false;
        let _ = run_loop(&handle, &input, &io, None).await;
        assert!(io.executed().is_empty());
        assert!(!io.kinds().contains(&"approval_required".to_string()));
        // 被拦下的写操作要作为请求回到主 Agent，不能静默少做一步。
        let returned = serde_json::to_string(&io.last_messages()).unwrap();
        assert!(returned.contains("WRITE_REQUEST"), "{returned}");
    }

    /// 跨服务器子任务：每条子任务带着自己的 sessionId 执行，命令不串台。
    struct MultiServerIo {
        base: FakeIo,
        barrier: std::sync::Arc<tokio::sync::Barrier>,
        seen: Mutex<Vec<(String, String)>>,
        disconnected: Vec<String>,
    }

    impl MultiServerIo {
        fn new(disconnected: Vec<String>, parallel: bool) -> Self {
            Self {
                base: FakeIo::new(&[]),
                barrier: std::sync::Arc::new(tokio::sync::Barrier::new(if parallel {
                    2
                } else {
                    1
                })),
                seen: Mutex::new(Vec::new()),
                disconnected,
            }
        }
    }

    impl AgentIo for MultiServerIo {
        fn emit(&self, event: AgentEvent) {
            self.base.emit(event);
        }
        fn sink(&self) -> Arc<dyn Fn(AgentEvent) + Send + Sync> {
            self.base.sink()
        }
        fn connected<'a>(&'a self, id: &'a str) -> IoFuture<'a, bool> {
            Box::pin(async move { !self.disconnected.iter().any(|closed| closed == id) })
        }
        fn verify_server(&self, id: &str, server: &str) -> Result<(), String> {
            self.base.verify_server(id, server)
        }
        fn exec<'a>(
            &'a self,
            id: &'a str,
            command: &'a str,
            timeout: Duration,
            sink: UnboundedSender<ExecChunk>,
        ) -> IoFuture<'a, Result<ExecOutput, String>> {
            Box::pin(async move {
                self.seen
                    .lock()
                    .unwrap()
                    .push((id.to_string(), command.to_string()));
                tokio::time::timeout(Duration::from_secs(3), self.barrier.wait())
                    .await
                    .map_err(|_| "child operations did not overlap".to_string())?;
                self.base.exec(id, command, timeout, sink).await
            })
        }
        fn chat<'a>(
            &'a self,
            messages: Vec<Value>,
            _tools: Value,
            _cancel: &'a AiCancel,
            _delta: Arc<dyn Fn(&str) + Send + Sync>,
        ) -> IoFuture<'a, Result<ToolReply, AiProviderError>> {
            Box::pin(async move {
                let text = serde_json::to_string(&messages).unwrap();
                let has_result = text.contains("<tool_result");
                let child = text.contains("Assigned read-only investigation:");
                let content = if child {
                    if has_result {
                        "checked"
                    } else if text.contains("check disk") {
                        r#"<tool name="run_shell">{"command":"df -h"}</tool>"#
                    } else {
                        r#"<tool name="run_shell">{"command":"free -h"}</tool>"#
                    }
                } else if has_result {
                    "all checked"
                } else {
                    r#"<tool name="parallel_readonly_agents">{"tasks":[{"id":"disk","title":"disk","goal":"check disk"},{"id":"memory","title":"memory","goal":"check memory","server":"srv-b"}]}</tool>"#
                };
                Ok(ToolReply {
                    message: json!({"role":"assistant","content":content}),
                    content: content.to_string(),
                    tool_calls: Vec::new(),
                })
            })
        }
    }

    fn multi_server_input() -> AgentInput {
        let mut input = parallel_input();
        input.session_id = "ssh-a".to_string();
        input.server = "prod".to_string();
        input.server_id = Some("srv-a".to_string());
        input.servers = vec![
            AgentServerRef {
                server_id: "srv-a".into(),
                server_name: "prod".into(),
                session_id: "ssh-a".into(),
            },
            AgentServerRef {
                server_id: "srv-b".into(),
                server_name: "test".into(),
                session_id: "ssh-b".into(),
            },
        ];
        input
    }

    #[tokio::test]
    async fn children_on_different_servers_keep_their_sessions_apart() {
        let io = MultiServerIo::new(Vec::new(), true);
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let input = multi_server_input();
        let result = run_loop(&handle, &input, &io, None).await;
        assert!(result.is_ok(), "{result:?}");
        let seen = io.seen.lock().unwrap().clone();
        assert!(
            seen.iter()
                .any(|(session, command)| session == "ssh-a" && command.contains("df -h")),
            "{seen:?}"
        );
        assert!(
            seen.iter()
                .any(|(session, command)| session == "ssh-b" && command.contains("free -h")),
            "{seen:?}"
        );
        // 不同服务器各跑各的，没有把命令发到另一条会话。
        assert_eq!(
            seen.iter()
                .filter(|(_, command)| command.contains("df -h"))
                .count(),
            1
        );
        assert_eq!(
            seen.iter()
                .filter(|(_, command)| command.contains("free -h"))
                .count(),
            1
        );
        let steps = handle.snapshot().steps;
        let memory = steps
            .iter()
            .find(|step| step.tool == "child_agent" && step.child_id.as_deref() == Some("memory"))
            .unwrap();
        assert_eq!(memory.server.as_deref(), Some("test"));
        assert_eq!(memory.server_id.as_deref(), Some("srv-b"));
        assert_eq!(memory.state, "success");
    }

    #[tokio::test]
    async fn a_disconnected_target_only_fails_its_own_child() {
        let io = MultiServerIo::new(vec!["ssh-b".to_string()], false);
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let input = multi_server_input();
        let _ = run_loop(&handle, &input, &io, None).await;
        let seen = io.seen.lock().unwrap().clone();
        assert!(
            seen.iter().all(|(session, _)| session == "ssh-a"),
            "{seen:?}"
        );
        let steps = handle.snapshot().steps;
        let disk = steps
            .iter()
            .find(|step| step.child_id.as_deref() == Some("disk"))
            .unwrap();
        let memory = steps
            .iter()
            .find(|step| step.child_id.as_deref() == Some("memory"))
            .unwrap();
        assert_eq!(disk.state, "success");
        assert_eq!(memory.state, "failed");
        assert_eq!(memory.blocked.as_deref(), Some("server_disconnected"));
        let aggregate = steps
            .iter()
            .find(|step| step.tool == "parallel_readonly_agents")
            .unwrap();
        assert_eq!(
            aggregate.state, "failed",
            "parent must not report success when one target failed"
        );
    }

    #[tokio::test]
    async fn a_child_timeout_is_reported_as_unverified_and_the_parent_fails() {
        struct SlowChildIo {
            base: FakeIo,
        }
        impl AgentIo for SlowChildIo {
            fn emit(&self, event: AgentEvent) {
                self.base.emit(event);
            }
            fn sink(&self) -> Arc<dyn Fn(AgentEvent) + Send + Sync> {
                self.base.sink()
            }
            fn connected<'a>(&'a self, id: &'a str) -> IoFuture<'a, bool> {
                self.base.connected(id)
            }
            fn verify_server(&self, id: &str, server: &str) -> Result<(), String> {
                self.base.verify_server(id, server)
            }
            fn exec<'a>(
                &'a self,
                id: &'a str,
                command: &'a str,
                timeout: Duration,
                sink: UnboundedSender<ExecChunk>,
            ) -> IoFuture<'a, Result<ExecOutput, String>> {
                self.base.exec(id, command, timeout, sink)
            }
            fn chat<'a>(
                &'a self,
                messages: Vec<Value>,
                _tools: Value,
                _cancel: &'a AiCancel,
                _delta: Arc<dyn Fn(&str) + Send + Sync>,
            ) -> IoFuture<'a, Result<ToolReply, AiProviderError>> {
                Box::pin(async move {
                    let text = serde_json::to_string(&messages).unwrap();
                    if text.contains("Assigned read-only investigation:") {
                        tokio::time::sleep(Duration::from_secs(3)).await;
                        return Ok(ToolReply {
                            message: json!({"role":"assistant","content":"late"}),
                            content: "late".into(),
                            tool_calls: Vec::new(),
                        });
                    }
                    if text.contains("<tool_result") {
                        return Ok(ToolReply {
                            message: json!({"role":"assistant","content":"done"}),
                            content: "done".into(),
                            tool_calls: Vec::new(),
                        });
                    }
                    let content = r#"<tool name="parallel_readonly_agents">{"tasks":[{"title":"a","goal":"x"},{"title":"b","goal":"y"}]}</tool>"#;
                    Ok(ToolReply {
                        message: json!({"role":"assistant","content":content}),
                        content: content.to_string(),
                        tool_calls: Vec::new(),
                    })
                })
            }
        }
        let io = SlowChildIo {
            base: FakeIo::new(&[]),
        };
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let input = parallel_input();
        let _ = run_loop(&handle, &input, &io, None).await;
        let steps = handle.snapshot().steps;
        let children: Vec<_> = steps
            .iter()
            .filter(|step| step.tool == "child_agent")
            .collect();
        assert_eq!(children.len(), 2);
        assert!(
            children.iter().all(|step| step.state == "failed"),
            "{children:?}"
        );
        assert!(
            children
                .iter()
                .all(|step| step.stderr.contains("timed out")),
            "{children:?}"
        );
        let aggregate = steps
            .iter()
            .find(|step| step.tool == "parallel_readonly_agents")
            .unwrap();
        assert_eq!(aggregate.state, "failed");
    }

    #[tokio::test]
    async fn same_server_child_slots_are_limited_to_three() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static CURRENT: AtomicUsize = AtomicUsize::new(0);
        static MAX: AtomicUsize = AtomicUsize::new(0);
        let key = format!("limit-server-{}", crate::db::AppDb::now());
        let mut jobs = Vec::new();
        for _ in 0..4 {
            let key = key.clone();
            jobs.push(tokio::spawn(async move {
                let permit = super::super::runner::child_slot(&key).await;
                let now = CURRENT.fetch_add(1, Ordering::SeqCst) + 1;
                MAX.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(60)).await;
                CURRENT.fetch_sub(1, Ordering::SeqCst);
                drop(permit);
            }));
        }
        futures_util::future::join_all(jobs).await;
        assert_eq!(
            MAX.load(Ordering::SeqCst),
            3,
            "same server must cap concurrent child runs"
        );
    }

    #[tokio::test]
    async fn a_completed_child_from_the_previous_run_is_reused_but_marked_stale() {
        struct CachedIo {
            base: FakeIo,
        }
        impl AgentIo for CachedIo {
            fn emit(&self, event: AgentEvent) {
                self.base.emit(event);
            }
            fn sink(&self) -> Arc<dyn Fn(AgentEvent) + Send + Sync> {
                self.base.sink()
            }
            fn connected<'a>(&'a self, id: &'a str) -> IoFuture<'a, bool> {
                self.base.connected(id)
            }
            fn verify_server(&self, id: &str, server: &str) -> Result<(), String> {
                self.base.verify_server(id, server)
            }
            fn exec<'a>(
                &'a self,
                id: &'a str,
                command: &'a str,
                timeout: Duration,
                sink: UnboundedSender<ExecChunk>,
            ) -> IoFuture<'a, Result<ExecOutput, String>> {
                self.base.exec(id, command, timeout, sink)
            }
            fn chat<'a>(
                &'a self,
                messages: Vec<Value>,
                _tools: Value,
                _cancel: &'a AiCancel,
                _delta: Arc<dyn Fn(&str) + Send + Sync>,
            ) -> IoFuture<'a, Result<ToolReply, AiProviderError>> {
                Box::pin(async move {
                    let text = serde_json::to_string(&messages).unwrap();
                    let has_result = text.contains("<tool_result");
                    let child = text.contains("Assigned read-only investigation:");
                    let content = if child {
                        if has_result {
                            "checked"
                        } else if text.contains("check memory") {
                            r#"<tool name="run_shell">{"command":"free -h"}</tool>"#
                        } else {
                            r#"<tool name="run_shell">{"command":"df -h"}</tool>"#
                        }
                    } else if has_result {
                        "all checked"
                    } else {
                        r#"<tool name="parallel_readonly_agents">{"tasks":[{"id":"disk","title":"disk","goal":"check disk"},{"id":"memory","title":"memory","goal":"check memory"}]}</tool>"#
                    };
                    Ok(ToolReply {
                        message: json!({"role":"assistant","content":content}),
                        content: content.to_string(),
                        tool_calls: Vec::new(),
                    })
                })
            }
        }
        let io = CachedIo {
            base: FakeIo::new(&[]),
        };
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let mut input = parallel_input();
        input.carry_steps = vec![crate::agent::AgentStep {
            index: 0,
            tool: "child_agent".into(),
            group_id: Some("children-0".into()),
            state: "success".into(),
            child_id: Some("disk".into()),
            child_goal: Some("check disk".into()),
            server_id: input.server_id.clone(),
            stdout: "disk: previous df output".into(),
            stale: true,
            ..Default::default()
        }];
        assert!(run_loop(&handle, &input, &io, None).await.is_ok());
        let executed = io.base.executed();
        assert!(
            !executed.iter().any(|command| command.contains("df -h")),
            "cached child must not re-run: {executed:?}"
        );
        assert!(executed.iter().any(|command| command.contains("free -h")));
        let steps = handle.snapshot().steps;
        let disk = steps
            .iter()
            .find(|step| step.child_id.as_deref() == Some("disk"))
            .unwrap();
        assert_eq!(disk.state, "success");
        assert!(
            disk.stale,
            "reused result must stay marked for re-verification"
        );
        assert!(disk.stdout.contains("previous df output"));
        let aggregate = steps
            .iter()
            .find(|step| step.tool == "parallel_readonly_agents")
            .unwrap();
        assert!(
            aggregate.stale,
            "the parent report must carry the stale marker"
        );
    }

    #[tokio::test]
    async fn child_mcp_with_unknown_effect_is_not_called_and_returns_a_request() {
        struct UnknownMcpIo {
            base: FakeIo,
            calls: Mutex<usize>,
        }
        impl AgentIo for UnknownMcpIo {
            fn emit(&self, event: AgentEvent) {
                self.base.emit(event);
            }
            fn sink(&self) -> Arc<dyn Fn(AgentEvent) + Send + Sync> {
                self.base.sink()
            }
            fn connected<'a>(&'a self, id: &'a str) -> IoFuture<'a, bool> {
                self.base.connected(id)
            }
            fn verify_server(&self, id: &str, server: &str) -> Result<(), String> {
                self.base.verify_server(id, server)
            }
            fn exec<'a>(
                &'a self,
                id: &'a str,
                command: &'a str,
                timeout: Duration,
                sink: UnboundedSender<ExecChunk>,
            ) -> IoFuture<'a, Result<ExecOutput, String>> {
                self.base.exec(id, command, timeout, sink)
            }
            fn call_mcp<'a>(
                &'a self,
                binding: &'a crate::mcp::McpBinding,
                _args: &'a Value,
            ) -> IoFuture<'a, Result<String, String>> {
                Box::pin(async move {
                    *self.calls.lock().unwrap() += 1;
                    Ok(format!("called {}", binding.tool))
                })
            }
            fn chat<'a>(
                &'a self,
                messages: Vec<Value>,
                _tools: Value,
                _cancel: &'a AiCancel,
                _delta: Arc<dyn Fn(&str) + Send + Sync>,
            ) -> IoFuture<'a, Result<ToolReply, AiProviderError>> {
                Box::pin(async move {
                    let text = serde_json::to_string(&messages).unwrap();
                    let has_result = text.contains("<tool_result");
                    let child = text.contains("Assigned read-only investigation:");
                    let content = if child {
                        if has_result {
                            "attempted"
                        } else {
                            r#"<tool name="mcp__selected__delete_file">{}</tool>"#
                        }
                    } else if has_result {
                        "all checked"
                    } else {
                        r#"<tool name="parallel_readonly_agents">{"tasks":[{"title":"a","goal":"check disk"},{"title":"b","goal":"check memory"}]}</tool>"#
                    };
                    Ok(ToolReply {
                        message: json!({"role":"assistant","content":content}),
                        content: content.to_string(),
                        tool_calls: Vec::new(),
                    })
                })
            }
        }
        let io = UnknownMcpIo {
            base: FakeIo::new(&[]),
            calls: Mutex::new(0),
        };
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let mut input = parallel_input();
        input.mcp_tools = vec![crate::mcp::McpBinding {
            exposed_name: "mcp__selected__delete_file".into(),
            server_id: "selected".into(),
            server_name: "selected".into(),
            tool: "delete_file".into(),
            description: "delete a file".into(),
            input_schema: json!({"type":"object"}),
            read_only: true,
            config: crate::mcp::McpServerConfig::default(),
        }];
        let _ = run_loop(&handle, &input, &io, None).await;
        assert_eq!(
            *io.calls.lock().unwrap(),
            0,
            "unknown-effect MCP tool must not run in a child"
        );
        // 子任务不弹审批：否则多个子任务同时等待时无法可靠路由。
        assert!(!io.base.kinds().contains(&"approval_required".to_string()));
        let steps = handle.snapshot().steps;
        let children: Vec<_> = steps
            .iter()
            .filter(|step| step.tool == "child_agent")
            .collect();
        assert_eq!(children.len(), 2);
        assert!(children.iter().all(|step| step.state == "failed"));
        assert!(
            children
                .iter()
                .any(|step| step.stderr.contains("WRITE_REQUEST")),
            "blocked MCP calls must be returned to the parent as requests: {children:?}"
        );
    }

    /// 等循环挂起后表态（循环先登记再发事件，所以轮询是稳妥的握手方式）。
    fn decide_later(handle: Arc<AgentHandle>, call_id: &'static str, allow: bool) {
        tokio::spawn(async move {
            for _ in 0..400 {
                tokio::time::sleep(Duration::from_millis(5)).await;
                if handle.resolve_approval(call_id, allow) {
                    return;
                }
            }
        });
    }

    /// 连续允许接下来两次挂起（callId 随轮次变化，测试不硬编码）。
    fn allow_two_later(handle: Arc<AgentHandle>) {
        tokio::spawn(async move {
            let mut resolved = 0u8;
            for _ in 0..800 {
                tokio::time::sleep(Duration::from_millis(5)).await;
                if let Some(call_id) = handle.pending_approval() {
                    if handle.resolve_approval(&call_id, true) {
                        resolved += 1;
                        if resolved >= 2 {
                            return;
                        }
                    }
                }
            }
        });
    }

    fn cancel_later(handle: Arc<AgentHandle>) {
        tokio::spawn(async move {
            for _ in 0..400 {
                tokio::time::sleep(Duration::from_millis(5)).await;
                if handle.pending_approval().is_some() {
                    handle.cancel().cancel();
                    return;
                }
            }
        });
    }

    /// 等循环挂起问题后提交回答（questionId 由后端生成，测试不硬编码）。
    fn answer_later(handle: Arc<AgentHandle>, selected: Vec<String>, custom: Option<String>) {
        tokio::spawn(async move {
            for _ in 0..400 {
                tokio::time::sleep(Duration::from_millis(5)).await;
                if let Some(question) = handle.pending_question() {
                    let answer = question
                        .validate_answer(&selected, custom.as_deref())
                        .expect("测试回答应通过校验");
                    if handle.resolve_answer(&question.question_id, answer) {
                        return;
                    }
                }
            }
        });
    }

    /// 等循环挂起后补一句要求（模拟用户在执行中改方向）。
    fn steer_later(handle: Arc<AgentHandle>, text: &'static str) {
        tokio::spawn(async move {
            for _ in 0..400 {
                tokio::time::sleep(Duration::from_millis(5)).await;
                if handle.pending_approval().is_some() {
                    handle.push_steer(text);
                    return;
                }
            }
        });
    }

    const ASK_CALL: &str = r#"<tool name="ask_user">{"question":"查哪些环境？","kind":"multi","options":[{"id":"prod","label":"生产"},{"id":"test","label":"测试"}],"allowCustom":true}</tool>"#;
    const READ_CALL: &str = r#"<tool name="run_shell">{"command":"uname -a"}</tool>"#;
    const WRITE_CALL: &str =
        r#"<tool name="run_shell">{"command":"systemctl restart nginx"}</tool>"#;
    const SUDO_CALL: &str =
        r#"<tool name="run_shell">{"command":"sudo systemctl restart nginx"}</tool>"#;
    const UNZIP_CALL: &str =
        r#"<tool name="run_shell">{"command":"unzip -o /tmp/dist.zip -d /srv/app/staging"}</tool>"#;
    const UNZIP_EQUIVALENT_CALL: &str = r#"<tool name="run_shell">{"command":"cd /srv/app && unzip -o /tmp/dist.zip -d staging"}</tool>"#;
    const UNZIP_ONLINE_CALL: &str =
        r#"<tool name="run_shell">{"command":"unzip -o /tmp/dist.zip -d /srv/app/online"}</tool>"#;

    #[tokio::test]
    async fn a_read_command_runs_without_asking_and_reports_back() {
        let io = FakeIo::new(&[READ_CALL, "是一台 Linux 机器。"]);
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());

        let content = run_loop(&handle, &loop_input(None), &io, None)
            .await
            .unwrap();
        assert_eq!(content, "是一台 Linux 机器。");
        // 只读命令自动执行一次，且真的发到了会话上。
        assert_eq!(io.executed().len(), 1);
        assert!(io.executed()[0].contains("uname -a"));
        let steps = handle.snapshot().steps;
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].risk, "read");
        assert_eq!(steps[0].state, "success");
        // 事件按顺序：开始 → 结束，且没有确认。
        let kinds = io.kinds();
        assert!(kinds.contains(&"tool_started".to_string()));
        assert!(kinds.contains(&"tool_finished".to_string()));
        assert!(!kinds.contains(&"approval_required".to_string()));
    }

    #[tokio::test]
    async fn read_only_mode_rejects_writes_without_asking() {
        let io = FakeIo::new(&[WRITE_CALL, "那我只查状态。"]);
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let mut input = loop_input(None);
        input.permission_mode = crate::agent::PermissionMode::ReadOnly;

        let content = run_loop(&handle, &input, &io, None).await.unwrap();
        assert!(io.executed().is_empty(), "只读模式绝不下发写命令");
        assert!(
            !io.kinds().contains(&"approval_required".to_string()),
            "只读模式不产生审批"
        );
        let steps = handle.snapshot().steps;
        assert_eq!(steps[0].state, "failed");
        // 被权限拦下：可见，但不是"执行失败"。
        assert_eq!(steps[0].category, Some(StepCategory::Denied));
        assert!(
            steps[0].stderr.contains("只读"),
            "失败原因要说清：{}",
            steps[0].stderr
        );
        assert_eq!(content, "那我只查状态。");
    }

    #[tokio::test]
    async fn a_denied_write_never_reaches_the_server() {
        let io = FakeIo::new(&[WRITE_CALL, "好的，我不改。"]);
        let handle = Arc::new(AgentHandle::new(loop_snapshot(), AiCancel::new()));
        decide_later(handle.clone(), "call-0-0", false);

        let result = run_loop(&handle, &loop_input(None), &io, None).await;
        assert!(result.is_ok(), "{result:?}");
        assert!(io.executed().is_empty(), "用户拒绝后绝不执行");
        let steps = handle.snapshot().steps;
        assert_eq!(steps[0].state, "failed");
        // 用户拒绝：可见，但类别是"被拦下"，不是服务器执行失败。
        assert_eq!(steps[0].category, Some(StepCategory::Denied));
        assert_eq!(steps[0].blocked.as_deref(), Some("user_denied"));
        assert!(steps[0].stderr.contains("拒绝"), "{}", steps[0].stderr);
        // 拒绝不是失败：模型拿到原因后可以换方案，循环继续到最终答复。
        assert_eq!(result.unwrap(), "好的，我不改。");
    }

    #[tokio::test]
    async fn equivalent_unzip_commands_are_confirmed_and_executed_once() {
        let io = FakeIo::new(&[
            UNZIP_CALL,
            UNZIP_EQUIVALENT_CALL,
            "解压完成，已做只读验证。",
            READ_CALL,
            "验证完成。",
        ]);
        let handle = Arc::new(AgentHandle::new(loop_snapshot(), AiCancel::new()));
        decide_later(handle.clone(), "call-0-0", true);

        let content = run_loop(&handle, &loop_input(None), &io, None)
            .await
            .unwrap();
        assert!(content.contains("验证完成") || content.contains("解压完成"));
        assert_eq!(
            io.executed()
                .iter()
                .filter(|command| command.contains("unzip"))
                .count(),
            1,
            "等价写法只执行一次"
        );
        assert_eq!(
            io.kinds()
                .iter()
                .filter(|kind| kind.as_str() == "approval_required")
                .count(),
            1,
            "同一个解压操作只确认一次"
        );
        let steps = handle.snapshot().steps;
        let reused = steps
            .iter()
            .find(|step| {
                step.summary
                    .as_deref()
                    .is_some_and(|summary| summary.contains("复用"))
            })
            .expect("第二个等价解压应复用结果");
        assert_eq!(reused.state, "success");
    }

    #[tokio::test]
    async fn changing_the_unzip_target_asks_again_and_explains_the_change() {
        let io = FakeIo::new(&[
            UNZIP_CALL,
            UNZIP_ONLINE_CALL,
            "已改为解压到线上目录。",
            READ_CALL,
            "验证完成。",
        ]);
        let handle = Arc::new(AgentHandle::new(loop_snapshot(), AiCancel::new()));
        allow_two_later(handle.clone());

        let content = run_loop(&handle, &loop_input(None), &io, None)
            .await
            .unwrap();
        assert!(content.contains("线上") || content.contains("验证完成"));
        assert_eq!(
            io.kinds()
                .iter()
                .filter(|kind| kind.as_str() == "approval_required")
                .count(),
            2,
            "目标目录变了，必须重新确认"
        );
        let steps = handle.snapshot().steps;
        let second = steps
            .iter()
            .find(|step| step.command.contains("online"))
            .unwrap();
        assert!(
            second
                .impact
                .as_deref()
                .is_some_and(|impact| impact.contains("目标目录从")),
            "新确认卡要说明目标变化：{:?}",
            second.impact
        );
    }

    #[tokio::test]
    async fn a_failed_unzip_returns_the_real_error_and_allows_one_retry() {
        let io = FakeIo::new(&[
            UNZIP_CALL,
            UNZIP_EQUIVALENT_CALL,
            "第一次失败，重试成功。",
            READ_CALL,
            "验证完成。",
        ]);
        io.failures
            .lock()
            .expect("failures")
            .push("unzip".to_string());
        let handle = Arc::new(AgentHandle::new(loop_snapshot(), AiCancel::new()));
        decide_later(handle.clone(), "call-0-0", true);

        let content = run_loop(&handle, &loop_input(None), &io, None)
            .await
            .unwrap();
        assert!(content.contains("验证完成") || content.contains("重试成功"));
        let unzip_runs = io
            .executed()
            .iter()
            .filter(|command| command.contains("unzip"))
            .count();
        assert_eq!(unzip_runs, 2, "失败后允许一次真实重试");
        let steps = handle.snapshot().steps;
        let first = steps.first().expect("first step");
        assert_eq!(first.state, "failed");
        // 真的执行过并返回非零：这是用户可见的真实失败。
        assert_eq!(first.category, Some(StepCategory::Executed));
        assert_eq!(first.exit_code, Some(1));
        assert!(first.stderr.contains("模拟失败"), "{}", first.stderr);
        assert_eq!(
            io.kinds()
                .iter()
                .filter(|kind| kind.as_str() == "approval_required")
                .count(),
            1,
            "重试同一操作不再重复确认"
        );
    }

    /// SSH 中断后的写操作结果不确定：必须先只读核对，核对前不允许自动重放。
    #[tokio::test]
    async fn an_uncertain_write_must_be_verified_before_it_is_retried() {
        let io = FakeIo::new(&[
            UNZIP_CALL,
            // 没有核对就重交等价命令：应当被拦下（不重复写）。
            UNZIP_EQUIVALENT_CALL,
            READ_CALL,
            // 核对后再重试：这次允许真正执行。
            UNZIP_EQUIVALENT_CALL,
            "已核对并完成。",
            // 写入后按平台要求补一次只读验证（只催一次）。
            READ_CALL,
            "验证完成。",
        ]);
        io.failures
            .lock()
            .expect("failures")
            .push("io:unzip".to_string());
        let handle = Arc::new(AgentHandle::new(loop_snapshot(), AiCancel::new()));
        decide_later(handle.clone(), "call-0-0", true);

        let result = run_loop(&handle, &loop_input(None), &io, None).await;
        let executed = io.executed();
        assert!(
            result.is_ok(),
            "loop failed: {result:?}; executed={executed:?}"
        );
        let content = result.unwrap();
        assert!(content.contains("核对") || content.contains("完成"));

        // 第一次：连接中断；第二次：被"先核对"拦下；第三次（核对后）：正常执行。
        assert_eq!(
            io.executed()
                .iter()
                .filter(|command| command.contains("unzip"))
                .count(),
            2,
            "不确定的写操作不能自动重放：{:?}",
            io.executed()
        );
        let steps = handle.snapshot().steps;
        let blocked = steps
            .iter()
            .find(|step| step.category == Some(StepCategory::Internal))
            .expect("拦截应标记为内部调整");
        assert_eq!(
            blocked.blocked.as_deref(),
            Some("uncertain"),
            "内部拦截要带结构化原因，界面才能写清为什么没执行"
        );
        /*
         * 给模型看的指令不能变成步骤标题：`summary` 是界面上的操作名，
         * 一旦写进"请先做只读核对…"这类句子，用户会以为这是自己的操作。
         */
        assert!(
            blocked
                .summary
                .as_deref()
                .map(|text| !text.contains("请先"))
                .unwrap_or(true),
            "内部纠错的指令不能写进用户可见标题：{:?}",
            blocked.summary
        );
        assert!(
            blocked.stderr.contains("核对"),
            "完整原因仍要留在可展开的诊断里：{}",
            blocked.stderr
        );
    }

    #[tokio::test]
    async fn a_denied_unzip_cannot_be_resubmitted_with_an_equivalent_command() {
        let io = FakeIo::new(&[UNZIP_CALL, UNZIP_EQUIVALENT_CALL, "好的，不执行解压。"]);
        let handle = Arc::new(AgentHandle::new(loop_snapshot(), AiCancel::new()));
        decide_later(handle.clone(), "call-0-0", false);

        let content = run_loop(&handle, &loop_input(None), &io, None)
            .await
            .unwrap();
        assert_eq!(content, "好的，不执行解压。");
        assert!(
            io.executed()
                .iter()
                .all(|command| !command.contains("unzip")),
            "拒绝后等价写法也不能执行"
        );
        assert_eq!(
            io.kinds()
                .iter()
                .filter(|kind| kind.as_str() == "approval_required")
                .count(),
            1,
            "拒绝过的等价操作不再重新发起审批"
        );
    }

    #[tokio::test]
    async fn an_approved_write_runs_exactly_once() {
        // 改写后执行器会催一次只读验证：补一条验证命令与最终答复。
        let io = FakeIo::new(&[WRITE_CALL, "已经重启。", READ_CALL, "验证通过：服务正常。"]);
        let handle = Arc::new(AgentHandle::new(loop_snapshot(), AiCancel::new()));
        decide_later(handle.clone(), "call-0-0", true);

        let result = run_loop(&handle, &loop_input(None), &io, None).await;
        assert_eq!(result.unwrap(), "验证通过：服务正常。");
        let executed = io.executed();
        assert_eq!(
            executed
                .iter()
                .filter(|command| command.contains("systemctl restart nginx"))
                .count(),
            1,
            "确认之后只执行一次"
        );
        assert!(executed[0].contains("systemctl restart nginx"));
        assert_eq!(handle.snapshot().steps[0].risk, "write");
        assert_eq!(handle.snapshot().steps[0].state, "success");
    }

    fn outcome_step(index: u32, risk: &str, state: &str, command: &str) -> crate::agent::AgentStep {
        crate::agent::AgentStep {
            index,
            risk: risk.to_string(),
            state: state.to_string(),
            command: command.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn a_write_without_a_later_read_is_only_partially_verified() {
        let steps = vec![
            outcome_step(0, "read", "success", "cat /etc/nginx/nginx.conf"),
            outcome_step(1, "write", "success", "systemctl restart nginx"),
        ];
        let outcome = evaluate_outcome(&steps, false, Lang::Zh).unwrap();
        assert_eq!(outcome.level, "partial");
        assert!(outcome.reason.contains("没有只读验证"));
        assert!(outcome
            .evidence
            .iter()
            .any(|item| item.contains("systemctl")));
    }

    #[test]
    fn a_write_followed_by_a_read_is_verified() {
        let steps = vec![
            outcome_step(0, "write", "success", "systemctl restart nginx"),
            outcome_step(1, "read", "success", "systemctl status nginx"),
        ];
        let outcome = evaluate_outcome(&steps, false, Lang::Zh).unwrap();
        assert_eq!(outcome.level, "verified");
        assert!(outcome.evidence.iter().any(|item| item.contains("status")));
    }

    #[test]
    fn a_query_without_any_step_has_no_server_evidence() {
        let outcome = evaluate_outcome(&[], true, Lang::Zh).unwrap();
        assert_eq!(outcome.level, "needs_info");
        assert!(outcome.reason.contains("没有执行任何只读检查"));
    }

    #[test]
    fn a_trailing_failure_keeps_the_result_partial() {
        let steps = vec![
            outcome_step(0, "read", "success", "docker ps"),
            outcome_step(1, "read", "failed", "docker inspect ops-web"),
        ];
        let outcome = evaluate_outcome(&steps, false, Lang::Zh).unwrap();
        assert_eq!(outcome.level, "partial");
        assert!(outcome.reason.contains("最后一次失败"));
    }

    #[test]
    fn a_failed_child_dispatch_keeps_the_parent_partial_even_after_a_later_read() {
        let mut dispatch = outcome_step(0, "read", "failed", "parallel_readonly_agents");
        dispatch.tool = "parallel_readonly_agents".into();
        let mut later_batch = outcome_step(1, "read", "success", "parallel_readonly_agents");
        later_batch.tool = "parallel_readonly_agents".into();
        let steps = vec![
            dispatch,
            later_batch,
            outcome_step(2, "read", "success", "curl -fsS localhost/health"),
        ];
        let outcome = evaluate_outcome(&steps, false, Lang::Zh).unwrap();
        assert_eq!(outcome.level, "partial");
        assert!(outcome.reason.contains("子任务"), "{}", outcome.reason);
    }

    #[test]
    fn a_child_on_another_server_does_not_verify_a_parent_write() {
        let mut child = outcome_step(1, "read", "success", "");
        child.tool = "child_agent".into();
        child.server_id = Some("other-server".into());
        let steps = vec![
            outcome_step(0, "write", "success", "systemctl reload nginx"),
            child,
        ];
        let outcome = evaluate_outcome(&steps, false, Lang::En).unwrap();
        assert_eq!(outcome.level, "partial");
        assert!(outcome.reason.contains("no read-only verification"));
    }

    #[test]
    fn stale_child_results_cannot_be_reported_as_verified_current_facts() {
        let mut dispatch = outcome_step(0, "read", "success", "parallel_readonly_agents");
        dispatch.tool = "parallel_readonly_agents".into();
        dispatch.stale = true;
        let steps = vec![
            dispatch,
            outcome_step(1, "read", "success", "curl -fsS localhost/health"),
        ];
        let outcome = evaluate_outcome(&steps, false, Lang::Zh).unwrap();
        assert_eq!(outcome.level, "partial");
        assert!(outcome.reason.contains("中断前"), "{}", outcome.reason);
    }

    #[tokio::test]
    async fn a_steer_withdraws_the_pending_write_and_reaches_the_next_round() {
        let io = FakeIo::new(&[WRITE_CALL, "只查了容器里的服务。"]);
        let handle = Arc::new(AgentHandle::new(loop_snapshot(), AiCancel::new()));
        steer_later(handle.clone(), "只看容器里的");

        let result = run_loop(&handle, &loop_input(None), &io, None).await;
        assert_eq!(result.unwrap(), "只查了容器里的服务。");
        assert!(io.executed().is_empty(), "撤回的写操作绝不能执行");
        assert_eq!(handle.snapshot().steps[0].state, "skipped");
        assert!(
            io.kinds().contains(&"approval_withdrawn".to_string()),
            "界面要能收到撤回事件"
        );
        let sent = io.last_messages();
        assert!(
            sent.iter().any(|message| {
                message["role"] == "user"
                    && message["content"]
                        .as_str()
                        .is_some_and(|text| text.contains("【任务更新】只看容器里的"))
            }),
            "下一轮请求必须带上补充要求：{sent:?}"
        );
    }

    #[tokio::test]
    async fn resuming_continues_step_indexes_after_the_checkpoint() {
        let io = FakeIo::new(&[READ_CALL, "从检查点继续完成。"]);
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let mut input = loop_input(None);
        input.carry_steps = vec![outcome_step(0, "read", "success", "uname -a")];

        let content = run_loop(&handle, &input, &io, None).await.unwrap();
        assert_eq!(content, "从检查点继续完成。");
        let steps = handle.snapshot().steps;
        assert_eq!(steps.len(), 1);
        // 历史里已有 #1，新步骤必须从 #2 开始，不能按 index 覆盖旧步骤。
        assert_eq!(steps[0].index, 1);
    }

    #[tokio::test]
    async fn finishing_after_a_write_asks_for_verification_once() {
        // 写入 → 模型直接收尾 → 执行器催一次只读验证 → 模型补验 → 才成功。
        let io = FakeIo::new(&[WRITE_CALL, "改好了。", READ_CALL, "已验证：服务正常。"]);
        let handle = Arc::new(AgentHandle::new(loop_snapshot(), AiCancel::new()));
        decide_later(handle.clone(), "call-0-0", true);

        let content = run_loop(&handle, &loop_input(None), &io, None)
            .await
            .unwrap();
        assert_eq!(content, "已验证：服务正常。");
        assert_eq!(io.executed().len(), 2, "改写后必须再跑一条只读验证");
        assert!(io.executed()[1].contains("uname -a"));
        let snapshot = handle.snapshot();
        assert_eq!(snapshot.outcome.unwrap().level, "verified");
        // 催验证是追加给模型的要求，不是把任务判失败。
        assert!(!io.kinds().contains(&"failed".to_string()));
    }

    #[tokio::test]
    async fn cancelling_while_waiting_stops_without_running_anything() {
        let io = FakeIo::new(&[WRITE_CALL]);
        let handle = Arc::new(AgentHandle::new(loop_snapshot(), AiCancel::new()));
        cancel_later(handle.clone());

        let result = run_loop(&handle, &loop_input(None), &io, None).await;
        assert!(
            matches!(result, Err(StopReason::Cancelled(ref message)) if message.contains("已停止")),
            "{result:?}"
        );
        assert!(io.executed().is_empty(), "取消后命令不能发出去");
        assert_eq!(handle.snapshot().steps[0].state, "failed");
    }

    #[tokio::test]
    async fn the_round_limit_fails_and_names_the_last_command() {
        // 每一轮都只要工具，永远给不出结论。
        // 各轮命令必须不同：执行器有"同一命令不跑第二遍"的硬约束，
        // 重复命令会被跳过，测不到轮数上限。
        let io = FakeIo::new(&[
            READ_CALL,
            r#"<tool name="run_shell">{"command":"df -h"}</tool>"#,
            READ_CALL,
            r#"<tool name="run_shell">{"command":"df -h"}</tool>"#,
        ]);
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());

        let result = run_loop(&handle, &loop_input(Some(2)), &io, None).await;
        match result {
            Err(StopReason::Failed(message)) => {
                assert!(message.contains("轮"), "{message}");
                assert!(message.contains("df"), "要说清停在哪条命令：{message}");
            }
            other => panic!("应当是失败：{other:?}"),
        }
        assert_eq!(io.executed().len(), 2, "两轮各执行一条");
    }

    #[tokio::test]
    async fn a_server_mismatch_refuses_before_running_anything() {
        let mut io = FakeIo::new(&[READ_CALL, "算了。"]);
        io.server_ok = false;
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());

        let result = run_loop(&handle, &loop_input(None), &io, None).await;
        assert!(
            matches!(result, Err(StopReason::Failed(ref message)) if message.contains("不是")),
            "{result:?}"
        );
        assert!(io.executed().is_empty(), "服务器对不上就不许发命令");
    }

    #[tokio::test]
    async fn sudo_is_refused_unless_the_user_allowed_it() {
        let io = FakeIo::new(&[SUDO_CALL, "需要你手动开权限。"]);
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());

        let result = run_loop(&handle, &loop_input(None), &io, None).await;
        assert!(result.is_ok());
        assert!(io.executed().is_empty(), "sudo 默认禁用");
        assert!(handle.snapshot().steps[0].stderr.contains("sudo"));
    }

    #[tokio::test]
    async fn broken_json_is_reported_to_the_model_and_the_loop_continues() {
        let io = FakeIo::new(&[
            r#"<tool name="run_shell">{not json}</tool>"#,
            "抱歉，重来。",
        ]);
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());

        let result = run_loop(&handle, &loop_input(None), &io, None).await;
        assert_eq!(result.unwrap(), "抱歉，重来。");
        assert!(io.executed().is_empty());
        let steps = handle.snapshot().steps;
        // 参数错误是模型自己写错：内部纠正，不是服务器执行失败。
        assert_eq!(steps[0].state, "skipped");
        assert_eq!(steps[0].category, Some(StepCategory::Internal));
        assert!(steps[0].stderr.contains("JSON"), "{}", steps[0].stderr);
    }

    /// 「完全权限」：写操作**不再逐条确认**，但写文件仍然走备份命令。
    #[tokio::test]
    async fn full_permission_runs_writes_without_asking() {
        let io = FakeIo::new(&[WRITE_CALL, "已重启。", READ_CALL, "服务正常。"]);
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let mut input = loop_input(None);
        input.auto_approve_writes = true;
        input.allow_sudo = true;

        let content = run_loop(&handle, &input, &io, None).await.unwrap();
        assert_eq!(content, "服务正常。");
        assert_eq!(io.executed().len(), 2, "写操作 + 必要的只读验证");
        assert!(
            !io.kinds().contains(&"approval_required".to_string()),
            "完全权限下不该再弹确认"
        );
        assert_eq!(handle.snapshot().steps[0].state, "success");
    }

    /// 完全权限：解压发布包属于日常部署，直接执行。
    #[tokio::test]
    async fn full_permission_runs_routine_unzip_without_asking() {
        let io = FakeIo::new(&[UNZIP_CALL, "解压完成。", READ_CALL, "验证完成。"]);
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let mut input = loop_input(None);
        input.auto_approve_writes = true;
        input.allow_sudo = true;

        let content = run_loop(&handle, &input, &io, None).await.unwrap();
        assert!(content.contains("验证完成") || content.contains("解压完成"));
        assert_eq!(
            io.executed()
                .iter()
                .filter(|command| command.contains("unzip"))
                .count(),
            1
        );
        assert!(
            !io.kinds().contains(&"approval_required".to_string()),
            "日常解压不该再弹确认"
        );
    }

    /// 只读查询在两种权限下都是零确认（完全权限也不会把查询变成确认）。
    #[tokio::test]
    async fn read_only_queries_never_ask_even_under_full_permission() {
        let io = FakeIo::new(&[READ_CALL, "已列出。"]);
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let mut input = loop_input(None);
        input.auto_approve_writes = true;
        input.allow_sudo = true;

        let content = run_loop(&handle, &input, &io, None).await.unwrap();
        assert_eq!(content, "已列出。");
        assert_eq!(io.executed().len(), 1, "只读查询应直接执行");
        assert!(
            !io.kinds().contains(&"approval_required".to_string()),
            "只读查询不该弹确认"
        );
    }

    /// 「完全权限」也不能跳过防火墙这类可能失联的严重操作。
    #[tokio::test]
    async fn full_permission_still_confirms_firewall_changes() {
        let io = FakeIo::new(&[
            r#"<tool name="run_shell">{"command":"iptables -F"}</tool>"#,
            "已清空防火墙规则。",
            READ_CALL,
            "规则已确认。",
        ]);
        let handle = Arc::new(AgentHandle::new(loop_snapshot(), AiCancel::new()));
        decide_later(handle.clone(), "call-0-0", true);
        let mut input = loop_input(None);
        input.auto_approve_writes = true;
        input.allow_sudo = true;

        let content = run_loop(&handle, &input, &io, None).await.unwrap();
        assert_eq!(content, "规则已确认。");
        assert_eq!(io.executed().len(), 2, "危险操作 + 必要的只读验证");
        assert_eq!(
            io.kinds()
                .iter()
                .filter(|kind| kind.as_str() == "approval_required")
                .count(),
            1,
            "完全权限下严重操作仍要确认一次"
        );
    }

    /// 普通权限：危险操作只问一次；拒绝后绝不执行。
    #[tokio::test]
    async fn danger_needs_one_confirmation_under_normal_permission() {
        let io = FakeIo::new(&[
            r#"<tool name="run_shell">{"command":"iptables -F"}</tool>"#,
            "好的，不改防火墙。",
        ]);
        let handle = Arc::new(AgentHandle::new(loop_snapshot(), AiCancel::new()));
        decide_later(handle.clone(), "call-0-0", false);

        let result = run_loop(&handle, &loop_input(None), &io, None).await;
        assert!(result.is_ok());
        assert_eq!(
            io.kinds()
                .iter()
                .filter(|kind| kind.as_str() == "approval_required")
                .count(),
            1,
            "同一次操作只问一次"
        );
        assert!(io.executed().is_empty(), "危险操作被拒绝后不能执行");
    }

    /// 查询范围由后端从最后一条用户消息推导：查询里出现写操作直接拦下，不弹确认。
    #[tokio::test]
    async fn query_scope_blocks_writes_without_asking() {
        let io = FakeIo::new(&[WRITE_CALL, "只查到 nginx 在跑。"]);
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let mut input = loop_input(None);
        input.messages = vec![AgentTurn {
            role: "user".to_string(),
            content: "查一下当前跑了哪些服务".to_string(),
        }];

        let content = run_loop(&handle, &input, &io, None).await.unwrap();
        assert_eq!(content, "只查到 nginx 在跑。");
        assert!(io.executed().is_empty(), "只查询任务不许执行写操作");
        assert!(
            !io.kinds().contains(&"approval_required".to_string()),
            "只查询任务零确认"
        );
        assert_eq!(handle.snapshot().steps[0].state, "skipped");
    }

    /// 拒绝过的操作换一种写法也不再问：直接拦下。
    #[tokio::test]
    async fn denied_operation_is_not_asked_twice_with_a_different_spelling() {
        let io = FakeIo::new(&[UNZIP_CALL, UNZIP_EQUIVALENT_CALL, "好的，不解压这个包。"]);
        let handle = Arc::new(AgentHandle::new(loop_snapshot(), AiCancel::new()));
        decide_later(handle.clone(), "call-0-0", false);

        let result = run_loop(&handle, &loop_input(None), &io, None).await;
        assert!(result.is_ok());
        assert_eq!(
            io.kinds()
                .iter()
                .filter(|kind| kind.as_str() == "approval_required")
                .count(),
            1,
            "同一操作只问一次"
        );
        assert!(io.executed().is_empty(), "被拒绝的操作换写法也不能执行");
    }

    /// 用量归到 taskId：每请求累计、工具次数、构成与目标都在快照里。
    #[tokio::test]
    async fn usage_is_attributed_to_the_task_and_accumulates() {
        // 用原生调用：结果以 `role: tool` 回灌，才测得到 tools 这一类构成。
        let io = FakeIo {
            replies: Mutex::new(VecDeque::from(vec![
                FakeReply::Native {
                    id: "c1".to_string(),
                    name: "run_shell".to_string(),
                    arguments: r#"{"command":"uname -a"}"#.to_string(),
                },
                FakeReply::Text("完成。".to_string()),
            ])),
            executed: Mutex::new(Vec::new()),
            events: Arc::new(Mutex::new(Vec::new())),
            sent: Mutex::new(Vec::new()),
            connected: true,
            server_ok: true,
            failures: Mutex::new(Vec::new()),
        };
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());

        let content = run_loop(&handle, &loop_input(None), &io, None)
            .await
            .unwrap();
        assert_eq!(content, "完成。");

        let context = handle.snapshot().context.expect("应当记录上下文用量");
        assert_eq!(context.goal, "处理这台机器");
        assert_eq!(context.cumulative.requests, 2, "工具轮 + 收尾轮");
        assert!(context.cumulative.input_tokens > 0);
        assert!(context.cumulative.output_tokens > 0);
        assert_eq!(context.tool_calls, 1);
        assert!(context.breakdown.system > 0);
        assert!(context.breakdown.history > 0);
        assert!(context.breakdown.tools > 0);
    }

    /// 续跑同一个 taskId 时，累计用量从 carry_usage 接着加，不重新从 0 开始。
    #[tokio::test]
    async fn carried_usage_continues_on_the_same_task() {
        let io = FakeIo::new(&["继续。"]);
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let mut input = loop_input(None);
        input.carry_usage = Some(TokenUsage {
            requests: 4,
            input_tokens: 1000,
            output_tokens: 200,
        });

        run_loop(&handle, &input, &io, None).await.unwrap();
        let context = handle.snapshot().context.expect("应当记录上下文用量");
        assert_eq!(context.cumulative.requests, 5);
        assert!(context.cumulative.input_tokens > 1000);
        assert!(context.cumulative.output_tokens > 200);
    }

    /// 混合目标：不能因为一个"只查"就把整条消息锁成只读，也不能因为一个
    /// "重启"就把纯查询当成改动。
    #[test]
    fn query_scope_handles_mixed_goals_instead_of_one_keyword() {
        let turn = |text: &str| AgentTurn {
            role: "user".to_string(),
            content: text.to_string(),
        };
        // 明确要改另一项 → 整体不是只查询（写操作照常走权限，由用户决定）。
        assert!(!is_query_only(&[turn(
            "只查 nginx 的状态，然后重启 api 服务"
        )]));
        assert!(!is_query_only(&[turn("先查一下磁盘占用，再清理旧日志")]));
        assert!(!is_query_only(&[turn("查看日志并删除旧文件")]));
        assert!(!is_query_only(&[turn("看看状态，然后把旧日志清掉")]));
        // 动词只是宾语 / 被否定 → 仍然是纯查询。
        assert!(is_query_only(&[turn("查一下最近的重启记录")]));
        assert!(is_query_only(&[turn("只查 nginx 状态")]));
        assert!(is_query_only(&[turn("不要重启 nginx，先看看状态")]));
        assert!(is_query_only(&[turn("不要动任何东西，只读检查")]));
    }

    /// AI 声明"只读"但命令里有写：平台把冲突回给模型，不直接问用户。
    #[tokio::test]
    async fn a_read_declaration_on_a_write_command_is_bounced_back() {
        let io = FakeIo {
            replies: Mutex::new(VecDeque::from(vec![
                FakeReply::Native {
                    id: "call_1".to_string(),
                    name: "run_shell".to_string(),
                    arguments:
                        r#"{"command":"rm -f /srv/app/x","intent":"read","purpose":"看看目录"}"#
                            .to_string(),
                },
                FakeReply::Native {
                    id: "call_2".to_string(),
                    name: "run_shell".to_string(),
                    // 改成真的只读，并且这次声明对得上。
                    arguments: r#"{"command":"docker ps","intent":"read","purpose":"列出容器"}"#
                        .to_string(),
                },
                FakeReply::Text("容器正常。".to_string()),
            ])),
            executed: Mutex::new(Vec::new()),
            events: Arc::new(Mutex::new(Vec::new())),
            sent: Mutex::new(Vec::new()),
            connected: true,
            server_ok: true,
            failures: Mutex::new(Vec::new()),
        };
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let content = run_loop(&handle, &loop_input(None), &io, None)
            .await
            .unwrap();
        assert_eq!(content, "容器正常。");

        let executed = io.executed();
        assert_eq!(executed.len(), 1, "写命令不该被执行：{executed:?}");
        assert!(executed[0].contains("docker ps"), "{executed:?}");

        let sent = io.sent.lock().expect("sent");
        let tool_text = sent
            .iter()
            .flatten()
            .filter(|message| message.get("role").and_then(Value::as_str) == Some("tool"))
            .filter_map(|message| message.get("content").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(tool_text.contains("intent=read"), "{tool_text}");
        assert!(tool_text.contains("写操作"), "{tool_text}");
        assert!(!io.kinds().contains(&"approval_required".to_string()));

        /*
         * 打回是**内部纠错**：命令没执行，步骤不能落成用户可见的"执行失败"，
         * 否则聊天里会刷一张红色失败卡，看起来像服务器报错。
         */
        let steps = handle.snapshot().steps;
        assert_eq!(steps[0].state, "skipped");
        assert_eq!(steps[0].category, Some(StepCategory::Internal));
        assert!(
            steps.iter().all(|step| step.state != "failed"),
            "内部纠错不能标成失败：{steps:?}"
        );
    }

    /// 看不懂的命令**先打回给模型**（不直接弹确认）；模型改成只读命令后正常执行。
    #[tokio::test]
    async fn unclear_commands_are_bounced_back_to_the_model_before_asking() {
        let io = FakeIo {
            replies: Mutex::new(VecDeque::from(vec![
                FakeReply::Native {
                    id: "call_1".to_string(),
                    name: "run_shell".to_string(),
                    arguments: r#"{"command":"frobnicate --do-stuff"}"#.to_string(),
                },
                FakeReply::Native {
                    id: "call_2".to_string(),
                    name: "run_shell".to_string(),
                    arguments: r#"{"command":"docker ps"}"#.to_string(),
                },
                FakeReply::Text("容器正常。".to_string()),
            ])),
            executed: Mutex::new(Vec::new()),
            events: Arc::new(Mutex::new(Vec::new())),
            sent: Mutex::new(Vec::new()),
            connected: true,
            server_ok: true,
            failures: Mutex::new(Vec::new()),
        };
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let content = run_loop(&handle, &loop_input(None), &io, None)
            .await
            .unwrap();
        assert_eq!(content, "容器正常。");

        // 只有第二条（只读）真的下发；看不懂的那条被拦下。
        let executed = io.executed();
        assert_eq!(executed.len(), 1, "{executed:?}");
        assert!(executed[0].contains("docker ps"), "{executed:?}");

        // 模型拿到了原因和片段，而且**没有**弹确认打扰用户。
        let sent = io.sent.lock().expect("sent");
        let tool_text = sent
            .iter()
            .flatten()
            .filter(|message| message.get("role").and_then(Value::as_str) == Some("tool"))
            .filter_map(|message| message.get("content").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(tool_text.contains("无法判断"), "{tool_text}");
        assert!(tool_text.contains("frobnicate"), "{tool_text}");
        assert!(!io.kinds().contains(&"approval_required".to_string()));

        // 同样是内部纠错：保留完整原因，但不显示成服务器执行失败。
        let steps = handle.snapshot().steps;
        assert_eq!(steps[0].state, "skipped");
        assert_eq!(steps[0].category, Some(StepCategory::Internal));
        assert!(
            steps[0].stderr.contains("无法判断"),
            "{:?}",
            steps[0].stderr
        );
    }

    /// 范围判据只看最后一条**真人**消息；平台回执不改变范围。
    #[test]
    fn query_scope_follows_the_last_human_message() {
        let turn = |text: &str| AgentTurn {
            role: "user".to_string(),
            content: text.to_string(),
        };
        assert!(is_query_only(&[turn("查一下当前跑了哪些服务")]));
        assert!(is_query_only(&[turn("看看 nginx 状态，不要改")]));
        assert!(!is_query_only(&[turn("重启 OPS 服务")]));
        assert!(!is_query_only(&[turn("查一下然后重启 nginx")]));
        assert!(is_query_only(&[
            turn("查一下当前跑了哪些服务"),
            turn("【执行结果】\n命令已执行"),
        ]));
    }

    /// 原生 `tool_calls`（标准 function calling）走同一条执行路径，
    /// 结果必须以 `role: tool` + 原 call id 回灌。
    #[tokio::test]
    async fn native_tool_calls_run_and_feed_back_as_tool_messages() {
        let io = FakeIo {
            replies: Mutex::new(VecDeque::from(vec![
                FakeReply::Native {
                    id: "call_abc".to_string(),
                    name: "run_shell".to_string(),
                    arguments: r#"{"command":"uname -a"}"#.to_string(),
                },
                FakeReply::Text("机器正常。".to_string()),
            ])),
            executed: Mutex::new(Vec::new()),
            events: Arc::new(Mutex::new(Vec::new())),
            sent: Mutex::new(Vec::new()),
            connected: true,
            server_ok: true,
            failures: Mutex::new(Vec::new()),
        };
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());

        let content = run_loop(&handle, &loop_input(None), &io, None)
            .await
            .unwrap();
        assert_eq!(content, "机器正常。");
        assert_eq!(io.executed().len(), 1);
        assert_eq!(handle.snapshot().steps[0].call_id, "call_abc");
        let roles = io.last_roles();
        assert!(
            roles.contains(&"tool".to_string()),
            "原生调用必须用 role: tool 回灌：{roles:?}"
        );
    }

    #[tokio::test]
    async fn ask_user_waits_pauses_execution_and_continues_with_the_answer() {
        let io = FakeIo::new(&[ASK_CALL, "按生产环境继续。"]);
        let handle = Arc::new(AgentHandle::new(loop_snapshot(), AiCancel::new()));
        answer_later(
            handle.clone(),
            vec!["prod".to_string()],
            Some("  先看最近一小时  ".to_string()),
        );

        let content = run_loop(&handle, &loop_input(None), &io, None)
            .await
            .unwrap();
        assert_eq!(content, "按生产环境继续。");
        // 问题不是命令：挂起期间什么都不能下发。
        assert!(io.executed().is_empty());
        let kinds = io.kinds();
        assert!(kinds.contains(&"question_required".to_string()));
        assert!(kinds.contains(&"question_answered".to_string()));
        // 回答（选项 id + 自定义文字）必须回灌给模型。
        let sent = io.last_messages();
        let text = serde_json::to_string(&sent).unwrap();
        assert!(text.contains("prod"), "{text}");
        assert!(text.contains("先看最近一小时"), "{text}");
        assert!(handle.snapshot().pending_question.is_none());
    }

    #[tokio::test]
    async fn an_invalid_question_is_returned_to_the_model_without_pausing() {
        let bad = r#"<tool name="ask_user">{"question":"","kind":"single","options":[],"allowCustom":false}</tool>"#;
        let io = FakeIo::new(&[bad, "我改成一句普通回答。"]);
        let handle = Arc::new(AgentHandle::new(loop_snapshot(), AiCancel::new()));

        let content = run_loop(&handle, &loop_input(None), &io, None)
            .await
            .unwrap();
        assert_eq!(content, "我改成一句普通回答。");
        assert!(!io.kinds().contains(&"question_required".to_string()));
        assert!(handle.snapshot().pending_question.is_none());
    }

    /// 确认卡倒计时以后端为准：事件与快照带**同一个**截止时刻，
    /// 且 = 挂起时刻 + APPROVAL_SECONDS（重进恢复时不能重新起算 5 分钟）。
    #[tokio::test]
    async fn pending_approval_carries_a_shared_deadline() {
        let io = FakeIo::new(&[WRITE_CALL, "好的，改完了。", READ_CALL, "验证通过。"]);
        let handle = Arc::new(AgentHandle::new(loop_snapshot(), AiCancel::new()));
        let probe = handle.clone();
        let observed = tokio::spawn(async move {
            for _ in 0..400 {
                tokio::time::sleep(Duration::from_millis(5)).await;
                if let Some(pending) = probe.snapshot().pending_approval {
                    let resolved = probe.resolve_approval("call-0-0", true);
                    return (pending.deadline, resolved);
                }
            }
            panic!("确认一直没有挂起");
        });

        let before = crate::db::AppDb::now();
        let result = run_loop(&handle, &loop_input(None), &io, None).await;
        assert!(result.is_ok(), "{result:?}");
        let (deadline, resolved) = observed.await.unwrap();
        assert!(resolved);

        let span = (super::super::protocol::APPROVAL_SECONDS as i64) * 1000;
        assert!(deadline >= before + span, "deadline 早于挂起时刻 + 5min");
        assert!(
            deadline <= crate::db::AppDb::now() + span,
            "deadline 晚于现在 + 5min"
        );
        let event_deadline = io
            .events
            .lock()
            .unwrap()
            .iter()
            .find(|event| event.kind == "approval_required")
            .and_then(|event| event.deadline);
        assert_eq!(
            event_deadline,
            Some(deadline),
            "事件与快照必须是同一个截止时刻"
        );
    }

    /* ---------------- MAX 强制计划 / 执行前说明 ---------------- */

    const PLAN_CALL: &str = r#"<tool name="submit_plan">{"understanding":"查机器","summary":"先探查","steps":[{"id":"s1","title":"检查机器","action":"uname -a","verify":"拿到内核信息","kind":"probe"}]}</tool>"#;
    const STEP_READ_CALL: &str =
        r#"<tool name="run_shell">{"command":"uname -a","step":"s1"}</tool>"#;
    const STEP_WRITE_CALL: &str =
        r#"<tool name="run_shell">{"command":"systemctl restart nginx","step":"s1"}</tool>"#;

    /// MAX：计划之前任何工具都不下发；提交后带 step 的工具才执行。
    #[tokio::test]
    async fn max_tools_wait_for_a_plan_and_then_run_the_step() {
        let io = FakeIo::new(&[READ_CALL, PLAN_CALL, STEP_READ_CALL, "机器是 Linux。"]);
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let mut input = loop_input(None);
        input.plan_required = true;

        let content = run_loop(&handle, &input, &io, None).await.unwrap();
        assert_eq!(content, "机器是 Linux。");
        assert_eq!(io.executed().len(), 1, "计划前的那条命令绝不能下发");
        assert!(
            io.kinds().contains(&"plan_updated".to_string()),
            "计划提交与状态变化都要推给界面"
        );
        let plan = handle.snapshot().plan.expect("快照里要有计划");
        assert_eq!(plan.steps.len(), 1);
        assert_eq!(plan.steps[0].state, "done", "工具成功后计划步骤才算完成");

        let started = io
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.kind == "tool_started")
            .last()
            .cloned()
            .expect("应当有 tool_started");
        assert_eq!(started.plan_step_id.as_deref(), Some("s1"));
        assert_eq!(started.group_id.as_deref(), Some("p-s1"));
        // 模型只发了工具、没有正文：执行器补一句说明，且与工具同组。
        assert!(started.note.is_some(), "无正文时要有执行前说明");
    }

    /// 计划里不存在的 step id：命令不下发，计划状态不动。
    #[tokio::test]
    async fn a_tool_with_an_unknown_step_is_not_executed() {
        let io = FakeIo::new(&[
            PLAN_CALL,
            r#"<tool name="run_shell">{"command":"uname -a","step":"s9"}</tool>"#,
            "没有执行。",
        ]);
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());
        let mut input = loop_input(None);
        input.plan_required = true;

        let content = run_loop(&handle, &input, &io, None).await.unwrap();
        assert_eq!(content, "没有执行。");
        assert!(io.executed().is_empty(), "未知步骤的命令不能执行");
        assert_eq!(handle.snapshot().plan.unwrap().steps[0].state, "pending");
        assert!(
            io.last_messages().iter().any(|message| message["content"]
                .as_str()
                .unwrap_or("")
                .contains("缺少有效的 step")),
            "要给模型明确原因"
        );
    }

    /// 连续几轮都直接调工具：说明只出现一次，组 id 保持不变。
    #[tokio::test]
    async fn a_tool_only_run_gets_one_preamble_for_the_whole_group() {
        let io = FakeIo::new(&[READ_CALL, READ_CALL, "完成。"]);
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());

        run_loop(&handle, &loop_input(None), &io, None)
            .await
            .unwrap();
        assert_eq!(io.executed().len(), 2);
        let started: Vec<_> = io
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.kind == "tool_started")
            .cloned()
            .collect();
        assert_eq!(started.len(), 2);
        assert!(started[0].note.is_some(), "第一组要有执行前说明");
        assert!(started[1].note.is_none(), "同一组不能重复说明");
        assert_eq!(started[0].group_id, started[1].group_id);
    }

    /// 模型自己写了说明：执行器不再补一句。
    #[tokio::test]
    async fn model_text_replaces_the_generated_preamble() {
        let reply = format!("我先查看机器信息，确认系统版本。\n{READ_CALL}");
        let io = FakeIo::new(&[reply.as_str(), "机器正常。"]);
        let handle = AgentHandle::new(loop_snapshot(), AiCancel::new());

        run_loop(&handle, &loop_input(None), &io, None)
            .await
            .unwrap();
        let started = io
            .events
            .lock()
            .unwrap()
            .iter()
            .find(|event| event.kind == "tool_started")
            .cloned()
            .expect("应当有 tool_started");
        assert!(started.group_id.is_some(), "说明与工具仍要共享组 id");
        assert!(started.note.is_none(), "已有模型说明就不再补");
    }

    /// 计划 + 写入审批：提交计划本身不弹确认，写入仍按原权限策略确认。
    #[tokio::test]
    async fn submitting_a_plan_does_not_bypass_write_approval() {
        let io = FakeIo::new(&[
            PLAN_CALL,
            STEP_WRITE_CALL,
            "改好了。",
            STEP_READ_CALL,
            "验证通过。",
        ]);
        let handle = Arc::new(AgentHandle::new(loop_snapshot(), AiCancel::new()));
        let mut input = loop_input(None);
        input.plan_required = true;
        // 第 0 轮是提交计划；写入在第 1 轮、步骤 index 0。
        decide_later(handle.clone(), "call-1-0", true);

        let content = run_loop(&handle, &input, &io, None).await.unwrap();
        assert_eq!(content, "验证通过。");
        assert_eq!(io.executed().len(), 2, "写入 + 只读验证");
        let approvals = io
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.kind == "approval_required")
            .count();
        assert_eq!(approvals, 1, "只有真实写入需要确认");
        assert_eq!(handle.snapshot().plan.unwrap().steps[0].state, "done");
    }

    #[tokio::test]
    async fn a_separate_plan_check_only_completes_the_action_it_verifies() {
        let plan = r#"<tool name="submit_plan">{"steps":[{"id":"restart","title":"重启站点","action":"重启 nginx","verify":"服务恢复 active","kind":"action"},{"id":"verify-site","title":"验证站点","action":"检查状态","verify":"取得实际状态","kind":"probe"}]}</tool>"#;
        let restart = r#"<tool name="run_shell">{"command":"systemctl restart nginx","step":"restart"}</tool>"#;
        let linked = r#"<tool name="run_shell">{"command":"systemctl is-active nginx","step":"verify-site","verifies":"restart"}</tool>"#;
        let unrelated =
            r#"<tool name="run_shell">{"command":"uptime","step":"verify-site"}</tool>"#;

        for (inspect, expected_step, expected_outcome) in [
            (linked, "done", "verified"),
            (unrelated, "verifying", "partial"),
        ] {
            let io = FakeIo::new(&[plan, restart, inspect, "执行结束。", "改动缺少验收证据。"]);
            let handle = Arc::new(AgentHandle::new(loop_snapshot(), AiCancel::new()));
            let mut input = loop_input(None);
            input.plan_required = true;
            decide_later(handle.clone(), "call-1-0", true);

            run_loop(&handle, &input, &io, None).await.unwrap();
            let snapshot = handle.snapshot();
            let plan = snapshot.plan.unwrap();
            assert_eq!(plan.step("restart").unwrap().state, expected_step);
            assert_eq!(plan.step("verify-site").unwrap().state, "done");
            assert_eq!(snapshot.outcome.unwrap().level, expected_outcome);
            assert_eq!(io.executed().len(), 2);
        }
    }

    /// 修订计划：同 id 保留已完成状态，未再提的已完成步骤也保留。
    #[test]
    fn plan_revisions_keep_completed_steps() {
        use super::super::protocol::{merge_plan, PlanDraft};

        let draft = |value: Value| serde_json::from_value::<PlanDraft>(value).unwrap();
        let first = merge_plan(
            None,
            draft(json!({
                "understanding": "检查并重启服务",
                "steps": [
                    {"id":"s1","title":"检查配置","action":"nginx -t","verify":"语法通过","kind":"probe"},
                    {"id":"s2","title":"重启","action":"systemctl restart nginx","verify":"服务 active","kind":"action"}
                ]
            })),
            100,
        )
        .unwrap();
        assert_eq!(first.revision, 1);
        let mut current = first;
        current.steps[0].state = "done".to_string();
        current.steps[0].evidence = Some("syntax is ok".to_string());

        let revised = merge_plan(
            Some(&current),
            draft(json!({
                "steps": [
                    {"id":"s2","title":"重启","action":"systemctl restart nginx","verify":"服务 active","kind":"action"},
                    {"id":"s3","title":"验证端口","action":"ss -ltnp","verify":"80 在监听","kind":"probe"}
                ]
            })),
            200,
        )
        .unwrap();
        assert_eq!(revised.revision, 2);
        let s1 = revised
            .steps
            .iter()
            .find(|step| step.id == "s1")
            .expect("完成记录要保留");
        assert_eq!(s1.state, "done");
        assert_eq!(s1.evidence.as_deref(), Some("syntax is ok"));
        assert!(revised.steps.iter().any(|step| step.id == "s3"));
    }
}

/// 文件变更审阅：预览 / 外部改动 / 回读 / 失败 / 未采集（独立子模块，见
/// `src/agent/tests/change_tests.rs`）。
#[test]
fn question_answers_follow_single_multi_and_custom_rules() {
    let question = super::protocol::PendingQuestion {
        question_id: "q1".to_string(),
        task_id: "task".to_string(),
        workspace_id: None,
        server_id: None,
        question: "选哪个？".to_string(),
        kind: "single".to_string(),
        options: vec![
            super::protocol::QuestionOption {
                id: "a".to_string(),
                label: "A".to_string(),
            },
            super::protocol::QuestionOption {
                id: "b".to_string(),
                label: "B".to_string(),
            },
        ],
        allow_custom: true,
        deadline: i64::MAX,
    };
    assert_eq!(
        question
            .validate_answer(&["a".to_string()], None)
            .unwrap()
            .selected,
        vec!["a".to_string()]
    );
    assert_eq!(
        question
            .validate_answer(&[], Some("  自定义  "))
            .unwrap()
            .custom,
        Some("自定义".to_string())
    );
    assert!(question
        .validate_answer(&["a".to_string()], Some("x"))
        .is_err());
    assert!(question.validate_answer(&[], None).is_err());
    assert!(question
        .validate_answer(&["missing".to_string()], None)
        .is_err());

    let multi = super::protocol::PendingQuestion {
        kind: "multi".to_string(),
        ..question
    };
    let both = multi
        .validate_answer(
            &["a".to_string(), "b".to_string(), "a".to_string()],
            Some("补充"),
        )
        .unwrap();
    assert_eq!(both.selected, vec!["a", "b"]);
    assert_eq!(both.custom.as_deref(), Some("补充"));
    assert!(multi.validate_answer(&[], None).is_err());
}

#[cfg(test)]
mod change_tests;

#[cfg(test)]
mod permission_decision_tests {
    use super::super::runner::{permission_decision, PermissionDecision, PermissionMode};
    use super::plan_tool;
    use serde_json::json;

    fn read() -> super::super::tools::PlannedTool {
        plan_tool("read_file", &json!({"path": "/tmp/a"}), "/tmp", 1).unwrap()
    }

    fn write() -> super::super::tools::PlannedTool {
        plan_tool(
            "write_file",
            &json!({"path": "/tmp/a", "content": "x"}),
            "/tmp",
            1,
        )
        .unwrap()
    }

    fn severe() -> super::super::tools::PlannedTool {
        plan_tool(
            "run_shell",
            &json!({"command": "systemctl restart ssh"}),
            "/tmp",
            1,
        )
        .unwrap()
    }

    #[test]
    fn three_modes_follow_the_matrix() {
        assert_eq!(
            permission_decision(PermissionMode::ReadOnly, &read(), false),
            PermissionDecision::Allow
        );
        assert_eq!(
            permission_decision(PermissionMode::ReadOnly, &write(), false),
            PermissionDecision::Block
        );
        assert_eq!(
            permission_decision(PermissionMode::Ask, &read(), false),
            PermissionDecision::Allow
        );
        assert_eq!(
            permission_decision(PermissionMode::Ask, &write(), false),
            PermissionDecision::Confirm
        );
        assert_eq!(
            permission_decision(PermissionMode::Full, &write(), true),
            PermissionDecision::Allow
        );
        // 完全访问下严重操作仍然单独确认。
        assert_eq!(
            permission_decision(PermissionMode::Full, &severe(), true),
            PermissionDecision::Confirm
        );
    }
}

/// 计划步骤只按真实执行 + 验证证据推进。
#[test]
fn plan_steps_need_write_then_verification() {
    use super::protocol::{AgentPlan, PlanStep};

    let mut plan = AgentPlan {
        steps: vec![
            PlanStep {
                id: "s1".to_string(),
                title: "替换站点".to_string(),
                action: "unzip dist.zip".to_string(),
                verify: "index.html 存在".to_string(),
                kind: "action".to_string(),
                state: "pending".to_string(),
                ..PlanStep::default()
            },
            PlanStep {
                id: "s2".to_string(),
                title: "查看目录".to_string(),
                action: "ls".to_string(),
                verify: "看到文件".to_string(),
                kind: "probe".to_string(),
                state: "pending".to_string(),
                ..PlanStep::default()
            },
        ],
        ..AgentPlan::default()
    };

    // 探测成功不能完成写入步骤。
    assert_eq!(plan.next_step_state("s1", true, true), Some("pending"));
    plan.steps[0].state = "running".to_string();
    assert_eq!(plan.next_step_state("s1", true, true), Some("pending"));
    plan.steps[0].state = "pending".to_string();
    // 写入成功也不直接算完成：等验证。
    assert_eq!(plan.next_step_state("s1", true, false), Some("verifying"));
    plan.steps[0].state = "verifying".to_string();
    // 写入之后再跑一次只读核对，才是这一步要求的验证证据。
    assert_eq!(plan.next_step_state("s1", true, true), Some("done"));
    // 失败优先于一切（包括已经写成功过）。
    assert_eq!(plan.next_step_state("s1", false, false), Some("failed"));

    // 探查步骤成功即完成。
    assert_eq!(plan.next_step_state("s2", true, true), Some("done"));
    // 不存在的步骤不推进。
    assert_eq!(plan.next_step_state("s3", true, true), None);
}

/// 归档管道必须传播失败；普通管道不能因为"没匹配到"被误判。
#[test]
fn archive_pipelines_propagate_failures_only() {
    use super::tools::wrap_with_cwd;

    let archive = wrap_with_cwd("/var/www", "unzip -o dist.zip -d . | tail -n 5");
    assert!(archive.contains("pipefail"), "{archive}");

    let plain = wrap_with_cwd("/var/www", "ps aux | grep nginx");
    assert!(!plain.contains("pipefail"), "{plain}");
}

/// 缺包 / 坏包：即使管道把退出码吞掉，也要从 stderr 认出失败。
#[test]
fn archive_errors_are_detected_from_stderr() {
    use super::tools::archive_error_hint;

    assert!(archive_error_hint(
        "unzip -o dist.zip -d /var/www | tail -n 3",
        "unzip:  cannot find or open dist.zip, dist.zip.zip or dist.zip.ZIP."
    )
    .is_some());
    assert!(archive_error_hint(
        "unzip -o dist.zip -d /var/www",
        "End-of-central-directory signature not found"
    )
    .is_some());
    assert!(archive_error_hint("unzip -o dist.zip -d /var/www", "error:  not a zipfile").is_some());
    // 普通命令的 stderr 不参与这条判定。
    assert!(archive_error_hint("systemctl restart nginx", "Job failed").is_none());
}

/// `unzip -p` 退出 0 却没有任何输出，不能当成"读到了内容"。
#[test]
fn empty_archive_read_is_not_success() {
    use super::tools::archive_read_is_empty;

    assert!(archive_read_is_empty(
        "unzip -p /opt/dist.zip index.html",
        ""
    ));
    assert!(!archive_read_is_empty(
        "unzip -p /opt/dist.zip index.html",
        "<html>"
    ));
    // 经过 grep / head 过滤时，空输出是正常的。
    assert!(!archive_read_is_empty(
        "unzip -p /opt/dist.zip index.html | grep -q root",
        ""
    ));
}

/// 归档命令按**真实动作**命名：看清单 / 校验 / 读内容 / 解压，不能一律叫"解压归档"。
#[test]
fn archive_commands_are_named_by_what_they_do() {
    use super::tools::describe_operation;
    use super::ToolRisk;

    let cases = [
        ("unzip -l /opt/dist.zip", "查看归档清单 /opt/dist.zip"),
        ("unzip -t /opt/dist.zip", "校验归档 /opt/dist.zip"),
        (
            "unzip -p /opt/dist.zip index.html",
            "读取归档内容 /opt/dist.zip",
        ),
        // zipinfo / `unzip -Z` 只是看清单，不能叫"解压归档"。
        ("zipinfo -1 /opt/dist.zip", "查看归档清单 /opt/dist.zip"),
        ("unzip -Z1 /opt/dist.zip", "查看归档清单 /opt/dist.zip"),
        // 复合只读：先 cd 再管道过滤，名称仍按归档本身。
        (
            "cd /opt && unzip -l dist.zip | head",
            "查看归档清单 /opt/dist.zip",
        ),
        (
            "unzip -o /opt/dist.zip -d /var/www",
            "将 /opt/dist.zip 解压到 /var/www",
        ),
        // 读内容 + 写重定向：确实落盘了，不能叫"读取归档内容"。
        (
            "unzip -p /opt/dist.zip index.html > /srv/index.html",
            "读取归档内容并写入文件",
        ),
        // 发布后的复合检查：主要是验证线上，不能因为末尾 unzip -p 叫成"读取归档"。
        (
            "curl -s http://example.com/ | grep -q ok; unzip -p /opt/dist.zip index.html",
            "验证发布结果",
        ),
    ];
    for (command, want) in cases {
        assert_eq!(
            describe_operation(command, ToolRisk::Write, None).as_deref(),
            Some(want),
            "{command}"
        );
    }
}
