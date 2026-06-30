# Frameless redesign — implementation plan

Recreate the **Frameless** chrome redesign (`docs/design_handoff_termhaus_frameless/`) in the
live SolidJS frontend. This is a **visual/chrome refactor**, not a rebuild: every surface the
design covers already exists as a component. We re-skin the token layer, restructure the pane
card (the one real structural change), and tune each surface to the spec.

> **Progress:** ✅ Phases 0–7 landed at the code level (tokens · pane card · top bar + rail ·
> broadcast + empty state · fleet tint · side panels → docked · palette + Settings-surface +
> overlay motion · modal-dialog unification + motion). Each is build-clean, typecheck-clean,
> tests-green. **Remaining: (1) the human visual QA sweep in `npm run tauri dev` across all 4
> themes — never run headless here; (2) the deferred launcher two-column WHERE/WHAT-RUNS rebuild
> (currently restyled, not restructured).**

> **Stack note.** The handoff README says "React + TypeScript". The real app is **SolidJS +
> Tauri + WebKitGTK**. We follow the README's explicit instruction — _recreate the design in the
> existing codebase, do not port the HTML_ — using Solid components, `data-theme` tokens, and the
> stores. `support.js` is reference-runtime only and is never touched.

## Hard constraints (carried from CLAUDE.md / ADR-0001)

- **Panes are opaque.** Every change is chrome _around_ xterm; never parse or restyle terminal
  bytes. The chip/state/tint all derive from existing metadata (`activity` store, `PaneSpec`,
  git branch), never from pane output.
- **Two levels only:** Workspace → Pane. No tabs, no windows-layer.
- **No product logic in Rust.** This redesign is 100% frontend (TS/CSS/Solid). No `src-tauri`
  changes.
- **Don't regress PTY coalescing/back-pressure.** We don't touch `pty.rs` or `ptyClient.ts`
  transport.

## Current → target gap (what actually changes)

| Surface        | Component(s)                                        | Change                                                                                                                                                            |
| -------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token layer    | `src/App.css` `:root` + 3 theme blocks              | Add/rename the Frameless token set; re-value existing tokens                                                                                                      |
| **Pane card**  | `Terminal.tsx`, `LayoutNode.tsx`, CSS               | **Structural:** replace full-width `.pane-title` with a floating glass **chip** (top-left) + hover `.pctl` controls (top-right); content padding `52px 20px 18px` |
| Pane states    | `Terminal.tsx` + `stores/activity.ts`               | working/idle/needs-you/dead → dot + ring + chip-border + label per state table                                                                                    |
| Top bar        | `TitleBar.tsx`                                      | Re-skin to 50px; active nav item reflects current surface; window controls restyle                                                                                |
| Workspace rail | `WorkspaceRail.tsx`                                 | 212px, 44px rows r12, accent-gradient active fill, hover `.wsact`, dashed **New** row, footer avatar                                                              |
| Broadcast bar  | `BroadcastBar.tsx`                                  | Detached floating bar (54px r15), toggle pill, targets chip + dropdown, Send; hidden on empty ws                                                                  |
| Fleet tint     | `LayoutNode.tsx` overview + `Terminal.tsx` chip     | Per-group 2nd tint dot + group inset border; compact chip                                                                                                         |
| Empty state    | new `EmptyWorkspace.tsx` (or in `LayoutNode`)       | Scratch first-run column; broadcast bar hidden                                                                                                                    |
| Side panels    | `GitPanel.tsx`, `PreviewPanel.tsx`, `DocsPanel.tsx` | Floating cards, fixed px widths, panel shadow, grid reflows to 1 col                                                                                              |
| Palette        | `CommandPalette.tsx`                                | 640px card r16, `ACTIONS`/`GO TO PANE` sections, accent-gradient selected row                                                                                     |
| Launcher       | `NewWorkspaceWizard.tsx`                            | 880px r18 two-column WHERE/WHAT-RUNS, layout tiles + slider, fleet row, preview grid                                                                              |
| Settings       | `Settings.tsx`                                      | Appearance (theme swatches + terminal group) / Key bindings tabs; live theme apply                                                                                |
| Overlay motion | `App.css`                                           | `ovin` keyframe, scrim blur(2px), pulse + cursor-blink keyframes                                                                                                  |

