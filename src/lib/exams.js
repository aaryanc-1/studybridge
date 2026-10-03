// The exam catalogue: which boards and syllabuses exist, how past-paper files are named,
// and how to read the exam boards' own past-paper pages. No exam content lives here.

export const BOARDS = {
  cie: { name: 'Cambridge IGCSE', short: 'IGCSE' },
  ib: { name: 'IB Diploma', short: 'IB' },
};

// Cambridge IGCSE syllabuses (code | name | page on cambridgeinternational.org), October 2026
const CIE_RAW = `0452|Accounting|cambridge-igcse-accounting-0452
0985|Accounting (9-1)|cambridge-igcse-accounting-9-1-0985
0548|Afrikaans – Second Language|cambridge-igcse-afrikaans-second-language-0548
0600|Agriculture|cambridge-igcse-agriculture-0600
0508|Arabic – First Language|cambridge-igcse-arabic-first-language-0508
7184|Arabic – First Language (9-1)|cambridge-igcse-arabic-9-1-first-language-7184
0544|Arabic – Foreign Language|cambridge-igcse-arabic-foreign-language-0544
7180|Arabic (9-1)|cambridge-igcse-arabic-9-1-7180
0400|Art & Design|cambridge-igcse-art-and-design-0400
0989|Art & Design (9-1)|cambridge-igcse-art-and-design-9-1-0989
0538|Bahasa Indonesia|cambridge-igcse-bahasa-indonesia-0538
0610|Biology|cambridge-igcse-biology-0610
0970|Biology (9-1)|cambridge-igcse-biology-9-1-0970
0264|Business|cambridge-igcse-business-0264
0774|Business (9-1)|cambridge-igcse-business-9-1-0774
0450|Business Studies|cambridge-igcse-business-studies-0450
0986|Business Studies (9-1)|cambridge-igcse-business-studies-9-1-0986
0620|Chemistry|cambridge-igcse-chemistry-0620
0971|Chemistry (9-1)|cambridge-igcse-chemistry-9-1-0971
0509|Chinese – First Language|cambridge-igcse-chinese-first-language-0509
0523|Chinese – Second Language|cambridge-igcse-chinese-second-language-0523
0547|Chinese (Mandarin) – Foreign Language|cambridge-igcse-chinese-mandarin-foreign-language-0547
0715|Commerce|cambridge-igcse-commerce-0715
0478|Computer Science|cambridge-igcse-computer-science-0478
0265|Computer Science (new)|cambridge-igcse-computer-science-0265
0984|Computer Science (9-1)|cambridge-igcse-9-1-computer-science-0984
0445|Design & Technology|cambridge-igcse-design-and-technology-0445
0979|Design & Technology (9-1)|cambridge-igcse-design-and-technology-9-1-0979
0411|Drama|cambridge-igcse-drama-0411
0994|Drama (9-1)|cambridge-igcse-drama-9-1-0994
0455|Economics|cambridge-igcse-economics-0455
0987|Economics (9-1)|cambridge-igcse-economics-9-1-0987
0472|English (as an Additional Language)|cambridge-igcse-english-as-an-additional-language-0472
0772|English (as an Additional Language) (9-1)|cambridge-igcse-english-as-an-additional-language-9-1-0772
0465|English (Core) as a Second Language (Egypt)|cambridge-igcse-core-english-as-second-language-0465
0500|English – First Language|cambridge-igcse-english-first-language-0500
0990|English – First Language (9-1)|cambridge-igcse-9-1-first-language-english-0990
0524|English – First Language (US)|cambridge-igcse-english-first-language-us-0524
0475|English – Literature in English|english-literature-0475
0992|English – Literature in English (9-1)|cambridge-igcse-english-literature-0992
0511|English as a Second Language (Count-in speaking)|cambridge-igcse-english-second-language-count-in-oral-0511
0991|English as a Second Language (Count-in speaking) (9-1)|cambridge-igcse-english-second-language-9-1-count-in-speaking
0510|English as a Second Language (Speaking endorsement)|cambridge-igcse-english-second-language-oral-endorsement-0510
0993|English as a Second Language (Speaking endorsement) (9-1)|cambridge-igcse-english-second-language-speaking-endorsement-9-1-0993
0454|Enterprise|cambridge-igcse-enterprise-0454
0680|Environmental Management|cambridge-igcse-environmental-management-0680
0648|Food & Nutrition|cambridge-igcse-food-and-nutrition-0648
0501|French – First Language|cambridge-igcse-french-first-language-0501
0520|French – Foreign Language|cambridge-igcse-french-foreign-language-0520
7156|French (9-1)|cambridge-igcse-french-9-1-7156
0460|Geography|cambridge-igcse-geography-0460
0976|Geography (9-1)|cambridge-igcse-geography-9-1-0976
0505|German – First Language|cambridge-igcse-german-first-language-0505
0525|German – Foreign Language|cambridge-igcse-german-foreign-language-0525
7159|German (9-1)|cambridge-igcse-german-9-1-7159
0457|Global Perspectives|cambridge-igcse-global-perspectives-0457
0549|Hindi as a Second Language|cambridge-igcse-hindi-as-a-second-language-0549
0470|History|cambridge-igcse-history-0470
0977|History (9-1)|cambridge-igcse-history-9-1-0977
0409|History – American (US)|cambridge-igcse-history-american-us-0409
0417|Information and Communication Technology|cambridge-igcse-information-and-communication-technology-0417
0983|Information and Communication Technology (9-1)|cambridge-igcse-information-and-communication-technology-9-1-0983
0531|IsiZulu as a Second Language|cambridge-igcse-isizulu-as-a-second-language-0531
0493|Islamiyat|cambridge-igcse-islamiyat-0493
0535|Italian – Foreign Language|cambridge-igcse-italian-foreign-language-0535
7164|Italian (9-1)|cambridge-igcse-italian-9-1-7164
0716|Japanese – Foreign Language|cambridge-igcse-japanese-0716
0480|Latin|cambridge-igcse-latin-0480
0696|Malay – First Language|cambridge-igcse-malay-0696
0546|Malay – Foreign Language|cambridge-igcse-malay-foreign-language-0546
0697|Marine Science|cambridge-igcse-marine-science-0697
0580|Mathematics|cambridge-igcse-mathematics-0580
0980|Mathematics (9-1)|cambridge-igcse-mathematics-9-1-0980
0444|Mathematics (US)|cambridge-igcse-mathematics-us-0444
0606|Mathematics – Additional|cambridge-igcse-mathematics-additional-0606
0607|Mathematics – International|cambridge-igcse-international-mathematics-0607
0410|Music|cambridge-igcse-music-0410
0978|Music (9-1)|cambridge-igcse-music-9-1-0978
0448|Pakistan Studies|cambridge-igcse-pakistan-studies-0448
0413|Physical Education|cambridge-igcse-physical-education-0413
0995|Physical Education (9-1)|cambridge-igcse-physical-education-0995
0652|Physical Science|cambridge-igcse-physical-science-0652
0625|Physics|cambridge-igcse-physics-0625
0972|Physics (9-1)|cambridge-igcse-physics-9-1-0972
0504|Portuguese – First Language|cambridge-igcse-portuguese-first-language-0504
0266|Psychology|cambridge-igcse-psychology-0266
0490|Religious Studies|cambridge-igcse-religious-studies-0490
0499|Sanskrit|cambridge-igcse-sanskrit-0499
0653|Science – Combined|cambridge-igcse-science-combined-0653
0654|Sciences – Co-ordinated (Double)|cambridge-igcse-sciences-co-ordinated-double-0654
0973|Sciences – Co-ordinated (9-1)|cambridge-igcse-sciences-9-1-only-0973
0698|Setswana – First Language|cambridge-igcse-setswana-0698
0495|Sociology|cambridge-igcse-sociology-0495
0502|Spanish – First Language|cambridge-igcse-spanish-first-language-0502
0530|Spanish – Foreign Language|cambridge-igcse-spanish-foreign-language-0530
0474|Spanish – Literature in Spanish|cambridge-igcse-literature-in-spanish-0474
7160|Spanish (9-1)|cambridge-igcse-spanish-9-1-7160
0479|Statistics|cambridge-igcse-statistics-0479
0262|Swahili|cambridge-igcse-swahili-0262
0518|Thai – First Language|cambridge-igcse-thai-first-language-0518
0471|Travel & Tourism|cambridge-igcse-travel-and-tourism-0471
0513|Turkish – First Language|cambridge-igcse-turkish-first-language-0513
0539|Urdu as a Second Language|cambridge-igcse-urdu-as-a-second-language-0539
0695|Vietnamese – First Language|cambridge-igcse-vietnamese-0695
0408|World Literature|cambridge-igcse-world-literature-0408`;

