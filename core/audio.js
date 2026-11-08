'use strict';

/**
 * core/audio.js — microphone capture helpers (v2, UMD).
 *
 * The SINGLE recorder implementation used by the renderer: mime picking,
 * clip recording, voice-activity gating, an upload queue with visible
 * depth, and generation tokens that make stop-during-start safe.
 *
 * UMD: works via require() in Node/Electron-main and via
 * window.XorViewAudio when loaded with a <script> tag in the renderer.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.XorViewAudio = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  /** Mime candidates in preference order — renderer must use this list. */
  const DEFAULT_MIME_CANDIDATES = Object.freeze([
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4'
  ]);

  function pickMimeType(candidates, isTypeSupported) {
    const list = Array.isArray(candidates) ? candidates : [];
    const check = typeof isTypeSupported === 'function' ? isTypeSupported : () => false;
    for (const candidate of list) {
      try {
        if (candidate && check(candidate)) return candidate;
      } catch {
        // Ignore and try the next candidate.
      }
    }
    return '';
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      if (typeof FileReader === 'undefined') {
        reject(new Error('FileReader is not available'));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(new Error('Failed to read audio blob'));
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Compute RMS energy of PCM-ish samples in [-1, 1]. Accepts any
   * array-like of numbers; empty input yields 0.
   */
  function computeRms(samples) {
    if (!samples || typeof samples.length !== 'number' || samples.length === 0) return 0;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = Number(samples[i]);
      if (!Number.isFinite(v)) continue;
      sum += v * v;
      n += 1;
    }
    if (n === 0) return 0;
    return Math.sqrt(sum / n);
  }

  /** True when the clip's energy is below the silence threshold. */
  function isSilentEnergy(energy, threshold) {
    const t = Number(threshold);
    const e = Number(energy);
    if (!Number.isFinite(e)) return true;
    if (!Number.isFinite(t)) return false;
    return e < t;
  }

  /**
   * Decide whether a recorded clip should be skipped instead of uploaded.
   * Skips empty clips always; when VAD is enabled, also skips clips whose
   * measured energy is below the threshold.
   *
   * @param {object} clip { size, energy } — size in bytes, energy 0..1 (optional)
   * @param {object} opts { vadEnabled, vadThreshold }
   * @returns {{ skip: boolean, reason: string }}
   */
  function shouldSkipClip(clip, opts) {
    const size = clip ? Number(clip.size) : 0;
    if (!Number.isFinite(size) || size <= 0) return { skip: true, reason: 'empty' };
    const options = opts || {};
    if (!options.vadEnabled) return { skip: false, reason: 'vad-off' };
    if (clip.energy === undefined || clip.energy === null) return { skip: false, reason: 'no-energy' };
    if (isSilentEnergy(clip.energy, options.vadThreshold)) return { skip: true, reason: 'silence' };
    return { skip: false, reason: 'speech' };
  }

  /**
   * Serial upload queue with visible depth. Clips are never dropped:
   * they wait their turn while a request is in flight.
   */
  class UploadQueue {
    constructor({ handler = null, onDepth = null } = {}) {
      this.handler = typeof handler === 'function' ? handler : null;
      this.onDepth = typeof onDepth === 'function' ? onDepth : null;
      this.items = [];
      this.busy = false;
      this.drained = 0;
    }

    depth() {
      return this.items.length + (this.busy ? 1 : 0);
    }

    enqueue(item) {
      this.items.push(item);
      this.emitDepth();
      void this.pump();
      return this.depth();
    }

    clear() {
      this.items = [];
      this.emitDepth();
    }

    emitDepth() {
      if (this.onDepth) {
        try {
          this.onDepth(this.depth());
        } catch {
          // Listener errors must not break the queue.
        }
      }
    }

    async pump() {
      if (this.busy) return;
      const next = this.items.shift();
      if (next === undefined) {
        this.emitDepth();
        return;
      }
      this.busy = true;
      this.emitDepth();
      try {
        if (this.handler) await this.handler(next);
      } catch {
        // A failing clip must not break the queue; the next clip follows.
      } finally {
        this.busy = false;
        this.drained += 1;
        if (this.items.length > 0) {
          void this.pump();
        } else {
          this.emitDepth();
        }
      }
    }
  }

  /**
   * Generation counter that makes stop-during-start safe. The renderer
   * takes a token before awaiting getUserMedia; if stop() runs first, the
   * token is stale and the late stream must be closed, never recorded.
   */
  class ListenSession {
    constructor() {
      this.generation = 0;
      this.activeToken = 0;
    }

    /** Take a token for a pending start; invalidated by stop(). */
    beginStart() {
      this.generation += 1;
      this.activeToken = this.generation;
      return this.generation;
    }

    /** True when the token is still the current pending/active start. */
    isCurrent(token) {
      return token === this.activeToken && token !== 0;
    }

    /** Invalidate any pending start (idempotent). */
    stop() {
      this.activeToken = 0;
    }
  }

  /**
   * Records fixed-length audio clips from a MediaStream and emits each clip
   * as { base64, mimeType, size, energy } via onClip. No-ops cleanly
   * outside Chromium. Energy metering is optional (analyser hook).
   */
  class AudioClipRecorder {
    constructor({ clipMs = 5000, mimeType = '', onClip = null, energySource = null } = {}) {
      this.clipMs = clipMs;
      this.mimeType = mimeType;
      this.onClip = typeof onClip === 'function' ? onClip : null;
      this.energySource = energySource;
      this.recorder = null;
      this.running = false;
    }

    static supported() {
      return typeof MediaRecorder !== 'undefined';
    }

    start(stream) {
      if (typeof MediaRecorder === 'undefined') {
        throw new Error('MediaRecorder is not available in this environment');
      }
      if (!stream) throw new Error('A MediaStream is required');
      if (this.running) return;
      const options = this.mimeType ? { mimeType: this.mimeType } : undefined;
      const recorder = new MediaRecorder(stream, options);
      recorder.ondataavailable = async (event) => {
        if (!event.data || event.data.size === 0) return;
        try {
          const base64 = await blobToBase64(event.data);
          let energy;
          try {
            energy = typeof this.energySource === 'function' ? this.energySource() : undefined;
          } catch {
            energy = undefined;
          }
          if (this.onClip) {
            this.onClip({
              base64,
              mimeType: recorder.mimeType || this.mimeType,
              size: event.data.size,
              energy
            });
          }
        } catch {
          // Drop undecodable clips; the next clip follows shortly.
        }
      };
      recorder.start(this.clipMs);
      this.recorder = recorder;
      this.running = true;
    }

    stop() {
      if (this.recorder && this.running) {
        try {
          this.recorder.stop();
        } catch {
          // Already stopped; safe to ignore.
        }
      }
      this.recorder = null;
      this.running = false;
    }
  }

  return {
    DEFAULT_MIME_CANDIDATES,
    pickMimeType,
    blobToBase64,
    computeRms,
    isSilentEnergy,
    shouldSkipClip,
    UploadQueue,
    ListenSession,
    AudioClipRecorder
  };
});
