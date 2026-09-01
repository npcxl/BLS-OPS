//! systemd service management (P3-1.1).
//!
//! Parsing is deliberately separated from I/O: every `parse_*` function takes
//! text and returns data, so the fixtures real servers produce can be asserted
//! in unit tests without a connection.

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::remote::{run_on_linux, run_tolerated};
use crate::safe::{Capability, ProbeTool, ServiceAction};
use crate::ssh::SshSessionManager;

/// One systemd service.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ServiceUnit {
    /// Unit name, e.g. `nginx.service`.
    pub unit: String,
    /// Load state: `loaded`, `not-found`, `error`, `masked`…
    pub load: String,
    /// Active state: `active`, `inactive`, `failed`, `activating`, `deactivating`.
    pub active: String,
    /// Sub state: `running`, `exited`, `dead`, `failed`, `auto-restart`…
    pub sub: String,
    pub description: String,
    /// Enabled at boot.
    ///
    /// `None` when systemd reports a state with no on/off meaning — `static`,
    /// `indirect`, `masked`, `generated` — instead of pretending it is false.
    pub enabled: Option<bool>,
    /// The raw `list-unit-files` state, so the UI can show “静态” or “已屏蔽”.
    pub enabled_state: Option<String>,
}

impl ServiceUnit {
    /// True when the service is both active and running.
    pub fn is_running(&self) -> bool {
        self.active == "active" && self.sub == "running"
    }

    /// True when systemd gave up on the unit.
    pub fn is_failed(&self) -> bool {
        self.active == "failed" || self.sub == "failed"
    }
}

/// Parses `systemctl list-units --type=service --all --no-legend --plain`.
///
/// Columns are whitespace-aligned; the description is everything after the
/// fourth column and may itself contain spaces. Lines that do not have four
/// columns are skipped rather than turned into a half-empty row — a truncated
/// or unexpected line is not a service.
pub fn parse_list_units(input: &str) -> Vec<ServiceUnit> {
    let mut units = Vec::new();

    for line in input.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            continue;
        }

        let mut columns = line.split_whitespace();
        let (Some(unit), Some(load), Some(active), Some(sub)) = (
            columns.next(),
            columns.next(),
            columns.next(),
            columns.next(),
        ) else {
            continue;
        };

        // A legend or stray status line has no unit suffix.
        if !unit.ends_with(".service") {
            continue;
        }

        let description: Vec<&str> = columns.collect();
        units.push(ServiceUnit {
            unit: unit.to_string(),
            load: load.to_string(),
            active: active.to_string(),
            sub: sub.to_string(),
            description: description.join(" "),
            enabled: None,
            enabled_state: None,
        });
    }

    units
}

/// Parses `systemctl list-unit-files --type=service --no-legend` into
/// `(unit, state)` pairs. The vendor preset column is optional and ignored.
pub fn parse_unit_files(input: &str) -> Vec<(String, String)> {
    let mut files = Vec::new();

    for line in input.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut columns = line.split_whitespace();
        let (Some(unit), Some(state)) = (columns.next(), columns.next()) else {
            continue;
        };
        if !unit.ends_with(".service") {
            continue;
        }
        files.push((unit.to_string(), state.to_string()));
    }

    files
}

/// Maps a `list-unit-files` state onto an on/off answer.
///
/// Returns `None` for the states where "enabled" is not a meaningful question:
/// `static` units are pulled in by others, `indirect` ones are aliases, and
/// `masked` ones cannot be started at all.
pub fn enabled_from_state(state: &str) -> Option<bool> {
    match state.trim() {
        "enabled" | "enabled-runtime" => Some(true),
        "disabled" => Some(false),
        _ => None,
    }
}

/// Fills in `enabled` / `enabled_state` on units that `list-unit-files` knows
/// about. Services that only exist at runtime keep `None`.
pub fn apply_enabled_state(units: &mut [ServiceUnit], files: &[(String, String)]) {
    for unit in units.iter_mut() {
        if let Some((_, state)) = files.iter().find(|(name, _)| name == &unit.unit) {
            unit.enabled = enabled_from_state(state);
            unit.enabled_state = Some(state.clone());
        }
    }
}

