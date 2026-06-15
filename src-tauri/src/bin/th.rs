//! `th` — the Termhaus inter-pane control CLI (ADR-0007). Runs *inside* a pane and talks to
//! the running app over the unix socket at `$TERMHAUS_SOCK`, so an agent (or you) can list
//! panes, send text/commands to a named pane, or spawn a new one.
//!
//!   th list                          # show every pane: name, live/dead, workspace
//!   th send Cleo claude "do the thing"   # type into pane "Cleo" and press Enter
//!   th send Cleo --no-enter ls       # type without the trailing newline
//!   th send Cleo                     # no text → reads stdin (pipe-friendly)
//!   th spawn --name Cleo --cwd /repo claude   # open a new pane running `claude`
//!   th read Cleo -n 100              # capture Cleo's last 100 scrollback lines
//!   th broadcast "run the tests"     # send to every live pane in the active workspace
//!   th focus Cleo                    # switch to Cleo's workspace and focus it
//!   th attention                     # light this pane's "needs you" border (clears on focus)
//!   th attention Cleo --clear        # drop pane Cleo's attention border
//!   th status "running tests"        # set this pane's status label (shown in its title/overview)
//!   th status Cleo --clear           # clear pane Cleo's status label
//!   th hooks --install               # wire a Claude Code agent's events to attention/status
//!   th hooks                         # print the recommended hooks profile (no changes made)
//!
//! Pure std + serde_json (already a workspace dep): no protocol logic lives here or in Rust —
//! the request is forwarded verbatim to the webview, which owns routing (src/ipc/protocol.ts).

use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::exit;

use serde_json::{json, Value};

// The bus client, shared with the `th-mcp` MCP server (two front-ends, one bus). `control_sock`
// frames requests; `control_transport` is the platform transport it connects over (UDS today).
#[path = "../control_sock.rs"]
mod control_sock;
#[path = "../control_transport.rs"]
mod control_transport;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() || args[0] == "-h" || args[0] == "--help" {
        usage();
        exit(if args.is_empty() { 2 } else { 0 });
    }
    // `hooks` is a local helper (print/install a Claude Code hooks profile) — no socket round-trip.
    if args[0] == "hooks" {
        match run_hooks(&args[1..]) {
            Ok(msg) => print!("{msg}"),
            Err(e) => {
                eprintln!("th: {e}");
                exit(1);
            }
        }
        return;
    }
    let req = match build_request(&args) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("th: {e}");
            exit(2);
        }
    };
    let resp = match control_sock::send(&req) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("th: {e}");
            exit(1);
        }
    };
    handle_response(&args[0], &resp);
}

