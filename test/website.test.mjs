// The website builds from its one config, and the config agrees with the app (plan limits, prices, web address)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWebsite, siteConfig, subjectCount } from '../scripts/build-website.mjs';

test('website: every page builds with nothing left unfilled', async () => {
  const out = mkdtempSync(join(tmpdir(), 'sbsite-'));
  try {
    await buildWebsite(out, '1.1.99', { url: 'https://example.supabase.co/', key: 'anon-key' });
    for (const f of ['index.html', 'subjects.html', 'terms.html', 'privacy.html', 'site.css', 'site.js', 'config.js', 'app-qr.svg', 'logo-192.png', 'favicon.png', 'release.json']) {
      assert.ok(existsSync(join(out, f)), f);
    }
    const c = siteConfig();
    for (const f of ['index.html', 'subjects.html', 'terms.html', 'privacy.html']) {
      const html = readFileSync(join(out, f), 'utf8');
      assert.doesNotMatch(html, /\{\{/, f);
      assert.match(html, new RegExp(`<title>[^<]*${c.brand}`), f);
    }
    const home = readFileSync(join(out, 'index.html'), 'utf8');
    assert.match(home, /#start=tutor/);
    assert.match(home, /#start=invite/);
    for (const p of c.plans) assert.match(home, new RegExp(`data-plan="${p.id}"`));
    // every audience, every board, the countdown and the early-access form; the trademark note on every page
    for (const a of c.audiences) assert.ok(home.includes(a.name), a.name);
    for (const b of c.boards) assert.ok(home.includes(`data-board="${b.id}"`) && home.includes(`id="panel-${b.id}"`), b.id);
    assert.match(home, /id="cd-session"/);
    assert.match(home, /id="ea-form"/);
    for (const f of ['index.html', 'subjects.html', 'terms.html', 'privacy.html']) assert.match(readFileSync(join(out, f), 'utf8'), /not affiliated with or endorsed by/, f);
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

test('website: plans and the phone address match the app', () => {
  const c = siteConfig();
  const sql = readFileSync(new URL('../supabase/setup.sql', import.meta.url), 'utf8');
  const limits = sql.match(/_plan_learners\(p_plan text\)[\s\S]*?select case[^\n]*/)[0];
  for (const p of c.plans) assert.match(limits, new RegExp(`'${p.id}' then ${p.learners}\\b`), p.id);
  for (const p of c.plans.filter((x) => x.month)) assert.equal(p.year, p.month * (12 - c.yearlyMonthsFree), `${p.id} yearly = ${12 - c.yearlyMonthsFree} months`);
  const settings = readFileSync(new URL('../src/screens/shared/Settings.jsx', import.meta.url), 'utf8');
  for (const p of c.plans.filter((x) => x.month)) {
    assert.ok(settings.includes(`$${p.month} a month`) && settings.includes(`$${p.year} a year`), `Settings shows ${p.id} prices`);
  }
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
