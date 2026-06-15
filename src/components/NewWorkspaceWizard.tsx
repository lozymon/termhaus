// The + on the rail opens this single-page launcher. Everything that used to be three steps
// (Start → Layout → Agents) now lives on one panel:
//  • Left  — where: working folder (native picker + Recents), saved Presets, launch options.
//  • Right — what runs: a visual layout picker (mini-grid tiles + a 1–16 slider), a "fleet"
//            row that fills every pane with one agent in a click, and an interactive grid
//            preview where clicking a pane sets its agent / command / cwd individually.

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import {
  createWorkspace, deletePreset, launchPreset, presets, recents, saveCurrentAsPreset,
} from "../stores/workspace";
import { settings } from "../stores/settings";
import { AGENTS, detectAgent } from "../lib/agents";
import { checkCommandAvailable } from "../lib/agentAvailability";
import { allocName, balancedBands } from "../lib/grid";

const PRESETS = [1, 2, 4, 6, 8, 10, 12];
const MAX_PANES = 16;

/** Final path segment of a folder, for the workspace name. Handles both `/` (Unix) and `\`
 * (Windows) separators so Windows paths like `C:\Users\me\proj` name the workspace `proj`. */
function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Capitalize the first letter, leaving the rest as-is (`src-tauri` → `Src-tauri`). */
function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** The default workspace name for a folder: its basename with the first letter capitalized. */
const autoName = (path: string): string => capitalize(basename(path));

/** A small diagram of how buildBalancedTree(n) will arrange its panes — used on the layout tiles. */
function MiniGrid(props: { n: number }) {
  return (
    <span class="wiz-mini">
      <For each={balancedBands(props.n)}>
        {(take) => (
          <span class="wiz-mini-row">
            <For each={Array.from({ length: take })}>{() => <span class="wiz-mini-cell" />}</For>
          </span>
        )}
      </For>
    </span>
  );
}

