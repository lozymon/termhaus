# Panes are opaque; Termhaus is not agent-aware

The reference app (BridgeSpace) parses agent output to show per-pane status and token counts, and the project began life (pre-pivot) coupled to the Claude Agent SDK. For v1 we deliberately reject both: a Pane is an opaque PTY byte stream that Termhaus streams but never interprets, and an "agent" is nothing more than a Pane whose launch command is a CLI like `claude`. We chose this to keep the make-or-break PTY-throughput core simple, keep Rust thin, and avoid re-importing the bundled-CLI packaging risk we escaped by dropping the SDK.

## Consequences

- No token counters, no "busy/needs-approval" badges, no output parsing in v1 — the screenshot's agent overlays are out of scope.
- Agent-awareness, if ever wanted, must be a **separate layer that tails pane output**, never logic baked into the core PTY/pane model.
- No Claude Agent SDK dependency; the data model has no Agent/Session entity.

## Amendment (2026-06-06): live-cwd carve-out for Source Control

The Source Control panel (M8, a git diff viewer) needs to know *which folder* the focused
terminal is actually in. The original rule — restated in PLAN's persistence section as
"Termhaus does not read `/proc/<pid>/cwd`; panes stay opaque" — was written for **respawn**:
on relaunch we re-run a pane's command in its *launch* cwd, never the live wandered cwd, so
restored layouts are deterministic. That rule still holds for persistence.

We carve out one narrow exception: on an **explicit, user-triggered** Source Control open,
`pty_cwd(paneId)` reads `/proc/<shell-pid>/cwd` of the *focused* pane to scope `git` to where
you've `cd`'d. This stays within the spirit of opacity — it reads the kernel's process state,
**not** the pane's output byte stream (which is what "opaque" protects). No output is parsed;
nothing polls; it fires only on the panel action and falls back to the workspace folder when
the read fails (dead child, non-Linux). Output parsing for agent-awareness remains rejected.

**Update (2026-06-29):** the Source Control panel that originally motivated this carve-out was
removed (the ADE role now lives in the companion app "loom" — see
[ADR-0008](0008-narrow-to-terminal-loom-owns-ade.md)). The carve-out rationale above is kept as
record, and **`pty_cwd` is retained** — it still backs the title-bar cwd display and the agent
badge — so this narrow `/proc/<pid>/cwd` exception stands, just for those callers instead.
