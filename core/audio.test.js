'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const audio = require('./audio');

test('DEFAULT_MIME_CANDIDATES is the single shared candidate list', () => {
  assert.ok(Array.isArray(audio.DEFAULT_MIME_CANDIDATES));
  assert.ok(audio.DEFAULT_MIME_CANDIDATES.length >= 2);
  assert.ok(Object.isFrozen(audio.DEFAULT_MIME_CANDIDATES));
});

test('pickMimeType returns the first supported candidate', () => {
  const supported = new Set(['audio/webm']);
  const picked = audio.pickMimeType(audio.DEFAULT_MIME_CANDIDATES, (c) => supported.has(c));
  assert.equal(picked, 'audio/webm');
  assert.equal(audio.pickMimeType(['a', 'b'], () => false), '');
  assert.equal(audio.pickMimeType(null, () => true), '');
});

test('computeRms measures signal energy', () => {
  assert.equal(audio.computeRms([]), 0);
  assert.equal(audio.computeRms(new Float32Array([0, 0, 0])), 0);
  assert.ok(Math.abs(audio.computeRms([1, -1, 1, -1]) - 1) < 1e-9);
  assert.ok(audio.computeRms([0.5, 0.5]) < 1);
});

test('shouldSkipClip gates silence and empty clips only', () => {
  assert.deepEqual(audio.shouldSkipClip({ size: 0 }, { vadEnabled: true }), { skip: true, reason: 'empty' });
  assert.deepEqual(
    audio.shouldSkipClip({ size: 100, energy: 0.001 }, { vadEnabled: true, vadThreshold: 0.02 }),
    { skip: true, reason: 'silence' }
  );
  assert.deepEqual(
    audio.shouldSkipClip({ size: 100, energy: 0.5 }, { vadEnabled: true, vadThreshold: 0.02 }),
    { skip: false, reason: 'speech' }
  );
  assert.deepEqual(
    audio.shouldSkipClip({ size: 100, energy: 0.001 }, { vadEnabled: false }),
    { skip: false, reason: 'vad-off' }
  );
  assert.deepEqual(
    audio.shouldSkipClip({ size: 100 }, { vadEnabled: true, vadThreshold: 0.02 }),
    { skip: false, reason: 'no-energy' }
  );
});

test('UploadQueue never drops clips and reports depth', async () => {
  const seen = [];
  const depths = [];
  const queue = new audio.UploadQueue({
    handler: async (clip) => {
      await new Promise((r) => setTimeout(r, 10));
      seen.push(clip);
    },
    onDepth: (d) => depths.push(d)
  });
  queue.enqueue('a');
  queue.enqueue('b');
  queue.enqueue('c');
  assert.equal(queue.depth(), 3);
  for (let i = 0; i < 100 && seen.length < 3; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.equal(queue.depth(), 0);
  assert.ok(depths.length > 0);
  assert.equal(depths[depths.length - 1], 0);
});

test('UploadQueue keeps working when a handler throws', async () => {
  const seen = [];
  const queue = new audio.UploadQueue({
    handler: async (clip) => {
      // eslint-disable-next-line no-throw-literal
      if (clip === 'bad') throw 'boom';
      seen.push(clip);
    }
  });
  queue.enqueue('bad');
  queue.enqueue('good');
  for (let i = 0; i < 100 && seen.length < 1; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.deepEqual(seen, ['good']);
});

test('ListenSession invalidates pending starts on stop', () => {
  const session = new audio.ListenSession();
  const token = session.beginStart();
  assert.equal(session.isCurrent(token), true);
  session.stop();
  assert.equal(session.isCurrent(token), false);
  const token2 = session.beginStart();
  assert.equal(session.isCurrent(token2), true);
  assert.equal(session.isCurrent(token), false);
});

test('blobToBase64 rejects without FileReader', async () => {
  await assert.rejects(() => audio.blobToBase64({}), /FileReader/);
});

test('AudioClipRecorder reports unsupported outside Chromium', () => {
  assert.equal(audio.AudioClipRecorder.supported(), false);
  const recorder = new audio.AudioClipRecorder({ clipMs: 100 });
  assert.throws(() => recorder.start({}), /MediaRecorder/);
  recorder.stop(); // safe no-op
});
