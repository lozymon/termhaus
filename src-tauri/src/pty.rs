//! M0 PTY engine — one PtyManager owning N PTYs keyed by PaneId.
//!
//! Each pane is an OS pseudo-terminal (portable-pty) running a login shell. Output is
//! streamed to the webview over a Tauri Channel; a dedicated reader thread feeds a flusher
//! thread that COALESCES on time (~16ms) and size (32KB) before sending — capping the
//! per-pane message rate so a flood (`yes`) can't drown the IPC bridge. See ADR-0003.
//!
//! Transport note (M0 baseline): bytes are base64-encoded into a `Channel<String>`. This is
//! the simplest guaranteed-correct path and the explicit thing the M0 flood test measures.
//! If base64 is the bottleneck, the next step is raw-byte channels / a WebSocket (ADR-0003).

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;

/// Emit at most one frame to the webview per this interval (frame-rate cap), and
/// flush a partial buffer this long after the last byte when the pane goes idle.
const FLUSH_INTERVAL: Duration = Duration::from_millis(16);
/// Hard cap on bytes coalesced into a single frame. Bounds per-message size and,
/// combined with the bounded reader→flusher channel, bounds total memory.
const FRAME_MAX: usize = 64 * 1024;
/// Bounded reader→flusher channel depth. When the flusher can't keep up the reader
/// blocks here, stops draining the PTY, the kernel PTY buffer fills, and the child
/// (`yes`, a big `cat`) is back-pressured by the OS — no unbounded queue, bounded RAM.
const CHANNEL_DEPTH: usize = 16;

pub struct PtyManager {
    // Arc so the per-pane reaper thread can remove its own entry on child exit.
    panes: Arc<Mutex<HashMap<u32, Pane>>>,
    next_id: Mutex<u32>,
}

struct Pane {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    // Lets `kill` terminate the child from the command thread even though the `Child`
    // itself lives in (and is reaped by) the reader/flusher thread.
    killer: Box<dyn ChildKiller + Send + Sync>,
    // The shell child's OS pid, so the Source Control panel can read its live cwd from
    // `/proc/<pid>/cwd` (see `cwd` below). `None` if the platform didn't report one.
    // Only read on Unix (the `/proc` cwd lookup is Linux-only); still populated everywhere.
    #[cfg_attr(windows, allow(dead_code))]
    pid: Option<u32>,
    // The webview Channels the flusher/reaper write to, behind a mutex so `retarget` can swap
    // them to a *different* window without disturbing the running PTY — the basis of tearing a
    // pane off into its own window (the PTY stays put in this process, only its output sink moves).
    sink: Arc<Mutex<Channel<String>>>,
    exit_sink: Arc<Mutex<Channel<i32>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            panes: Arc::new(Mutex::new(HashMap::new())),
            next_id: Mutex::new(1),
        }
    }
}

// ---- Platform launch model -------------------------------------------------------------------
// The shell, its launch args, and the locale/home env differ by OS. Unix is the original
// login-interactive model (ADR-0004); the Windows arms follow PLAN M7.1 (no login-shell concept)
// and are compiled only on a Windows build — unverifiable on the Linux dev box, verify at M7.4.

/// Pick the shell to launch. An explicit `pref` (the Settings "default shell") wins when it
/// names an existing binary; otherwise prefer `$SHELL` (set in any normal session); when that
/// is unset or names a missing binary — possible for a bare desktop-launcher start (M6) —
/// fall back to `/bin/bash`, then `/bin/sh`, which exist on every Linux target we support.
#[cfg(unix)]
fn resolve_shell(pref: Option<&str>) -> String {
    if let Some(p) = pref.map(str::trim).filter(|p| !p.is_empty()) {
        if std::path::Path::new(p).exists() {
            return p.to_string();
        }
    }
    if let Ok(sh) = std::env::var("SHELL") {
        if !sh.is_empty() && std::path::Path::new(&sh).exists() {
            return sh;
        }
    }
    for candidate in ["/bin/bash", "/bin/sh"] {
        if std::path::Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }
    "/bin/sh".to_string()
}

