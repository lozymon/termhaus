# Termhaus — improvement & feature ideas

A running, unprioritised-then-prioritised list of things we *could* build next. The core
(M0–M11) is done and solid: PTY engine, split-tree layout, workspace rail, single-page
launcher, agent control bus, presets, copy/paste/search, themes, git panel, overview mode,
notifications, the inter-pane `th` control bus, region capture, and the command palette.

So this list is **not** about re-paving basics. The guiding question is: *what sharpens the one
thing Termhaus is uniquely for — driving a fleet of CLI agents from one window?*

Everything here is **ADR-0001-safe**: Termhaus never parses pane *output*. Agent-driven signals
come in through the `th` control bus (ADR-0007), which is an inbound, agent-pushed channel —
the agent flags itself; we never infer state from what scrolls by.

> Status legend: 🟢 mostly wiring existing primitives · 🟡 moderate · 🔴 larger bet.

---

## Tier 1 — lean into the fleet thesis (highest leverage)

> **Shipped:** #1, #2, and #3 are now built (the fleet-console increment). See the per-item
> ✅ notes below. The `th` CLI gained a `status` subcommand and `ControlRequest` gained a
> `status` op; the broadcast bar gained a **⚑ Reply to flagged** button and a saved-groups menu.

### 1. "Needs-input" triage loop  🟢 ✅ shipped
**The flow:** several agents pause on a `y/n` (or "continue?"). Each self-flags with
`th attention`, raising its amber border. You type the answer **once** and it goes only to the
flagged panes, then clears their flags.

**Why it's strong:** this is *the* fleet workflow, and both halves already exist —
- agents can raise/clear the flag: `ControlRequest { op: "attention" }` (`protocol.ts`,
  handled in `paneControl.ts`).
- broadcast can target a subset: `broadcast: PaneId[]` on the workspace + `broadcastTargets(ws)`
  (`stores/workspace.ts`), driven by `BroadcastBar.tsx`.

**What's missing:** a "flagged" target mode. Add a `broadcastTargetMode: "all" | "subset" | "flagged"`
(or a one-click **"⚑ Reply to flagged"** button on the broadcast bar) that resolves targets to the
panes currently raising attention, sends, then drops their flags.

**Build notes:** attention state lives in `stores/activity.ts` (`anyNeedsAttention`); the bar
already shows a live-reach badge — extend it to show "→ N flagged". Clearing on send means
calling the existing attention-clear path for each target after the write.

**✅ Built as:** `flaggedTargets(ws)` (`stores/workspace.ts`) resolves the flagged set from the
activity store; `BroadcastBar.tsx` shows a pulsing amber **⚑ Reply to flagged (N)** button that
appears only when panes are flagged, sends the typed text to exactly those panes (honouring the
stagger), then drops their flags via `clearAttention`. Ignores the picked subset by design.

**Removed 2026-06-25:** the human broadcast bar (and its flagged-reply button / saved groups / snippets / stagger) was deleted — the user never used it and multi-agent work is cross-project. The agent-facing fan-out (`th broadcast` / the `th-mcp` `broadcast` tool) is kept.

### 2. Saved broadcast groups  🟢 ✅ shipped
**The flow:** name a set of panes ("claudes", "frontend", "reviewers") and flip the broadcast
scope to it in one click, instead of re-selecting panes every time.

**Why:** `setBroadcastByPattern` already matches panes by name glob, but the selection is
ephemeral. Persisting named groups makes recurring fan-outs a single click and pairs naturally
with agent badges (a group can just be "every Claude pane").

**Build notes:** persist `broadcastGroups: { name: string; pattern: string }[]` in `settings.ts`
(next to `broadcastSnippets`/`broadcastHistory`, which already follow this shape). UI: a small
dropdown on `BroadcastBar.tsx`. Resolution reuses `lib/matching.ts`.

**✅ Built as:** `broadcastGroups` in `settings.ts` with `addBroadcastGroup`/`removeBroadcastGroup`;
a `⚐ ▾` groups dropdown in `BroadcastBar.tsx` (mirrors the snippets menu) — save the current
Targets pattern under a name, then one click flips the bar into select-mode and applies the glob
through the existing `setBroadcastByPattern` → `matchesPattern` path.

