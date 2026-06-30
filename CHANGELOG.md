# Changelog

All notable changes to Termhaus are documented here. The format is loosely based on
[Keep a Changelog](https://keepachangelog.com/), and the project follows semantic
versioning.

## [0.12.0] — 2026-06-30

### Removed
- **Git (Source Control) panel and Docs reader** — Termhaus is refocused on being the
  terminal layer; the ADE role (git, code, and docs context) now lives in the companion
  "loom" app. Both panels and their backends (`git.rs`/`docs.rs`, the diff/markdown clients,
  the `markdown-it` dependency) are gone, the now-empty docked-panel system collapsed, and
  the per-pane git-branch badge in the title bar was removed with it. See
  [ADR-0008](docs/adr/0008-narrow-to-terminal-loom-owns-ade.md).

### Changed
- **One binary, three faces** — the separate `th` (control CLI) and `th-mcp` (MCP server)
  binaries are folded into the single `termhaus` executable, dispatched on the first arg:
  `termhaus <cmd>` drives the inter-pane bus, `termhaus mcp` runs the MCP server, anything
  else opens the GUI. The in-pane command is now `termhaus …` (not `th`), MCP launches via
  `termhaus mcp`, and panes get `$TERMHAUS_BIN` injected (replacing `$TERMHAUS_CLI` /
  `$TERMHAUS_MCP`). See the [ADR-0007](docs/adr/0007-inter-pane-control-bus.md) amendment.
  *External `.mcp.json` files that pointed at `th-mcp` should switch to `$TERMHAUS_BIN mcp`.*
- **New brand icon set** — refreshed app icon, title-bar mark, and favicon (the terminal-grid
  mark: cyan frame + orange prompt), replacing the leftover template logo.

### Fixed
- **Status/attention hooks no longer error outside a pane** — the `termhaus status`/`attention`
  hooks are guarded on `$TERMHAUS_PANE`, so running an agent's Claude Code hooks outside a
  Termhaus pane no longer spams errors on every turn.

## [0.11.0] — 2026-06-25

### Added
- **Code-review queue in Source Control** — the git diff panel is now a review tool.
  Select a diff region (drag lines, or click a hunk header to grab the whole hunk),
  optionally attach a note, then **Send ▸** it to the focused agent pane or **＋** queue
  it. Queued comments collect in a review bar (removable chips) and **Send review ▸**
  sends them all as one numbered "Code review — N comments" message. The panel now stays
  open across sends (review is iterative), and whole-file **＋ file / Send file** shortcuts
  are available. Still strictly read-only — staging/commit stays with the agent.

### Changed
- **Docs panel markdown rendering** now uses a real CommonMark engine (markdown-it):
  tables, nested lists, strikethrough, and proper soft-wrap reflow instead of the previous
  minimal parser. Selecting a rendered block still sends the raw markdown source. The panel
  also gains a fuzzy **filter box** with arrow/Enter navigation, a **change-folder** button
  to re-point the scanned root, and it now **stays open after a send**; the folder scan
  reaches deeper (4 levels).

### Removed
- **Right-side web preview panel** — embedding an `<iframe>` browser was scope creep for a
  terminal multiplexer; a real browser is one Alt-Tab away. The panel, its `Ctrl+Shift+B`
  shortcut/nav item, and its settings were removed.
- **Human broadcast bar** — the manual prompt-to-many-panes bar (and its target modes, saved
  groups, snippets, history, stagger, and per-pane target toggle) was removed as unused;
  multi-agent work here is cross-project, which the single-workspace bar never served. The
  agent-facing fan-out is kept: `th broadcast` and the `th-mcp` `broadcast` tool still fan a
  prompt to every pane in a workspace via the inter-pane control bus.

### Fixed
- **Mid-stream session-log write failures are now surfaced** — if a pane's opt-in session log
  fails to write partway through, the pane flags the error instead of silently dropping output
  from the log.

## [0.10.0] — 2026-06-24

### Added
- **Per-pane shell picker with WSL support (Windows)** — choose PowerShell, Command
  Prompt, or any installed WSL distro per pane in the new-workspace wizard, so a single
  workspace can mix shells (e.g. Claude in WSL/Ubuntu beside a PowerShell pane). The
  "Fill every pane with" row gains a matching `[agent] in [shell]` selector, and the
  chosen shell is remembered per pane and restored on relaunch.
- **Region capture on Windows** — the screenshot-to-pane control now works on Windows by
  driving the built-in Snip & Sketch overlay and saving the snip as PNG, matching the
  Linux flameshot/grim contract (a cancelled snip leaves the clipboard intact).

### Changed
- **Command panes drop into a shell on exit** — when a pane launched with a command
  (e.g. `claude`) exits, it now opens an interactive shell in the same folder instead of
  going dead, so you keep a usable terminal. Typing `exit` then closes the pane as usual.

### Fixed
- **Panes froze on process exit (Windows)** — quitting a program in a pane (e.g. exiting
  Claude) left the pane stuck on its last frame. On Windows ConPTY the PTY reader never
  sees EOF while the pseudoconsole stays open, so the exit was never detected. Exit is now
  observed independently and the pseudoconsole torn down in the documented ConPTY order,
  so the pane reports the exit and recovers.
- **External editor & `th` CLI resolution on Windows** — a bare editor command like `code`
  now resolves via PATH×PATHEXT (`code.cmd`), and the `th`/`th-mcp` sidecar binaries are
  found with their `.exe` suffix so a pane's inter-pane control bus is wired up.

## [0.9.0] — 2026

### Added
- **Open folder in external editor** — a `✎` control on each pane (and `Ctrl+Shift+I`,
  rebindable) launches your configured editor on the pane's working folder. Set the
  command in Settings → Terminal → External editor (e.g. `code`, `subl`, `zed`); the
  folder is appended, or substituted for a `{dir}` token.

### Fixed
- **Copy under WebKitGTK 2.5x (Linux Mint)** — `Ctrl+Shift+C` could silently drop the
  copy when the xterm selection was already cleared as the keystroke was processed,
  leaving the clipboard stale. The last selection is now cached and used as a fallback.

## [0.8.0] — 2026

### Added
- **Per-workspace Source Control & Docs panels** — each workspace independently
  owns whether the docked SC / Docs / Preview panel is open, and the source folder
  is captured from the active terminal when you open it and pinned to that
  workspace. Switching workspaces shows only what that workspace had open.
- Project (repo) name in the Source Control header, beside the branch.
- Documentation: `docs/cli.md` (the `th` CLI reference), `docs/troubleshooting.md`,
  and this `CHANGELOG.md`.

## [0.7.0] — 2026

### Added
- Collapsible workspace rail with lettered avatars.
- Setting to show/hide the broadcast bar.

## [0.6.0]

### Changed
- **Frameless redesign**: resizable side panels, a Settings overlay, and a refreshed
  window chrome.

## [0.5.1]

### Added
- Multi-window **tear-off**: pop a pane into its own window; torn-off panes stay
  reachable via broadcast and `th send`.
- Right-side **preview panel** (docked browser view).
- **System tray** + global summon/hide hotkey + close-to-tray.
- Faithful preset layouts, overview drag-reorder, and the **session-log viewer**.
- Workspace polish: `Ctrl+Shift+1–9` jump, duplicate workspace, shortcuts cheat-sheet,
  per-agent tint.
- **`th-mcp`** — the Termhaus MCP server, exposing the control bus as agent tools.
- **`th hooks`** — bridge Claude Code lifecycle events to the control bus.
- **Docs reader**: Raw/Preview markdown toggle; mark a passage and send it to a pane.
- **Fleet console**: flagged-reply broadcast, saved groups, agent status.
- Windows support (Linux-side, cross-checked).

### Fixed
- Preserve scrollback across pane tear-off / re-dock.
- Periodic poll no longer freezes the UI thread.
- Square off window corners when maximized/fullscreen.

### Security
- Fixed markdown XSS; hardened file-read commands and the control bus; CSP verified.

## [0.4.0]

### Added
- **Overview mode** — uniform tile wall for fleet-glance (`Ctrl+Shift+O`).
- Desktop notifications on attention + persisted broadcast history.
- `th attention` — self-flagged "needs you" pane border.
- Per-pane AI agent badges and title-bar polish.
- Single-page workspace launcher with visual layout + fleet fill.
- `Ctrl+Shift+,` opens Settings; app shortcuts work without pane focus.
- Customizable workspace names + double-click rename in the rail.
- `Ctrl+Shift+ +/-` to change terminal font size.

## [0.3.0]

### Added
- **Inter-pane control bus** + the `th` CLI (ADR-0007).
- Source-control panel with a git diff viewer; send selected diff lines to a pane.
- Per-pane button to launch Claude in the terminal's cwd.
- Snapshot a screen region into the focused pane.
- Live cwd + git branch in pane title bars.
- Configurable key bindings; theming system with light mode and selectable themes.
- Command palette, broadcast power-ups, drag-swap, session logging.

### Fixed
- Stop paste duplicating under WebKitGTK.
- Don't clobber a live control socket on startup.
- Debounce pane refit to stop resize stutter.

## [0.1.0] — initial release

- Termhaus terminal multiplexer (milestones M0–M6): real PTYs in resizable split grids,
  the left workspace rail, the Start→Layout→Agents wizard, broadcast input, and local
  JSON persistence of workspace intent.

[0.12.0]: https://github.com/lozymon/termhaus/releases/tag/v0.12.0
[0.8.0]: https://github.com/lozymon/termhaus/releases/tag/v0.8.0
[0.7.0]: https://github.com/lozymon/termhaus/releases/tag/v0.7.0
[0.6.0]: https://github.com/lozymon/termhaus/releases/tag/v0.6.0
[0.5.1]: https://github.com/lozymon/termhaus/releases/tag/v0.5.1
[0.3.0]: https://github.com/lozymon/termhaus/releases/tag/v0.3.0
