// The website builds from its one config, and the config agrees with the app (plan limits, prices, web address)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWebsite, siteConfig } from '../scripts/build-website.mjs';

test('website: every page builds with nothing left unfilled', async () => {
  const out = mkdtempSync(join(tmpdir(), 'sbsite-'));
  try {
    await buildWebsite(out, '1.1.99');
    for (const f of ['index.html', 'terms.html', 'privacy.html', 'site.css', 'site.js', 'config.js', 'app-qr.svg', 'logo-192.png', 'favicon.png', 'release.json']) {
      assert.ok(existsSync(join(out, f)), f);
    }
    const c = siteConfig();
    for (const f of ['index.html', 'terms.html', 'privacy.html']) {
      const html = readFileSync(join(out, f), 'utf8');
      assert.doesNotMatch(html, /\{\{/, f);
      assert.match(html, new RegExp(`<title>[^<]*${c.brand}`), f);
    }
    const home = readFileSync(join(out, 'index.html'), 'utf8');
    assert.match(home, /#start=tutor/);
    assert.match(home, /#start=invite/);
    for (const p of c.plans) assert.match(home, new RegExp(`data-plan="${p.id}"`));
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