/// Windows has no `$SHELL`/login-shell concept (PLAN M7.1): an explicit `pref` wins, else
/// PowerShell (`powershell.exe`, on every Win10/11; `%COMSPEC%`/`cmd.exe` is the fallback). PATH
/// resolution is handled by the spawner.
#[cfg(windows)]
fn resolve_shell(pref: Option<&str>) -> String {
    if let Some(p) = pref.map(str::trim).filter(|p| !p.is_empty()) {
        return p.to_string();
    }
    "powershell.exe".to_string()
}

/// Build the launch command: the shell plus the args that run `command`, or an interactive shell
/// when `command` is `None`. Unix launches a login-interactive shell so PATH / rc files / version
/// managers load (ADR-0004): `$SHELL -l`, or `$SHELL -lc "<cmd>"` for a command pane.
#[cfg(unix)]
fn launch_command(shell: &str, command: Option<&str>) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(shell);
    cmd.arg("-l");
    if let Some(c) = command {
        cmd.arg("-c");
        cmd.arg(c);
    }
    cmd
}

/// Windows has no login-shell concept (PLAN M7.1): PATH comes from the env/registry, not a sourced
/// profile. PowerShell runs the command via `-Command`; `cmd.exe` via `/c`.
#[cfg(windows)]
fn launch_command(shell: &str, command: Option<&str>) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(shell);
    let is_cmd = std::path::Path::new(shell)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("cmd"))
        .unwrap_or(false);
    match command {
        Some(c) if is_cmd => {
            cmd.arg("/c");
            cmd.arg(c);
        }
        Some(c) => {
            cmd.arg("-NoLogo");
            cmd.arg("-NoProfile");
            cmd.arg("-Command");
            cmd.arg(c);
        }
        None if !is_cmd => {
            cmd.arg("-NoLogo");
        }
        None => {}
    }
    cmd
}

/// Locale env the child inherits. `TERM`/`COLORTERM` are a Unix idiom; on Windows ConPTY advertises
/// its own capabilities, so they're skipped (PLAN M7.1).
#[cfg(unix)]
fn apply_locale_env(cmd: &mut CommandBuilder) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
}

#[cfg(windows)]
fn apply_locale_env(_cmd: &mut CommandBuilder) {}

/// The user's home dir, used as the cwd fallback when the requested folder is gone: `$HOME` on
/// Unix, `%USERPROFILE%` on Windows (PLAN M7.1).
#[cfg(unix)]
fn home_dir() -> Option<String> {
    std::env::var("HOME").ok()
}

#[cfg(windows)]
fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE").ok()
}

/// Best-effort check that a command's program would actually resolve when launched. A pane
/// runs `$SHELL -lc "<command>"` (ADR-0004), so a missing program just prints "command not
/// found" and exits 127 — an ordinary Dead pane. This lets the new-workspace wizard warn
/// *before* launch (e.g. picking GitHub Copilot CLI on a machine without it).
///
/// We resolve the program (the command's first token) through the *same* login shell that
/// `spawn` would use, so PATH / rc files / version managers are seen identically. The program
/// is passed as the shell's `$1` (never interpolated into the script) so it can't inject. An
/// empty command is a plain shell — always available. Any error (shell missing, spawn failure)
/// resolves to `true`: this is an advisory hint, never a gate, so it must not block a launch.
pub fn check_command(command: &str, shell: Option<&str>) -> bool {
    let prog = command.split_whitespace().next().unwrap_or("");
    if prog.is_empty() {
        return true; // plain shell
    }
    let shell = resolve_shell(shell);
    command_resolves(&shell, prog)
}

