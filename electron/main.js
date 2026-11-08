'use strict';

/**
 * electron/main.js — XorView v2 main process: stealth overlay window, tray,
 * global hotkey, capture orchestration, provider calls, settings IPC.
 *
 * Original code. Standard stealth only: content protection, hide/show
 * hotkey, tray presence with no taskbar entry, Alt+Tab exclusion, discreet
 * title, focus-safe show. No process hiding, no driver tricks, no
 * interference with other software.
 *
 * Testability: when globalThis.__XORVIEW_ELECTRON_STUB__ is set, it is used
 * instead of require('electron'); when globalThis.__XORVIEW_NO_AUTOINIT__
 * is set, app wiring is skipped and the exports below drive behavior.
 */

function getElectron() {
  if (globalThis.__XORVIEW_ELECTRON_STUB__) return globalThis.__XORVIEW_ELECTRON_STUB__;
  return require('electron');
}

const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, desktopCapturer } =
  getElectron();
const path = require('path');
const fs = require('fs');
const {
  defaults,
  loadSettingsResult,
  saveSettings,
  mergeSettings,
  resolveApiKey,
  hasApiKey,
  isValidSlot
} = require('../core/settings');
const providers = require('../core/providers');
const voicestudio = require('../core/voicestudio');
const { capturePrimaryScreen } = require('../core/screen');
const suggest = require('../core/suggest');
const profile = require('../core/profile');
const cv = require('../core/cv');

const SMOKE = process.argv.includes('--smoke') || process.env.XORVIEW_SMOKE === '1';
const SMOKE_TIMEOUT_MS = Number(process.env.XORVIEW_SMOKE_TIMEOUT_MS) || 2500;
/** Max base64 chars accepted for one transcription clip (~15 MB audio). */
const TRANSCRIBE_MAX_BASE64 = 20 * 1024 * 1024;
/** Max image data-URL chars forwarded to the chat provider. */
const SUGGEST_MAX_IMAGE_CHARS = 10 * 1024 * 1024;
const TRANSCRIPT_LOG_FILE = 'transcript.log';
/** Discreet overlay window title (never the product name). */
const OVERLAY_TITLE = 'Quick Notes';

const FALLBACK_TRAY_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJ9ggg==';

let win = null;
let tray = null;
let settings = defaults();
let sessionKeys = { transcribe: '', chat: '' };
let settingsNotice = '';
let listening = false;
let clickThrough = false;
let screenTimer = null;
let currentHotkey = null;
let quitting = false;
let smokeFailed = false;

function log(...args) {
  // Never pass settings or key material here.
  console.log('[xorview]', ...args);
}

/** Stored settings plus session-only keys (never persisted unless opted in). */
function effectiveSettings() {
  return {
    ...settings,
    transcribeApiKey: sessionKeys.transcribe || settings.transcribeApiKey || '',
    chatApiKey: sessionKeys.chat || settings.chatApiKey || ''
  };
}

/** Settings safe to send to the renderer: key values blanked, presence flagged. */
function publicSettings() {
  const effective = effectiveSettings();
  return {
    ...settings,
    transcribeApiKey: '',
    chatApiKey: '',
    hasTranscribeKey: hasApiKey('transcribe', effective, process.env),
    hasChatKey: hasApiKey('chat', effective, process.env),
    settingsNotice
  };
}

/**
 * Pure overlay window options (exported for the stub harness).
 * Standard stealth: frameless floating overlay, no taskbar entry, tool
 * window style for Alt+Tab exclusion, discreet title, focusable:false so
 * showing never steals focus, sandboxed renderer.
 */
function buildWindowOptions() {
  return {
    width: 400,
    height: 600,
    minWidth: 320,
    minHeight: 420,
    title: OVERLAY_TITLE,
    type: 'toolbar',
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  };
}

