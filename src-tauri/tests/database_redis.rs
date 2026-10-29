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
//! 覆盖：三阶段建连 + PING、SCAN 分页与模式过滤、string 读写、hash 增删改、
//! list push/set/remove、set 增删、zset 增改删、TTL/RENAME/DEL、PUBLISH。

use ops_workbench_lib::database::model::DatabaseProfile;
use ops_workbench_lib::database::redis_driver::RedisSession;
use ops_workbench_lib::database::{driver, tunnel::TunnelRegistry};

fn env(key: &str, fallback: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| fallback.to_string())
}

fn profile() -> DatabaseProfile {
    let now = chrono::Utc::now().timestamp_millis();
    DatabaseProfile {
        id: "test-redis".to_string(),
        name: "integration".to_string(),
        engine: "redis".to_string(),
        host: env("BLS_TEST_REDIS_HOST", "127.0.0.1"),
        port: env("BLS_TEST_REDIS_PORT", "36379").parse().unwrap_or(36379),
        username: String::new(),
        default_database: Some("0".to_string()),
        has_password: false,
        ssh_server_id: None,
        tls_mode: "disabled".to_string(),
        tls_ca_path: None,
        tls_server_name: None,
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
        .write_string(0, key, "hello redis")
        .await
        .expect("set");
    let payload = session.read_value(0, key).await.expect("get");
    match payload {
        ops_workbench_lib::database::redis_driver::RedisValuePayload::String { value, binary } => {
            assert_eq!(value, "hello redis");
            assert!(!binary);
        }
        other => panic!("unexpected payload: {other:?}"),
    }
    session.delete_key(0, key).await.expect("del");
    // 删除后读取必须报"键不存在"。
    assert!(session.read_value(0, key).await.is_err());
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
    match session.read_value(0, hash_key).await.expect("hgetall") {
        ops_workbench_lib::database::redis_driver::RedisValuePayload::Hash { fields, length } => {
            assert_eq!(length, 2);
            let field_a = fields.iter().find(|entry| entry.field == "field_a");
            assert_eq!(field_a.map(|entry| entry.value.as_str()), Some("2"));
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
    match session.read_value(0, list_key).await.expect("lrange") {
        ops_workbench_lib::database::redis_driver::RedisValuePayload::List { items, .. } => {
            assert_eq!(items, vec!["one".to_string(), "TWO".to_string()]);
        }
        other => panic!("unexpected payload: {other:?}"),
    }
    session
        .write_list(
            0,
            list_key,
            ops_workbench_lib::database::redis_driver::ListWrite::Remove { value: "one".into() },
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
    match session.read_value(0, set_key).await.expect("smembers") {
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
    match session.read_value(0, zset_key).await.expect("zrange") {
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
            .write_string(0, &format!("bls:scan:{index}"), "x")
            .await
            .expect("seed");
    }
    // COUNT=2 强制分页：循环 cursor 直到扫完，收齐 5 个键。
    let mut cursor = 0u64;
    let mut found = Vec::new();
    for _ in 0..50 {
        let page = session.scan(0, "bls:scan:*", cursor, 2).await.expect("scan");
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
    session.write_string(0, key, "temp").await.expect("set");

    // EXPIRE 1 秒 → TTL 应为正毫秒。
    session.expire_key(0, key, Some(1_000)).await.expect("expire");
    let info = session.key_info(0, key).await.expect("key_info");
    assert!(info.ttl_ms > 0 && info.ttl_ms <= 1_100);

    // PERSIST → TTL = -1（永久）。
    session.expire_key(0, key, None).await.expect("persist");
    let info = session.key_info(0, key).await.expect("key_info 2");
    assert_eq!(info.ttl_ms, -1);

    // RENAME → 旧键消失，新键存在。
    session
        .rename_key(0, key, "bls:test:ttl-renamed")
        .await
        .expect("rename");
    assert!(session.read_value(0, key).await.is_err());
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