Everything below references real files. Nothing here adds a new dependency.

---

## Phase 0 — Design tokens (foundation, do first)

All later phases consume these. Land this phase alone and verify all 4 themes still render before
touching components.

**File:** `src/App.css` `:root` + `[data-theme='light'|'midnight'|'paper']`.

1. **Add the Frameless tokens** (names the design uses; some are new, some re-value existing):
   `--canvas`, `--surface`, `--surface-dead`, `--text-bright`, `--text-mid`, `--text-dim`,
   `--text-faint`, `--accent`, `--accent-text`, `--accent-rgb`, `--well`, `--chip`,
   `--chip-border`, `--hairline`, `--tint-weak`. Use the exact hex/rgba from the README theme
   table (§Themes) for all four themes.
2. **Bridge, don't break.** The codebase uses `--bg`, `--fg`, `--fg-muted`, `--border`,
   `--surface-hover`, etc. across 2700 lines of CSS. Map old → new as aliases in each theme block
   (e.g. `--bg: var(--canvas)`, `--fg: var(--text-bright)`, `--fg-muted: var(--text-mid)`,
   `--border: var(--hairline)`) so untouched components keep working while we migrate surfaces one
   by one. Remove aliases only once a surface fully adopts the new names.
3. **Derived values** as documented helpers (comments, since CSS can't compute gradients into a
   var cleanly): active/broadcast/selected fill =
   `linear-gradient(90deg, rgba(var(--accent-rgb),.16), rgba(var(--accent-rgb),.03))`; target chip
   bg = `rgba(var(--accent-rgb),.14)`. Define `--accent-rgb` per theme so all alpha uses are
   single-sourced.
4. **State color tokens** (constant meaning across themes, but light/dark variants):
   `--state-working`, `--state-idle`, `--state-needs`, `--state-dead` per the State-colors table.
5. **Type + shadow tokens:** pane shadow, focus ring (dark vs light variants), broadcast-bar
   shadow, side-panel shadow, overlay-card shadow, scrim. Encode the **light-theme rule**: on
   `light`/`paper`, focus ring = solid `1.5px` accent stroke, **no blur halo**, and **no live-dot
   glow** (drop `box-shadow` glow, keep solid dot).

**xterm palette parity:** the terminal palettes live in `src/lib/theme.ts` (driven by
`currentTheme()`). The accent/canvas re-values above are chrome-only; confirm the xterm bg still
matches `--surface` per theme so panes don't seam against their card. Adjust `lib/theme.ts`
background entries only if they visibly differ from the new `--surface`.

**Verify:** `npm run tauri dev`, cycle all 4 themes in Settings, confirm no contrast regressions
and no unstyled (default-black) surfaces.

---

## Phase 1 — Pane card (the structural change)

This is the only phase that changes DOM, not just CSS. **Files:** `Terminal.tsx` (chrome JSX),
`App.css` (`.pane*`).

Today (`Terminal.tsx:558`) a full-width `.pane-title` bar holds name + branch + status + a row of
controls. Frameless replaces it with:

- **Floating chip, top-left** (`offset top 13px / left 14px`, `padding 6px 12px`, r999,
  `--chip` bg, `backdrop-filter: blur(8px)`, `inset 0 0 0 1px var(--chip-border)`): state dot
  (6px, pulsing if live) + pane name (mono 12/600) + branch (`⎇ main`) or status word in state
  color. Fleet variant compact: `padding 4px 9px`, name 10.5.
- **Hover controls, top-right** (`.pctl`, opacity 0→1 over .12s; honor the existing
  "always show controls" setting → force opacity 1): `✦ ⌕ ▥ ▤ ⤢ ◳ ✕` (keep current actions —
  launch/find/split-right/split-down/zoom/detach/close). Dead pane shows `↻ restart  ✕`.
- **Content padding** moves to the term wrap: `52px 20px 18px` so text clears the chip.
- **Card:** `--surface`, r14 (fleet r12), `overflow:hidden`, state-dependent box-shadow.

**State treatments** (drive off `activity` store + `dead()` signal already in `Terminal.tsx`):

