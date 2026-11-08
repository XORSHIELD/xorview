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
    fetchImpl,
    retryOptions: { sleep: async () => {}, random: () => 0 }
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
        timeoutMs: 5,
        retryOptions: { maxRetries: 0 }
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

test('filenameForMime matches the container for format detection', () => {
  assert.equal(providers.filenameForMime('audio/webm'), 'clip.webm');
  assert.equal(providers.filenameForMime('audio/webm;codecs=opus'), 'clip.webm');
  assert.equal(providers.filenameForMime('audio/mp4'), 'clip.mp4');
  assert.equal(providers.filenameForMime('audio/wav'), 'clip.wav');
  assert.equal(providers.filenameForMime('audio/mpeg'), 'clip.mp3');
  assert.equal(providers.filenameForMime('audio/ogg'), 'clip.ogg');
  assert.equal(providers.filenameForMime(''), 'clip.webm');
  assert.equal(providers.filenameForMime(undefined), 'clip.webm');
});

test('transcribeAudio sends the mime-matched filename', async () => {
  let seenName = '';
  const realFormData = globalThis.FormData;
  class SpyFormData {
    constructor() {
      this.fields = {};
    }
    append(key, value, name) {
      this.fields[key] = { value, name };
      if (key === 'file') seenName = name;
    }
  }
  globalThis.FormData = SpyFormData;
  try {
    await providers.transcribeAudio({
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
      model: 'whisper-1',
      audioBuffer: Buffer.from([1, 2, 3]),
      mimeType: 'audio/mp4',
      fetchImpl: async () => jsonResponse(200, { text: 'x' })
    });
  } finally {
    globalThis.FormData = realFormData;
  }
  assert.equal(seenName, 'clip.mp4');
});

test('non-JSON 200 bodies surface as coded provider errors', async () => {
  const badJson = {
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('bad json');
    }
  };
  await assert.rejects(
    () =>
      providers.chatCompletion({
        baseUrl: 'https://example.test/v1',
        apiKey: 'k',
        model: 'm',
        messages: [],
        fetchImpl: async () => badJson
      }),
    (err) => err.code === 'provider' && /non-JSON/.test(err.message)
  );
  await assert.rejects(
    () =>
      providers.transcribeAudio({
        baseUrl: 'https://example.test/v1',
        apiKey: 'k',
        model: 'w',
        audioBuffer: Buffer.from([1]),
        fetchImpl: async () => badJson
      }),
    (err) => err.code === 'provider'
  );
});

test('assertSlot validates provider slots', () => {
  assert.equal(providers.assertSlot('transcribe'), 'transcribe');
  assert.equal(providers.assertSlot('chat'), 'chat');
  assert.throws(() => providers.assertSlot('other'), (err) => err.code === 'bad-request');
  assert.throws(() => providers.assertSlot(''), (err) => err.code === 'bad-request');
});

test('withRetry backs off exponentially with jitter (mocked clock)', async () => {
  const sleeps = [];
  let calls = 0;
  await assert.rejects(
    () =>
      providers.withRetry(
        async () => {
          calls += 1;
          const err = new Error('boom');
          err.code = 'timeout';
          throw err;
        },
        { maxRetries: 3, baseMs: 100, maxMs: 1000, sleep: async (ms) => void sleeps.push(ms), random: () => 0 }
      ),
    (err) => err.code === 'timeout'
  );
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [100, 200, 400]);
});

test('withRetry caps backoff at maxMs', () => {
  assert.equal(providers.backoffDelayMs(1, 100, 1000, () => 0), 100);
  assert.equal(providers.backoffDelayMs(10, 100, 1000, () => 0), 1000);
  const jittered = providers.backoffDelayMs(1, 100, 1000, () => 1);
  assert.ok(jittered > 100 && jittered <= 125);
});
