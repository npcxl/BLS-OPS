/**
 * 枚举标签表测试。
 *
 * 两层保障：
 * 1. `Record<联合类型, string>` 在**编译期**保证不漏项（TS 会直接报错）；
 * 2. 这里在**运行期**再核对一遍取值清单，并断言每个标签 key 在 zh-CN 里真有译文 ——
 *    `Record` 只保证"有一个字符串"，保证不了"这个字符串被翻译过"。
 */

import { describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import {
  ACTION_LABELS,
  APPLICATION_KIND_LABELS,
  ARTIFACT_KIND_LABELS,
  ARTIFACT_SOURCE_LABELS,
  ARTIFACT_STATUS_LABELS,
  CHECK_STATE_LABELS,
  CONFIG_DATA_TYPE_LABELS,
  CONFIG_SCOPE_LABELS,
  CONFIG_SOURCE_LABELS,
  CONFLICT_RESOLUTION_LABELS,
  DEPENDENCY_KIND_LABELS,
  DNS_STATUS_LABELS,
  EVIDENCE_CLASS_LABELS,
  ENVIRONMENT_KIND_LABELS,
  ESTIMATION_BASIS_LABELS,
  FAILURE_POLICY_LABELS,
  FINDING_KIND_LABELS,
  FINDING_SEVERITY_LABELS,
  FINGERPRINT_BASIS_LABELS,
  IMPORT_STAGE_LABELS,
  IMPORT_STATUS_LABELS,
  PLAN_STATUS_LABELS,
  PROPOSAL_SOURCE_LABELS,
  RELEASE_STATUS_LABELS,
  RELATION_KIND_LABELS,
  RISK_LABELS,
  RUN_ACTION_KIND_LABELS,
  RUN_ACTION_PHASE_LABELS,
  RISK_TONES,
  RUN_NODE_STATUS_LABELS,
  RUN_STATUS_LABELS,
  RUNTIME_KIND_LABELS,
  SECRET_STORE_LABELS,
  SERVICE_KIND_LABELS,
  SERVICE_ROLE_LABELS,
  SOURCE_KIND_LABELS,
  SSL_MODE_LABELS,
  SSL_STATUS_LABELS,
  TOPOLOGY_KIND_LABELS,
  UNKNOWN_SEVERITY_LABELS,
  VIOLATION_KIND_LABELS,
} from "../labels";

/** Rust 侧的取值清单（改枚举时这里也要改 —— 故意的双重检查）。 */
const EXPECTED = {
  applicationKind: ["frontend", "backend", "full_stack", "static_site", "worker", "scheduled_task"],
  sourceKind: ["git", "local_upload", "existing_remote_dir"],
  environmentKind: ["development", "testing", "staging", "production"],
  serviceRole: ["web", "api", "worker", "scheduler", "gateway", "database", "cache", "static", "other"],
  serviceKind: [
    "static_nginx",
    "systemd_unit",
    "docker_image",
    "docker_compose",
    "java_jar",
    "node_process",
    "python_venv",
    "native_binary",
    "external_managed",
  ],
  runtimeKind: ["static_nginx", "systemd_unit", "docker_image", "docker_compose", "native_process", "external"],
  relationKind: ["depends_on", "provides_to", "shares_network", "shares_volume", "order_before"],
  failurePolicy: ["block", "warn", "ignore"],
  planStatus: ["draft", "ready", "approved", "rejected", "archived"],
  proposalSource: ["manual", "template", "ai_proposed"],
  riskLevel: ["low", "medium", "high", "critical"],
  runStatus: ["pending", "running", "paused", "succeeded", "failed", "cancelled", "rolled_back"],
  runNodeStatus: ["pending", "running", "succeeded", "failed", "skipped", "cancelled", "blocked"],
  releaseStatus: ["active", "superseded", "rolled_back", "failed"],
  dnsStatus: ["unknown", "unchecked", "resolved", "mismatched"],
  sslMode: ["none", "manual", "acme"],
  sslStatus: ["not_applicable", "pending", "issued", "expiring", "expired", "failed"],
  estimationBasis: ["user_provided", "estimated", "unknown"],
  configDataType: ["string", "number", "boolean", "url", "port", "path", "json"],
  configScope: ["build_time", "runtime", "reload", "restart"],
  configSource: ["literal", "secret_ref", "dependency_ref", "environment_ref", "generated", "file", "ai_proposed"],
  secretStore: ["keyring", "runtime_temp_file"],
  artifactKind: [
    "folder",
    "zip",
    "tar",
    "tar_gz",
    "dist",
    "jar",
    "binary",
    "docker_image",
    "compose_file",
    "dockerfile",
    "git_ref",
  ],
  artifactSource: ["local_path", "server_existing_dir", "docker_registry", "git_ref"],
  artifactStatus: ["draft", "ready", "uploaded", "active", "archived", "failed", "missing"],
  // -- P5.1 制品导入 --
  importStage: [
    "queued",
    "hashing",
    "security_scan",
    "inspecting",
    "awaiting_confirmation",
    "uploading",
    "done",
  ],
  importStatus: ["pending", "running", "succeeded", "failed", "cancelled"],
  findingSeverity: ["info", "low", "medium", "high", "critical"],
  findingKind: [
    "zip_slip",
    "absolute_path",
    "parent_traversal",
    "symlink",
    "hardlink",
    "device_entry",
    "encrypted_entry",
    "entry_count_limit",
    "file_size_limit",
    "total_size_limit",
    "compression_ratio_limit",
    "depth_limit",
    "path_length_limit",
    "private_key",
    "access_token",
    "credential_file",
    "cloud_credential",
    "package_registry_token",
    "docker_registry_auth",
    "executable_bit",
    "nested_archive",
  ],
  checkState: ["ready", "unknown", "blocked"],
  fingerprintBasis: [
    "file_bytes",
    "archive_bytes",
    "directory_manifest",
    "image_reference",
    "remote_listing",
  ],
  dependencyKind: ["database", "cache", "queue", "search", "object_storage", "mail", "other"],
  // -- P5.2 部署方案 --
  topologyKind: [
    "static_nginx",
    "systemd_processes",
    "docker_compose",
    "docker_images",
    "hybrid_gateway",
  ],
  evidenceClass: ["fact", "inference", "recommendation", "unknown"],
  unknownSeverity: ["info", "blocks_approval", "blocks_plan"],
  violationKind: ["schema", "capability", "path", "secret", "permission", "risk", "shell"],
  conflictResolution: [
    "unresolved",
    "server_fact_wins",
    "policy_wins",
    "not_actually_conflicting",
  ],
  action: [
    "fetch_source",
    "build_artifact",
    "package_artifact",
    "upload_artifact",
    "extract_artifact",
    "pull_image",
    "build_image",
    "push_image",
    "resolve_config",
    "render_env_file",
    "check_dependencies",
    "database_migration",
    "provision_service",
    "start_service",
    "stop_service",
    "restart_service",
    "compose_up",
    "compose_down",
    "apply_nginx_site",
    "test_nginx_config",
    "reload_nginx",
    "bind_domain",
    "request_certificate",
    "renew_certificate",
    "http_health_check",
    "tcp_health_check",
    "container_health_check",
    "activate_release",
    "restore_release",
    "restore_nginx_backup",
  ],
  // P5.3 类型化动作（与 Rust `ActionKind::ALL` 逐字一致）。
  runActionKind: [
    "check_dependencies",
    "ensure_directory",
    "prepare_release_directory",
    "upload_artifact",
    "verify_checksum",
    "extract_archive",
    "build_docker_image",
    "pull_docker_image",
    "write_runtime_config",
    "write_compose_file",
    "compose_up",
    "compose_down",
    "wait_container_healthy",
    "restart_systemd_unit",
    "backup_nginx_config",
    "write_nginx_config",
    "restore_nginx_backup",
    "test_nginx_config",
    "reload_nginx",
    "verify_dns_record",
    "issue_certificate",
    "renew_certificate",
    "http_health_check",
    "tcp_health_check",
    "switch_release_symlink",
    "promote_release",
    "stop_previous_release",
    "rollback_release",
    "require_manual_step",
  ],
  runActionPhase: [
    "preflight",
    "prepare",
    "configure",
    "provision",
    "gateway",
    "certificate",
    "health",
    "promote",
    "rollback",
  ],
} as const;

const MAPS: [string, Record<string, string>, readonly string[]][] = [
  ["applicationKind", APPLICATION_KIND_LABELS, EXPECTED.applicationKind],
  ["sourceKind", SOURCE_KIND_LABELS, EXPECTED.sourceKind],
  ["environmentKind", ENVIRONMENT_KIND_LABELS, EXPECTED.environmentKind],
  ["serviceRole", SERVICE_ROLE_LABELS, EXPECTED.serviceRole],
  ["serviceKind", SERVICE_KIND_LABELS, EXPECTED.serviceKind],
  ["runtimeKind", RUNTIME_KIND_LABELS, EXPECTED.runtimeKind],
  ["relationKind", RELATION_KIND_LABELS, EXPECTED.relationKind],
  ["failurePolicy", FAILURE_POLICY_LABELS, EXPECTED.failurePolicy],
  ["planStatus", PLAN_STATUS_LABELS, EXPECTED.planStatus],
  ["proposalSource", PROPOSAL_SOURCE_LABELS, EXPECTED.proposalSource],
  ["riskLevel", RISK_LABELS, EXPECTED.riskLevel],
  ["runStatus", RUN_STATUS_LABELS, EXPECTED.runStatus],
  ["runNodeStatus", RUN_NODE_STATUS_LABELS, EXPECTED.runNodeStatus],
  ["releaseStatus", RELEASE_STATUS_LABELS, EXPECTED.releaseStatus],
  ["dnsStatus", DNS_STATUS_LABELS, EXPECTED.dnsStatus],
  ["sslMode", SSL_MODE_LABELS, EXPECTED.sslMode],
  ["sslStatus", SSL_STATUS_LABELS, EXPECTED.sslStatus],
  ["estimationBasis", ESTIMATION_BASIS_LABELS, EXPECTED.estimationBasis],
  ["configDataType", CONFIG_DATA_TYPE_LABELS, EXPECTED.configDataType],
  ["configScope", CONFIG_SCOPE_LABELS, EXPECTED.configScope],
  ["configSource", CONFIG_SOURCE_LABELS, EXPECTED.configSource],
  ["secretStore", SECRET_STORE_LABELS, EXPECTED.secretStore],
  ["artifactKind", ARTIFACT_KIND_LABELS, EXPECTED.artifactKind],
  ["artifactSource", ARTIFACT_SOURCE_LABELS, EXPECTED.artifactSource],
  ["artifactStatus", ARTIFACT_STATUS_LABELS, EXPECTED.artifactStatus],
  ["action", ACTION_LABELS, EXPECTED.action],
  ["importStage", IMPORT_STAGE_LABELS, EXPECTED.importStage],
  ["importStatus", IMPORT_STATUS_LABELS, EXPECTED.importStatus],
  ["findingSeverity", FINDING_SEVERITY_LABELS, EXPECTED.findingSeverity],
  ["findingKind", FINDING_KIND_LABELS, EXPECTED.findingKind],
  ["checkState", CHECK_STATE_LABELS, EXPECTED.checkState],
  ["fingerprintBasis", FINGERPRINT_BASIS_LABELS, EXPECTED.fingerprintBasis],
  ["dependencyKind", DEPENDENCY_KIND_LABELS, EXPECTED.dependencyKind],
  ["topologyKind", TOPOLOGY_KIND_LABELS, EXPECTED.topologyKind],
  ["evidenceClass", EVIDENCE_CLASS_LABELS, EXPECTED.evidenceClass],
  ["unknownSeverity", UNKNOWN_SEVERITY_LABELS, EXPECTED.unknownSeverity],
  ["violationKind", VIOLATION_KIND_LABELS, EXPECTED.violationKind],
  ["conflictResolution", CONFLICT_RESOLUTION_LABELS, EXPECTED.conflictResolution],
  ["runActionKind", RUN_ACTION_KIND_LABELS, EXPECTED.runActionKind],
  ["runActionPhase", RUN_ACTION_PHASE_LABELS, EXPECTED.runActionPhase],
];

describe("枚举标签表", () => {
  it("每个枚举取值都有标签，且没有多余项", () => {
    for (const [name, map, expected] of MAPS) {
      expect(Object.keys(map).sort(), `${name} 的取值清单`).toEqual([...expected].sort());
    }
  });

  it("每个标签都是非空英文 key", () => {
    for (const [name, map] of MAPS) {
      for (const [key, label] of Object.entries(map)) {
        expect(label.trim().length, `${name}.${key} 的标签`).toBeGreaterThan(0);
      }
    }
  });

  it("风险配色覆盖全部风险级别", () => {
    expect(Object.keys(RISK_TONES).sort()).toEqual(["critical", "high", "low", "medium"]);
  });
});

describe("标签在 zh-CN 里有译文", () => {
  /** 缺失清单用换行拼接，失败信息里能一眼看全（vitest 会截断长数组）。 */
  function missingLabels(locale: string): string {
    const missing: string[] = [];
    for (const [name, map] of MAPS) {
      for (const [key, label] of Object.entries(map)) {
        if (i18n.t(label) === label) missing.push(`${name}.${key} → ${label}`);
      }
    }
    return `${locale} 缺失译文：\n${missing.join("\n")}`;
  }

  it("每一个标签 key 都能翻译成中文（不是回退成英文原文）", async () => {
    await i18n.changeLanguage("zh-CN");
    const missing = missingLabels("zh-CN").split("\n").slice(1);
    expect(missing.join("\n")).toBe("");
  });

  it("zh-TW 同样有译文", async () => {
    await i18n.changeLanguage("zh-TW");
    const missing = missingLabels("zh-TW").split("\n").slice(1);
    expect(missing.join("\n")).toBe("");
    await i18n.changeLanguage("zh-CN");
  });
});