- working → pulsing green dot.
- idle → static grey dot.
- needs-you → amber dot + pane ring `0 0 0 1px rgba(200,146,68,.5)` + chip border
  `rgba(200,146,68,.32)` + "needs you" label.
- dead → hollow dot, `--surface-dead` bg, `inset 0 0 0 1px var(--hairline)`, shows `exited · N`
  - `↻ restart`. (Reuse the existing `.pane-dead` overlay logic at `Terminal.tsx:665`; restyle.)
- focused → accent focus ring (dark: glow per shadow table; light/paper: solid 1.5px stroke).

**Keep intact:** the flat absolutely-positioned leaf layer in `LayoutNode.tsx` (PTY survival),
the search bar (`.pane-search`), fit/resize observer, detached-placeholder fallback. The chip is
purely additive markup inside the existing `.pane` root — do not reparent the terminal container.

**Verify:** split/close/zoom keep PTYs alive; chip never overlaps content; all 4 states render;
controls reveal on hover and respect the always-show setting.

---

## Phase 2 — Top bar + workspace rail

**TitleBar.tsx** (already has the nav + window controls — re-skin only):

- 50px height, transparent over `--canvas`, `padding 0 18px`. Brand = 17px radial-gradient mark +
  "Termhaus" (14.5/600); click → Overview.
- Nav `gap 24px`, 13px: Overview · Palette · Git · Preview · Docs · Settings. **Active item
  reflects current surface** — wire `panel`/`overlay`/`settings`/`overview` state in from `App.tsx`
  so Git/Preview/Docs highlight when open, Palette when its overlay is open, Settings on settings,
  else Overview. (Today only Overview reflects state.) Pass the open-flags down as props.
- Window controls restyle to the spec glyph sizes/colors.

**WorkspaceRail.tsx:**

- 212px width. `WORKSPACES` mono label + `+` (24px r7) → launcher.
- Rows 44px r12 `gap 11px` `padding 0 14px`: live dot + name (13.5/500) + mono count badge.
  Hover bg `--tint-weak`; active = accent-gradient fill + bright name + `--accent-text` count +
  glowing dot (dark only). Inline duplicate/✕ (`.wsact`) fade in on hover.
- Dashed/tinted **New** row (r12, `--tint-weak`) → launcher.
- Footer: 24px avatar + `lozymon` mono `--text-faint`, pinned bottom (`margin-top:auto`).

**Verify:** switching rails swaps grid + returns to Overview; active nav highlight tracks
panel/overlay/settings/overview correctly.

---

## Phase 3 — Broadcast bar + empty state

**BroadcastBar.tsx:**

- Detached floating bar: 54px r15, `--surface`, bar shadow, `padding 0 8px 0 16px`, `gap 14`.
  Sits in the stage's bottom margin (not flush to grid).
- Toggle pill (32×18, accent when on) + "Broadcast" label · hairline divider · prompt hint
  `Type a prompt → <scope hint>…` (mono `--text-faint`) · **Targets chip** (`⌖ <label> ▾`,
  accent-text on `rgba(var(--accent-rgb),.14)`, r999) · **Send** (accent, white, r11).
- **Targets dropdown** (absolute, above bar, 236px, `--surface`, panel shadow, r12): rows
  All live panes / Group: <name> / Current pane; selected row accent-gradient; selecting updates
  chip label + hint, closes menu (stop-propagation so document click closes it). Map scope to the
  existing broadcast routing in `stores/workspace.ts` (`broadcast` state).
- **Hidden on empty workspaces** (pane count 0).

**Empty / Scratch state** (new `EmptyWorkspace.tsx`, rendered by `LayoutNode`/`App` when the active
ws has 0 panes): centered 360px column — 62px dashed icon with 2×2 glyph, "No panes yet" (18/600),
helper line, primary **Choose a layout** (accent r11) → launcher, secondary **Split a pane**
(inset hairline), mono hint `or press Ctrl+Shift+D`.

**Verify:** broadcast still types into N panes; bar hides at 0 panes; dropdown scope changes label.

---

## Phase 4 — Fleet tint (per-agent grouping)

**Files:** `LayoutNode.tsx` (overview/fleet grid) + the chip in `Terminal.tsx`.

- Fleet grid: existing overview reflow already tiles uniformly. Apply compact chip + r12 tiles +
  `gap 11`.
