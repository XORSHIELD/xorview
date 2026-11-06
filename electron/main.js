'use strict';

/**
 * electron/main.js — XorView main process: stealth overlay window, tray,
 * global hotkey, capture orchestration, provider calls, settings IPC.
 *
 * Original code. Standard stealth only: content protection, hide/show
 * hotkey, tray presence with no taskbar entry. No process hiding, no
 * driver tricks, no interference with other software.
 */

const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, desktopCapturer } =
  require('electron');
const path = require('path');
const fs = require('fs');
const { defaults, loadSettings, saveSettings, resolveApiKey, hasApiKey } =
  require('../core/settings');
const providers = require('../core/providers');
const { capturePrimaryScreen } = require('../core/screen');

const SMOKE = process.argv.includes('--smoke') || process.env.XORVIEW_SMOKE === '1';
const FALLBACK_TRAY_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJ9ggg==';

let win = null;
let tray = null;
let settings = defaults();
let listening = false;
let screenTimer = null;
let currentHotkey = null;
let quitting = false;

function log(...args) {
  // Never pass settings or key material here.
  console.log('[xorview]', ...args);
}

/** Settings safe to send to the renderer: key values blanked, presence flagged. */
function publicSettings() {
  return {
    ...settings,
    transcribeApiKey: '',
    chatApiKey: '',
    hasTranscribeKey: hasApiKey('transcribe', settings, process.env),
    hasChatKey: hasApiKey('chat', settings, process.env)
  };
}

function createWindow() {
  win = new BrowserWindow({
    width: 400,
    height: 600,
    minWidth: 320,
    minHeight: 420,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // Standard stealth: exclude from screen capture where supported.
  win.setContentProtection(true);
  win.setOpacity(clampOpacity(settings.opacity));
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
  });
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
      rebuildTrayMenu();
    }
  });
}

function toggleOverlay() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
    win.focus();
  }
  rebuildTrayMenu();
}

