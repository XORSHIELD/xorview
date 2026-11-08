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

test('buildContextEntry never leaves an empty note stub', () => {
  const entry = screen.buildContextEntry({ pngDataUrl: 'x', sourceName: 'Screen 1' });
  assert.ok(entry.note && entry.note.length > 0);
  assert.match(entry.note, /Screen 1/);
  const withOcr = screen.buildContextEntry({ pngDataUrl: 'x', ocrText: '  quarterly results  ' });
  assert.equal(withOcr.note, 'quarterly results');
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

test('capturePrimaryScreen runs the text-extraction hook', async () => {
  const getSources = async () => [
    { name: 'Screen 1', thumbnail: { toDataURL: () => 'data:image/png;base64,thumb' } }
  ];
  const entry = await screen.capturePrimaryScreen(getSources, {
    extractText: async (source) => `text from ${source.name}`
  });
  assert.equal(entry.note, 'text from Screen 1');
});

test('thumbnailSizeFor preserves aspect ratio', () => {
  assert.deepEqual(screen.thumbnailSizeFor(1920, 1080, 960), { width: 960, height: 540 });
  assert.deepEqual(screen.thumbnailSizeFor(1080, 1920, 480), { width: 480, height: 853 });
  assert.deepEqual(screen.thumbnailSizeFor(3440, 1440, 960), { width: 960, height: 402 });
  // Unknown source size falls back to 16:9.
  assert.deepEqual(screen.thumbnailSizeFor(NaN, NaN, 960), { width: 960, height: 540 });
});

test('capturePrimaryScreen requests aspect-correct thumbnails', async () => {
  let seenOptions = null;
  const getSources = async (options) => {
    seenOptions = options;
    return [{ name: 'Screen 1', thumbnail: { toDataURL: () => 'x' } }];
  };
  await screen.capturePrimaryScreen(getSources, {
    thumbnailWidth: 480,
    sourceSize: { width: 1080, height: 1920 }
  });
  assert.deepEqual(seenOptions.thumbnailSize, { width: 480, height: 853 });
});

test('ContextStore evicts oldest-first by count and bytes', () => {
  const store = new screen.ContextStore({ maxItems: 2, maxBytes: 10 ** 9 });
  store.add(screen.buildContextEntry({ pngDataUrl: 'a', sourceName: 's1' }));
  store.add(screen.buildContextEntry({ pngDataUrl: 'b', sourceName: 's2' }));
  store.add(screen.buildContextEntry({ pngDataUrl: 'c', sourceName: 's3' }));
  assert.equal(store.count(), 2);
  assert.equal(store.latest().pngDataUrl, 'c');

  const big = screen.buildContextEntry({ pngDataUrl: 'x'.repeat(5000), sourceName: 'big' });
  const small = screen.buildContextEntry({ pngDataUrl: 'y', sourceName: 'small' });
  const cap = screen.entryBytes(small) + 64;
  assert.ok(screen.entryBytes(big) > cap);
  const tiny = new screen.ContextStore({ maxItems: 100, maxBytes: cap });
  tiny.add(big);
  tiny.add(small);
  assert.ok(tiny.bytes() <= cap);
  assert.equal(tiny.latest().sourceName, 'small');
});

test('ContextStore supports per-item delete and clear', () => {
  const store = new screen.ContextStore({});
  const a = store.add(screen.buildContextEntry({ pngDataUrl: 'a' }));
  store.add(screen.buildContextEntry({ pngDataUrl: 'b' }));
  assert.equal(store.remove(a.id), true);
  assert.equal(store.count(), 1);
  assert.equal(store.remove(999999), false);
  store.clear();
  assert.equal(store.count(), 0);
  assert.equal(store.latest(), null);
});
