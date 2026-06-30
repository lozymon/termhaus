// Fuzzy command palette (Ctrl+Shift+P). One searchable list over every app action that makes
// sense globally — pane ops on the focused pane, workspace switching, and jump-to-pane-by-name
// (the fleet-navigation win: type a pane's name, land on it wherever it lives). Built fresh on
// open from the live store so the workspace/pane entries are current. Pure scoring lives in
// lib/matching (fuzzyScore), unit-tested separately.

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  activeWorkspace,
  appState,
  closePane,
  listPanes,
  revealPane,
  saveCurrentAsPreset,
  splitPane,
  switchWorkspace,
  switchWorkspaceRelative,
  toggleOverview,
  toggleZoom,
} from "../stores/workspace";
import { fuzzyScore } from "../lib/matching";
import { formatBinding, type ActionId } from "../lib/keybindings";
import { settings } from "../stores/settings";
import { activity } from "../stores/activity";

type PaneState = "working" | "idle" | "needs" | "dead";

interface Command {
  label: string;
  /** "action" rows lead with an icon glyph; "pane" rows lead with a live state dot. */
  kind: "action" | "pane";
  icon?: string;
  state?: PaneState;
  hint?: string;
  /** Formatted shortcut (e.g. "Ctrl+Shift+D") shown on the right, when the command has one. */
  key?: string;
  run: () => void;
}

/** The live shortcut for an action, formatted for display. */
const kb = (id: ActionId): string => formatBinding(settings.keybindings[id]);

export default function CommandPalette(props: {
  onClose: () => void;
  onNewWorkspace: () => void;
  onSettings: () => void;
  onShortcuts: () => void;
  onLogs: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [sel, setSel] = createSignal(0);
  let input: HTMLInputElement | undefined;

  /** The focused pane in the active workspace (target of pane-scoped commands), or null. */
  const focused = (): number | null => activeWorkspace()?.focused ?? null;

  // Built once per open (the component is mounted only while open), so the workspace/pane
  // lists reflect the moment the palette appeared — fresh enough without reactive churn.
  const commands = (): Command[] => {
    const list: Command[] = [
      { label: "New workspace", icon: "＋", kind: "action", key: kb("new-workspace"), run: props.onNewWorkspace },
      { label: "Open settings", icon: "⚙", kind: "action", hint: "Preferences", run: props.onSettings },
      { label: "Keyboard shortcuts cheat-sheet", icon: "⌨", kind: "action", key: kb("shortcuts"), run: props.onShortcuts },
      { label: "View session logs", icon: "≣", kind: "action", hint: "Recorded pane output", run: props.onLogs },
      { label: "Toggle overview (fleet glance)", icon: "▦", kind: "action", key: kb("overview"), run: () => toggleOverview() },
      { label: "Save workspace as preset", icon: "★", kind: "action", run: () => saveCurrentAsPreset() },
      { label: "Next workspace", icon: "→", kind: "action", key: kb("next-workspace"), run: () => switchWorkspaceRelative(1) },
      { label: "Previous workspace", icon: "←", kind: "action", key: kb("prev-workspace"), run: () => switchWorkspaceRelative(-1) },
    ];
    const f = focused();
    if (f !== null) {
      list.push(
        { label: "Split pane right", icon: "⊟", kind: "action", key: kb("split-right"), run: () => splitPane(f, "row") },
        { label: "Split pane down", icon: "⊞", kind: "action", key: kb("split-down"), run: () => splitPane(f, "col") },
        { label: "Zoom focused pane", icon: "⤢", kind: "action", key: kb("toggle-zoom"), run: () => toggleZoom(f) },
        { label: "Close focused pane", icon: "✕", kind: "action", key: kb("close-pane"), run: () => closePane(f) },
      );
    }
    for (const w of appState.workspaces) {
      if (w.id === appState.activeId) continue;
      list.push({ label: `Switch to workspace: ${w.name}`, icon: "▦", kind: "action", hint: "Workspace", run: () => switchWorkspace(w.id) });
    }
    for (const p of listPanes()) {
      // Workspace in front of the pane name so same-named panes across workspaces (Faye in
      // "Home" vs "code") are distinguishable — and searchable by workspace.
      const a = activity[p.paneId];
      const state: PaneState = a?.attention ? "needs" : a?.busy === true ? "working" : "idle";
      list.push({ label: `${p.workspace} / ${p.name}`, kind: "pane", state, hint: a?.status, run: () => revealPane(p.paneId) });
    }
    return list;
  };

  // Filter + rank, then split into the two prototype sections (ACTIONS / GO TO PANE). `flat`
  // is the combined order the keyboard navigation + selection index walk.
  const filtered = createMemo(() => {
    const q = query().trim();
    const scored = commands()
      .map((c) => ({ c, score: fuzzyScore(q, c.label) }))
      .filter((x): x is { c: Command; score: number } => x.score !== null);
    if (q) scored.sort((a, b) => b.score - a.score);
    const all = scored.map((x) => x.c);
    const actions = all.filter((c) => c.kind === "action");
    const panes = all.filter((c) => c.kind === "pane");
    return { actions, panes, flat: [...actions, ...panes] };
  });

  function run(cmd: Command | undefined) {
    if (!cmd) return;
    props.onClose();
    cmd.run();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); props.onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, filtered().flat.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); run(filtered().flat[sel()]); }
  }

  onMount(() => {
    queueMicrotask(() => input?.focus());
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  /** One palette row: a leading icon (actions) or state dot (panes), a label, and a right-aligned
   *  shortcut/hint. `flatIdx` is the row's position in `filtered().flat` (for selection). */
  const paletteRow = (cmd: Command, flatIdx: number) => (
    <div
      class="palette-item"
      classList={{ sel: flatIdx === sel() }}
      onPointerEnter={() => setSel(flatIdx)}
      onClick={() => run(cmd)}
    >
      <Show
        when={cmd.kind === "pane"}
        fallback={<span class="palette-ic">{cmd.icon}</span>}
      >
        <span class="palette-dot" data-state={cmd.state} />
      </Show>
      <span class="palette-label">{cmd.label}</span>
      <Show when={cmd.kind === "pane" ? cmd.hint : (cmd.key ?? cmd.hint)}>
        <span class="palette-key" classList={{ "palette-key-state": cmd.kind === "pane" }} data-state={cmd.state}>
          {cmd.kind === "pane" ? cmd.hint : (cmd.key ?? cmd.hint)}
        </span>
      </Show>
    </div>
  );

  return (
    <div class="palette-overlay" onPointerDown={() => props.onClose()}>
      <div class="palette" onPointerDown={(e) => e.stopPropagation()}>
        <div class="palette-head">
          <span class="palette-glyph">⌘</span>
          <input
            ref={input}
            class="palette-input"
            placeholder="Type a command or pane name…"
            value={query()}
            onInput={(e) => { setQuery(e.currentTarget.value); setSel(0); }}
          />
          <kbd class="palette-esc">esc</kbd>
        </div>
        <div class="palette-list">
          <Show when={filtered().flat.length > 0} fallback={<div class="palette-empty">No matches</div>}>
            <Show when={filtered().actions.length > 0}>
              <div class="palette-section">ACTIONS</div>
              <For each={filtered().actions}>
                {(cmd, i) => paletteRow(cmd, i())}
              </For>
            </Show>
            <Show when={filtered().panes.length > 0}>
              <div class="palette-section">GO TO PANE</div>
              <For each={filtered().panes}>
                {(cmd, i) => paletteRow(cmd, filtered().actions.length + i())}
              </For>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}
