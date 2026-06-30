// Normalized app store: a list of workspaces (the rail) + which one is active. Each
// workspace owns its layout tree, panes, focus, and zoom. Switching only flips `activeId`
// — every workspace's panes stay mounted (PTYs survive hiding); closing a workspace removes
// it (its panes unmount → PTYs die). Components import this singleton and call its ops.
//
// Focus/zoom are ephemeral UI state and live alongside the persisted Workspace fields here;
// persistence (M3 Stage D) serializes only id/name/cwd/tree/panes.

import { batch, createEffect, onCleanup } from "solid-js";
import { createStore } from "solid-js/store";
import type { LayoutNode, PaneId, PaneSpec, Workspace } from "../ipc/protocol";
import { allocName, buildBalancedTree } from "../lib/grid";
import { firstLeaf, leafIds, neighbor, removeLeaf, replaceLeaf, swapLeaves, type Dir, type Path } from "../lib/layout";
import { loadState, saveState } from "../lib/persist";
import { countLive } from "../lib/paneRegistry";
import { settings } from "./settings";

/**
 * A workspace plus its ephemeral UI state (focus/zoom — not persisted).
 */
export interface WorkspaceUI extends Workspace {
  focused: PaneId | null;
  zoomed: PaneId | null;
}

/** A recently-used working folder + its remembered terminal count (for the wizard). */
export interface RecentFolder {
  cwd: string;
  count: number;
}

/** A saved workspace template the wizard can relaunch in one click. */
export interface Preset {
  id: string;
  name: string;
  cwd: string;
  paneCount: number;
  /** Per-pane launch commands in row-major order (empty/omitted = plain shell). */
  commands?: (string | undefined)[];
  /** The captured split tree + per-pane specs, so relaunch rebuilds the hand-tuned layout
   *  (shape, gutter ratios, per-pane cwd) faithfully. Absent on older presets → balanced grid. */
  tree?: LayoutNode;
  panes?: Record<PaneId, PaneSpec>;
}

interface AppState {
  workspaces: WorkspaceUI[];
  activeId: string;
  recents: RecentFolder[];
  presets: Preset[];
  /** Overview ("fleet glance") mode: the active workspace's panes reflow to a uniform tile grid
      (a view transform only — the split tree and PTYs are untouched). Active-workspace scoped. */
  overview: boolean;
}

let idSeq = 0;
let wsSeq = 0;
let presetSeq = 0;
const nextPaneId = (): PaneId => ++idSeq;
const nextWsId = (): string => `ws${++wsSeq}`;
const nextPresetId = (): string => `ps${++presetSeq}`;

export interface NewWorkspaceOpts {
  name: string;
  cwd: string;
  paneCount: number;
  /** Per-pane launch commands in row-major order; entry omitted/empty = plain shell. */
  commands?: (string | undefined)[];
  /** Per-pane working-folder overrides (row-major); entry omitted/empty = workspace `cwd`. */
  cwds?: (string | undefined)[];
  /** Per-pane shell overrides (row-major), e.g. `wsl.exe -d Ubuntu`; omitted/empty = global default. */
  shells?: (string | undefined)[];
  /** A saved layout to rebuild verbatim (preset relaunch / duplicate) instead of a balanced grid.
   *  When set with `panes`, the tree shape + gutter ratios are preserved and each leaf is remapped
   *  to a fresh PaneId; `paneCount`/`commands`/`cwds` are then ignored. */
  tree?: LayoutNode;
  panes?: Record<PaneId, PaneSpec>;
}

/**
 * Deep-clone a split tree with fresh PaneIds, copying each leaf's spec (command/cwd/env/title)
 * from `srcPanes`. Returns the new tree + its panes map. Shared by duplicate-workspace and faithful
 * preset relaunch — both need the exact shape/ratios with brand-new PaneIds (→ brand-new PTYs).
 */
