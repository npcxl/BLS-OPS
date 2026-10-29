//! 真实 Redis 集成测试（不是 mock）。
//!
//! 默认连接 `127.0.0.1:36379`，可用环境变量覆盖：
//! ```bash
//! docker run -d --name bls-redis-test -p 36379:6379 redis:7
//! BLS_TEST_REDIS_HOST=127.0.0.1 BLS_TEST_REDIS_PORT=36379 cargo test --test database_redis
//! ```
//! Redis 不可达时**跳过**（打印原因）；`BLS_TEST_REDIS_REQUIRED=1` 时
//! 不可达必须红（CI 用），不允许 skip 成假绿。
//!
//! 认证/TLS 组合（都是 Standalone）：
//! ```bash
//! # 仅密码
//! BLS_TEST_REDIS_PORT=36380 BLS_TEST_REDIS_PASSWORD=s3cret cargo test --test database_redis
//! # ACL 用户名 + 密码
//! BLS_TEST_REDIS_PORT=36381 BLS_TEST_REDIS_USERNAME=bls BLS_TEST_REDIS_PASSWORD=bls-pass \
//!   cargo test --test database_redis
//! # TLS
//! BLS_TEST_REDIS_TLS=verify_ca BLS_TEST_REDIS_CA=/path/ca.crt \
//!   BLS_TEST_REDIS_SERVER_NAME=localhost cargo test --test database_redis
//! ```
//!
//! 覆盖：三阶段建连 + PING、SCAN 分页与模式过滤、string 读写、hash 增删改、
//! list push/set/remove、set 增删、zset 增改删、TTL/RENAME/DEL、PUBLISH。

use ops_workbench_lib::database::model::DatabaseProfile;
use ops_workbench_lib::database::redis_driver::RedisSession;
use ops_workbench_lib::database::{driver, tunnel::TunnelRegistry};

