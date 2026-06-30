// VSCode-style custom title bar. Replaces the native window frame (decorations:false in
// tauri.conf.json), so this bar owns: the app icon + name, a flat row of app-action buttons,
// a draggable region (data-tauri-drag-region), and the min/maximize/close window controls.
//
// Actions reuse the same entry points as the rail/keyboard: Settings is passed down from
// App; Overview and the Command Palette fire through the store / the window events App already
// listens for. (New workspace lives in the rail header; save-as-preset in the palette — none
// need a button here.)

import { Show } from 'solid-js';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { appState, toggleOverview, setOverview } from '../stores/workspace';
import { settings } from '../stores/settings';
import appIcon from '../assets/app-icon.svg';

export default function TitleBar(props: {
  onSettings: () => void;
  onShortcuts: () => void;
  settingsOn: () => boolean;
  paletteOn: () => boolean;
}) {
  const win = getCurrentWindow();
  const openPalette = () =>
    window.dispatchEvent(new CustomEvent('termhaus:command-palette'));

  return (
    <header class="titlebar" data-tauri-drag-region>
      <button class="tb-brand" title="Overview" onClick={() => setOverview(false)}>
        <img class="tb-logo" src={appIcon} alt="" width="20" height="20" />
        <span class="tb-name">Termhaus</span>
      </button>

      <nav class="tb-actions">
        <Show when={settings.navVisible.overview}>
          <button
            class="tb-btn"
            classList={{ on: appState.overview }}
            title="Overview / fleet glance (Ctrl+Shift+O)"
            onClick={() => toggleOverview()}
          >
            Overview
          </button>
        </Show>
        <Show when={settings.navVisible.palette}>
          <button
            class="tb-btn"
            classList={{ on: props.paletteOn() }}
            title="Command palette (Ctrl+Shift+P)"
            onClick={openPalette}
          >
            Palette
          </button>
        </Show>
        <button
          class="tb-btn"
          classList={{ on: props.settingsOn() }}
          title="Settings"
          onClick={() => props.onSettings()}
        >
          Settings
        </button>
        <button
          class="tb-btn tb-btn-icon"
          title="Keyboard shortcuts (Ctrl+Shift+?)"
          onClick={() => props.onShortcuts()}
        >
          ⌨
        </button>
      </nav>

      <div class="tb-spacer" data-tauri-drag-region />

      <div class="tb-window">
        <button
          class="tb-wbtn"
          title="Minimize"
          onClick={() => void win.minimize()}
        >
          ﹣
        </button>
        <button
          class="tb-wbtn"
          title="Maximize"
          onClick={() => void win.toggleMaximize()}
        >
          ▢
        </button>
        <button
          class="tb-wbtn close"
          title="Close"
          onClick={() => void win.close()}
        >
          ✕
        </button>
      </div>
    </header>
  );
}