fn build_request(args: &[String]) -> Result<Value, String> {
    match args[0].as_str() {
        "list" => Ok(json!({ "op": "list" })),

        "send" => {
            // th send <pane> [text...] [--no-enter]; no text → read stdin.
            let mut enter = true;
            let mut positional: Vec<String> = Vec::new();
            for a in &args[1..] {
                if a == "--no-enter" {
                    enter = false;
                } else {
                    positional.push(a.clone());
                }
            }
            if positional.is_empty() {
                return Err("usage: th send <pane> <text...>  (or pipe text via stdin)".into());
            }
            let target = positional.remove(0);
            let text = if positional.is_empty() {
                read_stdin()?
            } else {
                positional.join(" ")
            };
            Ok(json!({ "op": "send", "target": target, "text": text, "enter": enter }))
        }

        "spawn" => {
            // th spawn [--name N] [--cwd D] <command...>   (use `--` to end flag parsing)
            let mut name: Option<String> = None;
            let mut cwd: Option<String> = None;
            let mut command: Vec<String> = Vec::new();
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--name" => {
                        i += 1;
                        name = Some(args.get(i).cloned().ok_or("--name needs a value")?);
                    }
                    "--cwd" => {
                        i += 1;
                        cwd = Some(args.get(i).cloned().ok_or("--cwd needs a value")?);
                    }
                    "--" => {
                        command.extend_from_slice(&args[i + 1..]);
                        break;
                    }
                    // The first non-flag token starts the command; the rest is taken verbatim
                    // (including any dashes), so `th spawn worker claude --resume` works.
                    s if command.is_empty() && s.starts_with("--") => {
                        return Err(format!("unknown flag '{s}' (put the command after `--`)"));
                    }
                    _ => {
                        command.extend_from_slice(&args[i..]);
                        break;
                    }
                }
                i += 1;
            }
            let command = command.join(" ");
            if command.trim().is_empty() {
                return Err("usage: th spawn [--name N] [--cwd D] <command...>".into());
            }
            let mut obj = json!({ "op": "spawn", "command": command });
            if let Some(n) = name {
                obj["name"] = json!(n);
            }
            if let Some(d) = cwd {
                obj["cwd"] = json!(d);
            }
            Ok(obj)
        }

        "read" => {
            // th read <pane> [-n LINES]   — capture the tail of a pane's scrollback.
            let mut lines: Option<u64> = None;
            let mut positional: Vec<String> = Vec::new();
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "-n" | "--lines" => {
                        i += 1;
                        let v = args.get(i).ok_or("-n needs a value")?;
                        lines = Some(v.parse().map_err(|_| format!("bad line count '{v}'"))?);
                    }
                    _ => positional.push(args[i].clone()),
                }
                i += 1;
            }
            if positional.is_empty() {
                return Err("usage: th read <pane> [-n LINES]".into());
            }
            let mut obj = json!({ "op": "read", "target": positional.remove(0) });
            if let Some(n) = lines {
                obj["lines"] = json!(n);
            }
            Ok(obj)
        }

        "broadcast" => {
            // th broadcast [--workspace W] [--no-enter] <text...>   (no text → read stdin)
            let mut enter = true;
            let mut workspace: Option<String> = None;
            let mut positional: Vec<String> = Vec::new();
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--no-enter" => enter = false,
                    "--workspace" | "-w" => {
                        i += 1;
                        workspace = Some(args.get(i).cloned().ok_or("--workspace needs a value")?);
                    }
                    _ => positional.push(args[i].clone()),
                }
                i += 1;
            }
            let text = if positional.is_empty() {
                read_stdin()?
            } else {
                positional.join(" ")
            };
            let mut obj = json!({ "op": "broadcast", "text": text, "enter": enter });
            if let Some(w) = workspace {
                obj["workspace"] = json!(w);
            }
            Ok(obj)
        }

        "focus" => {
            let target = args.get(1).ok_or("usage: th focus <pane>")?;
            Ok(json!({ "op": "focus", "target": target }))
        }

        "attention" => {
            // th attention [pane] [--clear]   — raise (or drop) a pane's attention border.
            // No pane → the calling pane (from $TERMHAUS_PANE), so an agent can flag itself.
            let mut clear = false;
            let mut positional: Vec<String> = Vec::new();
            for a in &args[1..] {
                if a == "--clear" {
                    clear = true;
                } else {
                    positional.push(a.clone());
                }
            }
            let target = if positional.is_empty() {
                env::var("TERMHAUS_PANE").map_err(|_| {
                    "no pane given and TERMHAUS_PANE not set — name a pane: th attention <pane>"
                        .to_string()
                })?
            } else {
                positional.remove(0)
            };
            Ok(json!({ "op": "attention", "target": target, "clear": clear }))
        }

        "status" => {
            // th status [pane] [text...|--clear]   — set a pane's short status label.
            // No pane → the calling pane (from $TERMHAUS_PANE), so an agent can label itself.
            // Empty text (or --clear) clears the label. A leading "--" ends flag parsing so a
            // status that starts with a dash still works: th status -- --resuming.
            let mut clear = false;
            let mut positional: Vec<String> = Vec::new();
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--clear" => clear = true,
                    "--" => {
                        positional.extend_from_slice(&args[i + 1..]);
                        break;
                    }
                    _ => positional.push(args[i].clone()),
                }
                i += 1;
            }
            // We can't resolve pane names here (Rust is a pure relay), so we use a convention to
            // tell "set my own status" from "set pane X's status", mirroring `th attention`:
            //   • --clear      → the (optional) lone positional is a pane name, else self.
            //   • one token + a calling pane → that token is the status text for *this* pane.
            //   • two+ tokens  → first is the target pane, the rest is the status text.
            let self_pane = env::var("TERMHAUS_PANE").ok();
            let no_pane = || {
                "no pane given and TERMHAUS_PANE not set — name a pane: th status <pane> <text>"
                    .to_string()
            };
            let (target, text) = if clear {
                let t = if positional.is_empty() {
                    self_pane.ok_or_else(no_pane)?
                } else {
                    positional.remove(0)
                };
                (t, String::new())
            } else if positional.is_empty() {
                (self_pane.ok_or_else(no_pane)?, String::new())
            } else if let (1, Some(me)) = (positional.len(), self_pane) {
                // One token + a calling pane → that token is *this* pane's status text.
                (me, positional.remove(0))
            } else {
                let t = positional.remove(0);
                (t, positional.join(" "))
            };
            Ok(json!({ "op": "status", "target": target, "text": text }))
        }

        other => Err(format!(
            "unknown command '{other}' (try: list, send, spawn, read, broadcast, focus, attention, status)"
        )),
    }
}

