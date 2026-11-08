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
  const s = { ...settings.defaults(), transcribeApiKey: 't1', chatApiKey: '' };
  const env = { XORVIEW_TRANSCRIBE_API_KEY: 'slot', XORVIEW_OPENAI_API_KEY: 'shared' };
  assert.equal(settings.resolveApiKey('transcribe', s, env), 't1');
  assert.equal(settings.resolveApiKey('chat', s, env), 'shared');
});

test('resolveApiKey prefers slot env over shared env', () => {
  const s = settings.defaults();
  const env = { XORVIEW_CHAT_API_KEY: 'slot', XORVIEW_OPENAI_API_KEY: 'shared' };
  assert.equal(settings.resolveApiKey('chat', s, env), 'slot');
  assert.equal(settings.hasApiKey('chat', s, env), true);
  assert.equal(settings.hasApiKey('transcribe', s, {}), false);
});

test('resolveApiKey trims explicit keys and rejects unknown slots', () => {
  const s = { ...settings.defaults(), chatApiKey: '  k1\n' };
  assert.equal(settings.resolveApiKey('chat', s, {}), 'k1');
  assert.equal(settings.resolveApiKey('bogus', s, {}), '');
  assert.equal(settings.hasApiKey('bogus', s, {}), false);
  assert.equal(settings.isValidSlot('transcribe'), true);
  assert.equal(settings.isValidSlot('chat'), true);
  assert.equal(settings.isValidSlot(''), false);
});

test('loadSettings sanitizes invalid values back to defaults', () => {
  const dir = makeTempDir();
  const bad = { ...settings.defaults(), bufferSize: -5, opacity: 99, clipLengthSec: 999 };
  fs.writeFileSync(settings.settingsPath(dir), JSON.stringify(bad), 'utf8');
  const loaded = settings.loadSettings(dir);
  assert.equal(loaded.bufferSize, settings.DEFAULTS.bufferSize);
  assert.equal(loaded.opacity, settings.DEFAULTS.opacity);
  assert.equal(loaded.clipLengthSec, settings.DEFAULTS.clipLengthSec);
});

test('loadSettingsResult backs up corrupt JSON instead of destroying it', () => {
  const dir = makeTempDir();
  fs.writeFileSync(settings.settingsPath(dir), '{ not valid json', 'utf8');
  const result = settings.loadSettingsResult(dir);
  assert.equal(result.corrupt, true);
  assert.ok(result.corruptBackup);
  assert.ok(fs.existsSync(result.corruptBackup));
  assert.equal(fs.existsSync(settings.settingsPath(dir)), false);
  assert.equal(result.settings.hotkey, settings.DEFAULTS.hotkey);
});

test('mergeSettings honors only known keys (prototype pollution safe)', () => {
  const current = settings.defaults();
  const merged = settings.mergeSettings(current, JSON.parse('{"__proto__":{"x":1},"constructor":1,"hotkey":"Ctrl+K"}'));
  assert.equal(merged.hotkey, 'Ctrl+K');
  assert.equal(Object.prototype.x, undefined);
  assert.equal(merged.x, undefined);
  assert.equal(typeof merged.constructor, 'function');
});

test('mergeSettings keeps stored keys on empty strings, ignores presence flags', () => {
  const current = { ...settings.defaults(), transcribeApiKey: 'kept' };
  const merged = settings.mergeSettings(current, {
    transcribeApiKey: '',
    chatApiKey: 'new',
    hasTranscribeKey: false,
    hasChatKey: true
  });
  assert.equal(merged.transcribeApiKey, 'kept');
  assert.equal(merged.chatApiKey, 'new');
  assert.equal(merged.hasTranscribeKey, undefined);
});

test('saveSettings is session-only by default, persists keys only when opted in', () => {
  const dir = makeTempDir();
  const sessionOnly = { ...settings.defaults(), transcribeApiKey: '  t1\n', chatApiKey: 'c1' };
  assert.equal(settings.saveSettings(dir, sessionOnly).ok, true);
  const stored = JSON.parse(fs.readFileSync(settings.settingsPath(dir), 'utf8'));
  assert.equal(stored.transcribeApiKey, '');
  assert.equal(stored.chatApiKey, '');

  const optedIn = { ...settings.defaults(), persistKeys: true, transcribeApiKey: '  t1\n' };
  assert.equal(settings.saveSettings(dir, optedIn).ok, true);
  const stored2 = JSON.parse(fs.readFileSync(settings.settingsPath(dir), 'utf8'));
  assert.equal(stored2.transcribeApiKey, 't1');
});

test('validateSettings covers new v2 fields', () => {
  const bad = {
    ...settings.defaults(),
    clipLengthSec: 1,
    vadThreshold: 2,
    interviewType: '',
    startHidden: 'yes',
    persistKeys: 1,
    transcriptLogEnabled: 'no'
  };
  const result = settings.validateSettings(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.clipLengthSec);
  assert.ok(result.errors.vadThreshold);
  assert.ok(result.errors.interviewType);
  assert.ok(result.errors.startHidden);
  assert.ok(result.errors.persistKeys);
  assert.ok(result.errors.transcriptLogEnabled);
});

