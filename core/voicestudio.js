'use strict';

/**
 * core/voicestudio.js — adapter for a user-run VoiceStudio backend.
 *
 * Original XorView code. Talks to VoiceStudio over HTTP only, using its
 * OpenAI-compatible `/v1` endpoints; no VoiceStudio code, models, or
 * assets are copied into this repo (default base `http://localhost:3900`).
 *
 * Pure Node module with injectable fetch so it can be unit tested without
 * a backend. Errors are coded like core/providers.js:
 *   bad-request | auth | network | timeout | provider
 * Key material is never logged or included in error messages.
 */

const DEFAULT_BASE_URL = 'http://localhost:3900';
const API_PREFIX = '/v1';
const DEFAULT_MODEL = 'whisper-1';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 30000;

function voicestudioError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function stripTrailingSlashes(value) {
  return String(value || '').replace(/\/+$/, '');
}

/** `http://host:3900` -> `http://host:3900/v1` (empty input uses the default). */
function apiBaseUrl(baseUrl) {
  const base = stripTrailingSlashes(baseUrl || DEFAULT_BASE_URL);
  if (!base) throw voicestudioError('bad-request', 'VoiceStudio base URL is empty.');
  return base + API_PREFIX;
}

function healthUrl(baseUrl) {
  return stripTrailingSlashes(baseUrl || DEFAULT_BASE_URL) + '/health';
}

function voicesUrl(baseUrl) {
  return apiBaseUrl(baseUrl) + '/audio/voices';
}

function transcriptionsUrl(baseUrl) {
  return apiBaseUrl(baseUrl) + '/audio/transcriptions';
}

