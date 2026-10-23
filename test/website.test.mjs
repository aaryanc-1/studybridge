// The website builds from its one config, and the config agrees with the app (plan limits, prices, web address)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWebsite, siteConfig, subjectCount, PAGES, catalogueKey, subjectPages, subjectName } from '../scripts/build-website.mjs';

test('website: every page builds with nothing left unfilled', async () => {
  const out = mkdtempSync(join(tmpdir(), 'sbsite-'));
  try {
    await buildWebsite(out, '1.1.99', { url: 'https://example.supabase.co/', key: 'anon-key' });
    const pages = ['index.html', ...PAGES.map(([f]) => f), 'download.html', 'contact.html', 'terms.html', 'privacy.html'];
    for (const f of [...pages, 'site.css', 'site.js', 'config.js', 'app-qr.svg', 'logo-192.png', 'favicon.png', 'release.json']) {
      assert.ok(existsSync(join(out, f)), f);
    }
    assert.ok(!existsSync(join(out, 'partials')), 'the shared pieces are built into the pages, not published');
    const c = siteConfig();
    const read = (f) => readFileSync(join(out, f), 'utf8');
    for (const f of pages) {
      const html = read(f);
      assert.doesNotMatch(html, /\{\{/, f);
      assert.match(html, new RegExp(`<title>[^<]*${c.brand}`), f);
      assert.match(html, /not affiliated with or endorsed by/, `${f}: the trademark note`);
      assert.match(html, /href="site\.css\?v=[0-9a-f]{10}"/, `${f}: asks for this release's styles, not an old saved copy`);
      for (const [p] of PAGES) assert.ok(html.includes(`href="${p}"`), `${f} links to ${p}`);
    }
    // each page marks itself in the menu
    for (const [p, name] of PAGES) assert.ok(read(p).includes(`<a href="${p}" aria-current="page">${name}</a>`), p);
    // home: the introduction, every audience with its own page, and the ways in
    const home = read('index.html');
    for (const a of c.audiences) assert.ok(home.includes(a.name) && home.includes(`href="${a.href}"`), a.name);
    assert.match(home, /#start=invite/);
    assert.match(home, /#start=tutor/);
    // home only: the opening (the logo comes to life), once a browser session and never with reduced motion,
    // with every layer it draws published next to the pages
    assert.match(home, /id="logo-intro"/);
    assert.match(home, /sessionStorage\.getItem\('sb\.intro'\)/);
    assert.match(home, /prefers-reduced-motion: reduce/);
    assert.match(home, /<button class="li-skip" type="button"/, 'a real Skip button');
    for (const f of pages.filter((p) => p !== 'index.html')) assert.doesNotMatch(read(f), /logo-intro|intro-play/, `${f}: no opening`);
    const layers = [...read('site.css').matchAll(/url\((intro\/[\w-]+\.png)\)/g)].map((m) => m[1]);
    assert.ok(layers.length >= 11, 'the logo in layers, and the word');
    for (const f of layers) assert.ok(existsSync(join(out, f)), f);
    // students: the countdown for every board, the subjects and the early-access form
    const students = read('students.html');
    for (const b of c.boards) assert.ok(students.includes(`data-board="${b.id}"`) && students.includes(`id="panel-${b.id}"`), b.id);
    assert.match(students, /id="cd-session"/);
    assert.match(students, /data-default-role="student"/);
    // only a student is asked their age (parents, tutors, centres and schools sign up for themselves), and the form's
    // fields and dropdown lists stay readable in dark mode
    assert.match(students, /<label class="check" id="ea-age"><input type="checkbox" name="age">/);
    assert.match(read('site.js'), /\$\('#ea-age'\)\.hidden = form\.elements\.role\.value !== 'student'/);
    assert.match(read('site.css'), /\.early-box input, \.early-box select, \.early-box textarea \{[^}]*color-scheme: light/);
    // tutors: plans and the calculator; parents and schools: their own early-access forms; downloads
    // pricing: its own page, one panel per kind of user, opened by the address (pricing.html#tutors)
    const pricing = read('pricing.html');
    for (const l of c.tutorLevels) assert.match(pricing, new RegExp(`data-level="${l.id}"`));
    assert.match(pricing, new RegExp(`data-usd="${c.selfLearner.month}"`), 'students see their price');
    for (const who of ['students', 'tutors', 'parents', 'schools']) assert.ok(pricing.includes(`data-hash="${who}"`) && pricing.includes(`id="pp-${who}"`), who);
    assert.match(read('tutors.html'), /href="pricing\.html#tutors"/);
    assert.match(students, /href="pricing\.html#students"/);
    for (const f of pages) assert.doesNotMatch(read(f), /tutors\.html#pricing/, `${f}: pricing lives on its own page`);
    // students never chat with AI: the website doesn't promise it
    for (const f of pages) assert.doesNotMatch(read(f), /Prof as (your|their) guide|Prof guides (you|them|students)/, `${f}: no AI chat for students`);
    assert.match(read('parents.html'), /#start=parent/);
    assert.match(read('parents.html'), /data-default-role="parent"/);
    assert.match(read('schools.html'), /data-default-role="centre"/);
    assert.match(read('download.html'), /data-dl="windows"/);
    // contact: the form and hello@ on the contact page, a Contact link on every page, never support@ (that one is for inside the app)
    assert.match(read('contact.html'), /id="contact-form"/);
    assert.ok(read('contact.html').includes(c.contactEmail));
    for (const f of pages) {
      assert.ok(read(f).includes('href="contact.html"'), `${f}: contact`);
      assert.ok(!read(f).includes('support@'), `${f}: support@ stays inside the app`);
    }
    assert.match(read('privacy.html'), /Cloudflare Web Analytics/);
    // the subjects page lists every subject in the config, searchable
    const subjects = readFileSync(join(out, 'subjects.html'), 'utf8');
    assert.equal((subjects.match(/<li data-s=/g) || []).length, subjectCount(c));
    assert.match(subjects, new RegExp(`data-count="${subjectCount(c)}">${subjectCount(c)}</span> subjects`));
    assert.match(subjects, /data-s="physics 0625 cambridge igcse"/);
    // the early-access form talks to the server only through its public address and key
    const pub = readFileSync(join(out, 'config.js'), 'utf8');
    assert.match(pub, /"sb":\{"url":"https:\/\/example\.supabase\.co","key":"anon-key"\}/);
    const rel = JSON.parse(readFileSync(join(out, 'release.json'), 'utf8'));
    assert.equal(rel.windows, `https://github.com/${c.releasesRepo}/releases/download/v1.1.99/StudyBridge-Setup-1.1.99.exe`);
    assert.match(readFileSync(join(out, 'app-qr.svg'), 'utf8'), /^<svg/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('website: prices are set once, make sense, and the app says the same', () => {
  const c = siteConfig();
  // tutors pay per learner on two levels, in steps that get cheaper; Plus costs more at every step
  const [ess, plus] = c.tutorLevels;
  for (const l of c.tutorLevels) {
    assert.equal(l.steps.at(-1).upTo, null, `${l.id}: the last step has no top`);
    for (let i = 1; i < l.steps.length; i++) assert.ok(l.steps[i].price < l.steps[i - 1].price && (l.steps[i].upTo ?? Infinity) > l.steps[i - 1].upTo, `${l.id} step ${i + 1}`);
  }
  ess.steps.forEach((s, i) => assert.ok(plus.steps[i].price > s.price && plus.steps[i].upTo === s.upTo, `Plus costs more at step ${i + 1}`));
  assert.ok(c.yearlyMonthsFree >= 0 && c.yearlyMonthsFree <= 2 && c.trialDays > 0);
  assert.ok(c.selfLearner.passMonth < c.selfLearner.month, 'the exam pass costs less than paying monthly');
  // the app's "Your plan" names the same levels and starting prices, the same yearly offer and trial
  const settings = readFileSync(new URL('../src/screens/shared/Settings.jsx', import.meta.url), 'utf8');
  for (const l of c.tutorLevels) assert.ok(settings.includes(`${l.name} from $${l.steps[0].price}`), `Settings shows ${l.name}`);
  assert.ok(settings.includes(`Yearly (${c.yearlyMonthsFree} month${c.yearlyMonthsFree === 1 ? '' : 's'} free)`), 'Settings shows the yearly offer');
  assert.ok(settings.includes(`free for ${c.trialDays} days`), 'Settings shows the trial');
  const api = readFileSync(new URL('../src/lib/api.js', import.meta.url), 'utf8');
  assert.ok(api.includes(`WEB_APP = '${c.siteUrl}${c.appPath}'`), 'the app sends people to the same web address');
});

test('website: without the server address the early-access form is switched off, not broken', async () => {
  const out = mkdtempSync(join(tmpdir(), 'sbsite-'));
  try {
    await buildWebsite(out, null, {});
    assert.match(readFileSync(join(out, 'config.js'), 'utf8'), /"sb":null/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('website: every IB subject is offered at SL and HL, and every board has exam sessions', () => {
  const c = siteConfig();
  const ib = c.boards.find((b) => b.id === 'ib');
  for (const [name, levels] of ib.levels[0].subjects) assert.equal(levels, 'SL · HL', name);
  for (const b of c.boards) assert.ok(b.sessions.length >= 2 && b.sessions.every((s) => s.month >= 1 && s.month <= 12 && s.day >= 1 && s.day <= 31), b.id);
});

// The subjects page marks the subjects students can start now by the same keys the app and the database use
test('website: subject keys match the app’s catalogue (cambridge:igcse:0607, ib:sl-and-hl:physics), one per subject', () => {
  const keys = [];
  for (const b of siteConfig().boards) for (const l of b.levels) for (const [n, code] of l.subjects) keys.push(catalogueKey(b, l, n, code));
  assert.equal(new Set(keys).size, keys.length, 'no two subjects share a key');
  assert.ok(keys.includes('cambridge:igcse:0607'));
  assert.ok(keys.includes('ib:sl-and-hl:physics'));
});

// Getting found: a page for every subject, a sitemap and robots.txt, and a link preview on every page
test('website: every subject has its own page, with the right way in whether or not it is open yet', async () => {
  const out = mkdtempSync(join(tmpdir(), 'sbsite-'));
  try {
    await buildWebsite(out, '1.1.99', { url: 'https://example.supabase.co/', key: 'anon-key' });
    const c = siteConfig();
    const read = (f) => readFileSync(join(out, f), 'utf8');
    const amp = (s) => s.replace(/&/g, '&amp;');
    const subjects = subjectPages(c);
    assert.equal(subjects.length, subjectCount(c), 'one page per subject');
    assert.equal(new Set(subjects.map((s) => s.file)).size, subjects.length, 'no two subjects share a page');
    // the file name is the app's catalogue key, so the page and the server's open_subjects() agree
    const maths = subjects.find((s) => s.file === 'subject-cambridge-igcse-0607.html');
    assert.equal(maths?.key, 'cambridge:igcse:0607');
    assert.equal(subjectName(maths.b, maths.l, maths.n, maths.code), 'Cambridge IGCSE International Mathematics (0607)');
    const subjectsPage = read('subjects.html');
    for (const s of subjects) {
      const html = read(s.file);
      const name = subjectName(s.b, s.l, s.n, s.code);
      const where = s.file;
      assert.doesNotMatch(html, /\{\{/, `${where}: nothing left unfilled`);
      assert.ok(html.includes(`<title>${amp(name)} · ${c.brand}</title>`), `${where}: title`);
      assert.equal(/<h1>(.*?)<\/h1>/.exec(html)?.[1].replace(/<[^>]+>/g, ''), amp(name), `${where}: the full name as the heading`);
      const pill = [s.b.name, s.l.name, s.b.id === 'ib' ? '' : s.code].filter(Boolean).join(' · ');
      assert.ok(html.includes(`<span class="pill">${amp(pill)}</span>`), `${where}: board · level · code`);
      // open: the free week; not open: ask for it, the subject already filled in (site.js picks one from open_subjects())
      assert.ok(html.includes(`class="sp-card" id="start" data-key="${s.key}"`), `${where}: knows its key`);
      assert.ok(html.includes(`href="${c.appPath}#start=student">Start your free week</a>`), `${where}: the free week`);
      assert.ok(html.includes('id="req-form"') && html.includes(`<input type="hidden" name="subject" value="${amp(name)}">`), `${where}: ask for this subject`);
      // what a student on their own gets (the IB core has no exam papers or mocks)
      const main = /<main[\s\S]*<\/main>/.exec(html)[0];
      assert.match(main, /a plan to your (exam|deadlines)/i, `${where}: a plan`);
      assert.match(main, /hint/, `${where}: hints`);
      if (s.l.name !== 'Core') for (const bit of ['worked solution', 'practice papers', 'mark scheme', 'timed mocks', 'Progress by topic', 'parents']) assert.ok(main.includes(bit), `${where}: ${bit}`);
      // the board's next sessions, the student price, a short FAQ, the trademark note and the way back
      assert.ok(html.includes(`<ul class="sp-sessions" data-board="${s.b.id}"><li>`), `${where}: exam sessions`);
      assert.ok((html.match(/<li><b>[^<]+ \d{4}<\/b><span>Starts about/g) || []).length >= 2, `${where}: at least two sessions`);
      assert.ok(html.includes(`data-usd="${c.selfLearner.month}"`) && html.includes(`data-usd="${c.selfLearner.passMonth}"`), `${where}: the student price`);
      const faqs = (main.match(/<details/g) || []).length;
      assert.ok(faqs >= 3 && faqs <= 4, `${where}: 3 or 4 questions`);
      assert.match(main, /Not affiliated with or endorsed by [^.<]+\./, `${where}: the trademark note`);
      assert.ok(main.includes('href="subjects.html"'), `${where}: back to all subjects`);
      // students never use AI: no Prof, no chat promised
      assert.doesNotMatch(main, /\bProf\b/, `${where}: Prof is for tutors`);
      // search engines: a Course
      const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(html)[1]);
      const course = ld['@graph'].find((x) => x['@type'] === 'Course');
      assert.equal(course.name, name, `${where}: Course name`);
      assert.equal(course.url, `${c.siteUrl}${s.file.replace(/\.html$/, '')}`, `${where}: Course address`);
      assert.equal(course.provider.name, c.brand);
      assert.ok(course.description.length > 40);
      // the subjects page links to it
      assert.ok(subjectsPage.includes(`data-key="${s.key}"><a href="${s.file}">`), `subjects.html links to ${where}`);
    }
    assert.ok(!existsSync(join(out, 'subject-page.html')), 'the template is not a page');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('website: a sitemap of every page, robots.txt, and a link preview on every page', async () => {
  const out = mkdtempSync(join(tmpdir(), 'sbsite-'));
  try {
    await buildWebsite(out, '1.1.99', { url: 'https://example.supabase.co/', key: 'anon-key' });
    const c = siteConfig();
    const read = (f) => readFileSync(join(out, f), 'utf8');
    const pages = readdirSync(out).filter((f) => f.endsWith('.html'));
    // the address each page is shared at: no .html (Cloudflare Pages sends /x.html to /x), the home page at the root
    const address = (f) => c.siteUrl + (f === 'index.html' ? '' : f.replace(/\.html$/, ''));
    assert.ok(c.siteUrl.startsWith('https://') && c.siteUrl.endsWith('/'));
    // sitemap: every page once, nothing else
    const sitemap = read('sitemap.xml');
    assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    assert.deepEqual([...locs].sort(), pages.map(address).sort(), 'every page, once');
    assert.equal(locs[0], c.siteUrl, 'the home page first');
    for (const s of subjectPages(c)) assert.ok(locs.includes(address(s.file)), `sitemap lists ${s.file}`);
    for (const [f] of PAGES) assert.ok(locs.includes(address(f)), `sitemap lists ${f}`);
    // robots.txt: everything but the app, and where the sitemap is
    const robots = read('robots.txt');
    assert.match(robots, /^User-agent: \*$/m);
    assert.match(robots, /^Disallow: \/app\/$/m);
    assert.ok(robots.includes(`\nSitemap: ${c.siteUrl}sitemap.xml\n`), 'robots.txt points to the sitemap');
    // the preview picture: a 1200 x 630 PNG
    const png = readFileSync(join(out, 'share.png'));
    assert.equal(png.toString('latin1', 1, 4), 'PNG');
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630], 'share.png is 1200 x 630');
    const tag = (html, attr, key) => [...html.matchAll(new RegExp(`<meta ${attr}="${key}" content="([^"]*)">`, 'g'))].map((m) => m[1]);
    for (const f of pages) {
      const html = read(f);
      const head = html.slice(0, html.indexOf('</head>'));
      const title = /<title>([^<]+)<\/title>/.exec(head)[1];
      const description = /<meta name="description" content="([^"]+)">/.exec(head)[1];
      const canonical = [...head.matchAll(/<link rel="canonical" href="([^"]+)">/g)].map((m) => m[1]);
      assert.deepEqual(canonical, [address(f)], `${f}: one canonical address`);
      assert.deepEqual(tag(head, 'property', 'og:title'), [title], `${f}: og:title is its title`);
      assert.deepEqual(tag(head, 'property', 'og:description'), [description], `${f}: og:description is its description`);
      assert.deepEqual(tag(head, 'property', 'og:url'), [address(f)], `${f}: og:url`);
      assert.deepEqual(tag(head, 'property', 'og:image'), [`${c.siteUrl}share.png`], `${f}: og:image, a full address`);
      assert.deepEqual(tag(head, 'property', 'og:type'), ['website'], `${f}: og:type`);
      assert.deepEqual(tag(head, 'property', 'og:site_name'), [c.brand], `${f}: og:site_name`);
      assert.deepEqual(tag(head, 'name', 'twitter:card'), ['summary_large_image'], `${f}: twitter:card`);
      // Aaryan: nothing says "coming soon" (we launch when it's ready)
      assert.doesNotMatch(html, /coming soon/i, `${f}: never "coming soon"`);
    }
    assert.doesNotMatch(read('config.js'), /coming soon/i);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('website: the prices the server charges (app_config.pricing in setup.sql) are the website’s', () => {
  const c = siteConfig();
  const sql = readFileSync(new URL('../supabase/setup.sql', import.meta.url), 'utf8');
  const m = sql.match(/update public\.app_config set pricing = '([\s\S]*?)'::jsonb where id = 1;/);
  assert.ok(m, 'the price list is in setup.sql');
  const p = JSON.parse(m[1]);
  for (const l of c.tutorLevels) assert.deepEqual(p.tutor[l.id], l.steps.map((s) => [s.upTo, s.price]), l.id);
  assert.equal(p.yearlyMonthsFree, c.yearlyMonthsFree);
  assert.deepEqual([p.student.month, p.student.passMonth], [c.selfLearner.month, c.selfLearner.passMonth]);
  assert.deepEqual(p.rates, Object.fromEntries(c.currencies.map((x) => [x.code, x.rate])));
});
