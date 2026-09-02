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
