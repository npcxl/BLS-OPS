//! The built-in catalog is maintained in `catalog.json`.
//! Cargo generates this typed static table so search and execution use the same data.

use super::model::{
    CommandCategory as CC, CommandKnowledge, ExecKind as EK, Mutability as M, RiskLevel as R,
};
use crate::safe::ProbeTool as PT;

include!(concat!(env!("OUT_DIR"), "/command_catalog.rs"));
