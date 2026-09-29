//! P5.0 部署中心 —— SQL 访问层（15 张新表，migration v9）。
//!
//! 与 `db/projects.rs` 同一套写法：`anyhow::Result`、显式级联删除、
//! 每个实体一个 row mapper。
//!
//! # 两个刻意的实现决定
//!
//! 1. **枚举一律以 serde 的 `snake_case` 字符串落库**（`enum_to_text` /
//!    `enum_from_text`）。这样数据库里的字面量与 IPC 上传给前端的完全一致 ——
//!    换一套手写映射就迟早会漂移。
//! 2. **保存计划图在一个事务里**：先 upsert 计划，再整体替换节点与边。
//!    节点 id 会被边引用，所以必须先删边、再删节点、再插入 —— 顺序反过来会
//!    撞外键。
//!
//! P5.0 没有任何"执行"路径：`upsert_run` / `upsert_run_node` 只有仓储层，
//! 由后续阶段的 Workflow Engine 使用（IPC 只暴露只读的 list/get）。

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::de::DeserializeOwned;
use serde::Serialize;

use super::schema::AppDb;
use crate::deployment::model::*;

// -- 通用 -------------------------------------------------------------------

/// 单元枚举 → 数据库文本（serde 的 snake_case 表示）。
fn enum_to_text<T: Serialize>(value: &T) -> Result<String> {
    Ok(match serde_json::to_value(value)? {
        serde_json::Value::String(text) => text,
        other => other.to_string(),
    })
}

/// 数据库文本 → 单元枚举。
fn enum_from_text<T: DeserializeOwned>(text: &str) -> rusqlite::Result<T> {
    serde_json::from_value(serde_json::Value::String(text.to_string())).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

/// 复杂结构（`ServiceRuntime` / 字符串数组）→ JSON 文本。
fn to_json<T: Serialize>(value: &T) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}

