// The past-paper catalogue: reading file names, cover pages, requests and Cambridge's own pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as X from '../src/lib/exams.js';

const pick = (o) => o && [o.exam_board, o.exam_code, o.exam_year, o.exam_session, o.exam_kind, o.exam_paper, o.exam_level, o.exam_tz].join('|');

test('Cambridge file names', () => {
  assert.equal(pick(X.parseFilename('0607_s23_qp_41.pdf')), 'cie|0607|2023|s|qp|41||');
  assert.equal(pick(X.parseFilename('0580_w22_ms_42.pdf')), 'cie|0580|2022|w|ms|42||');
  assert.equal(pick(X.parseFilename('0607_m24_qp_42.pdf')), 'cie|0607|2024|m|qp|42||');
  assert.equal(pick(X.parseFilename('0610_y25_sp_2.pdf')), 'cie|0610|2025|spec|qp|2||');
  assert.equal(pick(X.parseFilename('0607_s23_er.pdf')), 'cie|0607|2023|s|er|||');
  assert.equal(pick(X.parseFilename('copy of 0620_w19_qp_31 (1).pdf')), 'cie|0620|2019|w|qp|31||');
  assert.equal(X.parseFilename('holiday photo 2023.pdf'), null);
  assert.equal(X.parseFilename('9999_s23_qp_41.pdf'), null, 'unknown syllabus codes are not guessed');
});

test('IB file names and folders', () => {
  assert.equal(pick(X.parseFilename('Physics_paper_2__TZ1_HL_markscheme.pdf', 'May 2019/Physics')), 'ib|physics|2019|may|ms|2|HL|TZ1');
  assert.equal(pick(X.parseFilename('Mathematics_analysis_and_approaches_paper_1__TZ2_SL.pdf', 'Nov 2022')), 'ib|math-aa|2022|nov|qp|1|SL|TZ2');
  assert.equal(pick(X.parseFilename('November_2025_Math_AA_SL_Paper_1_for_IB.pdf')), 'ib|math-aa|2025|nov|qp|1|SL|');
  assert.equal(pick(X.parseFilename('Mathematics_analysis_and_approaches_paper_1_TZ1_SL.pdf')), 'ib|math-aa|||qp|1|SL|TZ1', 'the cover page fills in the rest');
});

test('IB cover page, past the copyright page', () => {
  const boiler = (l) => `© International Baccalaureate Organization 2025 All rights reserved. ${l} use by tutoring or study services, vendors operating curriculum mapping services or teacher resource digital platforms is prohibited. More information: https://ibo.org/become-an-ib-school/ib-publishing/licensing/applying-for-a-license/.`;
  const text = `${boiler('a')} ${boiler('b')} ${boiler('c')} Mathematics: analysis and approaches Standard level Paper 1 10 November 2025 Zone A afternoon | Zone B afternoon 1 hour 30 minutes Instructions to candidates 8825 – 7109 © International Baccalaureate Organization 2025`;
  assert.equal(pick(X.parseCover(text)), 'ib|math-aa|2025|nov|qp|1|SL|', '“teacher resource” in the notice doesn’t make it an insert');
});

test('cover pages', () => {
  assert.equal(pick(X.parseCover('Cambridge IGCSE™ INTERNATIONAL MATHEMATICS 0607/41 Paper 4 (Extended) May/June 2023 2 hours 30 minutes')), 'cie|0607|2023|s|qp|41||');
  assert.equal(pick(X.parseCover('Cambridge IGCSE™ INTERNATIONAL MATHEMATICS 0607/41 Paper 4 (Extended) May/June 2023 MARK SCHEME Maximum Mark: 120')), 'cie|0607|2023|s|ms|41||');
  assert.equal(X.parseCover('Chapter 1 Numbers'), null);
});

test('requests typed by the tutor', () => {
  assert.equal(pick(X.parseRequest('0607 June 2023 Paper 4')), 'cie|0607|2023|s|qp|4||');
  assert.equal(pick(X.parseRequest('international mathematics november 2022 paper 2 mark scheme')), 'cie|0607|2022|w|ms|2||');
  assert.equal(pick(X.parseRequest('IB Physics HL paper 2 May 2023')), 'ib|physics|2023|may|qp|2|HL|');
  assert.equal(X.parseRequest('maths'), null);
  // "Paper 4" matches every variant of paper 4
  const req = X.parseRequest('0607 June 2023 Paper 4');
  assert.ok(X.matches(req, X.parseFilename('0607_s23_qp_42.pdf')));
  assert.ok(!X.matches(req, X.parseFilename('0607_s23_qp_21.pdf')));
  assert.ok(!X.matches(req, X.parseFilename('0607_w23_qp_41.pdf')));
});

test('Cambridge past-papers page', () => {
  const html = `<a href="/Images/569856-june-2024-question-paper-11.pdf"  target="_blank" class="file-link"><!--<span class="icon pdf"></span>-->June 2024 Question Paper 11 <span class="binary-details">(PDF, 1008KB)</span></a>
    <a href="/Images/569850-june-2024-mark-scheme-paper-11.pdf" class="file-link">June 2024 Mark Scheme Paper 11 <span>(PDF, 283KB)</span></a>
    <a href="/Images/569849-june-2024-examiner-report.pdf">June 2024 Examiner Report <span>(PDF, 2MB)</span></a>
    <a href="/Images/662645-2025-specimen-paper-4-mark-scheme.pdf">2025 Specimen Paper 4 Mark Scheme (PDF, 1MB)</a>
    <a href="/Images/569850-june-2024-mark-scheme-paper-11.pdf">June 2024 Mark Scheme Paper 11</a>
    <a href="https://elsewhere.example/x.pdf">June 2024 Question Paper 21</a>`;
  const items = X.parseOfficialPage('0607', html);
  assert.deepEqual(items.map(pick), ['cie|0607|2024|s|qp|11||', 'cie|0607|2024|s|ms|11||', 'cie|0607|2024|s|er|||', 'cie|0607|2025|spec|ms|4||']);
  assert.equal(items[0].url, 'https://www.cambridgeinternational.org/Images/569856-june-2024-question-paper-11.pdf');
  assert.equal(items[0].name, 'June 2024 Question Paper 11');
  assert.ok(items.every((x) => x.url.startsWith('https://www.cambridgeinternational.org/')), 'only Cambridge’s own files');
  assert.equal(X.officialPage('0607'), 'https://www.cambridgeinternational.org/programmes-and-qualifications/cambridge-igcse-international-mathematics-0607/past-papers/');
});

test('labels and slots', () => {
  const ms = X.parseFilename('0607_s23_ms_41.pdf');
  const qp = X.parseFilename('0607_s23_qp_41.pdf');
  assert.equal(X.slotLabel(ms), '0607 June 2023 Paper 41 · Mark scheme');
  assert.equal(X.slotKey(ms), X.slotKey(qp), 'question paper and mark scheme share a slot');
  assert.equal(X.component('41'), '4');
  assert.equal(X.variant('41'), '1');
  assert.deepEqual(X.variantsFor('m'), ['2']);
  assert.equal(new Set(X.CIE.map((s) => s.code)).size, X.CIE.length, 'no duplicate syllabus codes');
});