/// Whether `prog` resolves through the login shell `spawn` would use — the program is passed as the
/// shell's `$1` (never interpolated) so it can't inject. Any error → `true` (advisory, never gate).
#[cfg(unix)]
fn command_resolves(shell: &str, prog: &str) -> bool {
    let status = std::process::Command::new(shell)
        .arg("-lc")
        .arg("command -v -- \"$1\" >/dev/null 2>&1")
        .arg(shell) // $0
        .arg(prog) // $1
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    match status {
        Ok(s) => s.success(),
        Err(_) => true, // can't tell → don't block the launch
    }
}

/// Windows: a faithful PowerShell `Get-Command` probe needs real Windows testing (M7.1/M7.4), and
/// this check is advisory-only — so skip it for now. A missing binary still surfaces in-pane as a
/// "not recognized" error, exactly the unix "can't tell → don't block" fallback.
#[cfg(windows)]
fn command_resolves(_shell: &str, _prog: &str) -> bool {
    true
}

/// Spawn a login-interactive shell in a fresh PTY and start streaming its output.
/// Returns the new PaneId. See ADR-0004 for why we launch via the login shell.
#[allow(clippy::too_many_arguments)] // mirrors the IPC spawn payload (cols/rows/cmd/cwd/shell/channels)
pub fn spawn(
    mgr: &PtyManager,
    cols: u16,
    rows: u16,
    command: Option<String>,
    cwd: Option<String>,
    shell: Option<String>,
    name: Option<String>,
    log_path: Option<String>,
    on_output: Channel<String>,
    on_exit: Channel<i32>,
) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // Always launch via the login shell so PATH / rc files / version managers load — a
    // plain pane gets an interactive `$SHELL -l`, a command pane gets `$SHELL -lc "<cmd>"`
    // (not a direct execvp), so a missing binary just prints into the pane and exits to a
    // Dead pane rather than failing the spawn. See ADR-0004. The `-l` is also what fixes
    // PATH when Termhaus is started from a desktop launcher (M6): a bundled launch inherits
    // only the session env, so the login shell must re-source the profile.
    let shell = resolve_shell(shell.as_deref());
    let command = command.as_deref().filter(|c| !c.trim().is_empty());
    let mut cmd = launch_command(&shell, command);
    // Start in the requested folder; fall back to the home dir if it's missing/unset (the wizard's
    // working folder may have been deleted between sessions — PLAN failure handling).
    let dir = cwd
        .filter(|d| std::path::Path::new(d).is_dir())
        .or_else(home_dir);
    if let Some(dir) = dir {
        cmd.cwd(dir);
    }
    apply_locale_env(&mut cmd);

    // Inter-pane control bus discovery (ADR-0007): tell the child where the socket is, what
    // its own pane is called (so an agent can address panes relative to itself), and make the
    // `th` CLI directly invokable by exposing its path and prepending its dir to PATH.
    cmd.env("TERMHAUS_SOCK", crate::control::endpoint());
    if let Some(name) = name.as_deref().filter(|n| !n.is_empty()) {
        cmd.env("TERMHAUS_PANE", name);
    }
    if let Some(cli) = crate::control::cli_path() {
        cmd.env("TERMHAUS_CLI", cli.to_string_lossy().into_owned());
        if let Some(dir) = cli.parent() {
            // Prepend the CLI's dir to PATH using the platform list separator (`:` unix, `;` win).
            let existing = std::env::var_os("PATH").unwrap_or_default();
            let mut entries = vec![dir.to_path_buf()];
            entries.extend(std::env::split_paths(&existing));
            if let Ok(joined) = std::env::join_paths(entries) {
                cmd.env("PATH", joined);
            }
        }
    }
    // The MCP server sits beside `th` (already on PATH above); also expose its absolute path so an
    // agent's `.mcp.json` can reference `$TERMHAUS_MCP` directly (ADR-0007, IDEAS.md step C).
    if let Some(mcp) = crate::control::mcp_path() {
        cmd.env("TERMHAUS_MCP", mcp.to_string_lossy().into_owned());
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // A killer we can store in the Pane to terminate the child from `kill`, while the
    // `Child` itself moves into the reaper thread below for `wait()`.
    let killer = child.clone_killer();
    // Grab the pid before the `Child` moves into the reaper thread — used to read the
    // shell's live cwd for the Source Control panel.
    let pid = child.process_id();
    // Close our handle to the slave so EOF propagates when the child exits.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    // Keep the master alive for resize() for the pane's lifetime.
    let master = pair.master;

    let id = {
        let mut next = mgr.next_id.lock().unwrap();
        let id = *next;
        *next += 1;
        id
    };

    // Reader thread: blocking reads off the PTY master -> raw chunks down a *bounded*
    // sync channel. When the flusher falls behind, `send` blocks here: the reader stops
    // draining the PTY, the kernel buffer fills, and the child is OS-back-pressured.
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(CHANNEL_DEPTH);
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — child exited
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Optional session log (opt-in, per-pane): append the raw PTY output to a file as it
    // streams. This is product-driven (the frontend decides the path when logging is on) but
    // the *writing* is an OS concern, so it rides the flusher thread alongside the IPC send.
    // We tee the un-encoded bytes — the log is the verbatim terminal stream, escape codes and
    // all (matching what xterm received), never the base64 frames.
    let mut log = log_path
        .as_deref()
        .filter(|p| !p.trim().is_empty())
        .and_then(
            |p| match OpenOptions::new().create(true).append(true).open(p) {
                Ok(f) => Some(std::io::BufWriter::new(f)),
                Err(e) => {
                    eprintln!(
                        "termhaus: session log unavailable at {p} ({e}); logging off for this pane"
                    );
                    None
                }
            },
        );

    // The output/exit sinks live behind a mutex so `retarget` can swap them to another window's
    // Channels mid-stream (tear-off). The flusher/reaper clone the Arcs; the Pane keeps copies.
    let sink = Arc::new(Mutex::new(on_output));
    let exit_sink = Arc::new(Mutex::new(on_exit));

    // Flusher thread: coalesce into one frame and emit at most once per FLUSH_INTERVAL.
    // The frame-rate cap is what keeps WebKitGTK alive under a flood — without it we'd
    // post to the IPC as fast as base64 runs and balloon the main process. acc is capped
    // at FRAME_MAX; when it's full we stop draining `rx`, which back-pressures the reader.
    let mut child = child;
    let panes = mgr.panes.clone();
    let flush_sink = sink.clone();
    let flush_exit = exit_sink.clone();
    std::thread::spawn(move || {
        let engine = base64::engine::general_purpose::STANDARD;
        let mut acc: Vec<u8> = Vec::with_capacity(FRAME_MAX);
        // Block until the first byte of the next frame; `recv` erroring means the reader
        // is gone (child exited), which ends the loop and falls through to reaping.
        while let Ok(first) = rx.recv() {
            acc.extend_from_slice(&first);
            let frame_start = Instant::now();
            // Greedily coalesce whatever is already queued, up to the per-frame cap.
            // Leaving the rest in `rx` is deliberate: a full channel blocks the reader.
            while acc.len() < FRAME_MAX {
                match rx.try_recv() {
                    Ok(chunk) => acc.extend_from_slice(&chunk),
                    Err(_) => break,
                }
            }
            if let Some(w) = log.as_mut() {
                let _ = w.write_all(&acc);
                let _ = w.flush();
            }
            // Lock just long enough to enqueue the frame; `retarget` may have swapped the sink to
            // another window's Channel since the last frame, and that's exactly the point.
            let _ = flush_sink.lock().unwrap().send(engine.encode(&acc));
            acc.clear();
            // Pace: hold the floor at one frame per FLUSH_INTERVAL so we never out-run
            // the webview's ability to render (the cause of the unbounded-memory flood).
            if let Some(rest) = FLUSH_INTERVAL.checked_sub(frame_start.elapsed()) {
                std::thread::sleep(rest);
            }
        }
        // Reap the child so it doesn't linger as a zombie, report its exit, and drop the
        // pane so a dead PaneId stops resolving (write/resize/kill become no-ops).
        let code = match child.wait() {
            Ok(status) => status.exit_code() as i32,
            Err(_) => -1,
        };
        let _ = flush_exit.lock().unwrap().send(code);
        panes.lock().unwrap().remove(&id);
    });

    mgr.panes.lock().unwrap().insert(
        id,
        Pane {
            master,
            writer,
            killer,
            pid,
            sink,
            exit_sink,
        },
    );
    Ok(id)
}