function cloneTreeWithFreshPanes(
  srcTree: LayoutNode,
  srcPanes: Record<PaneId, PaneSpec>,
): { tree: LayoutNode; panes: Record<PaneId, PaneSpec> } {
  const panes: Record<PaneId, PaneSpec> = {};
  const usedTitles: string[] = [];
  const clone = (node: LayoutNode): LayoutNode => {
    if (node.kind === "leaf") {
      const paneId = nextPaneId();
      const srcSpec = srcPanes[node.paneId];
      const spec: PaneSpec = srcSpec ? { ...srcSpec } : { title: allocName(usedTitles) };
      if (spec.env) spec.env = { ...spec.env }; // don't share env with the source
      if (!spec.title) spec.title = allocName(usedTitles);
      usedTitles.push(spec.title);
      panes[paneId] = spec;
      return { kind: "leaf", paneId };
    }
    return { kind: "split", dir: node.dir, ratio: node.ratio, a: clone(node.a), b: clone(node.b) };
  };
  return { tree: clone(srcTree), panes };
}

function buildWorkspace(opts: NewWorkspaceOpts): WorkspaceUI {
  // Faithful path: rebuild a saved tree verbatim (preset relaunch / duplicate), fresh PaneIds.
  if (opts.tree && opts.panes) {
    const { tree, panes } = cloneTreeWithFreshPanes(opts.tree, opts.panes);
    return { id: nextWsId(), name: opts.name, cwd: opts.cwd, tree, panes, focused: firstLeaf(tree), zoomed: null };
  }
  const panes: Record<PaneId, PaneSpec> = {};
  let i = 0;
  const makeLeaf = (): LayoutNode => {
    const paneId = nextPaneId();
    const title = allocName(Object.values(panes).map((p) => p.title));
    const command = opts.commands?.[i]?.trim();
    const cwd = opts.cwds?.[i]?.trim();
    const shell = opts.shells?.[i]?.trim();
    const spec: PaneSpec = { title };
    if (command) spec.command = command;
    if (cwd) spec.cwd = cwd;
    if (shell) spec.shell = shell;
    panes[paneId] = spec;
    i++;
    return { kind: "leaf", paneId };
  };
  const tree = buildBalancedTree(Math.max(1, opts.paneCount), makeLeaf);
  return { id: nextWsId(), name: opts.name, cwd: opts.cwd, tree, panes, focused: firstLeaf(tree), zoomed: null };
}

// Starts empty; `init()` (called once at startup) hydrates from disk or seeds a default
// workspace. Rendering is gated on init completing so panes spawn exactly once.
const [app, setApp] = createStore<AppState>({ workspaces: [], activeId: "", recents: [], presets: [], overview: false });

/** Reactive read-only view for components. */
export const appState = app;
export const recents = (): RecentFolder[] => app.recents;
export const presets = (): Preset[] => app.presets;
export const activeWorkspace = (): WorkspaceUI | undefined => app.workspaces.find((w) => w.id === app.activeId);
export const paneCount = (ws: Workspace): number => Object.keys(ws.panes).length;

const wsIdxById = (id: string) => app.workspaces.findIndex((w) => w.id === id);
const wsIdxByPane = (paneId: PaneId) => app.workspaces.findIndex((w) => paneId in w.panes);

// ---- Pane operations (resolve their owning workspace by paneId) ----------------------
// The pure tree transforms these build on (replaceLeaf/removeLeaf/firstLeaf/leafIds) live in
// lib/layout.ts; each op below wraps one in a `setApp` mutation.

export function focusPane(paneId: PaneId) {
  const i = wsIdxByPane(paneId);
  if (i >= 0) setApp("workspaces", i, "focused", paneId);
}

export function toggleZoom(paneId: PaneId) {
  const i = wsIdxByPane(paneId);
  if (i >= 0) setApp("workspaces", i, "zoomed", (z) => (z === paneId ? null : paneId));
}

/** Move focus to the pane spatially adjacent to `from` in `dir` (Ctrl+Shift+arrows). */
export function focusDir(from: PaneId, dir: Dir): boolean {
  const i = wsIdxByPane(from);
  if (i < 0) return false;
  const next = neighbor(app.workspaces[i].tree, from, dir);
  if (next === null) return false;
  setApp("workspaces", i, "focused", next);
  return true;
}

export function renamePane(paneId: PaneId, title: string) {
  const i = wsIdxByPane(paneId);
  const name = title.trim();
  if (i >= 0 && name) setApp("workspaces", i, "panes", paneId, "title", name);
}

