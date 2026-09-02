//! The security boundary for every management action in P3.
//!
//! # Why this module exists
//!
//! A desktop ops tool is one XSS-shaped bug away from handing an attacker a
//! remote shell. So the WebView never sends a command string. It sends a
//! *capability* — "restart the unit called nginx.service" — and this module is
//! the only place in the codebase that turns one into shell text.
//!
//! Three rules, all enforced here:
//!
//! 1. **Fixed templates.** Every command string lives in the exhaustive
//!    [`Capability::command`] match. Adding an action means touching this
//!    directory, which is the point: the audit surface is one `match`.
//! 2. **Validated parameters.** Anything the user can influence (unit names,
//!    container ids, site names, paths, git refs) is checked against a
//!    character whitelist before it reaches a template.
//! 3. **Always quoted.** Validated or not, every interpolated value is
//!    single-quoted, and positional arguments are preceded by `--` so a value
//!    can never be read as an option.
//!
//! Rule 3 is defence in depth: if a validator is ever loosened by mistake, the
//! quoting still stops the value from breaking out of the argument.
//!
//! Laid out as:
//! * [`capability`] — the closed enum plus the one `match` that builds commands
//! * [`validate`]   — the validators and the shell quoter
//! * [`deploy`]     — deployment-step validation

mod capability;
mod deploy;
mod validate;

pub use capability::{Capability, ContainerAction, ProbeTool, ServiceAction};
pub use deploy::validate_deploy_step;
pub use validate::{
    is_within, shell_quote, validate_abs_path, validate_container, validate_git_ref,
    validate_image, validate_lines, validate_remote_paths, validate_repo_url, validate_site_name,
    validate_unit,
};

#[cfg(test)]
mod tests;
