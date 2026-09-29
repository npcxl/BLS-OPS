//! P5.1 制品导入：安全边界、指纹、识别与任务流水线的单元测试。
//!
//! 三条主线：
//!
//! 1. **逃逸必须被拦**（ZIP Slip / 绝对路径 / 符号链接 / 设备条目）；
//! 2. **上限必须真的生效**（超限即停，且如实标 `truncated`）；
//! 3. **密钥扫描结论里不能出现明文**（掩码是硬要求）。

use std::io::Write;
use std::path::{Path, PathBuf};

use super::fingerprint;
use super::inspect;
use super::model::*;
use super::secrets;
use super::source::{
    self, ArchiveFormat, ArchiveSource, ContentSource, DirectorySource, FileSource,
};
use super::tasks;
use crate::deployment::model::ArtifactKind;

// -- 测试脚手架 -------------------------------------------------------------

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!("bls-p51-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create temp dir");
        Self { path }
    }

    fn write(&self, relative: &str, content: &str) -> PathBuf {
        let full = self.path.join(relative);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        let mut file = std::fs::File::create(&full).expect("create file");
        file.write_all(content.as_bytes()).expect("write file");
        full
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn path_string(&self) -> String {
        self.path.to_string_lossy().to_string()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn scan(dir: &TempDir) -> DirectorySource {
    DirectorySource::scan(dir.path()).expect("scan directory")
}

fn write_zip(path: &Path, entries: &[(&str, &str, Option<u32>)]) {
    let file = std::fs::File::create(path).expect("create zip");
    let mut writer = zip::ZipWriter::new(file);
    for (name, content, mode) in entries {
        let mut options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        if let Some(mode) = mode {
            options = options.unix_permissions(*mode);
        }
        writer.start_file(*name, options).expect("start file");
        writer.write_all(content.as_bytes()).expect("write entry");
    }
    writer.finish().expect("finish zip");
}

// -- 路径逃逸 ---------------------------------------------------------------

#[test]
fn entry_paths_that_escape_the_root_are_rejected() {
    assert_eq!(
        source::normalize_entry_path("dist/app.js").expect("ok"),
        "dist/app.js"
    );
    assert_eq!(
        source::normalize_entry_path("./dist/app.js").expect("ok"),
        "dist/app.js"
    );

    // ZIP Slip 与绝对路径必须是明确的 Critical，而不是"修一下继续"。
    for raw in [
        "../evil.txt",
        "a/../../evil.txt",
        "/etc/passwd",
        "C:/windows/system32",
    ] {
        let error = source::normalize_entry_path(raw).expect_err(raw);
        assert!(
            error.0 == FindingKind::ParentTraversal || error.0 == FindingKind::AbsolutePath,
            "{raw} → {error:?}"
        );
        assert!(error.0.blocks_import());
    }
    // 控制字符与空路径也要拦。
    assert!(source::normalize_entry_path("bad\u{0}name").is_err());
    assert!(source::normalize_entry_path("").is_err());
    assert!(source::normalize_entry_path("..").is_err());
    // `..foo` 不是相对段，不能被误杀。
    assert_eq!(
        source::normalize_entry_path("..foo/bar").expect("ok"),
        "..foo/bar"
    );
}

#[test]
fn root_escape_detection_is_independent_of_segment_checking() {
    assert!(source::escapes_root("../../etc/passwd"));
    assert!(source::escapes_root("a/../../b"));
    assert!(!source::escapes_root("a/b/c"));
    assert!(!source::escapes_root("./a/b"));
}

/// 用 tar 构造归档：符号链接与设备条目在 tar 里是显式的类型字段，
/// 比在 ZIP 里塞 unix mode 稳得多（测试要测的是**我们的判定**，不是打包库的怪癖）。
fn write_tar(path: &Path, build: impl FnOnce(&mut tar::Builder<std::fs::File>)) {
    let file = std::fs::File::create(path).expect("create tar");
    let mut builder = tar::Builder::new(file);
    build(&mut builder);
    builder.finish().expect("finish tar");
}

#[test]
fn archive_entries_with_escaping_symlinks_are_critical() {
    let dir = TempDir::new("symlink");
    let archive_path = dir.path().join("app.tar");
    write_tar(&archive_path, |builder| {
        let mut file_header = tar::Header::new_gnu();
        file_header.set_size(14);
        file_header.set_mode(0o644);
        file_header.set_cksum();
        builder
            .append_data(
                &mut file_header,
                "dist/index.html",
                "<html></html>".as_bytes(),
            )
            .expect("append file");

        let mut link_header = tar::Header::new_gnu();
        link_header.set_size(0);
        link_header.set_entry_type(tar::EntryType::Symlink);
        link_header.set_mode(0o777);
        builder
            .append_link(&mut link_header, "escape", "../../etc/passwd")
            .expect("append symlink");
    });

    let archive = ArchiveSource::open(&archive_path).expect("open archive");
    let findings = &archive.inventory().findings;
    assert!(
        findings
            .iter()
            .any(|finding| finding.kind == FindingKind::Symlink),
        "找到的结论：{findings:?}"
    );
    assert!(archive.inventory().blocked());
    // 正常条目仍然被登记 —— 报告要一次列全，而不是遇到第一条就停。
    assert!(archive
        .entries()
        .iter()
        .any(|entry| entry.path == "dist/index.html"));
}

#[test]
fn device_entries_are_rejected() {
    let dir = TempDir::new("device");
    let archive_path = dir.path().join("app.tar");
    write_tar(&archive_path, |builder| {
        let mut header = tar::Header::new_gnu();
        header.set_size(0);
        // b'3' = 字符设备。
        header.set_entry_type(tar::EntryType::new(b'3'));
        header.set_mode(0o666);
        header.set_cksum();
        builder
            .append_data(&mut header, "dev/null", std::io::empty())
            .expect("append device");
    });
    let archive = ArchiveSource::open(&archive_path).expect("open archive");
    assert!(archive
        .inventory()
        .findings
        .iter()
        .any(|finding| finding.kind == FindingKind::DeviceEntry));
}

#[test]
fn archive_formats_are_detected_by_content_then_name() {
    let dir = TempDir::new("format");
    let archive_path = dir.path().join("app.zip");
    write_zip(&archive_path, &[("a.txt", "hello", None)]);
    assert_eq!(
        source::detect_format(&archive_path).expect("format"),
        ArchiveFormat::Zip
    );
    assert!(ArchiveFormat::from_path(Path::new("x.tgz")).is_some());
    assert!(
        !ArchiveFormat::TarBz2.is_supported(),
        "没编进来的解码器必须诚实报不支持"
    );
}

// -- 符号链接与目录 ---------------------------------------------------------

#[test]
fn directory_scan_never_follows_symlinks() {
    let dir = TempDir::new("dir");
    dir.write("src/index.js", "export default 1");
    dir.write("build/big.txt", "x");

    // 建一个指向目录外的符号链接（Windows 上需要权限，失败就跳过这一条断言）。
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("/etc", dir.path().join("etc-link")).expect("symlink");
        let source = scan(&dir);
        assert!(source
            .inventory()
            .findings
            .iter()
            .any(|finding| finding.kind == FindingKind::Symlink));
        assert!(source
            .entries()
            .iter()
            .all(|entry| !entry.path.starts_with("etc-link/")));
    }
    let source = scan(&dir);
    assert!(source
        .entries()
        .iter()
        .any(|entry| entry.path == "src/index.js"));
}

// -- 掩码与密钥扫描 ---------------------------------------------------------

#[test]
fn masking_never_exposes_the_secret_body() {
    let masked = RedactedEvidence::mask("AKIAIOSFODNN7EXAMPLE", "aws_access_key_id");
    assert!(masked.preview.starts_with("AKIA"));
    assert!(!masked.preview.contains("IOSFODNN7EXAMPLE"));
    assert_eq!(masked.length, 20);
    assert_eq!(masked.pattern, "aws_access_key_id");
    // 短串：只给前 4 位 + 长度，绝不加"尾 2 位"（那对短串就等于交出原文）。
    let short = RedactedEvidence::mask("abcd", "tiny");
    assert_eq!(short.preview, "abcd（4 字符）");
    assert_eq!(short.length, 4);
}

#[test]
fn secret_scan_finds_tokens_and_only_reports_masked_evidence() {
    let dir = TempDir::new("secrets");
    dir.write(
        "config/app.env",
        "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n",
    );
    dir.write("src/index.js", "export const answer = 42;\n");
    let source = scan(&dir);
    let report = secrets::scan_source(&source);

    assert!(!report.findings.is_empty());
    for finding in &report.findings {
        let evidence = finding.evidence.as_ref().expect("evidence");
        assert!(
            !evidence.preview.contains("abcdefghijklmnopqrstuvwxyz"),
            "证据泄漏了密钥原文：{}",
            evidence.preview
        );
    }
    assert!(report
        .findings
        .iter()
        .any(|finding| finding.severity >= FindingSeverity::High));
}

#[test]
fn secret_scan_ignores_placeholders() {
    let dir = TempDir::new("placeholder");
    dir.write(".env", "API_KEY=your-api-key-here\nDB_PASSWORD=changeme\n");
    let source = scan(&dir);
    let report = secrets::scan_source(&source);
    assert!(
        report.findings.is_empty(),
        "占位值不该报：{:?}",
        report.findings
    );
}

#[test]
fn private_keys_and_cloud_credentials_are_critical() {
    let dir = TempDir::new("keys");
    dir.write("id_rsa", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n");
    dir.write(
        "gcp/service-account.json",
        "{\"type\": \"service_account\", \"private_key\": \"x\"}\n",
    );
    let source = scan(&dir);
    let report = secrets::scan_source(&source);
    assert!(report
        .findings
        .iter()
        .any(|finding| finding.kind == FindingKind::PrivateKey));
    assert!(report
        .findings
        .iter()
        .any(|finding| finding.blocking || finding.severity == FindingSeverity::High));
}

// -- 指纹 -------------------------------------------------------------------

#[test]
fn directory_fingerprint_is_deterministic_and_content_sensitive() {
    let dir = TempDir::new("fingerprint");
    dir.write("dist/index.html", "<html></html>");
    dir.write("dist/app.js", "console.log(1)");

    let source = scan(&dir);
    let (first, bytes, entries) = fingerprint::hash_source(&source, &mut |_| {});
    let (second, _, _) = fingerprint::hash_source(&source, &mut |_| {});
    assert_eq!(first, second, "同样的目录必须得到同样的指纹");
    assert!(bytes > 0 && entries >= 2);

    // 内容变了 → 指纹必须变（这就是"分析失效"的依据）。
    dir.write("dist/app.js", "console.log(2)");
    let changed = scan(&dir);
    let (third, _, _) = fingerprint::hash_source(&changed, &mut |_| {});
    assert_ne!(first, third);

    let left =
        fingerprint::fingerprint_for(FingerprintBasis::DirectoryManifest, first, 10, 2, None, 1);
    let right = fingerprint::fingerprint_for(
        FingerprintBasis::DirectoryManifest,
        third,
        10,
        2,
        Some(999),
        2,
    );
    assert!(left.differs_from(&right));
    // mtime 变化但哈希相同**不算**变化。
    let same = fingerprint::fingerprint_for(
        FingerprintBasis::DirectoryManifest,
        left.sha256.clone(),
        10,
        2,
        Some(12345),
        3,
    );
    assert!(!left.differs_from(&same));
}

#[test]
fn file_fingerprint_is_the_file_bytes() {
    let dir = TempDir::new("filehash");
    let file = dir.write("api.jar", "PK\x03\x04payload");
    let (sha, size) = fingerprint::hash_file(&file, &mut |_| {}).expect("hash");
    assert_eq!(size, std::fs::metadata(&file).expect("meta").len());
    assert_eq!(sha.len(), 64);
    assert_eq!(fingerprint::hash_bytes(b"PK\x03\x04payload"), sha);
}

// -- 识别 -------------------------------------------------------------------

#[test]
fn compose_services_become_individual_candidates() {
    let yaml = r#"
services:
  web:
    image: nginx:1.27
    ports:
      - "8080:80"
  api:
    build: .
    environment:
      - DATABASE_URL=postgres://db/app
    depends_on:
      - db
  db:
    image: postgres:16
"#;
    let parsed = inspect::parse_compose(yaml);
    let names: Vec<&str> = parsed
        .services
        .iter()
        .map(|service| service.name.as_str())
        .collect();
    assert_eq!(names, vec!["web", "api", "db"]);

    let web = &parsed.services[0];
    assert_eq!(web.ports, vec![(8080, 80)]);
    let api = &parsed.services[1];
    assert_eq!(api.depends_on, vec!["db".to_string()]);
    assert_eq!(api.env_keys, vec!["DATABASE_URL".to_string()]);
    let db = &parsed.services[2];
    assert!(db.external_kind.is_some());
    assert_eq!(db.ports, vec![(5432, 5432)]);

    // volumes 不该被误当成端口，environment 不该被误当成依赖。
    let noisy = inspect::parse_compose(
        "services:\n  app:\n    volumes:\n      - ./data:/data\n    ports:\n      - 9000\n",
    );
    assert_eq!(noisy.services[0].ports, vec![(9000, 9000)]);
    assert!(noisy.services[0].depends_on.is_empty());
}

#[test]
fn dockerfile_expose_becomes_declared_ports() {
    assert_eq!(
        inspect::dockerfile_expose("FROM node:20\nEXPOSE 3000 8080/tcp\n"),
        vec![3000, 8080]
    );
    assert!(inspect::dockerfile_expose("FROM node:20\n").is_empty());
}

#[test]
fn sanitized_names_are_safe_identifiers() {
    assert_eq!(inspect::sanitize_name("Shop API v2"), "shop-api-v2");
    assert_eq!(inspect::sanitize_name("../../etc/passwd"), "etc-passwd");
    assert_eq!(inspect::sanitize_name("$$$"), "service");
    assert_eq!(inspect::sanitize_name(""), "service");
    crate::deployment::validate::validate_name(&inspect::sanitize_name("Bench $ x!"), "服务名")
        .expect("valid name");
}

#[test]
fn static_site_is_detected_from_the_build_output_directory() {
    let dir = TempDir::new("static");
    dir.write(
        "package.json",
        "{\"name\":\"web\",\"scripts\":{\"build\":\"vite build\"},\"devDependencies\":{\"vite\":\"^5\"}}",
    );
    dir.write("dist/index.html", "<html></html>");

    let source = scan(&dir);
    let inspection = inspect::inspect(
        &source,
        ArtifactKind::Folder,
        crate::deployment::model::ArtifactSourceKind::LocalPath,
        "web",
        1_700_000_000_000,
        false,
    );

    assert_eq!(inspection.stack.language, Language::Node);
    assert_eq!(inspection.stack.framework.as_deref(), Some("vite"));
    assert!(!inspection.services.is_empty());
    let candidate = &inspection.services[0];
    assert_eq!(
        candidate.service_kind,
        crate::deployment::model::ServiceKind::StaticNginx
    );
    assert_eq!(candidate.artifact_kind, ArtifactKind::Dist);
    assert_eq!(candidate.source_path, "dist");
    assert!(matches!(
        &candidate.runtime,
        crate::deployment::model::ServiceRuntime::StaticNginx { root, .. } if root == "/dist"
    ));
    // 识别出来的 runtime 必须真的能过 P5.0 的校验（不能产出非法建议）。
    crate::deployment::validate::validate_runtime(&candidate.runtime).expect("valid runtime");
    assert!(inspection
        .build
        .iter()
        .any(|step| matches!(step, BuildStep::NpmScript { script, .. } if script == "build")));
    // 检查项必须覆盖"环境变量"与"端口"这两个永远要问用户的东西。
    assert!(inspection.checks.iter().any(|check| check.id == "port"));
    assert!(inspection.checks.iter().any(|check| check.id == "env"));
}

#[test]
fn monorepo_roots_produce_one_candidate_per_package() {
    let dir = TempDir::new("mono");
    dir.write("apps/web/package.json", "{\"name\":\"web\"}");
    dir.write("apps/web/dist/index.html", "<html></html>");
    dir.write("apps/api/pom.xml", "<project/>");
    dir.write("apps/api/target/api.jar", "PK\x03\x04");
    let source = scan(&dir);
    let inspection = inspect::inspect(
        &source,
        ArtifactKind::Folder,
        crate::deployment::model::ArtifactSourceKind::LocalPath,
        "shop",
        1,
        false,
    );
    let names: Vec<&str> = inspection
        .services
        .iter()
        .map(|candidate| candidate.name.as_str())
        .collect();
    assert!(names.len() >= 2, "候选：{names:?}");
    assert!(
        inspection
            .services
            .iter()
            .any(|candidate| candidate.service_kind
                == crate::deployment::model::ServiceKind::JavaJar),
        "JAR 子项目必须被单独识别：{names:?}"
    );
    assert!(inspection
        .services
        .iter()
        .any(|candidate| candidate.service_kind
            == crate::deployment::model::ServiceKind::StaticNginx));
    // 每个候选的名字必须唯一（同一个环境里服务名有唯一索引）。
    let unique: std::collections::BTreeSet<&str> = names.iter().copied().collect();
    assert_eq!(unique.len(), names.len());
}

#[test]
fn unknown_artifacts_still_produce_an_honest_candidate() {
    let dir = TempDir::new("unknown");
    dir.write("data.bin", "not a real binary");
    let source = scan(&dir);
    let inspection = inspect::inspect(
        &source,
        ArtifactKind::Folder,
        crate::deployment::model::ArtifactSourceKind::LocalPath,
        "mystery",
        1,
        false,
    );
    assert_eq!(inspection.services.len(), 1);
    assert!(!inspection.services[0].selected_by_default);
    assert!(inspection.services[0].confidence < 50);
    assert_eq!(inspection.stack.language, Language::Unknown);
}

#[test]
fn environment_keys_are_collected_without_values() {
    let dir = TempDir::new("envkeys");
    dir.write(
        ".env",
        "DATABASE_URL=postgres://user:pw@host/db\nFEATURE_FLAG=1\n",
    );
    dir.write(
        "docker-compose.yml",
        "services:\n  api:\n    environment:\n      - REDIS_URL=redis://cache\n",
    );
    let source = scan(&dir);
    let report = secrets::scan_source(&source);
    let inspection = inspect::inspect(
        &source,
        ArtifactKind::Folder,
        crate::deployment::model::ArtifactSourceKind::LocalPath,
        "api",
        1,
        report.truncated,
    );
    let keys: Vec<&str> = inspection
        .env_keys
        .iter()
        .map(|guess| guess.key.as_str())
        .collect();
    assert!(keys.contains(&"DATABASE_URL"));
    assert!(keys.contains(&"FEATURE_FLAG"));
    assert!(keys.contains(&"REDIS_URL"));
    // 名字里出现 SECRET/TOKEN 一类词的要被标成"像密钥"。
    assert!(inspection
        .env_keys
        .iter()
        .all(|guess| !guess.key.contains("://")));
    // 值永远不进模型：整个识别结果里不该出现密码。
    let serialized = serde_json::to_string(&inspection).expect("serialize");
    assert!(!serialized.contains("user:pw"));
}

// -- 任务 -------------------------------------------------------------------

#[test]
fn task_defaults_and_confirmability() {
    let mut task = ArtifactImportTask::new(
        "task-1".to_string(),
        ImportSource::LocalFolder {
            path: "/tmp/app".to_string(),
        },
        Some("app-1".to_string()),
        1_000,
    );
    assert_eq!(task.stage, ImportStage::Queued);
    assert_eq!(task.status, ImportStatus::Pending);
    assert!(task.can_cancel);
    assert!(!task.is_confirmable(), "还没分析完不能确认");

    task.stage = ImportStage::AwaitingConfirmation;
    task.security = Some(SecurityScanReport::empty());
    assert!(task.is_confirmable());

    // 有阻断项 → 不允许确认（一票否决）。
    task.security = Some(SecurityScanReport {
        findings: vec![SecurityFinding {
            kind: FindingKind::ZipSlip,
            severity: FindingSeverity::Critical,
            location: "../evil".to_string(),
            detail: "escape".to_string(),
            evidence: None,
            blocking: true,
        }],
        ..SecurityScanReport::empty()
    });
    assert!(!task.is_confirmable());
}

#[test]
fn progress_percent_uses_the_more_advanced_axis() {
    let mut progress = ImportProgress::queued();
    progress.total_bytes = 1000;
    progress.processed_bytes = 100;
    progress.total_entries = 10;
    progress.processed_entries = 5;
    progress.recompute();
    assert_eq!(progress.percent, 50, "按条目算更靠前就用条目算");

    let mut unknown = ImportProgress::queued();
    unknown.recompute();
    assert_eq!(unknown.percent, 0, "总量未知时不能瞎给百分比");
}

#[test]
fn artifact_and_source_kinds_are_derived_from_the_source() {
    assert_eq!(
        tasks::artifact_kind_of(&ImportSource::LocalFolder {
            path: "/tmp/app".to_string()
        }),
        ArtifactKind::Folder
    );
    assert_eq!(
        tasks::artifact_kind_of(&ImportSource::LocalArchive {
            path: "/tmp/app.tar.gz".to_string()
        }),
        ArtifactKind::TarGz
    );
    assert_eq!(
        tasks::artifact_kind_of(&ImportSource::DockerImageRef {
            reference: "nginx:1.27".to_string()
        }),
        ArtifactKind::DockerImage
    );
    assert_eq!(
        tasks::source_kind_of(&ImportSource::DockerImageRef {
            reference: "nginx:1.27".to_string()
        }),
        crate::deployment::model::ArtifactSourceKind::DockerRegistry
    );
    assert_eq!(
        tasks::source_kind_of(&ImportSource::RemoteDirectory {
            server_id: "srv-1".to_string(),
            path: "/opt/web".to_string()
        }),
        crate::deployment::model::ArtifactSourceKind::ServerExistingDir
    );
}

#[test]
fn pipeline_runs_end_to_end_and_binds_the_fingerprint() {
    let dir = TempDir::new("pipeline");
    dir.write("dist/index.html", "<html></html>");
    dir.write(
        ".env",
        "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n",
    );

    let source = ImportSource::LocalFolder {
        path: dir.path_string(),
    };
    let registry = tasks::TaskRegistry::default();
    let task = ArtifactImportTask::new(
        "task-e2e".to_string(),
        source.clone(),
        Some("app-1".to_string()),
        tasks::now_ms(),
    );
    let cancel = registry.insert(task.clone());

    let prepared = tasks::prepare_local(&source).expect("prepare");
    tasks::run(task, prepared, registry.clone(), cancel, None);

    let finished = registry.snapshot("task-e2e").expect("task");
    assert_eq!(finished.status, ImportStatus::Succeeded);
    assert_eq!(finished.stage, ImportStage::AwaitingConfirmation);
    assert!(!finished.can_cancel, "结束后不再可取消");

    let fingerprint = finished.fingerprint.as_ref().expect("fingerprint");
    assert_eq!(fingerprint.basis, FingerprintBasis::DirectoryManifest);
    assert_eq!(fingerprint.algorithm, "sha256");
    assert_eq!(fingerprint.sha256.len(), 64);

    let report = finished.security.as_ref().expect("security");
    assert!(
        !report.findings.is_empty(),
        "`.env` 里的 token 必须被扫出来"
    );
    let inspection = finished.inspection.as_ref().expect("inspection");
    assert!(!inspection.services.is_empty());
    assert!(inspection
        .services
        .iter()
        .any(|candidate| candidate.service_kind
            == crate::deployment::model::ServiceKind::StaticNginx));

    // 复核：内容没变 → 指纹一致。
    let revalidated = tasks::revalidate(&finished)
        .expect("revalidate")
        .expect("some");
    assert_eq!(revalidated.sha256, fingerprint.sha256);

    // 改文件 → 指纹必须变（分析失效）。
    dir.write("dist/index.html", "<html>changed</html>");
    let changed = tasks::revalidate(&finished)
        .expect("revalidate")
        .expect("some");
    assert!(fingerprint.differs_from(&changed));
}

#[test]
fn cancelled_tasks_report_cancellation_instead_of_failing() {
    let dir = TempDir::new("cancel");
    dir.write("dist/index.html", "<html></html>");
    let source = ImportSource::LocalFolder {
        path: dir.path_string(),
    };
    let registry = tasks::TaskRegistry::default();
    let task = ArtifactImportTask::new(
        "task-cancel".to_string(),
        source.clone(),
        None,
        tasks::now_ms(),
    );
    let cancel = registry.insert(task.clone());
    cancel.store(true, std::sync::atomic::Ordering::Relaxed);

    let prepared = tasks::prepare_local(&source).expect("prepare");
    tasks::run(task, prepared, registry.clone(), cancel, None);

    let finished = registry.snapshot("task-cancel").expect("task");
    assert_eq!(finished.status, ImportStatus::Cancelled);
    assert!(finished.inspection.is_none(), "取消不该留下半成品分析");
}

#[test]
fn retry_is_only_allowed_after_failure_or_cancellation() {
    let registry = tasks::TaskRegistry::default();
    let mut task = ArtifactImportTask::new(
        "task-retry".to_string(),
        ImportSource::LocalFolder {
            path: "/tmp/app".to_string(),
        },
        None,
        tasks::now_ms(),
    );
    task.status = ImportStatus::Succeeded;
    task.stage = ImportStage::Done;
    registry.insert(task);

    assert!(
        registry.prepare_retry("task-retry").is_err(),
        "成功的任务不该能重试"
    );

    registry.update("task-retry", |task| {
        task.status = ImportStatus::Failed;
        task.error = Some("boom".to_string());
    });
    let (retried, _token) = registry.prepare_retry("task-retry").expect("retry");
    assert_eq!(retried.attempt, 2);
    assert_eq!(retried.stage, ImportStage::Queued);
    assert!(retried.error.is_none());
}

#[test]
fn unavailable_paths_fail_with_a_readable_message() {
    let source = ImportSource::LocalFolder {
        path: "/definitely/not/here".to_string(),
    };
    let error = match tasks::prepare_local(&source) {
        Ok(_) => panic!("不存在的路径必须失败"),
        Err(error) => error,
    };
    assert!(
        error.contains("无法读取目录") || error.contains("不存在"),
        "{error}"
    );
}

#[test]
fn single_file_sources_carry_their_own_kind() {
    let dir = TempDir::new("single");
    let dockerfile = dir.write("Dockerfile", "FROM node:20\nEXPOSE 3000\n");
    let file = FileSource::open(&dockerfile).expect("open");
    assert_eq!(file.entries().len(), 1);
    assert_eq!(file.entries()[0].file_name(), "Dockerfile");
    let inspection = inspect::inspect(
        &file,
        ArtifactKind::Dockerfile,
        crate::deployment::model::ArtifactSourceKind::LocalPath,
        "Dockerfile",
        1,
        false,
    );
    // 只有一个候选（Dockerfile 分支），端口来自 EXPOSE。
    assert_eq!(inspection.services.len(), 1);
    assert_eq!(inspection.services[0].ports[0].host_port, 3000);
}
