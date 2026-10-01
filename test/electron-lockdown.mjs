// Desktop app check: a locked-down test fills the screen, reports leaving the
// window to the tutor, can't be closed, and unlocks when handed in.
//   npm run build && xvfb-run -a node test/electron-lockdown.mjs
import { _electron as electron, chromium } from 'playwright';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { startFakeSupabase } from './fake-supabase.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
for (const ev of ['uncaughtException', 'unhandledRejection'])
  process.on(ev, (e) => {
    console.error(e);
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=electron-lockdown (${ev})::${String(e?.message || e).replace(/\n/g, ' ').slice(0, 900)}`);
    process.exit(1);
  });
const SHOTS = process.env.SHOTS || join(ROOT, 'test', 'screenshots');
mkdirSync(SHOTS, { recursive: true });
const srv = await startFakeSupabase();
const sb = () => createClient(srv.url, srv.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

// Seed: tutor, learner, a locked-down camera test
const tutor = sb();
await tutor.auth.signUp({ email: 'tutor@example.com', password: 'secret123' });
await tutor.rpc('become_tutor', { p_name: 'Aaryan' });
const inv = (await tutor.from('invites').insert({ name: 'Anaya' }).select().single()).data;
const learner = sb();
await learner.auth.signUp({ email: 'anaya@example.com', password: 'secret123' });
await learner.rpc('accept_invite', { p_code: inv.code, p_name: 'Anaya' });
const a = (await tutor.from('assignments').insert({ kind: 'test', title: 'Algebra test', visibility: 'visible', lockdown: true, camera: true, time_limit_min: 30 }).select().single()).data;
const q1 = (await tutor.from('questions').insert({ assignment_id: a.id, type: 'mcq', prompt_md: 'Solve $x + 5 = 9$', options: ['3', '4', '5'], marks: 1 }).select().single()).data;
await tutor.from('question_keys').insert({ question_id: q1.id, answer: { choice: '1' } });

// With a LiveKit server available, the camera really streams and the tutor watches it
const LK = process.env.LIVEKIT_URL;
if (LK) await tutor.rpc('set_live_keys', { p_url: LK, p_key: process.env.LIVEKIT_KEY || 'devkey', p_secret: process.env.LIVEKIT_SECRET || 'secret' });

const app = await electron.launch({
  executablePath: join(ROOT, 'node_modules', 'electron', 'dist', 'electron'),
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ROOT],
  env: { ...process.env, SB_USER_DATA: mkdtempSync(join(tmpdir(), 'sb-')), SB_TEST: '1' },
});
const win = await app.firstWindow();
const errs = [];
win.on('pageerror', (e) => errs.push(e.message));
const isKiosk = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isKiosk());
const events = async () => (await tutor.from('attempts').select('lockdown_events').eq('assignment_id', a.id)).data[0]?.lockdown_events || [];

try {
  await win.evaluate(([u, k]) => (localStorage.setItem('sb.server', JSON.stringify({ url: u, key: k })), localStorage.setItem('sb.seen', '1')), [srv.url, srv.anonKey]);
  await win.reload();
  await win.getByLabel('Email').fill('anaya@example.com');
  await win.getByLabel('Password').fill('secret123');
  await win.getByRole('button', { name: 'Sign in' }).click();
  await win.getByText(/, Anaya!/).waitFor();
  assert.equal(await win.evaluate(() => !!window.studybridge?.desktop), true, 'desktop bridge available');

  await win.getByText('Algebra test').first().click();
  await win.getByText('locked to StudyBridge').waitFor();
  await win.screenshot({ path: join(SHOTS, 'desktop-before-test.png') });
  await win.getByRole('button', { name: 'Start', exact: true }).click();
  await win.getByRole('button', { name: /Start test/ }).click();
  await win.getByText('Locked until you hand in').waitFor();
  assert.equal(await isKiosk(), true, 'window locked (kiosk)');
  console.log('• Lockdown on');

  // Leaving the window is reported
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('blur'));
  await win.getByText(/Your tutor has been told/).waitFor();
  // Closing is blocked
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await win.waitForTimeout(1500);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, 'window still open');
  const ev = (await events()).map((e) => e.event);
  assert.ok(ev.includes('Left the StudyBridge window'), 'blur reported: ' + ev.join(' | '));
  assert.ok(ev.some((e) => /close/.test(e)), 'close attempt reported');
  if (!LK) assert.ok(ev.some((e) => /Camera could not start/.test(e)), 'camera failure reported when live video is not set up');
  if (LK) {
    await win.getByText('Tutor can see you').waitFor({ timeout: 30000 });
    // Tutor opens the watch page in a browser and sees the camera
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
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined), args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    // (media permission lets Chromium use loopback network addresses, needed only for this local test server)
    const T = await (await browser.newContext({ viewport: { width: 1300, height: 820 }, permissions: ['camera', 'microphone'] })).newPage();
    if (process.env.DEBUG_LIVE) T.on('console', (m) => console.log('tutor console:', m.type(), m.text().slice(0, 300)));
    await T.goto(`http://127.0.0.1:${web.address().port}/`);
    await T.evaluate(([u, k]) => (localStorage.setItem('sb.server', JSON.stringify({ url: u, key: k })), localStorage.setItem('sb.seen', '1')), [srv.url, srv.anonKey]);
    await T.reload();
    await T.getByLabel('Email').fill('tutor@example.com');
    await T.getByLabel('Password').fill('secret123');
    await T.getByRole('button', { name: 'Sign in' }).click();
    await T.locator('.content').waitFor();
    const attemptId = (await tutor.from('attempts').select('id').eq('assignment_id', a.id)).data[0].id;
    await T.evaluate((id) => (location.hash = `#/watch/${id}`), attemptId);
    try {
      await T.waitForFunction(() => [...document.querySelectorAll('.tile video')].some((v) => v.readyState >= 2 && v.videoWidth > 0), null, { timeout: 30000 });
    } catch (e) {
      await T.screenshot({ path: join(SHOTS, 'desktop-watch-FAIL.png') });
      console.log('watch page:', (await T.locator('.content').innerText()).slice(0, 600));
      await browser.close();
      web.close();
      throw e;
    }
    await T.getByText('Left the StudyBridge window').waitFor();
    await T.waitForTimeout(1500);
    await T.screenshot({ path: join(SHOTS, 'desktop-tutor-watching-exam.png') });
    console.log('• Tutor sees the live exam camera' + ((await T.locator('.tile video').count()) > 1 ? ' and screen' : ''));
    await browser.close();
    web.close();
  }
  const notes = (await tutor.from('notifications').select('kind,title').eq('kind', 'lockdown')).data;
  assert.ok(notes.length >= 2, 'tutor notified');
  console.log('• Leaving and closing reported to the tutor');
  await win.screenshot({ path: join(SHOTS, 'desktop-locked-test.png') });

  await win.locator('label.opt').nth(1).click();
  await win.getByText('All saved').waitFor();
  await win.getByRole('button', { name: 'Hand in' }).first().click();
  await win.getByRole('dialog').getByRole('button', { name: 'Hand in' }).click();
  await win.getByText(/Handed in\. Well done/).waitFor();
  await win.waitForTimeout(500);
  assert.equal(await isKiosk(), false, 'unlocked after handing in');
  console.log('• Unlocked after handing in');
  const t = (await tutor.from('attempts').select('status,score').eq('assignment_id', a.id)).data[0];
  assert.equal(t.status, 'marked');
  assert.equal(Number(t.score), 1);
  if (errs.length) throw new Error('Page errors: ' + errs.join('; '));
  console.log('\nDesktop lockdown check passed.');
} catch (e) {
  await win.screenshot({ path: join(SHOTS, 'desktop-FAIL.png') }).catch(() => {});
  console.error('FAILED:', e.message);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=electron-lockdown.mjs::${String(e.message).replace(/\n/g, ' ').slice(0, 900)}`);
  process.exitCode = 1;
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await srv.close();
}