/// Point a live pane's output (and exit) at a different window's Channels — the basis of tearing a
/// pane off into its own window and re-docking it. The PTY, its child, and all I/O threads keep
/// running untouched; only where the bytes are delivered changes. A no-op error if the pane is gone.
pub fn retarget(
    mgr: &PtyManager,
    id: u32,
    on_output: Channel<String>,
    on_exit: Channel<i32>,
) -> Result<(), String> {
    let panes = mgr.panes.lock().unwrap();
    let pane = panes.get(&id).ok_or_else(|| format!("no live pane {id}"))?;
    *pane.sink.lock().unwrap() = on_output;
    *pane.exit_sink.lock().unwrap() = on_exit;
    Ok(())
}

/// Best-effort current working directory of a pane's shell, read from `/proc/<pid>/cwd`.
/// This is the one place Termhaus inspects a pane's live process state — used only for the
/// explicit Source Control action to scope `git` to where the focused terminal actually is
/// (see ADR-0001's "live cwd" carve-out). Returns `None` (not an error) when the pid is
/// unknown or the link can't be read — e.g. the child already exited — so callers fall back.
#[cfg(unix)]
pub fn cwd(mgr: &PtyManager, id: u32) -> Result<Option<String>, String> {
    let pid = match mgr.panes.lock().unwrap().get(&id) {
        Some(p) => p.pid,
        None => return Ok(None),
    };
    let Some(pid) = pid else { return Ok(None) };
    match std::fs::read_link(format!("/proc/{pid}/cwd")) {
        Ok(path) => Ok(Some(path.to_string_lossy().into_owned())),
        Err(_) => Ok(None),
    }
}

