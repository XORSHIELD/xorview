'use strict';

/**
 * core/screen.js — screen-context capture helpers (v2, UMD).
 *
 * The Electron `desktopCapturer.getSources` function is injected, so this
 * module stays testable without Electron. Uses only public capture APIs;
 * never interferes with other software.
 *
 * UMD: require() in Node/Electron-main, window.XorViewScreen in renderer.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.XorViewScreen = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT_MAX_ITEMS = 20;
  const DEFAULT_MAX_BYTES = 12 * 1024 * 1024; // ~12 MB of PNG data URLs

  let nextId = 1;

  function resetIdsForTests() {
    nextId = 1;
  }

  /**
   * Salient-text extraction hook. When OCR/text is supplied (from a future
   * OCR path or the capture pipeline), it becomes the note; otherwise a
   * factual summary is generated so the note is NEVER the empty stub.
   */
  function extractSalientText({ sourceName, timestamp, ocrText } = {}) {
    const ocr = String(ocrText || '').trim();
    if (ocr) return ocr.slice(0, 2000);
    const when = timestamp || new Date().toISOString();
    const src = sourceName || 'screen';
    return `Screen capture from ${src} at ${when}. No text extraction available for this capture.`;
  }

  function buildContextEntry({ pngDataUrl, sourceName, timestamp, note, ocrText } = {}) {
    return {
      id: nextId++,
      timestamp: timestamp || new Date().toISOString(),
      sourceName: sourceName || 'screen',
      pngDataUrl: pngDataUrl || '',
      note: note !== undefined && note !== null && String(note).trim() !== ''
        ? String(note)
        : extractSalientText({ sourceName, timestamp, ocrText })
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

  /**
   * Aspect-correct thumbnail size for a source of (sourceWidth x sourceHeight),
   * scaled so the width is at most maxWidth. Falls back to 16:9 only when
   * the source size is unknown.
   */
  function thumbnailSizeFor(sourceWidth, sourceHeight, maxWidth) {
    const maxW = Math.max(1, Math.round(Number(maxWidth) || 960));
    const sw = Number(sourceWidth);
    const sh = Number(sourceHeight);
    if (Number.isFinite(sw) && Number.isFinite(sh) && sw > 0 && sh > 0) {
      return { width: maxW, height: Math.max(1, Math.round((maxW * sh) / sw)) };
    }
    return { width: maxW, height: Math.round((maxW * 9) / 16) };
  }

  /**
   * Estimate the in-memory footprint of a context entry (UTF-16 chars ~2B).
   */
  function entryBytes(entry) {
    if (!entry) return 0;
    return (
      String(entry.pngDataUrl || '').length * 2 +
      String(entry.note || '').length * 2 +
      String(entry.sourceName || '').length * 2 +
      128
    );
  }

  async function capturePrimaryScreen(
    getSources,
    { thumbnailWidth = 960, sourceSize = null, extractText = null } = {}
  ) {
    if (typeof getSources !== 'function') {
      throw new Error('getSources function is required');
    }
    const size = sourceSize
      ? thumbnailSizeFor(sourceSize.width, sourceSize.height, thumbnailWidth)
      : thumbnailSizeFor(NaN, NaN, thumbnailWidth);
    const sources = await getSources({
      types: ['screen'],
      thumbnailSize: { width: size.width, height: size.height }
    });
    const primary = pickPrimarySource(sources);
    if (!primary || !primary.thumbnail || typeof primary.thumbnail.toDataURL !== 'function') {
      throw new Error('No screen source available');
    }
    // When the thumbnail reports its own size, it is the best aspect hint.
    let ocrText = '';
    if (typeof extractText === 'function') {
      try {
        ocrText = String((await extractText(primary)) || '');
      } catch {
        ocrText = '';
      }
    }
    return buildContextEntry({
      pngDataUrl: primary.thumbnail.toDataURL(),
      sourceName: primary.name,
      timestamp: new Date().toISOString(),
      ocrText
    });
  }

  /**
   * Bounded in-memory store for context entries: oldest-first eviction by
   * item count AND total bytes, plus per-item delete.
   */
  class ContextStore {
    constructor({ maxItems = DEFAULT_MAX_ITEMS, maxBytes = DEFAULT_MAX_BYTES } = {}) {
      this.maxItems = maxItems;
      this.maxBytes = maxBytes;
      this.entries = [];
    }

    bytes() {
      return this.entries.reduce((sum, e) => sum + entryBytes(e), 0);
    }

    count() {
      return this.entries.length;
    }

    list() {
      return [...this.entries];
    }

    latest() {
      return this.entries.length > 0 ? this.entries[this.entries.length - 1] : null;
    }

    add(entry) {
      if (!entry) return null;
      this.entries.push(entry);
      this.evict();
      return entry;
    }

    remove(id) {
      const before = this.entries.length;
      this.entries = this.entries.filter((e) => e && e.id !== id);
      return this.entries.length !== before;
    }

    clear() {
      this.entries = [];
    }

    evict() {
      while (this.entries.length > this.maxItems) this.entries.shift();
      while (this.entries.length > 0 && this.bytes() > this.maxBytes) this.entries.shift();
    }
  }

  return {
    DEFAULT_MAX_ITEMS,
    DEFAULT_MAX_BYTES,
    buildContextEntry,
    pickPrimarySource,
    thumbnailSizeFor,
    entryBytes,
    extractSalientText,
    capturePrimaryScreen,
    ContextStore,
    resetIdsForTests
  };
});
