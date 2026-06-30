# Termhaus — What to Add or Remove

Notes for discussion. My honest read after going through the whole app.

## The headline

This is a _finished_ product, not a half-built one. M0–M11 plus the entire
IDEAS.md roadmap shipped, zero TODOs/FIXMEs/dead code, clean Rust↔TS separation.
So the real question isn't "what's missing" — it's **"what's diluting the core
thesis vs. strengthening it."** The thesis is sharp: _a control room for driving
fleets of CLI agents._ I judge everything against that.

## What I'd consider removing (or at least questioning)

The biggest risk here is **feature sprawl** — a few things are mini-apps bolted
onto a terminal multiplexer, and each one is a maintenance surface that competes
with a better tool the user could just run _in a pane_:

- ~~**PreviewPanel** (iframe web preview) — The weakest fit. A terminal
  multiplexer embedding a browser pane is scope creep; anyone wanting a live
  preview has a real browser one Alt-Tab away.~~ ✅ **Removed 2026-06-25** —
  component, `preview` keybinding/nav item, and `settings.previewUrl`/
  `previewWidth` deleted; tests + typecheck green.
- **DocsPanel** — A markdown reader competes directly with `glow`/`bat` in a pane.
  Its _one_ justification is "drag-select lines → send to a pane" for feeding
  agent context. **The user confirmed they use exactly this workflow** (write a
  doc, discuss it with an agent), so it stays — and got fixed up **2026-06-25**:
  - ✅ Preview now renders via **markdown-it** (real CommonMark + tables, nested
    lists, strikethrough, soft-wrap reflow) instead of the old ~140-line homegrown
    parser. Source-line mapping preserved via markdown-it token `.map`. _(One new
    runtime dep — a deliberate break from the "small parser, no deps" habit,
    justified in `lib/markdown.ts`.)_
  - ✅ **Stays open after a send** (was closing mid-conversation) + "sent ✓" flash.
  - ✅ **Fuzzy filter box** + arrow/Enter nav over the file list; Esc peels back
    filter → selection → close.
  - ✅ **📂 change-folder button** to re-point the scanned root (was pinned at
    first-open with no way to change it).
  - ✅ Rust walk descends **4 levels** (was 2) so deeper docs appear.
  - **Removed 2026-06-29** (see [ADR-0008](adr/0008-narrow-to-terminal-loom-owns-ade.md)) — the markdown reader now lives in the companion app "loom"; Termhaus narrows to the terminal multiplexer. Notes above are kept as history.
- ~~**GitPanel** (read-only) — Genuinely useful, but read-only git competes with
  `lazygit` in a pane, which does vastly more.~~ **Kept and deepened 2026-06-25.**
  The "send a diff region to the agent" gesture is precisely what `lazygit`
  _can't_ do, and it's the user's pre-commit-review workflow (review the diff,
  send comments, then tell the agent to commit). Rather than broaden toward a git
  client (staging/commit stays with the agent), the review gesture got deepened:
  - ✅ **Stays open after a send** (was closing) + flash — review is iterative.
  - ✅ **Review-note field** — type a comment that rides along with the diff, so
    the agent gets your question with the code instead of a bare diff.
  - ✅ **Click a hunk header to select the whole hunk**; **＋ file / Send file**
    for the whole open file.
  - ✅ **Review queue** — ＋ queues comments; a review bar lists them as removable
    chips and **Send review ▸** sends them all as one numbered message.
  - Still strictly read-only.
  - **Removed 2026-06-29** (see [ADR-0008](adr/0008-narrow-to-terminal-loom-owns-ade.md)) — read-only git review now lives in the companion app "loom"; Termhaus narrows to the terminal multiplexer. Notes above are kept as history.

I'm not saying delete all three — I'm saying each one needs to earn its keep via
a workflow that a pane _can't_ do, and right now that workflow is "drag text into
a pane." If that's load-bearing, keep them; if it's not getting used, they're
dead weight that blurs the product.

## What I'd consider adding (all reinforce the core thesis)

- **Cross-pane / cross-workspace session-log search.** Logs today are opt-in,
  ANSI-stripped, tail-only, per-pane. The single highest-value fleet feature you
  _don't_ have is "grep everything my 12 agents did in the last hour." This is
  the natural place SQLite finally earns its way in (PLAN.md already flags it as
  the trigger condition). This is the one I'd build first.
- **An agent-lifecycle timeline / fleet dashboard.** You have all the signals
  already (busy, attention, status, bell) but they live as per-pane dots. A
  compact "what is every agent doing right now, and which ones have been
  idle/waiting longest" strip would make the fleet thesis _visible_. Cheap to
  build on existing state, high payoff.
- ~~**Broadcast that crosses workspaces.**~~ **Resolved by removal, 2026-06-25.**
  The user never used the human broadcast bar, and their multi-agent work is
  cross-_project_ (separate workspaces) — which the single-workspace bar never
  served anyway. So instead of extending broadcast across workspaces, we **removed
  the human bar entirely** (and its targeting/groups/snippets/history/stagger, the
  per-pane ◉/○ toggle, and the now-orphaned glob matchers). The agent-facing
  fan-out is kept: `th broadcast` / the `th-mcp` `broadcast` tool still fan a
  prompt to every pane in a workspace via the control bus (ADR-0007), so one agent
  can still drive the fleet. Net −~600 lines; bundle −3.4KB gzip.

## What I would _not_ touch

The core engine — `pty.rs` coalescing/back-pressure, the layout tree, the control
bus relay, the opaque-panes rule. That's the part that's genuinely hard and
genuinely right. Don't let anyone "optimize" base64→raw-byte transport unless a
flood actually regresses; ADR-0003 already says it holds.
