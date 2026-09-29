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

mod ai;
mod audit;
mod command_center;
mod credentials;
mod deployment;
mod deployment_import;
mod deployment_proposal;
mod history;
mod knowledge;
mod known_hosts;
mod model;
mod projects;
mod schema;
mod servers;
mod sessions;

pub use ai::*;
pub use audit::*;
pub use command_center::*;
pub use credentials::*;
pub use deployment::*;
pub use deployment_import::*;
pub use deployment_proposal::*;
pub use history::*;
pub use knowledge::*;
pub use known_hosts::*;
pub use model::*;
pub use projects::*;
pub use schema::{AppDb, SCHEMA_VERSION};
pub use servers::*;
pub use sessions::*;

// Re-exported for the unit tests, which live next to this module.
#[cfg(test)]
pub(crate) use schema::{
    column_exists, migrate, DEPLOYMENT_CENTER_SCHEMA_SQL, DEPLOYMENT_IMPORT_SCHEMA_SQL,
    P3_SCHEMA_SQL, SCHEMA_SQL,
};

#[cfg(test)]
pub(crate) use tests::test_db;

#[cfg(test)]
mod tests;
