//! Unit tests for the command layer, split by origin module (阶段 E):
//! the tests moved verbatim from the former monolithic `commands.rs`.

use rusqlite::Connection;

use super::deployment::validate_project;
use super::servers::validate_server;
use super::services::parse_service_action;
use super::ssh::session_record;
use super::test_support::db;
use crate::db::{
    self, insert_or_replace_server, CredentialRecord, ServerGroupRecord, ServerRecord,
};

fn server(id: &str) -> ServerRecord {
    ServerRecord {
        id: id.to_string(),
        name: "web".to_string(),
        host: "10.0.0.1".to_string(),
        port: 22,
        username: "root".to_string(),
        credential_id: None,
        group_id: None,
        tags: vec![],
        proxy_jump_id: None,
        favorite: false,
        last_connected_at: None,
        status: "idle".to_string(),
        created_at: 1,
        updated_at: 1,
    }
}

fn project(id: &str, server_id: &str) -> db::ProjectRecord {
    db::ProjectRecord {
        id: id.to_string(),
        name: "app".to_string(),
        description: String::new(),
        server_id: server_id.to_string(),
        repo_url: "https://github.com/acme/app.git".to_string(),
        branch: "main".to_string(),
        deploy_path: "/var/www/app".to_string(),
        commands_json: r#"["git pull --ff-only","npm run build"]"#.to_string(),
        status: "idle".to_string(),
        created_at: 1,
        updated_at: 1,
    }
}

fn credential(id: &str) -> CredentialRecord {
    CredentialRecord {
        id: id.to_string(),
        name: "key".to_string(),
        credential_type: "password".to_string(),
        username: "root".to_string(),
        secret_ref: Some(format!("cred-{id}")),
        passphrase_ref: None,
        created_at: 1,
        updated_at: 1,
    }
}

#[test]
fn rejects_unknown_service_actions() {
    // Only the six fixed verbs exist; anything else must not reach a shell.
    assert!(parse_service_action("restart").is_ok());
    assert!(parse_service_action("enable").is_ok());
    assert!(parse_service_action("rm -rf /").is_err());
    assert!(parse_service_action("").is_err());
}

// -- projects ------------------------------------------------------------

#[test]
fn accepts_a_well_formed_project() {
    let conn = db();
    insert_or_replace_server(&conn, &server("s1")).unwrap();
    assert!(validate_project(&conn, &project("p1", "s1")).is_ok());
}

#[test]
fn rejects_a_project_without_a_name_or_server() {
    let conn = db();
    insert_or_replace_server(&conn, &server("s1")).unwrap();

    let mut blank = project("p1", "s1");
    blank.name = "  ".to_string();
    assert!(validate_project(&conn, &blank).is_err());

    // A project pointing at a deleted server would deploy nowhere.
    assert!(validate_project(&conn, &project("p1", "missing")).is_err());
}

#[test]
fn rejects_a_relative_or_traversing_deploy_path() {
    let conn = db();
    insert_or_replace_server(&conn, &server("s1")).unwrap();

    let mut relative = project("p1", "s1");
    relative.deploy_path = "var/www/app".to_string();
    assert!(validate_project(&conn, &relative).is_err());

    let mut traversing = project("p1", "s1");
    traversing.deploy_path = "/var/www/../../etc".to_string();
    assert!(validate_project(&conn, &traversing).is_err());
}

#[test]
fn rejects_a_project_whose_steps_are_not_allowlisted() {
    let conn = db();
    insert_or_replace_server(&conn, &server("s1")).unwrap();

    let mut evil = project("p1", "s1");
    evil.commands_json = r#"["git pull; rm -rf /"]"#.to_string();
    assert!(validate_project(&conn, &evil).is_err());

    let mut outside = project("p1", "s1");
    outside.commands_json = r#"["rm -rf /var/log"]"#.to_string();
    assert!(
        validate_project(&conn, &outside).is_err(),
        "步骤不能触碰项目目录之外"
    );
}

#[test]
fn rejects_a_project_with_no_steps_or_broken_json() {
    let conn = db();
    insert_or_replace_server(&conn, &server("s1")).unwrap();

    let mut empty = project("p1", "s1");
    empty.commands_json = "[]".to_string();
    assert!(validate_project(&conn, &empty).is_err());

    let mut broken = project("p1", "s1");
    broken.commands_json = "not json".to_string();
    assert!(validate_project(&conn, &broken).is_err());
}

