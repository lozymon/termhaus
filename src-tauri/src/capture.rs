// Screen-region capture: shell out to a desktop screenshot tool, let the user drag-select a
// region, save the result as a PNG in the temp dir, and return its path. The frontend types
// that path into the focused pane (so a CLI agent like Claude Code can read the image). This
// is an OS concern, so it lives in Rust (CLAUDE.md: OS/syscalls in Rust, UX/state in TS).
//
// Linux-first (X11/Wayland). Tries, in order: flameshot (a region selector that streams raw
// PNG to stdout, so we own the filename) → gnome-screenshot's area mode → grim+slurp (the
// wlroots-Wayland combo). A user who cancels the selection produces no file → we report it as
// a benign "cancelled" error; if none of the tools is installed we return a "no screenshot
// tool" error the frontend turns into an install hint.

// The shell-out path is Unix-only (flameshot/gnome-screenshot/grim are Linux tools). On Windows
// the command is gated to a clean "not yet supported" error for the first release (PLAN M7.6 —
// the cheap acceptable v1); a native path lands with M9's xcap-based capture, which supersedes
// this whole file. The imports below are only used by the Unix impl.
#[cfg(unix)]
use std::io::ErrorKind;
#[cfg(unix)]
use std::path::PathBuf;
#[cfg(unix)]
use std::process::Command;
#[cfg(unix)]
use std::time::{SystemTime, UNIX_EPOCH};

/// A unique temp path like `/tmp/termhaus-snap-<nanos>.png`.
#[cfg(unix)]
fn snap_path() -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("termhaus-snap-{nanos}.png"))
}

/// Capture a user-selected screen region to a PNG; returns its absolute path.
#[cfg(unix)]
#[tauri::command]
pub fn capture_region() -> Result<String, String> {
    let path = snap_path();

    // flameshot: `gui --raw` opens the region selector and prints the PNG to stdout.
    match Command::new("flameshot").args(["gui", "--raw"]).output() {
        Ok(out) => {
            if !out.status.success() {
                return Err(format!("flameshot exited with {}", out.status));
            }
            if out.stdout.is_empty() {
                return Err("capture cancelled".into());
            }
            std::fs::write(&path, &out.stdout)
                .map_err(|e| format!("failed to save snapshot: {e}"))?;
            return Ok(path.to_string_lossy().into_owned());
        }
        // Only fall through when flameshot isn't installed; surface other errors.
        Err(e) if e.kind() != ErrorKind::NotFound => {
            return Err(format!("failed to launch flameshot: {e}"));
        }
        Err(_) => {}
    }

    // gnome-screenshot: `-a` area-select, `-f` write straight to our file.
    match Command::new("gnome-screenshot")
        .args(["-a", "-f"])
        .arg(&path)
        .status()
    {
        Ok(status) => {
            if !status.success() || !path.exists() {
                return Err("capture cancelled".into());
            }
            return Ok(path.to_string_lossy().into_owned());
        }
        // Only fall through when gnome-screenshot isn't installed; surface other errors.
        Err(e) if e.kind() != ErrorKind::NotFound => {
            return Err(format!("failed to launch gnome-screenshot: {e}"));
        }
        Err(_) => {}
    }

    // grim + slurp: the wlroots-Wayland combo (Sway, Hyprland). `slurp` drags out a region
    // geometry, `grim -g` crops to it and writes our file. Does not cover GNOME/KDE Wayland,
    // which don't implement wlr-screencopy — those need gnome-screenshot/spectacle above.
    match Command::new("slurp").output() {
        Ok(sel) => {
            if !sel.status.success() || sel.stdout.is_empty() {
                return Err("capture cancelled".into());
            }
            let geom = String::from_utf8_lossy(&sel.stdout).trim().to_string();
            match Command::new("grim")
                .arg("-g")
                .arg(&geom)
                .arg(&path)
                .status()
            {
                Ok(status) if status.success() && path.exists() => {
                    return Ok(path.to_string_lossy().into_owned());
                }
                Ok(_) => return Err("capture cancelled".into()),
                Err(e) => return Err(format!("failed to launch grim: {e}")),
            }
        }
        // slurp missing → no tool at all; fall through to the final error.
        Err(e) if e.kind() != ErrorKind::NotFound => {
            return Err(format!("failed to launch slurp: {e}"));
        }
        Err(_) => {}
    }

    // The marker substring "no screenshot tool" is matched by the frontend (Terminal.tsx) to
    // show an install hint in the pane — keep it stable if you reword this.
    Err("no screenshot tool found — install flameshot, gnome-screenshot, or grim+slurp".into())
}

/// Windows: region capture isn't wired up yet (PLAN M7.6 — gated off for the first Windows
/// release; the native path arrives with M9's xcap capture). The command stays registered so the
/// frontend's `Ctrl+Shift+S` flow gets a clean error instead of a missing-command failure.
#[cfg(windows)]
#[tauri::command]
pub fn capture_region() -> Result<String, String> {
    Err("region capture isn't available on Windows yet".into())
}
