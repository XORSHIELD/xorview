'use strict';

/**
 * core/screen.js — screen-context capture helpers.
 *
 * The Electron `desktopCapturer.getSources` function is injected, so this
 * module stays testable without Electron. Uses only public capture APIs;
 * never interferes with other software.
 */

let nextId = 1;

function buildContextEntry({ pngDataUrl, sourceName, timestamp }) {
  return {
    id: nextId++,
    timestamp: timestamp || new Date().toISOString(),
    sourceName: sourceName || 'screen',
    pngDataUrl: pngDataUrl || '',
    note: ''
  };
}

function pickPrimarySource(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return null;
  return (
    sources.find((s) => s && typeof s.name === 'string' && /^entire screen/i.test(s.name)) ||
    sources.find((s) => s && typeof s.name === 'string' && /^screen/i.test(s.name)) ||
    sources[0]
  );
}

async function capturePrimaryScreen(getSources, { thumbnailWidth = 960 } = {}) {
  if (typeof getSources !== 'function') {
    throw new Error('getSources function is required');
  }
  const height = Math.round((thumbnailWidth * 9) / 16);
  const sources = await getSources({
    types: ['screen'],
    thumbnailSize: { width: thumbnailWidth, height }
  });
  const primary = pickPrimarySource(sources);
  if (!primary || !primary.thumbnail || typeof primary.thumbnail.toDataURL !== 'function') {
    throw new Error('No screen source available');
  }
  return buildContextEntry({
    pngDataUrl: primary.thumbnail.toDataURL(),
    sourceName: primary.name,
    timestamp: new Date().toISOString()
  });
}

module.exports = {
  buildContextEntry,
  pickPrimarySource,
  capturePrimaryScreen
};
