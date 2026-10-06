// End-to-end walkthrough of StudyBridge in real browsers, against the real
// database rules (fake Supabase server running supabase/setup.sql in PGlite).
// Tutor and learner use separate browsers; screenshots go to $SHOTS.
//   npm run build && node test/walkthrough.mjs
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright';
import { startFakeSupabase } from './fake-supabase.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const SHOTS = process.env.SHOTS || join(ROOT, 'test', 'screenshots');
mkdirSync(SHOTS, { recursive: true });
const PDF = join(ROOT, 'test', 'fixtures', 'algebra-chapter-3.pdf');

function serveDist() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const f = join(ROOT, 'dist', p);
    if (!f.startsWith(join(ROOT, 'dist')) || !existsSync(f) || statSync(f).isDirectory()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': types[extname(f)] || 'application/octet-stream' });
    res.end(readFileSync(f));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}/`, close: () => srv.close() })));
}

const step = (n) => console.log('•', n);
const nav = (page, name) => page.locator('aside.side').getByRole('link', { name, exact: false }).filter({ hasText: new RegExp('^' + name) }).first();
let shotN = 0;
async function shot(page, name, full = false) {
  shotN++;
  await page.waitForTimeout(350);
  const file = join(SHOTS, `${String(shotN).padStart(2, '0')}-${name}.png`);
  if (!full) return page.screenshot({ path: file });
  // The app scrolls inside .content, so grow the window to fit it for a full-length picture
  const vp = page.viewportSize();
  const h = await page.evaluate(() => {
    const c = document.querySelector('.content');
    return c ? c.scrollHeight + (window.innerHeight - c.clientHeight) : document.body.scrollHeight;
  });
  await page.setViewportSize({ width: vp.width, height: Math.min(Math.max(h, vp.height), 6000) });
  await page.waitForTimeout(400);
  await page.screenshot({ path: file });
  await page.setViewportSize(vp);
}

function watchErrors(page, label) {
  const errs = [];
  page.on('pageerror', (e) => errs.push(`${label}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|realtime|Failed to load resource|ERR_CONNECTION|net::|sb:\/\//i.test(m.text())) errs.push(`${label}: ${m.text()}`);
  });
  return errs;
}

const srv = await startFakeSupabase();
const web = await serveDist();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined), args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const tutorCtx = await browser.newContext({ viewport: { width: 1400, height: 900 }, timezoneId: 'America/New_York' });
const learnerCtx = await browser.newContext({ viewport: { width: 1280, height: 820 }, timezoneId: 'Africa/Lusaka', permissions: ['camera'] });
const T = await tutorCtx.newPage();
const L = await learnerCtx.newPage();
const errors = [...watchErrors(T, 'tutor'), ...watchErrors(L, 'learner')];
const errT = watchErrors(T, 'tutor');
const errL = watchErrors(L, 'learner');

