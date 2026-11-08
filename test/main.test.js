'use strict';

/**
 * test/main.test.js — stub harness for electron/main.js.
 * Stubs app/BrowserWindow/Tray/globalShortcut/desktopCapturer and asserts
 * window stealth options, hotkey behavior, tray menu, IPC validation,
 * capture failure reporting, session-only keys, and the smoke gate.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpRoot = fs.mkdtempSync(path.join(__dirname, '.test-tmp-main-'));
test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function createStub() {
  const stub = {
    sent: [],
    handlers: {},
    windows: [],
    trays: [],
    shortcuts: {},
    balloons: [],
    loginSettings: null,
    quitCalled: false,
    exitCode: null,
    sourcesImpl: async () => [
      { name: 'Screen 1', thumbnail: { toDataURL: () => 'data:image/png;base64,thumb' } }
    ]
  };

  stub.app = {
    getPath: (name) => (name === 'userData' ? tmpRoot : tmpRoot),
    requestSingleInstanceLock: () => true,
    whenReady: async () => {},
    quit: () => {
      stub.quitCalled = true;
    },
    exit: (code) => {
      stub.exitCode = code;
    },
    setLoginItemSettings: (opts) => {
      stub.loginSettings = opts;
    },
    on: () => {}
  };

  stub.BrowserWindow = class {
    constructor(options) {
      this.options = options;
      this.calls = [];
      this.visible = false;
      this.destroyed = false;
      this.opacity = null;
      this.onceHandlers = {};
      this.onHandlers = {};
      this.webContents = {
        sent: stub.sent,
        listeners: {},
        send: (channel, value) => void stub.sent.push([channel, value]),
        on: (channel, cb) => {
          this.webContents.listeners[channel] = cb;
        }
      };
      stub.windows.push(this);
    }
    setAlwaysOnTop(...args) {
      this.calls.push(['setAlwaysOnTop', ...args]);
    }
    setContentProtection(...args) {
      this.calls.push(['setContentProtection', ...args]);
    }
    setFocusable(...args) {
      this.calls.push(['setFocusable', ...args]);
    }
    setSkipTaskbar(...args) {
      this.calls.push(['setSkipTaskbar', ...args]);
    }
    setIgnoreMouseEvents(...args) {
      this.calls.push(['setIgnoreMouseEvents', ...args]);
    }
    setOpacity(v) {
      this.opacity = v;
    }
    loadFile(file) {
      this.calls.push(['loadFile', file]);
      return Promise.resolve();
    }
    once(channel, cb) {
      this.onceHandlers[channel] = cb;
    }
    on(channel, cb) {
      this.onHandlers[channel] = cb;
    }
    show() {
      this.calls.push(['show']);
      this.visible = true;
    }
    showInactive() {
      this.calls.push(['showInactive']);
      this.visible = true;
    }
    hide() {
      this.calls.push(['hide']);
      this.visible = false;
    }
    focus() {
      this.calls.push(['focus']);
    }
    isVisible() {
      return this.visible;
    }
    isDestroyed() {
      return this.destroyed;
    }
  };

  stub.Tray = class {
    constructor(icon) {
      this.icon = icon;
      this.tooltip = '';
      this.menu = null;
      this.clickHandler = null;
      stub.trays.push(this);
    }
    setToolTip(t) {
      this.tooltip = t;
    }
    on(channel, cb) {
      if (channel === 'click') this.clickHandler = cb;
    }
    setContextMenu(menu) {
      this.menu = menu;
    }
    displayBalloon(opts) {
      stub.balloons.push(opts);
    }
  };

  stub.Menu = {
    buildFromTemplate: (template) => template
  };

  stub.globalShortcut = {
    register: (accelerator, cb) => {
      stub.shortcuts[accelerator] = cb;
      return stub.registerResult !== undefined ? stub.registerResult : true;
    },
    unregister: (accelerator) => {
      delete stub.shortcuts[accelerator];
    },
    isRegistered: () => (stub.isRegisteredResult !== undefined ? stub.isRegisteredResult : true),
    unregisterAll: () => {
      stub.shortcuts = {};
    }
  };

  stub.ipcMain = {
    handle: (channel, handler) => {
      stub.handlers[channel] = handler;
    }
  };

  stub.nativeImage = {
    createFromPath: (p) => ({ path: p }),
    createFromDataURL: (d) => ({ dataUrl: d.slice(0, 32) })
  };

  stub.desktopCapturer = {
    getSources: (opts) => stub.sourcesImpl(opts)
  };

  return stub;
}

const stub = createStub();
globalThis.__XORVIEW_ELECTRON_STUB__ = stub;
globalThis.__XORVIEW_NO_AUTOINIT__ = true;

const main = require('../electron/main');
const providers = require('../core/providers');

test.beforeEach(() => {
  main.__test__.reset();
  stub.sent.length = 0;
  stub.windows.length = 0;
  stub.trays.length = 0;
  stub.handlers = {};
  stub.shortcuts = {};
  stub.balloons.length = 0;
  stub.registerResult = undefined;
  stub.isRegisteredResult = undefined;
  stub.sourcesImpl = async () => [
    { name: 'Screen 1', thumbnail: { toDataURL: () => 'data:image/png;base64,thumb' } }
  ];
  for (const file of fs.readdirSync(tmpRoot)) {
    fs.rmSync(path.join(tmpRoot, file), { recursive: true, force: true });
  }
});

test.afterEach(() => {
  main.__test__.reset();
});

test('window options harden standard stealth', () => {
  const opts = main.buildWindowOptions();
  assert.equal(opts.focusable, false);
  assert.equal(opts.skipTaskbar, true);
  assert.equal(opts.show, false);
  assert.equal(opts.frame, false);
  assert.equal(opts.transparent, true);
  assert.equal(opts.type, 'toolbar');
  assert.notEqual(opts.title, 'XorView');
  assert.ok(opts.title && opts.title.length > 0);
  assert.equal(opts.webPreferences.sandbox, true);
  assert.equal(opts.webPreferences.contextIsolation, true);
  assert.equal(opts.webPreferences.nodeIntegration, false);
});

test('init creates a protected floating window, tray, and hotkey', async () => {
  await main.init();
  assert.equal(stub.windows.length, 1);
  const win = stub.windows[0];
  assert.ok(win.calls.some((c) => c[0] === 'setContentProtection' && c[1] === true));
  assert.ok(win.calls.some((c) => c[0] === 'setAlwaysOnTop' && c[1] === true && c[2] === 'floating'));
  assert.ok(win.calls.some((c) => c[0] === 'setFocusable' && c[1] === false));
  assert.ok(win.webContents.listeners['did-fail-load']);
  assert.equal(stub.trays.length, 1);
  assert.ok(stub.shortcuts['CommandOrControl+\\']);
  assert.ok(stub.handlers['xorview:settings-get']);
  assert.ok(stub.handlers['xorview:transcribe-audio']);
});

test('toggleOverlay shows inactive and never steals focus', async () => {
  await main.init();
  const win = stub.windows[0];
  main.toggleOverlay(); // hidden -> show
  assert.ok(win.calls.some((c) => c[0] === 'showInactive'));
  assert.ok(!win.calls.some((c) => c[0] === 'focus'));
  main.toggleOverlay(); // visible -> hide
  assert.ok(win.calls.some((c) => c[0] === 'hide'));
});

test('ready-to-show respects start-hidden', async () => {
  await main.init();
  const win = stub.windows[0];
  win.onceHandlers['ready-to-show']();
  assert.ok(win.calls.some((c) => c[0] === 'showInactive'));

  main.__test__.reset();
  stub.windows.length = 0;
  stub.handlers = {};
  const { saveSettings, defaults } = require('../core/settings');
  saveSettings(tmpRoot, { ...defaults(), startHidden: true });
  await main.init();
  const hidden = stub.windows[0];
  hidden.onceHandlers['ready-to-show']();
  assert.ok(!hidden.calls.some((c) => c[0] === 'showInactive' || c[0] === 'show'));
});

test('registerHotkey notifies the renderer on non-string accelerators', async () => {
  await main.init();
  assert.equal(main.registerHotkey(null), false);
  assert.equal(main.registerHotkey(123), false);
  const errors = stub.sent.filter(([ch]) => ch === 'xorview:hotkey-error');
  assert.equal(errors.length, 2);
});

test('failed hotkey registration keeps the tray toggle working', async () => {
  await main.init();
  stub.registerResult = false;
  assert.equal(main.registerHotkey('Ctrl+X'), false);
  assert.ok(stub.sent.some(([ch]) => ch === 'xorview:hotkey-error'));
  // Tray menu still offers Show/Hide.
  const labels = stub.trays[0].menu.map((item) => item.label);
  assert.ok(labels.some((l) => /overlay/i.test(l)));
});

test('tray menu includes the click-through escape hatch', async () => {
  await main.init();
  const labels = stub.trays[0].menu.map((item) => item.label);
  assert.ok(labels.some((l) => /Click-through/.test(l)));
  assert.ok(labels.some((l) => /Capture screen now/.test(l)));
  assert.ok(labels.some((l) => /Settings/.test(l)));
  assert.ok(labels.some((l) => /Quit/.test(l)));
  // Toggling updates state and notifies the renderer.
  main.setClickThrough(true);
  assert.equal(main.__test__.getClickThrough(), true);
  assert.ok(stub.sent.some(([ch, v]) => ch === 'xorview:click-through-change' && v === true));
});

test('settings-set merge is allowlisted and keeps keys on empty', async () => {
  await main.init();
  const res = await stub.handlers['xorview:settings-set']({}, JSON.parse('{"__proto__":{"x":1},"hotkey":"Ctrl+K","transcribeApiKey":"","chatApiKey":"c9"}'));
  assert.equal(res.ok, true);
  assert.equal(Object.prototype.x, undefined);
  assert.equal(main.__test__.getSettings().hotkey, 'Ctrl+K');
  // Session-only: chat key lives in memory, never on disk.
  assert.equal(main.__test__.getSessionKeys().chat, 'c9');
  const stored = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'xorview-settings.json'), 'utf8'));
  assert.equal(stored.chatApiKey, '');
  assert.ok(res.settings.hasChatKey);
});

test('transcribe-audio caps unbounded payloads', async () => {
  await main.init();
  const res = await stub.handlers['xorview:transcribe-audio']({}, { audioBase64: 'x'.repeat(main.TRANSCRIBE_MAX_BASE64 + 1) });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'too-large');
});

test('transcribe-audio reports coded missing-key errors', async () => {
  await main.init();
  const res = await stub.handlers['xorview:transcribe-audio']({}, { audioBase64: 'aGk=' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'missing-key');
});

test('test-connection validates slots', async () => {
  await main.init();
  const bad = await stub.handlers['xorview:test-connection']({}, 'bogus');
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'bad-request');
  const missing = await stub.handlers['xorview:test-connection']({}, 'chat');
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'missing-key');
});

test('suggest forwards screenshot image content to the provider', async () => {
  await main.init();
  main.__test__.setSessionKeys({ chat: 'c9' });
  let seenMessages = null;
  const original = providers.chatCompletion;
  providers.chatCompletion = async ({ messages }) => {
    seenMessages = messages;
    return { text: 'suggestion one' };
  };
  try {
    const res = await stub.handlers['xorview:suggest'](
      {},
      { transcript: 'hello', contextNote: 'slide', imageDataUrl: 'data:image/png;base64,shot', interviewType: 'technical' }
    );
    assert.equal(res.ok, true);
    assert.equal(res.text, 'suggestion one');
    const user = seenMessages[seenMessages.length - 1];
    assert.ok(Array.isArray(user.content));
    assert.equal(user.content[1].type, 'image_url');
    assert.match(seenMessages[0].content, /technical/);
  } finally {
    providers.chatCompletion = original;
  }
});

test('capture failures push gap markers and tray balloons', async () => {
  await main.init();
  stub.sourcesImpl = async () => {
    throw new Error('denied');
  };
  const res = await main.doCapture({ source: 'scheduled' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'capture-failed');
  assert.ok(stub.sent.some(([ch]) => ch === 'xorview:capture-gap'));
  assert.equal(stub.balloons.length, 1);

  stub.sourcesImpl = async () => [
    { name: 'Screen 1', thumbnail: { toDataURL: () => 'data:image/png;base64,thumb' } }
  ];
  const ok = await main.doCapture({ source: 'manual' });
  assert.equal(ok.ok, true);
  assert.ok(stub.sent.some(([ch]) => ch === 'xorview:context'));
});

test('transcript log appends and loads only when enabled', async () => {
  await main.init();
  const skipped = await stub.handlers['xorview:transcript-append']({}, { text: 'hello' });
  assert.equal(skipped.ok, true);
  assert.equal(fs.existsSync(path.join(tmpRoot, main.TRANSCRIPT_LOG_FILE)), false);

  main.__test__.setSettings({ ...main.__test__.getSettings(), transcriptLogEnabled: true });
  await stub.handlers['xorview:transcript-append']({}, { text: 'hello world' });
  const loaded = await stub.handlers['xorview:transcript-load']({}, { limit: 10 });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.segments.length, 1);
  assert.equal(loaded.segments[0].text, 'hello world');
});

test('smoke gate fails loudly on did-fail-load', () => {
  assert.deepEqual(main.decideSmokeExit(false), { code: 0, message: 'smoke OK' });
  const fail = main.decideSmokeExit(true);
  assert.equal(fail.code, 1);
  assert.match(fail.message, /smoke FAIL/);
});

test('corrupt settings back up and surface a notice', async () => {
  fs.writeFileSync(path.join(tmpRoot, 'xorview-settings.json'), '{ corrupt', 'utf8');
  await main.init();
  const pub = await stub.handlers['xorview:settings-get']({});
  assert.match(pub.settingsNotice, /corrupt/i);
  const files = fs.readdirSync(tmpRoot);
  assert.ok(files.some((f) => f.startsWith('settings.json.corrupt-')));
});

test('transcribe-audio routes to VoiceStudio without requiring a key', async () => {
  await main.init();
  main.__test__.setSettings({ ...main.__test__.getSettings(), transcribeProvider: 'voicestudio' });
  const realFetch = globalThis.fetch;
  let seenUrl = '';
  let seenHeaders = null;
  globalThis.fetch = async (url, options) => {
    seenUrl = url;
    seenHeaders = options.headers;
    return { ok: true, status: 200, json: async () => ({ text: '  local words  ' }) };
  };
  try {
    const res = await stub.handlers['xorview:transcribe-audio']({}, { audioBase64: 'aGk=', mimeType: 'audio/webm' });
    assert.equal(res.ok, true);
    assert.equal(res.text, 'local words');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seenUrl, 'http://localhost:3900/v1/audio/transcriptions');
  assert.deepEqual(seenHeaders, {});
});

test('test-connection checks VoiceStudio health when selected', async () => {
  await main.init();
  main.__test__.setSettings({ ...main.__test__.getSettings(), transcribeProvider: 'voicestudio' });
  const realFetch = globalThis.fetch;
  let seenUrl = '';
  globalThis.fetch = async (url) => {
    seenUrl = url;
    return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
  };
  try {
    const res = await stub.handlers['xorview:test-connection']({}, 'transcribe');
    assert.equal(res.ok, true);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seenUrl, 'http://localhost:3900/health');
});

test('suggest grounds answers in the candidate profile when active', async () => {
  await main.init();
  main.__test__.setSessionKeys({ chat: 'c9' });
  main.__test__.setSettings({
    ...main.__test__.getSettings(),
    profileEnabled: true,
    candidateName: 'Ada',
    resumeFacts: 'Built billing',
    jobDescription: 'Backend role'
  });
  let seenMessages = null;
  const original = providers.chatCompletion;
  providers.chatCompletion = async ({ messages }) => {
    seenMessages = messages;
    return { text: 'grounded suggestion' };
  };
  try {
    const res = await stub.handlers['xorview:suggest']({}, { transcript: 'hello' });
    assert.equal(res.ok, true);
    assert.match(seenMessages[0].content, /never invent/);
    const user = seenMessages[seenMessages.length - 1];
    assert.match(user.content, /Candidate profile \(confirmed facts\)/);
    assert.match(user.content, /Ada/);
    assert.match(user.content, /Built billing/);
    assert.match(user.content, /Backend role/);
  } finally {
    providers.chatCompletion = original;
  }
});

test('suggest omits the profile block when grounding is off', async () => {
  await main.init();
  main.__test__.setSessionKeys({ chat: 'c9' });
  let seenMessages = null;
  const original = providers.chatCompletion;
  providers.chatCompletion = async ({ messages }) => {
    seenMessages = messages;
    return { text: 'plain suggestion' };
  };
  try {
    await stub.handlers['xorview:suggest']({}, { transcript: 'hello' });
    const user = seenMessages[seenMessages.length - 1];
    assert.doesNotMatch(user.content, /Candidate profile/);
  } finally {
    providers.chatCompletion = original;
  }
});

test('cv-upload parses a CV through core/cv', async () => {
  await main.init();
  const lib = require('../core/cv');
  const original = lib.parseCvUpload;
  let seen = null;
  lib.parseCvUpload = async (payload) => {
    seen = payload;
    return { ok: true, fileName: 'cv.pdf', numpages: 2, fill: { candidateName: 'Ada' } };
  };
  try {
    const res = await stub.handlers['xorview:cv-upload']({}, { fileName: 'cv.pdf', dataBase64: 'eA==' });
    assert.equal(res.ok, true);
    assert.equal(res.fill.candidateName, 'Ada');
    assert.equal(res.numpages, 2);
    assert.equal(seen.fileName, 'cv.pdf');
  } finally {
    lib.parseCvUpload = original;
  }
});

test('cv-upload surfaces parse errors with codes', async () => {
  await main.init();
  const res = await stub.handlers['xorview:cv-upload']({}, { fileName: 'cv.txt', dataBase64: 'eA==' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'bad-request');
});