function createWindow() {
  win = new BrowserWindow(buildWindowOptions());
  if (typeof win.setAlwaysOnTop === 'function') win.setAlwaysOnTop(true, 'floating');
  // Standard stealth: exclude from screen capture where supported.
  if (typeof win.setContentProtection === 'function') win.setContentProtection(true);
  if (typeof win.setFocusable === 'function') win.setFocusable(false);
  if (typeof win.setSkipTaskbar === 'function') win.setSkipTaskbar(true);
  win.setOpacity(clampOpacity(settings.opacity));
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (win.webContents && typeof win.webContents.on === 'function') {
    win.webContents.on('did-fail-load', (_event, code, desc) => {
      smokeFailed = true;
      log(`renderer failed to load (${code}): ${desc}`);
    });
  }
  win.once('ready-to-show', () => {
    if (settings.startHidden) {
      log('start-hidden enabled; overlay stays hidden until toggled');
      return;
    }
    showOverlay();
  });
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      hideOverlay();
      rebuildTrayMenu();
    }
  });
}

/** Show without stealing focus from the interview app. */
function showOverlay() {
  if (!win || win.isDestroyed()) return;
  if (typeof win.showInactive === 'function') win.showInactive();
  else win.show();
}

/** Enable keyboard input (for the settings form) then show normally. */
function showOverlayForInput() {
  if (!win || win.isDestroyed()) return;
  if (typeof win.setFocusable === 'function') win.setFocusable(true);
  win.show();
}

function hideOverlay() {
  if (!win || win.isDestroyed()) return;
  win.hide();
  if (typeof win.setFocusable === 'function') win.setFocusable(false);
}

function toggleOverlay() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) {
    hideOverlay();
  } else {
    showOverlay();
  }
  rebuildTrayMenu();
}

function setClickThrough(on) {
  clickThrough = !!on;
  if (win && !win.isDestroyed() && typeof win.setIgnoreMouseEvents === 'function') {
    win.setIgnoreMouseEvents(clickThrough, { forward: true });
  }
  sendToRenderer('xorview:click-through-change', clickThrough);
  rebuildTrayMenu();
}

function sendToRenderer(channel, value) {
  if (win && !win.isDestroyed() && win.webContents && typeof win.webContents.send === 'function') {
    win.webContents.send(channel, value);
  }
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
  tray.setToolTip(OVERLAY_TITLE);
  tray.on('click', () => toggleOverlay());
  rebuildTrayMenu();
}

function trayMenuTemplate() {
  const visible = win && !win.isDestroyed() && win.isVisible();
  return [
    { label: visible ? 'Hide overlay' : 'Show overlay', click: () => toggleOverlay() },
    {
      label: listening ? 'Pause listening' : 'Start listening',
      click: () => {
        listening = !listening;
        sendToRenderer('xorview:listening-change', listening);
        rebuildTrayMenu();
      }
    },
    { label: 'Capture screen now', click: () => void doCapture({ source: 'tray' }) },
    {
      label: clickThrough ? 'Click-through: ON' : 'Click-through: OFF',
      click: () => setClickThrough(!clickThrough)
    },
    {
      label: 'Settings',
      click: () => {
        if (win && !win.isDestroyed()) {
          showOverlayForInput();
          sendToRenderer('xorview:open-settings');
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
  ];
}

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));
}

