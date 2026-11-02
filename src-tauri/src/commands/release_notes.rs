//! Read-only release metadata. No installer download or update state changes.
use crate::ops_error::{OpsError, OpsResult};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const MANIFEST_URL: &str = "https://github.com/npcxl/BLS-OPS/releases/latest/download/latest.json";
const MAX_METADATA_BYTES: usize = 256 * 1024;

#[derive(Deserialize, Serialize)]
pub struct LatestReleaseNotes {
    pub version: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default, alias = "pub_date")]
    pub date: Option<String>,
}

fn release_error(message: impl ToString) -> OpsError {
    OpsError::from_stage("network", message)
}

#[tauri::command]
pub async fn latest_release_notes() -> OpsResult<LatestReleaseNotes> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .user_agent("BLS-OPS-release-notes")
        .build()
        .map_err(release_error)?;
    let mut response = client
        .get(MANIFEST_URL)
        .send()
        .await
        .map_err(release_error)?
        .error_for_status()
        .map_err(release_error)?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(release_error)? {
        if bytes.len() + chunk.len() > MAX_METADATA_BYTES {
            return Err(release_error("Release metadata is too large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let mut release: LatestReleaseNotes = serde_json::from_slice(&bytes).map_err(release_error)?;
    release.version = release.version.trim().to_owned();
    if release.version.is_empty() || release.version.len() > 128 {
        return Err(release_error("Release metadata has no valid version"));
    }
    Ok(release)
}
