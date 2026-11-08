'use strict';

/**
 * core/profile.js — candidate-profile grounding (UMD).
 *
 * Parses the profile fields stored in settings (plain strings: lists are one
 * item per line, stories are blank-line-separated blocks with the title on
 * the first line) and builds the "confirmed facts" block fused into
 * suggestion prompts. Pure functions, no Electron or fs dependency.
 *
 * UMD: require() in Node/Electron-main, window.XorViewProfile in renderer.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.XorViewProfile = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_LIST_ITEMS = 30;
  const MAX_ITEM_CHARS = 280;
  const MAX_STORIES = 10;
  const MAX_STORY_TITLE_CHARS = 120;
  const MAX_STORY_BODY_CHARS = 800;
  const MAX_JD_CHARS = 600;
  const MAX_BLOCK_CHARS = 3000;

  const PROFILE_TEXT_KEYS = Object.freeze([
    'candidateName',
    'candidateHeadline',
    'resumeFacts',
    'keySkills',
    'starStories',
    'jobDescription'
  ]);

  function truncate(text, max) {
    const s = String(text || '');
    if (s.length <= max) return s;
    return s.slice(0, Math.max(0, max - 1)) + '…';
  }

  function cleanLines(text) {
    return String(text || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /**
   * Parse a one-item-per-line list field. Returns at most MAX_LIST_ITEMS
   * trimmed items, each capped at MAX_ITEM_CHARS. Never throws.
   */
  function parseList(text) {
    return cleanLines(text)
      .slice(0, MAX_LIST_ITEMS)
      .map((item) => truncate(item, MAX_ITEM_CHARS));
  }

  /**
   * Parse STAR stories: blocks separated by blank lines; the first line is
   * the title, the rest is the body. Returns at most MAX_STORIES entries.
   * Never throws.
   */
  function parseStories(text) {
    return String(text || '')
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .filter(Boolean)
      .slice(0, MAX_STORIES)
      .map((block) => {
        const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
        return {
          title: truncate(lines[0] || '', MAX_STORY_TITLE_CHARS),
          body: truncate(lines.slice(1).join(' '), MAX_STORY_BODY_CHARS)
        };
      })
      .filter((story) => story.title !== '' || story.body !== '');
  }

  function hasContent(value) {
    return String(value || '').trim() !== '';
  }

  /**
   * True when grounding is enabled and at least one profile field has
   * content. Never throws.
   */
  function isProfileActive(s) {
    if (!s || typeof s !== 'object' || !s.profileEnabled) return false;
    return PROFILE_TEXT_KEYS.some((key) => hasContent(s[key]));
  }

  /**
   * Build the "confirmed facts" prompt block, or '' when inactive. Skills
   * accept comma-separated items on one line as well as one-per-line. The
   * whole block is capped at maxChars (default MAX_BLOCK_CHARS).
   */
  function buildProfileBlock(s, options) {
    if (!isProfileActive(s)) return '';
    const requested = options && Number.isFinite(options.maxChars) ? options.maxChars : MAX_BLOCK_CHARS;
    const maxChars = requested > 0 ? requested : MAX_BLOCK_CHARS;
    const parts = [];
    const name = String(s.candidateName || '').trim();
    const headline = String(s.candidateHeadline || '').trim();
    if (name !== '' || headline !== '') {
      parts.push(`Candidate: ${[name, headline].filter(Boolean).join(' — ')}`);
    }
    const facts = parseList(s.resumeFacts);
    if (facts.length > 0) {
      parts.push(`Résumé facts:\n${facts.map((fact) => `- ${fact}`).join('\n')}`);
    }
    const skills = parseList(s.keySkills)
      .flatMap((item) => item.split(',').map((piece) => piece.trim()).filter(Boolean))
      .slice(0, MAX_LIST_ITEMS);
    if (skills.length > 0) {
      parts.push(`Key skills: ${skills.join(', ')}`);
    }
    for (const story of parseStories(s.starStories)) {
      parts.push(`Story — ${story.title || 'Untitled'}: ${story.body || '(no details)'}`);
    }
    const jd = String(s.jobDescription || '').trim().replace(/\s+/g, ' ');
    if (jd !== '') {
      parts.push(`Target role: ${truncate(jd, MAX_JD_CHARS)}`);
    }
    return truncate(parts.join('\n'), maxChars);
  }

  return {
    MAX_LIST_ITEMS,
    MAX_ITEM_CHARS,
    MAX_STORIES,
    MAX_STORY_TITLE_CHARS,
    MAX_STORY_BODY_CHARS,
    MAX_JD_CHARS,
    MAX_BLOCK_CHARS,
    PROFILE_TEXT_KEYS,
    parseList,
    parseStories,
    isProfileActive,
    buildProfileBlock
  };
});