**Removed 2026-06-25:** the human broadcast bar (and its flagged-reply button / saved groups / snippets / stagger) was deleted — the user never used it and multi-agent work is cross-project. The agent-facing fan-out (`th broadcast` / the `th-mcp` `broadcast` tool) is kept.

### 3. Agent-controlled status label  🟡 ✅ shipped
**The flow:** an agent sets its own short status — `th status "running tests"` — shown in its
title bar and (more importantly) on its overview tile. Glance at overview → see who's building /
blocked / idle across the whole fleet.

**Why it's opacity-safe:** identical category to `attention` — the agent *pushes* the label; we
never read it from output. It turns overview mode into a real fleet dashboard.

**Build notes:** add `{ op: "status"; target: string; text?: string }` to `ControlRequest`
(`protocol.ts`), handle it in `paneControl.ts` (write into a per-pane `status` field on the store),
render it in `Terminal.tsx`'s title bar and on the overview tiles (`LayoutNode.tsx`). Extend the
`th` CLI (`src-tauri/src/bin/th.rs`). Clears on respawn.

**✅ Built as:** `status: string` on `PaneActivity` (`stores/activity.ts`, with `setStatus`/
`clearStatus`) — note it is *not* cleared by `seePane` (looking at a pane keeps its status), only
by the agent or a respawn. The `status` op is handled in `paneControl.ts`; a `.pane-statuslabel`
pill renders in `Terminal.tsx`'s title bar (and so in overview tiles for free, since overview just
repositions the full panes). `th status [pane] <text…> | --clear` added to the CLI:
`th status "running tests"` labels the calling pane; `th status Cleo --clear` clears another's.

### 4. Docs / README reader → mark & send to a Claude pane  🟡 ✅ shipped
**The flow:** open a markdown file (README, a spec, an ADR) in a side panel, read through it, mark
a passage, optionally add an instruction ("explain this", "implement this section"), and send the
selection into a Claude pane to discuss — exactly the gesture the Source Control panel already
gives you for diff lines.

