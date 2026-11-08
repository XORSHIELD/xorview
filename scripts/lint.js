'use strict';

/**
 * scripts/lint.js — XorView static checks:
 *  1. Syntax-check every project JS file (node --check equivalent).
 *  2. Fail on committed secret patterns or stray secret files.
 *  3. Require .gitignore coverage for node_modules and secret files.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const JS_FILES = [
  'electron/main.js',
  'electron/preload.js',
  'renderer/app.js',
  'core/settings.js',
  'core/providers.js',
  'core/screen.js',
  'core/audio.js',
  'core/suggest.js',
  'core/voicestudio.js',
  'core/profile.js',
  'core/cv.js',
  'core/settings.test.js',
  'core/providers.test.js',
  'core/screen.test.js',
  'core/audio.test.js',
  'core/suggest.test.js',
  'core/voicestudio.test.js',
  'core/profile.test.js',
  'core/cv.test.js',
  'scripts/lint.js',
  'scripts/build.js',
  'scripts/make-icon.js',
  'scripts/smoke.js',
  'scripts/scripts.test.js',
  'test/main.test.js',
  'test/renderer.test.js'
];

const SECRET_FILE_NAMES = ['.env', '.env.local', 'secrets.json'];

// Built from fragments so this file's own source never matches the scan.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
  new RegExp('sk-' + '[A-Za-z0-9-_]{20,}'),
  new RegExp('xox' + '[abop]-' + '[A-Za-z0-9-]{8,}'),
  new RegExp('api' + '[_-]?key' + '\\s*[:=]\\s*["\'][^"\'\\s]{8,}["\']', 'i'),
  new RegExp('["\']?secret' + '[_-]?key' + '["\']?\\s*[:=]\\s*["\'][^"\'\\s]{8,}["\']', 'i')
];

/** Return the patterns matching text (exported for unit tests). */
function scanText(text) {
  return SECRET_PATTERNS.filter((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(String(text || ''));
  });
}

function checkSyntax() {
  const failures = [];
  for (const rel of JS_FILES) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) {
      failures.push(`missing file ${rel}`);
      continue;
    }
    try {
      execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
    } catch {
      failures.push(`syntax error in ${rel}`);
    }
  }
  return failures;
}

function checkSecrets() {
  const failures = [];
  const scanTargets = [...JS_FILES, 'renderer/index.html', 'package.json', 'README.md', 'SPEC.md'];
  for (const rel of scanTargets) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const pattern of scanText(text)) {
      failures.push(`possible committed secret in ${rel} (${pattern})`);
    }
  }
  for (const name of SECRET_FILE_NAMES) {
    if (fs.existsSync(path.join(ROOT, name))) {
      failures.push(`secret file present in repo: ${name}`);
    }
  }
  return failures;
}

function checkGitignore() {
  const failures = [];
  const full = path.join(ROOT, '.gitignore');
  if (!fs.existsSync(full)) {
    failures.push('missing .gitignore');
    return failures;
  }
  const text = fs.readFileSync(full, 'utf8');
  for (const required of ['node_modules', '.env']) {
    if (!text.includes(required)) {
      failures.push(`.gitignore does not cover "${required}"`);
    }
  }
  return failures;
}

function run() {
  const failures = [...checkSyntax(), ...checkSecrets(), ...checkGitignore()];
  for (const failure of failures) {
    console.error(`lint FAIL: ${failure}`);
  }
  if (failures.length > 0) {
    console.error(`lint: ${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log(`lint: OK (${JS_FILES.length} files checked, no secrets found)`);
}

if (require.main === module) {
  run();
}

module.exports = {
  ROOT,
  JS_FILES,
  SECRET_FILE_NAMES,
  SECRET_PATTERNS,
  scanText,
  checkSyntax,
  checkSecrets,
  checkGitignore,
  run
};