/// Sorts services: running and failed first (the interesting ones), then
/// alphabetically.
pub fn sort_services(units: &mut [ServiceUnit]) {
    units.sort_by(|a, b| {
        let rank = |unit: &ServiceUnit| -> u8 {
            if unit.is_failed() {
                0
            } else if unit.is_running() {
                1
            } else {
                2
            }
        };
        rank(a).cmp(&rank(b)).then_with(|| a.unit.cmp(&b.unit))
    });
}

// -- Collection --------------------------------------------------------------

/// Lists services with their enabled-at-boot state.
///
/// `list-units` and `list-unit-files` are independent, so they run
/// concurrently: over a high-latency link that halves the wait. A failure to
/// read the unit files is tolerated — the list is still useful without the
/// enabled column.
pub async fn collect_services(
    manager: &SshSessionManager,
    session_id: &str,
) -> Result<Vec<ServiceUnit>> {
    let units_text = run_on_linux(manager, session_id, &Capability::ListServices).await?;
    let files_text = run_tolerated(
        manager,
        session_id,
        &Capability::ListUnitFiles.command()?,
        crate::remote::DEFAULT_TIMEOUT,
    )
    .await;

    let mut units = parse_list_units(&units_text);
    if let Some(files_text) = files_text {
        apply_enabled_state(&mut units, &parse_unit_files(&files_text));
    }
    sort_services(&mut units);
    Ok(units)
}

/// Runs a start/stop/restart/reload/enable/disable action.
///
/// Returns the combined output, which the UI shows as the result. Actions are
/// audited separately by the caller, because they change server state.
pub async fn service_action(
    manager: &SshSessionManager,
    session_id: &str,
    action: ServiceAction,
    unit: &str,
) -> Result<String> {
    // `run_on_linux` validates the unit before it opens a connection, so an
    // invalid name costs no round trip and never becomes shell text.
    run_on_linux(
        manager,
        session_id,
        &Capability::ServiceAction {
            action,
            unit: unit.to_string(),
        },
    )
    .await
}

/// `systemctl status` for one unit — the few lines of detail worth showing
/// after an action.
pub async fn service_status(
    manager: &SshSessionManager,
    session_id: &str,
    unit: &str,
) -> Result<String> {
    let capability = Capability::ServiceStatus {
        unit: unit.to_string(),
    };
    let command = capability.command()?;
    crate::remote::require_linux(manager, session_id).await?;

    // `systemctl status` returns a non-zero code for inactive or failed units,
    // while its stdout is still the detail the operator asked to inspect.
    let output = manager
        .exec(session_id, &command, capability.timeout())
        .await?;
    if output.stdout.is_empty() && !output.stderr.is_empty() {
        Ok(output.stderr)
    } else {
        Ok(output.stdout)
    }
}

