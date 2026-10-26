//! Credential commands.
//!
//! Secrets live in the OS keyring. They are read here, in Rust, and are never
//! returned to the WebView — there is intentionally no `credential_get_secret`.

use serde::Serialize;
use tauri::State;

use super::{open_db, record_audit};
use crate::{db, db::CredentialRecord, keyring, state::AppState};

#[tauri::command]
pub fn credential_list(state: State<'_, AppState>) -> Result<Vec<CredentialRecord>, String> {
    let conn = open_db(&state)?;
    db::list_credentials(&conn).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn credential_save(
    state: State<'_, AppState>,
    credential: CredentialRecord,
    secret: Option<String>,
    passphrase: Option<String>,
) -> Result<CredentialRecord, String> {
    let conn = open_db(&state)?;
    if credential.name.trim().is_empty() || credential.username.trim().is_empty() {
        return Err("凭据名称和用户名不能为空".to_string());
    }

    // `private_key_passphrase` was a legacy type; passphrase + key is now one
    // configuration instead of two mutually exclusive ones.
    let credential_type = match credential.credential_type.as_str() {
        "password" | "private_key" => credential.credential_type.clone(),
        "private_key_passphrase" => "private_key".to_string(),
        other => return Err(format!("不支持的凭据类型：{other}")),
    };

    let existing = db::get_credential(&conn, &credential.id).map_err(|error| error.to_string())?;
    let mut credential = credential;
    credential.credential_type = credential_type;
    credential.name = credential.name.trim().to_string();
    credential.username = credential.username.trim().to_string();
    credential.updated_at = db::AppDb::now();

    let trimmed_secret = secret
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let trimmed_passphrase = passphrase
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let is_new_secret = trimmed_secret.is_some();

    if existing.is_none() && trimmed_secret.is_none() {
        return Err(match credential.credential_type.as_str() {
            "private_key" => "请粘贴私钥内容".to_string(),
            _ => "请填写密码".to_string(),
        });
    }
    if trimmed_passphrase.is_some() && credential.credential_type != "private_key" {
        return Err("只有私钥凭据可以设置私钥口令".to_string());
    }

    // Keyring first: if it fails nothing has been persisted yet, and if the DB
    // write fails below we roll the keyring entry back instead of orphaning it.
    let mut written: Vec<String> = Vec::new();
    let secret_ref = credential
        .secret_ref
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("cred-{}", uuid::Uuid::new_v4()));
    let passphrase_ref = credential
        .passphrase_ref
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("cred-{}-pass", uuid::Uuid::new_v4()));

    if let Some(value) = trimmed_secret {
        keyring::save_secret(&secret_ref, value).map_err(|error| error.to_string())?;
        written.push(secret_ref.clone());
        credential.secret_ref = Some(secret_ref);
    }
    if let Some(value) = trimmed_passphrase {
        keyring::save_secret(&passphrase_ref, value).map_err(|error| error.to_string())?;
        written.push(passphrase_ref.clone());
        credential.passphrase_ref = Some(passphrase_ref);
    }

    match db::insert_or_replace_credential(&conn, &credential) {
        Ok(()) => {
            // Drop passphrase entries that are no longer wanted.
            if trimmed_passphrase.is_none() {
                if let Some(reference) = credential.passphrase_ref.as_deref() {
                    if !written.iter().any(|item| item == reference) {
                        let _ = keyring::delete_secret(reference);
                    }
                }
                credential.passphrase_ref = None;
                let _ = db::insert_or_replace_credential(&conn, &credential);
            }
            record_audit(
                &state,
                if existing.is_none() {
                    "credential_create"
                } else {
                    "credential_update"
                },
                None,
                None,
                &format!("{} (secret={})", credential.name, is_new_secret),
            );
            db::get_credential(&conn, &credential.id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "保存凭据后无法读取记录".to_string())
        }
        Err(error) => {
            for reference in written {
                let _ = keyring::delete_secret(&reference);
            }
            Err(error.to_string())
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CredentialDeleteResult {
    pub deleted: bool,
    /// Servers that would lose their credential if the delete went through.
    pub references: i64,
}

#[tauri::command]
pub fn credential_delete(
    state: State<'_, AppState>,
    id: String,
    force: Option<bool>,
) -> Result<CredentialDeleteResult, String> {
    let conn = open_db(&state)?;
    let credential = db::get_credential(&conn, &id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "凭据不存在".to_string())?;
    let references =
        db::count_servers_by_credential(&conn, &id).map_err(|error| error.to_string())?;

    if references > 0 && force != Some(true) {
        return Ok(CredentialDeleteResult {
            deleted: false,
            references,
        });
    }

    db::delete_credential(&conn, &id).map_err(|error| error.to_string())?;
    for reference in [credential.secret_ref, credential.passphrase_ref]
        .into_iter()
        .flatten()
    {
        if !reference.trim().is_empty() {
            let _ = keyring::delete_secret(&reference);
        }
    }
    record_audit(&state, "credential_delete", None, None, &credential.name);
    Ok(CredentialDeleteResult {
        deleted: true,
        references,
    })
}

// -- 私钥文件导入（受限读取）------------------------------------------------
//
// 为什么是后端读而不是前端读：前端没有"任意读文件"的能力，路径只能来自
// 系统文件选择器，读取范围被大小 + 私钥格式两条规则限死。
//
// 为什么不靠扩展名白名单：最常见的私钥文件名是 `id_rsa` / `id_ed25519`，
// **根本没有扩展名**。按扩展名过滤会把最该支持的场景挡在外面，
// 所以主防线是**内容必须真的像私钥**。

/// 私钥文件大小上限（64 KiB）。
///
/// 真实的 OpenSSH 私钥通常 1–3 KiB，PEM 更小；留到 64 KiB 只是给带注释 /
/// 多密钥的导出文件一点余量，不是"允许读大文件"。
pub const MAX_PRIVATE_KEY_BYTES: u64 = 64 * 1024;

/// PEM 系列的私钥头（OpenSSH 的 `BEGIN OPENSSH PRIVATE KEY` 也在其中）。
const PEM_MARKERS: &[&str] = &[
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN EC PRIVATE KEY-----",
    "-----BEGIN DSA PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----",
    "-----BEGIN ENCRYPTED PRIVATE KEY-----",
];

/// PuTTY 私钥（`.ppk`）的头。
const PPK_MARKER: &str = "PuTTY-User-Key-File-";

/// 从本地文件导入的私钥（**只返回内容，不落库**）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ImportedPrivateKey {
    /// 原始文件名（用于界面显示"从哪个文件来的"）。
    pub file_name: String,
    /// 私钥文本（已去掉 UTF-8 BOM）。
    pub content: String,
    /// 实际读取的字节数。
    pub bytes: u64,
    /// `openssh` / `pem` / `ppk`
    pub format: String,
    /// 私钥**本身**是否需要口令。
    ///
    /// `None` = 无法从文本判断。OpenSSH 私钥的加密信息在 base64 的二进制
    /// blob 里，文本层面看不出来 —— 与其猜，不如老实说"不知道"，
    /// 让解析器（`decode_secret_key`）去判定口令对不对。
    pub encrypted: Option<bool>,
}

/// 读取一个本地私钥文件，交给前端填入凭据表单（用户确认后才保存）。
#[tauri::command]
pub async fn credential_read_private_key_file(path: String) -> Result<ImportedPrivateKey, String> {
    read_private_key_file(&path)
}

/// 受限地读一个私钥文件（纯逻辑，便于单测）。
fn read_private_key_file(path: &str) -> Result<ImportedPrivateKey, String> {
    let path = std::path::Path::new(path);
    let metadata = std::fs::metadata(path).map_err(|error| format!("无法读取文件：{error}"))?;
    if !metadata.is_file() {
        return Err("选择的不是文件".to_string());
    }
    if metadata.len() > MAX_PRIVATE_KEY_BYTES {
        return Err(format!(
            "文件太大（{} KiB）：私钥文件上限 {} KiB",
            metadata.len() / 1024,
            MAX_PRIVATE_KEY_BYTES / 1024
        ));
    }

    let bytes = std::fs::read(path).map_err(|error| format!("无法读取文件：{error}"))?;
    // 读入后再查一次：避免"检查与读取之间文件被换掉"。
    let size = bytes.len() as u64;
    if size > MAX_PRIVATE_KEY_BYTES {
        return Err(format!(
            "文件太大（{} KiB）：私钥文件上限 {} KiB",
            size / 1024,
            MAX_PRIVATE_KEY_BYTES / 1024
        ));
    }
    let content = String::from_utf8(bytes).map_err(|_| {
        "文件不是 UTF-8 文本：私钥应当是 OpenSSH / PEM / PuTTY 的文本格式".to_string()
    })?;
    let content = content.trim_start_matches('\u{feff}').to_string();

    // **主防线**：内容必须真的像私钥。
    let is_pem = PEM_MARKERS
        .iter()
        .any(|marker| content.contains(marker));
    let is_ppk = content.contains(PPK_MARKER);
    if !is_pem && !is_ppk {
        return Err(
            "这个文件看起来不是私钥（找不到 OpenSSH / PEM / PuTTY 的私钥头）".to_string(),
        );
    }

    let format = if content.contains("-----BEGIN OPENSSH PRIVATE KEY-----") {
        "openssh"
    } else if is_ppk {
        "ppk"
    } else {
        "pem"
    };
    // 只有 PEM / PPK 能从文本可靠判断；OpenSSH 交给解析器。
    //
    // 注意顺序：OpenSSH 私钥**也**以 `-----BEGIN ... PRIVATE KEY-----` 开头，
    // 会同时命中 `is_pem`，所以必须先把它摘出来，否则会误报"未加密"。
    let is_openssh = content.contains("-----BEGIN OPENSSH PRIVATE KEY-----");
    let encrypted = if is_ppk {
        // `Encryption: none` 表示未加密。
        Some(!content.contains("Encryption: none"))
    } else if is_openssh {
        None
    } else {
        Some(content.contains("ENCRYPTED"))
    };

    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("id_key")
        .to_string();

    Ok(ImportedPrivateKey {
        file_name,
        content,
        bytes: size,
        format: format.to_string(),
        encrypted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "bls-ops-key-test-{}-{name}",
            uuid::Uuid::new_v4()
        ));
        let mut file = std::fs::File::create(&path).expect("create");
        file.write_all(bytes).expect("write");
        path
    }

    const OPENSSH_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n";

    #[test]
    fn an_openssh_key_without_an_extension_is_accepted() {
        // 最常见的场景：`id_rsa` / `id_ed25519` 没有扩展名。
        let path = temp_file("id_ed25519", OPENSSH_KEY.as_bytes());
        let imported = read_private_key_file(path.to_str().unwrap()).expect("应当读取成功");
        assert_eq!(imported.format, "openssh");
        assert!(imported.content.contains("BEGIN OPENSSH PRIVATE KEY"));
        assert_eq!(
            imported.encrypted, None,
            "OpenSSH 的加密信息在二进制 blob 里，不能猜"
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn an_encrypted_pem_key_is_flagged() {
        let pem = "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIB\n-----END ENCRYPTED PRIVATE KEY-----\n";
        let path = temp_file("key.pem", pem.as_bytes());
        let imported = read_private_key_file(path.to_str().unwrap()).expect("应当读取成功");
        assert_eq!(imported.format, "pem");
        assert_eq!(imported.encrypted, Some(true));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_ppk_file_is_recognised_and_its_encryption_is_read_from_the_header() {
        let ppk = "PuTTY-User-Key-File-3: ssh-rsa\nEncryption: none\n";
        let path = temp_file("key.ppk", ppk.as_bytes());
        let imported = read_private_key_file(path.to_str().unwrap()).expect("应当读取成功");
        assert_eq!(imported.format, "ppk");
        assert_eq!(imported.encrypted, Some(false));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_plain_text_file_is_rejected() {
        // 扩展名像私钥，但内容不是 —— 必须拒（否则等于给了任意读文件的口子）。
        let path = temp_file("fake.pem", b"this is just a note\n");
        let error = read_private_key_file(path.to_str().unwrap()).expect_err("必须拒绝");
        assert!(error.contains("不是私钥"), "{error}");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn an_oversized_file_is_rejected() {
        let huge = vec![b'a'; (MAX_PRIVATE_KEY_BYTES + 1) as usize];
        let path = temp_file("huge.pem", &huge);
        let error = read_private_key_file(path.to_str().unwrap()).expect_err("必须拒绝");
        assert!(error.contains("太大"), "{error}");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_non_utf8_file_is_rejected() {
        let path = temp_file("binary.pem", &[0xFF, 0xFE, 0x00, 0x41]);
        let error = read_private_key_file(path.to_str().unwrap()).expect_err("必须拒绝");
        assert!(error.contains("UTF-8"), "{error}");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_directory_is_rejected() {
        let dir = std::env::temp_dir().join(format!(
            "bls-ops-key-dir-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let error = read_private_key_file(dir.to_str().unwrap()).expect_err("目录必须被拒");
        assert!(error.contains("不是文件"), "{error}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
