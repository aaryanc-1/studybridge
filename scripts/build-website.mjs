// Builds the website (website/ → an output folder) from website/site.config.json, so a rename or a price
// change is one edit. CI publishes it at the root of the releases repo's GitHub Pages, next to the phone app at app/.
//   node scripts/build-website.mjs <out dir> [version]
// With a version, release.json points the download buttons straight at that release's files.
// For search engines and shared links it also makes a page for every subject (website/partials/subject-page.html),
// sitemap.xml and robots.txt, and gives every page a canonical address and a link preview (website/share.png).
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const siteConfig = () => JSON.parse(readFileSync(join(root, 'website/site.config.json'), 'utf8'));

// A subject's key, the same as the app's catalogue (src/lib/catalogue.js): 'cambridge:igcse:0607', 'ib:sl-and-hl:physics'.
// The subjects page marks the ones students can start now (the open_subjects list from the server).
const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
export function catalogueKey(b, l, subject, code) {
  const c = b.id === 'ib' ? '' : code || '';
  return `${b.id}:${slug(l.name)}:${c ? slug(c) : slug(subject)}`;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Tutors pay per learner, in steps that get cheaper; site.js turns data-usd into the visitor's currency (and yearly)
const stepRange = (s, i, steps) => (s.upTo == null ? `after ${steps[i - 1].upTo}` : `${i ? steps[i - 1].upTo + 1 : 1}\u2013${s.upTo}`);
function levelCards(c) {
  return c.tutorLevels
    .map((l) => {
      const [first, ...rest] = l.steps;
      const then = rest.map((s, i) => `<span data-usd="${s.price}" data-scale>$${s.price}</span> each for learners ${stepRange(s, i + 1, l.steps)}`).join(', and ');
      return `<article class="plan${l.tag ? ' popular' : ''}" data-level="${esc(l.id)}">
          ${l.tag ? `<a class="tag" href="features.html#prof" title="What is Prof?">${esc(l.tag)}</a>` : ''}
          <h3>${esc(l.name)}</h3>
          <div class="blurb">${esc(l.blurb)}</div>
          <div><span class="amount" data-usd="${first.price}" data-scale>$${first.price}</span><span class="per" data-per>per learner a month</span></div>
          <div class="equiv steps-line">For learners 1\u2013${first.upTo}. Then ${then}.</div>
          <ul>${l.includes.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
          <a class="btn${l.tag ? ' primary' : ''}" href="${esc(c.appPath)}#start=tutor">Start your free trial</a>
        </article>`;
    })
    .join('\n        ');
}

// Small line icons for each kind of user (the who-it's-for cards and the pricing picker)
const icon = (d) => `<svg class="ic" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  student: icon('<path d="M3 9l9-4 9 4-9 4-9-4Z"/><path d="M7 11v4c0 1.5 2.5 3 5 3s5-1.5 5-3v-4"/><path d="M21 9v5"/>'),
  tutor: icon('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20l4-4 4 4"/><path d="M7 9h6M7 12h4"/>'),
  parent: icon('<circle cx="9" cy="8" r="3"/><circle cx="17" cy="10" r="2.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M14.5 20c.2-2.4 1.6-4 3.5-4s3 1.6 3 4"/>'),
  school: icon('<path d="M3 21h18"/><path d="M5 21V10l7-5 7 5v11"/><path d="M10 21v-5h4v5"/><path d="M12 10h.01"/>'),
};
// Every subject as a chip, for the rows that drift across the home page (each row twice, so it loops)
const levelShort = (b, l) => (b.id === 'ib' ? 'IB' : /A Level/.test(l.name) ? 'A Level' : 'IGCSE');
function marquee(c, half) {
  const all = c.boards.flatMap((b) => b.levels.flatMap((l) => l.subjects.map(([n]) => `<span>${esc(n)}<small>${levelShort(b, l)}</small></span>`)));
  const row = half ? all.filter((_, i) => i % 2) : all.filter((_, i) => !(i % 2));
  return row.join('') + row.join('');
}

const statusClass = (s) => ({ 'Available now': 'now', Free: 'free', 'Early access': 'early' })[s] || '';
const levelTitle = (b, l) => (b.id === 'ib' ? `IB Diploma ${l.name === 'Core' ? 'core' : `subjects, ${l.name}`}` : `${b.name} ${l.name}`);
export const subjectCount = (c) => c.boards.reduce((n, b) => n + b.levels.reduce((m, l) => m + l.subjects.length, 0), 0);

// ---------- A page for every subject (search engines and shared links land on them) ----------
// Each one is website/partials/subject-page.html filled in for that subject, published at the site root as
// subject-<its catalogue key>.html (subject-cambridge-igcse-0607.html), so the shared header and footer links work.
export const subjectFile = (b, l, n, code) => `subject-${catalogueKey(b, l, n, code).replace(/:/g, '-')}.html`;
export function subjectPages(c) {
  return c.boards.flatMap((b) => b.levels.flatMap((l) => l.subjects.map(([n, code]) => ({ b, l, n, code, key: catalogueKey(b, l, n, code), file: subjectFile(b, l, n, code) }))));
}
// Its full name: "Cambridge IGCSE International Mathematics (0607)", "Pearson Edexcel International GCSE Biology",
// "IB Diploma Physics (SL and HL)", "IB Diploma Theory of Knowledge"
const isCore = (b, l) => b.id === 'ib' && l.name === 'Core';
const namePrefix = (b, l) => (b.id === 'ib' ? 'IB Diploma' : `${b.name} ${l.name}`);
const nameSuffix = (b, l, code) => (b.id === 'ib' ? (isCore(b, l) ? '' : ' (SL and HL)') : code ? ` (${code})` : '');
export const subjectName = (b, l, n, code) => `${namePrefix(b, l)} ${n}${nameSuffix(b, l, code)}`;
// Who owns the exam, for "Not affiliated with or endorsed by …"
const boardOwner = (b) => (b.id === 'ib' ? 'the IB' : b.name);
// The address a page lives at: Cloudflare Pages sends /students.html to /students, so that's the one search engines get
const pageUrl = (c, f) => c.siteUrl + (f === 'index.html' ? '' : f.replace(/\.html$/, ''));

// A board's next exam sessions from today (the same rule as the countdown in site.js, which refreshes them on the page)
const DAY = 864e5;
function nextSessions(b, now = new Date(), n = 3) {
  const out = [];
  for (let y = now.getFullYear(); y <= now.getFullYear() + 2; y++) {
    for (const s of b.sessions) {
      const date = new Date(y, s.month - 1, s.day);
      if (date - now > DAY) out.push({ label: `${s.name} ${y}`, date });
    }
  }
  return out.sort((a, z) => a.date - z.date).slice(0, n);
}
const longDate = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

// Small line icons for what a student gets
const featIcon = (d) => `<span class="sp-ic" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg></span>`;
const FEAT_ICONS = {
  plan: featIcon('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M8 15l2.5 2.5L16 13"/>'),
  lessons: featIcon('<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5Z"/><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5Z"/>'),
  hints: featIcon('<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3Z"/>'),
  papers: featIcon('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'),
  mock: featIcon('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>'),
  progress: featIcon('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  yours: featIcon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
};

// What a student on their own gets, and the questions they ask. The IB core (TOK, the Extended Essay) has no exam
// papers or mocks, so its page talks about a plan to the deadlines, lessons and practice instead.
function subjectCopy(c, { b, l, n, code }) {
  const brand = esc(c.brand), short = esc(n), full = esc(subjectName(b, l, n, code));
  const tutorFaq = ['Do I need a tutor?', `No. Everything here is made for studying ${short} on your own, and your first ${c.trialDays} days are free. Already have a tutor on ${brand}? <a href="${esc(c.appPath)}#start=invite">Join with their code</a> instead.`];
  const parentFaq = ['Can my parents see how I’m doing?', 'Yes, if you’d like. Make a parent code in Settings and they get a free parent account with your plan, your study time and your practice. A parent can pay for your plan, too.'];
  if (isCore(b, l)) {
    return {
      whatSub: 'On your own, in the right order, from today to your deadlines.',
      ownWork: 'lessons and practice questions',
      lead: `Support for the IB Diploma ${short}, on your own and step by step: a plan to your deadlines, short lessons, practice with hints, and progress you can see.`,
      description: `Support for the ${full} on your own: a plan to your deadlines, short lessons, practice with hints and progress you can see. ${c.trialDays} days free.`,
      feats: [
        ['plan', 'A plan to your deadlines', 'Pick your exam session and the hours you have each week. Every part is spread over the weeks left, so nothing piles up at the end.'],
        ['lessons', 'Lessons, step by step', `Short lessons on what ${short} asks of you and how it’s assessed, one idea at a time, with worked examples.`],
        ['hints', 'Practice with hints', 'Questions to practise with, each with a hint and a worked answer, written ahead of time and checked.'],
        ['progress', 'Progress you can see', 'What you’ve covered and your study time each week. Your parents can follow along with a free account.'],
      ],
      faq: [tutorFaq, ['Will it write my essay?', `No. Students never use AI on ${brand}, and nothing here writes for you. Lessons, hints and worked answers are written ahead of time and checked, so the ideas and the writing stay yours.`], parentFaq],
    };
  }
  return {
    whatSub: 'On your own, in the right order, from today to exam day.',
    ownWork: 'lessons and practice papers',
    lead: `Study ${short} on your own, step by step: a plan to your exam, lessons topic by topic, practice with hints and worked solutions, original practice papers and timed mocks.`,
    description: `Study ${full} on your own: a plan to your exam, lessons, practice with hints and worked solutions, original practice papers and timed mocks. ${c.trialDays} days free.`,
    feats: [
      ['plan', 'A plan to your exam', 'Pick your exam session and the hours you have each week. Every topic is spread over the weeks left, with time for papers and a mock at the end. A quick starting check puts your weakest topics first.'],
      ['lessons', 'Lessons, topic by topic', `Short lessons that follow the ${short} syllabus in order, one idea at a time, each with a worked example.`],
      ['hints', 'A hint and a worked solution', 'Every practice question has a hint and a worked solution, written ahead of time and checked. Open them only when you need them.'],
      ['papers', 'Practice papers in the exam’s format', 'Original papers built like the real ones: the same sections, timing and marks. Mark them with the mark scheme and see where every mark comes from.'],
      ['mock', 'Timed mocks in exam conditions', 'Full screen, with a timer, like the real exam, so exam day feels familiar.'],
      ['progress', 'Progress by topic', 'See which topics are strong and which need more work, and your study time each week. Your parents can follow along with a free account.'],
    ],
    faq: [
      tutorFaq,
      ['Are the practice papers real past papers?', `No. They’re original papers written in the format of the real ${full} papers: the same sections, timing, marks and style, each with a mark scheme. Official past papers come from the exam board.`],
      ['Is there an AI tutor or chat?', `No. Students never chat with AI on ${brand}. Lessons, hints and worked solutions are written ahead of time and checked before you see them, so the thinking stays yours.`],
      parentFaq,
    ],
  };
}

// The tokens that fill website/partials/subject-page.html for one subject
function subjectTokens(c, s, all) {
  const { b, l, n, code, key, file } = s;
  const full = subjectName(b, l, n, code);
  const url = pageUrl(c, file);
  const copy = subjectCopy(c, s);
  const course = {
    '@type': 'Course',
    '@id': `${url}#course`,
    name: full,
    description: copy.description.replace(/&amp;/g, '&'),
    url,
    ...(code && b.id !== 'ib' ? { courseCode: code } : {}),
    educationalLevel: b.id === 'ib' ? 'IB Diploma' : l.name,
    inLanguage: 'en',
    provider: { '@type': 'Organization', name: c.brand, url: c.siteUrl },
    isAccessibleForFree: false,
    offers: [{ '@type': 'Offer', category: 'Subscription', price: c.selfLearner.month, priceCurrency: 'USD', url }],
    hasCourseInstance: [{ '@type': 'CourseInstance', courseMode: 'Online' }],
  };
  const crumbs = {
    '@type': 'BreadcrumbList',
    itemListElement: [
      ['Home', c.siteUrl],
      ['Subjects', pageUrl(c, 'subjects.html')],
      [full, url],
    ].map(([name, item], i) => ({ '@type': 'ListItem', position: i + 1, name, item })),
  };
  // the other subjects at the same level (all of the IB Diploma's together), so each page leads to the next
  const siblings = all.filter((x) => x !== s && x.b === b && (b.id === 'ib' || x.l === l));
  return {
    spName: esc(full),
    spShort: esc(n),
    spKey: esc(key),
    spH1: `${esc(namePrefix(b, l))} <em>${esc(n)}</em>${esc(nameSuffix(b, l, code))}`,
    spPill: [b.name, l.name, b.id === 'ib' ? '' : code].filter(Boolean).map(esc).join(' · '),
    spLead: copy.lead,
    spDescription: copy.description,
    spFeatures: copy.feats.map(([ic, h, p]) => `<article>${FEAT_ICONS[ic]}<h3>${h}</h3><p>${p}</p></article>`).join(''),
    spFeatClass: copy.feats.length === 4 ? ' two' : '',
    spWhatSub: copy.whatSub,
    spOwnWork: copy.ownWork,
    spFaq: copy.faq.map(([q, a]) => `<details class="reveal"><summary>${q}</summary><p>${a}</p></details>`).join('\n      '),
    spBoard: esc(b.name),
    spBoardId: esc(b.id),
    spOwner: esc(boardOwner(b)),
    spSessions: nextSessions(b).map((x) => `<li><b>${esc(x.label)}</b><span>Starts about ${longDate(x.date)}</span></li>`).join(''),
    spMoreTitle: esc(b.id === 'ib' ? 'More IB Diploma subjects' : `More ${b.name} ${l.name} subjects`),
    spSiblings: siblings.map((x) => `<li><a href="${x.file}">${esc(x.n)}</a></li>`).join(''),
    // JSON inside <script>: "<" written as < so nothing in it can close the tag
    spJsonLd: JSON.stringify({ '@context': 'https://schema.org', '@graph': [course, crumbs] }).replace(/</g, '\\u003c'),
  };
}