/// Whether the host is managed by systemd.
pub async fn systemd_available(manager: &SshSessionManager, session_id: &str) -> bool {
    crate::remote::has_tool(manager, session_id, ProbeTool::Systemctl).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A trimmed but realistic `systemctl list-units` fixture.
    const LIST_UNITS: &str = "\
accounts-daemon.service                    loaded    active   running Accounts Service
acpid.service                              loaded    inactive dead    ACPI event daemon
app.service                                not-found inactive dead    app.service
cron.service                               loaded    active   running Regular background program processing daemon
dbus.service                               loaded    active   running D-Bus System Message Bus
failed-thing.service                       loaded    failed   failed  A service that broke
nginx.service                              loaded    active   running A high performance web server and a reverse proxy server
systemd-journald.service                   loaded    active   running Journal Service

LOAD   = Reflects whether the unit definition was properly loaded.
ACTIVE = The high-level unit activation state.
SUB    = The low-level unit activation state.
";

    const UNIT_FILES: &str = "\
accounts-daemon.service                disabled        enabled
acpid.service                          disabled        enabled
cron.service                           enabled         enabled
dbus.service                           static          -
failed-thing.service                   disabled        enabled
nginx.service                          enabled         enabled
systemd-journald.service               static          -
ufw.service                            enabled         enabled
";

    #[test]
    fn parses_units_and_keeps_spaces_in_the_description() {
        let units = parse_list_units(LIST_UNITS);
        // 8 个服务行；末尾的 LOAD/ACTIVE/SUB 图例不能被当成服务。
        assert_eq!(units.len(), 8, "图例与状态说明行不能被当成服务");

        let nginx = units
            .iter()
            .find(|unit| unit.unit == "nginx.service")
            .unwrap();
        assert_eq!(nginx.load, "loaded");
        assert_eq!(nginx.active, "active");
        assert_eq!(nginx.sub, "running");
        assert_eq!(
            nginx.description,
            "A high performance web server and a reverse proxy server"
        );
    }

    #[test]
    fn parses_not_found_and_failed_states() {
        let units = parse_list_units(LIST_UNITS);

        let missing = units
            .iter()
            .find(|unit| unit.unit == "app.service")
            .unwrap();
        assert_eq!(missing.load, "not-found");
        assert!(!missing.is_running());

        let failed = units
            .iter()
            .find(|unit| unit.unit == "failed-thing.service")
            .unwrap();
        assert!(failed.is_failed());
    }

    #[test]
    fn skips_lines_without_four_columns() {
        let units =
            parse_list_units("nginx.service loaded\n\nssh.service loaded active running SSH");
        assert_eq!(units.len(), 1);
        assert_eq!(units[0].unit, "ssh.service");
    }

    #[test]
    fn parses_enabled_states() {
        let files = parse_unit_files(UNIT_FILES);
        assert_eq!(files.len(), 8);
        assert_eq!(
            files
                .iter()
                .find(|(unit, _)| unit == "nginx.service")
                .map(|(_, state)| state.as_str()),
            Some("enabled")
        );
        assert_eq!(
            files
                .iter()
                .find(|(unit, _)| unit == "dbus.service")
                .map(|(_, state)| state.as_str()),
            Some("static")
        );
    }

    #[test]
    fn enabled_mapping_refuses_to_answer_for_non_boolean_states() {
        assert_eq!(enabled_from_state("enabled"), Some(true));
        assert_eq!(enabled_from_state("enabled-runtime"), Some(true));
        assert_eq!(enabled_from_state("disabled"), Some(false));
        // These genuinely have no on/off answer — do not invent one.
        assert_eq!(enabled_from_state("static"), None);
        assert_eq!(enabled_from_state("indirect"), None);
        assert_eq!(enabled_from_state("masked"), None);
        assert_eq!(enabled_from_state("generated"), None);
    }

    #[test]
    fn merges_enabled_state_into_the_list() {
        let mut units = parse_list_units(LIST_UNITS);
        apply_enabled_state(&mut units, &parse_unit_files(UNIT_FILES));

        let nginx = units
            .iter()
            .find(|unit| unit.unit == "nginx.service")
            .unwrap();
        assert_eq!(nginx.enabled, Some(true));

        let dbus = units
            .iter()
            .find(|unit| unit.unit == "dbus.service")
            .unwrap();
        assert_eq!(dbus.enabled, None, "static 不应该被当成 disabled");
        assert_eq!(dbus.enabled_state.as_deref(), Some("static"));

        // `app.service` only exists at runtime, so unit files know nothing.
        let app = units
            .iter()
            .find(|unit| unit.unit == "app.service")
            .unwrap();
        assert_eq!(app.enabled, None);
        assert_eq!(app.enabled_state, None);
    }

    #[test]
    fn sorts_failed_then_running_then_the_rest() {
        let mut units = parse_list_units(LIST_UNITS);
        sort_services(&mut units);

        assert_eq!(units[0].unit, "failed-thing.service");
        assert!(units[0].is_failed());

        let running: Vec<&str> = units
            .iter()
            .filter(|unit| unit.is_running())
            .map(|unit| unit.unit.as_str())
            .collect();
        assert_eq!(
            running,
            vec![
                "accounts-daemon.service",
                "cron.service",
                "dbus.service",
                "nginx.service",
                "systemd-journald.service",
            ]
        );

        // Inactive ones land at the end, alphabetically.
        assert_eq!(units[units.len() - 2].unit, "acpid.service");
        assert_eq!(units[units.len() - 1].unit, "app.service");
    }

    #[test]
    fn empty_input_yields_no_services() {
        assert!(parse_list_units("").is_empty());
        assert!(parse_unit_files("").is_empty());
    }
}