try {
  // ---------------- tutor sets up ----------------
  step('Tutor connects their Supabase project and creates an account');
  await T.goto(web.url);
  await shot(T, 'welcome');
  await T.getByText('I’m a tutor').click();
  await T.getByLabel('Project URL').fill(srv.url);
  await T.getByLabel(/Anon \/ publishable key/).fill(srv.anonKey);
  await shot(T, 'tutor-server-setup', true);
  await T.getByRole('button', { name: 'Connect' }).click();
  await T.getByLabel('Your name').fill('Aaryan');
  await T.getByLabel('Email').fill('aaryan@example.com');
  await T.getByLabel('Password').fill('secret123');
  await T.getByRole('button', { name: 'Create account' }).click();
  await T.getByText(/Good (morning|afternoon|evening), Aaryan/).waitFor();
  await shot(T, 'tutor-home-empty');

  step('Programmes, subjects and topics');
  await nav(T, 'Subjects').click();
  await T.getByRole('button', { name: 'Programme' }).first().click();
  await T.getByLabel('Name').fill('IGCSE');
  await T.getByLabel('Description (optional)').fill('Cambridge IGCSE, exams in 2028');
  await T.getByRole('button', { name: 'Save' }).click();
  await T.getByRole('button', { name: /^Subject$/ }).first().click();
  await T.getByLabel('Name').fill('Mathematics (Extended)');
  await T.getByLabel(/Topics/).fill('Number\nAlgebra\nGeometry\nStatistics');
  await T.getByRole('button', { name: 'Save' }).click();
  await T.getByText('Mathematics (Extended)').waitFor();
  await T.getByRole('button', { name: /^Subject$/ }).first().click();
  await T.getByLabel('Name').fill('Physics');
  await T.getByLabel(/Topics/).fill('Forces, Energy, Waves');
  await T.getByRole('button', { name: 'Save' }).click();
  await T.getByText('Waves').waitFor();
  await shot(T, 'tutor-subjects');

  step('Invite a learner');
  await nav(T, 'Learners').click();
  await T.getByRole('button', { name: 'Invite a learner' }).first().click();
  await T.getByLabel('Learner’s name').fill('Anaya');
  await T.getByText('Mathematics (Extended)').last().click();
  await T.getByText('Physics').last().click();
  await T.getByRole('button', { name: 'Create invite' }).click();
  await T.getByText(/Join me on StudyBridge/).waitFor();
  await shot(T, 'tutor-invite');
  const inviteText = await T.locator('.code-box').first().innerText();
  const invite = inviteText.match(/SB1[.-][A-Za-z0-9_-]+/)[0];
  await T.keyboard.press('Escape');

  // ---------------- learner joins ----------------
  step('Learner pastes the invite and creates an account');
  await L.goto(web.url);
  await L.getByText('I’m a learner').click();
  await L.getByLabel('Your invite').fill(inviteText);
  await shot(L, 'learner-invite');
  await L.getByRole('button', { name: 'Next' }).click();
  await L.getByLabel('Your name').fill('Anaya');
  await L.getByLabel('Email').fill('anaya@example.com');
  await L.getByLabel('Password').fill('secret123');
  await L.getByRole('button', { name: 'Create account' }).click();
  await L.getByText(/, Anaya!/).waitFor();
  await shot(L, 'learner-today-empty');
  assert.ok(invite.length > 20);

  // Tutor gets a "joined" notification
  await T.reload();
  await T.getByText('Anaya').first().waitFor();

  // ---------------- library ----------------
  step('Tutor uploads a PDF, hidden first, then makes it visible');
  await nav(T, 'Library').click();
  await T.locator('input[type=file]').setInputFiles(PDF);
  await T.getByText('File settings').waitFor();
  await T.getByLabel('Subject').selectOption({ label: 'Mathematics (Extended)' });
  await T.getByLabel('Topic').selectOption({ label: 'Algebra' });
  await T.getByLabel(/Note for learners/).fill('Read 3.1 before the homework');
  await shot(T, 'tutor-file-settings');
  await T.getByRole('button', { name: 'Save' }).click();
  await T.getByText('algebra-chapter-3.pdf').waitFor();
  await shot(T, 'tutor-library-hidden');
  // learner can't see it yet
  await nav(L, 'Library').click();
  await L.getByRole('button', { name: /Books & files/ }).click();
  await L.getByText('No files yet.').waitFor();
  // make visible
  await T.locator('table').getByRole('button', { name: 'Settings' }).first().click();
  await T.getByRole('button', { name: 'Visible now' }).click();
  await T.getByRole('button', { name: 'Save' }).click();
  await T.getByText('Visible', { exact: true }).first().waitFor();
  await L.reload();
  await L.getByRole('button', { name: /Books & files/ }).click();
  await L.getByText('algebra-chapter-3.pdf').click();
  await L.locator('canvas[aria-label="Page 1"]').waitFor();
  await L.waitForTimeout(800);
  // The text on the page really drew (PDFs that rely on standard fonts need pdf.js's font files)
  const ink = await L.evaluate(() => {
    const c = document.querySelector('canvas[aria-label="Page 1"]');
    const d = c.getContext('2d').getImageData(0, 0, c.width, Math.min(c.height, 400)).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 100 && d[i + 1] < 100 && d[i + 2] < 100) n++;
    return n;
  });
  assert.ok(ink > 500, `PDF text is visible (${ink} dark pixels)`);
  await shot(L, 'learner-pdf-viewer');

  // ---------------- lesson ----------------
  step('Tutor writes a lesson with maths');
  await T.getByRole('button', { name: 'Lesson notes' }).click();
  await T.getByRole('button', { name: 'New lesson notes' }).first().click();
  await T.getByLabel('Title').fill('Solving linear equations');
  await T.locator('textarea').first().fill('## The idea\nDo the **same thing to both sides**.\n\n## Worked example\nSolve $2x + 3 = 11$.\n\n$$2x = 8 \\Rightarrow x = 4$$\n\n- Subtract 3\n- Divide by 2');
  await T.getByRole('combobox').nth(0).selectOption({ label: 'Mathematics (Extended)' });
  await T.getByRole('button', { name: 'Preview' }).click();
  await shot(T, 'tutor-lesson-editor');
  await T.getByRole('button', { name: 'Post' }).click();
  await T.getByText('Posted: Solving linear equations').waitFor();

  // ---------------- assignment ----------------
  step('Tutor builds homework with every kind of question');
  await nav(T, 'Assignments').click();
  await T.getByRole('button', { name: 'New assignment' }).first().click();
  await T.getByLabel('Title').fill('Linear equations 1');
  await T.getByLabel('Subject').selectOption({ label: 'Mathematics (Extended)' });
  await T.getByRole('button', { name: 'Create' }).click();
  await T.getByText('No questions yet').waitFor();
  await T.getByPlaceholder(/What should the learner do/).fill('Show all your working. The textbook is attached if you get stuck.');
  // Q1 multiple choice
  await T.getByRole('button', { name: /Multiple choice/ }).click();
  await T.getByLabel('Question 1', { exact: true }).fill('Which value of $x$ solves $x + 5 = 9$?');
  const opts = T.locator('.qcard').nth(0).getByPlaceholder(/Option/);
  await opts.nth(0).fill('3');
  await opts.nth(1).fill('4');
  await opts.nth(2).fill('5');
  await opts.nth(3).fill('14');
  await T.getByLabel('Option B is correct').check();
  // Q2 number
  await T.getByRole('button', { name: /Number answer/ }).click();
  await T.getByLabel('Question 2', { exact: true }).fill('Solve $4x = 50$. Give $x$ as a decimal.');
  await T.locator('.qcard').nth(1).getByPlaceholder('e.g. 12.5').fill('12.5');
  // Q3 steps
  await T.getByRole('button', { name: /Maths with working/ }).click();
  await T.getByLabel('Question 3', { exact: true }).fill('Solve $3x - 1 = 11$, showing each step.');
  await T.locator('.qcard').nth(2).getByLabel('Worked solution').fill('$3x - 1 = 11 \\Rightarrow 3x = 12 \\Rightarrow x = 4$');
  // Q4 written
  await T.getByRole('button', { name: /Written answer/ }).click();
  await T.getByLabel('Question 4', { exact: true }).fill('Explain in one sentence why we do the same thing to both sides.');
  // Q5 drawing
  await T.getByRole('button', { name: /Drawing/ }).click();
  await T.getByLabel('Question 5', { exact: true }).fill('Draw the line $y = 2x + 1$ for $0 \\le x \\le 3$.');
  // Q6 photo
  await T.getByRole('button', { name: /Photo of work/ }).click();
  await T.getByLabel('Question 6', { exact: true }).fill('Solve Practice Q2 on paper and upload a photo.');
  // Settings
  await T.getByLabel('Due').fill('2030-01-10T17:00');
  await T.getByLabel('Topic', { exact: true }).last().selectOption({ label: 'Algebra' });
  await T.getByText('algebra-chapter-3.pdf').last().click();
  await T.getByText(/Goes to: Anaya/).waitFor();
  await shot(T, 'tutor-assignment-editor', true);
  // Post publishes it and goes back to the list
  await T.getByRole('button', { name: 'Post', exact: true }).click();
  await T.getByText('Posted: Linear equations 1').waitFor();
  await T.getByRole('heading', { name: 'Assignments' }).waitFor();
  await shot(T, 'tutor-assignment-posted');

  // ---------------- learner does it ----------------
  step('Learner opens the homework, answers every question');
  await nav(L, 'Today').click();
  await L.reload();
  await shot(L, 'learner-today');
  await L.getByRole('button', { name: /Let’s start/ }).click();
  await shot(L, 'learner-work-detail');
  await L.getByRole('button', { name: 'Start', exact: true }).click();
  await L.getByText('Which value of').waitFor();
  await L.locator('.qcard').nth(0).locator('label.opt').nth(1).click();
  await L.getByLabel('Your answer').first().fill('12.5');
  // steps: type into MathLive fields, one line per step
  const s1 = L.locator('.qcard').nth(2).locator('math-field').first();
  await s1.scrollIntoViewIfNeeded();
  const mb = await s1.boundingBox();
  await L.mouse.click(mb.x + 30, mb.y + mb.height / 2);
  await L.waitForTimeout(300);
  await L.keyboard.type('3x-1=11', { delay: 40 });
  await L.keyboard.press('Enter');
  await L.waitForTimeout(200);
  await L.keyboard.type('3x=12', { delay: 40 });
  await L.keyboard.press('Enter');
  await L.waitForTimeout(200);
  await L.keyboard.type('x=4', { delay: 40 });
  await L.getByPlaceholder(/Write your answer/).fill('Because an equation is a balance: changing both sides equally keeps it true.');
  // drawing
  const pad = L.locator('.pad canvas').first();
  await pad.scrollIntoViewIfNeeded();
  const box = await pad.boundingBox();
  await L.mouse.move(box.x + 40, box.y + box.height - 40);
  await L.mouse.down();
  for (let i = 1; i <= 12; i++) await L.mouse.move(box.x + 40 + i * 25, box.y + box.height - 40 - i * 16);
  await L.mouse.up();
  // photo
  await L.locator('.qcard').nth(5).locator('input[type=file]').setInputFiles({ name: 'working.png', mimeType: 'image/png', buffer: readFileSync(join(ROOT, 'build', 'icon.png')) });
  await L.locator('.qcard').nth(5).locator('.thumb img').waitFor();
  // work it out on the whiteboard as well
  await L.locator('.qcard').nth(2).getByRole('button', { name: 'Use the whiteboard' }).click();
  const wb = L.locator('.workboard canvas');
  await wb.waitFor();
  const wbb = await wb.boundingBox();
  await L.mouse.move(wbb.x + 80, wbb.y + 120);
  await L.mouse.down();
  for (let i = 1; i <= 20; i++) await L.mouse.move(wbb.x + 80 + i * 18, wbb.y + 120 + Math.sin(i / 2) * 40);
  await L.mouse.up();
  await shot(L, 'learner-whiteboard');
  await L.getByRole('button', { name: 'Add to my answer' }).click();
  await L.locator('.qcard').nth(2).locator('.thumb img').waitFor();
  // a note to the tutor
  await L.locator('.qcard').nth(2).getByText('Leave a note for your tutor').click();
  await L.locator('.qcard').nth(2).getByPlaceholder('Leave a note for your tutor…').fill('Is it OK to divide straight away?');
  await L.locator('.qcard').nth(2).getByRole('button', { name: 'Send' }).click();
  await L.getByText('All saved').waitFor();
  await shot(L, 'learner-attempt', true);
  await L.getByRole('button', { name: 'Resources' }).click();
  await L.locator('canvas[aria-label="Page 1"]').waitFor();
  await shot(L, 'learner-attempt-with-textbook');
  await L.getByRole('button', { name: 'Hand in' }).first().click();
  await shot(L, 'learner-hand-in-confirm');
  await L.getByRole('dialog').getByRole('button', { name: 'Hand in' }).click();
  await L.getByText(/Handed in\. Well done/).waitFor();
  await shot(L, 'learner-handed-in');

  // ---------------- tutor marks ----------------
  step('Tutor sees the note + submission and marks it');
  await nav(T, 'Home').click();
  await T.reload();
  await T.getByText('Is it OK to divide straight away?').first().waitFor();
  await shot(T, 'tutor-home-with-work');
  await nav(T, 'Marking').click();
  await T.getByText('Linear equations 1').first().click();
  await T.getByText('follows').first().waitFor({ timeout: 20000 });
  await shot(T, 'tutor-marking', true);
  // step ticks + marks
  const q3 = T.locator('.qcard').nth(2);
  await q3.getByLabel('Step 1 correct').click();
  await q3.getByLabel('Step 2 correct').click();
  await q3.getByLabel('Step 3 correct').click();
  await q3.getByRole('button', { name: /Full/ }).click();
  const q4 = T.locator('.qcard').nth(3);
  await q4.getByRole('button', { name: /Full/ }).click();
  const q5 = T.locator('.qcard').nth(4);
  await q5.getByLabel('Mark for question 5').fill('2');
  await q5.getByPlaceholder(/What was wrong/).fill('The line should pass through $(0, 1)$. Check your intercept.');
  await q5.getByPlaceholder(/Sign error/).fill('Wrong y-intercept');
  const q6 = T.locator('.qcard').nth(5);
  await q6.getByRole('button', { name: /Mark on it/ }).click();
  const apad = T.getByRole('dialog').locator('canvas');
  await apad.waitFor();
  const ab = await apad.boundingBox();
  await T.mouse.move(ab.x + 30, ab.y + 60);
  await T.mouse.down();
  await T.mouse.move(ab.x + 60, ab.y + 90);
  await T.mouse.move(ab.x + 120, ab.y + 20);
  await T.mouse.up();
  await shot(T, 'tutor-annotate');
  await T.getByRole('button', { name: 'Save marked copy' }).click();
  await T.getByText('Marked copy saved').waitFor();
  await q6.getByLabel('Mark for question 6').fill('4');
  await T.getByPlaceholder(/What went well/).fill('Great working, Anaya. Watch the intercept on graphs.');
  await T.waitForTimeout(900);
  await T.getByRole('button', { name: /Return marks/ }).click();
  await T.getByText('Marks returned').waitFor();

  step('Learner sees marks, feedback, step ticks and marked copy');
  await L.getByRole('button', { name: 'See what I handed in' }).click();
  await L.reload();
  await L.getByText('From your tutor').waitFor();
  await shot(L, 'learner-results', true);

  step('Progress and summaries');
  await nav(L, 'Progress').click();
  await L.getByText('Strengths by topic').waitFor();
  await shot(L, 'learner-progress', true);
  await nav(T, 'Learners').click();
  await T.getByText('Anaya').first().click();
  await T.getByText('Strengths by topic').waitFor();
  await shot(T, 'tutor-learner-progress', true);

  step('Messages');
  await T.getByRole('button', { name: 'Message' }).click();
  await T.getByPlaceholder('Write a message…').fill('Yes! Dividing first works too because 3x means 3 times x.');
  await T.keyboard.press('Enter');
  await T.getByText('Dividing first works').first().waitFor();
  await shot(T, 'tutor-messages');

  step('Mock exam: a paper adds up to a grade from the tutor’s own boundaries; the learner sees only her grade');
  await nav(T, 'Assignments').click();
  await T.getByRole('button', { name: 'New assignment' }).first().click();
  await T.getByRole('dialog').getByRole('button', { name: 'Mock exam', exact: true }).click();
  await T.getByLabel('Title').fill('October mock');
  await T.getByLabel('Subject').selectOption({ label: 'Mathematics (Extended)' });
  await T.getByRole('button', { name: 'Create' }).click();
  await T.getByRole('heading', { name: 'Papers' }).waitFor();
  await T.getByLabel('Add a paper you already made').selectOption({ label: 'Linear equations 1' });
  await T.getByRole('button', { name: 'Add', exact: true }).click();
  await T.locator('tr', { hasText: 'Anaya' }).getByText('Add grade boundaries').waitFor();
  await T.getByRole('button', { name: 'Add grade boundaries' }).click();
  await T.getByRole('button', { name: 'Type them in' }).click();
  await T.getByLabel('Session').fill('June 2025');
  await T.getByLabel(/Out of/).fill('100');
  for (const [g, m] of [['A*', 90], ['A', 75], ['B', 60], ['C', 45], ['D', 30], ['E', 15]]) await T.getByLabel(`Lowest mark for ${g}`, { exact: true }).fill(String(m));
  await T.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await T.getByText('Grade boundaries saved').waitFor();
  const grade = await T.locator('tr', { hasText: 'Anaya' }).locator('td').nth(3).locator('.strong').textContent();
  assert.match(grade, /^(A\*|[A-E]|U)$/, 'a grade from the boundaries: ' + grade);
  await shot(T, 'tutor-mock-exam', true);
  // the learner: her grade on Progress, never the boundaries
  await L.reload();
  await nav(L, 'Progress').click();
  await L.getByRole('heading', { name: /Mock exams/ }).waitFor();
  await L.getByText('October mock').waitFor();
  assert.equal(await L.getByText('June 2025').count(), 0, 'the learner never sees the boundaries');
  await shot(L, 'learner-mock-grade');

  step('Weekly lesson: the tutor sets it in New York time, the learner sees it in Lusaka time');
  {
    const d = new Date(Date.now() + 21 * 864e5);
    while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1); // a Tuesday 3+ weeks ahead
    await nav(T, 'Live').click();
    await T.getByRole('button', { name: 'Schedule' }).click();
    await T.getByLabel('Title').fill('Weekly maths');
    await T.getByLabel('Starts (your time)').fill(d.toISOString().slice(0, 10) + 'T10:00');
    await T.getByLabel('Repeat').selectOption('week');
    await T.getByLabel('First lesson (your time)').waitFor();
    const hint = await T.getByText(/^Anaya: /).textContent();
    const theirs = hint.match(/^Anaya: \w+ (.+) in Lusaka$/)?.[1];
    assert.ok(theirs, 'the form shows the learner’s own time: ' + hint);
    await shot(T, 'tutor-weekly-lesson-form');
    await T.getByRole('button', { name: 'Save' }).click();
    await T.getByText('Weekly lesson set').waitFor();
    await T.getByRole('heading', { name: 'Weekly lessons' }).waitFor();
    await T.getByText(new RegExp('Every Tue 10:00 AM your time · Anaya Tue ' + theirs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' Lusaka')).waitFor();
    assert.ok((await T.locator('.pill', { hasText: 'Weekly' }).count()) >= 4, 'lessons planned up to 8 weeks ahead');
    await shot(T, 'tutor-weekly-lessons', true);
    // the learner is told once, in her own time, and sees the lessons in Lusaka time
    await L.reload();
    await nav(L, 'Live').click();
    await L.getByText('Weekly maths').first().waitFor();
    assert.ok((await L.locator('.item', { hasText: 'Weekly maths' }).first().textContent()).includes(theirs));
    await L.evaluate(() => (location.hash = '#/notifications'));
    await shot(L, 'learner-weekly-lesson');
    // skip one week; the learner no longer sees it, the tutor can put it back
    await T.locator('.card', { hasText: 'Upcoming' }).getByRole('button', { name: 'Cancel session' }).nth(1).click();
    await T.getByRole('button', { name: 'Skip just this one' }).click();
    await T.getByText('Skipped. Your learners have been told.').waitFor();
    await T.getByRole('button', { name: 'Put back' }).waitFor();
    await L.reload();
    await L.getByText('Weekly maths').first().waitFor();
    // her phone reminders switch
    await L.evaluate(() => (location.hash = '#/settings'));
    await L.getByText('Reminders on your phone').waitFor();
    await L.getByText(/^studybridge-[0-9a-f]{18}$/).waitFor();
    await shot(L, 'learner-phone-reminders');
    await L.evaluate(() => (location.hash = '#/'));
  }

  step('Admin: tutor sets a new password for the learner, who signs in with it');
  await nav(T, 'Learners').click();
  await T.locator('.content').getByText('Anaya').first().click();
  await T.getByRole('button', { name: 'Account' }).click();
  await T.getByText('anaya@example.com').waitFor();
  await T.getByLabel('New password').fill('Mango-River-42');
  await T.getByRole('button', { name: 'Save new password' }).click();
  await T.getByText('Tell Anaya').waitFor();
  await shot(T, 'tutor-learner-account');
  await T.keyboard.press('Escape');
  {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const X = await ctx.newPage();
    await X.goto(web.url);
    await X.evaluate(([u, k]) => (localStorage.setItem('sb.server', JSON.stringify({ url: u, key: k })), localStorage.setItem('sb.seen', '1')), [srv.url, srv.anonKey]);
    await X.reload();
    await X.getByLabel('Email').fill('anaya@example.com');
    await X.getByLabel('Password').fill('secret123');
    await X.getByRole('button', { name: 'Sign in' }).click();
    await X.getByText(/don’t match/).waitFor();
    await X.getByLabel('Password').fill('Mango-River-42');
    await X.getByRole('button', { name: 'Sign in' }).click();
    await X.getByText(/, Anaya!/).waitFor();
    await ctx.close();
  }

  step('Offline: learner answers and hands in with no connection, it syncs later');
  const tc = (await import('@supabase/supabase-js')).createClient(srv.url, srv.anonKey, { auth: { persistSession: false } });
  await tc.auth.signInWithPassword({ email: 'aaryan@example.com', password: 'secret123' });
  const quiz = (await tc.from('assignments').insert({ kind: 'quiz', title: 'Offline quiz', visibility: 'visible', release_mode: 'on_submit' }).select().single()).data;
  const oq = (await tc.from('questions').insert({ assignment_id: quiz.id, type: 'numeric', prompt_md: 'What is $6 \\times 7$?', marks: 1 }).select().single()).data;
  await tc.from('question_keys').insert({ question_id: oq.id, answer: { value: '42', tolerance: '0' } });
  await nav(L, 'Today').click();
  await L.reload();
  await L.locator('.work-card', { hasText: 'Offline quiz' }).first().click();
  await L.getByRole('button', { name: 'Start', exact: true }).click();
  await L.getByText('What is').waitFor();
  await learnerCtx.setOffline(true);
  await L.getByLabel('Your answer').fill('42');
  await L.getByText('Saved on this device').waitFor({ timeout: 15000 });
  await L.getByText(/You’re offline/).first().waitFor();
  await shot(L, 'learner-offline');
  await L.getByRole('button', { name: 'Hand in' }).first().click();
  await L.getByRole('dialog').getByRole('button', { name: 'Hand in' }).click();
  await L.getByText(/saved on this laptop/).waitFor();
  await shot(L, 'learner-offline-handed-in');
  assert.equal((await tc.from('attempts').select('status').eq('assignment_id', quiz.id)).data[0].status, 'in_progress');
  await learnerCtx.setOffline(false);
  await L.evaluate(() => window.dispatchEvent(new Event('online')));
  let synced = null;
  for (let i = 0; i < 30 && !synced; i++) {
    await L.waitForTimeout(500);
    const r = (await tc.from('attempts').select('status,score').eq('assignment_id', quiz.id)).data[0];
    if (r.status === 'marked') synced = r;
  }
  assert.ok(synced, 'offline hand-in synced when back online');
  assert.equal(Number(synced.score), 1);

  step('Phone view');
  const phone = await browser.newContext({ ...devices['iPhone 13'] });
  const P = await phone.newPage();
  const errP = watchErrors(P, 'phone');
  await P.goto(web.url);
  await P.evaluate(([u, k]) => (localStorage.setItem('sb.server', JSON.stringify({ url: u, key: k })), localStorage.setItem('sb.seen', '1')), [srv.url, srv.anonKey]);
  await P.reload();
  await P.getByLabel('Email').fill('aaryan@example.com');
  await P.getByLabel('Password').fill('secret123');
  await P.getByRole('button', { name: 'Sign in' }).click();
  await P.getByText(/Good (morning|afternoon|evening), Aaryan/).waitFor();
  await shot(P, 'phone-tutor-home');
  errors.push(...errP);

  console.log('\nWalkthrough passed. Screenshots in', SHOTS);
} catch (e) {
  for (const [n, pg] of [['tutor', T], ['learner', L]]) {
    const t = await pg.locator('.toasts').innerText().catch(() => '');
    if (t.trim()) console.log(`${n} toasts:`, t.replace(/\n/g, ' | '));
  }
  await shot(T, 'FAIL-tutor', true).catch(() => {});
  await shot(L, 'FAIL-learner', true).catch(() => {});
  console.error('\nWalkthrough FAILED:', e.message);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=walkthrough::${String(e.message).replace(/\n/g, ' ').slice(0, 900)}`);
  process.exitCode = 1;
} finally {
  const all = [...errT, ...errL, ...errors];
  if (all.length) {
    console.log('\nConsole errors:\n' + [...new Set(all)].join('\n'));
    process.exitCode = 1;
  }
  await browser.close();
  web.close();
  await srv.close();
}
