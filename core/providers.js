'use strict';

/**
 * core/providers.js — OpenAI-compatible transcription + chat clients (v2).
 *
 * Runs in the main process. Uses injected fetch (default: global fetch)
 * with timeout + bounded retries with exponential backoff + jitter.
 * Errors are coded objects:
 *   missing-key | auth | bad-request | network | timeout | provider
 * Key material is never logged or included in error messages.
 */

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RETRIES = 2;
const DEFAULT_BACKOFF_BASE_MS = 250;
const DEFAULT_BACKOFF_MAX_MS = 4000;

/** Valid provider slots. */
const VALID_SLOTS = Object.freeze(['transcribe', 'chat']);

function isValidSlot(slot) {
  return slot === 'transcribe' || slot === 'chat';
}

function assertSlot(slot) {
  if (!isValidSlot(slot)) {
    throw providerError('bad-request', `Unknown provider slot: ${String(slot)}`);
  }
  return slot;
}

function providerError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function joinUrl(baseUrl, suffix) {
  return String(baseUrl).replace(/\/+$/, '') + suffix;
}

/**
 * Map a recorder mime type to the upload filename. Providers use the file
 * extension for format detection, so this must match the actual container.
 */
function filenameForMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
  if (mime === 'audio/mp4' || mime === 'audio/x-m4a' || mime === 'audio/aac') return 'clip.mp4';
  if (mime === 'audio/wav' || mime === 'audio/x-wav' || mime === 'audio/wave') return 'clip.wav';
  if (mime === 'audio/mpeg' || mime === 'audio/mp3') return 'clip.mp3';
  if (mime === 'audio/ogg' || mime === 'audio/opus') return 'clip.ogg';
  if (mime === 'audio/flac') return 'clip.flac';
  return 'clip.webm';
}

async function readErrorMessage(res) {
  try {
    const body = await res.json();
    if (body && body.error && typeof body.error.message === 'string') {
      return body.error.message;
    }
  } catch {
    // Fall through to generic message.
  }
  return `Request failed with HTTP ${res.status}`;
}

/** Parse a successful JSON body; non-JSON 200s become coded provider errors. */
async function readSuccessJson(res) {
  try {
    return await res.json();
  } catch {
    throw providerError('provider', `Unexpected non-JSON response (HTTP ${res.status}).`);
  }
}

function mapStatusToError(status, message) {
  if (status === 401 || status === 403) {
    return providerError('auth', `Authentication failed: ${message}`);
  }
  if (status === 400 || status === 404 || status === 422) {
    return providerError('bad-request', `Bad request (check endpoint/model): ${message}`);
  }
  return providerError('provider', message);
}

function isAbort(err) {
  return !!err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
}

function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (isAbort(err)) {
      throw providerError('timeout', `Request timed out after ${timeoutMs} ms`);
    }
    throw providerError('network', `Network error: ${(err && err.message) || err}`);
  } finally {
    clearTimeout(timer);
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with jitter for attempt N (1-based): base * 2^(N-1)
 * capped at maxMs, plus uniform jitter up to 25%.
 */
function backoffDelayMs(attempt, baseMs = DEFAULT_BACKOFF_BASE_MS, maxMs = DEFAULT_BACKOFF_MAX_MS, randomFn = Math.random) {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const rand = typeof randomFn === 'function' ? randomFn() : 0.5;
  return Math.round(exp * (1 + rand * 0.25));
}

/**
 * Run fn with bounded retries on retryable failures (network errors,
 * timeouts, HTTP 429/5xx), waiting with exponential backoff + jitter
 * between attempts.
 *
 * Second arg may be a retry count (legacy) or an options object:
 *   { maxRetries, baseMs, maxMs, sleep, random }
 * `sleep` and `random` are injectable for deterministic unit tests.
 */
async function withRetry(fn, maxRetriesOrOptions = MAX_RETRIES) {
  const opts = typeof maxRetriesOrOptions === 'object' && maxRetriesOrOptions !== null
    ? maxRetriesOrOptions
    : { maxRetries: maxRetriesOrOptions };
  const maxRetries = opts.maxRetries !== undefined ? opts.maxRetries : MAX_RETRIES;
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : defaultSleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const retryable =
        err.code === 'network' || err.code === 'timeout' || err.code === 'retryable-status';
      if (!retryable || attempt >= maxRetries) {
        if (err.code === 'retryable-status') {
          throw providerError('provider', err.message);
        }
        throw err;
      }
      attempt += 1;
      await sleep(backoffDelayMs(attempt, opts.baseMs, opts.maxMs, opts.random));
    }
  }
}

