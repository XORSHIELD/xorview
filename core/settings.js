'use strict';

/**
 * core/settings.js — XorView settings: defaults, load/save, validation,
 * and API-key resolution (settings value > slot env var > shared env var).
 *
 * Pure Node module (no Electron dependency) so it can be unit tested.
 * Never logs key material.
 */

const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = 'xorview-settings.json';

const DEFAULTS = Object.freeze({
  hotkey: 'CommandOrControl+\\',
  autostart: false,
  micDeviceId: 'default',
  language: 'en',
  screenIntervalSec: 30,
  screenPaused: false,
  transcribeBaseUrl: 'https://api.openai.com/v1',
  transcribeModel: 'whisper-1',
  transcribeApiKey: '',
  chatBaseUrl: 'https://api.openai.com/v1',
  chatModel: 'gpt-4o-mini',
  chatApiKey: '',
  suggestionMode: 'manual', // 'manual' | 'auto'
  theme: 'dark', // 'dark' | 'light'
  opacity: 0.95,
  bufferSize: 100
});

const KNOWN_KEYS = Object.keys(DEFAULTS);

function defaults() {
  return { ...DEFAULTS };
}

function settingsPath(userDataDir) {
  return path.join(userDataDir, SETTINGS_FILE);
}

/**
 * Load settings from the user-data dir, merged over defaults.
 * Missing/corrupt file -> defaults (corrupt file is left untouched).
 */
function loadSettings(userDataDir) {
  const merged = defaults();
  if (!userDataDir) return merged;
  try {
    const raw = fs.readFileSync(settingsPath(userDataDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const key of KNOWN_KEYS) {
        if (parsed[key] !== undefined) merged[key] = parsed[key];
      }
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      // Corrupt JSON: fall back to defaults rather than crashing.
    }
  }
  return merged;
}

/**
 * Validate a settings object. Returns { ok, errors } where errors maps
 * field name -> human-readable message.
 */
function validateSettings(s) {
  const errors = {};
  if (!s || typeof s !== 'object') {
    return { ok: false, errors: { _: 'Settings must be an object.' } };
  }
  if (typeof s.hotkey !== 'string' || s.hotkey.trim() === '') {
    errors.hotkey = 'Hotkey must be a non-empty accelerator string.';
  }
  if (typeof s.autostart !== 'boolean') {
    errors.autostart = 'Autostart must be true or false.';
  }
  if (typeof s.micDeviceId !== 'string') {
    errors.micDeviceId = 'Mic device must be a string id.';
  }
  if (typeof s.language !== 'string') {
    errors.language = 'Language must be a string.';
  }
  if (!Number.isFinite(s.screenIntervalSec) || s.screenIntervalSec < 5 || s.screenIntervalSec > 600) {
    errors.screenIntervalSec = 'Capture interval must be a number between 5 and 600 seconds.';
  }
  if (typeof s.screenPaused !== 'boolean') {
    errors.screenPaused = 'Screen pause flag must be true or false.';
  }
  for (const field of ['transcribeBaseUrl', 'chatBaseUrl']) {
    if (typeof s[field] !== 'string' || s[field].trim() === '') {
      errors[field] = 'Endpoint must be a non-empty URL.';
    } else {
      try {
        const u = new URL(s[field]);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') {
          errors[field] = 'Endpoint must use http(s).';
        }
      } catch {
        errors[field] = 'Endpoint must be a valid URL.';
      }
    }
  }
  for (const field of ['transcribeModel', 'chatModel']) {
    if (typeof s[field] !== 'string' || s[field].trim() === '') {
      errors[field] = 'Model name must be a non-empty string.';
    }
  }
  for (const field of ['transcribeApiKey', 'chatApiKey']) {
    if (typeof s[field] !== 'string') {
      errors[field] = 'API key must be a string.';
    }
  }
  if (s.suggestionMode !== 'manual' && s.suggestionMode !== 'auto') {
    errors.suggestionMode = "Suggestion mode must be 'manual' or 'auto'.";
  }
  if (s.theme !== 'dark' && s.theme !== 'light') {
    errors.theme = "Theme must be 'dark' or 'light'.";
  }
  if (!Number.isFinite(s.opacity) || s.opacity < 0.3 || s.opacity > 1) {
    errors.opacity = 'Opacity must be a number between 0.3 and 1.';
  }
  if (!Number.isInteger(s.bufferSize) || s.bufferSize < 10 || s.bufferSize > 1000) {
    errors.bufferSize = 'Buffer size must be an integer between 10 and 1000.';
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * Persist known settings keys to the user-data dir.
 * Returns { ok, errors } — never writes when validation fails.
 */
function saveSettings(userDataDir, settings) {
  const validation = validateSettings(settings);
  if (!validation.ok) return validation;
  const toWrite = {};
  for (const key of KNOWN_KEYS) toWrite[key] = settings[key];
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(settingsPath(userDataDir), JSON.stringify(toWrite, null, 2), 'utf8');
  return { ok: true, errors: {} };
}

const SLOT_ENV = Object.freeze({
  transcribe: 'XORVIEW_TRANSCRIBE_API_KEY',
  chat: 'XORVIEW_CHAT_API_KEY'
});
const SHARED_ENV = 'XORVIEW_OPENAI_API_KEY';

/**
 * Resolve the API key for a slot: explicit settings value wins, then the
 * slot-specific env var, then the shared env var, else ''.
 */
function resolveApiKey(slot, settings, env) {
  const store = env || process.env;
  const explicit = slot === 'transcribe' ? settings.transcribeApiKey : settings.chatApiKey;
  if (explicit && explicit.trim() !== '') return explicit;
  const slotVar = SLOT_ENV[slot];
  if (slotVar && store[slotVar]) return store[slotVar];
  if (store[SHARED_ENV]) return store[SHARED_ENV];
  return '';
}

/** True when a usable key exists from any source (never reveals it). */
function hasApiKey(slot, settings, env) {
  return resolveApiKey(slot, settings, env).trim() !== '';
}

module.exports = {
  DEFAULTS,
  SETTINGS_FILE,
  defaults,
  settingsPath,
  loadSettings,
  saveSettings,
  validateSettings,
  resolveApiKey,
  hasApiKey
};
