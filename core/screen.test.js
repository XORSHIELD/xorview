'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const screen = require('./screen');

test('buildContextEntry returns a shaped entry', () => {
  const entry = screen.buildContextEntry({
    pngDataUrl: 'data:image/png;base64,xx',
    sourceName: 'Screen 1',
    timestamp: '2026-01-01T00:00:00.000Z'
  });
  assert.equal(entry.timestamp, '2026-01-01T00:00:00.000Z');
  assert.equal(entry.sourceName, 'Screen 1');
  assert.equal(entry.pngDataUrl, 'data:image/png;base64,xx');
  assert.ok(Number.isInteger(entry.id));
});

test('pickPrimarySource prefers Entire Screen, then Screen prefix', () => {
  const sources = [{ name: 'Window A' }, { name: 'Screen 2' }, { name: 'Entire Screen' }];
  assert.equal(screen.pickPrimarySource(sources).name, 'Entire Screen');
  assert.equal(screen.pickPrimarySource(sources.slice(0, 2)).name, 'Screen 2');
  assert.equal(screen.pickPrimarySource([]), null);
});

test('capturePrimaryScreen uses injected getSources', async () => {
  let seenOptions = null;
  const getSources = async (options) => {
    seenOptions = options;
    return [{ name: 'Screen 1', thumbnail: { toDataURL: () => 'data:image/png;base64,thumb' } }];
  };
  const entry = await screen.capturePrimaryScreen(getSources, { thumbnailWidth: 480 });
  assert.deepEqual(seenOptions.types, ['screen']);
  assert.equal(entry.pngDataUrl, 'data:image/png;base64,thumb');
  assert.equal(entry.sourceName, 'Screen 1');
});

test('capturePrimaryScreen throws when no source is available', async () => {
  await assert.rejects(() => screen.capturePrimaryScreen(async () => [], {}));
});