/** Drop a pane's launch command so it (re)spawns as a plain login shell. The "Open shell
 *  instead" escape hatch on a Dead pane whose agent command wasn't installed (exited 127).
 *  Persisted, so a later restart/reload is a shell too — not the missing command again. */
export function clearPaneCommand(paneId: PaneId) {
  const i = wsIdxByPane(paneId);
  if (i >= 0) setApp("workspaces", i, "panes", paneId, "command", undefined);
}

/** Rename a workspace (rail double-click). Blank input is ignored — keeps the old name. */
export function renameWorkspace(id: string, name: string) {
  const i = wsIdxById(id);
  const next = name.trim();
  if (i >= 0 && next) setApp("workspaces", i, "name", next);
}

export function splitPane(paneId: PaneId, dir: "row" | "col") {
  const i = wsIdxByPane(paneId);
  if (i < 0) return;
  const ws = app.workspaces[i];
  const newId = nextPaneId();
  const newTree = replaceLeaf(ws.tree, paneId, (leaf) => ({
    kind: "split", dir, ratio: 0.5, a: leaf, b: { kind: "leaf", paneId: newId },
  }));
  const title = allocName(Object.values(ws.panes).map((p) => p.title));
  batch(() => {
    setApp("workspaces", i, "panes", newId, { title });
    setApp("workspaces", i, "tree", newTree);
    setApp("workspaces", i, "focused", newId);
    setApp("workspaces", i, "zoomed", null);
  });
}

export function closePane(paneId: PaneId) {
  const i = wsIdxByPane(paneId);
  if (i < 0) return;
  const ws = app.workspaces[i];
  const next = removeLeaf(ws.tree, paneId);
  if (next === null) return; // never leave a workspace with zero panes
  // Guard against closing a pane whose process is still alive (Settings → confirm close).
  if (settings.confirmClose && countLive([paneId]) > 0) {
    if (!window.confirm(`Close "${ws.panes[paneId]?.title}"? Its process is still running.`)) return;
  }
  batch(() => {
    setApp("workspaces", i, "tree", next);
    setApp("workspaces", i, "panes", paneId, undefined as unknown as PaneSpec);
    if (ws.focused === paneId) setApp("workspaces", i, "focused", firstLeaf(next));
    if (ws.zoomed === paneId) setApp("workspaces", i, "zoomed", null);
  });
}

/** Swap two panes' grid positions (drag-to-rearrange). Only swaps within one workspace. */
export function swapPanes(a: PaneId, b: PaneId) {
  if (a === b) return;
  const i = wsIdxByPane(a);
  if (i < 0 || !(b in app.workspaces[i].panes)) return;
  setApp("workspaces", i, "tree", (t) => swapLeaves(t, a, b));
}

export function setRatio(wsId: string, path: Path, ratio: number) {
  const i = wsIdxById(wsId);
  if (i < 0) return;
  const r = Math.max(0.05, Math.min(0.95, ratio));
  // Dynamic store path: `("workspaces", i, "tree", ...path, "ratio")`.
  (setApp as (...args: unknown[]) => void)("workspaces", i, "tree", ...path, "ratio", r);
}

// ---- Inter-pane control bus support (ADR-0007) --------------------------------------
// Name resolution + CLI-driven spawn live here, in TS, alongside the rest of the layout
// logic. The control relay (Rust) and the frontend handler (src/lib/paneControl.ts) call
// these; liveness itself is the pane registry's call at write time.

/** One pane for a `th list`, in row-major order across all workspaces. */
export interface PaneListing {
  paneId: PaneId;
  name: string;
  workspace: string;
  focused: boolean;
}

export function listPanes(): PaneListing[] {
  const out: PaneListing[] = [];
  for (const w of app.workspaces) {
    for (const id of leafIds(w.tree)) {
      out.push({ paneId: id, name: w.panes[id]?.title ?? `Pane ${id}`, workspace: w.name, focused: w.focused === id });
    }
  }
  return out;
}

/**
 * Resolve a pane display name to its PaneId, preferring the active workspace, then a unique
 * match across all workspaces. A name shared by several panes is an error (the CLI surfaces
 * it) rather than a silent pick.
 */