- **Per-agent tint:** group panes by command/agent (derive from `PaneSpec.command` /agent name).
  Each tile's chip carries a **2nd 5px dot** in the group tint + a faint group-colored inset
  border `inset 0 0 0 1px <tint>33`. A tiny uppercase status label top-right
  (`WORKING/IDLE/NEEDS YOU/EXITED·1`). **State stays primary; tint is secondary.** Focused tile
  still gets the accent ring; dead/needs keep their state treatments.
- Tint palette: reuse/extend the existing per-agent tint logic if present (CLAUDE.md mentions
  "per-agent tint" already shipped) — confirm in `stores/` before adding a parallel system.

**Verify:** 12-pane fleet groups read clearly; tint never overrides state signal.

---

## Phase 5 — Side panels (Git / Preview / Docs)

> **Note — Git and Docs panels removed 2026-06-29** (see [ADR-0008](adr/0008-narrow-to-terminal-loom-owns-ade.md)); the ADE role now lives in the companion app "loom" (Preview was already removed 2026-06-25). This phase is kept as historical record.

**Files:** `GitPanel.tsx`, `PreviewPanel.tsx`, `DocsPanel.tsx` + `App.tsx` grid reflow.

- Each = floating card, `--surface`, r14, panel shadow. Widths: Git 440px, Preview/Docs 480px.
  **Grid reflows to single column** when a panel is open (today `PreviewPanel` docks; make Git/Docs
  consistent — they currently open as overlays per `App.tsx`). Decide dock vs overlay: spec says
  **dock right, never replace grid** → move Git/Docs to the same docked slot as Preview, with the
  stage columns collapsing to `1fr`. Toggling the active nav item closes it.
- **Git:** 46px header (Source Control + `⎇ main` + `↻` + `✕`); `CHANGES · N` list with M/A/D
  letters (M=amber, A=green, D=red) + mono paths, selected row `--tint-weak`; unified-diff viewer
  (mono 11.5) with added/removed line tints; footer hint `⌖ drag to select lines → send to
terminal` (keep existing drag-to-send).
- **Preview:** header reload + URL field in `--well` + pop-out + close; web-preview body.
- **Docs:** header + close; file tabs (active = accent-gradient pill); rendered-markdown body with
  mono code block in `--well`.

**Decided:** Git/Docs move to the **docked** slot (match spec). Today `App.tsx` opens them as full
overlays while only Preview docks — unify all three on the docked-right slot, stage columns
collapse to `1fr` when any is open, and toggling the active nav item closes it. The `panel`
state (`null | git | preview | docs`) becomes the single source for which panel is docked.

**Verify:** opening a panel reflows grid to 1 col; closing restores; drag-to-send still works.

---

## Phase 6 — Overlays: palette + launcher + settings

**CommandPalette.tsx:** 640px card r16, overlay shadow, scrim. Header `⌘` accent + mono search
line w/ blinking cursor + `esc` kbd chip. Sections `ACTIONS` / `GO TO PANE` (mono uppercase). Rows
r9 `gap 12`: icon + label (13.5) + right mono shortcut; first/selected row accent-gradient;
go-to-pane rows lead with a state dot.

**NewWorkspaceWizard.tsx → launcher:** 880px card r18. Left "WHERE" (380px): name field in
`--well` (accent inset ring), working-folder field + Browse + recents chips, Presets chips (active
= accent-gradient). Right "WHAT RUNS": Layout row + mini layout tiles (1/2/4/6, selected has accent
ring) + 1–16 slider, Fleet row in `--well` (Fill every pane with [agent ▾] + Apply to all),
interactive 2×2 preview grid. Footer `Ctrl+Shift+T` hint + Cancel + Create. Keep the existing
3-step Start→Layout→Agents wiring underneath; this restyles it into the two-column launcher.

**Settings → full-area surface (decided).** Promote Settings from an overlay to a full main-area
view per the spec's state model (`surface: overview | settings`): it replaces the grid (not a
scrim overlay), and the top-bar Settings nav item reflects it as active. Add a `surface` signal
alongside `overview` in `App.tsx`/`stores/workspace.ts`; opening Settings sets `surface=settings`,
Esc / clicking Overview returns to the grid. The card styling below still applies, just hosted in
the main area rather than over a scrim.