/** True for loopback hosts (local backends usually need no API key). */
function isLocalhostUrl(urlString) {
  try {
    const host = new URL(String(urlString)).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * True when settings route transcription through the local VoiceStudio
 * backend instead of the hosted OpenAI-compatible endpoint.
 */
function isVoiceStudioTranscribe(settings) {
  return !!settings && settings.transcribeProvider === 'voicestudio';
}

/** Auth header, omitted entirely when no key is configured (local backend). */
function authHeaders(apiKey) {
  if (!apiKey || String(apiKey).trim() === '') return {};
  return { Authorization: `Bearer ${apiKey}` };
}

/** Upload filename per container; providers use the extension for detection. */
function filenameForMime(mimeType) {
  try {
    const providers = require('./providers');
    if (providers && typeof providers.filenameForMime === 'function') {
      return providers.filenameForMime(mimeType);
    }
  } catch {
    // Fall through to the local map.
  }
  const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
  if (mime === 'audio/mp4' || mime === 'audio/x-m4a' || mime === 'audio/aac') return 'clip.mp4';
  if (mime === 'audio/wav' || mime === 'audio/x-wav' || mime === 'audio/wave') return 'clip.wav';
  if (mime === 'audio/mpeg' || mime === 'audio/mp3') return 'clip.mp3';
  if (mime === 'audio/ogg' || mime === 'audio/opus') return 'clip.ogg';
  if (mime === 'audio/flac') return 'clip.flac';
  return 'clip.webm';
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const fn = fetchImpl || globalThis.fetch;
  if (typeof fn !== 'function') {
    throw voicestudioError('network', 'VoiceStudio unreachable: no fetch implementation available.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
      throw voicestudioError('timeout', `VoiceStudio request timed out after ${timeoutMs} ms`);
    }
    throw voicestudioError('network', `VoiceStudio unreachable: ${(err && err.message) || err}`);
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonSafe(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function readBodyText(res) {
  if (res && typeof res.text === 'function') {
    try {
      return String((await res.text()) || '');
    } catch {
      return '';
    }
  }
  const body = await readJsonSafe(res);
  if (typeof body === 'string') return body;
  if (body && typeof body.text === 'string') return body.text;
  return '';
}

function authOrProviderError(status, message) {
  if (status === 401 || status === 403) {
    return voicestudioError('auth', `VoiceStudio authentication failed: ${message}`);
  }
  return voicestudioError('provider', message);
}

/**
 * `GET {base}/health`. Resolves `{ ok, status, detail }`; throws coded
 * errors when the backend is down, refusing, or needs credentials.
 */
async function checkHealth({ baseUrl = DEFAULT_BASE_URL, apiKey = '', fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const res = await fetchWithTimeout(
    fetchImpl,
    healthUrl(baseUrl),
    { method: 'GET', headers: { ...authHeaders(apiKey) } },
    timeoutMs
  );
  if (!res.ok) {
    throw authOrProviderError(res.status, `VoiceStudio health check failed (HTTP ${res.status}).`);
  }
  const body = await readJsonSafe(res);
  return { ok: true, status: (body && (body.status || body.state)) || 'ok', detail: body };
}

/** Normalize the voices payload across schema versions. */
function normalizeVoices(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  if (body && Array.isArray(body.voices)) return body.voices;
  return [];
}

/** `GET {base}/v1/audio/voices`. Resolves `{ voices }` (possibly empty). */
async function listVoices({ baseUrl = DEFAULT_BASE_URL, apiKey = '', fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const res = await fetchWithTimeout(
    fetchImpl,
    voicesUrl(baseUrl),
    { method: 'GET', headers: { ...authHeaders(apiKey) } },
    timeoutMs
  );
  if (!res.ok) {
    throw authOrProviderError(res.status, `VoiceStudio voices request failed (HTTP ${res.status}).`);
  }
  return { voices: normalizeVoices(await readJsonSafe(res)) };
}

const TEXT_FORMATS = new Set(['text', 'srt', 'vtt']);

/**
 * Transcribe an audio clip via `POST {base}/v1/audio/transcriptions`.
 * No key is required for local backends; a configured key is sent as a
 * Bearer token for protected deployments. Resolves `{ text }`.
 */
async function transcribe({
  baseUrl = DEFAULT_BASE_URL,
  apiKey = '',
  model = DEFAULT_MODEL,
  audioBuffer,
  mimeType = 'audio/webm',
  language = '',
  responseFormat = 'json',
  fetchImpl,
  timeoutMs = DEFAULT_TRANSCRIBE_TIMEOUT_MS
} = {}) {
  if (!audioBuffer || audioBuffer.length === 0) {
    throw voicestudioError('bad-request', 'No audio data to transcribe.');
  }
  const form = new FormData();
  const blob = new Blob([audioBuffer], { type: mimeType });
  form.append('file', blob, filenameForMime(mimeType));
  form.append('model', model);
  if (language && String(language).trim() !== '') form.append('language', String(language).trim());
  if (responseFormat && String(responseFormat).trim() !== '') {
    form.append('response_format', String(responseFormat).trim());
  }
  const res = await fetchWithTimeout(
    fetchImpl,
    transcriptionsUrl(baseUrl),
    { method: 'POST', headers: { ...authHeaders(apiKey) }, body: form },
    timeoutMs
  );
  if (!res.ok) {
    const body = await readJsonSafe(res);
    const message = (body && body.error && typeof body.error.message === 'string')
      ? body.error.message
      : `Request failed with HTTP ${res.status}`;
    if (res.status === 400 || res.status === 404 || res.status === 422) {
      throw voicestudioError('bad-request', `VoiceStudio rejected the request: ${message}`);
    }
    throw authOrProviderError(res.status, message);
  }
  if (TEXT_FORMATS.has(String(responseFormat).toLowerCase())) {
    return { text: (await readBodyText(res)).trim() };
  }
  const body = await readJsonSafe(res);
  return { text: body && typeof body.text === 'string' ? body.text.trim() : '' };
}

module.exports = {
  DEFAULT_BASE_URL,
  API_PREFIX,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TRANSCRIBE_TIMEOUT_MS,
  apiBaseUrl,
  healthUrl,
  voicesUrl,
  transcriptionsUrl,
  isLocalhostUrl,
  isVoiceStudioTranscribe,
  authHeaders,
  filenameForMime,
  normalizeVoices,
  checkHealth,
  listVoices,
  transcribe
};