export function resolvePaneByName(name: string): { paneId: PaneId } | { error: string } {
  const active = activeWorkspace();
  if (active) {
    for (const id of leafIds(active.tree)) if (active.panes[id]?.title === name) return { paneId: id };
  }
  const matches: PaneId[] = [];
  for (const w of app.workspaces) for (const id of leafIds(w.tree)) if (w.panes[id]?.title === name) matches.push(id);
  if (matches.length === 1) return { paneId: matches[0] };
  if (matches.length === 0) return { error: `no pane named "${name}"` };
  return { error: `"${name}" is ambiguous (${matches.length} panes share it)` };
}

/** A workspace looked up by display name, preferring the active one (`th broadcast --workspace`). */
export function workspaceByName(name: string): WorkspaceUI | undefined {
  const active = activeWorkspace();
  if (active && active.name === name) return active;
  return app.workspaces.find((w) => w.name === name);
}

/** Switch to a pane's workspace and focus it (used by `th focus` and the command palette). */
export function revealPane(paneId: PaneId) {
  const i = wsIdxByPane(paneId);
  if (i < 0) return;
  batch(() => {
    setApp("activeId", app.workspaces[i].id);
    setApp("workspaces", i, "focused", paneId);
    setApp("workspaces", i, "zoomed", null);
  });
}

/**
 * Reveal a pane by name: switch to its workspace and focus it (`th focus`). Returns the pane's
 * name on success. Resolution reuses {@link resolvePaneByName} (active-workspace-preferring).
 */
export function revealPaneByName(name: string): { name: string } | { error: string } {
  const r = resolvePaneByName(name);
  if ("error" in r) return r;
  const i = wsIdxByPane(r.paneId);
  if (i < 0) return { error: `no pane named "${name}"` };
  revealPane(r.paneId);
  return { name: app.workspaces[i].panes[r.paneId]?.title ?? name };
}

/**
 * Spawn a new pane in the active workspace running `command`, by splitting the focused leaf
 * (same mutation the UI's split does, so the result is an ordinary persisted pane). Returns
 * the pane's final name — the requested one if free, else a freshly allocated pool name.
 */
export function spawnPane(opts: { title?: string; command: string; cwd?: string }): { name: string } | { error: string } {
  const i = wsIdxById(app.activeId);
  if (i < 0) return { error: "no active workspace" };
  const ws = app.workspaces[i];
  const target = ws.focused ?? firstLeaf(ws.tree);
  const newId = nextPaneId();
  const taken = Object.values(ws.panes).map((p) => p.title);
  const requested = opts.title?.trim();
  const title = requested && !taken.includes(requested) ? requested : allocName(taken);
  const newTree = replaceLeaf(ws.tree, target, (leaf) => ({
    kind: "split", dir: "row", ratio: 0.5, a: leaf, b: { kind: "leaf", paneId: newId },
  }));
  const spec: PaneSpec = opts.cwd ? { title, command: opts.command, cwd: opts.cwd } : { title, command: opts.command };
  batch(() => {
    setApp("workspaces", i, "panes", newId, spec);
    setApp("workspaces", i, "tree", newTree);
    setApp("workspaces", i, "focused", newId);
    setApp("workspaces", i, "zoomed", null);
  });
  return { name: title };
}

// ---- Workspace operations -----------------------------------------------------------

function recordRecent(cwd: string, count: number) {
  if (!cwd.trim()) return;
  const others = app.recents.filter((r) => r.cwd !== cwd);
  setApp("recents", [{ cwd, count }, ...others].slice(0, 8));
}

export function createWorkspace(opts: NewWorkspaceOpts): string {
  const ws = buildWorkspace(opts);
  batch(() => {
    setApp("workspaces", app.workspaces.length, ws);
    setApp("activeId", ws.id);
    recordRecent(opts.cwd, opts.paneCount);
  });
  return ws.id;
}

export function switchWorkspace(id: string) {
  setApp("activeId", id);
}

/** Jump directly to the workspace at position `i` (0-based) — Ctrl+Shift+1…9. No-op out of range. */
export function switchWorkspaceIndex(i: number) {
  if (i >= 0 && i < app.workspaces.length) setApp("activeId", app.workspaces[i].id);
}