// IB Diploma subjects. code is our own short id; levels are what the IB examines.
const IB_RAW = `math-aa|Mathematics: analysis and approaches|SL,HL|1,2,3
math-ai|Mathematics: applications and interpretation|SL,HL|1,2,3
physics|Physics|SL,HL|1,2
chemistry|Chemistry|SL,HL|1,2
biology|Biology|SL,HL|1,2
computer-science|Computer science|SL,HL|1,2
design-tech|Design technology|SL,HL|1,2,3
sehs|Sports, exercise and health science|SL,HL|1,2
ess|Environmental systems and societies|SL,HL|1,2,3
economics|Economics|SL,HL|1,2,3
business|Business management|SL,HL|1,2,3
geography|Geography|SL,HL|1,2,3
history|History|SL,HL|1,2,3
psychology|Psychology|SL,HL|1,2,3
global-politics|Global politics|SL,HL|1,2
digital-society|Digital society|SL,HL|1,2,3
philosophy|Philosophy|SL,HL|1,2,3
sca|Social and cultural anthropology|SL,HL|1,2
world-religions|World religions|SL|1,2
english-a-lit|English A: Literature|SL,HL|1,2
english-a-langlit|English A: Language and literature|SL,HL|1,2
english-b|English B|SL,HL|1,2
french-b|French B|SL,HL|1,2
spanish-b|Spanish B|SL,HL|1,2
german-b|German B|SL,HL|1,2
mandarin-b|Mandarin B|SL,HL|1,2
french-ab|French ab initio|SL|1,2
spanish-ab|Spanish ab initio|SL|1,2
mandarin-ab|Mandarin ab initio|SL|1,2
visual-arts|Visual arts|SL,HL|
music|Music|SL,HL|
theatre|Theatre|SL,HL|
film|Film|SL,HL|`;