**Why it fits:** feeding docs/specs into agents is core to driving them, and the whole interaction
already exists in `GitPanel.tsx` — only the *content source* changes (a markdown file instead of a
`git diff`). It also scales to the fleet: send a spec section to a **subset** of panes ("all of you
read this") via the same broadcast targeting, not just the focused pane.

**Reuse, almost verbatim:**
- selection → payload → PTY: `sendToTerminal()` in `GitPanel.tsx`, which calls
  `writeToPanes([focusedId], payload)` (`lib/paneRegistry.ts`) with an optional instruction line
  and an Enter-to-submit toggle. Swap the focused-pane target for `broadcastTargets(ws)` to fan a
  passage out to a group.
- the file/picker + live-cwd resolution: GitPanel already resolves the focused pane's live cwd
  (`paneCwd`) to know which folder to look in — a docs reader scans that folder for `*.md`
  (README first), or uses the native file dialog (`@tauri-apps/plugin-dialog`, already a dep).

**New bits:** a `DocsPanel.tsx` (mirror `GitPanel.tsx`), a rail/title-bar button + a keybinding
(register a `docs`/`open-readme` action in `lib/keybindings.ts`, dispatched like
`source-control`), and markdown rendering. Two rendering options:
- **plain text + drag-select** (cheapest, matches GitPanel's line-select gesture 1:1), or
- **rendered markdown** with selectable text (nicer to read; selection maps back to source lines —
  a bit more work). Could ship plain first, render later.

**Open question:** send the **raw markdown** of the selection (best for an agent to act on) vs. the
rendered text (nicer for humans). Lean raw — the agent wants the source.

**✅ Built as:** new Rust `docs.rs` (`list_docs` walks the focused pane's live cwd for markdown,
README-first, bounded depth/count; `read_doc` reads one file, capped at 2 MiB). `DocsPanel.tsx`
mirrors `GitPanel.tsx`: a file list + a plain-text reader with the same drag-select gesture and
selection tint; the selection is sent as **raw markdown** (`rel:lines` + a ```markdown fence` +
optional instruction) via bracketed paste. A **"to targets"** toggle fans the passage to
`broadcastTargets(ws)` instead of just the focused pane ("all of you read this") *(the broadcast bar has since been removed 2026-06-25; `broadcastTargets(ws)` now resolves to all live panes for the `th broadcast` path)*; **"Open file…"**
uses the native dialog for files outside the folder. Opened from the title bar's 📖 **Docs** button,
the command palette, or **Ctrl+Shift+R** (new `docs` keybinding action). — **Removed 2026-06-29 (see [ADR-0008](adr/0008-narrow-to-terminal-loom-owns-ade.md)); the docs reader is now owned by the companion app "loom". Notes below are kept as history.**

A **Raw / Preview** toggle (persisted as `settings.docsPreview`) now covers *both* rendering
options: Raw is the line-precise grid; Preview renders the markdown where each block carries its
**source line range**, so block drag-select still reconstructs and sends the *raw* markdown — the
"selection maps back to source lines" path the open question called the nicer-but-more-work option.

**Upgraded 2026-06-25** (in-use feedback — see `docs/ASSESSMENT.md`): the original Preview used a
~140-line homegrown parser that couldn't do tables or nested lists and rendered every soft newline
as a `<br>` (prose came out as a ragged column). Preview now renders via **markdown-it** (the one
runtime parsing dependency we've taken — a deliberate break from the "small purpose-built parser"
habit, justified in `lib/markdown.ts`): real CommonMark + tables, strikethrough, nested lists, and
proper soft-wrap reflow. The source-line mapping survives because markdown-it block tokens expose a
`.map` line range. Same pass also fixed three usability complaints: the panel **stays open after a
send** (was closing — bad for the iterative "read a doc, send passages while discussing" loop) and
flashes a "sent ✓" instead; a **fuzzy filter box** + arrow-key/Enter nav over the file list (Esc
peels back filter → selection → close); a **📂 change-folder button** so the scanned root can be
re-pointed (it used to pin at first-open with no way to change it); and the Rust walk now descends
**4 levels** (was 2) so deeper docs show up.

---

## Tier 2 — workspace & layout polish

### 5. Presets capture the real layout  🟡 ✅ shipped
Today a `Preset` stores `cwd` + `paneCount` + `commands` (`stores/workspace.ts`) — **not** the
tree shape, gutter ratios, or per-pane cwd. So a relaunched preset rebuilds a *balanced* grid,
losing any hand-tuned splits. Make "Save as preset" snapshot the actual `LayoutNode` tree (and the
per-pane `cwd` we added to the launcher) so relaunch is faithful.

*(Known gap, noted when we added the launcher's per-pane cwd — that override currently can't round-trip through a preset.)*

**✅ Built as:** `Preset` now carries a deep-copied `tree` + `panes` snapshot; `saveCurrentAsPreset`
records them, `launchPreset` rebuilds them verbatim via a new `NewWorkspaceOpts.tree/panes` path in
`buildWorkspace` (older presets without a tree still fall back to a balanced grid). The clone logic
is factored into `cloneTreeWithFreshPanes`, shared with `duplicateWorkspace` (#7) — both remap every
leaf to a fresh PaneId. The wizard tile shows "· layout" when a preset captured its shape.

### 6. Quick workspace switch (Ctrl+1…9)  🟢 ✅ shipped
You have prev/next (`switchWorkspaceRelative`, PageUp/PageDown). Add direct jumps to workspace N.
Register as keybinding actions (`lib/keybindings.ts`) so they show up in Settings and the global
fallback handler we just added.

**✅ Built as:** nine `switch-workspace-1…9` keybinding actions (default Ctrl+Shift+1…9) →
`switchWorkspaceIndex(n)`. The subtle bit: Ctrl+Shift+1 reports `e.key` as `"!"` (Shift transforms
the digit), so `SHIFT_FOLD` now maps `! @ # $ % ^ & * (` back to `1…9` — same mechanism as the
existing `+`/`_`/`<` folds. Wired into both dispatch maps (App global fallback + Terminal) via the
exported `SWITCH_WORKSPACE_ACTIONS`. Covered by `keybindings.test.ts`.

### 7. Duplicate workspace  🟢 ✅ shipped
Clone the active workspace's tree + per-pane commands/cwd into a fresh workspace (fresh PaneIds,
fresh PTYs). One rail action; reuses `buildWorkspace`-style construction.

**✅ Built as:** `duplicateWorkspace(id)` (`stores/workspace.ts`) deep-clones the split tree
(preserving `dir`/`ratio`), remaps every leaf to a fresh `PaneId`, copies each `PaneSpec`
(command/cwd/env/title, env deep-copied), names it "<name> copy", and makes it active — panes
respawn like any launch. Triggered by a ⧉ button on each rail row.

### 8. Drag-to-reorder panes in overview  🟡 ✅ shipped
`swapLeaves` already exists (`lib/layout.ts`) and powers programmatic swaps. Wire it to
drag-and-drop between tiles in overview mode (`overview-hit` overlay in `LayoutNode.tsx`).

**✅ Built as:** the `.overview-hit` tiles are now `draggable` with the same `text/plain` PaneId
dataTransfer protocol as the in-grid pane grip; dropping one tile on another calls `swapPanes`
(→ `swapLeaves`) and the overview re-tiles from the new leaf order. A `drag-over` highlight marks
the drop target.

---

## Tier 3 — observability & onboarding

### 9. Keybinding cheat-sheet overlay (`?`)  🟢 ✅ shipped
A visible shortcut map (read straight from `ACTIONS` in `lib/keybindings.ts`, so it stays in sync
and shows live rebinds). Complements the command palette and aids discovery — would have surfaced
the focus-vs-no-focus shortcut gap on its own.

**✅ Built as:** `ShortcutsOverlay.tsx` — a read-only modal that derives its groups straight from
`ACTIONS` and renders live keys via `formatBinding(settings.keybindings[id])`, so rebinds and new
actions show automatically. Flows into balanced columns. Opened from the title bar's ⌨ button, the
command palette, or **Ctrl+Shift+?** (new `shortcuts` action).

### 10. Session-log viewer  🟡 ✅ shipped
`sessionLog.ts` already writes per-pane raw output to disk (opt-in, `settings.sessionLogging`).
Add a small in-app reader/tail to review what an agent did without re-running it. This is the
natural on-ramp to the deferred searchable-scrollback / SQLite idea (PLAN "Out of scope").

**✅ Built as:** Rust `logs.rs` (`list_logs` lists the logs dir newest-first; `read_log_tail` tails
the last N bytes so multi-MB logs stay responsive, confined to the logs dir). `SessionLogViewer.tsx`
(mirrors the Git/Docs panels) lists logs + shows the selected tail, with raw terminal escapes run
through a new `lib/ansi.ts` `stripAnsi` (tested) so it reads as plain text. Opened from a pane's ≣
title-bar button (preselects that pane's log) or the command palette.

### 11. Per-agent border tint  🟢 ✅ shipped
Agent defs carry colors (`lib/agents.ts`). Tint each pane's focus ring / title bar by its detected
agent so a mixed fleet (Claude vs Codex vs Gemini) reads at a glance — and so overview tiles are
colour-coded by agent.

**✅ Built as:** when `agent()` resolves, `Terminal.tsx` sets `--agent-color` on the pane root and
an `agented` class. CSS tints the focused border + title stripe with the agent colour and shows a
subtle always-on title stripe at rest (so overview tiles read by agent) — gated with `:not(.attention)`
so the amber "needs you" signal always wins. The agent badge already carried the colour; this extends
it to the whole pane.

---

## Bigger bets (post-v1 — flagged out-of-scope in PLAN)

- **System tray + global hotkey** to summon/hide the window. 🔴 ✅ shipped — a tray icon
  (`src-tauri/src/tray.rs`, behind tauri's `tray-icon` feature) with a Show/Hide + Quit menu;
  left-click toggles the window. A configurable global hotkey (`settings.globalHotkey`, default
  `Ctrl+Alt+`` `) registered from TS via `tauri-plugin-global-shortcut` summons/hides from
  anywhere. An opt-in `settings.closeToTray` makes the close button hide instead of quit (tray
  "Quit" emits `termhaus://quit` so the frontend flushes state first, like the close path).
- **Multi-window / tear-off panes** — currently a pane lives in one workspace in one window. 🔴 ✅ shipped
  — the ◳ title-bar button tears a pane into its own window.
  The PTY never moves (stays in the Rust process by handle, ADR-0002); a new `pty_retarget` command
  swaps its output Channel (`pty.rs` sink behind `Arc<Mutex<Channel>>`) to the new `WebviewWindow`,
  which renders a single xterm (`DetachedPane.tsx`, entry branches on `?detach=` in `index.tsx`).
  The main grid shows a placeholder (`lib/detach.ts` state machine); closing the window re-docks the
  pane — the main `Terminal.start()` rebinds to the same handle (no respawn), gated so the detach
  unmount doesn't kill the child. A detached pane stays reachable from the main window's broadcast /
  `th send` (the placeholder keeps a handle-routed registry entry); only scrollback `th read` is
  unavailable while detached (its xterm lives in the other window).
  **Scrollback handoff (added 2026-06-13):** `retargetPty` only moves the *live* stream, so a torn-off
  (or re-docked) pane used to open blank — the painted history lives in the xterm buffer, not the PTY
  (a full-screen TUI like `top` survived only because it repaints). Fixed with `@xterm/addon-serialize`
  + `lib/scrollback.ts`: the source window serializes its buffer and the destination replays it before
  the live stream resumes, handed off via same-origin `localStorage` (all-TS, no Rust change). "Bring it
  back" now uses a graceful `window.close()` (not `destroy()`) so the close handler stashes first.
  **Live-verified on Linux 2026-06-13:** tear-off, re-dock via "Bring it back", and re-dock via the
  window ✕ all preserve scrollback; `top`-style live sessions transfer cleanly.
- **Right-side browser / preview panel** — the dropped reference-app feature (localhost/docs
  preview); users currently alt-tab to a real browser. 🔴 ✅ shipped, then ❌ **removed (2026-06-25)** —
  an embedded `<iframe>` browser was scope creep for a terminal multiplexer (a real browser is one
  Alt-Tab away, and sites that refuse framing wouldn't load inline anyway). `PreviewPanel.tsx`, the
  `preview` keybinding/nav item, and `settings.previewUrl`/`previewWidth` were all deleted. The
  docked-panel slot (a flex sibling of the stage that shrinks the grid) remains, shared by Source
  Control and Docs.

---

## Agent integration — the north star

How should an AI CLI agent and Termhaus integrate more deeply? The seam already exists: the
ADR-0007 control bus. Each pane's child gets `TERMHAUS_SOCK` / `TERMHAUS_PANE` / `TERMHAUS_CLI`
injected and the `th` CLI on `PATH`; `th` → unix socket → Rust pure relay → TS routing
(`paneControl.ts`). So "middleware" isn't a new architecture — it's **bridging an agent's native
extension points to that bus**. Three shapes, worst → best:

### A. PTY output-scraping proxy 🔴 — don't
Launch `th-wrap claude` instead of `claude`; the wrapper owns the PTY, passes I/O through, and
*watches the stream* to translate "agent is waiting" → `th attention`. Technically real middleware,
but it means parsing ANSI/TUI redraws — fragile, agent-version-specific, and it re-introduces
exactly the brittleness ADR-0001 (opaque panes) exists to avoid. Only if an agent has no hooks/MCP.

### B. Adapter via the agent's own hooks 🟢 — cheap, robust ✅ shipped (Claude Code)
Most capable CLIs fire lifecycle events without any output parsing (Claude Code, e.g., has a
"needs attention/permission" notification event and a "finished" stop event). Ship a tiny config
that points those at `th`:
- needs-input event → `th attention` (raises the amber border)
- finished event → `th attention --clear` / `th status "done"`

The agent *pushes* its own state through the channel you already built. Per-agent, ~10 lines of
config each. This is the natural partner to #1 (needs-input broadcast) and #3 (agent status).

**✅ Built as:** a `th hooks` subcommand (a *local* helper — no socket round-trip) that prints the
recommended Claude Code profile, or `--install [--user|--project]` merges it idempotently into the
right `.claude/settings.json` (preserving other keys/hooks). The profile wires `Notification` →
`th attention` (#1), `UserPromptSubmit` → `th status working` + `Stop` → `th status` (clears) (#3).
It's conflict-free by design: `Notification` owns `attention` (cleared by focusing the pane, so no
`Stop --clear` to race the idle notification); the prompt/stop pair owns `status`. See
[agent-hooks.md](agent-hooks.md). Next along the arc is **C** — the same handlers behind an MCP server.

### C. A Termhaus MCP server 🟡 — the model-native one ✅ shipped
Expose the `ControlRequest` set (`list/send/spawn/broadcast/read/focus/attention/status`) as an
**MCP server** the agent connects to. The agent gets first-class *tools* — "spawn a pane",
"broadcast to the reviewers group", "flag myself blocked" — instead of shelling out to `th`.
Mechanically a thin re-skin: the MCP tool handlers call the same relay the `th` CLI does, so the
`th` CLI and the MCP server become two front-ends to one bus.

**✅ Built as:** a `th-mcp` binary — a hand-rolled stdio MCP server (newline-delimited JSON-RPC,
pure std + serde_json, no SDK) exposing the eight ops as tools (`list_panes`, `send_text`,
`spawn_pane`, `read_pane`, `broadcast`, `focus_pane`, `flag_attention`, `set_status`). The socket
relay is factored into `src/control_sock.rs`, shared with `th` via `#[path]` so the two bins are
literally two faces of one relay. `flag_attention`/`set_status` default to the agent's own pane
(`$TERMHAUS_PANE`). `th-mcp` ships beside `th` (its dir is already on each pane's `PATH`) and its
absolute path is exposed as `$TERMHAUS_MCP`. Register with `claude mcp add --transport stdio
termhaus -- th-mcp`. See [agent-mcp.md](agent-mcp.md). The hook adapter (B) stays for the
blocked-agent moments MCP structurally can't see — that's the "permanent sliver of hooks" below.

### The decision: MCP-core, with a permanent sliver of hooks

**Ignoring effort, C (MCP) is the destination** — but the mature design is *MCP-core + a thin hook
layer that never goes away*. The reasoning:

- **Hooks signal; MCP acts.** Hooks are one-directional lifecycle pings. MCP is a bidirectional
  *action* surface. Orchestrating a fleet needs verbs, not just status — that's MCP.
- **MCP lives in the model's reasoning**, not bolted on outside it: the capabilities appear in the
  agent's tool list, so the model *plans with* Termhaus ("spawn a pane to run tests while I edit").
  Hooks are invisible to the model — external side-effects in a settings file.
- **MCP isn't gated by a vendor's hook taxonomy** and is cross-agent (one server serves every
  MCP-capable agent; hook formats are bespoke per CLI).
- **But MCP structurally can't see a *blocked* agent.** An agent waiting on stdin makes no tool
  calls — that state is the absence of activity, not an action. The "needs your input" / "finished"
  liminal moments live outside the tool-call loop. Hooks (notification/stop) capture exactly those,
  for free, no output parsing. So a minimal hook adapter stays forever to cover that gap.

**Sequencing toward it:** prove the *flows* (#1 needs-input broadcast, #3 agent status) over the
trivial hook adapter (B) first; then lift the whole capability set into the MCP server (C) once the
flows are validated — same handlers, richer face. Keep Rust a pure relay throughout (ADR-0007).

---

## Recommendation

Start with **#1 (needs-input broadcast)**: highest value per line, it's the workflow the whole app
is built around, and it's mostly connecting primitives that already shipped. **#2 (saved groups)**
and **#3 (agent status)** compound on it to make overview a genuine fleet console.

**#4 (docs reader → send to a pane)** is the strongest *standalone* next feature: it mirrors the
already-shipped Source Control send-to-terminal flow almost verbatim, so it's low-risk, and it
directly serves "drive an agent with context" — open a spec, mark a section, hand it to Claude.

Strategically, the **Agent integration north star** (above) is the bigger arc: ship the hook
adapter (B) to validate #1/#3, then grow it into the MCP server (C) as the deep, model-native
integration. The Tier-1 ideas are the concrete first steps along that path.