function trayIcon() {
  const file = path.join(__dirname, '..', 'assets', 'tray.png');
  try {
    if (fs.existsSync(file)) return nativeImage.createFromPath(file);
  } catch {
    // Fall through to the embedded fallback.
  }
  return nativeImage.createFromDataURL(FALLBACK_TRAY_ICON);
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('XorView');
  tray.on('click', () => toggleOverlay());
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const visible = win && !win.isDestroyed() && win.isVisible();
  const menu = Menu.buildFromTemplate([
    { label: visible ? 'Hide overlay' : 'Show overlay', click: () => toggleOverlay() },
    {
      label: listening ? 'Pause listening' : 'Start listening',
      click: () => {
        listening = !listening;
        if (win && !win.isDestroyed()) win.webContents.send('xorview:listening-change', listening);
        rebuildTrayMenu();
      }
    },
    { label: 'Capture screen now', click: () => void doCapture() },
    {
      label: 'Settings',
      click: () => {
        if (win && !win.isDestroyed()) {
          win.show();
          win.focus();
          win.webContents.send('xorview:open-settings');
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
}

function notifyHotkeyError(hotkey, message) {
  log(`Hotkey registration failed for "${hotkey}": ${message}`);
  if (win && !win.isDestroyed()) {
    win.webContents.send('xorview:hotkey-error', { hotkey, message });
  }
}

function registerHotkey(accelerator) {
  if (currentHotkey) {
    try {
      globalShortcut.unregister(currentHotkey);
    } catch {
      // Best effort.
    }
    currentHotkey = null;
  }
  if (!accelerator || typeof accelerator !== 'string') return false;
  try {
    const ok = globalShortcut.register(accelerator, toggleOverlay);
    if (ok) {
      currentHotkey = accelerator;
      return true;
    }
    notifyHotkeyError(accelerator, 'Another app may already use this shortcut. Tray toggle still works.');
  } catch (err) {
    notifyHotkeyError(accelerator, (err && err.message) || String(err));
  }
  return false;
}

function clampOpacity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.95;
  return Math.min(1, Math.max(0.3, n));
}

function applyAutostart() {
  try {
    app.setLoginItemSettings({ openAtLogin: !!settings.autostart });
  } catch (err) {
    log('Autostart update failed:', (err && err.message) || err);
  }
}

async function doCapture() {
  try {
    const entry = await capturePrimaryScreen(
      desktopCapturer.getSources.bind(desktopCapturer),
      { thumbnailWidth: 960 }
    );
    if (win && !win.isDestroyed()) win.webContents.send('xorview:context', entry);
    return { ok: true, entry };
  } catch (err) {
    return { ok: false, error: { code: 'capture-failed', message: (err && err.message) || String(err) } };
  }
}

function restartScreenLoop() {
  if (screenTimer) {
    clearInterval(screenTimer);
    screenTimer = null;
  }
  if (settings.screenPaused) return;
  const secs = Math.min(600, Math.max(5, Number(settings.screenIntervalSec) || 30));
  screenTimer = setInterval(() => {
    void doCapture();
  }, secs * 1000);
  if (typeof screenTimer.unref === 'function') screenTimer.unref();
}

function errorPayload(err) {
  return { code: (err && err.code) || 'provider', message: (err && err.message) || String(err) };
}

function setupIpc() {
  ipcMain.handle('xorview:settings-get', () => publicSettings());

  ipcMain.handle('xorview:settings-set', (_event, incoming) => {
    if (!incoming || typeof incoming !== 'object') {
      return { ok: false, errors: { _: 'Invalid settings payload.' } };
    }
    // Empty key fields mean "keep the stored key".
    const merged = { ...settings };
    for (const [key, value] of Object.entries(incoming)) {
      if ((key === 'transcribeApiKey' || key === 'chatApiKey') && value === '') continue;
      if (key === 'hasTranscribeKey' || key === 'hasChatKey') continue;
      if (key in merged) merged[key] = value;
    }
    const result = saveSettings(app.getPath('userData'), merged);
    if (!result.ok) return result;
    const hotkeyChanged = merged.hotkey !== settings.hotkey;
    settings = merged;
    if (hotkeyChanged) registerHotkey(settings.hotkey);
    if (win && !win.isDestroyed()) win.setOpacity(clampOpacity(settings.opacity));
    applyAutostart();
    restartScreenLoop();
    return { ok: true, errors: {}, settings: publicSettings() };
  });

  ipcMain.handle('xorview:test-connection', async (_event, slot) => {
    try {
      const useChat = slot !== 'transcribe';
      const baseUrl = useChat ? settings.chatBaseUrl : settings.transcribeBaseUrl;
      const apiKey = resolveApiKey(useChat ? 'chat' : 'transcribe', settings, process.env);
      await providers.testConnection({ baseUrl, apiKey });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorPayload(err) };
    }
  });

  ipcMain.handle('xorview:transcribe-audio', async (_event, payload) => {
    try {
      const audioBuffer = Buffer.from((payload && payload.audioBase64) || '', 'base64');
      const result = await providers.transcribeAudio({
        baseUrl: settings.transcribeBaseUrl,
        apiKey: resolveApiKey('transcribe', settings, process.env),
        model: settings.transcribeModel,
        audioBuffer,
        mimeType: (payload && payload.mimeType) || 'audio/webm',
        language: settings.language
      });
      return { ok: true, text: result.text };
    } catch (err) {
      return { ok: false, error: errorPayload(err) };
    }
  });

  ipcMain.handle('xorview:suggest', async (_event, payload) => {
    try {
      const transcript = payload && typeof payload.transcript === 'string' ? payload.transcript : '';
      const contextNote = payload && typeof payload.contextNote === 'string' ? payload.contextNote : '';
      const result = await providers.chatCompletion({
        baseUrl: settings.chatBaseUrl,
        apiKey: resolveApiKey('chat', settings, process.env),
        model: settings.chatModel,
        messages: [
          {
            role: 'system',
            content:
              'You are an interview assistant. Given a live transcript excerpt and on-screen context, ' +
              'suggest concise, correct answers the candidate can say next. Reply with 2-4 short suggestion ' +
              'cards, one per line, each under 280 characters. No preamble.'
          },
          {
            role: 'user',
            content: `Transcript (latest last):\n${transcript}\n\nOn-screen context:\n${contextNote}`
          }
        ]
      });
      return { ok: true, text: result.text };
    } catch (err) {
      return { ok: false, error: errorPayload(err) };
    }
  });

  ipcMain.handle('xorview:capture-now', async () => doCapture());

  ipcMain.handle('xorview:set-listening', (_event, on) => {
    listening = !!on;
    rebuildTrayMenu();
    return { ok: true, listening };
  });

  ipcMain.handle('xorview:set-click-through', (_event, on) => {
    if (win && !win.isDestroyed()) {
      win.setIgnoreMouseEvents(!!on, { forward: true });
    }
    return { ok: true };
  });

  ipcMain.handle('xorview:toggle', () => {
    toggleOverlay();
    return { ok: true };
  });
}

async function init() {
  settings = loadSettings(app.getPath('userData'));
  setupIpc();
  createWindow();
  createTray();
  registerHotkey(settings.hotkey);
  applyAutostart();
  restartScreenLoop();
  log('ready');
  if (SMOKE) {
    setTimeout(() => {
      log('smoke OK');
      quitting = true;
      app.quit();
    }, 2500);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
    }
  });
  app.whenReady().then(() => void init());
}

// Tray app: closing/hiding all windows must not quit.
app.on('window-all-closed', (event) => {
  event.preventDefault();
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (screenTimer) clearInterval(screenTimer);
});