export const CIE = CIE_RAW.split('\n').map((l) => {
  const [code, name, slug] = l.split('|');
  return { board: 'cie', code, name, slug };
});
export const IB = IB_RAW.split('\n').map((l) => {
  const [code, name, levels, papers] = l.split('|');
  return { board: 'ib', code, name, levels: levels.split(','), papers: papers ? papers.split(',') : [] };
});
export const syllabuses = (board) => (board === 'ib' ? IB : CIE);
export const findSyllabus = (board, code) => syllabuses(board).find((s) => s.code === code) || null;
export const syllabusLabel = (board, code) => {
  const s = findSyllabus(board, code);
  if (!s) return code || '';
  return board === 'cie' ? `${s.name} (${s.code})` : s.name;
};

export const SESSIONS = {
  cie: [
    ['m', 'March'],
    ['s', 'June'],
    ['w', 'November'],
  ],
  ib: [
    ['may', 'May'],
    ['nov', 'November'],
  ],
};
export const sessionName = (board, s) => (s === 'spec' ? 'Specimen' : (SESSIONS[board] || []).find((x) => x[0] === s)?.[1] || s || '');

export const KINDS = {
  qp: 'Question paper',
  ms: 'Mark scheme',
  er: 'Examiner report',
  in: 'Insert',
  tr: 'Transcript',
  tn: 'Teacher’s notes',
  ci: 'Confidential instructions',
  pre: 'Pre-release material',
  gt: 'Grade thresholds',
  other: 'Other',
};
export const kindName = (k) => KINDS[k] || 'Other';

