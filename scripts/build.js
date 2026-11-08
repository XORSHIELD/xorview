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
  'core/suggest.js',
  'core/voicestudio.js',
  'core/profile.js',
  'core/cv.js',
  'node_modules/pdf-parse/package.json',
  'scripts/smoke.js',
  'assets/tray.png',
  'assets/icon.png',
  'assets/icon.ico',
  '.gitignore',
  'README.md'
];

function readPackageJson() {
  const full = path.join(ROOT, 'package.json');
  let raw;
  try {
    raw = fs.readFileSync(full, 'utf8');
  } catch (err) {
    return { ok: false, error: `cannot read package.json: ${(err && err.message) || err}` };
  }
  try {
    return { ok: true, pkg: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: `package.json is not valid JSON: ${(err && err.message) || err}` };
  }
}

/** Validate packaging config; returns failure strings (exported for tests). */
function validatePackage(pkg) {
  const failures = [];
  if (!pkg || typeof pkg !== 'object') {
    return ['package.json did not parse to an object'];
  }
  if (!pkg.build || !pkg.build.appId || !pkg.build.win) {
    failures.push('package.json is missing electron-builder config (build.appId / build.win)');
    return failures;
  }
  const targets = JSON.stringify(pkg.build.win);
  if (!targets.includes('nsis')) {
    failures.push('package.json win target must include nsis');
  }
  const files = pkg.build.files || [];
  for (const file of files) {
    if (/(^|\/)\.env/i.test(file) || /secret/i.test(file)) {
      failures.push(`packaging config must not bundle secrets (${file})`);
    }
  }
  const joined = files.join('\n');
  if (!/!\*\*\/\*\.test\.js/.test(joined) && !/!\*\*\/\*.test.js/.test(joined)) {
    failures.push('packaging config must exclude test files ("!**/*.test.js" in build.files)');
  }
  if (!pkg.build.win.icon) {
    failures.push('package.json win target must configure an installer icon (build.win.icon)');
  }
  return failures;
}

function run() {
  const failures = [];
  const read = readPackageJson();
  if (!read.ok) {
    console.error(`build FAIL: ${read.error}`);
    process.exit(1);
  }
  failures.push(...validatePackage(read.pkg));

  for (const rel of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(ROOT, rel))) {
      failures.push(`missing required file ${rel}`);
    }
  }

  for (const failure of failures) {
    console.error(`build FAIL: ${failure}`);
  }
  if (failures.length > 0) {
    process.exit(1);
  }

  try {
    execFileSync(process.execPath, [path.join(__dirname, 'lint.js')], { stdio: 'inherit' });
  } catch {
    console.error('build FAIL: lint failed');
    process.exit(1);
  }

  console.log('build: OK (packaging config + required files + lint)');
}

if (require.main === module) {
  run();
}

module.exports = {
  ROOT,
  REQUIRED_FILES,
  readPackageJson,
  validatePackage,
  run
};
