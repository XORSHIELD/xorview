'use strict';

/**
 * core/cv.js — CV upload parsing for profile auto-fill.
 *
 * Pure Node module (no Electron dependency) so it can be unit tested.
 * PDF text comes from the bundled pdf-parse dependency; tests inject a
 * stub parser, so no real CV ever lives in the repo. Uploaded bytes stay
 * in memory; only the extracted profile fields persist via settings.
 *
 * Auto-fill is deliberately conservative: name, experience lines, and
 * skills come from clear signals; headline and STAR stories are left for
 * the user because guessing them is worse than leaving them empty.
 */

const profile = require('./profile');

/** Max decoded upload size (CVs are small; guards the IPC payload). */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Max base64 chars accepted before decoding (checked first, like audio clips). */
const MAX_BASE64_CHARS = 12 * 1024 * 1024;
/** Max PDF pages rendered (CVs are 1-3 pages; caps hostile files). */
const MAX_PAGES = 10;
/** Max extracted text chars kept for section splitting. */
const MAX_TEXT_CHARS = 50000;

function cvError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

/** True when the buffer starts with the %PDF- magic header. */
function isPdfBuffer(buffer) {
  if (!buffer || buffer.length < 5) return false;
  return buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 &&
    buffer[3] === 0x46 && buffer[4] === 0x2d;
}

/**
 * Default PDF parser: the pdf-parse dependency, page-capped. The input is
 * copied into a plain Uint8Array because the bundled pdf.js mishandles
 * pooled Node Buffers (nonzero byteOffset) on modern Node.
 */
async function defaultParser(buffer, maxPages) {
  const parse = require('pdf-parse');
  return parse(new Uint8Array(buffer), { max: maxPages });
}

/**
 * Extract raw text from a PDF buffer. Returns { text, numpages }.
 * Throws coded errors: bad-request (not a PDF), parse-failed, empty
 * (no readable text — typical for scanned/image-only PDFs).
 */
async function extractPdfText(buffer, { parser, maxPages = MAX_PAGES } = {}) {
  if (!buffer || buffer.length === 0) {
    throw cvError('bad-request', 'No file data to parse.');
  }
  if (!isPdfBuffer(buffer)) {
    throw cvError('bad-request', 'That file is not a PDF (missing %PDF header).');
  }
  const run = parser || defaultParser;
  let result;
  try {
    result = await run(buffer, maxPages);
  } catch (err) {
    throw cvError('parse-failed', `Could not read that PDF: ${(err && err.message) || err}`);
  }
  const text = String((result && result.text) || '').replace(/\r\n?/g, '\n');
  if (text.trim() === '') {
    throw cvError('empty', 'No readable text found — scanned or image-only PDFs need OCR first.');
  }
  return { text: text.slice(0, MAX_TEXT_CHARS), numpages: (result && result.numpages) || 0 };
}

const EXPERIENCE_RE = /^(work\s+)?experience|employment(\s+history)?|work\s+history/i;
const SKILLS_RE = /^(technical\s+)?skills|technologies|core\s+competencies|tech\s+stack/i;
const KNOWN_SECTION_RE = /^(work\s+)?experience|employment|work\s+history|education|skills|technologies|projects|summary|certifications?|languages/i;

/** True for section headings: known names or short ALL-CAPS lines. */
function isHeading(line) {
  const s = String(line || '').trim();
  if (s.length < 3 || s.length > 60) return false;
  if (/[.!?]$/.test(s)) return false;
  if (KNOWN_SECTION_RE.test(s)) return true;
  const letters = s.replace(/[^a-z]/gi, '');
  return letters.length >= 3 && letters === letters.toUpperCase();
}

function sectionKind(heading) {
  const s = String(heading || '').trim();
  if (EXPERIENCE_RE.test(s)) return 'experience';
  if (SKILLS_RE.test(s)) return 'skills';
  return 'other';
}

const BULLET_START = /^[\s•·▪\-\*\u2013\u2014+>]/;

function stripBullet(line) {
  return String(line || '').replace(/^[\s•·▪\-\*\u2013\u2014+>]+/, '').trim();
}