/// JSON 文本 → 复杂结构。
fn from_json<T: DeserializeOwned>(text: &str) -> rusqlite::Result<T> {
    serde_json::from_str(text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

// -- 应用 -------------------------------------------------------------------

pub fn list_applications(
    conn: &Connection,
    server_id: Option<&str>,
) -> Result<Vec<DeploymentApplication>> {
    let mut statement = match server_id {
        Some(_) => conn.prepare(
            "SELECT * FROM deployment_applications WHERE server_id = ?1 ORDER BY name ASC",
        )?,
        None => conn.prepare("SELECT * FROM deployment_applications ORDER BY name ASC")?,
    };
    let rows = match server_id {
        Some(server) => statement.query_map([server], application_from_row)?,
        None => statement.query_map([], application_from_row)?,
    };
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_application(conn: &Connection, id: &str) -> Result<Option<DeploymentApplication>> {
    let mut statement = conn.prepare("SELECT * FROM deployment_applications WHERE id = ?1")?;
    let mut rows = statement.query_map([id], application_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn application_exists(conn: &Connection, id: &str) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM deployment_applications WHERE id = ?1",
        [id],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn application_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeploymentApplication> {
    Ok(DeploymentApplication {
        id: row.get("id")?,
        server_id: row.get("server_id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        application_kind: enum_from_text(&row.get::<_, String>("application_kind")?)?,
        source_kind: enum_from_text(&row.get::<_, String>("source_kind")?)?,
        source_ref: row.get("source_ref")?,
        default_branch: row.get("default_branch")?,
        confirmed_project_path: row.get("confirmed_project_path")?,
        status: row.get("status")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn upsert_application(conn: &Connection, application: &DeploymentApplication) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO deployment_applications (
            id, server_id, name, description, application_kind, source_kind, source_ref,
            default_branch, confirmed_project_path, status, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
        ON CONFLICT(id) DO UPDATE SET
            server_id=excluded.server_id,
            name=excluded.name,
            description=excluded.description,
            application_kind=excluded.application_kind,
            source_kind=excluded.source_kind,
            source_ref=excluded.source_ref,
            default_branch=excluded.default_branch,
            confirmed_project_path=excluded.confirmed_project_path,
            status=excluded.status,
            updated_at=excluded.updated_at
        "#,
        params![
            &application.id,
            &application.server_id,
            &application.name,
            &application.description,
            enum_to_text(&application.application_kind)?,
            enum_to_text(&application.source_kind)?,
            &application.source_ref,
            &application.default_branch,
            application.confirmed_project_path.as_deref(),
            &application.status,
            application.created_at,
            application.updated_at,
        ],
    )?;
    Ok(())
}

/// 删应用：连环境、服务、关系、方案（含节点与边）、运行、版本、制品、配置、
/// 密钥引用一并清掉，并如实回报删除数量（UI 要告诉用户删了什么）。
pub fn delete_application_cascade(conn: &Connection, id: &str) -> Result<DeploymentCascadeResult> {
    let mut result = DeploymentCascadeResult::default();
    result.services = conn.query_row(
        "SELECT COUNT(*) FROM service_units WHERE application_id = ?1",
        [id],
        |row| row.get(0),
    )?;
    result.relations = conn.query_row(
        "SELECT COUNT(*) FROM service_relations WHERE application_id = ?1",
        [id],
        |row| row.get(0),
    )?;
    result.plans = conn.query_row(
        "SELECT COUNT(*) FROM deployment_plans WHERE application_id = ?1",
        [id],
        |row| row.get(0),
    )?;
    result.runs = conn.query_row(
        "SELECT COUNT(*) FROM deployment_runs WHERE application_id = ?1",
        [id],
        |row| row.get(0),
    )?;
    result.releases = conn.query_row(
        "SELECT COUNT(*) FROM release_records WHERE application_id = ?1",
        [id],
        |row| row.get(0),
    )?;
    result.artifacts = conn.query_row(
        "SELECT COUNT(*) FROM artifact_records WHERE application_id = ?1",
        [id],
        |row| row.get(0),
    )?;
    result.configs = conn.query_row(
        "SELECT COUNT(*) FROM config_definitions WHERE application_id = ?1",
        [id],
        |row| row.get(0),
    )?;
    result.secrets = conn.query_row(
        "SELECT COUNT(*) FROM secret_refs WHERE application_id = ?1",
        [id],
        |row| row.get(0),
    )?;
    result.environments = conn.query_row(
        "SELECT COUNT(*) FROM deployment_environments WHERE application_id = ?1",
        [id],
        |row| row.get(0),
    )?;
    result.domains = conn.query_row(
        "SELECT COUNT(*) FROM domain_bindings WHERE environment_id IN
            (SELECT id FROM deployment_environments WHERE application_id = ?1)",
        [id],
        |row| row.get(0),
    )?;

    // 顺序：先删引用方，再删被引用方（外键开着，反过来会撞约束）。
    conn.execute(
        "DELETE FROM run_nodes WHERE run_id IN
            (SELECT id FROM deployment_runs WHERE application_id = ?1)",
        [id],
    )?;
    conn.execute(
        "DELETE FROM deployment_runs WHERE application_id = ?1",
        [id],
    )?;
    conn.execute(
        "DELETE FROM plan_edges WHERE plan_id IN
            (SELECT id FROM deployment_plans WHERE application_id = ?1)",
        [id],
    )?;
    conn.execute(
        "DELETE FROM plan_nodes WHERE plan_id IN
            (SELECT id FROM deployment_plans WHERE application_id = ?1)",
        [id],
    )?;
    conn.execute(
        "DELETE FROM deployment_plans WHERE application_id = ?1",
        [id],
    )?;
    conn.execute(
        "DELETE FROM release_records WHERE application_id = ?1",
        [id],
    )?;
    conn.execute(
        "DELETE FROM domain_bindings WHERE environment_id IN
        (SELECT id FROM deployment_environments WHERE application_id = ?1)",
        [id],
    )?;
    conn.execute(
        "DELETE FROM capacity_profiles WHERE environment_id IN
            (SELECT id FROM deployment_environments WHERE application_id = ?1)",
        [id],
    )?;
    conn.execute("DELETE FROM service_units WHERE application_id = ?1", [id])?;
    conn.execute(
        "DELETE FROM service_relations WHERE application_id = ?1",
        [id],
    )?;
    conn.execute(
        "DELETE FROM artifact_records WHERE application_id = ?1",
        [id],
    )?;
    conn.execute(
        "DELETE FROM config_definitions WHERE application_id = ?1",
        [id],
    )?;
    conn.execute("DELETE FROM secret_refs WHERE application_id = ?1", [id])?;
    conn.execute(
        "DELETE FROM deployment_environments WHERE application_id = ?1",
        [id],
    )?;
    conn.execute("DELETE FROM deployment_applications WHERE id = ?1", [id])?;
    Ok(result)
}

// -- 环境 -------------------------------------------------------------------

pub fn list_environments(
    conn: &Connection,
    application_id: Option<&str>,
) -> Result<Vec<DeploymentEnvironment>> {
    let mut statement = match application_id {
        Some(_) => conn.prepare(
            "SELECT * FROM deployment_environments WHERE application_id = ?1 ORDER BY created_at ASC",
        )?,
        None => conn.prepare("SELECT * FROM deployment_environments ORDER BY created_at ASC")?,
    };
    let rows = match application_id {
        Some(application) => statement.query_map([application], environment_from_row)?,
        None => statement.query_map([], environment_from_row)?,
    };
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_environment(conn: &Connection, id: &str) -> Result<Option<DeploymentEnvironment>> {
    let mut statement = conn.prepare("SELECT * FROM deployment_environments WHERE id = ?1")?;
    let mut rows = statement.query_map([id], environment_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

fn environment_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeploymentEnvironment> {
    Ok(DeploymentEnvironment {
        id: row.get("id")?,
        application_id: row.get("application_id")?,
        server_id: row.get("server_id")?,
        name: row.get("name")?,
        kind: enum_from_text(&row.get::<_, String>("kind")?)?,
        deploy_root: row.get("deploy_root")?,
        capacity_profile_id: row.get("capacity_profile_id")?,
        notes: row.get("notes")?,
        status: row.get("status")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn upsert_environment(conn: &Connection, environment: &DeploymentEnvironment) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO deployment_environments (
            id, application_id, server_id, name, kind, deploy_root, capacity_profile_id,
            notes, status, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        ON CONFLICT(id) DO UPDATE SET
            application_id=excluded.application_id,
            server_id=excluded.server_id,
            name=excluded.name,
            kind=excluded.kind,
            deploy_root=excluded.deploy_root,
            capacity_profile_id=excluded.capacity_profile_id,
            notes=excluded.notes,
            status=excluded.status,
            updated_at=excluded.updated_at
        "#,
        params![
            &environment.id,
            &environment.application_id,
            &environment.server_id,
            &environment.name,
            enum_to_text(&environment.kind)?,
            &environment.deploy_root,
            environment.capacity_profile_id.as_deref(),
            &environment.notes,
            &environment.status,
            environment.created_at,
            environment.updated_at,
        ],
    )?;
    Ok(())
}

/// 删环境：连同它的服务、容量画像、域名绑定、方案（含节点与边）与运行记录。
pub fn delete_environment_cascade(conn: &Connection, id: &str) -> Result<DeploymentCascadeResult> {
    let mut result = DeploymentCascadeResult::default();
    result.services = conn.query_row(
        "SELECT COUNT(*) FROM service_units WHERE environment_id = ?1",
        [id],
        |row| row.get(0),
    )?;
    result.plans = conn.query_row(
        "SELECT COUNT(*) FROM deployment_plans WHERE environment_id = ?1",
        [id],
        |row| row.get(0),
    )?;
    result.domains = conn.query_row(
        "SELECT COUNT(*) FROM domain_bindings WHERE environment_id = ?1",
        [id],
        |row| row.get(0),
    )?;
    result.releases = conn.query_row(
        "SELECT COUNT(*) FROM release_records WHERE environment_id = ?1",
        [id],
        |row| row.get(0),
    )?;

    conn.execute(
        "DELETE FROM plan_edges WHERE plan_id IN
            (SELECT id FROM deployment_plans WHERE environment_id = ?1)",
        [id],
    )?;
    conn.execute(
        "DELETE FROM plan_nodes WHERE plan_id IN
            (SELECT id FROM deployment_plans WHERE environment_id = ?1)",
        [id],
    )?;
    conn.execute(
        "DELETE FROM deployment_plans WHERE environment_id = ?1",
        [id],
    )?;
    conn.execute(
        "DELETE FROM release_records WHERE environment_id = ?1",
        [id],
    )?;
    conn.execute(
        "DELETE FROM domain_bindings WHERE environment_id = ?1",
        [id],
    )?;
    conn.execute(
        "DELETE FROM capacity_profiles WHERE environment_id = ?1",
        [id],
    )?;
    conn.execute("DELETE FROM service_units WHERE environment_id = ?1", [id])?;
    conn.execute("DELETE FROM deployment_environments WHERE id = ?1", [id])?;
    Ok(result)
}

// -- 服务 -------------------------------------------------------------------

pub fn list_service_units(
    conn: &Connection,
    application_id: Option<&str>,
    environment_id: Option<&str>,
) -> Result<Vec<ServiceUnit>> {
    let mut statement = match (application_id, environment_id) {
        (Some(_), Some(_)) => conn.prepare(
            "SELECT * FROM service_units WHERE application_id = ?1 AND environment_id = ?2
             ORDER BY name ASC",
        )?,
        (Some(_), None) => {
            conn.prepare("SELECT * FROM service_units WHERE application_id = ?1 ORDER BY name ASC")?
        }
        (None, Some(_)) => {
            conn.prepare("SELECT * FROM service_units WHERE environment_id = ?1 ORDER BY name ASC")?
        }
        (None, None) => conn.prepare("SELECT * FROM service_units ORDER BY name ASC")?,
    };
    let rows = match (application_id, environment_id) {
        (Some(application), Some(environment)) => {
            statement.query_map(params![application, environment], service_unit_from_row)?
        }
        (Some(application), None) => statement.query_map([application], service_unit_from_row)?,
        (None, Some(environment)) => statement.query_map([environment], service_unit_from_row)?,
        (None, None) => statement.query_map([], service_unit_from_row)?,
    };
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_service_unit(conn: &Connection, id: &str) -> Result<Option<ServiceUnit>> {
    let mut statement = conn.prepare("SELECT * FROM service_units WHERE id = ?1")?;
    let mut rows = statement.query_map([id], service_unit_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

fn service_unit_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ServiceUnit> {
    Ok(ServiceUnit {
        id: row.get("id")?,
        application_id: row.get("application_id")?,
        environment_id: row.get("environment_id")?,
        name: row.get("name")?,
        role: enum_from_text(&row.get::<_, String>("role")?)?,
        service_kind: enum_from_text(&row.get::<_, String>("service_kind")?)?,
        runtime: from_json(&row.get::<_, String>("runtime_json")?)?,
        deploy_path: row.get("deploy_path")?,
        confirmed_project_id: row.get("confirmed_project_id")?,
        confirmed_project_path: row.get("confirmed_project_path")?,
        artifact_id: row.get("artifact_id")?,
        status: row.get("status")?,
        notes: row.get("notes")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn upsert_service_unit(conn: &Connection, unit: &ServiceUnit) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO service_units (
            id, application_id, environment_id, name, role, service_kind, runtime_json,
            deploy_path, confirmed_project_id, confirmed_project_path, artifact_id,
            status, notes, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
        ON CONFLICT(id) DO UPDATE SET
            application_id=excluded.application_id,
            environment_id=excluded.environment_id,
            name=excluded.name,
            role=excluded.role,
            service_kind=excluded.service_kind,
            runtime_json=excluded.runtime_json,
            deploy_path=excluded.deploy_path,
            confirmed_project_id=excluded.confirmed_project_id,
            confirmed_project_path=excluded.confirmed_project_path,
            artifact_id=excluded.artifact_id,
            status=excluded.status,
            notes=excluded.notes,
            updated_at=excluded.updated_at
        "#,
        params![
            &unit.id,
            &unit.application_id,
            &unit.environment_id,
            &unit.name,
            enum_to_text(&unit.role)?,
            enum_to_text(&unit.service_kind)?,
            to_json(&unit.runtime)?,
            unit.deploy_path.as_deref(),
            unit.confirmed_project_id.as_deref(),
            unit.confirmed_project_path.as_deref(),
            unit.artifact_id.as_deref(),
            &unit.status,
            &unit.notes,
            unit.created_at,
            unit.updated_at,
        ],
    )?;
    Ok(())
}

/// 把 P3.8 的已确认项目挂到服务上（`project_id` 为空 = 只记路径）。
///
/// 反向查询（某个已确认项目被哪些服务引用）走
/// `idx_service_units_confirmed_project`。
pub fn link_service_confirmed_project(
    conn: &Connection,
    unit_id: &str,
    project_id: Option<&str>,
    project_path: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE service_units
            SET confirmed_project_id = ?1, confirmed_project_path = ?2, updated_at = ?3
          WHERE id = ?4",
        params![project_id, project_path, AppDb::now(), unit_id],
    )?;
    Ok(())
}

pub fn unlink_service_confirmed_project(conn: &Connection, unit_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE service_units
            SET confirmed_project_id = NULL, confirmed_project_path = NULL, updated_at = ?1
          WHERE id = ?2",
        params![AppDb::now(), unit_id],
    )?;
    Ok(())
}

/// 引用某个已确认项目的服务 id 列表。
pub fn service_units_for_confirmed_project(
    conn: &Connection,
    project_id: &str,
) -> Result<Vec<String>> {
    let mut statement =
        conn.prepare("SELECT id FROM service_units WHERE confirmed_project_id = ?1")?;
    let rows = statement.query_map([project_id], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 删服务：连带它的关系、域名绑定与制品挂载（制品本体保留）。
pub fn delete_service_unit_cascade(conn: &Connection, id: &str) -> Result<i64> {
    let relations: i64 = conn.query_row(
        "SELECT COUNT(*) FROM service_relations WHERE from_service_id = ?1 OR to_service_id = ?1",
        [id],
        |row| row.get(0),
    )?;
    conn.execute(
        "DELETE FROM service_relations WHERE from_service_id = ?1 OR to_service_id = ?1",
        [id],
    )?;
    conn.execute(
        "UPDATE domain_bindings SET service_unit_id = NULL WHERE service_unit_id = ?1",
        [id],
    )?;
    conn.execute(
        "UPDATE artifact_records SET service_unit_id = NULL WHERE service_unit_id = ?1",
        [id],
    )?;
    conn.execute("DELETE FROM service_units WHERE id = ?1", [id])?;
    Ok(relations)
}

// -- 服务关系 ---------------------------------------------------------------

pub fn list_service_relations(
    conn: &Connection,
    application_id: Option<&str>,
) -> Result<Vec<ServiceRelation>> {
    let mut statement = match application_id {
        Some(_) => conn.prepare(
            "SELECT * FROM service_relations WHERE application_id = ?1 ORDER BY created_at ASC",
        )?,
        None => conn.prepare("SELECT * FROM service_relations ORDER BY created_at ASC")?,
    };
    let rows = match application_id {
        Some(application) => statement.query_map([application], relation_from_row)?,
        None => statement.query_map([], relation_from_row)?,
    };
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn relation_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ServiceRelation> {
    Ok(ServiceRelation {
        id: row.get("id")?,
        application_id: row.get("application_id")?,
        from_service_id: row.get("from_service_id")?,
        to_service_id: row.get("to_service_id")?,
        relation_kind: enum_from_text(&row.get::<_, String>("relation_kind")?)?,
        required: row.get("required")?,
        failure_policy: enum_from_text(&row.get::<_, String>("failure_policy")?)?,
        notes: row.get("notes")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn upsert_service_relation(conn: &Connection, relation: &ServiceRelation) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO service_relations (
            id, application_id, from_service_id, to_service_id, relation_kind, required,
            failure_policy, notes, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(id) DO UPDATE SET
            application_id=excluded.application_id,
            from_service_id=excluded.from_service_id,
            to_service_id=excluded.to_service_id,
            relation_kind=excluded.relation_kind,
            required=excluded.required,
            failure_policy=excluded.failure_policy,
            notes=excluded.notes,
            updated_at=excluded.updated_at
        "#,
        params![
            &relation.id,
            &relation.application_id,
            &relation.from_service_id,
            &relation.to_service_id,
            enum_to_text(&relation.relation_kind)?,
            relation.required,
            enum_to_text(&relation.failure_policy)?,
            &relation.notes,
            relation.created_at,
            relation.updated_at,
        ],
    )?;
    Ok(())
}

pub fn delete_service_relation(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM service_relations WHERE id = ?1", [id])?;
    Ok(())
}

// -- 容量画像 ---------------------------------------------------------------

pub fn get_capacity_profile(
    conn: &Connection,
    environment_id: &str,
) -> Result<Option<CapacityProfile>> {
    let mut statement =
        conn.prepare("SELECT * FROM capacity_profiles WHERE environment_id = ?1")?;
    let mut rows = statement.query_map([environment_id], capacity_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

fn capacity_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CapacityProfile> {
    Ok(CapacityProfile {
        id: row.get("id")?,
        environment_id: row.get("environment_id")?,
        expected_dau: row.get("expected_dau")?,
        concurrent_users: row.get("concurrent_users")?,
        peak_qps: row.get("peak_qps")?,
        avg_qps: row.get("avg_qps")?,
        websocket_connections: row.get("websocket_connections")?,
        response_target_ms: row.get("response_target_ms")?,
        monthly_bandwidth_gb: row.get("monthly_bandwidth_gb")?,
        monthly_upload_gb: row.get("monthly_upload_gb")?,
        monthly_data_growth_gb: row.get("monthly_data_growth_gb")?,
        availability_target: row.get("availability_target")?,
        rpo_minutes: row.get("rpo_minutes")?,
        rto_minutes: row.get("rto_minutes")?,
        monthly_budget: row.get("monthly_budget")?,
        budget_currency: row.get("budget_currency")?,
        estimation_basis: enum_from_text(&row.get::<_, String>("estimation_basis")?)?,
        assumptions: from_json(&row.get::<_, String>("assumptions")?)?,
        notes: row.get("notes")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn upsert_capacity_profile(conn: &Connection, profile: &CapacityProfile) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO capacity_profiles (
            id, environment_id, expected_dau, concurrent_users, peak_qps, avg_qps,
            websocket_connections, response_target_ms, monthly_bandwidth_gb, monthly_upload_gb,
            monthly_data_growth_gb, availability_target, rpo_minutes, rto_minutes,
            monthly_budget, budget_currency, estimation_basis, assumptions, notes,
            created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
        ON CONFLICT(id) DO UPDATE SET
            environment_id=excluded.environment_id,
            expected_dau=excluded.expected_dau,
            concurrent_users=excluded.concurrent_users,
            peak_qps=excluded.peak_qps,
            avg_qps=excluded.avg_qps,
            websocket_connections=excluded.websocket_connections,
            response_target_ms=excluded.response_target_ms,
            monthly_bandwidth_gb=excluded.monthly_bandwidth_gb,
            monthly_upload_gb=excluded.monthly_upload_gb,
            monthly_data_growth_gb=excluded.monthly_data_growth_gb,
            availability_target=excluded.availability_target,
            rpo_minutes=excluded.rpo_minutes,
            rto_minutes=excluded.rto_minutes,
            monthly_budget=excluded.monthly_budget,
            budget_currency=excluded.budget_currency,
            estimation_basis=excluded.estimation_basis,
            assumptions=excluded.assumptions,
            notes=excluded.notes,
            updated_at=excluded.updated_at
        "#,
        params![
            &profile.id,
            &profile.environment_id,
            profile.expected_dau,
            profile.concurrent_users,
            profile.peak_qps,
            profile.avg_qps,
            profile.websocket_connections,
            profile.response_target_ms,
            profile.monthly_bandwidth_gb,
            profile.monthly_upload_gb,
            profile.monthly_data_growth_gb,
            profile.availability_target.as_deref(),
            profile.rpo_minutes,
            profile.rto_minutes,
            profile.monthly_budget,
            profile.budget_currency.as_deref(),
            enum_to_text(&profile.estimation_basis)?,
            to_json(&profile.assumptions)?,
            &profile.notes,
            profile.created_at,
            profile.updated_at,
        ],
    )?;
    Ok(())
}

pub fn delete_capacity_profile(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM capacity_profiles WHERE id = ?1", [id])?;
    Ok(())
}

// -- 域名绑定 ---------------------------------------------------------------

pub fn list_domain_bindings(
    conn: &Connection,
    environment_id: Option<&str>,
) -> Result<Vec<DomainBinding>> {
    let mut statement = match environment_id {
        Some(_) => conn.prepare(
            "SELECT * FROM domain_bindings WHERE environment_id = ?1 ORDER BY domain ASC",
        )?,
        None => conn.prepare("SELECT * FROM domain_bindings ORDER BY domain ASC")?,
    };
    let rows = match environment_id {
        Some(environment) => statement.query_map([environment], domain_from_row)?,
        None => statement.query_map([], domain_from_row)?,
    };
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn domain_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DomainBinding> {
    Ok(DomainBinding {
        id: row.get("id")?,
        environment_id: row.get("environment_id")?,
        service_unit_id: row.get("service_unit_id")?,
        domain: row.get("domain")?,
        listen_port: row.get::<_, i64>("listen_port")? as u16,
        path_prefix: row.get("path_prefix")?,
        dns_credential_ref: row.get("dns_credential_ref")?,
        dns_status: enum_from_text(&row.get::<_, String>("dns_status")?)?,
        dns_checked_at: row.get("dns_checked_at")?,
        ssl_mode: enum_from_text(&row.get::<_, String>("ssl_mode")?)?,
        ssl_status: enum_from_text(&row.get::<_, String>("ssl_status")?)?,
        ssl_expires_at: row.get("ssl_expires_at")?,
        notes: row.get("notes")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn upsert_domain_binding(conn: &Connection, binding: &DomainBinding) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO domain_bindings (
            id, environment_id, service_unit_id, domain, listen_port, path_prefix,
            dns_credential_ref, dns_status, dns_checked_at, ssl_mode, ssl_status,
            ssl_expires_at, notes, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
        ON CONFLICT(id) DO UPDATE SET
            environment_id=excluded.environment_id,
            service_unit_id=excluded.service_unit_id,
            domain=excluded.domain,
            listen_port=excluded.listen_port,
            path_prefix=excluded.path_prefix,
            dns_credential_ref=excluded.dns_credential_ref,
            dns_status=excluded.dns_status,
            dns_checked_at=excluded.dns_checked_at,
            ssl_mode=excluded.ssl_mode,
            ssl_status=excluded.ssl_status,
            ssl_expires_at=excluded.ssl_expires_at,
            notes=excluded.notes,
            updated_at=excluded.updated_at
        "#,
        params![
            &binding.id,
            &binding.environment_id,
            binding.service_unit_id.as_deref(),
            &binding.domain,
            binding.listen_port as i64,
            &binding.path_prefix,
            binding.dns_credential_ref.as_deref(),
            enum_to_text(&binding.dns_status)?,
            binding.dns_checked_at,
            enum_to_text(&binding.ssl_mode)?,
            enum_to_text(&binding.ssl_status)?,
            binding.ssl_expires_at,
            &binding.notes,
            binding.created_at,
            binding.updated_at,
        ],
    )?;
    Ok(())
}

pub fn delete_domain_binding(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM domain_bindings WHERE id = ?1", [id])?;
    Ok(())
}

// -- 配置定义 ---------------------------------------------------------------

pub fn list_config_definitions(
    conn: &Connection,
    application_id: Option<&str>,
) -> Result<Vec<ConfigDefinition>> {
    let mut statement = match application_id {
        Some(_) => conn.prepare(
            "SELECT * FROM config_definitions WHERE application_id = ?1 ORDER BY key ASC",
        )?,
        None => conn.prepare("SELECT * FROM config_definitions ORDER BY key ASC")?,
    };
    let rows = match application_id {
        Some(application) => statement.query_map([application], config_from_row)?,
        None => statement.query_map([], config_from_row)?,
    };
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn config_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConfigDefinition> {
    Ok(ConfigDefinition {
        id: row.get("id")?,
        application_id: row.get("application_id")?,
        service_unit_id: row.get("service_unit_id")?,
        key: row.get("key")?,
        data_type: enum_from_text(&row.get::<_, String>("data_type")?)?,
        required: row.get("required")?,
        secret: row.get("secret")?,
        scope: enum_from_text(&row.get::<_, String>("scope")?)?,
        source_kind: enum_from_text(&row.get::<_, String>("source_kind")?)?,
        source_ref: row.get("source_ref")?,
        default_value: row.get("default_value")?,
        description: row.get("description")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn upsert_config_definition(conn: &Connection, config: &ConfigDefinition) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO config_definitions (
            id, application_id, service_unit_id, key, data_type, required, secret, scope,
            source_kind, source_ref, default_value, description, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
        ON CONFLICT(id) DO UPDATE SET
            application_id=excluded.application_id,
            service_unit_id=excluded.service_unit_id,
            key=excluded.key,
            data_type=excluded.data_type,
            required=excluded.required,
            secret=excluded.secret,
            scope=excluded.scope,
            source_kind=excluded.source_kind,
            source_ref=excluded.source_ref,
            default_value=excluded.default_value,
            description=excluded.description,
            updated_at=excluded.updated_at
        "#,
        params![
            &config.id,
            &config.application_id,
            config.service_unit_id.as_deref(),
            &config.key,
            enum_to_text(&config.data_type)?,
            config.required,
            config.secret,
            enum_to_text(&config.scope)?,
            enum_to_text(&config.source_kind)?,
            config.source_ref.as_deref(),
            config.default_value.as_deref(),
            &config.description,
            config.created_at,
            config.updated_at,
        ],
    )?;
    Ok(())
}

pub fn delete_config_definition(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM config_definitions WHERE id = ?1", [id])?;
    Ok(())
}

// -- 密钥引用 ---------------------------------------------------------------

pub fn list_secret_refs(conn: &Connection, application_id: Option<&str>) -> Result<Vec<SecretRef>> {
    let mut statement = match application_id {
        Some(_) => {
            conn.prepare("SELECT * FROM secret_refs WHERE application_id = ?1 ORDER BY name ASC")?
        }
        None => conn.prepare("SELECT * FROM secret_refs ORDER BY name ASC")?,
    };
    let rows = match application_id {
        Some(application) => statement.query_map([application], secret_ref_from_row)?,
        None => statement.query_map([], secret_ref_from_row)?,
    };
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_secret_ref(conn: &Connection, id: &str) -> Result<Option<SecretRef>> {
    let mut statement = conn.prepare("SELECT * FROM secret_refs WHERE id = ?1")?;
    let mut rows = statement.query_map([id], secret_ref_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

fn secret_ref_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SecretRef> {
    Ok(SecretRef {
        id: row.get("id")?,
        application_id: row.get("application_id")?,
        name: row.get("name")?,
        store_kind: enum_from_text(&row.get::<_, String>("store_kind")?)?,
        keyring_service: row.get("keyring_service")?,
        keyring_account: row.get("keyring_account")?,
        runtime_path: row.get("runtime_path")?,
        description: row.get("description")?,
        last_used_at: row.get("last_used_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn upsert_secret_ref(conn: &Connection, reference: &SecretRef) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO secret_refs (
            id, application_id, name, store_kind, keyring_service, keyring_account,
            runtime_path, description, last_used_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        ON CONFLICT(id) DO UPDATE SET
            application_id=excluded.application_id,
            name=excluded.name,
            store_kind=excluded.store_kind,
            keyring_service=excluded.keyring_service,
            keyring_account=excluded.keyring_account,
            runtime_path=excluded.runtime_path,
            description=excluded.description,
            last_used_at=excluded.last_used_at,
            updated_at=excluded.updated_at
        "#,
        params![
            &reference.id,
            reference.application_id.as_deref(),
            &reference.name,
            enum_to_text(&reference.store_kind)?,
            reference.keyring_service.as_deref(),
            reference.keyring_account.as_deref(),
            reference.runtime_path.as_deref(),
            &reference.description,
            reference.last_used_at,
            reference.created_at,
            reference.updated_at,
        ],
    )?;
    Ok(())
}

pub fn delete_secret_ref(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM secret_refs WHERE id = ?1", [id])?;
    Ok(())
}

// -- 制品 -------------------------------------------------------------------

pub fn list_artifacts(
    conn: &Connection,
    application_id: Option<&str>,
    service_unit_id: Option<&str>,
) -> Result<Vec<ArtifactRecord>> {
    let mut statement = match (application_id, service_unit_id) {
        (Some(_), Some(_)) => conn.prepare(
            "SELECT * FROM artifact_records WHERE application_id = ?1 AND service_unit_id = ?2
             ORDER BY created_at DESC",
        )?,
        (Some(_), None) => conn.prepare(
            "SELECT * FROM artifact_records WHERE application_id = ?1 ORDER BY created_at DESC",
        )?,
        (None, Some(_)) => conn.prepare(
            "SELECT * FROM artifact_records WHERE service_unit_id = ?1 ORDER BY created_at DESC",
        )?,
        (None, None) => conn.prepare("SELECT * FROM artifact_records ORDER BY created_at DESC")?,
    };
    let rows = match (application_id, service_unit_id) {
        (Some(application), Some(service)) => {
            statement.query_map(params![application, service], artifact_from_row)?
        }
        (Some(application), None) => statement.query_map([application], artifact_from_row)?,
        (None, Some(service)) => statement.query_map([service], artifact_from_row)?,
        (None, None) => statement.query_map([], artifact_from_row)?,
    };
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_artifact(conn: &Connection, id: &str) -> Result<Option<ArtifactRecord>> {
    let mut statement = conn.prepare("SELECT * FROM artifact_records WHERE id = ?1")?;
    let mut rows = statement.query_map([id], artifact_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

fn artifact_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ArtifactRecord> {
    Ok(ArtifactRecord {
        id: row.get("id")?,
        application_id: row.get("application_id")?,
        service_unit_id: row.get("service_unit_id")?,
        kind: enum_from_text(&row.get::<_, String>("kind")?)?,
        source_kind: enum_from_text(&row.get::<_, String>("source_kind")?)?,
        source_ref: row.get("source_ref")?,
        file_name: row.get("file_name")?,
        size_bytes: row.get("size_bytes")?,
        sha256: row.get("sha256")?,
        docker_digest: row.get("docker_digest")?,
        version_label: row.get("version_label")?,
        built_at: row.get("built_at")?,
        checksum_verified: row.get("checksum_verified")?,
        status: enum_from_text(&row.get::<_, String>("status")?)?,
        notes: row.get("notes")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn upsert_artifact(conn: &Connection, artifact: &ArtifactRecord) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO artifact_records (
            id, application_id, service_unit_id, kind, source_kind, source_ref, file_name,
            size_bytes, sha256, docker_digest, version_label, built_at, checksum_verified,
            status, notes, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
        ON CONFLICT(id) DO UPDATE SET
            application_id=excluded.application_id,
            service_unit_id=excluded.service_unit_id,
            kind=excluded.kind,
            source_kind=excluded.source_kind,
            source_ref=excluded.source_ref,
            file_name=excluded.file_name,
            size_bytes=excluded.size_bytes,
            sha256=excluded.sha256,
            docker_digest=excluded.docker_digest,
            version_label=excluded.version_label,
            built_at=excluded.built_at,
            checksum_verified=excluded.checksum_verified,
            status=excluded.status,
            notes=excluded.notes,
            updated_at=excluded.updated_at
        "#,
        params![
            &artifact.id,
            &artifact.application_id,
            artifact.service_unit_id.as_deref(),
            enum_to_text(&artifact.kind)?,
            enum_to_text(&artifact.source_kind)?,
            &artifact.source_ref,
            artifact.file_name.as_deref(),
            artifact.size_bytes,
            artifact.sha256.as_deref(),
            artifact.docker_digest.as_deref(),
            artifact.version_label.as_deref(),
            artifact.built_at,
            artifact.checksum_verified,
            enum_to_text(&artifact.status)?,
            &artifact.notes,
            artifact.created_at,
            artifact.updated_at,
        ],
    )?;
    Ok(())
}

pub fn delete_artifact(conn: &Connection, id: &str) -> Result<()> {
    conn.execute(
        "UPDATE service_units SET artifact_id = NULL WHERE artifact_id = ?1",
        [id],
    )?;
    conn.execute("DELETE FROM artifact_records WHERE id = ?1", [id])?;
    Ok(())
}

// -- 方案（图） -------------------------------------------------------------

pub fn list_plans(
    conn: &Connection,
    application_id: Option<&str>,
    environment_id: Option<&str>,
) -> Result<Vec<DeploymentPlan>> {
    let mut statement = match (application_id, environment_id) {
        (Some(_), Some(_)) => conn.prepare(
            "SELECT * FROM deployment_plans WHERE application_id = ?1 AND environment_id = ?2
             ORDER BY created_at DESC",
        )?,
        (Some(_), None) => conn.prepare(
            "SELECT * FROM deployment_plans WHERE application_id = ?1 ORDER BY created_at DESC",
        )?,
        (None, Some(_)) => conn.prepare(
            "SELECT * FROM deployment_plans WHERE environment_id = ?1 ORDER BY created_at DESC",
        )?,
        (None, None) => conn.prepare("SELECT * FROM deployment_plans ORDER BY created_at DESC")?,
    };
    let rows = match (application_id, environment_id) {
        (Some(application), Some(environment)) => {
            statement.query_map(params![application, environment], plan_from_row)?
        }
        (Some(application), None) => statement.query_map([application], plan_from_row)?,
        (None, Some(environment)) => statement.query_map([environment], plan_from_row)?,
        (None, None) => statement.query_map([], plan_from_row)?,
    };
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn plan_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeploymentPlan> {
    Ok(DeploymentPlan {
        id: row.get("id")?,
        application_id: row.get("application_id")?,
        environment_id: row.get("environment_id")?,
        name: row.get("name")?,
        version: row.get("version")?,
        status: enum_from_text(&row.get::<_, String>("status")?)?,
        proposal_source: enum_from_text(&row.get::<_, String>("proposal_source")?)?,
        risk_level: enum_from_text(&row.get::<_, String>("risk_level")?)?,
        notes: row.get("notes")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn get_plan(conn: &Connection, id: &str) -> Result<Option<DeploymentPlan>> {
    let mut statement = conn.prepare("SELECT * FROM deployment_plans WHERE id = ?1")?;
    let mut rows = statement.query_map([id], plan_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

fn plan_node_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PlanNode> {
    Ok(PlanNode {
        id: row.get("id")?,
        plan_id: row.get("plan_id")?,
        node_key: row.get("node_key")?,
        title: row.get("title")?,
        action: enum_from_text(&row.get::<_, String>("action")?)?,
        service_unit_id: row.get("service_unit_id")?,
        risk_level: enum_from_text(&row.get::<_, String>("risk_level")?)?,
        approval_required: row.get("approval_required")?,
        skippable: row.get("skippable")?,
        params_json: row.get("params_json")?,
        position: row.get("position")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn plan_edge_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PlanEdge> {
    Ok(PlanEdge {
        id: row.get("id")?,
        plan_id: row.get("plan_id")?,
        from_node_id: row.get("from_node_id")?,
        to_node_id: row.get("to_node_id")?,
        condition: enum_from_text(&row.get::<_, String>("condition")?)?,
        created_at: row.get("created_at")?,
    })
}

pub fn list_plan_nodes(conn: &Connection, plan_id: &str) -> Result<Vec<PlanNode>> {
    let mut statement = conn.prepare(
        "SELECT * FROM plan_nodes WHERE plan_id = ?1 ORDER BY position ASC, node_key ASC",
    )?;
    let rows = statement.query_map([plan_id], plan_node_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn list_plan_edges(conn: &Connection, plan_id: &str) -> Result<Vec<PlanEdge>> {
    let mut statement =
        conn.prepare("SELECT * FROM plan_edges WHERE plan_id = ?1 ORDER BY created_at ASC")?;
    let rows = statement.query_map([plan_id], plan_edge_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 读一个方案连同它的图。
pub fn get_plan_graph(conn: &Connection, id: &str) -> Result<Option<DeploymentPlanGraph>> {
    let Some(plan) = get_plan(conn, id)? else {
        return Ok(None);
    };
    Ok(Some(DeploymentPlanGraph {
        nodes: list_plan_nodes(conn, id)?,
        edges: list_plan_edges(conn, id)?,
        plan,
    }))
}

/// 整体保存一个方案图（事务）。
///
/// 节点与边是**整体替换**：先删边再删节点（外键顺序），然后按传入的顺序写入。
/// 调用方必须先跑 `validate::validate_plan_graph`。
pub fn upsert_plan_graph(conn: &Connection, graph: &DeploymentPlanGraph) -> Result<()> {
    let transaction = conn.unchecked_transaction()?;
    let plan = &graph.plan;
    transaction.execute(
        r#"
        INSERT INTO deployment_plans (
            id, application_id, environment_id, name, version, status, proposal_source,
            risk_level, notes, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        ON CONFLICT(id) DO UPDATE SET
            application_id=excluded.application_id,
            environment_id=excluded.environment_id,
            name=excluded.name,
            version=excluded.version,
            status=excluded.status,
            proposal_source=excluded.proposal_source,
            risk_level=excluded.risk_level,
            notes=excluded.notes,
            updated_at=excluded.updated_at
        "#,
        params![
            &plan.id,
            &plan.application_id,
            &plan.environment_id,
            &plan.name,
            plan.version,
            enum_to_text(&plan.status)?,
            enum_to_text(&plan.proposal_source)?,
            enum_to_text(&plan.risk_level)?,
            &plan.notes,
            plan.created_at,
            plan.updated_at,
        ],
    )?;

    transaction.execute("DELETE FROM plan_edges WHERE plan_id = ?1", [&plan.id])?;
    transaction.execute("DELETE FROM plan_nodes WHERE plan_id = ?1", [&plan.id])?;

    for node in &graph.nodes {
        transaction.execute(
            r#"
            INSERT INTO plan_nodes (
                id, plan_id, node_key, title, action, service_unit_id, risk_level,
                approval_required, skippable, params_json, position, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            "#,
            params![
                &node.id,
                &plan.id,
                &node.node_key,
                &node.title,
                enum_to_text(&node.action)?,
                node.service_unit_id.as_deref(),
                enum_to_text(&node.risk_level)?,
                node.approval_required,
                node.skippable,
                &node.params_json,
                node.position,
                node.created_at,
                node.updated_at,
            ],
        )?;
    }

    for edge in &graph.edges {
        transaction.execute(
            r#"
            INSERT INTO plan_edges (id, plan_id, from_node_id, to_node_id, condition, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            "#,
            params![
                &edge.id,
                &plan.id,
                &edge.from_node_id,
                &edge.to_node_id,
                enum_to_text(&edge.condition)?,
                edge.created_at,
            ],
        )?;
    }

    transaction.commit()?;
    Ok(())
}

pub fn delete_plan_cascade(conn: &Connection, id: &str) -> Result<i64> {
    let runs: i64 = conn.query_row(
        "SELECT COUNT(*) FROM deployment_runs WHERE plan_id = ?1",
        [id],
        |row| row.get(0),
    )?;
    conn.execute(
        "DELETE FROM run_nodes WHERE run_id IN (SELECT id FROM deployment_runs WHERE plan_id = ?1)",
        [id],
    )?;
    conn.execute("DELETE FROM deployment_runs WHERE plan_id = ?1", [id])?;
    conn.execute("DELETE FROM plan_edges WHERE plan_id = ?1", [id])?;
    conn.execute("DELETE FROM plan_nodes WHERE plan_id = ?1", [id])?;
    conn.execute("DELETE FROM deployment_plans WHERE id = ?1", [id])?;
    Ok(runs)
}

// -- 运行 -------------------------------------------------------------------

pub fn list_runs(
    conn: &Connection,
    application_id: Option<&str>,
    plan_id: Option<&str>,
    limit: i64,
) -> Result<Vec<DeploymentRun>> {
    let mut statement = match (application_id, plan_id) {
        (Some(_), Some(_)) => conn.prepare(
            "SELECT * FROM deployment_runs WHERE application_id = ?1 AND plan_id = ?2
             ORDER BY created_at DESC LIMIT ?3",
        )?,
        (Some(_), None) => conn.prepare(
            "SELECT * FROM deployment_runs WHERE application_id = ?1
             ORDER BY created_at DESC LIMIT ?2",
        )?,
        (None, Some(_)) => conn.prepare(
            "SELECT * FROM deployment_runs WHERE plan_id = ?1
             ORDER BY created_at DESC LIMIT ?2",
        )?,
        (None, None) => {
            conn.prepare("SELECT * FROM deployment_runs ORDER BY created_at DESC LIMIT ?1")?
        }
    };
    let rows = match (application_id, plan_id) {
        (Some(application), Some(plan)) => {
            statement.query_map(params![application, plan, limit], run_from_row)?
        }
        (Some(application), None) => {
            statement.query_map(params![application, limit], run_from_row)?
        }
        (None, Some(plan)) => statement.query_map(params![plan, limit], run_from_row)?,
        (None, None) => statement.query_map(params![limit], run_from_row)?,
    };
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn run_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeploymentRun> {
    Ok(DeploymentRun {
        id: row.get("id")?,
        plan_id: row.get("plan_id")?,
        application_id: row.get("application_id")?,
        environment_id: row.get("environment_id")?,
        server_id: row.get("server_id")?,
        server_name: row.get("server_name")?,
        status: enum_from_text(&row.get::<_, String>("status")?)?,
        trigger_source: enum_from_text(&row.get::<_, String>("trigger_source")?)?,
        plan_version: row.get("plan_version")?,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
        duration_ms: row.get("duration_ms")?,
        log: row.get("log")?,
        error_message: row.get("error_message")?,
        snapshot_json: row.get("snapshot_json")?,
        release_id: row.get("release_id")?,
        created_at: row.get("created_at")?,
    })
}

pub fn get_run(conn: &Connection, id: &str) -> Result<Option<DeploymentRun>> {
    let mut statement = conn.prepare("SELECT * FROM deployment_runs WHERE id = ?1")?;
    let mut rows = statement.query_map([id], run_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// 写入/更新一次运行 —— **只给后续阶段的 Workflow Engine 用**，P5.0 没有 IPC 入口。
pub fn upsert_run(conn: &Connection, run: &DeploymentRun) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO deployment_runs (
            id, plan_id, application_id, environment_id, server_id, server_name, status,
            trigger_source, plan_version, started_at, finished_at, duration_ms, log,
            error_message, snapshot_json, release_id, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
        ON CONFLICT(id) DO UPDATE SET
            status=excluded.status,
            trigger_source=excluded.trigger_source,
            plan_version=excluded.plan_version,
            started_at=excluded.started_at,
            finished_at=excluded.finished_at,
            duration_ms=excluded.duration_ms,
            log=excluded.log,
            error_message=excluded.error_message,
            snapshot_json=excluded.snapshot_json,
            release_id=excluded.release_id
        "#,
        params![
            &run.id,
            &run.plan_id,
            &run.application_id,
            &run.environment_id,
            &run.server_id,
            &run.server_name,
            enum_to_text(&run.status)?,
            enum_to_text(&run.trigger_source)?,
            run.plan_version,
            run.started_at,
            run.finished_at,
            run.duration_ms,
            &run.log,
            run.error_message.as_deref(),
            run.snapshot_json.as_deref(),
            run.release_id.as_deref(),
            run.created_at,
        ],
    )?;
    Ok(())
}

fn run_node_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RunNode> {
    Ok(RunNode {
        id: row.get("id")?,
        run_id: row.get("run_id")?,
        node_id: row.get("node_id")?,
        node_key: row.get("node_key")?,
        title: row.get("title")?,
        action: row.get("action")?,
        risk_level: enum_from_text(&row.get::<_, String>("risk_level")?)?,
        status: enum_from_text(&row.get::<_, String>("status")?)?,
        attempt: row.get("attempt")?,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
        duration_ms: row.get("duration_ms")?,
        exit_code: row.get("exit_code")?,
        output: row.get("output")?,
        error_message: row.get("error_message")?,
        created_at: row.get("created_at")?,
    })
}

pub fn list_run_nodes(conn: &Connection, run_id: &str) -> Result<Vec<RunNode>> {
    let mut statement =
        conn.prepare("SELECT * FROM run_nodes WHERE run_id = ?1 ORDER BY created_at ASC")?;
    let rows = statement.query_map([run_id], run_node_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 写入/更新一个节点执行记录（同样只给后续阶段的引擎用）。
pub fn upsert_run_node(conn: &Connection, node: &RunNode) -> Result<()> {
    conn.execute(
        r#"
        INSERT INTO run_nodes (
            id, run_id, node_id, node_key, title, action, risk_level, status, attempt,
            started_at, finished_at, duration_ms, exit_code, output, error_message, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
        ON CONFLICT(id) DO UPDATE SET
            action=excluded.action,
            risk_level=excluded.risk_level,
            status=excluded.status,
            attempt=excluded.attempt,
            started_at=excluded.started_at,
            finished_at=excluded.finished_at,
            duration_ms=excluded.duration_ms,
            exit_code=excluded.exit_code,
            output=excluded.output,
            error_message=excluded.error_message
        "#,
        params![
            &node.id,
            &node.run_id,
            node.node_id.as_deref(),
            &node.node_key,
            &node.title,
            &node.action,
            enum_to_text(&node.risk_level)?,
            enum_to_text(&node.status)?,
            node.attempt,
            node.started_at,
            node.finished_at,
            node.duration_ms,
            node.exit_code,
            &node.output,
            node.error_message.as_deref(),
            node.created_at,
        ],
    )?;
    Ok(())
}

// -- 版本 -------------------------------------------------------------------

pub fn list_releases(
    conn: &Connection,
    environment_id: Option<&str>,
    service_unit_id: Option<&str>,
) -> Result<Vec<ReleaseRecord>> {
    let mut statement = match (environment_id, service_unit_id) {
        (Some(_), Some(_)) => conn.prepare(
            "SELECT * FROM release_records WHERE environment_id = ?1 AND service_unit_id = ?2
             ORDER BY created_at DESC",
        )?,
        (Some(_), None) => conn.prepare(
            "SELECT * FROM release_records WHERE environment_id = ?1 ORDER BY created_at DESC",
        )?,
        (None, Some(_)) => conn.prepare(
            "SELECT * FROM release_records WHERE service_unit_id = ?1 ORDER BY created_at DESC",
        )?,
        (None, None) => conn.prepare("SELECT * FROM release_records ORDER BY created_at DESC")?,
    };
    let rows = match (environment_id, service_unit_id) {
        (Some(environment), Some(service)) => {
            statement.query_map(params![environment, service], release_from_row)?
        }
        (Some(environment), None) => statement.query_map([environment], release_from_row)?,
        (None, Some(service)) => statement.query_map([service], release_from_row)?,
        (None, None) => statement.query_map([], release_from_row)?,
    };
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn release_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReleaseRecord> {
    Ok(ReleaseRecord {
        id: row.get("id")?,
        application_id: row.get("application_id")?,
        environment_id: row.get("environment_id")?,
        service_unit_id: row.get("service_unit_id")?,
        run_id: row.get("run_id")?,
        version_label: row.get("version_label")?,
        artifact_id: row.get("artifact_id")?,
        is_active: row.get("is_active")?,
        activated_at: row.get("activated_at")?,
        replaced_release_id: row.get("replaced_release_id")?,
        nginx_backup_path: row.get("nginx_backup_path")?,
        image_digest: row.get("image_digest")?,
        config_snapshot_json: row.get("config_snapshot_json")?,
        status: enum_from_text(&row.get::<_, String>("status")?)?,
        notes: row.get("notes")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn get_release(conn: &Connection, id: &str) -> Result<Option<ReleaseRecord>> {
    let mut statement = conn.prepare("SELECT * FROM release_records WHERE id = ?1")?;
    let mut rows = statement.query_map([id], release_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// 写入/更新版本记录。
///
/// 若这条是 `is_active`，先把同一个服务的其它**生效中**版本让位：
/// 既置 `is_active = 0`（库层部分唯一索引要求一个服务只能有一个生效版本），
/// 也把状态改成 `superseded` —— 状态字段是给人和 UI 看的，不能只翻布尔量留下
/// 两条都写 `active` 的记录。
pub fn upsert_release(conn: &Connection, release: &ReleaseRecord) -> Result<()> {
    if release.is_active {
        if let Some(service_id) = release.service_unit_id.as_deref() {
            conn.execute(
                "UPDATE release_records
                    SET is_active = 0, status = 'superseded', updated_at = ?3
                  WHERE service_unit_id = ?1 AND id != ?2 AND is_active = 1",
                params![service_id, &release.id, AppDb::now()],
            )?;
        }
    }
    conn.execute(
        r#"
        INSERT INTO release_records (
            id, application_id, environment_id, service_unit_id, run_id, version_label,
            artifact_id, is_active, activated_at, replaced_release_id, nginx_backup_path,
            image_digest, config_snapshot_json, status, notes, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
        ON CONFLICT(id) DO UPDATE SET
            application_id=excluded.application_id,
            environment_id=excluded.environment_id,
            service_unit_id=excluded.service_unit_id,
            run_id=excluded.run_id,
            version_label=excluded.version_label,
            artifact_id=excluded.artifact_id,
            is_active=excluded.is_active,
            activated_at=excluded.activated_at,
            replaced_release_id=excluded.replaced_release_id,
            nginx_backup_path=excluded.nginx_backup_path,
            image_digest=excluded.image_digest,
            config_snapshot_json=excluded.config_snapshot_json,
            status=excluded.status,
            notes=excluded.notes,
            updated_at=excluded.updated_at
        "#,
        params![
            &release.id,
            &release.application_id,
            &release.environment_id,
            release.service_unit_id.as_deref(),
            release.run_id.as_deref(),
            &release.version_label,
            release.artifact_id.as_deref(),
            release.is_active,
            release.activated_at,
            release.replaced_release_id.as_deref(),
            release.nginx_backup_path.as_deref(),
            release.image_digest.as_deref(),
            release.config_snapshot_json.as_deref(),
            enum_to_text(&release.status)?,
            &release.notes,
            release.created_at,
            release.updated_at,
        ],
    )?;
    Ok(())
}

pub fn delete_release(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM release_records WHERE id = ?1", [id])?;
    Ok(())
}

/// 某个服务当前生效的版本。
/// 把某个服务当前生效的版本标记为"已回滚"（P5.3 引擎回滚收尾用）。
///
/// 只改状态、不删记录：版本历史必须留着，否则"回滚过几次"就查不出来了。
pub fn mark_release_rolled_back(conn: &Connection, service_unit_id: &str, now: i64) -> Result<()> {
    conn.execute(
        "UPDATE release_records SET status = ?1, is_active = 0, updated_at = ?2
         WHERE service_unit_id = ?3 AND is_active = 1",
        params![
            enum_to_text(&ReleaseStatus::RolledBack)?,
            now,
            service_unit_id
        ],
    )?;
    Ok(())
}

pub fn active_release(conn: &Connection, service_unit_id: &str) -> Result<Option<ReleaseRecord>> {
    let mut statement = conn.prepare(
        "SELECT * FROM release_records WHERE service_unit_id = ?1 AND is_active = 1 LIMIT 1",
    )?;
    let mut rows = statement.query_map([service_unit_id], release_from_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

// -- 迁移辅助（测试用） -----------------------------------------------------

/// 部署中心所有表的表名 —— 迁移测试用它断言 13 张表齐全。
pub const DEPLOYMENT_TABLES: &[&str] = &[
    "deployment_applications",
    "deployment_environments",
    "service_units",
    "service_relations",
    "capacity_profiles",
    "domain_bindings",
    "config_definitions",
    "secret_refs",
    "artifact_records",
    "deployment_plans",
    "plan_nodes",
    "plan_edges",
    "deployment_runs",
    "run_nodes",
    "release_records",
    // P5.1 制品导入任务（migration v10，见 `db/deployment_import.rs`）。
    "artifact_import_tasks",
    // P5.2 部署方案与安全策略（migration v11，见 `db/deployment_proposal.rs`）。
    "deployment_proposals",
    "deployment_security_policies",
];
