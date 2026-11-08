'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const vs = require('./voicestudio');

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

test('URL builders join the base without double slashes', () => {
  assert.equal(vs.apiBaseUrl('http://localhost:3900'), 'http://localhost:3900/v1');
  assert.equal(vs.apiBaseUrl('http://localhost:3900/'), 'http://localhost:3900/v1');
  assert.equal(vs.healthUrl('http://localhost:3900/'), 'http://localhost:3900/health');
  assert.equal(vs.voicesUrl('http://localhost:3900'), 'http://localhost:3900/v1/audio/voices');
  assert.equal(vs.transcriptionsUrl('http://localhost:3900'), 'http://localhost:3900/v1/audio/transcriptions');
  assert.equal(vs.apiBaseUrl(''), 'http://localhost:3900/v1');
});

test('isLocalhostUrl detects loopback hosts only', () => {
  assert.equal(vs.isLocalhostUrl('http://localhost:3900'), true);
  assert.equal(vs.isLocalhostUrl('http://127.0.0.1:3900/v1'), true);
  assert.equal(vs.isLocalhostUrl('http://[::1]:3900'), true);
  assert.equal(vs.isLocalhostUrl('https://api.openai.com/v1'), false);
  assert.equal(vs.isLocalhostUrl('not a url'), false);
  assert.equal(vs.isLocalhostUrl(''), false);
});

test('authHeaders omits Authorization when no key is configured', () => {
  assert.deepEqual(vs.authHeaders(''), {});
  assert.deepEqual(vs.authHeaders('   '), {});
  assert.deepEqual(vs.authHeaders(undefined), {});
  assert.deepEqual(vs.authHeaders('k'), { Authorization: 'Bearer k' });
});

test('checkHealth resolves on 200 without sending auth for local backends', async () => {
  let seen = {};
  const fetchImpl = async (url, options) => {
    seen = { url, options };
    return jsonResponse(200, { status: 'ok' });
  };
  const result = await vs.checkHealth({ baseUrl: 'http://localhost:3900/', fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ok');
  assert.equal(seen.url, 'http://localhost:3900/health');
  assert.deepEqual(seen.options.headers, {});
});

test('checkHealth maps refused auth and failures to coded errors', async () => {
  await assert.rejects(
    () => vs.checkHealth({ fetchImpl: async () => jsonResponse(401, {}) }),
    (err) => err.code === 'auth'
  );
  await assert.rejects(
    () => vs.checkHealth({ fetchImpl: async () => jsonResponse(500, {}) }),
    (err) => err.code === 'provider'
  );
  await assert.rejects(
    () => vs.checkHealth({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }),
    (err) => err.code === 'network' && /unreachable/.test(err.message)
  );
});

test('listVoices normalizes schema variants', async () => {
  const fetchImpl = (body) => async () => jsonResponse(200, body);
  assert.deepEqual(
    (await vs.listVoices({ fetchImpl: fetchImpl({ data: [{ id: 'a' }] }) })).voices,
    [{ id: 'a' }]
  );
  assert.deepEqual(
    (await vs.listVoices({ fetchImpl: fetchImpl({ voices: [{ id: 'b' }] }) })).voices,
    [{ id: 'b' }]
  );
  assert.deepEqual((await vs.listVoices({ fetchImpl: fetchImpl([{ id: 'c' }]) })).voices, [{ id: 'c' }]);
  assert.deepEqual((await vs.listVoices({ fetchImpl: fetchImpl({}) })).voices, []);
});

test('transcribe posts multipart audio and returns trimmed text', async () => {
  let seenUrl = '';
  let seenHeaders = null;
  const realFormData = globalThis.FormData;
  const fields = {};
  class SpyFormData {
    append(key, value, name) {
      fields[key] = { value, name };
    }
  }
  globalThis.FormData = SpyFormData;
  try {
    const result = await vs.transcribe({
      baseUrl: 'http://localhost:3900/',
      model: 'whisper-1',
      audioBuffer: Buffer.from([1, 2, 3]),
      mimeType: 'audio/mp4',
      language: 'en',
      fetchImpl: async (url, options) => {
        seenUrl = url;
        seenHeaders = options.headers;
        return jsonResponse(200, { text: '  hello  ' });
      }
    });
    assert.equal(result.text, 'hello');
  } finally {
    globalThis.FormData = realFormData;
  }
  assert.equal(seenUrl, 'http://localhost:3900/v1/audio/transcriptions');
  assert.deepEqual(seenHeaders, {});
  assert.equal(fields.file.name, 'clip.mp4');
  assert.equal(fields.model.value, 'whisper-1');
  assert.equal(fields.language.value, 'en');
  assert.equal(fields.response_format.value, 'json');
});

test('transcribe sends the Bearer token for protected deployments', async () => {
  let seenHeaders = null;
  await vs.transcribe({
    baseUrl: 'http://voice.example.test:3900',
    apiKey: 'secret',
    audioBuffer: Buffer.from([1]),
    fetchImpl: async (_url, options) => {
      seenHeaders = options.headers;
      return jsonResponse(200, { text: 'x' });
    }
  });
  assert.deepEqual(seenHeaders, { Authorization: 'Bearer secret' });
});

test('transcribe rejects empty audio and maps error statuses', async () => {
  await assert.rejects(
    () => vs.transcribe({ audioBuffer: Buffer.alloc(0), fetchImpl: async () => jsonResponse(200, {}) }),
    (err) => err.code === 'bad-request'
  );
  await assert.rejects(
    () =>
      vs.transcribe({
        audioBuffer: Buffer.from([1]),
        fetchImpl: async () => jsonResponse(400, { error: { message: 'bad model' } })
      }),
    (err) => err.code === 'bad-request' && /bad model/.test(err.message)
  );
  await assert.rejects(
    () =>
      vs.transcribe({
        audioBuffer: Buffer.from([1]),
        fetchImpl: async () => jsonResponse(403, { error: { message: 'no' } })
      }),
    (err) => err.code === 'auth'
  );
});

test('transcribe reads plain-text formats via res.text', async () => {
  const result = await vs.transcribe({
    audioBuffer: Buffer.from([1]),
    responseFormat: 'text',
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '  raw transcript  ' })
  });
  assert.equal(result.text, 'raw transcript');
});

test('transcribe maps aborts to timeout errors', async () => {
  const abortErr = new Error('aborted');
  abortErr.name = 'AbortError';
  await assert.rejects(
    () =>
      vs.transcribe({
        audioBuffer: Buffer.from([1]),
        fetchImpl: async () => {
          throw abortErr;
        },
        timeoutMs: 5
      }),
    (err) => err.code === 'timeout'
  );
});

test('isVoiceStudioTranscribe reads the provider switch', () => {
  assert.equal(vs.isVoiceStudioTranscribe({ transcribeProvider: 'voicestudio' }), true);
  assert.equal(vs.isVoiceStudioTranscribe({ transcribeProvider: 'openai' }), false);
  assert.equal(vs.isVoiceStudioTranscribe({}), false);
  assert.equal(vs.isVoiceStudioTranscribe(null), false);
  assert.equal(vs.isVoiceStudioTranscribe(undefined), false);
});