**Settings.tsx:** max-width 860 scroll column. Title 24/600. Tabs Appearance / Key bindings
(active = bright + 2px accent underline). Appearance→THEME: 4 live "Ab" swatch tiles, active ring
`0 0 0 2px accent`, click applies theme live (already wired via `setTheme`). Appearance→TERMINAL:
grouped card (font family / size slider / cursor style segmented / blink toggle / scrollback).
Key bindings: intro note + grouped FOCUS/PANES/WORKSPACES lists, each row action + mono kbd chip in
`--well`. Bindings come from `lib/keybindings.ts` / `stores/settings.ts`.

**Overlay motion** (`App.css`): `@keyframes ovin { from{opacity:0;transform:translateY(8px)
scale(.99)} to{opacity:1;transform:none} }` .16s ease-out; scrim fade .14s + `backdrop-filter:
blur(2px)`; close on scrim click / Esc (already wired); inner card stops propagation.

**Verify:** all overlays animate in, close on Esc/scrim, theme tiles repaint app instantly.

---

## Phase 7 — Motion, polish, cross-theme QA

- Keyframes in `App.css`: live-dot pulse `{0%,100%{opacity:1}50%{opacity:.4}}` 2.4s; cursor blink
  1.1s steps. Honor `prefers-reduced-motion` (disable pulse/blink) — not in spec but cheap and
  correct.
- Responsive: rail fixed width, grid is the existing fluid binary-split tree; panes have no min
  content width (gutter/chip padding constant). Side panels keep px width, grid yields.
- **Cross-theme sweep:** every surface in all 4 themes. Verify light/paper drop focus glow + dot
  glow. Verify accent is used _only_ for focus/active/live.
- Typography: load IBM Plex Sans/Mono _for parity check only_; ship with the app's configured mono
  stack (JetBrains/Cascadia) per the README's own note — don't hard-code Plex in production.

---

## Sequencing & risk

```
Phase 0 (tokens) ─┬─ Phase 1 (pane card)        ← biggest/structural, do early
                  ├─ Phase 2 (top bar + rail)
                  ├─ Phase 3 (broadcast + empty)
                  ├─ Phase 4 (fleet tint)        ← depends on Phase 1 chip
                  ├─ Phase 5 (side panels → dock)
                  └─ Phase 6 (overlays + Settings → surface)
                          └─ Phase 7 (motion + QA)
```

Phase 0 gates everything; ship it behind the alias bridge so nothing breaks mid-migration.
Phases 2/3/6 are independent re-skins (parallelizable). Phase 1 must precede Phase 4. Phases 5
and 6 each carry a small behavior change (Git/Docs → docked; Settings → full surface), both now
decided to match the spec.

**Risks / watch-items:**

- `App.css` is 2700 lines with the old token names threaded everywhere — the alias bridge in
  Phase 0 is what prevents a big-bang rewrite. Migrate names surface-by-surface.
- `backdrop-filter: blur()` under WebKitGTK can be flaky/perf-heavy — verify the glass chip blur
  renders acceptably; fall back to a solid `--chip` bg if it stutters (same pattern as the
  WebGL→canvas fallback in CLAUDE.md).
- Don't let the chip's `overflow:hidden` card clip the focus glow — glow needs to render outside
  the card bounds (use an outer ring element or `box-shadow` on the leaf box, not the clipped card).
- Keep xterm `term.write()` path and resize/fit untouched — chrome only.

## Out of scope (explicitly)

Rust/`src-tauri`, PTY transport, the `th`/`th-mcp` bus, persistence format, multi-window
tear-off behavior, the `.dc.html`/`support.js` runtime. Rail icon-collapse below ~1100px is a
future enhancement (not in mocks).

## Resolved decisions

1. **Git/Docs panels → docked right** (match spec). Unify all three side panels on the docked-right
   slot; stage reflows to 1 column when one is open. (Phase 5.)
2. **Settings → full-area surface** (match spec). Promote from overlay to a main-area `surface`
   that replaces the grid. (Phase 6.)

## Open questions

1. **Fonts in production:** parity-match with Plex during dev, ship with the configured mono stack
   — confirm that's the intended final (the README says so, but it's worth a nod).
