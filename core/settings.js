'use strict';

/**
 * core/settings.js — XorView v2 settings: defaults, load/save, validation,
 * sanitization, allowlisted merge, and API-key resolution.
 *
 * Pure Node module (no Electron dependency) so it can be unit tested.
 * Never logs key material.
 *
 * Key storage rule (v2): secrets persist to disk ONLY when the user opts in
 * via `persistKeys`. Otherwise keys are session-only (kept in main-process
 * memory) with env-var fallback.
 *
 * Candidate-profile fields (profileEnabled + candidateName/headline,
 * resumeFacts, keySkills, starStories, jobDescription) are plain strings
 * persisted like any other setting; core/profile.js parses and fuses them
 * into suggestion prompts.
 */

const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = 'xorview-settings.json';

const DEFAULTS = Object.freeze({
  hotkey: 'CommandOrControl+\\',
  autostart: false,
  startHidden: false,
  micDeviceId: 'default',
  language: 'en',
  clipLengthSec: 5,
  vadEnabled: true,
  vadThreshold: 0.02,
  screenIntervalSec: 30,
  screenPaused: false,
  transcribeBaseUrl: 'https://api.openai.com/v1',
  transcribeModel: 'whisper-1',
  transcribeApiKey: '',
  transcribeProvider: 'openai', // 'openai' | 'voicestudio'
  voiceStudioBaseUrl: 'http://localhost:3900',
  voiceStudioModel: 'whisper-1',
  chatBaseUrl: 'https://api.openai.com/v1',
  chatModel: 'gpt-4o-mini',
  chatApiKey: '',
  persistKeys: false,
  suggestionMode: 'manual', // 'manual' | 'auto'
  interviewType: 'general',
  theme: 'dark', // 'dark' | 'light'
  opacity: 0.95,
  bufferSize: 100,
  transcriptLogEnabled: false,
  profileEnabled: false,
  candidateName: '',
  candidateHeadline: '',
  resumeFacts: '',
  keySkills: '',
  starStories: '',
  jobDescription: '',
  cvFileName: ''
});

const KNOWN_KEYS = Object.keys(DEFAULTS);

/** Valid provider slots. */
const VALID_SLOTS = Object.freeze(['transcribe', 'chat']);

/** Max stored characters per candidate-profile text field. */
const PROFILE_TEXT_LIMITS = Object.freeze({
  candidateName: 120,
  candidateHeadline: 200,
  resumeFacts: 4000,
  keySkills: 2000,
  starStories: 6000,
  jobDescription: 6000
});

function defaults() {
  return { ...DEFAULTS };
}

function settingsPath(userDataDir) {
  return path.join(userDataDir, SETTINGS_FILE);
}

