'use strict';

/**
 * test/renderer.test.js — harness for renderer/app.js using a dependency-free
 * DOM stub (jsdom is not installed; this sandbox must stay offline-safe).
 * Loads the real core/*.js UMD bundles plus the real app.js in a vm context
 * with a fake document/navigator/bridge, then drives UI events.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const AUDIO_SRC = fs.readFileSync(path.join(ROOT, 'core', 'audio.js'), 'utf8');
const SCREEN_SRC = fs.readFileSync(path.join(ROOT, 'core', 'screen.js'), 'utf8');
const SUGGEST_SRC = fs.readFileSync(path.join(ROOT, 'core', 'suggest.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');

class FakeClassList {
  constructor() {
    this.classes = new Set();
  }
  toggle(name, force) {
    if (force === undefined) {
      if (this.classes.has(name)) this.classes.delete(name);
      else this.classes.add(name);
    } else if (force) {
      this.classes.add(name);
    } else {
      this.classes.delete(name);
    }
  }
  contains(name) {
    return this.classes.has(name);
  }
}

class FakeElement {
  constructor(tag = 'div', id = '') {
    this.tagName = tag;
    this.id = id;
    this.children = [];
    this.listeners = {};
    this._text = '';
    this._html = '';
    this.hidden = false;
    this.value = '';
    this.checked = false;
    this.src = '';
    this.disabled = false;
    this.title = '';
    this.dataset = {};
    this.attributes = {};
    this.classList = new FakeClassList();
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }
  get className() {
    return [...this.classList.classes].join(' ');
  }
  set className(v) {
    this.classList.classes = new Set(String(v || '').split(/\s+/).filter(Boolean));
  }
  get textContent() {
    return this._text;
  }
  set textContent(v) {
    this._text = String(v);
  }
  get innerHTML() {
    return this._html;
  }
  set innerHTML(v) {
    this._html = String(v);
    this.children = [];
    // Persistent delete-button stubs so listeners bound at render time survive.
    this._delButtons = [];
    const re = /data-del="(\d+)"/g;
    let match;
    while ((match = re.exec(this._html)) !== null) {
      const btn = new FakeElement('button');
      btn.setAttribute('data-del', match[1]);
      this._delButtons.push(btn);
    }
  }
  addEventListener(type, cb) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(cb);
  }
  fire(type, event = {}) {
    for (const cb of this.listeners[type] || []) cb(event);
  }
  click() {
    this.fire('click');
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  getAttribute(name) {
    return this.attributes[name] !== undefined ? this.attributes[name] : null;
  }
  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'src') this.src = '';
  }
  querySelectorAll(selector) {
    if (selector === '[data-del]') {
      return this._delButtons || [];
    }
    return [];
  }
}

function makeMediaRecorder() {
  class FakeMediaRecorder {
    constructor(stream, opts) {
      this.stream = stream;
      this.opts = opts;
      this.mimeType = 'audio/webm';
      this.ondataavailable = null;
      FakeMediaRecorder.instances.push(this);
    }
    static isTypeSupported() {
      return true;
    }
    start() {
      this.started = true;
    }
    stop() {
      this.started = false;
    }
    emit(data) {
      if (this.ondataavailable) this.ondataavailable({ data });
    }
  }
  FakeMediaRecorder.instances = [];
  return FakeMediaRecorder;
}

class FakeFileReader {
  readAsDataURL() {
    this.result = 'data:audio/webm;base64,aGk=';
    if (this.onload) this.onload();
  }
}

function makeStream() {
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  return { getTracks: () => tracks, _tracks: tracks };
}

const DEFAULT_SETTINGS = {
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
  transcribeBaseUrl: 'https://example.test/v1',
  transcribeModel: 'whisper-1',
  chatBaseUrl: 'https://example.test/v1',
  chatModel: 'gpt-test',
  persistKeys: false,
  suggestionMode: 'manual',
  interviewType: 'general',
  theme: 'dark',
  opacity: 0.95,
  bufferSize: 100,
  transcriptLogEnabled: false,
  hasTranscribeKey: true,
  hasChatKey: true,
  settingsNotice: ''
};

async function setup(overrides = {}) {
  const els = {};
  const getOrCreate = (id) => {
    if (!els[id]) els[id] = new FakeElement('div', id);
    return els[id];
  };

  const tabs = ['transcript', 'context', 'suggestions', 'settings'].map((name) => {
    const btn = new FakeElement('button');
    btn.dataset.tab = name;
    if (name === 'transcript') btn.classList.toggle('active', true);
    return btn;
  });
  const panes = ['transcript', 'context', 'suggestions', 'settings'].map((name) => {
    const pane = new FakeElement('section', `tab-${name}`);
    if (name === 'transcript') pane.classList.toggle('active', true);
    return pane;
  });

  const domListeners = {};
  const document = {
    body: new FakeElement('body'),
    getElementById: (id) => getOrCreate(id),
    querySelectorAll: (selector) => {
      if (selector === '#tabs button') return tabs;
      if (selector === '.pane') return panes;
      return [];
    },
    createElement: (tag) => new FakeElement(tag),
    addEventListener: (type, cb) => {
      domListeners[type] = domListeners[type] || [];
      domListeners[type].push(cb);
    }
  };

  const calls = {
    setListening: [],
    setClickThrough: [],
    setFocusable: [],
    suggest: 0,
    transcribe: 0,
    appended: []
  };
  const bridgeListeners = {};
  const settingsValue = { ...DEFAULT_SETTINGS, ...(overrides.settings || {}) };
  let transcribeImpl = overrides.transcribeImpl || (async () => ({ ok: true, text: 'hello world' }));
  let suggestImpl = overrides.suggestImpl || (async () => ({ ok: true, text: 'line one' }));
  const bridge = {
    getSettings: async () => ({ ...settingsValue }),
    saveSettings: async (s) => ({ ok: true, settings: { ...settingsValue, ...s } }),
    testConnection: async () => ({ ok: true }),
    transcribeAudio: async (payload) => {
      calls.transcribe += 1;
      return transcribeImpl(payload);
    },
    suggest: async (payload) => {
      calls.suggest += 1;
      return suggestImpl(payload);
    },
    captureNow: async () => ({ ok: true }),
    setListening: async (on) => {
      calls.setListening.push(on);
      return { ok: true };
    },
    setClickThrough: async (on) => {
      calls.setClickThrough.push(on);
      return { ok: true };
    },
    setFocusable: async (on) => {
      calls.setFocusable.push(on);
      return { ok: true };
    },
    appendTranscript: async (text) => {
      calls.appended.push(text);
      return { ok: true };
    },
    loadTranscript: async () => ({ ok: true, segments: overrides.logSegments || [] }),
    toggle: async () => ({ ok: true }),
    on: (channel, cb) => {
      bridgeListeners[channel] = bridgeListeners[channel] || [];
      bridgeListeners[channel].push(cb);
      return () => {};
    }
  };

  const FakeMediaRecorder = makeMediaRecorder();
  const streams = [];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date: overrides.Date || Date,
    MediaRecorder: overrides.noMediaRecorder ? undefined : FakeMediaRecorder,
    FileReader: FakeFileReader,
    navigator: {
      mediaDevices: {
        getUserMedia: overrides.getUserMedia || (async () => {
          const s = makeStream();
          streams.push(s);
          return s;
        }),
        enumerateDevices: async () => []
      },
      clipboard: { writeText: async () => {} }
    }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.document = document;
  sandbox.xorview = undefined;
  sandbox.window.xorview = bridge;
  vm.createContext(sandbox);
  vm.runInContext(AUDIO_SRC, sandbox, { filename: 'audio.js' });
  vm.runInContext(SCREEN_SRC, sandbox, { filename: 'screen.js' });
  vm.runInContext(SUGGEST_SRC, sandbox, { filename: 'suggest.js' });
  assert.ok(sandbox.XorViewAudio, 'shared audio module loads');
  assert.ok(sandbox.XorViewScreen, 'shared screen module loads');
  assert.ok(sandbox.XorViewSuggest, 'shared suggest module loads');
  vm.runInContext(APP_SRC, sandbox, { filename: 'app.js' });

  const flush = async (rounds = 30) => {
    for (let i = 0; i < rounds; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  for (const cb of domListeners.DOMContentLoaded || []) cb();
  await flush();

  const fireBridge = async (channel, value) => {
    for (const cb of bridgeListeners[channel] || []) cb(value);
    await flush(10);
  };
  const suggestionTexts = () =>
    els.suggestions.children.map((card) => card.children[0].textContent);

  return {
    els,
    tabs,
    panes,
    bridge,
    bridgeListeners,
    calls,
    streams,
    FakeMediaRecorder,
    fireBridge,
    suggestionTexts,
    flush,
    setTranscribeImpl: (fn) => {
      transcribeImpl = fn;
    },
    setSuggestImpl: (fn) => {
      suggestImpl = fn;
    },
    activeTab: () => {
      const tab = tabs.find((t) => t.classList.contains('active'));
      return tab ? tab.dataset.tab : null;
    }
  };
}

test('boot loads settings into the form', async () => {
  const ctx = await setup();
  assert.equal(ctx.els['set-hotkey'].value, 'CommandOrControl+\\');
  assert.equal(ctx.els['set-clip'].value, 5);
  assert.equal(ctx.els['tkey-state'].textContent, '(configured)');
  assert.equal(ctx.els['key-banner'].hidden, true);
});

test('key banner names exactly which key is missing', async () => {
  const both = await setup({ settings: { hasTranscribeKey: false, hasChatKey: false } });
  assert.equal(both.els['key-banner'].hidden, false);
  assert.match(both.els['key-banner-text'].textContent, /Transcription and suggestions need keys/);

  const noTranscribe = await setup({ settings: { hasTranscribeKey: false, hasChatKey: true } });
  assert.match(noTranscribe.els['key-banner-text'].textContent, /Transcription key missing/);
  assert.match(noTranscribe.els['key-banner-text'].textContent, /suggestions still work/i);

  const noChat = await setup({ settings: { hasTranscribeKey: true, hasChatKey: false } });
  assert.match(noChat.els['key-banner-text'].textContent, /Chat key missing/);
  assert.match(noChat.els['key-banner-text'].textContent, /Transcription still works/);
});

test('hotkey errors render inline without yanking tabs', async () => {
  const ctx = await setup();
  assert.equal(ctx.activeTab(), 'transcript');
  await ctx.fireBridge('xorview:hotkey-error', { hotkey: 'Ctrl+X', message: 'taken' });
  assert.equal(ctx.els['hotkey-error'].hidden, false);
  assert.match(ctx.els['hotkey-error'].textContent, /Ctrl\+X/);
  assert.equal(ctx.activeTab(), 'transcript');
});

test('Clear local data removes the visible screenshot', async () => {
  const ctx = await setup();
  await ctx.fireBridge('xorview:context', {
    id: 1,
    timestamp: new Date().toISOString(),
    sourceName: 'Screen 1',
    pngDataUrl: 'data:image/png;base64,shot',
    note: 'slide text'
  });
  assert.equal(ctx.els['context-img'].hidden, false);
  ctx.els['btn-clear-data'].click();
  await ctx.flush();
  assert.equal(ctx.els['context-img'].hidden, true);
  assert.equal(ctx.els['context-img'].src, '');
  assert.match(ctx.els['context-note'].textContent, /appear here/);
});

test('context items support per-item delete', async () => {
  const ctx = await setup();
  await ctx.fireBridge('xorview:context', { id: 11, timestamp: '', sourceName: 'A', pngDataUrl: 'x', note: 'n' });
  await ctx.fireBridge('xorview:context', { id: 22, timestamp: '', sourceName: 'B', pngDataUrl: 'y', note: 'n' });
  const list = ctx.els['context-list'];
  assert.deepEqual(list.querySelectorAll('[data-del]').map((b) => b.getAttribute('data-del')).sort(), ['11', '22']);
  list.querySelectorAll('[data-del]').find((b) => b.getAttribute('data-del') === '22').click();
  await ctx.flush();
  assert.deepEqual(list.querySelectorAll('[data-del]').map((b) => b.getAttribute('data-del')), ['11']);
});

test('capture gaps render as markers, not silent skips', async () => {
  const ctx = await setup();
  await ctx.fireBridge('xorview:capture-gap', { timestamp: new Date().toISOString(), message: 'denied' });
  assert.match(ctx.els['context-list'].innerHTML, /gap/);
  assert.match(ctx.els['capture-state'].textContent, /gap/);
});

test('suggestion render preserves leading numbers', async () => {
  const ctx = await setup({
    suggestImpl: async () => ({ ok: true, text: '3 tips for pricing\n- second idea' })
  });
  ctx.els['btn-suggest'].click();
  await ctx.flush();
  assert.deepEqual(ctx.suggestionTexts(), ['3 tips for pricing', 'second idea']);
});

test('null suggestion responses are handled safely', async () => {
  const ctx = await setup({ suggestImpl: async () => null });
  ctx.els['btn-suggest'].click();
  await ctx.flush();
  assert.match(ctx.els['suggest-state'].textContent, /unknown/);
});

test('mic failure notifies main so tray stays in sync', async () => {
  const ctx = await setup({
    getUserMedia: async () => {
      throw new Error('denied');
    }
  });
  ctx.els['btn-listen'].click();
  await ctx.flush();
  assert.match(ctx.els['listen-state'].textContent, /Mic error/);
  assert.deepEqual(ctx.calls.setListening, [false]);
});

test('listening start/stop syncs state and stops mic tracks', async () => {
  const ctx = await setup();
  ctx.els['btn-listen'].click();
  await ctx.flush();
  assert.deepEqual(ctx.calls.setListening, [true]);
  assert.equal(ctx.els['btn-listen'].textContent, 'Pause listening');
  ctx.els['btn-listen'].click();
  await ctx.flush();
  assert.deepEqual(ctx.calls.setListening, [true, false]);
  assert.ok(ctx.streams[0]._tracks.every((t) => t.stopped));
});

test('stop-during-start closes the late stream instead of leaking it', async () => {
  let resolveFirst;
  let resolveSecond;
  const firstGate = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const secondGate = new Promise((resolve) => {
    resolveSecond = resolve;
  });
  let calls = 0;
  const ctx = await setup({
    getUserMedia: () => {
      calls += 1;
      return calls === 1 ? firstGate : secondGate;
    }
  });
  ctx.els['btn-listen'].click(); // start #1 pending
  await ctx.flush(5);
  ctx.els['btn-listen'].click(); // start #2 invalidates #1 while still idle
  await ctx.flush(5);
  const stale = makeStream();
  resolveFirst(stale);
  await ctx.flush();
  assert.ok(stale._tracks.every((t) => t.stopped), 'stale stream closed');
  assert.deepEqual(ctx.calls.setListening, []);
  resolveSecond(makeStream());
  await ctx.flush();
  assert.deepEqual(ctx.calls.setListening, [true]);
});

test('upload queue shows depth and drops nothing while busy', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ctx = await setup({
    transcribeImpl: async () => {
      await gate;
      return { ok: true, text: 'clip text' };
    }
  });
  ctx.els['btn-listen'].click();
  await ctx.flush();
  const recorder = ctx.FakeMediaRecorder.instances[0];
  assert.ok(recorder);
  recorder.emit({ size: 100 });
  recorder.emit({ size: 200 });
  await ctx.flush();
  assert.match(ctx.els['queue-depth'].textContent, /queued/);
  release();
  await ctx.flush();
  assert.equal(ctx.els['queue-depth'].textContent, '');
  assert.equal(ctx.calls.transcribe, 2);
  assert.match(ctx.els['transcript-list'].innerHTML, /clip text/);
});

test('auto mode fires only on new question-bearing transcript', async () => {
  let now = 1000000;
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      super(...(args.length > 0 ? args : [now]));
    }
    static now() {
      return now;
    }
  }
  const texts = ['I worked there for five years', 'How do you handle tight deadlines?'];
  let n = 0;
  const ctx = await setup({
    Date: FakeDate,
    settings: { suggestionMode: 'auto' },
    transcribeImpl: async () => ({ ok: true, text: texts[Math.min(n++, texts.length - 1)] })
  });
  ctx.els['btn-listen'].click();
  await ctx.flush();
  const recorder = ctx.FakeMediaRecorder.instances[0];
  recorder.emit({ size: 100 }); // statement -> no auto-fire
  await ctx.flush();
  assert.equal(ctx.calls.suggest, 0);
  now += 9000; // pass the debounce
  recorder.emit({ size: 100 }); // question -> auto-fire
  await ctx.flush();
  assert.equal(ctx.calls.suggest, 1);
});

test('provider errors show code plus action', async () => {
  const ctx = await setup({
    suggestImpl: async () => ({ ok: false, error: { code: 'auth', message: 'bad key' } })
  });
  ctx.els['btn-suggest'].click();
  await ctx.flush();
  assert.match(ctx.els['suggest-state'].textContent, /auth/);
  assert.match(ctx.els['suggest-state'].textContent, /Settings/);
});

test('click-through state syncs from the tray', async () => {
  const ctx = await setup();
  await ctx.fireBridge('xorview:click-through-change', true);
  assert.match(ctx.els['btn-click'].textContent, /ON/);
  await ctx.fireBridge('xorview:click-through-change', false);
  assert.equal(ctx.els['btn-click'].textContent, 'Click-through');
});

test('settings notices and transcript log restore on boot', async () => {
  const ctx = await setup({
    settings: { settingsNotice: 'Settings were reset.', transcriptLogEnabled: true },
    logSegments: [{ t: 't1', text: 'restored line' }]
  });
  assert.equal(ctx.els['settings-state'].textContent, 'Settings were reset.');
  assert.match(ctx.els['transcript-list'].innerHTML, /restored line/);
});

test('VoiceStudio provider fills its fields and needs no key banner', async () => {
  const ctx = await setup({
    settings: {
      transcribeProvider: 'voicestudio',
      voiceStudioBaseUrl: 'http://127.0.0.1:3900',
      voiceStudioModel: 'whisper-1',
      hasTranscribeKey: false,
      hasChatKey: true
    }
  });
  assert.equal(ctx.els['set-tprovider'].value, 'voicestudio');
  assert.equal(ctx.els['set-vs-base'].value, 'http://127.0.0.1:3900');
  assert.equal(ctx.els['set-vs-model'].value, 'whisper-1');
  assert.equal(ctx.els['key-banner'].hidden, true);
  assert.match(ctx.els['tkey-state'].textContent, /not needed/);
});

test('profile fields fill the form and round-trip on save', async () => {
  const ctx = await setup({
    settings: {
      profileEnabled: true,
      candidateName: 'Ada',
      candidateHeadline: 'Backend engineer',
      resumeFacts: 'Led billing',
      keySkills: 'Node.js',
      starStories: 'Outage\nFixed it.',
      jobDescription: 'Backend role'
    }
  });
  assert.equal(ctx.els['set-profile-enabled'].checked, true);
  assert.equal(ctx.els['set-profile-name'].value, 'Ada');
  assert.equal(ctx.els['set-profile-headline'].value, 'Backend engineer');
  assert.equal(ctx.els['set-profile-facts'].value, 'Led billing');
  assert.equal(ctx.els['set-profile-jd'].value, 'Backend role');

  let seen = null;
  ctx.bridge.saveSettings = async (s) => {
    seen = s;
    return { ok: true, settings: { ...s } };
  };
  ctx.els['set-profile-name'].value = '  Grace  ';
  ctx.els['settings-form'].fire('submit', { preventDefault() {} });
  await ctx.flush();
  assert.equal(seen.profileEnabled, true);
  assert.equal(seen.candidateName, 'Grace');
  assert.equal(seen.jobDescription, 'Backend role');
  assert.equal(ctx.els['settings-state'].textContent, 'Saved.');
});

test('suggestion badges mark profile-grounded cards', async () => {
  const ctx = await setup({
    suggestImpl: async () => ({ ok: true, text: '[you] Mention billing work\n[general] Generic tip\nPlain line' })
  });
  ctx.els['btn-suggest'].click();
  await ctx.flush();
  assert.deepEqual(ctx.suggestionTexts(), ['Mention billing work', 'Generic tip', 'Plain line']);
  const cards = ctx.els.suggestions.children;
  assert.equal(cards[0].children[1].textContent, 'From your profile');
  assert.match(cards[0].children[1].className, /you/);
  assert.equal(cards[1].children[1].textContent, 'General');
  assert.equal(cards[2].children.length, 2);
});
