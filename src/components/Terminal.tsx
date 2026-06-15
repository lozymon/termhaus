// M2 pane: a title bar + one xterm.js instance bound to one Rust PTY. The pane owns its
// PTY lifecycle (spawn/write/resize/kill/respawn); the workspace store owns its place in
// the layout tree, its name, focus, and zoom. Canvas renderer (ADR-0006); fit addon drives
// pty_resize; Ctrl+Shift shortcuts are intercepted before the PTY (ADR-0005).
//
// M5 polish: shared theme/font, unicode11 widths, clickable web links (opened via the OS),
// copy/paste through the OS clipboard, and a per-pane scrollback search overlay — all on the
// Ctrl+Shift namespace, so plain Ctrl+C still reaches the PTY as SIGINT.

import { onMount, onCleanup, createEffect, createSignal, Show } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { homeDir } from "@tauri-apps/api/path";
import "@xterm/xterm/css/xterm.css";

import { spawnPty, writePty, resizePty, killPty, cwdPty, busyPty, foregroundPty, retargetPty } from "../lib/ptyClient";
import { detachPaneToWindow, detachedHandle, forgetDetached } from "../lib/detach";
import { gitBranch } from "../lib/gitClient";
import { captureRegion } from "../lib/capture";
import { sessionLogPath } from "../lib/sessionLog";
import { registerPane, unregisterPane } from "../lib/paneRegistry";
import { stashScrollback, takeScrollback } from "../lib/scrollback";
import { notifyAttention } from "../lib/notify";
import { activity, noteUnseen, noteBell, setBusy, noteAttention, seePane, forgetPane, clearStatus } from "../stores/activity";
import { currentTheme } from "../stores/theme";
import { settings, adjustFontSize } from "../stores/settings";
import { actionForKey, isModifierKey, SWITCH_WORKSPACE_ACTIONS, type ActionId } from "../lib/keybindings";
import { detectAgent } from "../lib/agents";
import type { PaneId, PtyHandle } from "../ipc/protocol";
import {
  appState,
  focusPane,
  focusDir,
  splitPane,
  closePane,
  clearPaneCommand,
  toggleZoom,
  toggleOverview,
  toggleBroadcastTarget,
  switchWorkspaceRelative,
  switchWorkspaceIndex,
  swapPanes,
  type WorkspaceUI,
} from "../stores/workspace";

// Resolved once and cached: collapse a leading $HOME to "~" in the title-bar path. Resolves
// async; until it lands paths show in full, and the next poll picks up the abbreviation.
let homePrefix: string | null = null;
void homeDir().then((h) => { homePrefix = h.replace(/\/+$/, ""); }).catch(() => {});

function prettyCwd(dir: string): string {
  if (homePrefix && (dir === homePrefix || dir.startsWith(homePrefix + "/"))) {
    return "~" + dir.slice(homePrefix.length);
  }
  return dir;
}

/** Last segment of a path — the pane's folder-derived display name (e.g. "termhaus"). Accepts
 * both `/` and `\` so a Windows cwd (`C:\Users\me\proj`) resolves to its final segment. */
function basename(dir: string): string {
  const p = dir.replace(/[\\/]+$/, "");
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) || p : p;
}

