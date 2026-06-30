// App-wide preferences (everything the Settings page configures except the active theme,
// which has its own store in ./theme). A single reactive `createStore` is the source of
// truth; components read `settings.<field>` reactively and call `setSetting`. The whole
// object is persisted as one JSON blob under the "settings" key and reloaded at startup.
//
// Terminal-shaping fields (font/cursor/scrollback) are applied live to every open pane via
// reactive effects in Terminal.tsx — changing one here restyles all panes without respawn.

import { createStore } from "solid-js/store";
import { FONT_FAMILY, FONT_SIZE } from "../lib/theme";
import { loadState, saveState } from "../lib/persist";
import { DEFAULT_KEYBINDINGS, type ActionId, type Keybindings } from "../lib/keybindings";

const STORE_KEY = "settings";

export type CursorStyle = "block" | "bar" | "underline";

/** Top-bar nav items that can be shown/hidden from Settings (Settings itself is always shown
 *  so this config stays reachable). */
export type NavItemId = "overview" | "palette";

export interface Settings {
  // ---- Appearance (terminal text) ----
  fontFamily: string;
  fontSize: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  scrollback: number;
  // ---- Terminal behaviour ----
  copyOnSelect: boolean;
  middleClickPaste: boolean;
  // ---- New terminals ----
  /** Shell binary new panes launch (empty = the OS `$SHELL`, then bash/sh). */
  defaultShell: string;
  /** Working folder the wizard pre-fills and plain shells fall back to (empty = `$HOME`). */
  defaultCwd: string;
  // ---- External editor ----
  /** Command the top-bar "Editor" button runs on the focused pane's working folder (empty =
   *  button does nothing but prompt). The folder is appended as the last argument, unless the
   *  command contains a `{dir}` token, which is replaced with it (e.g. `code`, `subl`, `zed`). */
  editorCommand: string;
  // ---- Safety ----
  /** Ask before closing a pane/workspace that still has a live process. */
  confirmClose: boolean;
  /** Ask before another pane's `th spawn` (ADR-0007 bus) opens a pane running its command —
   *  the one cross-pane op that runs an arbitrary command with no visible keystrokes. */
  confirmExternalSpawn: boolean;
  // ---- Notifications ----
  /** Pop a desktop notification when a pane raises attention while Termhaus is unfocused. */
  notifyOnAttention: boolean;
  // ---- Window / tray ----
  /** Global hotkey that summons/hides the window from anywhere (Tauri accelerator; "" = off). */
  globalHotkey: string;
  /** Close button hides to the tray instead of quitting (Quit from the tray menu still exits). */
  closeToTray: boolean;
  // ---- Session logging ----
  /** Append each pane's raw output to a per-pane file under <config>/logs/ (opt-in). */
  sessionLogging: boolean;
  // ---- Keyboard ----
  /** Final key for each app shortcut; the Ctrl+Shift prefix is fixed (ADR-0005). */
  keybindings: Keybindings;
  // ---- Layout ----
  /** Which top-bar nav items are visible (Settings is always shown and isn't listed here). */
  navVisible: Record<NavItemId, boolean>;
  /** Width (px) of the left workspace rail; drag its right edge to resize. */
  railWidth: number;
  /** Collapse the workspace rail to a slim icon strip (toggle in the rail header). */
  railCollapsed: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  fontFamily: FONT_FAMILY,
  fontSize: FONT_SIZE,
  cursorStyle: "block",
  cursorBlink: true,
  scrollback: 5000,
  copyOnSelect: false,
  middleClickPaste: false,
  defaultShell: "",
  defaultCwd: "",
  editorCommand: "code",
  confirmClose: true,
  confirmExternalSpawn: true,
  notifyOnAttention: false,
  globalHotkey: "CommandOrControl+Alt+Backquote",
  closeToTray: false,
  sessionLogging: false,
  keybindings: { ...DEFAULT_KEYBINDINGS },
  navVisible: { overview: true, palette: true },
  railWidth: 212,
  railCollapsed: false,
};

const [settings, setStore] = createStore<Settings>({ ...DEFAULT_SETTINGS });

/** Reactive read-only view for components. */
export { settings };

function persist() {
  void saveState(STORE_KEY, JSON.stringify(settings));
}

/** Update one setting and persist. */
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  setStore(key, value);
  persist();
}

/** Show or hide a top-bar nav item. */
export function setNavVisible(id: NavItemId, on: boolean) {
  setStore("navVisible", id, on);
  persist();
}

/** Terminal font-size bounds (mirrors the Settings slider). */
export const FONT_SIZE_MIN = 9;
export const FONT_SIZE_MAX = 24;

/** Nudge the terminal font size by `delta`, clamped to [FONT_SIZE_MIN, FONT_SIZE_MAX]. Every
 *  open pane restyles + refits live via the appearance effect in Terminal.tsx. */
export function adjustFontSize(delta: number) {
  const next = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, settings.fontSize + delta));
  if (next !== settings.fontSize) setSetting("fontSize", next);
}

/** Restore every setting to its default and persist. */
export function resetSettings() {
  setStore({ ...DEFAULT_SETTINGS, keybindings: { ...DEFAULT_KEYBINDINGS } });
  persist();
}

/** Rebind one action to a new final key (the Ctrl+Shift prefix is fixed). */
export function setKeybinding(action: ActionId, key: string) {
  setStore("keybindings", action, key.toLowerCase());
  persist();
}

/** Restore one action to its default key. */
export function resetKeybinding(action: ActionId) {
  setStore("keybindings", action, DEFAULT_KEYBINDINGS[action]);
  persist();
}

/** Restore every shortcut to its default. */
export function resetKeybindings() {
  setStore("keybindings", { ...DEFAULT_KEYBINDINGS });
  persist();
}

/** Load saved settings (merged over defaults so new fields get sane values). Call once at startup. */
export async function initSettings() {
  try {
    const raw = await loadState(STORE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Settings>;
      // Merge over defaults: tolerate older blobs missing newer fields, drop unknown keys.
      const merged: Settings = { ...DEFAULT_SETTINGS };
      for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
        if (saved[k] !== undefined) (merged as unknown as Record<string, unknown>)[k] = saved[k];
      }
      // Deep-merge keybindings over defaults so actions added in a later version still get a
      // key when an older blob is loaded (and stray actions in the blob are dropped).
      merged.keybindings = { ...DEFAULT_KEYBINDINGS, ...(saved.keybindings ?? {}) };
      // Deep-merge nav visibility too, so a nav item added in a later version defaults to shown.
      merged.navVisible = { ...DEFAULT_SETTINGS.navVisible, ...(saved.navVisible ?? {}) };
      setStore(merged);
    }
  } catch (e) {
    console.error("failed to load settings", e);
  }
}
