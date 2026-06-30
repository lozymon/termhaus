// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// One binary, three faces. The first positional arg decides which: a control-CLI subcommand
// (`termhaus list`/`send`/`spawn`/… , ADR-0007) drives the inter-pane bus; `termhaus mcp` runs
// the MCP server; anything else — a bare `termhaus`, `termhaus .`, or `termhaus <dir>` — opens
// the GUI. The CLI/MCP arms return before any Tauri/WebKitGTK setup, so invoking `termhaus`
// inside a pane stays cheap.
fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("mcp") => termhaus_lib::mcp::run(),
        Some(cmd) if termhaus_lib::cli::is_command(cmd) => termhaus_lib::cli::run(),
        _ => termhaus_lib::run(),
    }
}
