//! `termhaus mcp` — a Model Context Protocol server exposing the Termhaus control bus (ADR-0007)
//! as agent *tools*. It's the model-native face of the same relay the `termhaus` CLI drives: each
//! tool builds the identical `ControlRequest` JSON and sends it over `$TERMHAUS_SOCK`, so the agent
//! can "spawn a pane", "broadcast to a group", or "flag myself blocked" as first-class tools
//! instead of shelling out (IDEAS.md's agent-integration arc, step C). No protocol logic lives
//! here — the webview owns routing (src/ipc/protocol.ts); we only translate MCP ⇄ the bus.
//!
//! Transport: newline-delimited JSON-RPC 2.0 over stdio (MCP stdio). stdout carries protocol
//! messages ONLY — anything diagnostic goes to stderr (the same byte-protocol discipline as the
//! PTY output channel). Pure std + serde_json; the socket client is shared with the `termhaus` CLI.

use std::env;
use std::io::{self, BufRead, Write};

use serde_json::{json, Value};

// The bus client, shared with the `termhaus` CLI (two faces, one bus): `control_sock` frames
// requests over the platform transport (`control_transport`, UDS today). Both live in the lib
// crate now, so we reach them through `crate::` rather than the old `#[path]` bin includes.
use crate::control_sock;

/// The MCP-server entry point (`termhaus mcp`), invoked from `main.rs`. Speaks JSON-RPC 2.0 over stdio.
pub fn run() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            // Malformed JSON on the wire → JSON-RPC parse error (id unknown → null).
            Err(e) => {
                write_msg(
                    &mut out,
                    &rpc_error(Value::Null, -32700, &format!("parse error: {e}")),
                );
                continue;
            }
        };

        // A message with no `id` is a notification (initialized/cancelled/…) — never answered.
        let Some(id) = msg.get("id").cloned() else {
            continue;
        };
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let reply = handle_request(method, msg.get("params"), id);
        write_msg(&mut out, &reply);
    }
}

fn handle_request(method: &str, params: Option<&Value>, id: Value) -> Value {
    match method {
        "initialize" => rpc_result(id, initialize_result(params)),
        "ping" => rpc_result(id, json!({})),
        "tools/list" => rpc_result(id, json!({ "tools": tools() })),
        "tools/call" => {
            let Some(name) = params.and_then(|p| p.get("name")).and_then(Value::as_str) else {
                return rpc_error(id, -32602, "tools/call missing \"name\"");
            };
            let empty = json!({});
            let args = params
                .and_then(|p| p.get("arguments"))
                .filter(|a| a.is_object())
                .unwrap_or(&empty);
            let result = match call_tool(name, args) {
                Ok(resp) => control_to_result(&resp),
                Err(msg) => tool_error(&msg),
            };
            rpc_result(id, result)
        }
        other => rpc_error(id, -32601, &format!("method not found: {other}")),
    }
}

fn initialize_result(params: Option<&Value>) -> Value {
    // Echo the client's requested protocol version (we're version-agnostic — a pure proxy), so the
    // negotiated version always matches; fall back to a known-good one if the client omitted it.
    let pv = params
        .and_then(|p| p.get("protocolVersion"))
        .and_then(Value::as_str)
        .unwrap_or("2025-06-18");
    json!({
        "protocolVersion": pv,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": "termhaus", "version": env!("CARGO_PKG_VERSION") },
        "instructions": "Drive a fleet of Termhaus terminal panes: list/spawn/focus panes, send \
            text or broadcast to many at once, read a pane's scrollback, and flag your own pane's \
            attention/status so the UI lights up. Panes are addressed by their display name (e.g. \
            \"Cleo\"). attention/status default to your own pane when no target is given."
    })
}