/**
 * Clone a workspace into a fresh one (fresh PaneIds → fresh PTYs) keeping the exact split tree,
 * gutter ratios, and each pane's spec (command/cwd/env/title). The new workspace is appended and
 * made active; its panes respawn their commands like any launch. Returns the new id.
 */
export function duplicateWorkspace(id: string): string | undefined {
  const src = app.workspaces.find((w) => w.id === id);
  if (!src) return;
  const { tree, panes } = cloneTreeWithFreshPanes(src.tree, src.panes);
  const ws: WorkspaceUI = {
    id: nextWsId(),
    name: `${src.name} copy`,
    cwd: src.cwd,
    tree,
    panes,
    focused: firstLeaf(tree),
    zoomed: null,
  };
  batch(() => {
    setApp("workspaces", app.workspaces.length, ws);
    setApp("activeId", ws.id);
  });
  return ws.id;
}

/** Switch to the next (+1) / previous (-1) workspace, wrapping (Ctrl+Shift+PageUp/Down). */
export function switchWorkspaceRelative(delta: number) {
  const n = app.workspaces.length;
  if (n <= 1) return;
  const cur = wsIdxById(app.activeId);
  const next = ((cur + delta) % n + n) % n;
  setApp("activeId", app.workspaces[next].id);
}

export function closeWorkspace(id: string) {
  const i = wsIdxById(id);
  if (i < 0 || app.workspaces.length === 1) return; // keep at least one workspace
  if (settings.confirmClose) {
    const live = countLive(leafIds(app.workspaces[i].tree));
    if (live > 0 && !window.confirm(
      `Close "${app.workspaces[i].name}"? ${live} running terminal${live === 1 ? "" : "s"} will be killed.`,
    )) return;
  }
  const remaining = app.workspaces.filter((w) => w.id !== id);
  batch(() => {
    setApp("workspaces", remaining);
    if (app.activeId === id) setApp("activeId", remaining[Math.min(i, remaining.length - 1)].id);
  });
}

/** Set overview ("fleet glance") mode on/off. */
export function setOverview(on: boolean) {
  setApp("overview", on);
}

/** Toggle overview mode (Ctrl+Shift+O). */
export function toggleOverview() {
  setApp("overview", (v) => !v);
}

/**
 * The PaneIds a broadcast should reach in `ws`, in row-major order: every pane in the workspace.
 * This is the agent-facing fan-out target for the inter-pane control bus (`th broadcast` and the
 * MCP `broadcast` tool, ADR-0007) — there is no human broadcast UI. Liveness is the registry's
 * call at send time, so dead panes are simply skipped there.
 */
export function broadcastTargets(ws: WorkspaceUI): PaneId[] {
  return leafIds(ws.tree);
}

// ---- Presets (saved workspace templates) --------------------------------------------

/** Snapshot the active workspace as a relaunchable preset: the full split tree + per-pane specs
 *  (so the hand-tuned layout, gutter ratios, and per-pane cwd round-trip), plus cwd + paneCount +
 *  commands for display and older-style fallback. The tree/panes are deep-copied so later edits to
 *  the live workspace don't mutate the saved preset. */
export function saveCurrentAsPreset(): Preset | undefined {
  const ws = activeWorkspace();
  if (!ws) return;
  const order = leafIds(ws.tree);
  const commands = order.map((id) => ws.panes[id]?.command);
  const preset: Preset = {
    id: nextPresetId(),
    name: ws.name,
    cwd: ws.cwd,
    paneCount: order.length,
    commands: commands.some(Boolean) ? commands : undefined,
    tree: JSON.parse(JSON.stringify(ws.tree)) as LayoutNode,
    panes: JSON.parse(JSON.stringify(ws.panes)) as Record<PaneId, PaneSpec>,
  };
  // Replace a same-name preset rather than piling up duplicates.
  const others = app.presets.filter((p) => p.name !== preset.name);
  setApp("presets", [preset, ...others].slice(0, 24));
  return preset;
}