test('validateSettings covers VoiceStudio transcription provider fields', () => {
  const bad = {
    ...settings.defaults(),
    transcribeProvider: 'other',
    voiceStudioBaseUrl: 'not a url',
    voiceStudioModel: ''
  };
  const result = settings.validateSettings(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.transcribeProvider);
  assert.ok(result.errors.voiceStudioBaseUrl);
  assert.ok(result.errors.voiceStudioModel);

  const good = {
    ...settings.defaults(),
    transcribeProvider: 'voicestudio',
    voiceStudioBaseUrl: 'http://127.0.0.1:3900/',
    voiceStudioModel: 'whisper-1'
  };
  assert.equal(settings.validateSettings(good).ok, true);
});

test('loadSettings sanitizes invalid VoiceStudio values back to defaults', () => {
  const dir = makeTempDir();
  const bad = { ...settings.defaults(), transcribeProvider: 'bogus', voiceStudioBaseUrl: 'ftp://x' };
  fs.writeFileSync(settings.settingsPath(dir), JSON.stringify(bad), 'utf8');
  const loaded = settings.loadSettings(dir);
  assert.equal(loaded.transcribeProvider, settings.DEFAULTS.transcribeProvider);
  assert.equal(loaded.voiceStudioBaseUrl, settings.DEFAULTS.voiceStudioBaseUrl);
});

test('validateSettings covers candidate-profile fields', () => {
  const bad = {
    ...settings.defaults(),
    profileEnabled: 'yes',
    candidateName: 'x'.repeat(121),
    candidateHeadline: 'x'.repeat(201),
    resumeFacts: 'x'.repeat(4001),
    keySkills: 'x'.repeat(2001),
    starStories: 'x'.repeat(6001),
    jobDescription: 'x'.repeat(6001)
  };
  const result = settings.validateSettings(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.profileEnabled);
  assert.ok(result.errors.candidateName);
  assert.ok(result.errors.candidateHeadline);
  assert.ok(result.errors.resumeFacts);
  assert.ok(result.errors.keySkills);
  assert.ok(result.errors.starStories);
  assert.ok(result.errors.jobDescription);

  const good = {
    ...settings.defaults(),
    profileEnabled: true,
    candidateName: 'Ada',
    candidateHeadline: 'Backend engineer',
    resumeFacts: 'Led billing',
    keySkills: 'Node.js',
    starStories: 'Outage\nFixed it.',
    jobDescription: 'Backend role'
  };
  assert.equal(settings.validateSettings(good).ok, true);
});

test('validateSettings rejects non-string profile text', () => {
  const bad = { ...settings.defaults(), resumeFacts: ['not a string'] };
  const result = settings.validateSettings(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.resumeFacts);
});

test('saveSettings round-trips candidate-profile fields', () => {
  const dir = makeTempDir();
  const input = {
    ...settings.defaults(),
    profileEnabled: true,
    candidateName: 'Ada',
    candidateHeadline: 'Backend engineer',
    resumeFacts: 'Led billing',
    keySkills: 'Node.js',
    starStories: 'Outage\nFixed it.',
    jobDescription: 'Backend role'
  };
  assert.equal(settings.saveSettings(dir, input).ok, true);
  const loaded = settings.loadSettings(dir);
  assert.equal(loaded.profileEnabled, true);
  assert.equal(loaded.candidateName, 'Ada');
  assert.equal(loaded.starStories, 'Outage\nFixed it.');
  assert.equal(loaded.jobDescription, 'Backend role');
});

test('loadSettings sanitizes invalid profile values back to defaults', () => {
  const dir = makeTempDir();
  const bad = { ...settings.defaults(), profileEnabled: 'yes', candidateName: 'x'.repeat(500) };
  fs.writeFileSync(settings.settingsPath(dir), JSON.stringify(bad), 'utf8');
  const loaded = settings.loadSettings(dir);
  assert.equal(loaded.profileEnabled, settings.DEFAULTS.profileEnabled);
  assert.equal(loaded.candidateName, settings.DEFAULTS.candidateName);
});

test('mergeSettings honors profile keys', () => {
  const merged = settings.mergeSettings(settings.defaults(), {
    profileEnabled: true,
    candidateName: 'Ada',
    jobDescription: 'Backend role'
  });
  assert.equal(merged.profileEnabled, true);
  assert.equal(merged.candidateName, 'Ada');
  assert.equal(merged.jobDescription, 'Backend role');
});

test('validateSettings covers the CV file name', () => {
  const bad = { ...settings.defaults(), cvFileName: 'x'.repeat(256) };
  const result = settings.validateSettings(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.cvFileName);
  const nonString = settings.validateSettings({ ...settings.defaults(), cvFileName: 42 });
  assert.equal(nonString.ok, false);
  assert.ok(nonString.errors.cvFileName);
  const good = settings.validateSettings({ ...settings.defaults(), cvFileName: 'Ada-CV.pdf' });
  assert.equal(good.ok, true);
});

test('saveSettings round-trips the CV file name', () => {
  const dir = makeTempDir();
  const input = { ...settings.defaults(), cvFileName: 'Ada-CV.pdf' };
  assert.equal(settings.saveSettings(dir, input).ok, true);
  assert.equal(settings.loadSettings(dir).cvFileName, 'Ada-CV.pdf');
});
