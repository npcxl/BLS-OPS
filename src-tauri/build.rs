#[path = "build/command_catalog.rs"]
mod command_catalog;

fn main() {
    command_catalog::generate();
    tauri_build::build()
}
