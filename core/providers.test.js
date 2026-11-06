'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const providers = require('./providers');

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

test('transcribeAudio throws missing-key without calling fetch', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(200, { text: 'hi' });
  };
  await assert.rejects(
    () =>
      providers.transcribeAudio({
        baseUrl: 'https://example.test/v1',
        apiKey: '',
        model: 'whisper-1',
        audioBuffer: Buffer.from([1, 2, 3]),
        fetchImpl
      }),
    (err) => err.code === 'missing-key'
  );
  assert.equal(calls, 0);
});

test('transcribeAudio posts to /audio/transcriptions and returns text', async () => {
  let seenUrl = '';
  const fetchImpl = async (url) => {
    seenUrl = url;
    return jsonResponse(200, { text: '  hello world  ' });
  };
  const result = await providers.transcribeAudio({
    baseUrl: 'https://example.test/v1/',
    apiKey: 'k',
    model: 'whisper-1',
    audioBuffer: Buffer.from([1, 2, 3]),
    fetchImpl
  });
  assert.equal(result.text, 'hello world');
  assert.equal(seenUrl, 'https://example.test/v1/audio/transcriptions');
});

test('transcribeAudio maps 401 to auth error without retry storm', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(401, { error: { message: 'bad key' } });
  };
  await assert.rejects(
    () =>
      providers.transcribeAudio({
        baseUrl: 'https://example.test/v1',
        apiKey: 'k',
        model: 'whisper-1',
        audioBuffer: Buffer.from([1]),
        fetchImpl
      }),
    (err) => err.code === 'auth' && /bad key/.test(err.message)
  );
  assert.equal(calls, 1);
});

test('chatCompletion returns first choice content', async () => {
  const fetchImpl = async () => jsonResponse(200, { choices: [{ message: { content: '  answer  ' } }] });
  const result = await providers.chatCompletion({
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl
  });
  assert.equal(result.text, 'answer');
});

test('chatCompletion retries a 500 then succeeds', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse(500, {});
    return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
  };
  const result = await providers.chatCompletion({
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    model: 'm',
    messages: [],
    fetchImpl
  });
  assert.equal(result.text, 'ok');
  assert.equal(calls, 2);
});

test('chatCompletion maps aborts to timeout errors', async () => {
  const abortErr = new Error('aborted');
  abortErr.name = 'AbortError';
  const fetchImpl = async () => {
    throw abortErr;
  };
  await assert.rejects(
    () =>
      providers.chatCompletion({
        baseUrl: 'https://example.test/v1',
        apiKey: 'k',
        model: 'm',
        messages: [],
        fetchImpl,
        timeoutMs: 5
      }),
    (err) => err.code === 'timeout'
  );
});

test('testConnection checks /models with auth header', async () => {
  let seen = {};
  const fetchImpl = async (url, options) => {
    seen = { url, options };
    return jsonResponse(200, { data: [] });
  };
  const result = await providers.testConnection({
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    fetchImpl
  });
  assert.equal(result.ok, true);
  assert.equal(seen.url, 'https://example.test/v1/models');
  assert.equal(seen.options.headers.Authorization, 'Bearer k');
});