#[test]
fn rejects_bad_repo_urls_and_branches() {
    let conn = db();
    insert_or_replace_server(&conn, &server("s1")).unwrap();

    let mut bad_url = project("p1", "s1");
    bad_url.repo_url = "rm -rf /".to_string();
    assert!(validate_project(&conn, &bad_url).is_err());

    let mut bad_branch = project("p1", "s1");
    bad_branch.branch = "--upload-pack=evil".to_string();
    assert!(validate_project(&conn, &bad_branch).is_err());
}

#[test]
fn rejects_blank_fields_and_bad_ports() {
    let conn = db();
    let mut blank = server("s1");
    blank.name = "  ".to_string();
    assert!(validate_server(&conn, &blank).is_err());

    let mut bad_port = server("s1");
    bad_port.port = 70000;
    assert!(validate_server(&conn, &bad_port).is_err());

    assert!(validate_server(&conn, &server("s1")).is_ok());
}

#[test]
fn rejects_unknown_credential_group_and_jump_host() {
    let conn: Connection = db();

    let mut unknown_credential = server("s1");
    unknown_credential.credential_id = Some("missing".to_string());
    assert!(validate_server(&conn, &unknown_credential).is_err());

    db::insert_or_replace_credential(&conn, &credential("c1")).unwrap();
    let mut known = server("s1");
    known.credential_id = Some("c1".to_string());
    assert!(validate_server(&conn, &known).is_ok());

    let mut unknown_group = server("s1");
    unknown_group.group_id = Some("missing".to_string());
    assert!(validate_server(&conn, &unknown_group).is_err());

    db::insert_or_replace_server_group(
        &conn,
        &ServerGroupRecord {
            id: "g1".to_string(),
            name: "prod".to_string(),
            sort_order: 0,
            created_at: 1,
            updated_at: 1,
        },
    )
    .unwrap();
    let mut known_group = server("s1");
    known_group.group_id = Some("g1".to_string());
    assert!(validate_server(&conn, &known_group).is_ok());

    let mut unknown_jump = server("s1");
    unknown_jump.proxy_jump_id = Some("missing".to_string());
    assert!(validate_server(&conn, &unknown_jump).is_err());
}

#[test]
fn rejects_self_and_cyclic_jump_hosts() {
    let conn = db();
    db::insert_or_replace_server(&conn, &server("a")).unwrap();
    db::insert_or_replace_server(&conn, &server("b")).unwrap();

    let mut itself = server("a");
    itself.proxy_jump_id = Some("a".to_string());
    assert!(validate_server(&conn, &itself).is_err());

    // a -> b first, then b -> a would close a cycle.
    let mut a = server("a");
    a.proxy_jump_id = Some("b".to_string());
    db::insert_or_replace_server(&conn, &a).unwrap();
    let mut b = server("b");
    b.proxy_jump_id = Some("a".to_string());
    assert!(validate_server(&conn, &b).is_err());
}

#[test]
fn session_record_tracks_status_and_geometry() {
    let connected = session_record(
        "sess-1",
        "s1",
        "web",
        "10.0.0.1",
        22,
        "root",
        "connected",
        None,
        100,
        40,
        true,
    );
    assert_eq!(connected.status, "connected");
    assert_eq!(connected.terminal_pty, Some(true));
    assert_eq!(connected.username, "root");
    assert_eq!(connected.terminal_cols, Some(100));
    assert_eq!(connected.terminal_rows, Some(40));
    assert!(connected.connected_at.is_some());
    assert!(connected.disconnected_at.is_none());

    let failed = session_record(
        "sess-2",
        "s1",
        "web",
        "10.0.0.1",
        22,
        "root",
        "error",
        Some("认证失败".to_string()),
        80,
        24,
        true,
    );
    assert_eq!(failed.error_message.as_deref(), Some("认证失败"));
    assert!(failed.connected_at.is_none());
    assert!(failed.disconnected_at.is_some());

    // Monitoring sessions record that they did not allocate a terminal.
    let monitor = session_record(
        "sess-3",
        "s1",
        "web",
        "10.0.0.1",
        22,
        "root",
        "connected",
        None,
        0,
        0,
        false,
    );
    assert_eq!(monitor.terminal_pty, Some(false));
    assert_eq!(monitor.terminal_cols, Some(0));
}
