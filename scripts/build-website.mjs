// Builds the website (website/ → an output folder) from website/site.config.json, so a rename or a price
// change is one edit. CI publishes it at the root of the releases repo's GitHub Pages, next to the phone app at app/.
//   node scripts/build-website.mjs <out dir> [version]
// With a version, release.json points the download buttons straight at that release's files.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const siteConfig = () => JSON.parse(readFileSync(join(root, 'website/site.config.json'), 'utf8'));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Tutors pay per learner, in steps that get cheaper; site.js turns data-usd into the visitor's currency (and yearly)
const stepRange = (s, i, steps) => (s.upTo == null ? `after ${steps[i - 1].upTo}` : `${i ? steps[i - 1].upTo + 1 : 1}\u2013${s.upTo}`);
function levelCards(c) {
  return c.tutorLevels
    .map((l) => {
      const [first, ...rest] = l.steps;
      const then = rest.map((s, i) => `<span data-usd="${s.price}" data-scale>$${s.price}</span> each for learners ${stepRange(s, i + 1, l.steps)}`).join(', and ');
      return `<article class="plan${l.tag ? ' popular' : ''}" data-level="${esc(l.id)}">
          ${l.tag ? `<span class="tag">${esc(l.tag)}</span>` : ''}
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

// The pages, in the order the menu shows them
export const PAGES = [
  ['students.html', 'Students'],
  ['tutors.html', 'Tutors'],
  ['parents.html', 'Parents'],
  ['schools.html', 'Schools'],
  ['pricing.html', 'Pricing'],
  ['subjects.html', 'Subjects'],
  ['download.html', 'Get the app'],
];

// The header and footer every page shares; the current page is marked in the menu
function header(c, file) {
  const links = PAGES.map(([f, name]) => `<a href="${f}"${f === file ? ' aria-current="page"' : ''}>${name}</a>`).join('');
  return `<header class="top">
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
  <nav class="mobile-nav" id="mobile-nav" aria-label="Main" hidden><a href="./">Home</a>${links}<a href="${esc(c.appPath)}#start=signin">Sign in</a><button type="button" class="nav-theme" data-theme-toggle>Switch light or dark</button></nav>
</header>`;
}
function footer(c, year) {
  return `<footer class="foot">
  <div class="wrap">
    <div class="foot-grid">
      <div class="foot-brand"><a class="brand" href="./"><img src="logo-192.png" alt="" width="28" height="28"><span>${esc(c.brand)}</span></a><p class="fine">${esc(c.tagline)}</p></div>
      <nav aria-label="For students"><b>Students</b><a href="students.html">How it works</a><a href="students.html#countdown">Exam countdown</a><a href="subjects.html">Subjects</a><a href="students.html#early">Early access</a></nav>
      <nav aria-label="For tutors"><b>Tutors</b><a href="tutors.html">Features</a><a href="${esc(c.appPath)}#start=tutor">Free trial</a><a href="${esc(c.appPath)}#start=signin">Sign in</a></nav>
      <nav aria-label="For families and schools"><b>Families</b><a href="parents.html">Parents</a><a href="schools.html">Schools and centres</a><a href="download.html">Get the app</a></nav>
      <nav aria-label="About"><b>${esc(c.brand)}</b><a href="./">Home</a><a href="pricing.html">Pricing</a><a href="contact.html">Contact</a><a href="terms.html">Terms</a><a href="privacy.html">Privacy</a></nav>
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
              .map(([n, code]) => `<li data-s="${esc(`${n} ${code || ''} ${b.name} ${l.name}`.toLowerCase())}"><span>${esc(n)}</span>${code ? `<small>${esc(code)}</small>` : ''}</li>`)
              .join('')}</ul></div>`,
          )
          .join('')}</section>`,
      )
      .join('\n    '),
  };
  for (const f of readdirSync(join(root, 'website'))) {
    if (f.endsWith('.html')) {
      const page = { ...tokens, header: header(c, f), footer: footer(c, tokens.year) };
      writeFileSync(join(out, f), render(readFileSync(join(root, 'website', f), 'utf8'), page, f));
    } else if (f.endsWith('.css') || f.endsWith('.js')) copyFileSync(join(root, 'website', f), join(out, f));
  }
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
