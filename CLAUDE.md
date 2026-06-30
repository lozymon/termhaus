# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

**Implemented and shipping** (v0.5.0). The milestone plan (M0–M11) in [PLAN.md](PLAN.md) is done, and the whole [docs/IDEAS.md](docs/IDEAS.md) follow-up roadmap is shipped too: agent-pushed status/attention signals (`th status`/`th attention`), the agent-integration arc (`th hooks` + the `th-mcp` MCP server), workspace polish (Ctrl+Shift+1–9, duplicate, shortcuts cheat-sheet, per-agent tint), faithful-layout presets, overview drag-reorder, the session-log viewer, and the bigger bets (system tray + global hotkey). Multi-window tear-off is merged and shipping on `main` (`src/lib/detach.ts`, `DetachedPane.tsx`, the `pty_retarget` command). **The human broadcast bar was removed 2026-06-25** as unused (multi-agent work is cross-project); one-to-many fan-out is now agent-driven only, via `th broadcast` / the `th-mcp` `broadcast` tool — see [docs/ASSESSMENT.md](docs/ASSESSMENT.md). **The Git (Source Control) panel and the Docs reader were removed 2026-06-29** to refocus Termhaus on being the terminal layer — the ADE role (git, code, docs context) now lives in the companion "loom" app; see [ADR-0008](docs/adr/0008-narrow-to-terminal-loom-owns-ade.md).

Treat **PLAN.md** (design/milestones) and the **ADRs** under [docs/adr/](docs/adr/) as the source of truth for the *why*; update them if the design changes. IDEAS.md tracks the post-v1 feature log (each item has a "✅ Built as" note).

> **Note:** Termhaus is a **GUI terminal multiplexer** — real PTYs in resizable split grids and a left workspace rail. Agents are just one thing you can run in a pane; the model is generic terminals (panes are opaque — Termhaus never parses their output; see [ADR-0001](docs/adr/0001-opaque-panes-no-agent-awareness.md)).

## What this is

Termhaus — a Linux-first desktop "control room" of real terminals. You run many PTYs at once, arranged in **resizable split grids and a left workspace rail** (a GUI tmux/Terminator), tuned for driving fleets of CLI agents: one agent can drive the others — including fanning a prompt to every pane in a workspace via `th broadcast` — over the inter-pane control bus (ADR-0007). *(There is no human broadcast-input bar; it was removed 2026-06-25.)* Stack is **locked in**: Tauri 2 (Rust shell + WebKitGTK webview), SolidJS + Vite + TypeScript frontend, **xterm.js** (`@xterm/xterm` 5.x) for rendering, and **`portable-pty`** (Rust) for PTYs. Persistence is local JSON (`workspace.json`); SQLite is deferred. Target environment: Node v24, Rust 1.96, Linux Mint 22.3.

## Commands

- `npm run tauri dev` — run the app in development (opens the Tauri window, starts Vite + the Rust shell).
- `npm run build` — Vite production build of the frontend (`tsc`-checked via the build; run `npx tsc --noEmit` for a standalone typecheck).
- `npm test` — the Vitest unit suite (pure-logic libs: layout, grid, matching, agents, ansi, keybindings, paneControl, ptyClient).
- Rust lives in `src-tauri/`: `cargo check`, `cargo clippy`, and `cargo fmt --check` (CI enforces rustfmt). The crate builds the app plus two extra binaries — `th` (the inter-pane control CLI, ADR-0007) and `th-mcp` (the MCP server) — both std + serde_json only, sharing the socket client in `src-tauri/src/control_sock.rs`.

## Architecture — the non-obvious decisions

These cross-cutting rules shape nearly every file. Read them before touching the PTY layer, IPC, or layout engine.

**One PtyManager, N PTYs (one per pane).** Rust owns a `HashMap<PaneId, PtySession>`; each session is a PTY master (`portable-pty`), its child process, and a dedicated reader thread. The kernel isolates each pane's process for free. Build the manager so panes are addressed by `PaneId` indirection from day one.

**Rust does the core now (this inverts the old thin-Rust rule).** PTYs are an OS concern, so the engine lives in Rust: spawn PTY + child from a `PaneSpec`, pump master→webview, accept write/resize/kill, reap exited children, save/load `workspace.json`. Still **no product logic in Rust** — layout geometry, drag-resize, focus/zoom, the workspace rail, and broadcast routing all live in TypeScript/SolidJS. If it's UX or state, it's TS; if it's a PTY/OS syscall or packaging path, it's Rust.

**Output = Tauri `Channel`, input = cheap commands.** PTY output streams to the webview over a `tauri::ipc::Channel`, never per-line JSON events. (Current M0 transport: bytes are base64-encoded into a `Channel<String>` — the simplest guaranteed-correct path; raw-byte channels are the future optimization per ADR-0003. See `pty.rs`.) Keystrokes go the other way as `pty_write(id, bytes)` commands; resize as `pty_resize(id, cols, rows)`; lifecycle as `pty_spawn`/`pty_kill`; and `pty_retarget` re-points a live pane's output Channel at another window (multi-window tear-off). Never round-trip terminal output through commands. The output Channel is byte-protocol-only — Rust logging goes to stderr, never into the stream.