function isValidSlot(slot) {
  return slot === 'transcribe' || slot === 'chat';
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
  if (typeof s.startHidden !== 'boolean') {
    errors.startHidden = 'Start-hidden must be true or false.';
  }
  if (typeof s.micDeviceId !== 'string') {
    errors.micDeviceId = 'Mic device must be a string id.';
  }
  if (typeof s.language !== 'string') {
    errors.language = 'Language must be a string.';
  }
  if (!Number.isInteger(s.clipLengthSec) || s.clipLengthSec < 2 || s.clipLengthSec > 30) {
    errors.clipLengthSec = 'Clip length must be an integer between 2 and 30 seconds.';
  }
  if (typeof s.vadEnabled !== 'boolean') {
    errors.vadEnabled = 'VAD gate must be true or false.';
  }
  if (!Number.isFinite(s.vadThreshold) || s.vadThreshold < 0 || s.vadThreshold > 1) {
    errors.vadThreshold = 'VAD threshold must be a number between 0 and 1.';
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
  if (s.transcribeProvider !== 'openai' && s.transcribeProvider !== 'voicestudio') {
    errors.transcribeProvider = "Transcription provider must be 'openai' or 'voicestudio'.";
  }
  if (typeof s.voiceStudioBaseUrl !== 'string' || s.voiceStudioBaseUrl.trim() === '') {
    errors.voiceStudioBaseUrl = 'VoiceStudio backend URL must be a non-empty URL.';
  } else {
    try {
      const u = new URL(s.voiceStudioBaseUrl);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        errors.voiceStudioBaseUrl = 'VoiceStudio backend URL must use http(s).';
      }
    } catch {
      errors.voiceStudioBaseUrl = 'VoiceStudio backend URL must be a valid URL.';
    }
  }
  if (typeof s.voiceStudioModel !== 'string' || s.voiceStudioModel.trim() === '') {
    errors.voiceStudioModel = 'VoiceStudio model name must be a non-empty string.';
  }
  if (typeof s.persistKeys !== 'boolean') {
    errors.persistKeys = 'Persist-keys opt-in must be true or false.';
  }
  if (s.suggestionMode !== 'manual' && s.suggestionMode !== 'auto') {
    errors.suggestionMode = "Suggestion mode must be 'manual' or 'auto'.";
  }
  if (typeof s.interviewType !== 'string' || s.interviewType.trim() === '' || s.interviewType.length > 64) {
    errors.interviewType = 'Interview type must be a non-empty string (max 64 chars).';
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
  if (typeof s.transcriptLogEnabled !== 'boolean') {
    errors.transcriptLogEnabled = 'Transcript-log flag must be true or false.';
  }
  if (typeof s.profileEnabled !== 'boolean') {
    errors.profileEnabled = 'Profile opt-in must be true or false.';
  }
  if (typeof s.cvFileName !== 'string') {
    errors.cvFileName = 'CV file name must be a string.';
  } else if (s.cvFileName.length > 255) {
    errors.cvFileName = 'CV file name must be at most 255 characters.';
  }
  for (const field of Object.keys(PROFILE_TEXT_LIMITS)) {
    const max = PROFILE_TEXT_LIMITS[field];
    if (typeof s[field] !== 'string') {
      errors[field] = 'Profile text must be a string.';
    } else if (s[field].length > max) {
      errors[field] = `Profile text must be at most ${max} characters.`;
    }
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * Sanitize a parsed settings object: unknown keys dropped, invalid values
 * replaced by defaults. Returns { settings, dropped } where dropped lists
 * the keys that failed validation.
 */
function sanitizeSettings(parsed) {
  const merged = defaults();
  const dropped = [];
  if (!parsed || typeof parsed !== 'object') return { settings: merged, dropped };
  for (const key of KNOWN_KEYS) {
    if (parsed[key] === undefined) continue;
    const trial = { ...merged, [key]: parsed[key] };
    // Validate the single field by checking the full object and looking
    // only at this key's error (defaults are valid, so other keys pass).
    const result = validateSettings(trial);
    if (result.errors[key]) {
      dropped.push(key);
    } else {
      merged[key] = parsed[key];
    }
  }
  return { settings: merged, dropped };
}

/**
 * Load settings with full diagnostics. Corrupt JSON is renamed aside to
 * `settings.json.corrupt-<ts>` so the evidence survives and the next save
 * cannot silently destroy it. Invalid values fall back to defaults.
 */
function loadSettingsResult(userDataDir) {
  const merged = defaults();
  if (!userDataDir) return { settings: merged, corruptBackup: null, dropped: [] };
  let raw;
  try {
    raw = fs.readFileSync(settingsPath(userDataDir), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { settings: merged, corruptBackup: null, dropped: [] };
    }
    return { settings: merged, corruptBackup: null, dropped: [], readError: (err && err.message) || String(err) };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    let corruptBackup = null;
    try {
      corruptBackup = path.join(userDataDir, `settings.json.corrupt-${Date.now()}`);
      fs.renameSync(settingsPath(userDataDir), corruptBackup);
    } catch {
      corruptBackup = null;
    }
    return { settings: merged, corruptBackup, dropped: [], corrupt: true };
  }
  const { settings, dropped } = sanitizeSettings(parsed);
  return { settings, corruptBackup: null, dropped };
}

/**
 * Load settings from the user-data dir, merged over defaults with invalid
 * values sanitized. Missing/corrupt file -> defaults (corrupt file is
 * renamed aside; see loadSettingsResult for diagnostics).
 */
function loadSettings(userDataDir) {
  return loadSettingsResult(userDataDir).settings;
}

/**
 * Persist known settings keys to the user-data dir.
 * Returns { ok, errors } — never writes when validation fails.
 * Keys are trimmed, and written ONLY when `persistKeys` is true;
 * otherwise empty strings are stored (session-only mode).
 */
function saveSettings(userDataDir, settings) {
  const validation = validateSettings(settings);
  if (!validation.ok) return validation;
  const toWrite = {};
  for (const key of KNOWN_KEYS) toWrite[key] = settings[key];
  toWrite.transcribeApiKey = String(toWrite.transcribeApiKey || '').trim();
  toWrite.chatApiKey = String(toWrite.chatApiKey || '').trim();
  if (!toWrite.persistKeys) {
    toWrite.transcribeApiKey = '';
    toWrite.chatApiKey = '';
  }
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(settingsPath(userDataDir), JSON.stringify(toWrite, null, 2), 'utf8');
  return { ok: true, errors: {} };
}

/**
 * Allowlisted merge of renderer-supplied settings over current settings.
 * Only KNOWN_KEYS are honored (never __proto__/constructor/etc.).
 * Empty key strings mean "keep the current key". UI-only presence flags
 * (hasTranscribeKey/hasChatKey) are ignored.
 */
const IGNORED_MERGE_KEYS = new Set(['hasTranscribeKey', 'hasChatKey']);

function mergeSettings(current, incoming) {
  const merged = { ...(current || defaults()) };
  if (!incoming || typeof incoming !== 'object') return merged;
  const allow = new Set(KNOWN_KEYS);
  for (const key of Object.keys(incoming)) {
    if (!allow.has(key)) continue;
    if (IGNORED_MERGE_KEYS.has(key)) continue;
    if ((key === 'transcribeApiKey' || key === 'chatApiKey') && incoming[key] === '') continue;
    merged[key] = incoming[key];
  }
  return merged;
}

const SLOT_ENV = Object.freeze({
  transcribe: 'XORVIEW_TRANSCRIBE_API_KEY',
  chat: 'XORVIEW_CHAT_API_KEY'
});
const SHARED_ENV = 'XORVIEW_OPENAI_API_KEY';

/**
 * Resolve the API key for a slot: explicit settings value (trimmed) wins,
 * then the slot-specific env var, then the shared env var, else ''.
 * Unknown slots resolve to ''.
 */
function resolveApiKey(slot, settings, env) {
  if (!isValidSlot(slot)) return '';
  const store = env || process.env;
  const explicit = slot === 'transcribe' ? settings.transcribeApiKey : settings.chatApiKey;
  if (explicit && String(explicit).trim() !== '') return String(explicit).trim();
  const slotVar = SLOT_ENV[slot];
  if (slotVar && store[slotVar]) return store[slotVar];
  if (store[SHARED_ENV]) return store[SHARED_ENV];
  return '';
}

/** True when a usable key exists from any source (never reveals it). */
function hasApiKey(slot, settings, env) {
  if (!isValidSlot(slot)) return false;
  return resolveApiKey(slot, settings, env).trim() !== '';
}

module.exports = {
  DEFAULTS,
  KNOWN_KEYS,
  VALID_SLOTS,
  SETTINGS_FILE,
  SLOT_ENV,
  SHARED_ENV,
  PROFILE_TEXT_LIMITS,
  defaults,
  settingsPath,
  isValidSlot,
  loadSettings,
  loadSettingsResult,
  saveSettings,
  sanitizeSettings,
  mergeSettings,
  validateSettings,
  resolveApiKey,
  hasApiKey
};
