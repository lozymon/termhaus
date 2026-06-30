//! Shared client for the Termhaus control bus (ADR-0007): connect to `$TERMHAUS_SOCK`, write one
//! JSON request line, read one JSON response line. The actual transport (unix-domain socket today;
//! a Windows named pipe at M7.5) lives behind `control_transport`, so this stays platform-neutral.
//! Both faces of the bus — the `termhaus` CLI and the `termhaus mcp` MCP server (now subcommands
//! of the one binary, see main.rs) — use it, so they're two faces of the same relay (IDEAS.md's
//! agent-integration arc). Std + serde_json only (no Tauri lib).

use std::env;

use serde_json::Value;

use crate::control_transport;

/// Send one control request over the bus and return the parsed JSON response (`{ok, …}`).
pub fn send(req: &Value) -> Result<Value, String> {
    let addr = env::var("TERMHAUS_SOCK")
        .map_err(|_| "TERMHAUS_SOCK not set — run this inside a Termhaus pane".to_string())?;
    let stream = control_transport::connect(&addr)
        .map_err(|e| format!("cannot reach Termhaus at {addr}: {e}"))?;
    let line = serde_json::to_string(req).map_err(|e| e.to_string())?;
    control_transport::write_line(&stream, &line).map_err(|e| e.to_string())?;
    match control_transport::read_line(&stream).map_err(|e| e.to_string())? {
        Some(resp) => serde_json::from_str(&resp).map_err(|e| format!("bad response: {e}")),
        None => Err("no response from Termhaus".into()),
    }
}