/// The tool catalogue — one per control-bus op, each with a JSON-Schema for its arguments.
fn tools() -> Value {
    json!([
        {
            "name": "list_panes",
            "description": "List every pane: name, workspace, whether it's focused, and whether its process is live.",
            "inputSchema": { "type": "object", "properties": {}, "required": [] }
        },
        {
            "name": "send_text",
            "description": "Type text into one pane (addressed by name) and press Enter by default.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "target": { "type": "string", "description": "Pane display name, e.g. \"Cleo\"." },
                    "text": { "type": "string", "description": "Text to type into the pane." },
                    "enter": { "type": "boolean", "description": "Press Enter after the text (default true)." }
                },
                "required": ["target", "text"]
            }
        },
        {
            "name": "spawn_pane",
            "description": "Open a new pane running a command (e.g. another agent), optionally named and in a cwd.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Command line to run in the new pane." },
                    "name": { "type": "string", "description": "Optional display name for the pane." },
                    "cwd": { "type": "string", "description": "Optional working directory." }
                },
                "required": ["command"]
            }
        },
        {
            "name": "read_pane",
            "description": "Read the tail of a pane's scrollback (an explicit, requested read — not output scraping).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "target": { "type": "string", "description": "Pane display name." },
                    "lines": { "type": "integer", "description": "How many trailing lines (default 50, max 2000)." }
                },
                "required": ["target"]
            }
        },
        {
            "name": "broadcast",
            "description": "Send the same text to every live pane in a workspace (the active one, or a named one).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "Text to send to every targeted pane." },
                    "enter": { "type": "boolean", "description": "Press Enter after the text (default true)." },
                    "workspace": { "type": "string", "description": "Workspace name (default: the active workspace)." }
                },
                "required": ["text"]
            }
        },
        {
            "name": "focus_pane",
            "description": "Reveal and focus a pane by name, switching to its workspace.",
            "inputSchema": {
                "type": "object",
                "properties": { "target": { "type": "string", "description": "Pane display name." } },
                "required": ["target"]
            }
        },
        {
            "name": "flag_attention",
            "description": "Raise (or, with clear=true, drop) a pane's amber \"needs you\" border. Defaults to your own pane.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "target": { "type": "string", "description": "Pane name (default: your own pane, $TERMHAUS_PANE)." },
                    "clear": { "type": "boolean", "description": "Clear the flag instead of raising it." }
                },
                "required": []
            }
        },
        {
            "name": "set_status",
            "description": "Set a pane's short status label (shown in its title bar and overview tile). Empty text clears it. Defaults to your own pane.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "target": { "type": "string", "description": "Pane name (default: your own pane, $TERMHAUS_PANE)." },
                    "text": { "type": "string", "description": "Status text, e.g. \"running tests\" (omit/empty to clear)." }
                },
                "required": []
            }
        }
    ])
}

/// Build a control request from the named tool's arguments and send it over the bus. `Err` is a
/// tool-level failure (bad/missing args or no socket) → surfaced to the model as `isError`.
fn call_tool(name: &str, args: &Value) -> Result<Value, String> {
    let req = match name {
        "list_panes" => json!({ "op": "list" }),
        "send_text" => json!({
            "op": "send",
            "target": arg_str(args, "target")?,
            "text": arg_str(args, "text")?,
            "enter": arg_bool(args, "enter", true),
        }),
        "spawn_pane" => {
            let mut obj = json!({ "op": "spawn", "command": arg_str(args, "command")? });
            if let Some(n) = arg_opt(args, "name") {
                obj["name"] = json!(n);
            }
            if let Some(d) = arg_opt(args, "cwd") {
                obj["cwd"] = json!(d);
            }
            obj
        }
        "read_pane" => {
            let mut obj = json!({ "op": "read", "target": arg_str(args, "target")? });
            if let Some(n) = args.get("lines").and_then(Value::as_u64) {
                obj["lines"] = json!(n);
            }
            obj
        }
        "broadcast" => {
            let mut obj = json!({
                "op": "broadcast",
                "text": arg_str(args, "text")?,
                "enter": arg_bool(args, "enter", true),
            });
            if let Some(w) = arg_opt(args, "workspace") {
                obj["workspace"] = json!(w);
            }
            obj
        }
        "focus_pane" => json!({ "op": "focus", "target": arg_str(args, "target")? }),
        "flag_attention" => json!({
            "op": "attention",
            "target": arg_target_or_self(args)?,
            "clear": arg_bool(args, "clear", false),
        }),
        "set_status" => json!({
            "op": "status",
            "target": arg_target_or_self(args)?,
            "text": args.get("text").and_then(Value::as_str).unwrap_or(""),
        }),
        other => return Err(format!("unknown tool '{other}'")),
    };
    control_sock::send(&req)
}

/// A required string argument (non-empty).
fn arg_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("missing required argument \"{key}\""))
}

/// An optional, non-empty string argument.
fn arg_opt(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn arg_bool(args: &Value, key: &str, default: bool) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(default)
}

/// A pane target, defaulting to the caller's own pane ($TERMHAUS_PANE) — lets an agent flag itself.
fn arg_target_or_self(args: &Value) -> Result<String, String> {
    if let Some(t) = arg_opt(args, "target") {
        return Ok(t);
    }
    env::var("TERMHAUS_PANE")
        .ok()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "no \"target\" given and TERMHAUS_PANE not set — name a pane".to_string())
}

/// Map a control-bus response (`{ok, data|error}`) to an MCP `tools/call` result.
fn control_to_result(resp: &Value) -> Value {
    if resp.get("ok").and_then(Value::as_bool) == Some(true) {
        let text = match resp.get("data") {
            Some(d) => serde_json::to_string_pretty(d).unwrap_or_else(|_| "ok".to_string()),
            None => "ok".to_string(),
        };
        json!({ "content": [ { "type": "text", "text": text } ], "isError": false })
    } else {
        let err = resp
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        tool_error(err)
    }
}

fn tool_error(msg: &str) -> Value {
    json!({ "content": [ { "type": "text", "text": msg } ], "isError": true })
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Write one JSON-RPC message as a single line to stdout (the MCP stdio framing) and flush.
fn write_msg(out: &mut impl Write, msg: &Value) {
    let line = serde_json::to_string(msg).unwrap_or_else(|_| "{}".to_string());
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}