/** Create + activate a fresh workspace from a saved preset — rebuilding the captured layout
 *  verbatim when present, else (older presets) a balanced grid from paneCount + commands. */
export function launchPreset(preset: Preset): string {
  return createWorkspace({
    name: preset.name,
    cwd: preset.cwd,
    paneCount: preset.paneCount,
    commands: preset.commands,
    tree: preset.tree,
    panes: preset.panes,
  });
}

export function deletePreset(id: string) {
  setApp("presets", (ps) => ps.filter((p) => p.id !== id));
}

// ---- Persistence (JSON, app config dir) ---------------------------------------------
// Persist intent (layout + per-pane spec), never live scrollback — on restart we rebuild
// the trees and respawn each pane's command in its cwd (PLAN "Persist intent, not scrollback").

/** The serialized shape: persisted Workspace fields only (focus/zoom are ephemeral). */
interface PersistedRoot {
  activeId: string;
  workspaces: Workspace[];
}

function snapshot(): PersistedRoot {
  return {
    activeId: app.activeId,
    workspaces: app.workspaces.map((w) => ({ id: w.id, name: w.name, cwd: w.cwd, tree: w.tree, panes: w.panes })),
  };
}

function allPaneIds(workspaces: Workspace[]): number[] {
  const ids: number[] = [];
  const walk = (n: LayoutNode) => {
    if (n.kind === "leaf") ids.push(n.paneId);
    else { walk(n.a); walk(n.b); }
  };
  workspaces.forEach((w) => walk(w.tree));
  return ids;
}

/** Load persisted workspaces/recents (or seed a default Home). Call once before rendering. */
export async function init() {
  let restored = false;
  try {
    const raw = await loadState("workspaces");
    if (raw) {
      const data = JSON.parse(raw) as PersistedRoot;
      if (data.workspaces?.length) {
        // Resume the id counters past anything persisted so new panes/workspaces don't collide.
        idSeq = Math.max(0, ...allPaneIds(data.workspaces));
        wsSeq = Math.max(0, ...data.workspaces.map((w) => parseInt(w.id.replace(/\D/g, ""), 10) || 0));
        const workspaces = data.workspaces.map((w) => ({ ...w, focused: firstLeaf(w.tree), zoomed: null }));
        const activeId = workspaces.some((w) => w.id === data.activeId) ? data.activeId : workspaces[0].id;
        setApp({ workspaces, activeId });
        restored = true;
      }
    }
    const recRaw = await loadState("recents");
    if (recRaw) setApp("recents", JSON.parse(recRaw) as RecentFolder[]);
    const psRaw = await loadState("presets");
    if (psRaw) {
      const ps = JSON.parse(psRaw) as Preset[];
      presetSeq = Math.max(0, ...ps.map((p) => parseInt(p.id.replace(/\D/g, ""), 10) || 0));
      setApp("presets", ps);
    }
  } catch (e) {
    console.error("failed to load persisted state", e);
  }
  if (!restored) {
    const home = buildWorkspace({ name: "Home", cwd: "", paneCount: 4 });
    setApp({ workspaces: [home], activeId: home.id });
  }
}

// The most recent serialized state, kept current by the persistence effect so a flush (e.g.
// on app close) writes the latest values without waiting on the debounce.
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
let latest = { ws: "", rec: "", ps: "" };
let dirty = false;

/** Autosave workspaces + recents (debounced) on any change. Call once, inside a root owner. */
export function startPersistence() {
  createEffect(() => {
    // Stringify inside the effect so every nested change (ratio, split, rename…) is tracked.
    latest = {
      ws: JSON.stringify(snapshot()),
      rec: JSON.stringify(app.recents),
      ps: JSON.stringify(app.presets),
    };
    dirty = true;
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => { void flushPersistence(); }, 400);
  });
  onCleanup(() => clearTimeout(pendingTimer));
}

/** Write the latest snapshot immediately. Call before the window closes so no debounced change is lost. */
export async function flushPersistence(): Promise<void> {
  clearTimeout(pendingTimer);
  if (!dirty) return;
  dirty = false;
  await Promise.all([
    saveState("workspaces", latest.ws),
    saveState("recents", latest.rec),
    saveState("presets", latest.ps),
  ]);
}