export default function TerminalPane(props: { paneId: PaneId; ws: WorkspaceUI }) {
  let container!: HTMLDivElement;
  let term!: Terminal;
  let fit!: FitAddon;
  let search!: SearchAddon;
  // Serializes this pane's buffer for the scrollback handoff on tear-off / re-dock (see scrollback.ts).
  let serialize!: SerializeAddon;
  let searchInput: HTMLInputElement | undefined;
  // The live PTY handle, or null before first spawn / after the child exits.
  let handle: PtyHandle | null = null;
  // Set true while tearing this pane off into its own window, so onCleanup unmounts the xterm
  // WITHOUT killing the PTY — the detached window takes over the live stream.
  let detaching = false;
  const [dead, setDead] = createSignal<number | null>(null);
  const [finding, setFinding] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [dragOver, setDragOver] = createSignal(false);
  // Live shell location for the title bar: cwd (via /proc, ADR-0001's carve-out) + git branch.
  const [cwd, setCwd] = createSignal<string | null>(null);
  const [branch, setBranch] = createSignal<string | null>(null);
  // The live foreground command in this pane (polled from /proc), or null at the prompt.
  const [foreground, setForeground] = createSignal<string | null>(null);

  const spec = () => props.ws.panes[props.paneId];
  // Which AI agent (if any) this pane is running — drives the title-bar badge. Prefer the live
  // foreground process (catches `claude` launched via the ✦ button or typed by hand), and fall
  // back to the launch command (covers the gap before the first /proc poll). Both are metadata,
  // never pane output (opacity-safe; see agents.ts + ADR-0001).
  const agent = () => detectAgent(foreground()) ?? detectAgent(spec()?.command);
  const isFocused = () => props.ws.focused === props.paneId;
  const inBroadcast = () => props.ws.broadcast.includes(props.paneId);
  /** Is the user actually looking at this pane right now? (active workspace + focused) */
  const looking = () => appState.activeId === props.ws.id && isFocused();
  const act = () => activity[props.paneId];

  // The name shown in the title bar is the live folder (cwd basename) — it tracks `cd` so the bar
  // always tells you *where* the pane is. The pool name (Faye…) is only the fallback before the
  // first cwd read, and stays the pane's routing handle for `th send`/broadcast (folder names
  // aren't unique) — only the display changes.
  const displayName = () => {
    const d = cwd();
    return d ? basename(d) : (spec()?.title ?? "");
  };

  // Stream bytes into xterm; flag unseen output when this pane isn't being looked at (ADR-0001:
  // we react to the *fact* of output, never its content). Shared by spawn + re-dock binding.
  const onOutput = (bytes: Uint8Array) => {
    term.write(bytes);
    if (!looking()) noteUnseen(props.paneId);
  };
  const onExit = (code: number) => {
    handle = null;
    setBusy(props.paneId, null);
    setForeground(null);
    term.write(`\r\n\x1b[2m[process exited: ${code}]\x1b[0m\r\n`);
    setDead(code);
  };

  /** Spawn a fresh PTY and bind it to this pane's xterm — or, when re-docking from a torn-off
   *  window, rebind to the *existing* PTY (no respawn). Used for first run, respawn, and re-dock. */
  async function start() {
    if (handle !== null) return;
    setDead(null);

    // Re-docking: a saved handle means this pane is a live PTY coming back from its own window.
    // Reclaim its output stream instead of spawning a new shell.
    const reattach = detachedHandle(props.paneId);
    if (reattach !== null) {
      try {
        handle = reattach;
        // Replay the buffer the detached window serialized on close, then resume the live stream so
        // new output appends after the restored history (vs the grid coming back blank).
        const snap = takeScrollback(reattach);
        if (snap) term.write(snap);
        await retargetPty(reattach, onOutput, onExit);
        if (handle !== null) void resizePty(handle, term.cols, term.rows);
      } catch (e) {
        handle = null;
        term.write(`\r\n\x1b[31mfailed to re-dock pane: ${e}\x1b[0m\r\n`);
      } finally {
        forgetDetached(props.paneId);
      }
      return;
    }

    // Resolve the opt-in session-log path (same file across respawns; null if logging off).
    const logPath = settings.sessionLogging
      ? (await sessionLogPath(props.ws.name, spec()?.title ?? "", props.paneId)) ?? undefined
      : undefined;
    try {
      handle = await spawnPty(
        {
          cols: term.cols,
          rows: term.rows,
          command: spec()?.command,
          // Per-pane cwd wins (e.g. a `th spawn --cwd …` pane), then the workspace folder.
          cwd: spec()?.cwd || props.ws.cwd || settings.defaultCwd || undefined,
          shell: settings.defaultShell || undefined,
          name: spec()?.title,
          logPath,
        },
        onOutput,
        onExit,
      );
    } catch (e) {
      term.write(`\r\n\x1b[31mfailed to spawn pty: ${e}\x1b[0m\r\n`);
    }
  }

  /** Tear this pane off into its own window: hand the live PTY's output to a new window and let
   *  the main grid show a placeholder until that window closes (the PTY itself never stops). */
  async function detachPane() {
    if (handle === null) return; // a dead pane has nothing to tear off
    detaching = true; // tell onCleanup not to kill the PTY when this Terminal unmounts
    // Snapshot the painted buffer so the new window can replay it — retargetPty only moves the live
    // stream, so without this the torn-off pane would start blank (history lives in xterm, not the PTY).
    stashScrollback(handle, serialize);
    try {
      await detachPaneToWindow(props.paneId, handle, spec()?.title ?? displayName());
    } catch {
      detaching = false; // window didn't open — detachPaneToWindow already re-docked us
    }
  }

  // ---- Clipboard (OS, via Tauri — reliable under WebKitGTK) --------------------------
  async function copySelection(): Promise<boolean> {
    const sel = term.getSelection();
    if (!sel) return false;
    try { await writeText(sel); } catch (e) { console.error("clipboard write failed", e); }
    return true;
  }

  async function pasteClipboard() {
    try {
      const text = await readText();
      if (text && handle !== null) void writePty(handle, text);
    } catch (e) {
      console.error("clipboard read failed", e);
    }
  }

  // Capture a screen region → PNG, then type its path into this pane (with a trailing space,
  // no Enter) so it lands in the prompt — e.g. a Claude Code message referencing the image.
  async function captureToPane() {
    try {
      const path = await captureRegion();
      if (path && handle !== null) {
        await writePty(handle, `${path} `);
        term.focus();
      }
    } catch (e) {
      // A cancelled selection or a missing screenshot tool both land here. A missing tool is
      // otherwise invisible (it looks like a dead shortcut), so for that case type a harmless
      // shell comment into the pane as an install hint; the user can run it (a no-op) or clear
      // it. Cancellation stays silent. The marker substring is set in capture.rs.
      const msg = String((e as { message?: string })?.message ?? e);
      if (msg.includes("no screenshot tool") && handle !== null) {
        await writePty(handle, "# Termhaus: screenshot tool not found — install flameshot or gnome-screenshot ");
        term.focus();
      }
      console.error("region capture failed", e);
    }
  }

  // Launch the Claude CLI in this pane's shell. The shell is already sitting in the
  // terminal's current directory, so a bare `claude` runs in exactly that cwd.
  function launchClaude() {
    if (handle === null) return;
    void writePty(handle, "claude\n");
    term.focus();
  }

  // ---- Title-bar location (cwd + git branch) -----------------------------------------
  // Panes are opaque (ADR-0001) — we can't watch the shell's output for `cd`, so we poll
  // /proc for the live cwd and derive the branch from it. Cheap: one /proc readlink + one
  // `git rev-parse` per tick, only while this pane's workspace is visible.
  async function refreshLoc() {
    if (handle === null) { setCwd(null); setBranch(null); setForeground(null); setBusy(props.paneId, null); return; }
    // Busy state (running a command vs. at the prompt) — a cheap foreground-pgrp read. A
    // busy→idle transition in a pane you're not watching means a command just finished and the
    // shell is back at its prompt → raise the sticky attention border (cleared when you look).
    // It's the foreground-pgrp fact, never pane output (opacity-safe; ADR-0001).
    try {
      const wasBusy = act()?.busy === true;
      const nowBusy = await busyPty(handle);
      if (wasBusy && nowBusy === false && !looking() && noteAttention(props.paneId)) {
        void notifyAttention(displayName() || `Pane ${props.paneId}`, props.ws.name);
      }
      setBusy(props.paneId, nowBusy);
    } catch { /* leave last value */ }
    // The live foreground command, for the agent badge (e.g. `claude`); null at the prompt.
    try { setForeground(await foregroundPty(handle)); } catch { /* leave last value */ }
    let dir: string | null = null;
    try { dir = await cwdPty(handle); } catch { return; }
    setCwd(dir);
    if (!dir) { setBranch(null); return; }
    try { setBranch(await gitBranch(dir)); } catch { setBranch(null); }
  }

  // ---- Search overlay ----------------------------------------------------------------
  const SEARCH_OPTS = {
    decorations: {
      matchBackground: "#5b8cff66", matchOverviewRuler: "#5b8cff",
      activeMatchBackground: "#e0b85a", activeMatchColorOverviewRuler: "#e0b85a",
    },
  };
  function openSearch() {
    setFinding(true);
    queueMicrotask(() => searchInput?.focus());
  }
  function closeSearch() {
    setFinding(false);
    search.clearDecorations();
    term.focus();
  }
  function findNext() { if (query()) search.findNext(query(), SEARCH_OPTS); }
  function findPrev() { if (query()) search.findPrevious(query(), SEARCH_OPTS); }

  // ---- Scrollback read (th read) -----------------------------------------------------
  // Return the last `lines` rows of this pane's buffer as plain text. Only reached on an
  // explicit inbound `th read` request (ADR-0007), never to drive Termhaus's own UI.
  function readScrollback(lines: number): string {
    const buf = term.buffer.active;
    const total = buf.length; // scrollback + viewport rows
    const want = Math.max(1, Math.min(lines, total));
    const out: string[] = [];
    for (let i = total - want; i < total; i++) {
      const line = buf.getLine(i);
      out.push(line ? line.translateToString(true) : "");
    }
    // Drop trailing blank lines (the empty viewport below the prompt) for a tidy capture.
    while (out.length > 1 && out[out.length - 1] === "") out.pop();
    return out.join("\n");
  }

  onMount(async () => {
    term = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      scrollback: settings.scrollback,
      cursorStyle: settings.cursorStyle,
      cursorBlink: settings.cursorBlink,
      allowProposedApi: true, // required by the unicode11 addon
      theme: currentTheme().terminal,
    });

    fit = new FitAddon();
    search = new SearchAddon();
    serialize = new SerializeAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(serialize);
    term.loadAddon(new WebLinksAddon((_e, uri) => { void openUrl(uri); }));
    const uni = new Unicode11Addon();
    term.loadAddon(uni);
    term.unicode.activeVersion = "11";
    term.open(container);
    try {
      term.loadAddon(new CanvasAddon());
    } catch (e) {
      console.error("canvas renderer unavailable, using DOM renderer", e);
    }
    fit.fit();

    // Restyle live when the active theme changes — every open pane reacts.
    createEffect(() => {
      term.options.theme = currentTheme().terminal;
    });

    // Live-apply appearance settings. Font changes alter the cell size, so refit + tell the
    // PTY its new cols/rows; cursor/scrollback are pure xterm option flips.
    createEffect(() => {
      term.options.fontFamily = settings.fontFamily;
      term.options.fontSize = settings.fontSize;
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        fit.fit();
        if (handle !== null) void resizePty(handle, term.cols, term.rows);
      }
    });
    createEffect(() => {
      term.options.cursorStyle = settings.cursorStyle;
      term.options.cursorBlink = settings.cursorBlink;
      term.options.scrollback = settings.scrollback;
    });

    // Poll the cwd/branch only while this workspace is on screen — hidden layers don't burn
    // /proc reads or git calls (CLAUDE.md: throttle hidden Workspaces). The effect re-runs on
    // activeId changes, tearing down the old interval first via onCleanup.
    createEffect(() => {
      if (appState.activeId !== props.ws.id) return;
      void refreshLoc();
      const t = setInterval(() => void refreshLoc(), 2000);
      onCleanup(() => clearInterval(t));
    });

    // Repaint when this workspace is shown again. Hidden workspaces are display:none'd, and the
    // canvas renderer under WebKitGTK leaves a blank surface behind — so after a workspace
    // switch the terminal looks black until a click forces a redraw. On becoming active, wait
    // one frame for display:block to land (so the box has real dimensions), re-fit (it may have
    // been resized while hidden), then force a full refresh.
    createEffect(() => {
      if (appState.activeId !== props.ws.id) return;
      const raf = requestAnimationFrame(() => {
        if (container.clientWidth === 0 || container.clientHeight === 0) return;
        fit.fit();
        if (handle !== null) void resizePty(handle, term.cols, term.rows);
        term.refresh(0, term.rows - 1);
      });
      onCleanup(() => cancelAnimationFrame(raf));
    });

    // Keep real keyboard focus in sync with the focus ring. When this pane becomes the
    // workspace's focused pane (e.g. via Ctrl+Shift+arrow nav, which only moves the store's
    // `focused`), pull DOM focus onto its xterm — otherwise typing and the *next* nav keypress
    // would still target the previously-focused pane. Guard to the active workspace so hidden
    // layers don't grab focus, and skip while the title/search inputs are taking input.
    createEffect(() => {
      if (appState.activeId === props.ws.id && isFocused() && !finding()) {
        term.focus();
      }
    });

    // The terminal bell (BEL) is an attention signal — agents/builds often ring on
    // done/needs-input. Note it unless you're already looking at this pane.
    term.onBell(() => { if (!looking()) noteBell(props.paneId); });

    // Clear a pane's sticky unseen/bell signals the moment you look at it (focus it in the
    // active workspace). Separate from the focus-pull effect so it isn't gated on editing/find.
    createEffect(() => { if (looking()) seePane(props.paneId); });

    // Copy-on-select (optional): mirror any selection straight to the OS clipboard.
    term.onSelectionChange(() => {
      if (!settings.copyOnSelect) return;
      const sel = term.getSelection();
      if (sel) void writeText(sel).catch((e) => console.error("clipboard write failed", e));
    });

    // Middle-click paste (optional, classic X11 behaviour) — paste into the PTY.
    container.addEventListener("auxclick", (e) => {
      if (e.button === 1 && settings.middleClickPaste) { e.preventDefault(); void pasteClipboard(); }
    });

    // App shortcuts live in the Ctrl+Shift namespace (ADR-0005). Intercept them before the
    // PTY; everything else (Ctrl+C SIGINT, arrows, fn keys) passes through untouched. The
    // final key of each combo is user-configurable — look it up in the live bindings map.
    const ACTIONS: Record<ActionId, () => void> = {
      "focus-up": () => focusDir(props.paneId, "up"),
      "focus-down": () => focusDir(props.paneId, "down"),
      "focus-left": () => focusDir(props.paneId, "left"),
      "focus-right": () => focusDir(props.paneId, "right"),
      "split-right": () => splitPane(props.paneId, "row"),
      "split-down": () => splitPane(props.paneId, "col"),
      "close-pane": () => closePane(props.paneId),
      "toggle-zoom": () => toggleZoom(props.paneId),
      "new-workspace": () => window.dispatchEvent(new CustomEvent("termhaus:new-workspace")),
      "command-palette": () => window.dispatchEvent(new CustomEvent("termhaus:command-palette")),
      "source-control": () => window.dispatchEvent(new CustomEvent("termhaus:source-control")),
      "docs": () => window.dispatchEvent(new CustomEvent("termhaus:docs")),
      "settings": () => window.dispatchEvent(new CustomEvent("termhaus:settings")),
      "overview": () => toggleOverview(),
      "shortcuts": () => window.dispatchEvent(new CustomEvent("termhaus:shortcuts")),
      "preview": () => window.dispatchEvent(new CustomEvent("termhaus:preview")),
      "prev-workspace": () => switchWorkspaceRelative(-1),
      "next-workspace": () => switchWorkspaceRelative(1),
      // Ctrl+Shift+1…9 → jump straight to workspace N.
      ...(Object.fromEntries(
        SWITCH_WORKSPACE_ACTIONS.map((id, i) => [id, () => switchWorkspaceIndex(i)]),
      ) as Record<(typeof SWITCH_WORKSPACE_ACTIONS)[number], () => void>),
      "copy": () => void copySelection(), // no selection → no-op
      "paste": () => void pasteClipboard(),
      "search": () => openSearch(),
      "capture-region": () => void captureToPane(),
      "font-increase": () => adjustFontSize(1),
      "font-decrease": () => adjustFontSize(-1),
    };
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return true;
      if (isModifierKey(e.key)) return true;
      const action = actionForKey(settings.keybindings, e.key);
      if (!action) return true;
      // Stop the webview's native handling too. WebKitGTK treats Ctrl+Shift+V / Ctrl+Shift+C
      // as clipboard shortcuts: without preventDefault it would *also* paste into the textarea
      // (firing xterm's onData) on top of our pasteClipboard(), doubling the input.
      e.preventDefault();
      ACTIONS[action]();
      return false;
    });

    term.onData((data) => {
      if (handle !== null) void writePty(handle, data);
    });
    term.textarea?.addEventListener("focus", () => focusPane(props.paneId));

    // Publish this pane to the broadcast router. `handle` reflects live/dead via closure,
    // so a Restart re-arms reach without re-registering.
    registerPane(props.paneId, {
      write: (data) => { if (handle !== null) void writePty(handle, data); },
      isLive: () => handle !== null,
      cwd: () => (handle !== null ? cwdPty(handle) : Promise.resolve(null)),
      read: (lines) => readScrollback(lines),
    });

    // Refit + tell the PTY whenever the box resizes (split, drag, zoom, window). Skip when
    // hidden (zoom) — a 0-size box would compute nonsense cols/rows.
    //
    // fit.fit() reflows xterm's whole scrollback to the new column count — too heavy to run
    // every frame of a gutter drag (that's the resize stutter). The CSS box already tracks
    // the pointer 1:1, so we debounce the reflow: it fires once movement settles (~100ms),
    // keeping discrete resizes (split/zoom/window) imperceptibly delayed while a live drag
    // stays smooth.
    let settle = 0;
    const refit = () => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      fit.fit();
      if (handle !== null) void resizePty(handle, term.cols, term.rows);
      // Force a repaint too: a box going from hidden→shown (un-zoom, window restore) keeps a
      // blank canvas under WebKitGTK until xterm redraws it.
      term.refresh(0, term.rows - 1);
    };
    const ro = new ResizeObserver(() => {
      clearTimeout(settle);
      settle = window.setTimeout(refit, 100);
    });
    ro.observe(container);

    onCleanup(() => {
      clearTimeout(settle);
      ro.disconnect();
      unregisterPane(props.paneId);
      forgetPane(props.paneId);
      // Detaching hands the PTY to another window — keep it alive; otherwise this unmount is a
      // real close, so kill the child.
      if (handle !== null && !detaching) void killPty(handle);
      term.dispose();
    });

    await start();
  });

  return (
    <div
      class="pane"
      classList={{
        focused: isFocused(),
        attention: !isFocused() && (act()?.attention ?? false),
        agented: !!agent(),
        "bcast-target": appState.broadcastSelecting && inBroadcast(),
        "drag-over": dragOver(),
      }}
      style={agent() ? { "--agent-color": agent()!.color } : undefined}
      onPointerDown={() => focusPane(props.paneId)}
      onDragOver={(e) => { e.preventDefault(); if (!dragOver()) setDragOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const src = Number(e.dataTransfer?.getData("text/plain"));
        if (src) swapPanes(src, props.paneId);
      }}
    >
      <div class="pane-title">
        <Show when={appState.broadcastSelecting}>
          <button
            class="bcast-toggle"
            classList={{ on: inBroadcast() }}
            title={inBroadcast() ? "In broadcast set" : "Add to broadcast set"}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => toggleBroadcastTarget(props.paneId)}
          >
            {inBroadcast() ? "◉" : "○"}
          </button>
        </Show>
        <span
          class="pane-grip"
          title="Drag to swap this pane with another"
          draggable={true}
          onPointerDown={(e) => e.stopPropagation()}
          onDragStart={(e) => {
            e.dataTransfer?.setData("text/plain", String(props.paneId));
            if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
          }}
        >
          ⠿
        </span>
        <span
          class="pane-status"
          classList={{
            bell: act()?.bell ?? false,
            unseen: !(act()?.bell ?? false) && (act()?.unseen ?? false),
            busy: !(act()?.bell ?? false) && !(act()?.unseen ?? false) && act()?.busy === true,
          }}
          title={
            act()?.bell ? "Bell rang" :
            act()?.unseen ? "New output" :
            act()?.busy === true ? "Running a command" : "Idle"
          }
        />
        <Show when={agent()}>
          {(a) => (
            <span
              class="pane-agent"
              style={{ "--agent-color": a().color }}
              title={`Running ${a().label}`}
            >
              {a().icon}
            </span>
          )}
        </Show>
        <span class="pane-name" title={cwd() ? prettyCwd(cwd()!) : (spec()?.title ?? "")}>
          {displayName()}
        </span>
        <Show when={branch()}>
          <span class="pane-branch" title={`git branch: ${branch()}`}>⎇ {branch()}</span>
        </Show>
        <Show when={act()?.status}>
          {(s) => (
            <span class="pane-statuslabel" title={`agent status: ${s()}`}>{s()}</span>
          )}
        </Show>
        <span class="pane-controls">
          <button title="Launch Claude here" onClick={launchClaude}>✦</button>
          <button title="Find (Ctrl+Shift+F)" onClick={openSearch}>⌕</button>
          <button title="Split right (Ctrl+Shift+D)" onClick={() => splitPane(props.paneId, "row")}>▥</button>
          <button title="Split down (Ctrl+Shift+E)" onClick={() => splitPane(props.paneId, "col")}>▤</button>
          <button title="Zoom (Ctrl+Shift+Enter)" onClick={() => toggleZoom(props.paneId)}>
            {props.ws.zoomed === props.paneId ? "▢" : "⤢"}
          </button>
          <button title="Tear off into its own window" onClick={() => void detachPane()}>◳</button>
          <Show when={settings.sessionLogging}>
            <button
              title="View this pane's session log"
              onClick={async () => {
                const path = await sessionLogPath(props.ws.name, spec()?.title ?? "", props.paneId);
                window.dispatchEvent(new CustomEvent("termhaus:view-session-log", { detail: { path: path ?? undefined } }));
              }}
            >≣</button>
          </Show>
          <button title="Close (Ctrl+Shift+W)" onClick={() => closePane(props.paneId)}>✕</button>
        </span>
      </div>

      <div class="pane-term-wrap">
        <Show when={finding()}>
          <div class="pane-search" onPointerDown={(e) => e.stopPropagation()}>
            <input
              ref={searchInput}
              class="pane-search-input"
              placeholder="Find in scrollback"
              value={query()}
              onInput={(e) => { setQuery(e.currentTarget.value); findNext(); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); e.shiftKey ? findPrev() : findNext(); }
                else if (e.key === "Escape") { e.preventDefault(); closeSearch(); }
              }}
            />
            <button title="Previous (Shift+Enter)" onClick={findPrev}>↑</button>
            <button title="Next (Enter)" onClick={findNext}>↓</button>
            <button title="Close (Esc)" onClick={closeSearch}>✕</button>
          </div>
        </Show>
        <div ref={container} class="terminal-pane" />
        <Show when={dead() !== null}>
          {(() => {
            const cmd = () => spec()?.command?.trim() ?? "";
            const prog = () => cmd().split(/\s+/)[0];
            const restart = () => { term.clear(); clearStatus(props.paneId); void start(); };
            const openShell = () => { clearPaneCommand(props.paneId); restart(); };
            return (
              <div class="pane-dead">
                {/* Exit 127 from `$SHELL -lc "<cmd>"` means the program wasn't found — the common
                    case of launching an agent (e.g. copilot) that isn't installed. Say so plainly
                    instead of a bare "process exited (127)", which reads as a crash. */}
                <Show
                  when={dead() === 127 && cmd()}
                  fallback={<span class="pane-dead-msg">process exited ({dead()})</span>}
                >
                  <span class="pane-dead-msg">command not found: {cmd()}</span>
                  <span class="pane-dead-hint">“{prog()}” isn’t installed or not on your PATH</span>
                </Show>
                <div class="pane-dead-actions">
                  <button onClick={restart}>Restart</button>
                  <Show when={cmd()}>
                    <button onClick={openShell}>Open shell instead</button>
                  </Show>
                </div>
              </div>
            );
          })()}
        </Show>
      </div>
    </div>
  );
}