/// Non-Unix stub: no `/proc`, so the panel falls back to the workspace folder (see M7).
#[cfg(not(unix))]
pub fn cwd(_mgr: &PtyManager, _id: u32) -> Result<Option<String>, String> {
    Ok(None)
}

/// Whether a pane is "busy" — running a foreground command rather than sitting at the shell
/// prompt. We read the PTY's foreground process group (`tcgetpgrp` on the master, via
/// portable-pty) and compare it to the shell's own pid: at the prompt the shell *is* the
/// foreground group leader, so a different leader means some child command holds the terminal.
/// This is a metadata signal (kernel process state), never pane output — it stays inside
/// ADR-0001's opacity rule, the same carve-out as `cwd`. `None` when the answer is unknown
/// (pid/leader unavailable, e.g. the child just exited) so the UI shows no busy state.
#[cfg(unix)]
pub fn busy(mgr: &PtyManager, id: u32) -> Result<Option<bool>, String> {
    let panes = mgr.panes.lock().unwrap();
    let Some(pane) = panes.get(&id) else {
        return Ok(None);
    };
    let Some(pid) = pane.pid else {
        return Ok(None);
    };
    match pane.master.process_group_leader() {
        Some(leader) => Ok(Some(leader != pid as i32)),
        None => Ok(None),
    }
}

/// Non-Unix stub: no foreground-process-group query, so panes never report busy (see M7).
#[cfg(not(unix))]
pub fn busy(_mgr: &PtyManager, _id: u32) -> Result<Option<bool>, String> {
    Ok(None)
}