async function transcribeAudio({
  baseUrl,
  apiKey,
  model,
  audioBuffer,
  mimeType = 'audio/webm',
  language = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryOptions = undefined
}) {
  if (!apiKey || String(apiKey).trim() === '') {
    throw providerError('missing-key', 'No transcription API key configured.');
  }
  if (!audioBuffer || audioBuffer.length === 0) {
    throw providerError('bad-request', 'No audio data to transcribe.');
  }
  const url = joinUrl(baseUrl, '/audio/transcriptions');
  const form = new FormData();
  const blob = new Blob([audioBuffer], { type: mimeType });
  form.append('file', blob, filenameForMime(mimeType));
  form.append('model', model);
  if (language && String(language).trim() !== '') form.append('language', String(language).trim());

  return withRetry(async () => {
    const res = await fetchWithTimeout(
      fetchImpl,
      url,
      { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form },
      timeoutMs
    );
    if (!res.ok) {
      const message = await readErrorMessage(res);
      if (isRetryableStatus(res.status)) throw providerError('retryable-status', message);
      throw mapStatusToError(res.status, message);
    }
    const body = await readSuccessJson(res);
    const text = body && typeof body.text === 'string' ? body.text.trim() : '';
    return { text };
  }, retryOptions !== undefined ? retryOptions : MAX_RETRIES);
}

async function chatCompletion({
  baseUrl,
  apiKey,
  model,
  messages,
  maxTokens = 800,
  temperature = 0.3,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryOptions = undefined
}) {
  if (!apiKey || String(apiKey).trim() === '') {
    throw providerError('missing-key', 'No chat API key configured.');
  }
  const url = joinUrl(baseUrl, '/chat/completions');
  const payload = { model, messages, max_tokens: maxTokens, temperature };

  return withRetry(async () => {
    const res = await fetchWithTimeout(
      fetchImpl,
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload)
      },
      timeoutMs
    );
    if (!res.ok) {
      const message = await readErrorMessage(res);
      if (isRetryableStatus(res.status)) throw providerError('retryable-status', message);
      throw mapStatusToError(res.status, message);
    }
    const body = await readSuccessJson(res);
    const content =
      body && body.choices && body.choices[0] && body.choices[0].message
        ? String(body.choices[0].message.content || '').trim()
        : '';
    return { text: content };
  }, retryOptions !== undefined ? retryOptions : MAX_RETRIES);
}

/**
 * Lightweight connectivity check: authenticated GET /models.
 * Never sends key material anywhere except the Authorization header.
 */
async function testConnection({ baseUrl, apiKey, fetchImpl = globalThis.fetch, timeoutMs = 15000, retryOptions = undefined }) {
  if (!apiKey || String(apiKey).trim() === '') {
    throw providerError('missing-key', 'No API key configured.');
  }
  const url = joinUrl(baseUrl, '/models');
  return withRetry(async () => {
    const res = await fetchWithTimeout(
      fetchImpl,
      url,
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
      timeoutMs
    );
    if (!res.ok) {
      const message = await readErrorMessage(res);
      if (isRetryableStatus(res.status)) throw providerError('retryable-status', message);
      throw mapStatusToError(res.status, message);
    }
    return { ok: true };
  }, retryOptions !== undefined ? retryOptions : MAX_RETRIES);
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_RETRIES,
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_MAX_MS,
  VALID_SLOTS,
  isValidSlot,
  assertSlot,
  filenameForMime,
  backoffDelayMs,
  withRetry,
  transcribeAudio,
  chatCompletion,
  testConnection
};
