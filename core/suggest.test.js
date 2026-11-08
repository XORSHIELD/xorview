'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const suggest = require('./suggest');

test('detectQuestions finds interviewer questions', () => {
  assert.equal(suggest.detectQuestions('So tell me about yourself?').isQuestion, true);
  assert.equal(suggest.detectQuestions('How do you handle tight deadlines?').isQuestion, true);
  assert.equal(suggest.detectQuestions('Why did you leave your last role').isQuestion, true);
  assert.equal(suggest.detectQuestions('Walk me through your resume').isQuestion, true);
  assert.equal(suggest.detectQuestions('I have a concern about the commute').isQuestion, true);
});

test('detectQuestions stays quiet on plain statements', () => {
  assert.equal(suggest.detectQuestions('I worked there for five years.').isQuestion, false);
  assert.equal(suggest.detectQuestions('').isQuestion, false);
  assert.equal(suggest.detectQuestions('Yes.').isQuestion, false);
});

test('summarizeSegments compacts the dropped head', () => {
  assert.equal(suggest.summarizeSegments([]), '');
  const summary = suggest.summarizeSegments([
    { t: 't1', text: 'I led the kubernetes migration project' },
    { t: 't2', text: 'We improved deployment reliability a lot' }
  ]);
  assert.match(summary, /2 segments/);
  assert.match(summary, /kubernetes/);
});

test('splitTranscript bounds the excerpt and summarizes overflow', () => {
  const segments = Array.from({ length: 20 }, (_, i) => ({ t: `t${i}`, text: `segment number ${i} with filler words` }));
  const { summary, excerpt } = suggest.splitTranscript(segments, 200);
  assert.ok(excerpt.length <= 200);
  assert.match(excerpt, /segment number 19/);
  assert.match(summary, /summarized/);
  const small = suggest.splitTranscript([{ t: 't', text: 'hi' }], 4000);
  assert.equal(small.summary, '');
  assert.match(small.excerpt, /hi/);
});

test('buildFusionPrompt fuses transcript, summary, note, and image', () => {
  const messages = suggest.buildFusionPrompt({
    transcript: '[t] hello',
    summary: 'Earlier: intros',
    contextNote: 'Slide about roadmap',
    imageDataUrl: 'data:image/png;base64,xx',
    interviewType: 'technical',
    language: 'en',
    history: [{ role: 'assistant', content: 'prior answer' }]
  });
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /technical/);
  assert.match(messages[0].content, /en/);
  const user = messages[messages.length - 1];
  assert.equal(user.role, 'user');
  assert.ok(Array.isArray(user.content));
  assert.equal(user.content[1].type, 'image_url');
  assert.equal(user.content[1].image_url.url, 'data:image/png;base64,xx');
  assert.match(user.content[0].text, /hello/);
  assert.match(user.content[0].text, /Earlier: intros/);
  assert.match(user.content[0].text, /roadmap/);
});

test('buildFusionPrompt omits the image part without a screenshot', () => {
  const messages = suggest.buildFusionPrompt({ transcript: 'hi' });
  const user = messages[messages.length - 1];
  assert.equal(typeof user.content, 'string');
  assert.match(user.content, /No screen captures yet/);
});

test('buildFusionPrompt caps history and skips bad turns', () => {
  const history = [
    { role: 'user', content: 'q1' },
    null,
    { role: 'system', content: 'nope' },
    { role: 'assistant', content: 'a1' },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: 'a2' }
  ];
  const messages = suggest.buildFusionPrompt({ transcript: 't', history });
  const roles = messages.map((m) => m.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'assistant', 'user']);
});

test('parseSuggestionLines preserves leading numbers', () => {
  assert.deepEqual(suggest.parseSuggestionLines('3 tips for pricing\n- second idea\n* third'), [
    '3 tips for pricing',
    'second idea',
    'third'
  ]);
  assert.deepEqual(suggest.parseSuggestionLines('1. First\n2. Second'), ['1. First', '2. Second']);
  assert.deepEqual(suggest.parseSuggestionLines('  \n'), []);
});

test('safeResponse is null-safe', () => {
  assert.deepEqual(suggest.safeResponse(null), {
    ok: false,
    text: '',
    code: 'unknown',
    message: 'Empty response from provider bridge.'
  });
  assert.deepEqual(suggest.safeResponse(undefined).ok, false);
  assert.deepEqual(suggest.safeResponse({ ok: true, text: 'hi' }), { ok: true, text: 'hi', code: '', message: '' });
  const failed = suggest.safeResponse({ ok: false, error: { code: 'auth', message: 'bad key' } });
  assert.equal(failed.code, 'auth');
  assert.equal(suggest.safeResponse({ ok: false }).code, 'unknown');
});

