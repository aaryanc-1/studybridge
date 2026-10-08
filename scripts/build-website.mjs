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

function planCards(c) {
  return c.plans
    .map((p) => {
      const free = !p.month;
      const items = [
        `${p.learners === 1 ? '1 learner' : `Up to ${p.learners} learners`}`,
        'Every feature, including Prof',
        'Free parent accounts',
        free ? 'No card needed' : 'Cancel any time',
      ];
      const cta = free ? 'Start free' : c.freeNow ? 'Start free now' : `Choose ${p.name}`;
      return `<article class="plan${p.popular ? ' popular' : ''}" data-plan="${esc(p.id)}">
          ${p.popular ? '<span class="tag">Most popular</span>' : ''}
          <h3>${esc(p.name)}</h3>
          <div class="who">${esc(p.blurb)}</div>
          <div><span class="amount">$${p.month}</span><span class="per">${free ? 'for ever' : '/ month'}</span></div>
          <div class="equiv"></div>
          <ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
          <a class="btn${p.popular ? ' primary' : ''}" href="${esc(c.appPath)}#start=tutor">${cta}</a>
          ${!free && c.freeNow ? '<div class="soon">Paid plans coming soon</div>' : ''}
        </article>`;
    })
    .join('\n        ');
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
      <div><a class="brand" href="./"><img src="logo-192.png" alt="" width="28" height="28"><span>${esc(c.brand)}</span></a><p class="fine">${esc(c.tagline)}</p><p class="fine"><a href="mailto:${esc(c.contactEmail)}">${esc(c.contactEmail)}</a></p></div>
      <nav aria-label="For students"><b>Students</b><a href="students.html">How it works</a><a href="students.html#countdown">Exam countdown</a><a href="subjects.html">Subjects</a><a href="students.html#early">Early access</a></nav>
      <nav aria-label="For tutors"><b>Tutors</b><a href="tutors.html">Features</a><a href="tutors.html#pricing">Pricing</a><a href="${esc(c.appPath)}#start=tutor">Start free</a><a href="${esc(c.appPath)}#start=signin">Sign in</a></nav>
      <nav aria-label="Parents and schools"><b>Families and schools</b><a href="parents.html">Parents</a><a href="schools.html">Schools and centres</a><a href="download.html">Get the app</a></nav>
      <nav aria-label="About"><b>About</b><a href="./">Home</a><a href="contact.html">Contact</a><a href="terms.html">Terms</a><a href="privacy.html">Privacy</a></nav>
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
    monthsFree: String(c.yearlyMonthsFree),
    freeBadge: c.freeNow ? 'Free while we grow · paid plans coming soon' : 'Free for one learner',
    freeLine: c.freeNow ? 'Free now, paid plans coming soon.' : 'Start free with one learner.',
    plans: planCards(c),
    currencyOptions: c.currencies.map((x) => `<option value="${esc(x.code)}">${esc(x.code)} (${esc(x.symbol)})</option>`).join(''),
    subjectCount: String(subjectCount(c)),
    languages: c.languages.map((l, i) => `<i${i ? ' class="soon"' : ''}>${esc(l)}</i>`).join(''),
    audienceCards: c.audiences
      .map((a) => `<a class="fit-card" href="${esc(a.href)}"><span class="status ${statusClass(a.status)}">${esc(a.status)}</span><b>${esc(a.name)}</b><p>${esc(a.line)}</p><span class="go">${esc(a.go || 'Show me')} →</span></a>`)
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
    brand: c.brand, siteUrl: c.siteUrl, contactEmail: c.contactEmail, appPath: c.appPath, releasesRepo: c.releasesRepo, freeNow: c.freeNow, plans: c.plans, currencies: c.currencies,
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
