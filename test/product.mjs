// StudyBridge as a product, end to end in real browsers: an app build with the
// server built in, tutor sign-up and approval, the admin console, Prof making
// a quiz from a textbook page (stand-in Claude), approving it, and pausing a tutor.
//   node test/product.mjs
import http from 'node:http';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { startFakeSupabase } from './fake-supabase.mjs';
import { startFakeClaude, seen } from './fake-claude.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'test', '.dist-product');
const SHOTS = process.env.SHOTS || join(ROOT, 'test', 'screenshots');
mkdirSync(SHOTS, { recursive: true });
const PDF = join(ROOT, 'test', 'fixtures', 'algebra-chapter-3.pdf');

const claude = await startFakeClaude();
const srv = await startFakeSupabase({ port: 54329, anthropicUrl: claude.url });
console.log('• Building the app with the StudyBridge server built in');
execSync(`npx vite build --outDir ${OUT} --emptyOutDir`, { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_SB_URL: srv.url, VITE_SB_KEY: srv.anonKey } });

function serve(dir) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf' };
  const s = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const f = join(dir, p);
    if (!f.startsWith(dir) || !existsSync(f) || statSync(f).isDirectory()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': types[extname(f)] || 'application/octet-stream' });
    res.end(readFileSync(f));
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${s.address().port}/`, close: () => s.close() })));
}
const web = await serve(OUT);
const step = (n) => console.log('•', n);
const nav = (page, name) => page.locator('aside.side').getByRole('link', { name, exact: false }).filter({ hasText: new RegExp('^' + name) }).first();
let shotN = 50;
const shot = async (page, name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(SHOTS, `${++shotN}-${name}.png`) });
};
const errors = [];
const watch = (page, label) => {
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|realtime|Failed to load resource|ERR_CONNECTION|net::|sb:\/\//i.test(m.text())) errors.push(`${label}: ${m.text()}`);
  });
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined) });
const A = await (await browser.newContext({ viewport: { width: 1400, height: 900 }, timezoneId: 'America/New_York' })).newPage();
const B = await (await browser.newContext({ viewport: { width: 1280, height: 820 }, timezoneId: 'Europe/London' })).newPage();
watch(A, 'admin');
watch(B, 'tutor2');

async function signUpTutor(P, name, email) {
  await P.goto(web.url);
  await P.getByText('I’m a tutor').click();
  await P.getByLabel('Your name').fill(name);
  await P.getByLabel('Email').fill(email);
  await P.getByLabel('Password').fill('secret123');
  await P.getByRole('button', { name: 'Create account' }).click();
}

try {
  step('First tutor signs up (no server to set up) and is the StudyBridge admin');
  await signUpTutor(A, 'Aaryan Chouhan', 'aaryan@example.com');
  await nav(A, 'Admin').waitFor();
  await nav(A, 'Prof').waitFor();

  step('Another tutor signs up and waits for approval');
  await B.goto(web.url);
  await B.getByText('I’m a tutor').click();
  await B.getByText(/approved by StudyBridge/).waitFor();
  await B.getByLabel('Your name').fill('Maria Banda');
  await B.getByLabel('Email').fill('maria@example.com');
  await B.getByLabel('Password').fill('secret123');
  await B.getByRole('button', { name: 'Create account' }).click();
  await B.getByText('Waiting for approval', { exact: true }).waitFor();
  await shot(B, 'tutor-waiting-for-approval');

  step('Admin approves her');
  await A.reload();
  await nav(A, 'Admin').click();
  await A.getByRole('heading', { name: 'Waiting for approval' }).waitFor();
  await shot(A, 'admin-waiting');
  await A.getByRole('button', { name: 'Approve' }).click();
  await A.getByText('Maria Banda approved').waitFor();
  await B.getByRole('button', { name: 'Check again' }).click();
  await nav(B, 'Learners').waitFor();
  assert.equal(await nav(B, 'Admin').count(), 0, 'only the admin has Admin');

  step('Admin switches Prof on (Claude key, write-only) and checks the server');
  await A.getByLabel('Claude API key').fill('sk-ant-test-key');
  await A.getByRole('button', { name: 'Save', exact: true }).click();
  await A.getByText('Prof settings saved').waitFor();
  await A.getByRole('button', { name: 'Check the Prof server' }).click();
  await A.getByText(/Prof server is working/).waitFor();
  assert.equal(await A.getByLabel('Claude API key').inputValue(), '');
  await shot(A, 'admin-console');

  step('A learner joins; the tutor’s textbook is in the library');
  const tc = createClient(srv.url, srv.anonKey, { auth: { persistSession: false } });
  await tc.auth.signInWithPassword({ email: 'aaryan@example.com', password: 'secret123' });
  const me = (await tc.auth.getUser()).data.user.id;
  const maths = (await tc.from('subjects').insert({ name: 'Mathematics' }).select().single()).data;
  const inv = (await tc.from('invites').insert({ name: 'Anaya', subject_ids: [maths.id] }).select().single()).data;
  const lc = createClient(srv.url, srv.anonKey, { auth: { persistSession: false } });
  await lc.auth.signUp({ email: 'anaya@example.com', password: 'secret123' });
  await lc.rpc('accept_invite', { p_code: inv.code, p_name: 'Anaya' });
  const path = `${me}/files/algebra.pdf`;
  await tc.storage.from('library').upload(path, readFileSync(PDF), { contentType: 'application/pdf' });
  await tc.from('files').insert({ name: 'Algebra chapter 3.pdf', mime: 'application/pdf', size: 1000, storage_path: path, subject_id: maths.id });

  step('Tutor asks Prof for a quiz from page 1 of the book');
  await A.reload();
  await nav(A, 'Prof').click();
  await A.getByRole('heading', { name: 'Ask Prof' }).waitFor();
  await A.getByLabel('What should Prof make?').fill('A 5 question quiz on linear equations for Anaya from this page, due Friday');
  await A.getByRole('button', { name: 'Use a book from my library' }).click();
  await A.getByRole('textbox', { name: 'Pages' }).fill('1');
  await A.getByRole('button', { name: 'Add these pages' }).click();
  await A.getByText(/Algebra chapter 3\.pdf: page 1/).waitFor();
  await A.getByRole('button', { name: 'Ask Prof' }).click();
  await A.getByText('Prof is on it').waitFor();
  await A.locator('.item', { hasText: 'Linear equations quiz' }).first().waitFor({ timeout: 30000 });
  const img = seen.find((x) => x.body.tools?.some((t) => t.name === 'start_assignment'))?.body.messages[0].content.find((b) => b.type === 'image');
  assert.ok(img && img.source.data.length > 5000, 'Prof got a picture of the page');
  await shot(A, 'prof-draft-ready');

  step('Tutor reviews the draft and approves it');
  await A.locator('.item', { hasText: 'Linear equations quiz' }).first().click();
  await A.getByText('Drafted by Prof').waitFor();
  await shot(A, 'prof-draft-review');
  await A.getByRole('button', { name: 'Approve & post' }).click();
  await A.getByText(/Posted/).first().waitFor();
  const visible = (await lc.from('assignments').select('title')).data;
  assert.deepEqual(visible.map((x) => x.title), ['Linear equations quiz']);

  step('Tutor gives Prof the whole book (no page numbers): the app sends the pages Prof asks for');
  await nav(A, 'Prof').click();
  await A.getByLabel('What should Prof make?').fill('Homework on linear equations from the book');
  await A.getByRole('button', { name: 'Use a book from my library' }).click();
  await A.getByRole('button', { name: 'Add the book' }).click();
  await A.getByText(/Algebra chapter 3\.pdf: Prof finds the pages/).waitFor();
  const before = seen.length;
  await A.getByRole('button', { name: 'Ask Prof' }).click();
  const bookJob = A.locator('.prof-job', { hasText: 'Homework on linear equations from the book' });
  await bookJob.getByRole('link', { name: /Linear equations quiz · 5 questions/ }).waitFor({ timeout: 45000 });
  const looked = seen.slice(before).find((x) => x.body.messages.length === 3 && x.body.tools.some((t) => t.name === 'look_at_pages'));
  assert.ok(looked, 'Prof asked for pages and got them');
  const tr = looked.body.messages[2].content.find((b) => b.type === 'tool_result');
  assert.ok(tr.content.filter((b) => b.type === 'image').length >= 1, 'the app sent pictures of the pages');
  await shot(A, 'prof-whole-book');

  step('Tutor replies to Prof under its answer');
  await bookJob.getByRole('button', { name: 'Reply to Prof' }).click();
  await bookJob.getByLabel('Reply to Prof').fill('Make questions 4 and 5 harder');
  await bookJob.getByRole('button', { name: 'Send' }).click();
  await A.getByText('Sent to Prof').waitFor();
  const replyJob = A.locator('.prof-job', { hasText: 'Make questions 4 and 5 harder' });
  await replyJob.getByText(/↳ Reply to “Homework on linear equations/).waitFor();
  await replyJob.getByRole('link', { name: /Linear equations quiz/ }).waitFor({ timeout: 45000 });

  step('Tutor switches on auto-marking');
  await nav(A, 'Prof').click();
  await A.getByText('Mark hand-ins for me').click();
  await A.getByText('Saved').first().waitFor();
  const ps = (await tc.from('prof_settings').select('*').single()).data;
  assert.equal(ps.auto_mark, true);
  await shot(A, 'prof-page');

  step('Admin pauses the other tutor: she can’t sign in, nothing is deleted');
  await nav(A, 'Admin').click();
  await A.locator('.tutor-row', { hasText: 'Maria Banda' }).getByRole('button', { name: 'Pause' }).click();
  await A.getByRole('dialog').getByRole('button', { name: 'Pause' }).click();
  await A.getByText('Maria Banda paused', { exact: true }).waitFor();
  await B.reload();
  await B.getByText('Your account is paused').waitFor();
  await B.getByRole('button', { name: 'Sign out' }).click();
  await B.getByText('I already have an account: sign in').click().catch(() => {});
  await B.getByLabel('Email').fill('maria@example.com');
  await B.getByLabel('Password').fill('secret123');
  await B.getByRole('button', { name: 'Sign in' }).click();
  await B.getByText(/This account is paused/).waitFor();
  await A.getByText('What’s been done').waitFor();
  await shot(A, 'admin-log');

  if (errors.length) throw new Error('Errors in the page:\n' + errors.join('\n'));
  console.log('\nProduct walkthrough passed.');
} catch (e) {
  await A.screenshot({ path: join(SHOTS, 'product-fail-admin.png') }).catch(() => {});
  await B.screenshot({ path: join(SHOTS, 'product-fail-tutor2.png') }).catch(() => {});
  console.error('\nProduct walkthrough FAILED:', e.message);
  if (errors.length) console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  web.close();
  await srv.close();
  await claude.close();
}
