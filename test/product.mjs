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
async function expectValue(loc, re, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (re.test(await loc.inputValue().catch(() => ''))) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${re}`);
}
const watch = (page, label) => {
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|realtime|Failed to load resource|ERR_CONNECTION|net::|sb:\/\//i.test(m.text())) errors.push(`${label}: ${m.text()}`);
  });
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined) });
const A = await (await browser.newContext({ viewport: { width: 1400, height: 900 }, timezoneId: 'America/New_York' })).newPage();
const B = await (await browser.newContext({ viewport: { width: 1280, height: 820 }, timezoneId: 'Europe/London' })).newPage();
const ADM = await (await browser.newContext({ viewport: { width: 1300, height: 860 }, timezoneId: 'America/New_York' })).newPage();
watch(A, 'tutor');
watch(B, 'tutor2');
watch(ADM, 'admin');

async function signUpTutor(P, name, email) {
  await P.goto(web.url);
  await P.getByText('I’m a tutor').click();
  await P.getByLabel('Your name').fill(name);
  await P.getByLabel('Email').fill(email);
  await P.getByLabel('Password').fill('secret123');
  await P.getByRole('button', { name: 'Create account' }).click();
}

try {
  step('First tutor signs up (no server to set up); admin goes to its own account');
  await signUpTutor(A, 'Aaryan Chouhan', 'aaryan@example.com');
  await nav(A, 'Prof').waitFor();
  await nav(A, 'Admin').click();
  await A.getByRole('heading', { name: 'Admin has its own account now' }).waitFor();
  assert.equal(await A.getByLabel('Email for the admin account').inputValue(), 'aaryan+admin@example.com', 'filled in for you');
  await A.getByRole('button', { name: 'Make this the admin account' }).click();
  await A.getByText('aaryan+admin@example.com will be the admin account').waitFor();
  await shot(A, 'tutor-moves-admin');

  step('The admin account signs up with that email and opens Admin');
  await signUpTutor(ADM, 'Aaryan (admin)', 'aaryan+admin@example.com');
  await ADM.getByRole('heading', { name: /Set up as the StudyBridge admin/ }).waitFor();
  await ADM.getByRole('button', { name: 'Set up admin account' }).click();
  await nav(ADM, 'Tutors').waitFor();
  assert.equal(await nav(ADM, 'Learners').count(), 0, 'the admin account has no teaching screens');
  await A.reload();
  await nav(A, 'Learners').waitFor();
  assert.equal(await nav(A, 'Admin').count(), 0, 'the tutor account no longer has Admin');

  step('One sign-in page for everyone: the admin email opens Admin');
  await ADM.evaluate(() => localStorage.removeItem('sb.auth'));
  await ADM.goto(web.url);
  await ADM.getByRole('heading', { name: 'Sign in' }).waitFor();
  await ADM.getByLabel('Email').fill('aaryan+admin@example.com');
  await ADM.getByLabel('Password').fill('secret123');
  await ADM.getByRole('button', { name: 'Sign in' }).click();
  await nav(ADM, 'Tutors').waitFor();
  await shot(ADM, 'admin-home');

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
  await ADM.reload();
  await nav(ADM, 'Tutors').click();
  await ADM.getByRole('heading', { name: 'Waiting for approval' }).waitFor();
  await shot(ADM, 'admin-waiting');
  await ADM.getByRole('button', { name: 'Approve' }).click();
  await ADM.getByText('Maria Banda approved').waitFor();
  await B.getByRole('button', { name: 'Check again' }).click();
  await nav(B, 'Learners').waitFor();
  assert.equal(await nav(B, 'Admin').count(), 0, 'only the admin has Admin');

  step('Admin switches Prof on (Claude key, write-only) and checks the server');
  await nav(ADM, 'StudyBridge settings').click();
  await ADM.getByLabel('Claude API key').fill('sk-ant-test-key');
  await ADM.getByRole('button', { name: 'Save', exact: true }).click();
  await ADM.getByText('Prof settings saved').waitFor();
  await ADM.getByRole('button', { name: 'Check the Prof server' }).click();
  await ADM.getByText(/Prof server is working/).waitFor();
  assert.equal(await ADM.getByLabel('Claude API key').inputValue(), '');
  await shot(ADM, 'admin-console');

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

  step('Past papers: import a folder; papers are filed, paired and de-duplicated; nothing is uploaded');
  const pdfBytes = readFileSync(PDF);
  const variantOf = (tag) => Buffer.concat([pdfBytes, Buffer.from(`\n%${tag}\n`)]);
  const paperFiles = [
    { name: '0607_s23_qp_41.pdf', mimeType: 'application/pdf', buffer: variantOf('qp41') },
    { name: '0607_s23_ms_41.pdf', mimeType: 'application/pdf', buffer: variantOf('ms41') },
    { name: '0607_s23_qp_41 (1).pdf', mimeType: 'application/pdf', buffer: variantOf('qp41') },
    { name: '0580_w22_qp_22.pdf', mimeType: 'application/pdf', buffer: variantOf('qp22') },
    { name: 'November_2025_Math_AA_SL_Paper_1_for_IB.pdf', mimeType: 'application/pdf', buffer: variantOf('ibnov25') },
    { name: 'Mathematics_analysis_and_approaches_paper_1_TZ1_SL.pdf', mimeType: 'application/pdf', buffer: variantOf('ibtz1') },
    { name: 'chapter notes.pdf', mimeType: 'application/pdf', buffer: variantOf('notes') },
    { name: 'readme.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
  ];
  const storageBefore = (await tc.storage.from('library').list(`${me}/files`)).data?.length || 0;
  await nav(A, 'Library').click();
  await A.getByRole('button', { name: 'Past papers' }).click();
  // The tutor says which exam the subject is for, right there; Past papers then follows the learners
  await A.getByText('Which exam is each subject for?').waitFor();
  await shot(A, 'pastpapers-set-exam');
  await A.getByLabel('Exam for Mathematics').selectOption('cie:0607');
  // choosing in the list doesn't save on its own (a stray key press used to); Save does
  await A.getByText('Which exam is each subject for?').waitFor();
  await A.locator('.card.tint').getByRole('button', { name: 'Save' }).click();
  await A.locator('.pill.click', { hasText: '(Anaya)' }).waitFor();
  await A.getByText('Which exam is each subject for?').waitFor({ state: 'detached' });
  await nav(A, 'Subjects').click();
  await A.locator('.pill', { hasText: '(0607)' }).waitFor();
  await nav(A, 'Library').click();
  await A.getByRole('button', { name: 'Past papers' }).click();
  await A.locator('.pill.click', { hasText: '(Anaya)' }).waitFor();
  await A.getByText('For Anaya (Mathematics)').waitFor();
  await A.getByRole('button', { name: 'Import papers' }).click();
  const dlg = A.getByRole('dialog', { name: 'Import past papers' });
  await dlg.locator('input[type=file][accept]').setInputFiles(paperFiles);
  await dlg.getByRole('button', { name: /Import 5 papers/ }).waitFor({ timeout: 30000 });
  await dlg.getByText('Same file twice').waitFor();
  await dlg.getByText('Couldn’t tell which paper').waitFor();
  // Fix one that was read without its session: the tutor sets it
  await dlg.getByRole('button', { name: 'Fix Mathematics_analysis_and_approaches_paper_1_TZ1_SL.pdf' }).click();
  const fix = A.getByRole('dialog', { name: 'Which paper is this?' });
  await fix.getByLabel('Session').selectOption('may');
  await fix.getByLabel('Year').fill('2024');
  await fix.getByText('Files as: Mathematics: analysis and approaches SL May 2024 Paper 1 TZ1').waitFor();
  await fix.getByRole('button', { name: 'Use this' }).click();
  await dlg.getByText('Mathematics: analysis and approaches SL May 2024 Paper 1 TZ1').waitFor();
  await shot(A, 'papers-import');
  await dlg.getByRole('button', { name: /Import 5 papers/ }).click();
  await A.getByText('Imported 5 papers').waitFor({ timeout: 30000 });
  const papers = (await tc.from('files').select('*').not('exam_board', 'is', null)).data;
  assert.equal(papers.length, 5);
  assert.ok(papers.every((f) => f.cloud === false && f.storage_path.startsWith('local/') && f.sha256), 'kept on the computer, not uploaded');
  assert.equal((await tc.storage.from('library').list(`${me}/files`)).data?.length || 0, storageBefore, 'nothing uploaded');
  // the folder's subject is opened and pinned
  await A.locator('.papers-grid').waitFor();
  const chip41 = A.locator('.papers-grid tr', { hasText: 'June 2023' }).locator('.paper-chip', { hasText: '41' });
  assert.match(await chip41.getAttribute('class'), /mine/);
  assert.equal(await chip41.locator('.ms-dot').count(), 1, 'mark scheme paired');
  assert.match(await A.locator('.papers-grid tr', { hasText: 'June 2023' }).locator('.paper-chip', { hasText: '42' }).getAttribute('class'), /missing/);
  await shot(A, 'papers-grid');

  step('Open the paper: share it with the learner (uploaded only now); save a link for a missing one');
  await chip41.click();
  const panel = A.getByRole('dialog', { name: '0607 June 2023 Paper 41' });
  await panel.locator('.upper', { hasText: 'Mark scheme' }).waitFor();
  await panel.getByRole('button', { name: 'Turn into a test with Prof' }).waitFor();
  await shot(A, 'papers-slot');
  await panel.getByRole('button', { name: 'Share' }).first().click();
  const fs = A.getByRole('dialog', { name: 'File settings' });
  await fs.getByText('Visible now').click();
  await fs.getByRole('button', { name: 'Save' }).click();
  await fs.waitFor({ state: 'detached' });
  const shared = (await tc.from('files').select('*').eq('exam_kind', 'qp').eq('exam_paper', '41').single()).data;
  assert.equal(shared.cloud, true);
  assert.equal(shared.visibility, 'visible');
  assert.ok(!shared.storage_path.startsWith('local/'));
  assert.equal((await lc.from('files').select('id').eq('id', shared.id)).data.length, 1, 'the learner can open the shared paper');
  await panel.getByRole('button', { name: 'Close' }).click();
  await A.locator('.papers-grid tr', { hasText: 'June 2023' }).locator('.paper-chip', { hasText: '42' }).click();
  const p42 = A.getByRole('dialog', { name: '0607 June 2023 Paper 42' });
  await p42.getByRole('button', { name: 'Add my link' }).click();
  await A.getByLabel('Web address').fill('https://example.org/0607-42.pdf');
  await A.getByRole('button', { name: 'Save link' }).click();
  await A.getByRole('dialog', { name: 'Add your link' }).waitFor({ state: 'detached' });
  await p42.getByText('your link').waitFor();
  await p42.getByRole('button', { name: 'Close' }).click();
  assert.match(await A.locator('.papers-grid tr', { hasText: 'June 2023' }).locator('.paper-chip', { hasText: '42' }).getAttribute('class'), /link/);

  step('Find a paper by typing it');
  await A.getByLabel('Find a paper').fill('0580 November 2022 paper 2');
  await A.getByRole('button', { name: 'Find' }).click();
  await A.getByRole('dialog', { name: '0580 November 2022 Paper 2' }).getByText('0580 November 2022 Paper 22').waitFor();
  await A.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

  step('IB: papers filed by level and paper; private to the tutor; Prof can write one in the same style');
  await A.getByLabel('Subject').selectOption('ib:math-aa');
  const sl1 = A.locator('.ib-paper', { hasText: 'Paper 1' }).first();
  await sl1.locator('.paper-chip', { hasText: 'Nov 2025' }).waitFor();
  await sl1.locator('.paper-chip', { hasText: 'May 2024 TZ1' }).waitFor();
  await shot(A, 'papers-ib');
  await sl1.locator('.paper-chip', { hasText: 'Nov 2025' }).click();
  const ibp = A.getByRole('dialog', { name: 'Mathematics: analysis and approaches SL November 2025 Paper 1' });
  await ibp.getByText(/IB paper, private to you/).waitFor();
  await ibp.getByRole('button', { name: 'Prof: practice paper in this style' }).waitFor();
  await ibp.getByRole('button', { name: 'Close' }).click();

  step('Syllabus: Prof sets out 0607, the tutor uses it; coverage per learner');
  await A.getByRole('button', { name: 'Syllabus' }).click();
  await A.getByRole('heading', { name: 'Set up the syllabus for Mathematics' }).waitFor();
  assert.match(await A.getByLabel('Exam or syllabus').inputValue(), /0607/);
  await A.getByRole('button', { name: 'Set it up with Prof' }).click();
  await A.getByRole('heading', { name: /Prof’s syllabus for Mathematics: 5 topics/ }).waitFor({ timeout: 60000 });
  await shot(A, 'syllabus-proposal');
  await A.getByRole('button', { name: 'Use these topics' }).click();
  await A.locator('.syllabus-topic', { hasText: 'Coordinate geometry' }).waitFor();
  const geoRow = A.locator('table.coverage tr', { hasText: 'Geometry' }).filter({ hasNotText: 'Coordinate' });
  await geoRow.locator('.cov-cell').click();
  await A.getByRole('menu').waitFor();
  await shot(A, 'syllabus-coverage-menu');
  await A.getByRole('menuitem', { name: 'Getting there' }).click();
  await geoRow.locator('.cov-cell.developing.mine').waitFor();
  await geoRow.locator('.cov-cell').click();
  await A.getByRole('menuitem', { name: 'Taught' }).click();
  await geoRow.locator('.cov-cell.taught').waitFor();
  await geoRow.locator('.cov-cell').click();
  await A.getByRole('menuitem', { name: 'Let StudyBridge decide' }).click();
  await geoRow.locator('.cov-cell:not(.taught)').waitFor();
  await geoRow.locator('.cov-cell').click();
  await A.getByRole('menuitem', { name: 'Taught' }).click();
  await geoRow.locator('.cov-cell.taught').waitFor();
  await shot(A, 'syllabus-coverage');
  await A.getByRole('button', { name: 'Free textbooks' }).click();
  await A.getByText('Prealgebra 2e').waitFor();
  await A.getByRole('button', { name: 'My files' }).click();
  await A.getByText(/past papers? (is|are) filed under/).waitFor();

  step('Question bank: Prof writes questions, a second check flags a wrong one, the tutor approves the rest');
  await A.getByRole('button', { name: 'Question bank' }).click();
  await A.getByText('No questions yet').waitFor();
  await A.getByRole('button', { name: 'Ask Prof for questions' }).click();
  const ask = A.getByRole('dialog', { name: 'Ask Prof for bank questions' });
  await ask.getByLabel('Syllabus or subject').selectOption('cie:0607');
  await ask.getByRole('button', { name: 'Number', exact: true }).click();
  await ask.getByLabel('How many').fill('3');
  await ask.getByRole('button', { name: /Write 3 questions/ }).click();
  await A.getByText('Waiting for your approval').waitFor({ timeout: 60000 });
  await A.locator('.bank-q.flagged').waitFor();
  await shot(A, 'bank-review');
  await A.getByRole('button', { name: 'Approve 2 the check agreed with' }).click();
  await A.getByText('Approved 2').waitFor();
  await A.locator('.bank-q', { hasText: 'Work out' }).first().waitFor();
  assert.equal(await A.locator('.bank-q').count(), 2 + 1, 'two in the bank, the flagged one still waiting');
  await A.getByRole('button', { name: /Choose all 2/ }).click();
  await A.getByRole('button', { name: 'Make an assignment' }).click();
  await A.getByRole('dialog', { name: /Make an assignment from 2 questions/ }).getByRole('button', { name: 'Make it' }).click();
  await A.getByText('Assignment made').waitFor();
  await A.getByText('Number practice').first().waitFor();
  const made = (await tc.from('assignments').select('id,title,visibility').eq('title', 'Number practice').single()).data;
  assert.equal(made.visibility, 'hidden');
  assert.equal((await tc.from('questions').select('id').eq('assignment_id', made.id)).data.length, 2);
  await A.getByRole('button', { name: 'From the bank' }).click();
  const picker = A.getByRole('dialog', { name: 'Add questions from the bank' });
  await picker.getByRole('button', { name: /Choose all 2/ }).click();
  await picker.getByRole('button', { name: /Add 2/ }).click();
  await A.getByText('Added 2 questions from the bank').waitFor();
  await shot(A, 'bank-in-editor');

  step('Practice: the tutor gives the learner bank questions; she practises on her phone and it marks itself');
  await nav(A, 'Library').click();
  await A.getByRole('button', { name: 'Question bank' }).click();
  await A.getByRole('button', { name: 'Set practice for a learner' }).click();
  const pb = A.getByRole('dialog', { name: 'Set practice for a learner' });
  await pb.getByRole('button', { name: /Give 2 questions to Anaya/ }).click();
  await A.getByText('Practice set for Anaya').waitFor();
  const prac = (await tc.from('assignments').select('*').eq('practice', true).single()).data;
  assert.equal(prac.visibility, 'visible');
  assert.deepEqual(prac.learner_ids.length, 1);
  const C = await (await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true })).newPage();
  watch(C, 'learner');
  await C.goto(web.url);
  await C.evaluate(() => localStorage.setItem('sb.seen', '1'));
  await C.reload();
  await C.getByText(/already have an account|Sign in/).first().click().catch(() => {});
  await C.getByLabel('Email').fill('anaya@example.com');
  await C.getByLabel('Password').fill('secret123');
  await C.getByRole('button', { name: 'Sign in' }).click();
  await C.getByText('New practice from your tutor').click();
  await C.getByText(/Extra practice from your tutor/).waitFor();
  await shot(C, 'learner-practice');
  await C.locator('.work-card', { hasText: 'Practice' }).first().click();
  await C.getByRole('button', { name: 'Start', exact: true }).click();
  const inputs = C.getByLabel('Your answer');
  await inputs.first().waitFor();
  const prompts = await tc.from('questions').select('prompt_md,position').eq('assignment_id', prac.id).order('position');
  const nums = prompts.data.map((p) => Number(p.prompt_md.match(/\$(\d+) /)[1]) * 7);
  for (let i = 0; i < nums.length; i++) await inputs.nth(i).fill(String(nums[i]));
  await C.getByRole('button', { name: 'Hand in', exact: true }).first().click();
  await C.getByRole('dialog', { name: 'Hand in now?' }).getByRole('button', { name: 'Hand in' }).click();
  await C.getByText('2 / 2 · 100%').waitFor({ timeout: 20000 });
  await C.getByRole('button', { name: 'Practise again' }).waitFor();
  await shot(C, 'learner-practice-marked');
  const tries = (await tc.from('attempts').select('status,score').eq('assignment_id', prac.id)).data;
  assert.equal(tries[0].status, 'marked');
  assert.equal(Number(tries[0].score), 2);

  step('Study: Prof writes flashcards, the tutor picks; the learner reviews them, takes the daily quiz, writes a formula sheet');
  await nav(A, 'Library').click();
  await A.getByRole('button', { name: 'Flashcards' }).click();
  await A.getByLabel('Topic').fill('Algebra');
  await A.getByRole('button', { name: 'Write them' }).click();
  await A.getByRole('button', { name: /Add 12 cards/ }).waitFor({ timeout: 60000 });
  await A.locator('.card-tile.pick input').first().uncheck();
  await A.getByRole('button', { name: /Add 11 cards/ }).click();
  await A.getByText('11 cards added. Learners see them in Study.').waitFor();
  await shot(A, 'tutor-flashcards');
  await C.goto(web.url + '#/study');
  await C.getByRole('heading', { name: 'Flashcards' }).waitFor();
  await C.getByRole('button', { name: /Start \(11\)/ }).click();
  await C.locator('.flashcard').click();
  await C.locator('.flashcard .face.back').waitFor();
  await shot(C, 'learner-flashcard');
  await C.getByRole('button', { name: 'Good' }).click();
  await C.locator('.flashcard .face.back').waitFor({ state: 'detached' });
  await C.locator('.flashcard').click();
  await C.getByRole('button', { name: 'Again' }).click();
  await C.getByRole('button', { name: 'Stop' }).click();
  await C.getByRole('button', { name: 'Daily quiz (5 questions)' }).waitFor();
  const reviews = (await lc.from('card_reviews').select('*')).data;
  assert.equal(reviews.length, 2);
  await C.getByLabel('Formula sheet').fill('Area of a circle: $\\pi r^2$');
  await C.getByRole('button', { name: 'Save', exact: true }).click();
  await C.getByText('Formula sheet saved').waitFor();
  await shot(C, 'learner-study');
  await C.getByRole('button', { name: 'Daily quiz (5 questions)' }).click();
  await C.getByRole('button', { name: 'Start', exact: true }).waitFor();
  assert.equal((await tc.from('assignments').select('id').eq('source', 'self')).data.length, 1);
  await nav(A, 'Assignments').click();
  await A.getByRole('heading', { name: 'Assignments' }).waitFor();
  assert.equal(await A.getByText(/Daily quiz ·/).count(), 0, 'her own practice isn’t in the tutor’s list');
  await A.goto(web.url + `#/learners/${(await lc.auth.getUser()).data.user.id}/study`);
  await A.getByText('Area of a circle').waitFor();
  await shot(A, 'tutor-learner-study');

  step('Weekly parent report: StudyBridge fills it in; the learner switches WhatsApp on; Prof only suggests a comment; the tutor approves');
  await nav(A, 'Reports').click();
  await A.locator('.report-row', { hasText: 'Anaya' }).getByRole('button', { name: 'View report' }).click();
  const early = A.getByRole('dialog', { name: 'Anaya’s report' });
  await early.getByText('This week so far, as of now').waitFor();
  await early.locator('.report-card', { hasText: 'Anaya' }).waitFor();
  await early.getByText(/has no parent linked yet/).waitFor();
  assert.equal(await early.getByRole('button', { name: /Approve/ }).count(), 0, 'nothing can go until there is a parent');
  await early.getByRole('button', { name: 'Close' }).click();
  await A.locator('.report-row', { hasText: 'Anaya' }).getByRole('button', { name: /^Ask Anaya/ }).click();
  await A.getByText('Asked Anaya').waitFor();
  await C.goto(web.url + '#/settings');
  await C.getByText('Send my parent a weekly report').click();
  await C.getByLabel('Their name').fill('Mum');
  await C.getByLabel('WhatsApp number').fill('+260 97 123 4567');
  await C.locator('#set-reports').getByRole('button', { name: 'Save', exact: true }).click();
  await C.getByText('Weekly reports are on').waitFor();
  await A.reload();
  await nav(A, 'Reports').click();
  await A.getByText(/Mum by WhatsApp/).waitFor();
  await A.locator('.report-row', { hasText: 'Anaya' }).getByRole('button', { name: 'View report' }).click();
  const rep = A.getByRole('dialog', { name: 'Anaya’s report' });
  await rep.getByRole('button', { name: 'Prof, suggest a comment' }).click();
  await expectValue(rep.getByLabel('Your comment to the parent (optional)'), /She worked hard/);
  await rep.locator('.report-card', { hasText: 'Work this week' }).waitFor();
  await shot(A, 'parent-report');
  await A.context().route(/wa\.me|whatsapp\.com/, (r) => r.fulfill({ contentType: 'text/html', body: '<p>WhatsApp</p>' }));
  const [wa] = await Promise.all([A.waitForEvent('popup'), rep.getByRole('button', { name: 'Approve and send on WhatsApp' }).click()]);
  assert.match(wa.url(), /^https:\/\/(wa\.me|api\.whatsapp\.com)\/.*260971234567/);
  assert.match(decodeURIComponent(wa.url()), /Weekly report: Anaya/);
  assert.match(decodeURIComponent(wa.url()), /She worked hard/);
  await wa.close();
  await A.locator('.toast .t', { hasText: 'Approved' }).waitFor();
  const sentRep = (await tc.from('parent_reports').select('*').eq('status', 'sent').single()).data;
  assert.equal(sentRep.sent_via, 'whatsapp');
  assert.match(sentRep.comment, /She worked hard/);
  await C.reload();
  await C.getByText('Reports sent so far (1)').click();
  await C.locator('.report-card', { hasText: 'She worked hard' }).waitFor();

  step('Parent account: the tutor makes a parent invite; Dad joins and sees the approved report, read-only; Anaya sees him');
  const anayaId = (await lc.auth.getUser()).data.user.id;
  await A.goto(web.url + `#/learners/${anayaId}/parents`);
  await A.getByLabel('Parent’s name').fill('Dad');
  await A.getByRole('button', { name: 'Make an invite' }).click();
  const pinv = A.getByRole('dialog', { name: 'Parent invite for Anaya' });
  const ptoken = ((await pinv.locator('pre').textContent()).match(/SB1-[A-Za-z0-9_-]+/) || [])[0];
  assert.ok(ptoken, 'the invite message has the parent invite');
  await pinv.getByRole('button', { name: 'Close' }).click();
  const P = await (await browser.newContext({ viewport: { width: 1200, height: 860 }, timezoneId: 'Africa/Lusaka' })).newPage();
  watch(P, 'parent');
  await P.goto(web.url);
  await P.getByText('I’m a parent').click();
  await P.getByLabel('Your parent invite').fill(ptoken);
  await P.getByRole('button', { name: 'Next' }).click();
  await P.getByLabel('Your name').fill('Dad');
  await P.getByLabel('Email').fill('dad@example.com');
  await P.getByLabel('Password').fill('secret123');
  await P.getByRole('button', { name: 'Create account' }).click();
  await P.getByRole('heading', { name: 'Anaya', level: 1 }).waitFor();
  await P.locator('.report-card', { hasText: 'She worked hard' }).waitFor();
  assert.equal(await nav(P, 'Messages').count(), 0, 'parents can’t message');
  assert.equal(await nav(P, 'Prof').count(), 0);
  await shot(P, 'parent-home', true);
  await C.goto(web.url + '#/settings');
  await C.reload();
  await C.getByText('Parents who can see your progress').waitFor();
  await C.locator('#set-parents').getByText('Dad').waitFor();
  await A.reload();
  await nav(A, 'Reports').click();
  await A.locator('.report-row', { hasText: 'Anaya' }).getByText(/1 parent account/).waitFor();
  await P.close();
  await C.close();

  step('Admin adds shared StudyBridge questions; every tutor gets them once approved');
  await nav(ADM, 'StudyBridge questions').click();
  await ADM.getByRole('heading', { name: 'StudyBridge questions' }).waitFor();
  await ADM.getByRole('button', { name: 'Ask Prof for shared questions' }).click();
  const sh = ADM.getByRole('dialog', { name: 'Add shared StudyBridge questions' });
  await sh.getByRole('button', { name: 'Algebra', exact: true }).click();
  await sh.getByLabel('How many').fill('3');
  await sh.getByRole('button', { name: /Write 3 questions/ }).click();
  await ADM.getByText('Shared questions to review').waitFor({ timeout: 60000 });
  await shot(ADM, 'admin-shared-bank');
  await ADM.getByRole('button', { name: 'Approve 2 the check agreed with' }).click();
  await ADM.getByText('0607 · Algebra: 2').waitFor();
  await nav(B, 'Library').click();
  await B.getByRole('button', { name: 'Question bank' }).click();
  await B.locator('.bank-q', { hasText: 'StudyBridge' }).first().waitFor();
  assert.equal(await B.locator('.bank-q').count(), 2, 'the other tutor sees only the approved shared questions');

  step('Admin pauses the other tutor: she can’t sign in, nothing is deleted');
  await nav(ADM, 'Tutors').click();
  await ADM.locator('.tutor-row', { hasText: 'Maria Banda' }).getByRole('button', { name: 'Pause' }).click();
  await ADM.getByRole('dialog').getByRole('button', { name: 'Pause' }).click();
  await ADM.getByText('Maria Banda paused', { exact: true }).waitFor();
  await B.reload();
  await B.getByText('Your account is paused').waitFor();
  await B.getByRole('button', { name: 'Sign out' }).click();
  await B.getByText('I already have an account: sign in').click().catch(() => {});
  await B.getByLabel('Email').fill('maria@example.com');
  await B.getByLabel('Password').fill('secret123');
  await B.getByRole('button', { name: 'Sign in' }).click();
  await B.getByText(/This account is paused/).waitFor();
  await nav(ADM, 'What’s been done').click();
  await ADM.locator('.item', { hasText: 'maria@example.com' }).filter({ hasText: 'Paused' }).waitFor();
  await shot(ADM, 'admin-log');

  step('StudyBridge papers: Prof works out 0607’s papers, writes one in the background, admin approves; the tutor copies it into a test');
  await nav(ADM, 'StudyBridge papers').click();
  await ADM.getByRole('button', { name: 'Clear' }).click();
  await ADM.locator('.subject-picks .pick', { hasText: '0607 Mathematics – International' }).locator('input').check();
  await ADM.getByRole('button', { name: 'Work out their papers' }).click();
  await ADM.getByRole('cell', { name: 'Paper 4 (Extended)' }).waitFor({ timeout: 60000 });
  await ADM.getByLabel('How many for 0607 Paper 2 (Core)').selectOption('1');
  await ADM.getByLabel('How many for 0607 Paper 4 (Extended)').selectOption('0');
  await ADM.getByRole('button', { name: 'Write 1 paper' }).click();
  await ADM.getByRole('dialog').getByRole('button', { name: 'Start writing' }).click();
  const sbRow = ADM.locator('.item', { hasText: 'SB 1' }).filter({ hasText: 'check flagged 1' });
  await sbRow.waitFor({ timeout: 90000 });
  await shot(ADM, 'admin-papers');
  await sbRow.getByRole('button', { name: 'Open' }).click();
  await ADM.getByText(/The automatic check flagged 1/).waitFor();
  await ADM.getByRole('button', { name: 'Fix this part' }).click();
  await ADM.getByLabel('Correct answer').fill('21');
  await ADM.getByRole('button', { name: 'Save fix' }).click();
  await ADM.getByText('Fixed', { exact: true }).waitFor();
  await ADM.getByText(/The automatic check flagged/).waitFor({ state: 'detached' });
  await shot(ADM, 'admin-paper-review');
  await ADM.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await ADM.getByText('Approved: every tutor sees it now').waitFor();
  await nav(A, 'Library').click();
  await A.getByRole('button', { name: 'Past papers' }).click();
  await A.locator('.sb-shelf .paper-chip', { hasText: 'SB 1' }).click();
  await A.getByRole('dialog').getByText('written by StudyBridge in this paper’s format').waitFor();
  await A.getByRole('dialog').getByRole('button', { name: 'Use with my learners' }).click();
  await A.getByText('A StudyBridge practice paper, copied for you').waitFor();
  await shot(A, 'tutor-sb-paper-copied');
  const copied = (await tc.from('assignments').select('*').eq('source', 'studybridge').single()).data;
  assert.equal(copied.draft, true);
  assert.equal((await tc.from('questions').select('id').eq('assignment_id', copied.id)).data.length, 8);

  step('Admin overview, a tutor’s message and the reply, an announcement, a crash report');
  await nav(A, 'Learners').waitFor();
  await A.goto(web.url + '#/settings?s=contact');
  await A.getByLabel('Your message').fill('Could learners get flashcards?');
  await A.getByRole('button', { name: 'Idea' }).click();
  await A.getByRole('button', { name: 'Send', exact: true }).click();
  await A.getByText('Waiting for a reply').waitFor();
  await nav(ADM, 'Inbox').click();
  await ADM.getByText('Could learners get flashcards?').waitFor();
  await ADM.getByPlaceholder('Your reply (optional)').fill('Yes, they are coming in 1.4.');
  await ADM.getByRole('button', { name: 'Send reply' }).click();
  await ADM.getByText('Reply sent').waitFor();
  await A.reload();
  await A.getByText('StudyBridge:').waitFor();
  await nav(ADM, 'Announcements').click();
  await ADM.getByLabel('Title').fill('New update tonight');
  await ADM.getByRole('button', { name: 'Post announcement' }).click();
  await ADM.getByText('Announcement is live').waitFor();
  await A.reload();
  await A.locator('.announce', { hasText: 'New update tonight' }).waitFor();
  await shot(A, 'tutor-announcement');
  await A.locator('.announce').getByRole('button', { name: 'Close' }).click();
  await A.locator('.announce').waitFor({ state: 'detached' });
  await tc.rpc('report_error', { p_message: 'TypeError: cannot read things of undefined', p_stack: 'at Thing (index-abcdefgh.js:1:2)', p_screen: '#/library', p_version: '1.1.99', p_platform: 'desktop Windows' });
  await nav(ADM, 'Problems').click();
  await ADM.getByText('TypeError: cannot read things of undefined').waitFor();
  await shot(ADM, 'admin-problems');
  await nav(ADM, 'Overview').click();
  await ADM.getByRole('heading', { name: 'System health' }).waitFor();
  await shot(ADM, 'admin-overview');
  // Prof: spending, who used it, and the Claude credit counting down
  await nav(ADM, 'Prof').click();
  await ADM.getByRole('heading', { name: 'Claude credit' }).waitFor();
  await ADM.getByRole('heading', { name: 'Who used it this month' }).waitFor();
  await ADM.locator('table', { hasText: 'Aaryan Chouhan' }).waitFor();
  await ADM.getByLabel('Credit on your Claude key now ($)').fill('25.40');
  await ADM.getByRole('button', { name: 'Save', exact: true }).click();
  await ADM.getByText(/You entered \$25\.40/).waitFor();
  await shot(ADM, 'admin-prof');
  await nav(ADM, 'Overview').click();
  await ADM.locator('.stat', { hasText: 'Prof credit left' }).getByText('$25.40').waitFor();
  await nav(ADM, 'Tutors').click();
  await ADM.locator('.tutor-row a', { hasText: 'Aaryan Chouhan' }).click();
  await ADM.getByRole('heading', { name: 'Your notes' }).waitFor();
  await shot(ADM, 'admin-tutor');

  if (errors.length) throw new Error('Errors in the page:\n' + errors.join('\n'));
  console.log('\nProduct walkthrough passed.');
} catch (e) {
  await A.screenshot({ path: join(SHOTS, 'product-fail-tutor.png') }).catch(() => {});
  await ADM.screenshot({ path: join(SHOTS, 'product-fail-admin.png') }).catch(() => {});
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
