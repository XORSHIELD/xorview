'use strict';

/**
 * core/suggest.js — suggestion fusion engine (v2, UMD).
 *
 * Fuses rolling transcript (+rolling summary) with screen context (image +
 * extracted text) and the confirmed candidate profile into chat prompts with
 * interview-type awareness, language matching, and short conversation
 * history. Also: interviewer-question detection, number-preserving line
 * parsing, labeled [you]/[general] card parsing, null-safe responses, MMR
 * dedup/ranking, and a debounce + in-flight suggestion gate.
 *
 * UMD: require() in Node/Electron-main, window.XorViewSuggest in renderer.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.XorViewSuggest = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT_EXCERPT_CHARS = 4000;
  const DEFAULT_MAX_HISTORY = 3;

  const QUESTION_WORDS = [
    'who', 'what', 'when', 'where', 'why', 'how', 'which', 'whose', 'whom',
    'can you', 'could you', 'would you', 'do you', 'did you', 'have you',
    'has you', 'are you', 'is there', 'tell me', 'describe', 'explain',
    'walk me through', 'give me an example'
  ];

  const INTERVIEW_TYPE_HINTS = Object.freeze({
    general: 'a general job interview',
    behavioral: 'a behavioral interview (STAR-format answers preferred)',
    technical: 'a technical interview (precise, correct, with brief reasoning)',
    sales: 'a sales interview (confident, concise, objection-aware)',
    support: 'a customer-support interview (empathetic, solution-oriented)'
  });

  /**
   * Detect whether a transcript segment bears an interviewer question or
   * another suggestion trigger. Returns { isQuestion, triggers, score }.
   */
  function detectQuestions(text) {
    const input = String(text || '');
    const lower = input.toLowerCase();
    const triggers = [];
    let score = 0;
    if (/\?\s*$/.test(input.trim()) || input.includes('?')) {
      triggers.push('question-mark');
      score += 2;
    }
    for (const word of QUESTION_WORDS) {
      if (lower.includes(word)) {
        triggers.push(`keyword:${word}`);
        score += word.includes(' ') ? 2 : 1;
        if (triggers.length > 6) break;
      }
    }
    // Objection / concern language is also suggestion-worthy.
    for (const cue of ['concern', 'worried', 'problem with', 'not sure', 'hesitat', 'objection']) {
      if (lower.includes(cue)) {
        triggers.push(`cue:${cue}`);
        score += 2;
        break;
      }
    }
    return { isQuestion: score >= 2, triggers, score };
  }

  /**
   * Rolling summary for transcript overflow: the dropped head is replaced
   * by a compact factual summary instead of being silently truncated.
   */
  function summarizeSegments(droppedSegments) {
    const segs = Array.isArray(droppedSegments) ? droppedSegments : [];
    if (segs.length === 0) return '';
    const keywords = [];
    for (const seg of segs.slice(0, 12)) {
      const words = String((seg && seg.text) || '').split(/\s+/).filter((w) => w.length > 5).slice(0, 3);
      keywords.push(...words);
      if (keywords.length >= 12) break;
    }
    const tail = segs.length > 1
      ? ` Last dropped line: "${String(segs[segs.length - 1].text || '').slice(0, 140)}".`
      : '';
    return `Earlier discussion (${segs.length} segment${segs.length === 1 ? '' : 's'} summarized): ` +
      `topics included ${keywords.length > 0 ? keywords.slice(0, 12).join(', ') : 'general discussion'}.${tail}`;
  }

  /**
   * Split transcript segments into a rolling summary (for the dropped head)
   * plus a bounded excerpt (latest-first filling up to maxChars).
   */
  function splitTranscript(segments, maxChars = DEFAULT_EXCERPT_CHARS) {
    const segs = Array.isArray(segments) ? segments : [];
    const lines = segs.map((seg) => `[${(seg && seg.t) || ''}] ${String((seg && seg.text) || '')}`);
    let excerpt = lines.join('\n');
    if (excerpt.length <= maxChars) {
      return { summary: '', excerpt };
    }
    // Drop whole leading lines until under budget; summarize the dropped head.
    let dropped = 0;
    while (dropped < lines.length - 1 && excerpt.length > maxChars) {
      dropped += 1;
      excerpt = lines.slice(dropped).join('\n');
    }
    return { summary: summarizeSegments(segs.slice(0, dropped)), excerpt };
  }

  function interviewHint(interviewType) {
    const key = String(interviewType || 'general').toLowerCase().trim();
    return INTERVIEW_TYPE_HINTS[key] || INTERVIEW_TYPE_HINTS.general;
  }

  /**
   * Build chat messages fusing transcript + summary + screen context.
   * When imageDataUrl is present it is attached as an image_url content
   * part so screen context actually informs the suggestion. When
   * profileBlock is present it is appended as confirmed candidate facts
   * with a grounding instruction plus per-card [you]/[general] labels.
   */
  function buildFusionPrompt({
    transcript = '',
    summary = '',
    contextNote = '',
    imageDataUrl = '',
    interviewType = 'general',
    language = '',
    history = [],
    profileBlock = ''
  } = {}) {
    const lang = String(language || '').trim();
    const profile = String(profileBlock || '').trim();
    const system =
      `You are an interview assistant helping a candidate in ${interviewHint(interviewType)}. ` +
      'Given a live transcript excerpt (latest last), an optional summary of earlier discussion, ' +
      'and on-screen context, suggest concise, correct answers the candidate can say next. ' +
      'Reply with 2-4 short suggestion cards, one per line, each under 280 characters. No preamble.' +
      (profile
        ? ' Ground answers in the confirmed candidate profile when relevant; never invent jobs, dates, or credentials outside it. Prefix each card with [you] when it draws on profile facts, otherwise [general].'
        : '') +
      (lang ? ` Match the candidate's language (${lang}) unless the interviewer switches languages.` : '');
    const contextBlock = contextNote && String(contextNote).trim() !== ''
      ? String(contextNote)
      : 'No screen captures yet.';
    const summaryBlock = summary ? `Summary of earlier discussion:\n${summary}\n\n` : '';
    const profileSection = profile ? `\n\nCandidate profile (confirmed facts):\n${profile}` : '';
    const textBlock =
      `${summaryBlock}Transcript (latest last):\n${transcript || '(empty)'}\n\n` +
      `On-screen context:\n${contextBlock}${profileSection}`;
    const userContent = imageDataUrl
      ? [
        { type: 'text', text: textBlock },
        { type: 'image_url', image_url: { url: imageDataUrl } }
      ]
      : textBlock;
    const messages = [{ role: 'system', content: system }];
    const valid = (Array.isArray(history) ? history : []).filter(
      (turn) =>
        turn &&
        typeof turn === 'object' &&
        (turn.role === 'user' || turn.role === 'assistant') &&
        typeof turn.content === 'string' &&
        turn.content.trim() !== ''
    );
    for (const turn of valid.slice(-DEFAULT_MAX_HISTORY)) {
      messages.push({ role: turn.role, content: turn.content.slice(0, 2000) });
    }
    messages.push({ role: 'user', content: userContent });
    return messages;
  }

  const BULLET_PREFIX = /^[\s\u2022\u2023\u25E6\u2043\-*+>]+/;
  const LABEL_PREFIX = /^\[(you|general)\]\s*/i;

  function stripBullets(line) {
    return String(line).replace(BULLET_PREFIX, '').trim();
  }

  /**
   * Parse suggestion text into cards. Strips bullet markers (-, *, bullets)
   * but PRESERVES leading numbers ("3 tips..." stays intact).
   */
  function parseSuggestionLines(text) {
    return String(text || '')
      .split('\n')
      .map((line) => stripBullets(line))
      .filter(Boolean);
  }

  /**
   * Parse suggestion text into labeled cards: [{ label, text }] where label
   * is 'you', 'general', or 'none'. Accepts the [you]/[general] prefix in
   * either order relative to bullet markers; the prefix is stripped from
   * the returned text. Unknown brackets are kept as plain text.
   */
  function parseLabeledCards(text) {
    const out = [];
    for (const rawLine of String(text || '').split('\n')) {
      let line = stripBullets(rawLine);
      let label = 'none';
      const match = LABEL_PREFIX.exec(line);
      if (match) {
        label = match[1].toLowerCase();
        line = stripBullets(line.slice(match[0].length));
      }
      if (!line) continue;
      out.push({ label, text: line });
    }
    return out;
  }

  /**
   * Null-safe normalization of a suggest/transcribe bridge response.
   * Returns { ok, text, code, message } — never throws on null input.
   */
  function safeResponse(res) {
    if (!res || typeof res !== 'object') {
      return { ok: false, text: '', code: 'unknown', message: 'Empty response from provider bridge.' };
    }
    if (res.ok) {
      return { ok: true, text: typeof res.text === 'string' ? res.text : '', code: '', message: '' };
    }
    const err = res.error && typeof res.error === 'object' ? res.error : {};
    return {
      ok: false,
      text: '',
      code: err.code || 'unknown',
      message: err.message || 'Unknown provider error.'
    };
  }

  function tokens(text) {
    return String(text || '').toLowerCase().split(/[^a-z0-9']+/).filter((t) => t.length > 2);
  }

  function jaccard(aTokens, bTokens) {
    if (aTokens.length === 0 || bTokens.length === 0) return 0;
    const a = new Set(aTokens);
    const b = new Set(bTokens);
    let inter = 0;
    for (const t of a) if (b.has(t)) inter += 1;
    return inter / (a.size + b.size - inter);
  }

  /**
   * Two-stage-lite rank: score candidates by query overlap, then MMR-select
   * topK balancing relevance (lambda) vs diversity. Deterministic.
   */
  function rankCandidates(candidates, { query = '', topK = 4, lambda = 0.7 } = {}) {
    const cands = Array.isArray(candidates) ? candidates.map((c) => String(c)).filter(Boolean) : [];
    if (cands.length === 0) return [];
    const qTokens = tokens(query);
    const scored = cands.map((text, index) => ({
      text,
      index,
      relevance: qTokens.length > 0 ? jaccard(tokens(text), qTokens) : 0.5
    }));
    const selected = [];
    const remaining = [...scored];
    const k = Math.max(1, Math.min(topK, scored.length));
    while (selected.length < k && remaining.length > 0) {
      let best = 0;
      let bestScore = -Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const cand = remaining[i];
        let maxSim = 0;
        for (const sel of selected) {
          maxSim = Math.max(maxSim, jaccard(tokens(cand.text), tokens(sel.text)));
        }
        const mmr = lambda * cand.relevance - (1 - lambda) * maxSim;
        if (mmr > bestScore) {
          bestScore = mmr;
          best = i;
        }
      }
      selected.push(remaining.splice(best, 1)[0]);
    }
    return selected.map((s) => s.text);
  }

  /** Remove near-duplicate candidates (Jaccard >= threshold keeps first). */
  function dedupeCandidates(candidates, threshold = 0.85) {
    const out = [];
    for (const cand of Array.isArray(candidates) ? candidates : []) {
      const text = String(cand);
      if (!text) continue;
      const dup = out.some((kept) => jaccard(tokens(kept), tokens(text)) >= threshold);
      if (!dup) out.push(text);
    }
    return out;
  }

  /**
   * Debounced, in-flight-guarded suggestion gate. `request` runs fn at most
   * once per minIntervalMs and never concurrently; overlapping calls while
   * busy resolve { ok:false, code:'busy' } instead of stacking requests.
   */
  class SuggestionGate {
    constructor({ minIntervalMs = 5000, clock = null } = {}) {
      this.minIntervalMs = minIntervalMs;
      this.clock = clock || { now: () => Date.now() };
      this.inFlight = false;
      this.lastAt = 0;
      this.lastTranscriptLength = 0;
    }

    /** True when auto mode may fire for the current transcript length. */
    shouldAutoFire(transcriptLength, hasQuestion) {
      if (!hasQuestion) return false;
      if (transcriptLength <= this.lastTranscriptLength) return false;
      return this.clock.now() - this.lastAt >= this.minIntervalMs;
    }

    markFired(transcriptLength) {
      this.lastAt = this.clock.now();
      this.lastTranscriptLength = transcriptLength;
    }

    async request(fn, transcriptLength = 0) {
      if (this.inFlight) return { ok: false, code: 'busy', message: 'A suggestion request is already running.' };
      this.inFlight = true;
      try {
        const result = await fn();
        this.markFired(transcriptLength);
        return result;
      } finally {
        this.inFlight = false;
      }
    }
  }

  return {
    DEFAULT_EXCERPT_CHARS,
    DEFAULT_MAX_HISTORY,
    detectQuestions,
    summarizeSegments,
    splitTranscript,
    interviewHint,
    buildFusionPrompt,
    parseSuggestionLines,
    parseLabeledCards,
    safeResponse,
    rankCandidates,
    dedupeCandidates,
    SuggestionGate
  };
});