// "0607 June 2023 Paper 41 · Mark scheme"
export function slotLabel(x, { kind = true } = {}) {
  if (!x) return '';
  const parts = [];
  if (x.exam_board === 'ib') {
    parts.push(findSyllabus('ib', x.exam_code)?.name || x.exam_code);
    if (x.exam_level) parts.push(x.exam_level);
  } else parts.push(x.exam_code);
  if (x.exam_session === 'spec') parts.push(`Specimen${x.exam_year ? ' ' + x.exam_year : ''}`);
  else parts.push(`${sessionName(x.exam_board, x.exam_session)} ${x.exam_year || ''}`.trim());
  if (x.exam_paper) parts.push(`Paper ${x.exam_paper}`);
  if (x.exam_tz) parts.push(x.exam_tz);
  let s = parts.filter(Boolean).join(' ');
  if (kind && x.exam_kind && x.exam_kind !== 'qp') s += ` · ${kindName(x.exam_kind)}`;
  return s;
}

// The same paper (any kind) — question paper, mark scheme and examiner report share a slot
export const slotKey = (x) =>
  [x.exam_board, x.exam_code, x.exam_year || '', x.exam_session || '', x.exam_paper || '', x.exam_level || '', x.exam_tz || ''].join('|');

// ---------------------------------------------------------------------------
// Reading file names: Cambridge names its files 0607_s23_qp_41.pdf; IB files usually
// say the subject, paper, level, time zone and session in words.
// ---------------------------------------------------------------------------
const CIE_KIND = { qp: 'qp', ms: 'ms', er: 'er', in: 'in', gt: 'gt', ci: 'ci', tn: 'tn', pm: 'pre', pre: 'pre', sp: 'qp', sm: 'ms', ir: 'ci', qr: 'tr', tr: 'tr', sf: 'other', rp: 'other' };
const yy = (n) => (n.length === 2 ? 2000 + +n : +n);

export function parseFilename(name, path = '') {
  const base = String(name).replace(/\.[a-z0-9]+$/i, '');
  // 0607_s23_qp_41, 0580_w22_ms_42, 0607_m24_qp_42, 0610_y25_sp_2 (specimen), 0625_s23_gt, 0607_s23_er
  const m = base.match(/(?:^|[^0-9])(\d{4})[_\- ]([msw]|y)(\d{2})[_\- ]([a-z]{2,3})(?:[_\- ](\d{1,2}[a-z]?))?/i);
  if (m && findSyllabus('cie', m[1])) {
    const sess = m[2].toLowerCase();
    const k = m[4].toLowerCase();
    const kind = CIE_KIND[k] || 'other';
    return {
      exam_board: 'cie',
      exam_code: m[1],
      exam_year: yy(m[3]),
      exam_session: sess === 'y' || k === 'sp' || k === 'sm' ? 'spec' : sess,
      exam_kind: kind,
      exam_paper: kind === 'gt' || kind === 'er' ? null : (m[5] || '').toUpperCase() || null,
      exam_level: null,
      exam_tz: null,
    };
  }
  return parseIbWords(`${path} ${base}`.replace(/[_\-.]+/g, ' '));
}