test('rankCandidates prefers relevant, diverse suggestions', () => {
  const cands = [
    'Our pricing starts at ten dollars per seat',
    'Our pricing begins at ten dollars per seat',
    'We offer a free trial for two weeks'
  ];
  const ranked = suggest.rankCandidates(cands, { query: 'pricing per seat', topK: 2, lambda: 0.3 });
  assert.equal(ranked.length, 2);
  assert.match(ranked[0], /pricing/);
  // MMR diversity: the near-duplicate should lose to the distinct candidate.
  assert.match(ranked[1], /trial/);
});

test('dedupeCandidates drops near-duplicates', () => {
  const out = suggest.dedupeCandidates(['hello world today', 'hello world today', 'completely different phrase here']);
  assert.equal(out.length, 2);
});

test('SuggestionGate never overlaps requests', async () => {
  const gate = new suggest.SuggestionGate({ minIntervalMs: 0 });
  let running = 0;
  let maxRunning = 0;
  const fn = async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 20));
    running -= 1;
    return { ok: true };
  };
  const [first, second] = await Promise.all([gate.request(fn), gate.request(fn)]);
  assert.equal(first.ok, true);
  assert.equal(second.code, 'busy');
  assert.equal(maxRunning, 1);
});

test('SuggestionGate auto-fire needs new question-bearing transcript', () => {
  let now = 100000;
  const gate = new suggest.SuggestionGate({ minIntervalMs: 5000, clock: { now: () => now } });
  gate.markFired(5);
  assert.equal(gate.shouldAutoFire(5, true), false); // nothing new
  assert.equal(gate.shouldAutoFire(6, false), false); // no question
  assert.equal(gate.shouldAutoFire(6, true), false); // debounce
  now += 6000;
  assert.equal(gate.shouldAutoFire(6, true), true);
});

test('buildFusionPrompt grounds answers in the candidate profile', () => {
  const messages = suggest.buildFusionPrompt({
    transcript: 'hello',
    profileBlock: 'Candidate: Ada\nKey skills: Node.js'
  });
  assert.match(messages[0].content, /never invent/);
  assert.match(messages[0].content, /\[you\]/);
  const user = messages[messages.length - 1];
  assert.match(user.content, /Candidate profile \(confirmed facts\)/);
  assert.match(user.content, /Candidate: Ada/);
});

test('buildFusionPrompt omits grounding without a profile', () => {
  const messages = suggest.buildFusionPrompt({ transcript: 'hi' });
  assert.doesNotMatch(messages[0].content, /\[you\]/);
  assert.doesNotMatch(messages[messages.length - 1].content, /Candidate profile/);
  const blank = suggest.buildFusionPrompt({ transcript: 'hi', profileBlock: '   ' });
  assert.doesNotMatch(blank[0].content, /never invent/);
});

test('parseLabeledCards extracts you/general labels', () => {
  assert.deepEqual(suggest.parseLabeledCards('[you] Mention billing work'), [
    { label: 'you', text: 'Mention billing work' }
  ]);
  assert.deepEqual(suggest.parseLabeledCards('[GENERAL] Generic tip'), [
    { label: 'general', text: 'Generic tip' }
  ]);
  assert.deepEqual(suggest.parseLabeledCards('Plain line'), [
    { label: 'none', text: 'Plain line' }
  ]);
});

test('parseLabeledCards tolerates bullets in either order', () => {
  assert.deepEqual(suggest.parseLabeledCards('- [you] First'), [
    { label: 'you', text: 'First' }
  ]);
  assert.deepEqual(suggest.parseLabeledCards('[general] - Second'), [
    { label: 'general', text: 'Second' }
  ]);
  assert.deepEqual(suggest.parseLabeledCards('[you] 3 tips for pricing'), [
    { label: 'you', text: '3 tips for pricing' }
  ]);
});

test('parseLabeledCards drops empties and keeps unknown brackets', () => {
  assert.deepEqual(suggest.parseLabeledCards('  \n[you]\n'), []);
  assert.deepEqual(suggest.parseLabeledCards('[other] Keep me'), [
    { label: 'none', text: '[other] Keep me' }
  ]);
  assert.deepEqual(suggest.parseLabeledCards(''), []);
  assert.deepEqual(suggest.parseLabeledCards(null), []);
});
