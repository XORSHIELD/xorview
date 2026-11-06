'use strict';

/**
 * scripts/build.js — XorView build gate: validates the packaging config and
 * required files, then runs lint. The real installer is built with
 * `npm run dist` (electron-builder).
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const REQUIRED_FILES = [
  'package.json',
  'electron/main.js',
  'electron/preload.js',
  'renderer/index.html',
  'renderer/app.js',
  'renderer/styles.css',
  'core/settings.js',
  'core/providers.js',
  'core/screen.js',
  'core/audio.js',
  'assets/tray.png',
  '.gitignore',
  'README.md'
];

function fail(message) {
  console.error(`build FAIL: ${message}`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (!pkg.build || !pkg.build.appId || !pkg.build.win) {
  fail('package.json is missing electron-builder config (build.appId / build.win)');
}
const targets = JSON.stringify(pkg.build.win);
if (!targets.includes('nsis')) {
  fail('package.json win target must include nsis');
}
for (const file of pkg.build.files || []) {
  if (/(^|\/)\.env/i.test(file) || /secret/i.test(file)) {
    fail(`packaging config must not bundle secrets (${file})`);
  }
}

for (const rel of REQUIRED_FILES) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    fail(`missing required file ${rel}`);
  }
}

try {
  execFileSync(process.execPath, [path.join(__dirname, 'lint.js')], { stdio: 'inherit' });
} catch {
  fail('lint failed');
}

console.log('build: OK (packaging config + required files + lint)');
