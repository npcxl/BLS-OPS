use anyhow::{anyhow, Result};
use keyring::Entry;

const SERVICE: &str = "ops-workbench";

pub fn save_secret(secret_id: &str, secret: &str) -> Result<String> {
    let entry = Entry::new(SERVICE, secret_id)
        .map_err(|error| anyhow!(error.to_string()))?;
    entry.set_password(secret).map_err(|error| anyhow!(error.to_string()))?;
    Ok(secret_id.to_string())
}

pub fn read_secret(secret_id: &str) -> Result<String> {
    let entry = Entry::new(SERVICE, secret_id)
        .map_err(|error| anyhow!(error.to_string()))?;
    entry.get_password().map_err(|error| anyhow!(error.to_string()))
}

pub fn delete_secret(secret_id: &str) -> Result<()> {
    let entry = Entry::new(SERVICE, secret_id)
        .map_err(|error| anyhow!(error.to_string()))?;
    entry.delete_credential().map_err(|error| anyhow!(error.to_string()))?;
    Ok(())
}
