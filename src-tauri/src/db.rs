//! SQLite persistence, one module per table.
//!
//! Split by entity during the modularisation pass; the re-exports below keep
//! every existing `crate::db::xxx` path working, so `commands/*`, `ssh` and the
//! e2e tests are untouched.
//!
//! Two rules hold across every submodule:
//!
//! * **Secrets never land in SQLite.** Credentials store keyring *references*
//!   (`secret_ref` / `passphrase_ref`); the material itself lives in the OS
//!   keyring and is read only in Rust.
//! * **Deletes cascade explicitly.** Foreign keys are enabled, but every
//!   destructive path also clears dependent rows by hand so the UI can report
//!   what was removed instead of leaving orphans.

mod audit;
mod credentials;
mod history;
mod known_hosts;
mod model;
mod projects;
mod schema;
mod servers;
mod sessions;

pub use audit::*;
pub use credentials::*;
pub use history::*;
pub use known_hosts::*;
pub use model::*;
pub use projects::*;
pub use schema::{migrate, AppDb, P3_SCHEMA_SQL, SCHEMA_VERSION};
pub use servers::*;
pub use sessions::*;

// Re-exported for the unit tests, which live next to this module.
#[cfg(test)]
pub(crate) use schema::{column_exists, SCHEMA_SQL};

#[cfg(test)]
mod tests;
