// src/main/window.ts — secure BrowserWindow creation + the summon/focus globalShortcut.
//
// Security posture (locked per BUILD_GUIDE step 2): contextIsolation ON, sandbox ON,
// nodeIntegration OFF. The renderer reaches MAIN only through the preload contextBridge.
// The MAIN_WINDOW_VITE_* magic constants are injected by @electron-forge/plugin-vite and
// typed via forge.env.d.ts — do NOT redeclare them.
import { BrowserWindow, globalShortcut } from 'electron';
import path from 'node:path';
import { CH } from '../shared/ipc';

const SUMMON_ACCELERATOR = 'CommandOrControl+Shift+Space';
const MUTE_ACCELERATOR = 'CommandOrControl+Shift+M';
const FLOATING_WINDOW_FLAG = process.env.COMPANION_FLOATING_WINDOW === '1';
const FLOATING_WINDOW_SIZE = {
  width: 380,
  height: 400,
} as const;
const FLOATING_WINDOW_ASPECT_RATIO = FLOATING_WINDOW_SIZE.width / FLOATING_WINDOW_SIZE.height;

export function createWindow(): BrowserWindow {
  // Renderer-safe runtime config, sourced from MAIN's process.env (populated by
  // dotenv in src/main.ts). Only the Vapi PUBLIC key + non-secret URLs/ids cross
  // into the renderer; private keys stay in MAIN. Passed via additionalArguments
  // (a single argv element — these values contain no spaces).
  const companionCfg = {
    vapiPublicKey: process.env.VAPI_PUBLIC_KEY ?? '',
    vapiAssistantId: process.env.VAPI_ASSISTANT_ID ?? '',
    customLlmUrl: process.env.VAPI_PROXY_URL ?? 'http://127.0.0.1:8787',
    customLlmModel: process.env.NEBIUS_MODEL ?? 'deepseek-ai/DeepSeek-V3.2',
    modelUrl: process.env.LIVE2D_MODEL_URL ?? '/live2d/model.model3.json',
    floatingWindow: FLOATING_WINDOW_FLAG,
  };

  const mainWindow = new BrowserWindow({
    title: 'Nero',
    width: FLOATING_WINDOW_FLAG ? FLOATING_WINDOW_SIZE.width : 1024,
    height: FLOATING_WINDOW_FLAG ? FLOATING_WINDOW_SIZE.height : 768,
    frame: !FLOATING_WINDOW_FLAG,
    transparent: FLOATING_WINDOW_FLAG,
    backgroundColor: FLOATING_WINDOW_FLAG ? '#00000000' : '#0e1018',
    hasShadow: !FLOATING_WINDOW_FLAG,
    acceptFirstMouse: FLOATING_WINDOW_FLAG,
    alwaysOnTop: FLOATING_WINDOW_FLAG,
    fullscreenable: !FLOATING_WINDOW_FLAG,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), // compiled name is .js
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: ['--companion-cfg=' + JSON.stringify(companionCfg)],
    },
  });

  if (FLOATING_WINDOW_FLAG) {
    mainWindow.setAspectRatio(FLOATING_WINDOW_ASPECT_RATIO);
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    mainWindow.setFullScreenable(false);
  }

  // Keep the template's MAIN_WINDOW_VITE_* loading logic (dev server vs packaged file).
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  return mainWindow;
}

/**
 * Register the global summon/toggle shortcut. register() returns false (does not throw)
 * if the accelerator is already taken — we log loud on failure. Call after whenReady.
 */
export function registerSummonShortcut(): void {
  const summonOk = globalShortcut.register(SUMMON_ACCELERATOR, () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isVisible() && win.isFocused()) {
      win.hide();
    } else {
      if (FLOATING_WINDOW_FLAG) {
        win.showInactive();
      } else {
        win.show();
        win.focus();
      }
    }
  });
  if (!summonOk) {
    console.error(
      `[main] globalShortcut '${SUMMON_ACCELERATOR}' registration failed (already taken)`,
    );
  }

  const muteOk = globalShortcut.register(MUTE_ACCELERATOR, () => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(CH.micToggleMute);
    }
  });
  if (!muteOk) {
    console.error(
      `[main] globalShortcut '${MUTE_ACCELERATOR}' registration failed (already taken)`,
    );
  }
}

/** Unregister all global shortcuts (call on will-quit). */
export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll();
}