function parseIbWords(t) {
  const s = ' ' + t.toLowerCase().replace(/\s+/g, ' ') + ' ';
  const subj = ibSubjectFrom(s);
  if (!subj) return null;
  const paper = (s.match(/\bpaper ?([123])\b/) || s.match(/\bp([123])\b/) || [])[1] || null;
  const level = /\bhl\b|higher level/.test(s) ? 'HL' : /\bsl\b|standard level/.test(s) ? 'SL' : null;
  const tz = (s.match(/\btz ?([012])\b/) || [])[1];
  const dated = s.match(/\b(may|nov(?:ember)?) (20[0-3]\d)\b/);
  const year = +((dated || [])[2] || (s.match(/\b(20[0-3]\d)\b/) || [])[1] || 0) || null;
  const session = /\bnov(ember)?\b/.test(s) ? 'nov' : /\bmay\b/.test(s) ? 'may' : /specimen/.test(s) ? 'spec' : null;
  const kind = /mark ?scheme|\bms\b|markscheme/.test(s) ? 'ms' : /subject report|examiner/.test(s) ? 'er' : /\binsert\b|resource booklet|source booklet|data booklet/.test(s) ? 'in' : 'qp';
  if (!paper && !year) return null;
  return {
    exam_board: 'ib',
    exam_code: subj.code,
    exam_year: year,
    exam_session: session,
    exam_kind: kind,
    exam_paper: paper,
    exam_level: level,
    exam_tz: tz ? 'TZ' + tz : null,
  };
}

const IB_WORDS = [
  ['math-aa', /analysis (and|&) approaches|math(ematic)?s? aa\b|\bmaa\b/],
  ['math-ai', /applications (and|&) interpretation|math(ematic)?s? ai\b|\bmai\b/],
  ['sehs', /sports,? exercise|\bsehs\b/],
  ['ess', /environmental systems|\bess\b/],
  ['design-tech', /design tech/],
  ['computer-science', /computer science/],
  ['business', /business/],
  ['global-politics', /global politics/],
  ['digital-society', /digital society/],
  ['sca', /anthropology/],
  ['world-religions', /world religions/],
  ['english-a-langlit', /english a:? lang(uage)? (and|&) lit/],
  ['english-a-lit', /english a:? lit/],
  ['english-b', /english b\b/],
  ['french-ab', /french ab initio/],
  ['spanish-ab', /spanish ab initio/],
  ['mandarin-ab', /mandarin ab initio/],
  ['french-b', /french b\b/],
  ['spanish-b', /spanish b\b/],
  ['german-b', /german b\b/],
  ['mandarin-b', /mandarin b\b/],
  ['physics', /physics/],
  ['chemistry', /chemistry/],
  ['biology', /biology/],
  ['economics', /economics/],
  ['geography', /geography/],
  ['history', /history/],
  ['psychology', /psychology/],
  ['philosophy', /philosophy/],
];
function ibSubjectFrom(s) {
  const hit = IB_WORDS.find(([, re]) => re.test(s));
  return hit ? findSyllabus('ib', hit[0]) : null;
}