**Coalesce output, or WebKitGTK locks up — hard rule.** Each reader thread buffers and flushes on a ~8–16ms tick *or* a 32–64KB size threshold, whichever first, to cap frames-per-second per pane under floods (`yes`, big `cat`). Feed chunks straight to `term.write()` (xterm has its own write buffer) — do not pre-split into per-token DOM work. Start on the **canvas** renderer; treat `@xterm/addon-webgl` as optional and fall back gracefully (WebGL under WebKitGTK is the flaky path). Bounded/drop buffers, not unbounded queues; throttle hidden Workspaces.

**The workspace rail is a LEFT vertical list; "new workspace" is a wizard.** The rail lists Workspaces (name + terminal-count badge + close ✕); switching swaps the whole grid, hidden Workspaces keep their PTYs alive. Hierarchy is exactly two levels (Workspace → Pane) — no tmux-style "window" layer, and "tab" is retired as a term. Clicking **+** opens a 3-step **Start→Layout→Agents** wizard: pick a working folder (with Recents/Presets) → tap a grid-preset tile (1/2/4/6/8/10/12 terminals → `buildBalancedTree(n)`) → optionally set per-pane launch commands → launch ("Open without AI" = plain shells). Don't build top tabs or a freeform-split-only creation flow.

**Layout = a binary split tree per workspace.** `LayoutNode` is `{kind:'leaf', paneId}` or `{kind:'split', dir:'row'|'col', ratio, a, b}`. Splitting replaces a leaf with a split (old leaf + new pane); closing collapses the parent and promotes the sibling. Draggable gutters mutate `ratio`. Each pane measures its box with `@xterm/addon-fit` → derives cols/rows → debounced `pty_resize`. Every pane has a title bar: auto-name (Faye, Cleo…) + per-pane controls (collapse/split/zoom/close) + focus ring. Grid presets are just `buildBalancedTree(n)` constructors, not a separate mode — the freeform splitter still works after launch.

**Persist intent, not scrollback.** `workspaces.json` stores Workspaces, each tree, and per-pane `PaneSpec` (command, cwd, env, title). On launch, rebuild the tree and **respawn** each command in its cwd — terminals are not restored to prior output (ephemeral). SQLite only enters the picture if searchable scrollback/session logging becomes a goal.

**Shared types in one module.** `PaneId`, `PaneSpec`, `LayoutNode`, `Workspace`, and command names live in `src/ipc/protocol.ts`; Rust command signatures mirror it.

**Inter-pane control bus = Rust socket relay, routing in TS** (ADR-0007). A process *inside* a pane (e.g. a `claude` CLI) can drive other panes via the `th` CLI → a unix socket at `$TERMHAUS_SOCK`. Rust is a **pure relay**: it forwards the raw request string to the webview as a `termhaus://pane-cmd` event and writes back whatever the frontend replies via `pane_cmd_reply` — it never parses the protocol. All routing (name→pane resolution, writes through the pane registry, `spawn` layout mutation) stays in TS, per the no-product-logic-in-Rust rule. Each PTY child gets `TERMHAUS_SOCK`/`TERMHAUS_PANE`/`TERMHAUS_CLI` injected and the CLI dir prepended to `PATH`. This is an **inbound command channel**, distinct from ADR-0001's opacity rule (which forbids parsing pane *output* — still rejected).

## Key files (all exist — this is the map, not a to-do)

**Rust (`src-tauri/src/`):** `pty.rs` (`PtyManager`: spawn, reader+coalescing-flush threads, write/resize/kill/retarget, reaping) · `lib.rs` (command handlers + Channel wiring + tray/plugin setup) · `control.rs` + `bin/th.rs` (inter-pane bus: socket relay + the `th` CLI, ADR-0007) · `bin/th-mcp.rs` (MCP server) · `control_sock.rs` (socket client shared by both bins) · `tray.rs` (system tray) · `logs.rs` · `capture.rs` · `workspace.rs` (JSON persistence).

**Frontend (`src/`):** `ipc/protocol.ts` (shared types + command names) · `lib/ptyClient.ts` (bind xterm to the output Channel) · `lib/paneControl.ts` (bus routing) · `lib/detach.ts` (multi-window, branch) · `stores/workspace.ts` (normalized Workspaces/trees/panes/focus/zoom) · `stores/{activity,settings,theme}.ts` · `components/` — `Terminal`, `LayoutNode`, `WorkspaceRail`, `NewWorkspaceWizard`, `SessionLogViewer`, `ShortcutsOverlay`, `CommandPalette`, `Settings`, `TitleBar`.

Most new work follows an existing pattern — overlay/side panels mirror `SessionLogViewer.tsx`; new shortcuts add an action to `lib/keybindings.ts` and wire both dispatch maps (App global + Terminal); new bus ops extend `ControlRequest` in `protocol.ts`, handle in `paneControl.ts`, and add a `th`/`th-mcp` front-end.

## Resolved risk (kept for context)

The make-or-break M0 assumption — **PTY throughput rendering smoothly in WebKitGTK via Tauri IPC** — was proven and holds: a single pane survives a flood (`yes`, big `cat`, `find /`) with no main-thread lockup and bounded memory, via a base64 `Channel<String>` + Rust-side coalescing (frame-rate cap + bounded reader→flusher channel for OS back-pressure) + the canvas renderer. Don't regress the coalescing/back-pressure in `pty.rs` — that's what keeps the webview alive under floods (see ADR-0003, ADR-0006).
