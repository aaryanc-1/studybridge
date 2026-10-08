// The website builds from its one config, and the config agrees with the app (plan limits, prices, web address)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWebsite, siteConfig, subjectCount, PAGES } from '../scripts/build-website.mjs';

test('website: every page builds with nothing left unfilled', async () => {
  const out = mkdtempSync(join(tmpdir(), 'sbsite-'));
  try {
    await buildWebsite(out, '1.1.99', { url: 'https://example.supabase.co/', key: 'anon-key' });
    const pages = ['index.html', ...PAGES.map(([f]) => f), 'contact.html', 'terms.html', 'privacy.html'];
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
      for (const [p] of PAGES) assert.ok(html.includes(`href="${p}"`), `${f} links to ${p}`);
    }
    // each page marks itself in the menu
    for (const [p, name] of PAGES) assert.ok(read(p).includes(`<a href="${p}" aria-current="page">${name}</a>`), p);
    // home: the introduction, every audience with its own page, and the ways in
    const home = read('index.html');
    for (const a of c.audiences) assert.ok(home.includes(a.name) && home.includes(`href="${a.href}"`), a.name);
    assert.match(home, /#start=invite/);
    assert.match(home, /#start=tutor/);
    // students: the countdown for every board, the subjects and the early-access form
    const students = read('students.html');
    for (const b of c.boards) assert.ok(students.includes(`data-board="${b.id}"`) && students.includes(`id="panel-${b.id}"`), b.id);
    assert.match(students, /id="cd-session"/);
    assert.match(students, /data-default-role="student"/);
    // tutors: plans and the calculator; parents and schools: their own early-access forms; downloads
    for (const l of c.tutorLevels) assert.match(read('tutors.html'), new RegExp(`data-level="${l.id}"`));
    assert.match(students, new RegExp(`data-usd="${c.selfLearner.month}"`), 'students see their price');
    // students never chat with AI: the website doesn't promise it
    for (const f of pages) assert.doesNotMatch(read(f), /Prof as (your|their) guide|Prof guides (you|them|students)/, `${f}: no AI chat for students`);
    assert.match(read('parents.html'), /#start=parent/);
    assert.match(read('parents.html'), /data-default-role="parent"/);
    assert.match(read('schools.html'), /data-default-role="centre"/);
    assert.match(read('download.html'), /data-dl="windows"/);
    // contact: the form, hello@ on every page (footer), never support@ (that one is for inside the app)
    assert.match(read('contact.html'), /id="contact-form"/);
    for (const f of pages) {
      assert.ok(read(f).includes(c.contactEmail) && read(f).includes('href="contact.html"'), `${f}: contact`);
      assert.ok(!read(f).includes('support@'), `${f}: support@ stays inside the app`);
    }
    assert.match(read('privacy.html'), /Cloudflare Web Analytics/);
    // the subjects page lists every subject in the config, searchable
    const subjects = readFileSync(join(out, 'subjects.html'), 'utf8');
    assert.equal((subjects.match(/<li data-s=/g) || []).length, subjectCount(c));
    assert.match(subjects, new RegExp(`${subjectCount(c)} subjects`));
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