// ---------------------------------------------------------------------------
// Reading a paper's first page (when the file name says nothing useful)
// ---------------------------------------------------------------------------
const MONTHS = { 'february/march': 'm', 'may/june': 's', 'october/november': 'w' };
export function parseCover(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const low = t.toLowerCase();
  // Cambridge: "INTERNATIONAL MATHEMATICS 0607/41 Paper 4 (Extended) May/June 2023" ... "MARK SCHEME"
  const code = t.match(/\b(\d{4})\/(\d{2})\b/);
  if (code && findSyllabus('cie', code[1])) {
    const sess = low.match(/(february\/march|may\/june|october\/november) (20\d\d)/);
    const spec = /specimen/.test(low);
    const kind = /mark scheme/.test(low) ? 'ms' : /\binsert\b/.test(low) ? 'in' : /confidential instructions/.test(low) ? 'ci' : /pre-release/.test(low) ? 'pre' : 'qp';
    return {
      exam_board: 'cie',
      exam_code: code[1],
      exam_year: sess ? +sess[2] : +((t.match(/\bfor examination from (20\d\d)\b/i) || [])[1] || 0) || null,
      exam_session: spec ? 'spec' : sess ? MONTHS[sess[1]] : null,
      exam_kind: kind,
      exam_paper: code[2],
      exam_level: null,
      exam_tz: null,
    };
  }
  if (/international baccalaureate|baccalauréat international|\bib\b/.test(low) || /markscheme/.test(low)) {
    // leave out the IB's copyright page (in three languages), which mentions other things
    return parseIbWords(t.replace(/©[\s\S]{0,1500}?applying-for-a-license\/?\.?/gi, ' '));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cambridge's own past-papers page for a syllabus, and what its links mean
// ---------------------------------------------------------------------------
export const CIE_SITE = 'https://www.cambridgeinternational.org';
export const officialPage = (code) => {
  const s = findSyllabus('cie', code);
  return s ? `${CIE_SITE}/programmes-and-qualifications/${s.slug}/past-papers/` : null;
};
export const IB_STORE = 'https://www.follettibstore.com/';

// "June 2024 Question Paper 41", "June 2024 Mark Scheme Paper 41", "2025 Specimen Paper 4 Mark Scheme", "June 2024 Examiner Report"
export function parseOfficialLink(code, label, href) {
  const t = String(label).replace(/\s+/g, ' ').replace(/\s*\(PDF.*$/i, '').trim();
  const l = t.toLowerCase();
  const year = +((t.match(/\b(20\d\d)\b/) || [])[1] || 0) || null;
  const session = /specimen|speciman/.test(l) ? 'spec' : /^june|may\/june/.test(l) ? 's' : /^november|october\/november/.test(l) ? 'w' : /^march|february\/march/.test(l) ? 'm' : null;
  let kind = 'qp';
  if (/mark ?scheme|markscheme/.test(l)) kind = 'ms';
  else if (/examiner report/.test(l)) kind = 'er';
  else if (/insert/.test(l)) kind = 'in';
  else if (/transcript/.test(l)) kind = 'tr';
  else if (/teacher'?s'? notes|teachers notes|instructions for teachers/.test(l)) kind = 'tn';
  else if (/confidential/.test(l)) kind = 'ci';
  else if (/pre-release/.test(l)) kind = 'pre';
  else if (/grade threshold/.test(l)) kind = 'gt';
  else if (/update notice|role play|candidate card|survey map|update/.test(l)) kind = 'other';
  let paper = (t.match(/Paper\s+(\d{1,2}[A-Z]?)\b/i) || t.match(/\s(\d{1,2}[A-Z]?)(?:\s+(?:Mark Scheme|Markscheme|Insert))?$/i) || [])[1] || null;
  if (paper && /^20\d\d$/.test(paper)) paper = null;
  if (kind === 'er' || kind === 'gt') paper = null;
  const url = /^https?:/i.test(href) ? href : CIE_SITE + (href.startsWith('/') ? '' : '/') + href;
  return { official: true, exam_board: 'cie', exam_code: code, exam_year: year, exam_session: session, exam_kind: kind, exam_paper: paper ? paper.toUpperCase() : null, exam_level: null, exam_tz: null, name: t, url };
}

// All PDF links on a syllabus's past-papers page
export function parseOfficialPage(code, html) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href="([^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1].replace(/&amp;/g, '&');
    if (seen.has(href)) continue;
    seen.add(href);
    const label = m[2].replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, '’').replace(/\s+/g, ' ').trim();
    if (!label) continue;
    // only Cambridge's own files
    if (/^https?:/i.test(href) && !/^https:\/\/(www\.)?cambridgeinternational\.org\//i.test(href)) continue;
    out.push(parseOfficialLink(code, label, href));
  }
  return out;
}

// ---------------------------------------------------------------------------
// "0607 June 2023 Paper 4", "0607_s23_qp_41", "IB Physics HL paper 2 May 2023"
// ---------------------------------------------------------------------------
export function parseRequest(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const byName = parseFilename(t);
  if (byName) return byName;
  const low = ' ' + t.toLowerCase() + ' ';
  const code = (t.match(/\b(\d{4})\b(?!\s*(?:-|–)?\s*\d)/) || [])[1];
  const cie = code && findSyllabus('cie', code) ? code : findCieByName(low);
  if (cie) {
    const year = +((low.match(/\b(20[0-3]\d)\b/) || [])[1] || 0) || null;
    const sess = /specimen/.test(low) ? 'spec' : /\b(june|may)\b|\bs\d\d\b/.test(low) ? 's' : /\b(nov(ember)?|oct(ober)?)\b|\bw\d\d\b/.test(low) ? 'w' : /\b(march|feb(ruary)?)\b|\bm\d\d\b/.test(low) ? 'm' : null;
    const paper = (low.match(/\b(?:paper|p) ?(\d{1,2})\b/) || [])[1] || null;
    const kind = /mark ?scheme|\bms\b/.test(low) ? 'ms' : /examiner report/.test(low) ? 'er' : 'qp';
    return { exam_board: 'cie', exam_code: cie, exam_year: year, exam_session: sess, exam_kind: kind, exam_paper: paper, exam_level: null, exam_tz: null };
  }
  return parseIbWords(t);
}
function findCieByName(low) {
  let best = null;
  let bestLen = 0;
  for (const s of CIE) {
    const parts = s.name.toLowerCase().split(' – ');
    // "Mathematics – International" is also said "International Mathematics"
    for (const n of [parts.join(' '), [...parts].reverse().join(' ')]) {
      if (low.includes(' ' + n + ' ') && n.length > bestLen) {
        best = s;
        bestLen = n.length;
      }
    }
  }
  return best?.code || null;
}

// Does a request match a file or link? (a request for "Paper 4" matches 41, 42 and 43)
export function matches(req, x) {
  if (!req || req.exam_board !== x.exam_board || req.exam_code !== x.exam_code) return false;
  if (req.exam_year && req.exam_year !== x.exam_year) return false;
  if (req.exam_session && req.exam_session !== x.exam_session) return false;
  if (req.exam_level && x.exam_level && req.exam_level !== x.exam_level) return false;
  if (req.exam_tz && x.exam_tz && req.exam_tz !== x.exam_tz) return false;
  if (req.exam_paper && x.exam_paper) {
    const a = String(req.exam_paper).toUpperCase();
    const b = String(x.exam_paper).toUpperCase();
    if (!(a === b || (a.length === 1 && b.startsWith(a)))) return false;
  }
  return true;
}

// Cambridge papers: "41" = paper 4, variant 1. Specimen papers have no variant.
export const component = (p) => (p ? (/^\d\d$/.test(String(p)) ? String(p)[0] : String(p)) : '');
export const variant = (p) => (/^\d\d$/.test(String(p || '')) ? String(p)[1] : '');
export const variantsFor = (session) => (session === 'm' ? ['2'] : ['1', '2', '3']);

// Open textbooks anyone may use and share (openly licensed)
export const OPEN_BOOKS = [
  { title: 'Prealgebra 2e', by: 'OpenStax', for: 'Maths', url: 'https://openstax.org/details/books/prealgebra-2e' },
  { title: 'Elementary Algebra 2e', by: 'OpenStax', for: 'Maths', url: 'https://openstax.org/details/books/elementary-algebra-2e' },
  { title: 'Intermediate Algebra 2e', by: 'OpenStax', for: 'Maths', url: 'https://openstax.org/details/books/intermediate-algebra-2e' },
  { title: 'Algebra and Trigonometry 2e', by: 'OpenStax', for: 'Maths', url: 'https://openstax.org/details/books/algebra-and-trigonometry-2e' },
  { title: 'Precalculus 2e', by: 'OpenStax', for: 'Maths', url: 'https://openstax.org/details/books/precalculus-2e' },
  { title: 'Calculus Volume 1', by: 'OpenStax', for: 'Maths', url: 'https://openstax.org/details/books/calculus-volume-1' },
  { title: 'Introductory Statistics 2e', by: 'OpenStax', for: 'Maths', url: 'https://openstax.org/details/books/introductory-statistics-2e' },
  { title: 'Physics (high school)', by: 'OpenStax', for: 'Physics', url: 'https://openstax.org/details/books/physics' },
  { title: 'Chemistry 2e', by: 'OpenStax', for: 'Chemistry', url: 'https://openstax.org/details/books/chemistry-2e' },
  { title: 'Biology 2e', by: 'OpenStax', for: 'Biology', url: 'https://openstax.org/details/books/biology-2e' },
  { title: 'Principles of Economics 3e', by: 'OpenStax', for: 'Economics', url: 'https://openstax.org/details/books/principles-economics-3e' },
  { title: 'Introduction to Business', by: 'OpenStax', for: 'Business', url: 'https://openstax.org/details/books/introduction-business' },
  { title: 'Psychology 2e', by: 'OpenStax', for: 'Psychology', url: 'https://openstax.org/details/books/psychology-2e' },
  { title: 'Introduction to Sociology 3e', by: 'OpenStax', for: 'Sociology', url: 'https://openstax.org/details/books/introduction-sociology-3e' },
  ...[10, 11, 12].map((g) => ({ title: `Mathematics Grade ${g}`, by: 'Siyavula', for: 'Maths', url: `https://www.siyavula.com/read/za/mathematics/grade-${g}` })),
  ...[10, 11, 12].map((g) => ({ title: `Physical Sciences Grade ${g}`, by: 'Siyavula', for: 'Physics and Chemistry', url: `https://www.siyavula.com/read/za/physical-sciences/grade-${g}` })),
  { title: 'Life Sciences Grade 10', by: 'Siyavula', for: 'Biology', url: 'https://www.siyavula.com/read/za/life-sciences/grade-10' },
];

// Syllabus topic areas, used to organise the question bank
export const TOPICS = {
  '0607': ['Number', 'Algebra', 'Functions', 'Coordinate geometry', 'Geometry', 'Mensuration', 'Trigonometry', 'Transformations and vectors', 'Probability', 'Statistics'],
  '0580': ['Number', 'Algebra and graphs', 'Coordinate geometry', 'Geometry', 'Mensuration', 'Trigonometry', 'Transformations and vectors', 'Probability', 'Statistics'],
  '0606': ['Functions', 'Quadratic functions', 'Factors of polynomials', 'Equations, inequalities and graphs', 'Simultaneous equations', 'Logarithmic and exponential functions', 'Straight-line graphs', 'Coordinate geometry of the circle', 'Circular measure', 'Trigonometry', 'Permutations and combinations', 'Series', 'Calculus'],
};
export const topicsFor = (code) => TOPICS[code] || [];

// "x = 4", "3 (± 0.1) cm", "B: 12", a model answer…
export function answerText(q) {
  const a = q.answer || q.key?.answer || {};
  const opts = Array.isArray(q.options) ? q.options : q.options?.items || [];
  if (q.type === 'mcq') {
    const picks = a.choices || (a.choice != null ? [a.choice] : []);
    return picks.map((i) => `${String.fromCharCode(65 + Number(i))}: ${opts[Number(i)] ?? '?'}`).join(', ');
  }
  if (q.type === 'numeric') return `${a.value ?? ''}${a.tolerance && Number(a.tolerance) ? ` (± ${a.tolerance})` : ''}${a.unit ? ' ' + a.unit : ''}`;
  if (q.type === 'steps') return a.final || '';
  if (q.type === 'short') return a.text || '';
  return '';
}
export const DIFFICULTY = { 1: 'Easy', 2: 'Medium', 3: 'Hard' };
