use serde::Deserialize;
use std::{collections::HashSet, env, fmt::Write, fs, path::PathBuf};

const CATALOG_PATH: &str = "src/command_center/catalog.json";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    id: String,
    executable: String,
    subcommand: String,
    title: String,
    description: String,
    category: String,
    #[serde(default)]
    scenarios: Vec<String>,
    #[serde(default)]
    aliases: Vec<String>,
    syntax: String,
    risk: Option<String>,
    output_adapter: Option<String>,
    #[serde(default)]
    requires: Vec<String>,
    exec: Option<String>,
}

// Variant names are identifiers, never Rust expressions. Rust also checks that
// each generated reference names an existing enum variant.
fn variant<'a>(id: &str, name: &'a str) -> &'a str {
    assert!(
        name.starts_with(|c: char| c.is_ascii_uppercase())
            && name.chars().all(|c| c.is_ascii_alphanumeric()),
        "{id}: invalid catalog variant {name:?}"
    );
    name
}

pub fn generate() {
    println!("cargo:rerun-if-changed={CATALOG_PATH}");
    let source = fs::read_to_string(CATALOG_PATH).expect("read command catalog JSON");
    let entries: Vec<Entry> = serde_json::from_str(&source).expect("parse command catalog JSON");
    let mut ids = HashSet::new();
    let mut generated = String::from("pub(super) static CATALOG: &[CommandKnowledge] = &[\n");

    for entry in &entries {
        let id = &entry.id;
        assert!(ids.insert(id), "duplicate command ID {id}");
        let category = variant(id, &entry.category);
        let exec = variant(id, entry.exec.as_deref().unwrap_or("None"));
        let risk = entry.risk.as_deref().unwrap_or("ReadOnly");
        let mutability = match risk {
            "ReadOnly" => "Read",
            "Medium" => "Change",
            _ => panic!("{id}: unsupported command risk {risk:?}"),
        };
        let requires = entry
            .requires
            .iter()
            .map(|name| format!("PT::{}", variant(id, name)))
            .collect::<Vec<_>>()
            .join(", ");
        let adapter = entry.output_adapter.as_deref().unwrap_or("auto");

        writeln!(
            generated,
            "    CommandKnowledge {{
        id: {id:?},
        executable: {executable:?},
        subcommand: {subcommand:?},
        title: {title:?},
        description: {description:?},
        category: CC::{category},
        scenarios: &{scenarios:?},
        aliases: &{aliases:?},
        syntax: {syntax:?},
        risk: R::{risk},
        mutability: M::{mutability},
        output_adapter: {adapter:?},
        requires: &[{requires}],
        exec: EK::{exec},
    }},",
            executable = entry.executable,
            subcommand = entry.subcommand,
            title = entry.title,
            description = entry.description,
            scenarios = entry.scenarios,
            aliases = entry.aliases,
            syntax = entry.syntax,
        )
        .expect("write command catalog source");
    }

    generated.push_str("];\n");
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo OUT_DIR"));
    fs::write(out_dir.join("command_catalog.rs"), generated)
        .expect("save generated command catalog");
}