function notifyHotkeyError(hotkey, message) {
  log(`Hotkey registration failed for "${hotkey}": ${message}`);
  sendToRenderer('xorview:hotkey-error', { hotkey, message });
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
  if (!accelerator || typeof accelerator !== 'string') {
    notifyHotkeyError(
      String(accelerator),
      'Hotkey must be a non-empty accelerator string. Tray toggle still works.'
    );
    return false;
  }
  try {
    const ok = globalShortcut.register(accelerator, toggleOverlay);
    const verified =
      ok && (typeof globalShortcut.isRegistered !== 'function' || globalShortcut.isRegistered(accelerator));
    if (verified) {
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

function reportCaptureFailure(message, source) {
  log(`capture failed (${source}):`, message);
  sendToRenderer('xorview:capture-gap', {
    timestamp: new Date().toISOString(),
    message: String(message || 'unknown error')
  });
  // Tray balloon so failures are never silent, even with overlay hidden.
  try {
    if (tray && typeof tray.displayBalloon === 'function') {
      tray.displayBalloon({ title: OVERLAY_TITLE, content: `Screen capture failed: ${message}` });
    }
  } catch {
    // Balloon is best-effort.
  }
}

async function doCapture({ source = 'manual' } = {}) {
  try {
    const entry = await capturePrimaryScreen(
      desktopCapturer.getSources.bind(desktopCapturer),
      { thumbnailWidth: 960 }
    );
    sendToRenderer('xorview:context', entry);
    return { ok: true, entry };
  } catch (err) {
    const message = (err && err.message) || String(err);
    reportCaptureFailure(message, source);
    return { ok: false, error: { code: 'capture-failed', message } };
  }
}

/** One scheduled-capture tick: failures are logged + pushed, never swallowed. */
async function tickScreenCapture() {
  const result = await doCapture({ source: 'scheduled' });
  if (!result.ok) {
    log('scheduled capture gap recorded');
  }
  return result;
}

function restartScreenLoop() {
  if (screenTimer) {
    clearInterval(screenTimer);
    screenTimer = null;
  }
  if (settings.screenPaused) return;
  const secs = Math.min(600, Math.max(5, Number(settings.screenIntervalSec) || 30));
  screenTimer = setInterval(() => {
    void tickScreenCapture();
  }, secs * 1000);
  if (typeof screenTimer.unref === 'function') screenTimer.unref();
}

function errorPayload(err) {
  return { code: (err && err.code) || 'provider', message: (err && err.message) || String(err) };
}

function transcriptLogPath() {
  try {
    return path.join(app.getPath('userData'), TRANSCRIPT_LOG_FILE);
  } catch {
    return null;
  }
}

function appendTranscriptLog(text) {
  if (!settings.transcriptLogEnabled) return { ok: true, skipped: true };
  const file = transcriptLogPath();
  if (!file) return { ok: false, error: { code: 'log-unavailable', message: 'User data dir unavailable.' } };
  const clean = String(text || '').trim();
  if (!clean) return { ok: true, skipped: true };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()}\t${clean.replace(/[\r\n]+/g, ' ')}\n`, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: { code: 'log-failed', message: (err && err.message) || String(err) } };
  }
}

function loadTranscriptLog(limit = 100) {
  const file = transcriptLogPath();
  if (!file || !fs.existsSync(file)) return { ok: true, segments: [] };
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const n = Math.min(1000, Math.max(1, Number(limit) || 100));
    const segments = lines.slice(-n).map((line) => {
      const tab = line.indexOf('\t');
      return tab >= 0
        ? { t: line.slice(0, tab), text: line.slice(tab + 1) }
        : { t: '', text: line };
    });
    return { ok: true, segments };
  } catch (err) {
    return { ok: false, error: { code: 'log-failed', message: (err && err.message) || String(err) } };
  }
}

function handleSettingsSet(incoming) {
  if (!incoming || typeof incoming !== 'object') {
    return { ok: false, errors: { _: 'Invalid settings payload.' } };
  }
  const merged = mergeSettings(settings, incoming);
  // Capture explicit keys into session memory (trimmed); disk persistence
  // of keys happens only under the persistKeys opt-in (see saveSettings).
  for (const slot of ['transcribe', 'chat']) {
    const field = `${slot}ApiKey`;
    if (typeof incoming[field] === 'string' && incoming[field].trim() !== '') {
      sessionKeys[slot] = incoming[field].trim();
    }
    if (!merged.persistKeys) {
      merged[field] = '';
    } else if (sessionKeys[slot]) {
      merged[field] = sessionKeys[slot];
    }
  }
  let result;
  try {
    result = saveSettings(app.getPath('userData'), merged);
  } catch (err) {
    return { ok: false, errors: { _: (err && err.message) || String(err) } };
  }
  if (!result.ok) return result;
  const hotkeyChanged = merged.hotkey !== settings.hotkey;
  settings = merged;
  settingsNotice = '';
  if (hotkeyChanged) registerHotkey(settings.hotkey);
  if (win && !win.isDestroyed()) win.setOpacity(clampOpacity(settings.opacity));
  applyAutostart();
  restartScreenLoop();
  return { ok: true, errors: {}, settings: publicSettings() };
}

function setupIpc() {
  ipcMain.handle('xorview:settings-get', () => publicSettings());

  ipcMain.handle('xorview:settings-set', (_event, incoming) => handleSettingsSet(incoming));

  ipcMain.handle('xorview:test-connection', async (_event, slot) => {
    try {
      if (!isValidSlot(slot)) {
        throw Object.assign(new Error(`Unknown provider slot: ${String(slot)}`), { code: 'bad-request' });
      }
      const useChat = slot === 'chat';
      const effective = effectiveSettings();
      if (!useChat && voicestudio.isVoiceStudioTranscribe(effective)) {
        await voicestudio.checkHealth({
          baseUrl: effective.voiceStudioBaseUrl,
          apiKey: resolveApiKey('transcribe', effective, process.env)
        });
        return { ok: true };
      }
      const baseUrl = useChat ? effective.chatBaseUrl : effective.transcribeBaseUrl;
      const apiKey = resolveApiKey(useChat ? 'chat' : 'transcribe', effective, process.env);
      await providers.testConnection({ baseUrl, apiKey });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorPayload(err) };
    }
  });

  ipcMain.handle('xorview:transcribe-audio', async (_event, payload) => {
    try {
      const base64 = (payload && payload.audioBase64) || '';
      if (typeof base64 !== 'string' || base64.length === 0) {
        throw Object.assign(new Error('No audio data to transcribe.'), { code: 'bad-request' });
      }
      if (base64.length > TRANSCRIBE_MAX_BASE64) {
        throw Object.assign(new Error('Audio clip exceeds the 15 MB IPC cap.'), { code: 'too-large' });
      }
      const audioBuffer = Buffer.from(base64, 'base64');
      const effective = effectiveSettings();
      if (voicestudio.isVoiceStudioTranscribe(effective)) {
        const vsResult = await voicestudio.transcribe({
          baseUrl: effective.voiceStudioBaseUrl,
          apiKey: resolveApiKey('transcribe', effective, process.env),
          model: effective.voiceStudioModel,
          audioBuffer,
          mimeType: (payload && payload.mimeType) || 'audio/webm',
          language: effective.language
        });
        return { ok: true, text: vsResult.text };
      }
      const result = await providers.transcribeAudio({
        baseUrl: effective.transcribeBaseUrl,
        apiKey: resolveApiKey('transcribe', effective, process.env),
        model: effective.transcribeModel,
        audioBuffer,
        mimeType: (payload && payload.mimeType) || 'audio/webm',
        language: effective.language
      });
      return { ok: true, text: result.text };
    } catch (err) {
      return { ok: false, error: errorPayload(err) };
    }
  });

  ipcMain.handle('xorview:suggest', async (_event, payload) => {
    try {
      const p = payload && typeof payload === 'object' ? payload : {};
      const transcript = typeof p.transcript === 'string' ? p.transcript : '';
      const summary = typeof p.summary === 'string' ? p.summary : '';
      const contextNote = typeof p.contextNote === 'string' ? p.contextNote : '';
      const history = Array.isArray(p.history) ? p.history : [];
      const effective = effectiveSettings();
      let imageDataUrl = typeof p.imageDataUrl === 'string' ? p.imageDataUrl : '';
      if (imageDataUrl.length > SUGGEST_MAX_IMAGE_CHARS) imageDataUrl = '';
      const profileBlock = profile.buildProfileBlock(effective);
      const messages = suggest.buildFusionPrompt({
        transcript,
        summary,
        contextNote,
        imageDataUrl,
        interviewType: typeof p.interviewType === 'string' ? p.interviewType : effective.interviewType,
        language: typeof p.language === 'string' && p.language ? p.language : effective.language,
        history,
        profileBlock
      });
      const result = await providers.chatCompletion({
        baseUrl: effective.chatBaseUrl,
        apiKey: resolveApiKey('chat', effective, process.env),
        model: effective.chatModel,
        messages
      });
      return { ok: true, text: result.text };
    } catch (err) {
      return { ok: false, error: errorPayload(err) };
    }
  });

  ipcMain.handle('xorview:cv-upload', async (_event, payload) => {
    try {
      return await cv.parseCvUpload(payload);
    } catch (err) {
      return { ok: false, error: errorPayload(err) };
    }
  });

  ipcMain.handle('xorview:capture-now', async () => doCapture({ source: 'renderer' }));

  ipcMain.handle('xorview:set-listening', (_event, on) => {
    listening = !!on;
    rebuildTrayMenu();
    return { ok: true, listening };
  });

  ipcMain.handle('xorview:set-click-through', (_event, on) => {
    setClickThrough(on);
    return { ok: true, clickThrough };
  });

  ipcMain.handle('xorview:set-focusable', (_event, on) => {
    if (win && !win.isDestroyed() && typeof win.setFocusable === 'function') {
      win.setFocusable(!!on);
    }
    return { ok: true };
  });

  ipcMain.handle('xorview:transcript-append', (_event, payload) => {
    const text = payload && typeof payload.text === 'string' ? payload.text : '';
    return appendTranscriptLog(text);
  });

  ipcMain.handle('xorview:transcript-load', (_event, payload) => {
    const limit = payload && payload.limit !== undefined ? payload.limit : 100;
    return loadTranscriptLog(limit);
  });

  ipcMain.handle('xorview:toggle', () => {
    toggleOverlay();
    return { ok: true };
  });
}

/** Pure smoke verdict for the did-fail-load gate (exported for tests). */
function decideSmokeExit(failed) {
  if (failed) return { code: 1, message: 'smoke FAIL: renderer did-fail-load' };
  return { code: 0, message: 'smoke OK' };
}

function finishSmoke() {
  const verdict = decideSmokeExit(smokeFailed);
  log(verdict.message);
  quitting = true;
  try {
    if (typeof app.exit === 'function' && verdict.code !== 0) {
      app.exit(verdict.code);
      return;
    }
    app.quit();
  } finally {
    if (verdict.code !== 0) process.exitCode = verdict.code;
  }
}

async function init() {
  const loaded = loadSettingsResult(app.getPath('userData'));
  settings = loaded.settings;
  if (loaded.corrupt) {
    settingsNotice = loaded.corruptBackup
      ? `Previous settings were corrupt; backed up to ${loaded.corruptBackup} and reset to defaults.`
      : 'Previous settings were corrupt and were reset to defaults.';
    log(settingsNotice);
  } else if (loaded.dropped && loaded.dropped.length > 0) {
    settingsNotice = `Some saved settings were invalid and were reset: ${loaded.dropped.join(', ')}.`;
    log(settingsNotice);
  }
  setupIpc();
  createWindow();
  createTray();
  registerHotkey(settings.hotkey);
  applyAutostart();
  restartScreenLoop();
  log('ready');
  if (SMOKE) {
    setTimeout(() => finishSmoke(), SMOKE_TIMEOUT_MS);
  }
}

if (!globalThis.__XORVIEW_NO_AUTOINIT__) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      showOverlay();
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
}

module.exports = {
  OVERLAY_TITLE,
  TRANSCRIBE_MAX_BASE64,
  SUGGEST_MAX_IMAGE_CHARS,
  TRANSCRIPT_LOG_FILE,
  buildWindowOptions,
  trayMenuTemplate,
  clampOpacity,
  errorPayload,
  decideSmokeExit,
  effectiveSettings,
  publicSettings,
  handleSettingsSet,
  doCapture,
  tickScreenCapture,
  appendTranscriptLog,
  loadTranscriptLog,
  toggleOverlay,
  showOverlay,
  hideOverlay,
  setClickThrough,
  registerHotkey,
  restartScreenLoop,
  setupIpc,
  init,
  // Test-only state accessors.
  __test__: {
    getSettings: () => settings,
    setSettings: (s) => {
      settings = s;
    },
    getSessionKeys: () => ({ ...sessionKeys }),
    setSessionKeys: (k) => {
      sessionKeys = { ...sessionKeys, ...k };
    },
    getListening: () => listening,
    getClickThrough: () => clickThrough,
    getWindow: () => win,
    getTray: () => tray,
    setSmokeFailed: (v) => {
      smokeFailed = !!v;
    },
    reset: () => {
      win = null;
      tray = null;
      settings = defaults();
      sessionKeys = { transcribe: '', chat: '' };
      settingsNotice = '';
      listening = false;
      clickThrough = false;
      if (screenTimer) clearInterval(screenTimer);
      screenTimer = null;
      currentHotkey = null;
      quitting = false;
      smokeFailed = false;
    }
  }
};