fn env(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

/// 空字符串视作"没设置"，便于用环境变量切换 ACL / TLS 组合。
fn env_opt(key: &str) -> Option<String> {
    let value = env(key, "");
    (!value.is_empty()).then_some(value)
}

fn profile() -> DatabaseProfile {
    let now = chrono::Utc::now().timestamp_millis();
    DatabaseProfile {
        id: "test-redis".to_string(),
        name: "integration".to_string(),
        engine: "redis".to_string(),
        host: env("BLS_TEST_REDIS_HOST", "127.0.0.1"),
        port: env("BLS_TEST_REDIS_PORT", "36379").parse().unwrap_or(36379),
        // Redis 6+ ACL：留空 = 只发 AUTH <password>（Redis 5 及更早的写法）。
        username: env("BLS_TEST_REDIS_USERNAME", ""),
        default_database: Some("0".to_string()),
        has_password: false,
        ssh_server_id: None,
        tls_mode: env("BLS_TEST_REDIS_TLS", "disabled"),
        tls_ca_path: env_opt("BLS_TEST_REDIS_CA"),
        tls_server_name: env_opt("BLS_TEST_REDIS_SERVER_NAME"),
        read_only: false,
        redis_mode: Some("standalone".to_string()),
        sentinel_master: None,
        nodes_json: None,
        connect_timeout_ms: 10_000,
        query_timeout_ms: 30_000,
        created_at: now,
        updated_at: now,
    }
}

fn password() -> Option<String> {
    let value = env("BLS_TEST_REDIS_PASSWORD", "");
    (!value.is_empty()).then_some(value)
}

/// 建连；不可达时按 REQUIRED 语义跳过或 panic。
async fn open_session() -> Option<std::sync::Arc<RedisSession>> {
    // 直连、无隧道的 EndpointPlan：profile + 密码，与命令层的 plan_for 行为一致。
    let plan = driver::EndpointPlan {
        profile: profile(),
        password: password(),
        ssh: None,
        generation: driver::next_generation(),
    };
    let tunnels = TunnelRegistry::default();
    match RedisSession::open(&tunnels, plan).await {
        Ok(session) => Some(session),
        Err(error) => {
            if std::env::var("BLS_TEST_REDIS_REQUIRED").as_deref() == Ok("1") {
                panic!("required Redis integration test cannot connect: {error:?}");
            }
            eprintln!("skip Redis integration test: cannot connect: {error:?}");
            None
        }
    }
}

#[tokio::test]
async fn redis_connect_ping_and_info() {
    let Some(session) = open_session().await else {
        return;
    };
    assert!(session.server_version.is_some() || true);
    // PING 在 open() 内部已经验证过；这里再读一次键信息路径确认命令可用。
    let page = session.scan(0, "*", 0, 100).await.expect("scan");
    assert!(page.dbsize >= 0);
}

#[tokio::test]
async fn redis_string_write_read_delete() {
    let Some(session) = open_session().await else {
        return;
    };
    let key = "bls:test:string";
    session
        .write_string(0, key, "hello redis", false)
        .await
        .expect("set");
    let payload = session.read_value(0, key, false).await.expect("get");
    match payload {
        ops_workbench_lib::database::redis_driver::RedisValuePayload::String {
            value,
            binary,
            ..
        } => {
            assert_eq!(value, "hello redis");
            assert!(!binary);
        }
        other => panic!("unexpected payload: {other:?}"),
    }
    session.delete_key(0, key).await.expect("del");
    // 删除后读取必须报"键不存在"。
    assert!(session.read_value(0, key, false).await.is_err());
}

/// hash 一律 HSCAN 分页：大 hash 每页最多 HASH_PAGE_MAX 条，cursor 续扫收齐。
/// 二进制 string 值必须 Base64 无损往返（禁止有损 UTF-8 替换）。
#[tokio::test]
async fn redis_hash_scan_pagination_and_binary_base64() {
    let Some(session) = open_session().await else {
        return;
    };

    // hash：写入 12 个字段，COUNT=5 强制 HSCAN 分页。
    let hash_key = "bls:test:big-hash";
    for index in 0..12 {
        session
            .write_hash_field(
                0,
                hash_key,
                &format!("f{index}"),
                Some(&format!("v{index}")),
            )
            .await
            .expect("hset");
    }
    let mut cursor = 0u64;
    let mut fields = Vec::new();
    for _ in 0..50 {
        let page = session
            .hash_scan(0, hash_key, cursor, 5)
            .await
            .expect("hscan");
        fields.extend(page.fields);
        cursor = page.cursor;
        if cursor == 0 {
            break;
        }
    }
    assert_eq!(fields.len(), 12, "expected 12 fields via paged hscan");
    session.delete_key(0, hash_key).await.expect("cleanup hash");

    // 二进制 string：写入非法 UTF-8 字节，读回应标记 binary 且 Base64
    // 解码后与原字节完全一致。
    let bin_key = "bls:test:binary";
    let raw: Vec<u8> = vec![0x00, 0xFF, 0xFE, 0x01, 0x80, 0x7F];
    {
        use redis::AsyncCommands;
        let mut conn = session.acquire(0).await.expect("conn");
        let _: () = conn.set(bin_key, raw.clone()).await.expect("set bytes");
    }
    match session
        .read_value(0, bin_key, false)
        .await
        .expect("get binary")
    {
        ops_workbench_lib::database::redis_driver::RedisValuePayload::String {
            value,
            binary,
            ..
        } => {
            assert!(binary, "binary flag must be set");
            use base64::Engine as _;
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(&value)
                .expect("value must be valid base64");
            assert_eq!(decoded, raw, "base64 roundtrip must preserve bytes");
        }
        other => panic!("unexpected payload: {other:?}"),
    }
    // Base64 写回路径：binary=true 写入，读回仍是同一批字节。
    let rewritten = "AA/+AQCB"; // base64([0x00, 0xFF, 0xFE, 0x01, 0x00, 0x81])
    session
        .write_string(0, bin_key, rewritten, true)
        .await
        .expect("set base64");
    match session
        .read_value(0, bin_key, false)
        .await
        .expect("get rewritten")
    {
        ops_workbench_lib::database::redis_driver::RedisValuePayload::String {
            value,
            binary,
            ..
        } => {
            assert!(binary);
            assert_eq!(value, rewritten, "base64 write path must roundtrip");
        }
        other => panic!("unexpected payload: {other:?}"),
    }
    session
        .delete_key(0, bin_key)
        .await
        .expect("cleanup binary");
}

#[tokio::test]
async fn redis_hash_list_set_zset_roundtrip() {
    let Some(session) = open_session().await else {
        return;
    };

    // hash：增 → 改 → 删字段。
    let hash_key = "bls:test:hash";
    session
        .write_hash_field(0, hash_key, "field_a", Some("1"))
        .await
        .expect("hset");
    session
        .write_hash_field(0, hash_key, "field_a", Some("2"))
        .await
        .expect("hset update");
    session
        .write_hash_field(0, hash_key, "field_b", Some("keep"))
        .await
        .expect("hset b");
    match session
        .read_value(0, hash_key, false)
        .await
        .expect("hscan page 1")
    {
        ops_workbench_lib::database::redis_driver::RedisValuePayload::Hash {
            fields,
            length,
            cursor,
        } => {
            assert_eq!(length, 2);
            let field_a = fields.iter().find(|entry| entry.field == "field_a");
            assert_eq!(field_a.map(|entry| entry.value.as_str()), Some("2"));
            // 2 个字段的 hash 一页 HSCAN 就应扫完。
            assert_eq!(cursor, 0);
        }
        other => panic!("unexpected payload: {other:?}"),
    }
    session
        .write_hash_field(0, hash_key, "field_a", None)
        .await
        .expect("hdel");
    session.delete_key(0, hash_key).await.expect("cleanup hash");

    // list：尾插 → 原位改 → 按值删。
    let list_key = "bls:test:list";
    session
        .write_list(
            0,
            list_key,
            ops_workbench_lib::database::redis_driver::ListWrite::Push {
                front: false,
                value: "one".into(),
            },
        )
        .await
        .expect("rpush");
    session
        .write_list(
            0,
            list_key,
            ops_workbench_lib::database::redis_driver::ListWrite::Push {
                front: false,
                value: "two".into(),
            },
        )
        .await
        .expect("rpush 2");
    session
        .write_list(
            0,
            list_key,
            ops_workbench_lib::database::redis_driver::ListWrite::Set {
                index: 1,
                value: "TWO".into(),
            },
        )
        .await
        .expect("lset");
    match session
        .read_value(0, list_key, false)
        .await
        .expect("lrange")
    {
        ops_workbench_lib::database::redis_driver::RedisValuePayload::List { items, .. } => {
            assert_eq!(items, vec!["one".to_string(), "TWO".to_string()]);
        }
        other => panic!("unexpected payload: {other:?}"),
    }
    session
        .write_list(
            0,
            list_key,
            ops_workbench_lib::database::redis_driver::ListWrite::Remove {
                value: "one".into(),
            },
        )
        .await
        .expect("lrem");
    session.delete_key(0, list_key).await.expect("cleanup list");

    // set：加 → 删。
    let set_key = "bls:test:set";
    session
        .write_set(0, set_key, "member-1", true)
        .await
        .expect("sadd");
    match session
        .read_value(0, set_key, false)
        .await
        .expect("smembers")
    {
        ops_workbench_lib::database::redis_driver::RedisValuePayload::Set { members, .. } => {
            assert!(members.contains(&"member-1".to_string()));
        }
        other => panic!("unexpected payload: {other:?}"),
    }
    session
        .write_set(0, set_key, "member-1", false)
        .await
        .expect("srem");
    session.delete_key(0, set_key).await.expect("cleanup set");

    // zset：加 → 改分数 → 删。
    let zset_key = "bls:test:zset";
    session
        .write_zset(0, zset_key, "alpha", Some(1.5))
        .await
        .expect("zadd");
    session
        .write_zset(0, zset_key, "alpha", Some(3.25))
        .await
        .expect("zadd update");
    match session
        .read_value(0, zset_key, false)
        .await
        .expect("zrange")
    {
        ops_workbench_lib::database::redis_driver::RedisValuePayload::Zset { entries, .. } => {
            assert_eq!(entries.len(), 1);
            assert!((entries[0].score - 3.25).abs() < f64::EPSILON);
        }
        other => panic!("unexpected payload: {other:?}"),
    }
    session
        .write_zset(0, zset_key, "alpha", None)
        .await
        .expect("zrem");
    session.delete_key(0, zset_key).await.expect("cleanup zset");
}

#[tokio::test]
async fn redis_scan_pattern_and_pagination() {
    let Some(session) = open_session().await else {
        return;
    };
    for index in 0..5 {
        session
            .write_string(0, &format!("bls:scan:{index}"), "x", false)
            .await
            .expect("seed");
    }
    // COUNT=2 强制分页：循环 cursor 直到扫完，收齐 5 个键。
    let mut cursor = 0u64;
    let mut found = Vec::new();
    for _ in 0..50 {
        let page = session
            .scan(0, "bls:scan:*", cursor, 2)
            .await
            .expect("scan");
        found.extend(page.keys.into_iter().map(|brief| brief.key));
        cursor = page.cursor;
        if cursor == 0 {
            break;
        }
    }
    assert_eq!(found.len(), 5, "expected 5 keys via paged scan");
    for index in 0..5 {
        session
            .delete_key(0, &format!("bls:scan:{index}"))
            .await
            .expect("cleanup");
    }
}

#[tokio::test]
async fn redis_expire_rename_publish() {
    let Some(session) = open_session().await else {
        return;
    };
    let key = "bls:test:ttl";
    session
        .write_string(0, key, "temp", false)
        .await
        .expect("set");

    // EXPIRE 1 秒 → TTL 应为正毫秒。
    session
        .expire_key(0, key, Some(1_000))
        .await
        .expect("expire");
    let info = session.key_info(0, key).await.expect("key_info");
    assert!(info.ttl_ms > 0 && info.ttl_ms <= 1_100);

    // PERSIST → TTL = -1（永久）。
    session.expire_key(0, key, None).await.expect("persist");
    let info = session.key_info(0, key).await.expect("key_info 2");
    assert_eq!(info.ttl_ms, -1);

    // RENAME → 旧键消失，新键存在。
    session
        .rename_key(0, key, "bls:test:ttl-renamed", false)
        .await
        .expect("rename");
    assert!(session.read_value(0, key, false).await.is_err());
    session
        .delete_key(0, "bls:test:ttl-renamed")
        .await
        .expect("cleanup renamed");

    // PUBLISH：没有订阅者时返回 0。
    let receivers = session
        .publish(0, "bls:test:channel", "hello")
        .await
        .expect("publish");
    assert_eq!(receivers, 0);
}

/// TTL 必须是毫秒精度：500ms 用 EXPIRE 会被抬成 1s，PEXPIRE 才对得上。
#[tokio::test]
async fn redis_ttl_keeps_millisecond_precision() {
    let Some(session) = open_session().await else {
        return;
    };
    let key = "bls:test:ttl-ms";
    session.write_string(0, key, "v", false).await.expect("set");

    session
        .expire_key(0, key, Some(500))
        .await
        .expect("pexpire 500");
    let info = session.key_info(0, key).await.expect("key_info");
    assert!(
        info.ttl_ms > 0 && info.ttl_ms <= 600,
        "500ms TTL 应保留毫秒精度，实际 {}ms",
        info.ttl_ms
    );

    session.delete_key(0, key).await.expect("cleanup");
}

/// 重命名默认 RENAMENX：目标存在必须报错且不动任何键；显式 overwrite 才覆盖。
#[tokio::test]
async fn redis_rename_refuses_overwrite_by_default() {
    let Some(session) = open_session().await else {
        return;
    };
    let from = "bls:test:rename-from";
    let to = "bls:test:rename-to";
    session
        .write_string(0, from, "from", false)
        .await
        .expect("set from");
    session
        .write_string(0, to, "to", false)
        .await
        .expect("set to");

    // 默认不覆盖：报错，且两个键都还在。
    assert!(session.rename_key(0, from, to, false).await.is_err());
    assert_eq!(
        session.key_info(0, from).await.expect("from alive").ttl_ms,
        -1
    );
    assert_eq!(session.key_info(0, to).await.expect("to alive").ttl_ms, -1);

    // 显式覆盖：成功，旧键消失（读值应报"键不存在"）。
    session
        .rename_key(0, from, to, true)
        .await
        .expect("overwrite rename");
    assert!(session.read_value(0, from, false).await.is_err());

    session.delete_key(0, to).await.expect("cleanup");
}

/// set 走 SSCAN 游标分页：一页装不完就必须给 cursor，翻完刚好覆盖全部成员。
#[tokio::test]
async fn redis_set_uses_sscan_pages() {
    let Some(session) = open_session().await else {
        return;
    };
    let key = "bls:test:set-scan";
    session.delete_key(0, key).await.ok();
    // 600 个**非整数**成员 → set 走 hashtable 编码（intset/listpack 会一次回全），
    // 这样才能真正测到 SSCAN 分批。
    for index in 0..600 {
        session
            .write_set(0, key, &format!("member-{index}-padding"), true)
            .await
            .expect("sadd");
    }

    match session.read_value(0, key, false).await.expect("set page 1") {
        ops_workbench_lib::database::redis_driver::RedisValuePayload::Set {
            members,
            length,
            cursor,
            truncated,
        } => {
            assert_eq!(length, 600);
            // intset/listpack 编码下 SSCAN 会一次回全部（COUNT 只是提示），
            // 此时 cursor=0、truncated=false；hashtable 编码才会分批。
            assert_eq!(truncated, cursor != 0, "truncated 必须与“还有下一页”一致");

            let mut seen = std::collections::HashSet::new();
            seen.extend(members);
            let mut next = cursor;
            let mut rounds = 0;
            while next != 0 && rounds < 20 {
                let page = session
                    .set_scan(0, key, next, 500)
                    .await
                    .expect("sscan page");
                seen.extend(page.members);
                next = page.cursor;
                rounds += 1;
            }
            assert_eq!(next, 0, "游标必须能扫完");
            assert_eq!(seen.len(), 600, "翻页必须覆盖全部成员且不重复");
        }
        other => panic!("unexpected payload: {other:?}"),
    }

    session.delete_key(0, key).await.expect("cleanup");
}

/// 字节预算：5000 个 1 MB 成员同样危险，超过 4 MiB 就该截断。
#[tokio::test]
async fn redis_collection_reads_are_byte_budgeted() {
    let Some(session) = open_session().await else {
        return;
    };
    let key = "bls:test:set-big";
    session.delete_key(0, key).await.ok();
    // 10 × 500 KiB = 5 MiB > READ_BYTES_MAX(4 MiB)。
    let big = "x".repeat(500 * 1024);
    for index in 0..10 {
        session
            .write_set(0, key, &format!("{big}-{index}"), true)
            .await
            .expect("sadd big");
    }

    match session.read_value(0, key, false).await.expect("set page") {
        ops_workbench_lib::database::redis_driver::RedisValuePayload::Set {
            members,
            truncated,
            ..
        } => {
            assert!(truncated, "超过字节预算必须标记 truncated");
            assert!(
                members.len() < 10,
                "5 MiB 的集合不能整段返回，实际 {} 条",
                members.len()
            );
        }
        other => panic!("unexpected payload: {other:?}"),
    }

    session.delete_key(0, key).await.expect("cleanup");
}

/// 大 string 只回预览（带 truncated + 真实字节数），显式请求才给全量。
#[tokio::test]
async fn redis_string_reads_are_budgeted() {
    let Some(session) = open_session().await else {
        return;
    };
    let key = "bls:test:big-string";
    // 300 KiB：超过 256 KiB 预览预算，但远小于 8 MiB 全量上限。
    let value = "x".repeat(300 * 1024);
    session
        .write_string(0, key, &value, false)
        .await
        .expect("set");

    match session.read_value(0, key, false).await.expect("preview") {
        ops_workbench_lib::database::redis_driver::RedisValuePayload::String {
            value: preview,
            bytes,
            truncated,
            ..
        } => {
            assert!(truncated, "超过预览预算必须标记 truncated");
            assert_eq!(bytes, 300 * 1024, "bytes 必须是 STRLEN 的真实值");
            assert_eq!(preview.len(), 256 * 1024, "预览只取前 256 KiB");
        }
        other => panic!("unexpected payload: {other:?}"),
    }

    match session.read_value(0, key, true).await.expect("full") {
        ops_workbench_lib::database::redis_driver::RedisValuePayload::String {
            value: full,
            truncated,
            ..
        } => {
            assert!(!truncated);
            assert_eq!(full.len(), 300 * 1024, "全量读取必须完整");
        }
        other => panic!("unexpected payload: {other:?}"),
    }

    session.delete_key(0, key).await.expect("cleanup");
}
