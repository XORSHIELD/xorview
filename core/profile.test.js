'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const profile = require('./profile');

test('parseList splits, trims, and drops empty lines', () => {
  assert.deepEqual(profile.parseList('  Led billing\n\nCut latency 40%  \n'), [
    'Led billing',
    'Cut latency 40%'
  ]);
  assert.deepEqual(profile.parseList(''), []);
  assert.deepEqual(profile.parseList(null), []);
  assert.deepEqual(profile.parseList(undefined), []);
});

test('parseList caps item count and length deterministically', () => {
  const many = Array.from({ length: 40 }, (_, i) => `fact ${i}`).join('\n');
  const out = profile.parseList(many);
  assert.equal(out.length, profile.MAX_LIST_ITEMS);
  assert.equal(out[0], 'fact 0');
  const capped = profile.parseList(`x${'y'.repeat(500)}`);
  assert.equal(capped.length, 1);
  assert.equal(capped[0].length, profile.MAX_ITEM_CHARS);
  assert.match(capped[0], /…$/);
});

test('parseStories splits on blank lines with title and body', () => {
  const stories = profile.parseStories('Payments outage\nDetected the alert. Rolled back.\n\nLaunch\nShipped v2.');
  assert.equal(stories.length, 2);
  assert.equal(stories[0].title, 'Payments outage');
  assert.match(stories[0].body, /Rolled back/);
  assert.equal(stories[1].title, 'Launch');
  assert.match(stories[1].body, /Shipped v2/);
});

test('parseStories caps story count and truncates long bodies', () => {
  const blocks = Array.from({ length: 15 }, (_, i) => `Title ${i}\nBody ${i}`).join('\n\n');
  const stories = profile.parseStories(blocks);
  assert.equal(stories.length, profile.MAX_STORIES);
  assert.equal(stories[0].title, 'Title 0');
  const big = profile.parseStories(`Big\n${'w'.repeat(2000)}`);
  assert.equal(big.length, 1);
  assert.equal(big[0].body.length, profile.MAX_STORY_BODY_CHARS);
});

test('parseStories ignores empty input', () => {
  assert.deepEqual(profile.parseStories(''), []);
  assert.deepEqual(profile.parseStories('   \n  '), []);
  assert.deepEqual(profile.parseStories(null), []);
});

test('isProfileActive needs the opt-in plus content', () => {
  assert.equal(profile.isProfileActive(null), false);
  assert.equal(profile.isProfileActive({}), false);
  assert.equal(profile.isProfileActive({ profileEnabled: true }), false);
  assert.equal(profile.isProfileActive({ profileEnabled: true, candidateName: '  ' }), false);
  assert.equal(profile.isProfileActive({ profileEnabled: false, candidateName: 'Ada' }), false);
  assert.equal(profile.isProfileActive({ profileEnabled: true, candidateName: 'Ada' }), true);
  assert.equal(profile.isProfileActive({ profileEnabled: true, jobDescription: 'Backend role' }), true);
});

test('buildProfileBlock returns empty when inactive', () => {
  assert.equal(profile.buildProfileBlock(null), '');
  assert.equal(profile.buildProfileBlock({}), '');
  assert.equal(profile.buildProfileBlock({ profileEnabled: false, candidateName: 'Ada' }), '');
  assert.equal(profile.buildProfileBlock({ profileEnabled: true }), '');
});

test('buildProfileBlock fuses every profile section', () => {
  const block = profile.buildProfileBlock({
    profileEnabled: true,
    candidateName: 'Ada',
    candidateHeadline: 'Backend engineer',
    resumeFacts: 'Led billing migration\nCut latency 40%',
    keySkills: 'Node.js, PostgreSQL',
    starStories: 'Outage\nDetected and rolled back.',
    jobDescription: 'Senior backend role\nOwn payments.'
  });
  assert.match(block, /Ada/);
  assert.match(block, /Backend engineer/);
  assert.match(block, /- Led billing migration/);
  assert.match(block, /Key skills: Node\.js, PostgreSQL/);
  assert.match(block, /Story — Outage/);
  assert.match(block, /Target role: Senior backend role Own payments\./);
});

test('buildProfileBlock omits empty sections', () => {
  const block = profile.buildProfileBlock({ profileEnabled: true, candidateName: 'Ada' });
  assert.match(block, /Candidate: Ada/);
  assert.doesNotMatch(block, /Résumé facts/);
  assert.doesNotMatch(block, /Key skills/);
  assert.doesNotMatch(block, /Story/);
  assert.doesNotMatch(block, /Target role/);
});

test('buildProfileBlock caps total length', () => {
  const big = {
    profileEnabled: true,
    resumeFacts: Array.from({ length: 30 }, () => 'f'.repeat(280)).join('\n')
  };
  const block = profile.buildProfileBlock(big);
  assert.ok(block.length <= profile.MAX_BLOCK_CHARS);
  const tiny = profile.buildProfileBlock(big, { maxChars: 100 });
  assert.ok(tiny.length <= 100);
  const fallback = profile.buildProfileBlock(big, { maxChars: -5 });
  assert.ok(fallback.length <= profile.MAX_BLOCK_CHARS);
});