fn read_stdin() -> Result<String, String> {
    let mut buf = String::new();
    std::io::stdin()
        .read_to_string(&mut buf)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

fn handle_response(op: &str, resp: &Value) {
    if resp.get("ok").and_then(Value::as_bool) != Some(true) {
        let err = resp
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        eprintln!("th: {err}");
        exit(1);
    }
    let data = resp.get("data");
    match op {
        "list" => print_list(data),
        "send" => {
            let n = data
                .and_then(|d| d.get("count"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            println!("sent to {n} pane{}", if n == 1 { "" } else { "s" });
        }
        "spawn" => {
            let name = data
                .and_then(|d| d.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("?");
            println!("spawned pane '{name}'");
        }
        "read" => {
            let text = data
                .and_then(|d| d.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("");
            println!("{text}");
        }
        "broadcast" => {
            let n = data
                .and_then(|d| d.get("count"))
                .and_then(Value::as_u64)
                .unwrap_or(0);
            println!("sent to {n} pane{}", if n == 1 { "" } else { "s" });
        }
        "focus" => {
            let name = data
                .and_then(|d| d.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("?");
            println!("focused pane '{name}'");
        }
        "attention" => {
            let name = data
                .and_then(|d| d.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("?");
            let cleared = data
                .and_then(|d| d.get("cleared"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            println!(
                "attention {} '{name}'",
                if cleared { "cleared on" } else { "raised on" }
            );
        }
        "status" => {
            let name = data
                .and_then(|d| d.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("?");
            let cleared = data
                .and_then(|d| d.get("cleared"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if cleared {
                println!("status cleared on '{name}'");
            } else {
                let text = data
                    .and_then(|d| d.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                println!("status of '{name}' → {text}");
            }
        }
        _ => {}
    }
}

fn print_list(data: Option<&Value>) {
    let Some(arr) = data.and_then(Value::as_array) else {
        return;
    };
    if arr.is_empty() {
        println!("(no panes)");
        return;
    }
    for p in arr {
        let name = p.get("name").and_then(Value::as_str).unwrap_or("?");
        let ws = p.get("workspace").and_then(Value::as_str).unwrap_or("");
        let live = p.get("live").and_then(Value::as_bool).unwrap_or(false);
        let focused = p.get("focused").and_then(Value::as_bool).unwrap_or(false);
        let marker = if focused { "*" } else { " " };
        let status = if live { "live" } else { "dead" };
        println!("{marker} {name:<12} {status:<5} {ws}");
    }
}

// ---- `th hooks` — bridge a Claude Code agent's lifecycle to the control bus (ADR-0007) ----
//
// The agent *pushes* its own state through the channel we already built, no output parsing
// (ADR-0001): a "needs you" notification raises the amber border; a prompt-submit/turn-end pair
// drives the status label. This is the hook adapter from docs/IDEAS.md's agent-integration arc.

/// The recommended hook entries, as (event, entry) pairs. Each entry is one Claude Code hook
/// matcher-group with a single command. Kept conflict-free: `Notification` owns `attention`
/// (cleared by focusing the pane), the prompt/stop pair owns `status` — they never touch the
/// same flag, so firing order can't race.
fn hook_profile() -> Vec<(&'static str, Value)> {
    vec![
        // You submit a prompt → the pane shows "working" until the turn ends.
        (
            "UserPromptSubmit",
            json!({ "hooks": [ { "type": "command", "command": "th status working" } ] }),
        ),
        // Claude needs input / permission / went idle → raise the "needs you" border.
        (
            "Notification",
            json!({ "matcher": "", "hooks": [ { "type": "command", "command": "th attention" } ] }),
        ),
        // Turn finished → clear the status label (attention is cleared by looking at the pane).
        (
            "Stop",
            json!({ "hooks": [ { "type": "command", "command": "th status" } ] }),
        ),
    ]
}

/// The profile as a full `{ "hooks": { … } }` settings fragment (what `th hooks` prints).
fn profile_value() -> Value {
    let mut hooks = serde_json::Map::new();
    for (event, entry) in hook_profile() {
        hooks
            .entry(event.to_string())
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .expect("hook event value is an array")
            .push(entry);
    }
    json!({ "hooks": Value::Object(hooks) })
}

/// The single `command` string inside a hook entry (our entries each carry exactly one).
fn entry_command(entry: &Value) -> Option<&str> {
    entry.get("hooks")?.get(0)?.get("command")?.as_str()
}

/// Does an existing hook group already carry `cmd` (so install stays idempotent)?
fn group_has_command(group: &Value, cmd: &str) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hs| {
            hs.iter()
                .any(|h| h.get("command").and_then(Value::as_str) == Some(cmd))
        })
}

/// The user's home dir for locating `~/.claude/settings.json`: `$HOME` on Unix, `%USERPROFILE%`
/// on Windows (mirrors `pty::home_dir`). Claude Code uses `~/.claude` on every platform.
#[cfg(unix)]
fn home_dir() -> Option<String> {
    env::var("HOME").ok()
}

#[cfg(windows)]
fn home_dir() -> Option<String> {
    env::var("USERPROFILE").ok()
}

fn run_hooks(args: &[String]) -> Result<String, String> {
    let mut install = false;
    let mut scope_user = false;
    for a in args {
        match a.as_str() {
            "--print" => install = false,
            "--install" => install = true,
            "--user" | "-u" => scope_user = true,
            "--project" | "-p" => scope_user = false,
            other => {
                return Err(format!(
                "unknown flag '{other}' (usage: th hooks [--print] | --install [--user|--project])"
            ))
            }
        }
    }

    if !install {
        let mut out = serde_json::to_string_pretty(&profile_value()).map_err(|e| e.to_string())?;
        out.push('\n');
        return Ok(out);
    }

    let path = if scope_user {
        let home = home_dir().ok_or_else(|| "home directory not set".to_string())?;
        PathBuf::from(home).join(".claude/settings.json")
    } else {
        let base = env::var("CLAUDE_PROJECT_DIR")
            .map(PathBuf::from)
            .or_else(|_| env::current_dir())
            .map_err(|e| format!("cannot resolve project dir: {e}"))?;
        base.join(".claude/settings.json")
    };
    install_hooks(&path)
}

/// Merge the profile into a Claude Code settings file, creating it if absent. Idempotent: a hook
/// whose command is already present under its event is left alone, so re-running is safe.
fn install_hooks(path: &Path) -> Result<String, String> {
    let mut root: Value = if path.exists() {
        let s =
            fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        if s.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&s)
                .map_err(|e| format!("{} is not valid JSON: {e}", path.display()))?
        }
    } else {
        json!({})
    };

    let obj = root
        .as_object_mut()
        .ok_or_else(|| format!("{} is not a JSON object", path.display()))?;
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks
        .as_object_mut()
        .ok_or("\"hooks\" in settings is not an object")?;

    let mut added = 0;
    let mut skipped = 0;
    for (event, entry) in hook_profile() {
        let cmd = entry_command(&entry).unwrap_or("").to_string();
        let arr = hooks.entry(event.to_string()).or_insert_with(|| json!([]));
        let arr = arr
            .as_array_mut()
            .ok_or_else(|| format!("hooks.{event} in settings is not an array"))?;
        if arr.iter().any(|g| group_has_command(g, &cmd)) {
            skipped += 1;
        } else {
            arr.push(entry);
            added += 1;
        }
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    let mut pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    pretty.push('\n');
    fs::write(path, pretty).map_err(|e| format!("cannot write {}: {e}", path.display()))?;

    Ok(format!(
        "hooks installed in {} ({added} added, {skipped} already present)\nrestart `claude` (or run /hooks) for it to pick them up\n",
        path.display()
    ))
}

fn usage() {
    eprintln!(
        "th — Termhaus inter-pane control\n\
         usage:\n\
        \x20 th list\n\
        \x20 th send <pane> <text...> [--no-enter]\n\
        \x20 th spawn [--name N] [--cwd D] <command...>\n\
        \x20 th read <pane> [-n LINES]\n\
        \x20 th broadcast [--workspace W] [--no-enter] <text...>\n\
        \x20 th focus <pane>\n\
        \x20 th attention [pane] [--clear]\n\
        \x20 th status [pane] <text...> | [pane] --clear\n\
        \x20 th hooks [--print] | --install [--user|--project]"
    );
}
