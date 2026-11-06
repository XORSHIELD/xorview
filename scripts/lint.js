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
  'core/settings.test.js',
  'core/providers.test.js',
  'core/screen.test.js',
  'scripts/lint.js',
  'scripts/build.js',
  'scripts/make-icon.js'
];

const SECRET_FILE_NAMES = ['.env', '.env.local', 'secrets.json'];

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/
];

let failures = 0;

function fail(message) {
  failures += 1;
  console.error(`lint FAIL: ${message}`);
}

function checkSyntax() {
  for (const rel of JS_FILES) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) {
      fail(`missing file ${rel}`);
      continue;
    }
    try {
      execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
    } catch {
      fail(`syntax error in ${rel}`);
    }
  }
}

function checkSecrets() {
  const scanTargets = [...JS_FILES, 'renderer/index.html', 'package.json', 'README.md'];
  for (const rel of scanTargets) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        fail(`possible committed secret in ${rel} (${pattern})`);
      }
    }
  }
  for (const name of SECRET_FILE_NAMES) {
    if (fs.existsSync(path.join(ROOT, name))) {
      fail(`secret file present in repo: ${name}`);
    }
  }
}

function checkGitignore() {
  const full = path.join(ROOT, '.gitignore');
  if (!fs.existsSync(full)) {
    fail('missing .gitignore');
    return;
  }
  const text = fs.readFileSync(full, 'utf8');
  for (const required of ['node_modules', '.env']) {
    if (!text.includes(required)) {
      fail(`.gitignore does not cover "${required}"`);
    }
  }
}

checkSyntax();
checkSecrets();
checkGitignore();

if (failures > 0) {
  console.error(`lint: ${failures} failure(s)`);
  process.exit(1);
}
console.log(`lint: OK (${JS_FILES.length} files checked, no secrets found)`);
