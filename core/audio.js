'use strict';

/**
 * core/audio.js — microphone capture helpers for the renderer process.
 *
 * MediaRecorder-based clip recording: the renderer records short clips and
 * sends each clip to the main process for transcription. Pure helpers are
 * exported for unit testing; the recorder class only runs in Chromium.
 */

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
 * Records fixed-length audio clips from a MediaStream and emits each clip
 * as { base64, mimeType } via onClip. No-ops cleanly outside Chromium.
 */
class AudioClipRecorder {
  constructor({ clipMs = 10000, mimeType = '', onClip = null } = {}) {
    this.clipMs = clipMs;
    this.mimeType = mimeType;
    this.onClip = typeof onClip === 'function' ? onClip : null;
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
        if (this.onClip) this.onClip({ base64, mimeType: recorder.mimeType || this.mimeType });
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

module.exports = {
  pickMimeType,
  blobToBase64,
  AudioClipRecorder
};
