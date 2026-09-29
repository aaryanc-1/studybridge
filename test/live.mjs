// Live lesson check against a real LiveKit server: both people connect with
// passes signed by the database, see each other's video, and share the whiteboard.
//   livekit-server --dev --bind 127.0.0.1 --node-ip 127.0.0.1 &
//   npm run build && node test/live.mjs
import http from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { startFakeSupabase } from './fake-supabase.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || join(ROOT, 'test', 'screenshots');
mkdirSync(SHOTS, { recursive: true });
const LK = process.env.LIVEKIT_URL || 'ws://127.0.0.1:7880';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png' };
const web = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const f = join(ROOT, 'dist', p);
  if (!existsSync(f) || statSync(f).isDirectory()) return res.writeHead(404), res.end();
  res.writeHead(200, { 'content-type': types[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const WEB = `http://127.0.0.1:${web.address().port}/`;

const srv = await startFakeSupabase();
const sb = () => createClient(srv.url, srv.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const tutor = sb();
await tutor.auth.signUp({ email: 'tutor@example.com', password: 'secret123' });
await tutor.rpc('become_tutor', { p_name: 'Aaryan' });
const inv = (await tutor.from('invites').insert({ name: 'Anaya' }).select().single()).data;
const learner = sb();
await learner.auth.signUp({ email: 'anaya@example.com', password: 'secret123' });
const lid = (await learner.rpc('accept_invite', { p_code: inv.code, p_name: 'Anaya' })).data.id;
await tutor.rpc('set_live_keys', { p_url: LK, p_key: 'devkey', p_secret: 'secret' });
const session = (await tutor.from('sessions').insert({ title: 'Quadratics live', starts_at: new Date().toISOString(), learner_ids: [lid] }).select().single()).data;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined), args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
async function join_(email) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 780 }, permissions: ['camera', 'microphone'] });
  const p = await ctx.newPage();
  await p.goto(WEB);
  await p.evaluate(([u, k]) => localStorage.setItem('sb.server', JSON.stringify({ url: u, key: k })), [srv.url, srv.anonKey]);
  await p.reload();
  await p.getByLabel('Email').fill(email);
  await p.getByLabel('Password').fill('secret123');
  await p.getByRole('button', { name: 'Sign in' }).click();
  await p.locator('.content').waitFor();
  await p.evaluate((id) => (location.hash = `#/live/${id}`), session.id);
  return p;
}

let ok = false;
try {
  const T = await join_('tutor@example.com');
  const L = await join_('anaya@example.com');
  // Both see two people, with live video
  for (const p of [T, L]) {
    await p.waitForFunction(() => document.querySelectorAll('.live .tiles .tile').length >= 2, null, { timeout: 30000 });
    await p.waitForFunction(() => [...document.querySelectorAll('.live .tiles video')].filter((v) => v.readyState >= 2 && v.videoWidth > 0).length >= 2, null, { timeout: 30000 });
  }
  console.log('• Both connected and see each other’s video');
  // Tutor draws; learner's board shows it
  const c = T.locator('.board canvas');
  const b = await c.boundingBox();
  await T.mouse.move(b.x + 100, b.y + 100);
  await T.mouse.down();
  for (let i = 1; i < 20; i++) await T.mouse.move(b.x + 100 + i * 15, b.y + 100 + Math.sin(i / 3) * 60);
  await T.mouse.up();
  const inked = () =>
    L.evaluate(() => {
      const cv = document.querySelector('.board canvas');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let dark = 0;
      for (let i = 0; i < d.length; i += 16) if (d[i] < 80 && d[i + 1] < 80 && d[i + 2] < 80) dark++;
      return dark;
    });
  let dark = 0;
  for (let i = 0; i < 40 && dark < 20; i++) {
    await L.waitForTimeout(250);
    dark = await inked();
  }
  assert.ok(dark >= 20, 'stroke reached the learner’s whiteboard');
  console.log('• Whiteboard strokes sync');
  await T.screenshot({ path: join(SHOTS, 'live-tutor.png') });
  await L.screenshot({ path: join(SHOTS, 'live-learner.png') });
  ok = true;
  console.log('\nLive session check passed.');
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  web.close();
  await srv.close();
  if (!ok) process.exitCode = 1;
}
