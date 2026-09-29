// Desktop app check: a locked-down test fills the screen, reports leaving the
// window to the tutor, can't be closed, and unlocks when handed in.
//   npm run build && xvfb-run -a node test/electron-lockdown.mjs
import { _electron as electron } from 'playwright';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { startFakeSupabase } from './fake-supabase.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
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

const app = await electron.launch({
  executablePath: join(ROOT, 'node_modules', 'electron', 'dist', 'electron'),
  args: ['--no-sandbox', ROOT],
  env: { ...process.env, SB_USER_DATA: mkdtempSync(join(tmpdir(), 'sb-')), SB_TEST: '1' },
});
const win = await app.firstWindow();
const errs = [];
win.on('pageerror', (e) => errs.push(e.message));
const isKiosk = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isKiosk());
const events = async () => (await tutor.from('attempts').select('lockdown_events').eq('assignment_id', a.id)).data[0]?.lockdown_events || [];

try {
  await win.evaluate(([u, k]) => localStorage.setItem('sb.server', JSON.stringify({ url: u, key: k })), [srv.url, srv.anonKey]);
  await win.reload();
  await win.getByLabel('Email').fill('anaya@example.com');
  await win.getByLabel('Password').fill('secret123');
  await win.getByRole('button', { name: 'Sign in' }).click();
  await win.getByText('Hi Anaya').waitFor();
  assert.equal(await win.evaluate(() => !!window.studybridge?.desktop), true, 'desktop bridge available');

  await win.getByText('Algebra test').first().click();
  await win.getByText('locked to StudyBridge').waitFor();
  await win.screenshot({ path: join(SHOTS, 'desktop-before-test.png') });
  await win.getByRole('button', { name: 'Start' }).click();
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
  assert.ok(ev.some((e) => /Camera could not start/.test(e)), 'camera failure reported when live video is not set up');
  const notes = (await tutor.from('notifications').select('kind,title').eq('kind', 'lockdown')).data;
  assert.ok(notes.length >= 2, 'tutor notified');
  console.log('• Leaving and closing reported to the tutor');
  await win.screenshot({ path: join(SHOTS, 'desktop-locked-test.png') });

  await win.locator('label.opt').nth(1).click();
  await win.getByText('All saved').waitFor();
  await win.getByRole('button', { name: 'Hand in' }).first().click();
  await win.getByRole('dialog').getByRole('button', { name: 'Hand in' }).click();
  await win.getByText('Handed in!').waitFor();
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
  process.exitCode = 1;
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await srv.close();
}
