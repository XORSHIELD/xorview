'use strict';

/**
 * core/providers.js — OpenAI-compatible transcription + chat clients.
 *
 * Runs in the main process. Uses injected fetch (default: global fetch)
 * with timeout + bounded retries. Errors are coded objects:
 *   missing-key | auth | bad-request | network | timeout | provider
 * Key material is never logged or included in error messages.
 */

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RETRIES = 2;

function providerError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function joinUrl(baseUrl, suffix) {
  return baseUrl.replace(/\/+$/, '') + suffix;
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

/**
 * Run fn with up to MAX_RETRIES retries on retryable failures
 * (network errors, timeouts, HTTP 429/5xx).
 */
async function withRetry(fn, maxRetries = MAX_RETRIES) {
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
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  if (!apiKey || apiKey.trim() === '') {
    throw providerError('missing-key', 'No transcription API key configured.');
  }
  if (!audioBuffer || audioBuffer.length === 0) {
    throw providerError('bad-request', 'No audio data to transcribe.');
  }
  const url = joinUrl(baseUrl, '/audio/transcriptions');
  const form = new FormData();
  const blob = new Blob([audioBuffer], { type: mimeType });
  form.append('file', blob, 'clip.webm');
  form.append('model', model);
  if (language && language.trim() !== '') form.append('language', language.trim());

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
    const body = await res.json();
    const text = body && typeof body.text === 'string' ? body.text.trim() : '';
    return { text };
  });
}

async function chatCompletion({
  baseUrl,
  apiKey,
  model,
  messages,
  maxTokens = 800,
  temperature = 0.3,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  if (!apiKey || apiKey.trim() === '') {
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
    const body = await res.json();
    const content =
      body && body.choices && body.choices[0] && body.choices[0].message
        ? String(body.choices[0].message.content || '').trim()
        : '';
    return { text: content };
  });
}

/**
 * Lightweight connectivity check: authenticated GET /models.
 * Never sends key material anywhere except the Authorization header.
 */
async function testConnection({ baseUrl, apiKey, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  if (!apiKey || apiKey.trim() === '') {
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
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_RETRIES,
  transcribeAudio,
  chatCompletion,
  testConnection
};