// Link previews (WhatsApp, social media) and search: every page gets its own title and description as the preview,
// its address without .html as the canonical one, and the share picture (website/share.png, from scripts/make-share.py)
function previews(html, c, f) {
  const title = /<title>([^<]+)<\/title>/.exec(html)?.[1];
  const description = /<meta name="description" content="([^"]+)">/.exec(html)?.[1];
  if (!title || !description) throw new Error(`website/${f}: needs a <title> and a <meta name="description">`);
  const url = pageUrl(c, f);
  const tags = [
    `<link rel="canonical" href="${url}">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:site_name" content="${esc(c.brand)}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:image" content="${c.siteUrl}share.png">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    `<meta property="og:image:alt" content="${esc(`${c.brand}: get exam-ready, step by step`)}">`,
    '<meta name="twitter:card" content="summary_large_image">',
  ];
  // a page's own preview tags would only repeat these
  const clean = html.replace(/<meta (?:property="og:|name="twitter:)[^>]*>\n?/g, '').replace(/<link rel="canonical"[^>]*>\n?/g, '');
  return clean.replace('</head>', `${tags.join('\n')}\n</head>`);
}

// The pages, in the order the menu shows them
export const PAGES = [
  ['students.html', 'Students'],
  ['tutors.html', 'Tutors'],
  ['parents.html', 'Parents'],
  ['schools.html', 'Schools'],
  ['features.html', 'Features'],
  ['pricing.html', 'Pricing'],
  ['subjects.html', 'Subjects'],
];

// The header and footer every page shares; the current page is marked in the menu
function header(c, file) {
  const links = PAGES.map(([f, name]) => `<a href="${f}"${f === file ? ' aria-current="page"' : ''}>${name}</a>`).join('');
  return `<div class="aurora" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
<header class="top">
  <div class="wrap bar">
    <a class="brand" href="./" aria-label="${esc(c.brand)} home"><img src="logo-192.png" alt="" width="32" height="32"><span>${esc(c.brand)}</span></a>
    <nav class="links" aria-label="Main">${links}</nav>
    <div class="actions">
      <button class="icon-btn theme-btn" id="theme" type="button" data-theme-toggle aria-label="Switch light or dark"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></button>
      <a class="btn ghost hide-sm" href="${esc(c.appPath)}#start=signin">Sign in</a>
      <a class="btn primary" href="students.html#countdown">Get my plan</a>
      <button class="icon-btn menu-btn" id="menu" type="button" aria-label="Menu" aria-expanded="false" aria-controls="mobile-nav"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
    </div>
  </div>
  <nav class="mobile-nav" id="mobile-nav" aria-label="Main" hidden><a href="./">Home</a>${links}<a href="download.html">Get the app</a><a href="${esc(c.appPath)}#start=signin">Sign in</a><button type="button" class="nav-theme" data-theme-toggle>Switch light or dark</button></nav>
</header>`;
}
function footer(c, year) {
  return `<footer class="foot">
  <div class="wrap">
    <div class="foot-grid">
      <div class="foot-brand"><a class="brand" href="./"><img src="logo-192.png" alt="" width="28" height="28"><span>${esc(c.brand)}</span></a><p class="fine">${esc(c.tagline)}</p></div>
      <nav aria-label="For students"><b>Students</b><a href="students.html">How it works</a><a href="students.html#countdown">Exam countdown</a><a href="subjects.html">Subjects</a><a href="students.html#early">Early access</a></nav>
      <nav aria-label="For tutors"><b>Tutors</b><a href="tutors.html">For tutors</a><a href="features.html#prof">Meet Prof</a><a href="${esc(c.appPath)}#start=tutor">Free trial</a><a href="${esc(c.appPath)}#start=signin">Sign in</a></nav>
      <nav aria-label="For families and schools"><b>Families</b><a href="parents.html">Parents</a><a href="schools.html">Schools and centres</a><a href="download.html">Get the app</a></nav>
      <nav aria-label="About"><b>${esc(c.brand)}</b><a href="./">Home</a><a href="features.html">Features</a><a href="pricing.html">Pricing</a><a href="contact.html">Contact</a><a href="terms.html">Terms</a><a href="privacy.html">Privacy</a></nav>
    </div>
    <p class="legal-line">© ${year} ${esc(c.brand)}. Cambridge, Pearson Edexcel and IB are trademarks of their owners. ${esc(c.brand)} is not affiliated with or endorsed by them, and its practice papers are original.</p>
  </div>
</footer>`;
}

// {{name}} fills in a value; {{name:arg}} drops in website/partials/name.html, where {{arg}} is the argument
function render(src, tokens, where, depth = 0) {
  return src.replace(/\{\{(\w+)(?::([\w-]*))?\}\}/g, (m, k, arg) => {
    if (k in tokens && arg === undefined) return tokens[k];
    const file = join(root, 'website/partials', `${k}.html`);
    if (depth < 3 && existsSync(file)) return render(readFileSync(file, 'utf8'), { ...tokens, arg: arg || '' }, `partials/${k}.html`, depth + 1);
    throw new Error(`website/${where}: unknown {{${k}}}`);
  });
}

export async function buildWebsite(out, version, sb = { url: process.env.SB_URL, key: process.env.SB_KEY }) {
  const c = siteConfig();
  mkdirSync(out, { recursive: true });
  const today = new Date();
  const tokens = {
    brand: esc(c.brand),
    tagline: esc(c.tagline),
    siteUrl: esc(c.siteUrl),
    contactEmail: esc(c.contactEmail),
    app: esc(c.appPath),
    repo: esc(c.releasesRepo),
    year: String(today.getFullYear()),
    updated: today.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    yearlyFree: `${c.yearlyMonthsFree} month${c.yearlyMonthsFree === 1 ? '' : 's'} free`,
    tutorFrom: String(c.tutorLevels[0].steps[0].price),
    icStudent: ICONS.student,
    icTutor: ICONS.tutor,
    icParent: ICONS.parent,
    icSchool: ICONS.school,
    marqueeA: marquee(c, 0),
    marqueeB: marquee(c, 1),
    trialDays: String(c.trialDays),
    earlyAccessPayment: esc(c.earlyAccessPayment),
    levels: levelCards(c),
    studentMonth: String(c.selfLearner.month),
    studentPass: String(c.selfLearner.passMonth),
    studentExampleMonths: String(c.selfLearner.exampleMonths),
    studentExample: String(c.selfLearner.passMonth * c.selfLearner.exampleMonths),
    schoolYear: String(c.schoolPlan.perLearnerYear),
    schoolMin: String(c.schoolPlan.minLearners),
    schoolMinYear: String(c.schoolPlan.perLearnerYear * c.schoolPlan.minLearners),
    currencyOptions: c.currencies.map((x) => `<option value="${esc(x.code)}">${esc(x.code)} (${esc(x.symbol)})</option>`).join(''),
    subjectCount: String(subjectCount(c)),
    languages: c.languages.map((l, i) => `<i${i ? ' class="soon"' : ''}>${esc(l)}</i>`).join(''),
    audienceCards: c.audiences
      .map((a) => `<a class="fit-card" href="${esc(a.href)}"><span class="fc-top"><span class="fc-ic">${ICONS[a.id] || ''}</span><span class="status ${statusClass(a.status)}">${esc(a.status)}</span></span><b>${esc(a.name)}</b><p>${esc(a.line)}</p><span class="go">${esc(a.go || 'Show me')} <i aria-hidden="true">→</i></span></a>`)
      .join(''),
    boardButtons: c.boards.map((b, i) => `<button type="button" data-board="${esc(b.id)}" aria-pressed="${i === 0}">${esc(b.name)}</button>`).join(''),
    boardTabs: c.boards
      .map((b, i) => `<button role="tab" id="tab-${esc(b.id)}" aria-selected="${i === 0}" aria-controls="panel-${esc(b.id)}"${i ? ' tabindex="-1"' : ''}>${esc(b.name)}</button>`)
      .join(''),
    boardPanels: c.boards
      .map(
        (b, i) => `<div class="board-panel" role="tabpanel" id="panel-${esc(b.id)}" aria-labelledby="tab-${esc(b.id)}"${i ? ' hidden' : ''}>${b.levels
          .map((l) => `<div class="level"><h3>${esc(levelTitle(b, l))}</h3><ul class="chips">${l.subjects.map(([n, code]) => `<li>${esc(n)}${code && b.id !== 'ib' ? `<small>${esc(code)}</small>` : ''}</li>`).join('')}</ul></div>`)
          .join('')}</div>`,
      )
      .join('\n      '),
    filterButtons: c.boards.map((b) => `<button type="button" data-filter="${esc(b.id)}" aria-pressed="false">${esc(b.name)}</button>`).join(''),
    allSubjects: c.boards
      .map(
        (b) => `<section class="board-panel board-block" data-board="${esc(b.id)}"><h2 class="left" style="font-size:28px">${esc(b.name)}</h2>${b.levels
          .map(
            (l) => `<div class="level"><h3>${esc(levelTitle(b, l))}</h3><ul class="subject-list">${l.subjects
              .map(
                ([n, code]) =>
                  `<li data-s="${esc(`${n} ${code || ''} ${b.name} ${l.name}`.toLowerCase())}" data-key="${esc(catalogueKey(b, l, n, code))}"><a href="${subjectFile(b, l, n, code)}"><span>${esc(n)}</span>${code ? `<small>${esc(code)}</small>` : ''}</a></li>`,
              )
              .join('')}</ul></div>`,
          )
          .join('')}</section>`,
      )
      .join('\n    '),
  };
  // Each page asks for this release's own copy of the styles and scripts (site.css?v=…), so a browser that kept an
  // older copy for a few hours shows the new look straight away
  const v = (f) => createHash('sha1').update(readFileSync(join(root, 'website', f))).digest('hex').slice(0, 10);
  const fresh = (html) =>
    html
      .replace(/href="site\.css"/g, `href="site.css?v=${v('site.css')}"`)
      .replace(/src="site\.js"/g, `src="site.js?v=${v('site.js')}"`)
      .replace(/src="config\.js"/g, `src="config.js?v=${String(version || Date.now())}"`);
  const built = [];
  for (const f of readdirSync(join(root, 'website'))) {
    if (f.endsWith('.html')) {
      const page = { ...tokens, header: header(c, f), footer: footer(c, tokens.year) };
      writeFileSync(join(out, f), fresh(previews(render(readFileSync(join(root, 'website', f), 'utf8'), page, f), c, f)));
      built.push(f);
    } else if (f.endsWith('.css') || f.endsWith('.js') || f.endsWith('.png')) copyFileSync(join(root, 'website', f), join(out, f));
  }
  // a page for every subject, all from one template
  const subjectSrc = readFileSync(join(root, 'website/partials/subject-page.html'), 'utf8');
  const subjects = subjectPages(c);
  for (const s of subjects) {
    const page = { ...tokens, ...subjectTokens(c, s, subjects), header: header(c, s.file), footer: footer(c, tokens.year) };
    writeFileSync(join(out, s.file), fresh(previews(render(subjectSrc, page, 'partials/subject-page.html'), c, s.file)));
  }
  // For search engines: every page (home, the menu's pages, the rest, then the subjects), and everything but the app
  const first = ['index.html', ...PAGES.map(([f]) => f)].filter((f) => built.includes(f));
  const urls = [...first, ...built.filter((f) => !first.includes(f)).sort(), ...subjects.map((s) => s.file)].map((f) => pageUrl(c, f));
  writeFileSync(
    join(out, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join('\n')}\n</urlset>\n`,
  );
  writeFileSync(join(out, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /app/\n\nSitemap: ${c.siteUrl}sitemap.xml\n`);
  // the home page's opening: the logo cut into layers by scripts/make-intro.py
  mkdirSync(join(out, 'intro'), { recursive: true });
  for (const f of readdirSync(join(root, 'website/intro'))) copyFileSync(join(root, 'website/intro', f), join(out, 'intro', f));
  const pub = {
    brand: c.brand, siteUrl: c.siteUrl, contactEmail: c.contactEmail, appPath: c.appPath, releasesRepo: c.releasesRepo, tutorLevels: c.tutorLevels, yearlyMonthsFree: c.yearlyMonthsFree, currencies: c.currencies,
    boards: c.boards.map((b) => ({ id: b.id, name: b.name, sessions: b.sessions })),
    // the public address and key of the server (both public by design), for the early-access form
    sb: sb?.url && sb?.key ? { url: sb.url.replace(/\/+$/, ''), key: sb.key } : null,
  };
  writeFileSync(join(out, 'config.js'), `window.SITE = ${JSON.stringify(pub)};\n`);
  copyFileSync(join(root, 'public/favicon.png'), join(out, 'favicon.png'));
  copyFileSync(join(root, 'public/icon-192.png'), join(out, 'logo-192.png'));
  copyFileSync(join(root, 'public/icon-512.png'), join(out, 'logo-512.png'));
  writeFileSync(join(out, 'app-qr.svg'), await QRCode.toString(c.siteUrl + c.appPath, { type: 'svg', margin: 1, color: { dark: '#0B3F3F', light: '#FFFFFF' } }));
  if (version) {
    const base = `https://github.com/${c.releasesRepo}/releases/download/v${version}/`;
    writeFileSync(
      join(out, 'release.json'),
      JSON.stringify({
        version,
        windows: `${base}StudyBridge-Setup-${version}.exe`,
        mac_arm: `${base}StudyBridge-${version}-arm64.dmg`,
        mac_x64: `${base}StudyBridge-${version}-x64.dmg`,
      }),
    );
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [out = 'dist-site', version] = process.argv.slice(2);
  await buildWebsite(out, version);
  console.log(`Website built in ${out}${version ? ` (downloads for ${version})` : ''}`);
}