/**
 * Split cleaned lines into experience lines, skill lines, and the rest,
 * following section headings. A plain line right after a bulleted line
 * joins it as a continuation. Headings themselves are dropped.
 */
function splitSections(lines) {
  const experience = [];
  const skills = [];
  const other = [];
  let current = other;
  let lastWasBullet = false;
  for (const raw of Array.isArray(lines) ? lines : []) {
    const line = String(raw || '').trim();
    if (!line) continue;
    if (isHeading(line)) {
      const kind = sectionKind(line);
      current = kind === 'experience' ? experience : kind === 'skills' ? skills : other;
      lastWasBullet = false;
      continue;
    }
    const bulleted = BULLET_START.test(raw);
    const clean = bulleted ? stripBullet(line) : line;
    if (!clean) continue;
    if (!bulleted && lastWasBullet && current.length > 0) {
      current[current.length - 1] += ` ${clean}`;
    } else {
      current.push(clean);
    }
    lastWasBullet = bulleted;
  }
  return { experience, skills, other };
}

/** Best-effort name guess: a short digit-free line among the first three. */
function guessName(lines) {
  const list = Array.isArray(lines) ? lines.slice(0, 3) : [];
  for (const raw of list) {
    const line = String(raw || '').trim();
    if (!line || line.length > 60 || /[0-9@|]/.test(line)) continue;
    if (/curriculum|vitae|^resume$/i.test(line)) continue;
    if (isHeading(line)) continue;
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length >= 2 && words.length <= 5) return line;
  }
  return '';
}

/** Split skill lines on commas, semicolons, pipes, slashes, and bullets. */
function splitSkillItems(lines) {
  const out = [];
  for (const raw of Array.isArray(lines) ? lines : []) {
    for (const piece of String(raw || '').split(/[,;•·|/]/)) {
      const item = stripBullet(piece);
      if (item && item.length <= 120) out.push(item);
    }
  }
  return out;
}

/**
 * Build textarea-ready profile fields from extracted CV text. Returns
 * { candidateName, resumeFacts, keySkills } (headline and stories stay
 * empty for the user). Caps reuse profile.js limits.
 */
function buildProfileFill(text) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const { experience, skills, other } = splitSections(lines);
  const name = guessName(lines);
  const factSource = (experience.length > 0 ? experience : other).filter((line) => line !== name);
  return {
    candidateName: name,
    resumeFacts: profile.parseList(factSource.join('\n')).join('\n'),
    keySkills: profile.parseList(splitSkillItems(skills).join('\n')).join('\n')
  };
}

/**
 * Parse one CV upload ({ fileName, dataBase64 }). Never throws: returns
 * { ok:true, fileName, numpages, fill } or { ok:false, error:{code,message} }
 * in the same shape as other IPC results.
 */
async function parseCvUpload(payload, { parser } = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const fileName = String(p.fileName || '').trim();
  if (!/\.pdf$/i.test(fileName)) {
    return fail('bad-request', 'Choose a PDF file (.pdf).');
  }
  if (fileName.length > 255) {
    return fail('bad-request', 'File name is too long (max 255 characters).');
  }
  const b64 = String(p.dataBase64 || '');
  if (b64 === '') {
    return fail('bad-request', 'No file data received.');
  }
  if (!/^[a-z0-9+/=\s]*$/i.test(b64)) {
    return fail('bad-request', 'File data is not valid base64.');
  }
  if (b64.length > MAX_BASE64_CHARS) {
    return fail('too-large', `CV is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  }
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length === 0) {
    return fail('bad-request', 'No file data received.');
  }
  if (buffer.length > MAX_FILE_BYTES) {
    return fail('too-large', `CV is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  }
  try {
    const { text, numpages } = await extractPdfText(buffer, { parser });
    return { ok: true, fileName, numpages, fill: buildProfileFill(text) };
  } catch (err) {
    return fail((err && err.code) || 'parse-failed', (err && err.message) || 'Could not read that PDF.');
  }
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_BASE64_CHARS,
  MAX_PAGES,
  MAX_TEXT_CHARS,
  isPdfBuffer,
  defaultParser,
  extractPdfText,
  isHeading,
  sectionKind,
  splitSections,
  splitSkillItems,
  guessName,
  buildProfileFill,
  parseCvUpload
};
