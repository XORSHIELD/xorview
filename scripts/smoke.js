'use strict';

/**
 * scripts/smoke.js — packaged smoke test with a did-fail-load assertion.
 *
 * The Electron main process tracks webContents 'did-fail-load' and exits
 * nonzero with "smoke FAIL" when the renderer fails; this script launches
 * the app with --smoke and asserts the "smoke OK" verdict. The monitor
 * helper is pure and unit-tested; the CLI needs a display + Electron and
 * is intended for real Windows targets (Chromium cannot launch here).
 */

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Pure verdict tracker: fail() records a load failure; finish() resolves
 * the exit code/message. Injectable clock/timer for deterministic tests.
 */
function createSmokeMonitor({ timeoutMs = DEFAULT_TIMEOUT_MS, now = () => Date.now() } = {}) {
  const startedAt = now();
  const monitor = {
    failed: false,
    failMessage: '',
    fail(message) {
      monitor.failed = true;
      monitor.failMessage = String(message || 'renderer did-fail-load');
    },
    expired() {
      return now() - startedAt >= timeoutMs;
    },
    finish() {
      if (monitor.failed) return { code: 1, message: `smoke FAIL: ${monitor.failMessage}` };
      return { code: 0, message: 'smoke OK' };
    }
  };
  return monitor;
}

/** Decide the CLI verdict from electron's exit + captured output. */
function decideCliVerdict({ exitCode, output }) {
  const text = String(output || '');
  if (exitCode !== 0) {
    return { code: 1, message: `smoke FAIL: electron exited with code ${exitCode}` };
  }
  if (/smoke FAIL/.test(text)) {
    return { code: 1, message: 'smoke FAIL: app reported a renderer load failure' };
  }
  if (!/smoke OK/.test(text)) {
    return { code: 1, message: 'smoke FAIL: missing "smoke OK" verdict in app output' };
  }
  return { code: 0, message: 'smoke: OK (app started and renderer loaded)' };
}

function runElectronSmoke({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const electronBin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
    const child = spawn(electronBin, ['.', '--smoke'], {
      cwd: ROOT,
      timeout: timeoutMs,
      env: { ...process.env, XORVIEW_SMOKE: '1' }
    });
    let output = '';
    child.stdout.on('data', (d) => {
      output += String(d);
    });
    child.stderr.on('data', (d) => {
      output += String(d);
    });
    child.on('error', (err) => {
      resolve({ code: 1, message: `smoke FAIL: cannot launch electron (${(err && err.message) || err})` });
    });
    child.on('close', (exitCode) => {
      resolve(decideCliVerdict({ exitCode, output }));
    });
  });
}

async function main() {
  const verdict = await runElectronSmoke({});
  console.log(verdict.message);
  process.exit(verdict.code);
}

if (require.main === module) {
  void main();
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  createSmokeMonitor,
  decideCliVerdict,
  runElectronSmoke,
  main
};
