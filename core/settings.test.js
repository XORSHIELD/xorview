'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const settings = require('./settings');

// Repo-local temp dirs (system temp may be unavailable in sandboxes).
const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(__dirname, '.test-tmp-'));
  tempDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('defaults returns a fresh copy of DEFAULTS', () => {
  const a = settings.defaults();
  assert.equal(a.hotkey, 'CommandOrControl+\\');
  assert.equal(a.transcribeModel, 'whisper-1');
  a.hotkey = 'changed';
  assert.equal(settings.defaults().hotkey, 'CommandOrControl+\\');
});

test('loadSettings falls back to defaults when no file exists', () => {
  const dir = makeTempDir();
  const loaded = settings.loadSettings(dir);
  assert.equal(loaded.hotkey, settings.DEFAULTS.hotkey);
  assert.equal(loaded.bufferSize, 100);
});

test('saveSettings round-trips and ignores unknown keys', () => {
  const dir = makeTempDir();
  const input = { ...settings.defaults(), hotkey: 'Ctrl+Alt+X', opacity: 0.8, bogus: true };
  const result = settings.saveSettings(dir, input);
  assert.equal(result.ok, true);
  const loaded = settings.loadSettings(dir);
  assert.equal(loaded.hotkey, 'Ctrl+Alt+X');
  assert.equal(loaded.opacity, 0.8);
  assert.equal(loaded.bogus, undefined);
});

test('saveSettings refuses invalid settings without writing', () => {
  const dir = makeTempDir();
  const bad = { ...settings.defaults(), screenIntervalSec: 9999, opacity: 5 };
  const result = settings.saveSettings(dir, bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.screenIntervalSec);
  assert.ok(result.errors.opacity);
  assert.equal(fs.existsSync(settings.settingsPath(dir)), false);
});

test('validateSettings accepts defaults', () => {
  assert.equal(settings.validateSettings(settings.defaults()).ok, true);
});

test('validateSettings rejects bad endpoint, mode, and theme', () => {
  const bad = {
    ...settings.defaults(),
    transcribeBaseUrl: 'not a url',
    suggestionMode: 'sometimes',
    theme: 'neon'
  };
  const result = settings.validateSettings(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.transcribeBaseUrl);
  assert.ok(result.errors.suggestionMode);
  assert.ok(result.errors.theme);
});

test('resolveApiKey prefers settings over env vars', () => {
  const s = { ...settings.defaults(), transcribeApiKey: 'from-settings', chatApiKey: '' };
  const env = { XORVIEW_TRANSCRIBE_API_KEY: 'slot', XORVIEW_OPENAI_API_KEY: 'shared' };
  assert.equal(settings.resolveApiKey('transcribe', s, env), 'from-settings');
  assert.equal(settings.resolveApiKey('chat', s, env), 'shared');
});

test('resolveApiKey prefers slot env over shared env', () => {
  const s = settings.defaults();
  const env = { XORVIEW_CHAT_API_KEY: 'slot', XORVIEW_OPENAI_API_KEY: 'shared' };
  assert.equal(settings.resolveApiKey('chat', s, env), 'slot');
  assert.equal(settings.hasApiKey('chat', s, env), true);
  assert.equal(settings.hasApiKey('transcribe', s, {}), false);
});
