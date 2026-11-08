'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const cv = require('./cv');

const stubParser = (text, numpages = 2) => async () => ({ text, numpages });

function pdfBuffer(bodyText) {
  return Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.from(String(bodyText || ''), 'latin1')]);
}

/** Build a byte-valid single-page PDF (computed xref) for real-parser tests. */
function minimalPdf(textLines) {
  const safe = textLines.map((t) => String(t).replace(/[()\\]/g, ''));
  const content = safe.map((t, i) => `BT /F1 12 Tf 72 ${720 - i * 24} Td (${t}) Tj ET`).join('\n');
  const objects = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objects[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>';
  objects[4] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let n = 1; n <= 5; n++) {
    offsets[n] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(pdf, 'latin1');
  pdf += 'xref\n0 6\n0000000000 65535 f \n';
  for (let n = 1; n <= 5; n++) {
    pdf += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

test('isPdfBuffer detects the magic header only', () => {
  assert.equal(cv.isPdfBuffer(Buffer.from('%PDF-1.7 rest', 'latin1')), true);
  assert.equal(cv.isPdfBuffer(Buffer.from('not a pdf', 'latin1')), false);
  assert.equal(cv.isPdfBuffer(Buffer.from('%PDF', 'latin1')), false);
  assert.equal(cv.isPdfBuffer(null), false);
  assert.equal(cv.isPdfBuffer(undefined), false);
});

test('extractPdfText rejects non-PDF input', async () => {
  await assert.rejects(() => cv.extractPdfText(Buffer.from('hello', 'latin1')), /not a PDF/);
  await assert.rejects(() => cv.extractPdfText(Buffer.alloc(0)), /No file data/);
  await assert.rejects(() => cv.extractPdfText(null), /No file data/);
});

test('extractPdfText uses the injected parser and normalizes newlines', async () => {
  const { text, numpages } = await cv.extractPdfText(
    pdfBuffer('x'),
    { parser: stubParser('Ada\r\nBuilt billing\rSystems', 3) }
  );
  assert.equal(numpages, 3);
  assert.equal(text, 'Ada\nBuilt billing\nSystems');
});

test('extractPdfText maps parser failures and empty text to codes', async () => {
  await assert.rejects(
    () => cv.extractPdfText(pdfBuffer('x'), { parser: async () => { throw new Error('boom'); } }),
    /Could not read that PDF: boom/
  );
  try {
    await cv.extractPdfText(pdfBuffer('x'), { parser: stubParser('   \n  ') });
    assert.fail('expected an empty-text error');
  } catch (err) {
    assert.equal(err.code, 'empty');
    assert.match(err.message, /scanned/i);
  }
});

test('extractPdfText caps kept text', async () => {
  const { text } = await cv.extractPdfText(pdfBuffer('x'), { parser: stubParser(`y${'z'.repeat(60000)}`) });
  assert.equal(text.length, cv.MAX_TEXT_CHARS);
});

test('splitSections groups experience, skills, and the rest', () => {
  const { experience, skills, other } = cv.splitSections([
    'Ada Lovelace',
    'EXPERIENCE',
    'Led billing migration',
    'SKILLS',
    'Node.js, PostgreSQL',
    'EDUCATION',
    'BSc Computer Science'
  ]);
  assert.deepEqual(experience, ['Led billing migration']);
  assert.deepEqual(skills, ['Node.js, PostgreSQL']);
  assert.deepEqual(other, ['Ada Lovelace', 'BSc Computer Science']);
});

test('splitSections joins bullet continuations and strips markers', () => {
  const { experience } = cv.splitSections([
    'Work Experience',
    '• Led payments revamp',
    'resulting in 40% lower latency',
    '- Cut on-call pages by half'
  ]);
  assert.deepEqual(experience, [
    'Led payments revamp resulting in 40% lower latency',
    'Cut on-call pages by half'
  ]);
});

test('splitSkillItems splits separators and drops long junk', () => {
  assert.deepEqual(cv.splitSkillItems(['Node.js, PostgreSQL; Redis | Docker / K8s']), [
    'Node.js', 'PostgreSQL', 'Redis', 'Docker', 'K8s'
  ]);
  assert.deepEqual(cv.splitSkillItems(['• Python', 'x'.repeat(200)]), ['Python']);
  assert.deepEqual(cv.splitSkillItems([]), []);
});

test('guessName picks the name line and skips CV titles', () => {
  assert.equal(cv.guessName(['Ada Lovelace', 'Backend engineer']), 'Ada Lovelace');
  assert.equal(cv.guessName(['CURRICULUM VITAE', 'Grace Hopper', 'Systems engineer']), 'Grace Hopper');
  assert.equal(cv.guessName(['ada@example.com', '+1 555 0100', 'Engineer']), '');
  assert.equal(cv.guessName(['A very long opening line that is clearly not a name at all here']), '');
  assert.equal(cv.guessName([]), '');
});

test('buildProfileFill assembles textarea-ready fields', () => {
  const fill = cv.buildProfileFill([
    'Ada Lovelace',
    'EXPERIENCE',
    '• Led billing migration',
    '• Cut latency 40%',
    'SKILLS',
    'Node.js, PostgreSQL'
  ].join('\n'));
  assert.deepEqual(Object.keys(fill).sort(), ['candidateName', 'keySkills', 'resumeFacts']);
  assert.equal(fill.candidateName, 'Ada Lovelace');
  assert.equal(fill.resumeFacts, 'Led billing migration\nCut latency 40%');
  assert.equal(fill.keySkills, 'Node.js\nPostgreSQL');
});

test('buildProfileFill falls back to body lines without sections', () => {
  const fill = cv.buildProfileFill('Ada Lovelace\nBuilt billing systems\nShipped v2');
  assert.equal(fill.candidateName, 'Ada Lovelace');
  assert.equal(fill.resumeFacts, 'Built billing systems\nShipped v2');
  assert.equal(fill.keySkills, '');
});

test('parseCvUpload rejects bad names and bad payloads', async () => {
  assert.deepEqual(await cv.parseCvUpload(null), {
    ok: false, error: { code: 'bad-request', message: 'Choose a PDF file (.pdf).' }
  });
  assert.deepEqual((await cv.parseCvUpload({ fileName: 'cv.docx', dataBase64: 'eA==' })).error.code, 'bad-request');
  assert.deepEqual((await cv.parseCvUpload({ fileName: `${'n'.repeat(252)}.pdf`, dataBase64: 'eA==' })).error.code, 'bad-request');
  assert.deepEqual((await cv.parseCvUpload({ fileName: 'cv.pdf', dataBase64: '' })).error.code, 'bad-request');
  assert.deepEqual((await cv.parseCvUpload({ fileName: 'cv.pdf', dataBase64: '!!!' })).error.code, 'bad-request');
});

test('parseCvUpload enforces size caps', async () => {
  const tooManyChars = await cv.parseCvUpload({ fileName: 'cv.pdf', dataBase64: 'a'.repeat(cv.MAX_BASE64_CHARS + 1) });
  assert.equal(tooManyChars.error.code, 'too-large');
  const bigBinary = Buffer.alloc(cv.MAX_FILE_BYTES + 1).toString('base64');
  const tooManyBytes = await cv.parseCvUpload({ fileName: 'cv.pdf', dataBase64: bigBinary });
  assert.equal(tooManyBytes.error.code, 'too-large');
});

test('parseCvUpload succeeds end to end with a stub parser', async () => {
  const b64 = pdfBuffer('body').toString('base64');
  const res = await cv.parseCvUpload(
    { fileName: 'Ada-CV.pdf', dataBase64: b64 },
    { parser: stubParser('Ada Lovelace\nEXPERIENCE\nBuilt billing', 1) }
  );
  assert.equal(res.ok, true);
  assert.equal(res.fileName, 'Ada-CV.pdf');
  assert.equal(res.numpages, 1);
  assert.equal(res.fill.candidateName, 'Ada Lovelace');
  assert.equal(res.fill.resumeFacts, 'Built billing');
});

test('parseCvUpload surfaces empty-text PDFs with the empty code', async () => {
  const b64 = pdfBuffer('body').toString('base64');
  const res = await cv.parseCvUpload(
    { fileName: 'scan.pdf', dataBase64: b64 },
    { parser: stubParser('   ') }
  );
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'empty');
});

test('defaultParser extracts text from a real minimal PDF', async () => {
  const buffer = minimalPdf(['Ada Lovelace', 'Built billing systems']);
  const { text, numpages } = await cv.extractPdfText(buffer);
  assert.equal(numpages, 1);
  assert.match(text, /Ada Lovelace/);
  assert.match(text, /Built billing systems/);
});
