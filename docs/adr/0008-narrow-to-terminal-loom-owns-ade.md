# Narrow Termhaus to the terminal layer; the ADE role moves to "loom"

Termhaus started as a Linux-first "control room" of real terminals and accreted a couple of
IDE-adjacent side panels along the way: a **Git (Source Control)** panel (`git.rs`,
`GitPanel.tsx`, `gitClient.ts`) with a file list + unified-diff viewer + send-to-pane, and a
**Docs reader** (`docs.rs`, `DocsPanel.tsx`, `markdown.ts`) that browsed and previewed
markdown to send passages to a pane. A companion app — **loom** — now owns the agentic
development environment (ADE): git, code, and docs context live there, and it does that job
better than two bolted-on panels ever did inside a terminal multiplexer.

Keeping git/docs in Termhaus blurred the product line, duplicated loom, and pulled the app
away from its actual thesis. ADR-0001 already says panes are opaque and Termhaus has no
agent-awareness; a diff viewer and a markdown reader were the most "IDE-in-a-terminal"
features and the clearest things to shed.

## Decision

**Termhaus is the terminal layer. loom owns the ADE role. The Git panel and the Docs reader
are removed (2026-06-29).**

Removed: `src-tauri/src/git.rs`, `src-tauri/src/docs.rs`; `GitPanel.tsx`, `DocsPanel.tsx`,
`gitClient.ts`, `docsClient.ts`, `markdown.ts` (+ their tests); the `markdown-it` /
`@types/markdown-it` npm deps; the `git_status`/`git_branch`/`git_diff`/`list_docs`/`read_doc`
Tauri commands; the `source-control` and `docs` keybindings/actions; the Git/Docs top-bar nav
buttons and command-palette entries; and the **per-pane git-branch badge** in each pane's
title bar (it depended on the now-removed `git_branch`).

Because the two panels were the *only* members of `DockedPanelKind`, the entire docked
right-side-panel system collapsed: `DockedPanelKind`, `DockedPanelState`, the per-workspace
`panel` field, and `activePanel`/`setActivePanel`/`setPanelCwd` are all gone. The
`SessionLogViewer` is unaffected — it renders as its own overlay and only *reuses* the legacy
`.git-*` CSS list/diff classes, which are retained for it.

## What stays

- **The session-log viewer** — it's about terminal *output*, Termhaus's own domain, not ADE
  overlap.
- **The inter-pane control bus** (`th` / `th-mcp`, ADR-0007) and `th broadcast` — this is the
  "drive a fleet of agents" thesis, not an IDE feature.
- **`pty_cwd`** — still used for the title-bar cwd and the agent badge; ADR-0001's `/proc`
  cwd carve-out is unchanged. Only the git-branch derivation built on top of it is gone.

## Consequences

- Termhaus's surface area shrinks toward "the best resizable PTY grid + workspace rail for
  driving fleets of CLI agents." Less to maintain, a sharper line against loom.
- Persisted `workspace.json` from before this change may carry a now-ignored `panel` field per
  workspace; it is silently dropped on load (the loader rebuilds ephemeral UI state). No
  migration needed.
- If git/diff or docs context is wanted again, it belongs in loom (or as a pane running a CLI
  like `lazygit`/`git`), not as a Termhaus panel — panes stay opaque (ADR-0001).