/// The command line of the pane's foreground process group leader — what's actually running
/// in the terminal right now (e.g. `claude`), regardless of how it was launched (wizard spec,
/// the ✦ button, or typed by hand). Lets the frontend badge a pane by its live agent.
///
/// Same mechanism and opacity stance as `busy`: we read the foreground pgrp leader (kernel
/// process state) and its `/proc/<pid>/cmdline` (argv, NUL-joined → space-joined) — process
/// metadata, never pane output (ADR-0001 carve-out, same as `cwd`). Returns `None` when the
/// shell itself is in the foreground (at the prompt, leader == shell pid → no command running)
/// or when the leader/cmdline is unavailable.
#[cfg(unix)]
pub fn foreground(mgr: &PtyManager, id: u32) -> Result<Option<String>, String> {
    let panes = mgr.panes.lock().unwrap();
    let Some(pane) = panes.get(&id) else {
        return Ok(None);
    };
    let Some(pid) = pane.pid else {
        return Ok(None);
    };
    let Some(leader) = pane.master.process_group_leader() else {
        return Ok(None);
    };
    // At the prompt the shell is its own foreground leader — nothing is "running".
    if leader == pid as i32 {
        return Ok(None);
    }
    let raw = match std::fs::read(format!("/proc/{leader}/cmdline")) {
        Ok(b) => b,
        Err(_) => return Ok(None),
    };
    // cmdline is NUL-separated argv; join with spaces and trim the trailing NUL.
    let cmd: String = String::from_utf8_lossy(&raw)
        .split('\0')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if cmd.is_empty() {
        Ok(None)
    } else {
        Ok(Some(cmd))
    }
}

/// Non-Unix stub: no `/proc`, so foreground detection is unavailable (see M7).
#[cfg(not(unix))]
pub fn foreground(_mgr: &PtyManager, _id: u32) -> Result<Option<String>, String> {
    Ok(None)
}

/// Forward keystrokes (UTF-8) from the webview into the pane's PTY.
pub fn write(mgr: &PtyManager, id: u32, data: &str) -> Result<(), String> {
    let mut panes = mgr.panes.lock().unwrap();
    let pane = panes.get_mut(&id).ok_or("no such pane")?;
    pane.writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    pane.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Tell the PTY its new dimensions (after the webview's fit addon recomputes cols/rows).
pub fn resize(mgr: &PtyManager, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let panes = mgr.panes.lock().unwrap();
    let pane = panes.get(&id).ok_or("no such pane")?;
    pane.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Terminate a pane's child and drop its PTY. The reaper thread then fires `on_exit` and
/// removes the entry, so this is idempotent — killing an already-dead pane is a no-op.
pub fn kill(mgr: &PtyManager, id: u32) -> Result<(), String> {
    let mut pane = match mgr.panes.lock().unwrap().remove(&id) {
        Some(p) => p,
        None => return Ok(()),
    };
    let _ = pane.killer.kill();
    // Dropping `pane` here closes the master/writer; the reaper observes the child exit.
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::{check_command, resolve_shell};

    #[test]
    fn resolve_shell_prefers_existing_pref() {
        // An explicit shell that exists wins outright.
        assert_eq!(resolve_shell(Some("/bin/sh")), "/bin/sh");
    }

    #[test]
    fn resolve_shell_skips_missing_pref() {
        // A non-existent pref is ignored; we fall through to a shell that actually exists.
        let got = resolve_shell(Some("/nonexistent/zsh"));
        assert_ne!(got, "/nonexistent/zsh");
        assert!(
            std::path::Path::new(&got).exists(),
            "resolved shell should exist: {got}"
        );
    }

    #[test]
    fn resolve_shell_blank_pref_falls_through() {
        assert!(std::path::Path::new(&resolve_shell(Some("   "))).exists());
    }

    #[test]
    fn check_command_empty_is_available() {
        // An empty command is a plain shell — always launchable.
        assert!(check_command("", None));
    }
}