export default function NewWorkspaceWizard(props: { onClose: () => void }) {
  const [cwd, setCwd] = createSignal(settings.defaultCwd);
  // Name tracks the folder's basename until the user types their own — then it sticks.
  const [name, setName] = createSignal(autoName(settings.defaultCwd));
  const [nameDirty, setNameDirty] = createSignal(false);
  const [count, setCount] = createSignal(4);
  const [commands, setCommands] = createSignal<string[]>([]);
  const [cwds, setCwds] = createSignal<string[]>([]);
  const [selected, setSelected] = createSignal<number | null>(null);
  const [saveAsPreset, setSaveAsPreset] = createSignal(false);
  const [broadcastAll, setBroadcastAll] = createSignal(false);
  // Pre-flight: command string → is its program installed? (undefined = unchecked/checking).
  // Filled async so we never block opening the wizard; drives the "⚠ not installed" hints.
  const [avail, setAvail] = createSignal<Record<string, boolean>>({});
  const checkAvail = (cmd: string) => {
    const key = cmd.trim();
    if (!key || key in avail()) return;
    void checkCommandAvailable(key).then((ok) => setAvail((m) => ({ ...m, [key]: ok })));
  };
  /** A command we've confirmed isn't installed (false), as opposed to unchecked (undefined). */
  const isMissing = (cmd: string | undefined) => avail()[(cmd ?? "").trim()] === false;
  // Probe the built-in agents up front so the fleet chips can warn before any click.
  onMount(() => AGENTS.forEach((a) => checkAvail(a.command)));

  // Auto-names exactly as buildWorkspace allocates them (Faye, Cleo, …) so the preview matches.
  const names = createMemo(() => {
    const taken: string[] = [];
    return Array.from({ length: count() }, () => {
      const nm = allocName(taken);
      taken.push(nm);
      return nm;
    });
  });
  const bands = createMemo(() => balancedBands(count()));
  const agentCount = createMemo(() => commands().slice(0, count()).filter((c) => c?.trim()).length);

  // No availability probe here: this fires on every keystroke of the free-text cmd field, and a
  // probe spawns a login shell. The built-in agent commands are all probed up front (onMount);
  // a hand-typed command is covered after the fact by the pane's dead-pane overlay instead.
  const setCommandAt = (i: number, cmd: string) =>
    setCommands((c) => { const n = [...c]; n[i] = cmd; return n; });
  const setCwdAt = (i: number, dir: string) =>
    setCwds((c) => { const n = [...c]; n[i] = dir; return n; });
  const fillAll = (cmd: string) => setCommands(Array.from({ length: count() }, () => cmd));

  // Changing the folder also refreshes the name, unless the user has hand-edited it.
  function applyCwd(next: string) {
    setCwd(next);
    if (!nameDirty()) setName(next.trim() ? autoName(next) : "");
  }

  async function browse() {
    const picked = await open({ directory: true, title: "Pick a working folder" });
    if (typeof picked === "string") applyCwd(picked);
  }
  async function browseCwdAt(i: number) {
    const picked = await open({ directory: true, title: "Folder for this terminal" });
    if (typeof picked === "string") setCwdAt(i, picked);
  }

  function launch() {
    const folder = cwd().trim();
    const cmds = commands().slice(0, count());
    const dirs = cwds().slice(0, count());
    const wsName = name().trim() || (folder ? autoName(folder) : `Workspace ${recents().length + 1}`);
    createWorkspace({
      name: wsName,
      cwd: folder,
      paneCount: count(),
      commands: cmds.some((c) => c?.trim()) ? cmds : undefined,
      cwds: dirs.some((c) => c?.trim()) ? dirs : undefined,
      broadcastAll: broadcastAll(),
    });
    if (saveAsPreset()) saveCurrentAsPreset();
    props.onClose();
  }

  function launchSaved(id: string) {
    const p = presets().find((x) => x.id === id);
    if (p) { launchPreset(p); props.onClose(); }
  }

  // Esc closes the launcher from anywhere (capture phase: xterm swallows Escape when a terminal
  // has focus, so a bubble listener wouldn't fire until you click off the pane).
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) launch();
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));

  return (
    <div class="wizard-backdrop" onClick={() => props.onClose()}>
      <div class="wizard wizard-wide" onClick={(e) => e.stopPropagation()}>
        <header class="wizard-head">
          <strong>New workspace</strong>
          <span class="muted">
            {count()} terminal{count() === 1 ? "" : "s"}
            {agentCount() > 0 ? ` · ${agentCount()} agent${agentCount() === 1 ? "" : "s"}` : " · shells"}
          </span>
        </header>

        <div class="wiz-cols">
          {/* LEFT — where it runs */}
          <div class="wiz-left">
            <div>
              <label class="wizard-label">Name</label>
              <input
                class="wizard-input"
                placeholder="Workspace name"
                value={name()}
                onInput={(e) => { setName(e.currentTarget.value); setNameDirty(true); }}
              />
            </div>

            <div>
              <label class="wizard-label">Working folder</label>
              <div class="wizard-row">
                <input
                  class="wizard-input"
                  placeholder="$HOME (default)"
                  value={cwd()}
                  onInput={(e) => applyCwd(e.currentTarget.value)}
                />
                <button onClick={browse}>Browse…</button>
              </div>
            </div>

            <Show when={recents().length > 0}>
              <div>
                <label class="wizard-label">Recent</label>
                <div class="wizard-recents">
                  <For each={recents()}>
                    {(r) => (
                      <button class="wizard-recent" onClick={() => { applyCwd(r.cwd); setCount(r.count); }}>
                        <span>{basename(r.cwd)}</span>
                        <span class="muted">{r.cwd} · {r.count}</span>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            <Show when={presets().length > 0}>
              <div>
                <label class="wizard-label">Presets · one-click relaunch</label>
                <div class="wizard-presets">
                  <For each={presets()}>
                    {(p) => (
                      <div class="wizard-preset">
                        <button class="wizard-preset-go" onClick={() => launchSaved(p.id)}>
                          <span>{p.name}</span>
                          <span class="muted">{p.paneCount} panes{p.commands?.some(Boolean) ? " · agents" : ""}{p.tree ? " · layout" : ""}</span>
                        </button>
                        <button class="wizard-preset-del" title="Delete preset" onClick={() => deletePreset(p.id)}>✕</button>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            <div class="wiz-opts">
              <label class="wiz-opt">
                <input type="checkbox" checked={broadcastAll()} onChange={(e) => setBroadcastAll(e.currentTarget.checked)} />
                Preselect all panes for broadcast
              </label>
              <label class="wiz-opt">
                <input type="checkbox" checked={saveAsPreset()} onChange={(e) => setSaveAsPreset(e.currentTarget.checked)} />
                Save as preset on launch
              </label>
            </div>
          </div>

          {/* RIGHT — what runs */}
          <div class="wiz-right">
            <div>
              <label class="wizard-label">Layout</label>
              <div class="wiz-ltiles">
                <For each={PRESETS}>
                  {(n) => (
                    <button class="wiz-ltile" classList={{ on: count() === n }} onClick={() => setCount(n)}>
                      <MiniGrid n={n} />
                      <span>{n}</span>
                    </button>
                  )}
                </For>
              </div>
              <div class="wiz-slider">
                <span class="muted">custom</span>
                <input
                  type="range" min="1" max={MAX_PANES} value={count()}
                  onInput={(e) => setCount(+e.currentTarget.value)}
                />
                <span class="wiz-slider-n">{count()}</span>
              </div>
            </div>

            <div>
              <label class="wizard-label">Fleet · fill every pane</label>
              <div class="wiz-fleet">
                <For each={AGENTS}>
                  {(a) => (
                    <button
                      class="wiz-chip"
                      classList={{ "wiz-chip-missing": isMissing(a.command) }}
                      style={{ "--chip": a.color }}
                      title={isMissing(a.command) ? `${a.label} isn't installed or not on PATH` : `Fill all with ${a.label}`}
                      onClick={() => fillAll(a.command)}
                    >
                      <span class="wiz-chip-ic">{a.icon}</span>{a.label}
                      <Show when={isMissing(a.command)}><span class="wiz-chip-warn" title="not installed">⚠</span></Show>
                    </button>
                  )}
                </For>
                <button class="wiz-chip wiz-chip-shell" title="All plain shells" onClick={() => fillAll("")}>
                  <span class="wiz-chip-ic">⌗</span>Shells
                </button>
              </div>
            </div>

            <div>
              <label class="wizard-label">Preview · click a pane to set its agent</label>
              <div class="wiz-grid">
                <For each={bands()}>
                  {(take, bandIdx) => {
                    const start = () => bands().slice(0, bandIdx()).reduce((a, b) => a + b, 0);
                    return (
                      <div class="wiz-grid-row">
                        <For each={Array.from({ length: take })}>
                          {(_, k) => {
                            const idx = () => start() + k();
                            const agent = () => detectAgent(commands()[idx()]);
                            return (
                              <button
                                class="wiz-cell"
                                classList={{ on: selected() === idx(), agent: !!agent(), "wiz-cell-missing": isMissing(commands()[idx()]) }}
                                style={agent() ? { "--cell-accent": agent()!.color } : undefined}
                                title={isMissing(commands()[idx()]) ? `${commands()[idx()]} isn't installed or not on PATH` : undefined}
                                onClick={() => setSelected(idx())}
                              >
                                <span class="wiz-cell-name">
                                  {names()[idx()]}
                                  <Show when={isMissing(commands()[idx()])}><span class="wiz-cell-warn" title="not installed">⚠</span></Show>
                                </span>
                                <span class="wiz-cell-agent">
                                  {agent() ? `${agent()!.icon} ${agent()!.label}` : "shell"}
                                  <Show when={cwds()[idx()]?.trim()}> · {basename(cwds()[idx()]!)}</Show>
                                </span>
                              </button>
                            );
                          }}
                        </For>
                      </div>
                    );
                  }}
                </For>
              </div>
            </div>

            <Show when={selected() !== null && selected()! < count()}>
              {(() => {
                const i = () => selected()!;
                return (
                  <div class="wiz-editor">
                    <div class="wiz-editor-head">
                      <strong>{names()[i()]}</strong>
                      <button class="wiz-editor-x" title="Done" onClick={() => setSelected(null)}>✕</button>
                    </div>
                    <div class="wiz-fleet">
                      <For each={AGENTS}>
                        {(a) => (
                          <button
                            class="wiz-chip" style={{ "--chip": a.color }}
                            classList={{ on: detectAgent(commands()[i()])?.id === a.id, "wiz-chip-missing": isMissing(a.command) }}
                            title={isMissing(a.command) ? `${a.label} isn't installed or not on PATH` : a.label}
                            onClick={() => setCommandAt(i(), a.command)}
                          >
                            <span class="wiz-chip-ic">{a.icon}</span>{a.label}
                            <Show when={isMissing(a.command)}><span class="wiz-chip-warn" title="not installed">⚠</span></Show>
                          </button>
                        )}
                      </For>
                      <button class="wiz-chip wiz-chip-shell" classList={{ on: !commands()[i()]?.trim() }} onClick={() => setCommandAt(i(), "")}>
                        <span class="wiz-chip-ic">⌗</span>Shell
                      </button>
                    </div>
                    <div class="wizard-row">
                      <span class="muted" style={{ width: "5ch" }}>cmd</span>
                      <input
                        class="wizard-input" placeholder="$SHELL"
                        value={commands()[i()] ?? ""}
                        onInput={(e) => setCommandAt(i(), e.currentTarget.value)}
                      />
                    </div>
                    <div class="wizard-row">
                      <span class="muted" style={{ width: "5ch" }}>cwd</span>
                      <input
                        class="wizard-input" placeholder="(workspace folder)"
                        value={cwds()[i()] ?? ""}
                        onInput={(e) => setCwdAt(i(), e.currentTarget.value)}
                      />
                      <button onClick={() => browseCwdAt(i())}>Browse…</button>
                    </div>
                  </div>
                );
              })()}
            </Show>
          </div>
        </div>

        <footer class="wizard-foot">
          <button onClick={() => props.onClose()}>Cancel</button>
          <span class="spacer" />
          <button class="primary" onClick={launch}>Launch</button>
        </footer>
      </div>
    </div>
  );
}
