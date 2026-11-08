'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const lint = require('./lint');
const build = require('./build');
const makeIcon = require('./make-icon');
const smoke = require('./smoke');

// Secret fixtures are assembled from fragments so this file's own source
// never matches the secret scan it is testing.
const FRAG = {
  openai: () => 'sk' + '-' + 'abcdefghij1234567890XY',
  aws: () => 'AKI' + 'A' + 'IOSFODNN7EXAMPLE',
  pem: () => '-----BEGIN ' + 'RSA PRIVATE KEY-----',
  apiAssign: () => 'api' + '_key' + ' = ' + '"Sup3rSecretValue99"',
  pluginToken: () => 'xox' + 'b-' + '1234567890abcdef',
  clean: () => 'const transcribeApiKey = getKey(); // short ref k1'
};

test('secret scan catches OpenAI-style keys', () => {
  assert.ok(lint.scanText(`key=${FRAG.openai()}`).length >= 1);
});

test('secret scan catches AWS keys, private keys, and assignments', () => {
  assert.ok(lint.scanText(FRAG.aws()).length >= 1);
  assert.ok(lint.scanText(FRAG.pem()).length >= 1);
  assert.ok(lint.scanText(FRAG.apiAssign()).length >= 1);
  assert.ok(lint.scanText(FRAG.pluginToken()).length >= 1);
});

test('secret scan stays quiet on clean code', () => {
  assert.deepEqual(lint.scanText(FRAG.clean()), []);
  assert.deepEqual(lint.scanText('no secrets here, just a hotkey Ctrl+K'), []);
  assert.deepEqual(lint.scanText('transcribeApiKey: (missing)'), []);
});

test('lint module has no import side effects', () => {
  assert.ok(Array.isArray(lint.JS_FILES));
  assert.ok(lint.JS_FILES.includes('core/suggest.js'));
  assert.ok(lint.JS_FILES.includes('core/profile.js'));
  assert.ok(lint.JS_FILES.includes('core/cv.js'));
  assert.ok(lint.JS_FILES.includes('scripts/smoke.js'));
});

test('build readPackageJson reports corrupt JSON cleanly', () => {
  const read = build.readPackageJson();
  assert.equal(read.ok, true);
  assert.ok(read.pkg.build);
});

test('build validatePackage requires nsis, icon, and test exclusion', () => {
  const good = {
    build: {
      appId: 'x',
      win: { icon: 'assets/icon.ico', target: [{ target: 'nsis' }] },
      files: ['core/**', '!**/*.test.js']
    }
  };
  assert.deepEqual(build.validatePackage(good), []);

  const missing = build.validatePackage({ build: { appId: 'x', win: { target: ['nsis'] }, files: ['core/**'] } });
  assert.ok(missing.some((m) => /test exclusion|exclude test/.test(m)));
  assert.ok(missing.some((m) => /icon/.test(m)));

  assert.ok(build.validatePackage(null).length > 0);
  assert.ok(build.validatePackage({}).length > 0);
});

test('build module has no import side effects', () => {
  assert.ok(Array.isArray(build.REQUIRED_FILES));
  assert.ok(build.REQUIRED_FILES.includes('core/suggest.js'));
  assert.ok(build.REQUIRED_FILES.includes('core/profile.js'));
  assert.ok(build.REQUIRED_FILES.includes('core/cv.js'));
  assert.ok(build.REQUIRED_FILES.includes('node_modules/pdf-parse/package.json'));
});

test('make-icon has no import side effects and writes icons on main()', () => {
  const dir = fs.mkdtempSync(path.join(__dirname, '.test-tmp-icon-'));
  try {
    // Import alone must not write into the repo assets dir mtime-wise;
    // main(dir) writes all three artifacts to the given dir.
    const written = makeIcon.main(dir);
    assert.equal(written.length, 3);
    for (const file of written) {
      assert.ok(fs.existsSync(file));
      assert.ok(fs.statSync(file).size > 100);
    }
    const pngSig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(fs.readFileSync(path.join(dir, 'tray.png')).subarray(0, 8).equals(pngSig));
    const ico = fs.readFileSync(path.join(dir, 'icon.ico'));
    assert.equal(ico.readUInt16LE(0), 0);
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke monitor asserts failures loudly', () => {
  let now = 1000;
  const monitor = smoke.createSmokeMonitor({ timeoutMs: 500, now: () => now });
  assert.equal(monitor.expired(), false);
  now += 600;
  assert.equal(monitor.expired(), true);
  assert.deepEqual(monitor.finish(), { code: 0, message: 'smoke OK' });
  monitor.fail('did-fail-load 404');
  assert.deepEqual(monitor.finish(), { code: 1, message: 'smoke FAIL: did-fail-load 404' });
});

test('smoke CLI verdict requires the OK marker', () => {
  assert.equal(smoke.decideCliVerdict({ exitCode: 0, output: '[xorview] smoke OK' }).code, 0);
  assert.equal(smoke.decideCliVerdict({ exitCode: 1, output: 'smoke OK' }).code, 1);
  assert.equal(smoke.decideCliVerdict({ exitCode: 0, output: 'smoke FAIL: x' }).code, 1);
  assert.equal(smoke.decideCliVerdict({ exitCode: 0, output: 'no verdict here' }).code, 1);
});
