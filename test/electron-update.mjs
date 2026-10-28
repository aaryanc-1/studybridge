// Desktop updates: the app finds a new version on the releases page, downloads
// and checks it, switches to it on the next start, and if a new one fails to
// start twice goes back to the last version that started (Check now retries it).
// A second copy of the app leaves the updates alone.
//   npm run build && xvfb-run -a node test/electron-update.mjs
import { _electron as electron } from 'playwright';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const ROOT = new URL('..', import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), 'sb-upd-'));
const site = join(work, 'site');
mkdirSync(site);

// Make a release: a copy of the app with a marker, packed like CI does
function release(version, change) {
  const d = join(work, 'dist-' + version);
  cpSync(join(ROOT, 'dist'), d, { recursive: true });
  const f = join(d, 'index.html');
  writeFileSync(f, change(readFileSync(f, 'utf8')));
  for (const x of ['StudyBridge-app-9.9.9.sbz', 'StudyBridge-app-9.9.10.sbz', 'manifest.json']) rmSync(join(site, x), { force: true });
  execFileSync('node', [join(ROOT, 'scripts', 'pack-bundle.mjs'), version, site], { env: { ...process.env, DIST: d }, stdio: 'ignore' });
  execFileSync('node', [join(ROOT, 'scripts', 'make-manifest.mjs'), version, site], { stdio: 'ignore' });
}

const server = http.createServer((req, res) => {
  const f = join(site, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!existsSync(f)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200);
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const UPDATE_URL = `http://127.0.0.1:${server.address().port}/`;
const userData = join(work, 'userdata');

const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
const appEnv = { ...process.env, SB_USER_DATA: userData, SB_UPDATE_URL: UPDATE_URL, SB_UPDATE_CHECK_DELAY: '300' };
// SB_TEST skips the one-copy-at-a-time lock; `single` keeps it, like the real app
async function launch({ single = false } = {}) {
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: ['--no-sandbox', ROOT],
    env: single ? appEnv : { ...appEnv, SB_TEST: '1' },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win };
}
async function waitFor(win, fn, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const st = await win.evaluate(() => window.studybridge.updates.get());
    if (fn(st)) return st;
    await win.waitForTimeout(250);
  }
  throw new Error('Timed out waiting for ' + what);
}

let ok = false;
try {
  // 1. A new version is published
  release('9.9.9', (h) => h.replace('<title>StudyBridge</title>', '<title>StudyBridge UPDATED</title>'));
  let { app, win } = await launch();
  assert.equal(await win.title(), 'StudyBridge');
  const st = await waitFor(win, (s) => s.state === 'ready' || s.state === 'error', 'the update to download');
  assert.equal(st.state, 'ready', st.error);
  assert.equal(st.kind, 'restart');
  assert.equal(st.version, '9.9.9');
  console.log('• Found, downloaded and checked version 9.9.9');
  await app.close();

  // 2. Next start runs the new version
  ({ app, win } = await launch());
  await win.getByText('Welcome to StudyBridge').waitFor();
  assert.equal(await win.title(), 'StudyBridge UPDATED');
  assert.equal((await win.evaluate(() => window.studybridge.updates.get())).current, '9.9.9');
  console.log('• Restarted into version 9.9.9');
  await win.waitForTimeout(500);
  await app.close();

  // 3. A second copy, opened while the app is still starting a new version, leaves the updates alone (on 28 Oct 2026
  // it set a good version aside as "didn't start", and the app went back to the one it was installed with)
  ({ app, win } = await launch({ single: true }));
  await win.getByText('Welcome to StudyBridge').waitFor();
  const stateFile = join(userData, 'app-updates', 'state.json');
  const starting = { ...JSON.parse(readFileSync(stateFile, 'utf8')), trying: '9.9.9', confirmed: false };
  writeFileSync(stateFile, JSON.stringify(starting));
  const second = spawn(ELECTRON, ['--no-sandbox', ROOT], { env: appEnv, stdio: 'ignore' });
  const code = await new Promise((r, no) => {
    const t = setTimeout(() => no(new Error('the second copy kept running')), 20000);
    second.on('exit', (c) => (clearTimeout(t), r(c)));
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), starting, 'the second copy changed nothing');
  await app.close();
  console.log('• A second copy hands over and leaves the updates alone');

  // 4. A broken version: it never starts. It gets a second go (it may only have been closed too soon), then the app
  // goes back to the last version that started, 9.9.9, not the built-in one
  ({ app, win } = await launch());
  await win.getByText('Welcome to StudyBridge').waitFor();
  await app.close();
  release('9.9.10', (h) => h.replace('<title>StudyBridge</title>', '<title>BROKEN</title>').replace(/<script[^>]*src=[^>]*><\/script>/g, ''));
  ({ app, win } = await launch());
  await waitFor(win, (s) => s.state === 'ready' && s.version === '9.9.10', 'the broken update');
  await app.close();
  ({ app, win } = await launch());
  assert.equal(await win.title(), 'BROKEN');
  assert.ok(existsSync(join(userData, 'app-updates', '9.9.9', 'index.html')), 'the version before stays on disk as a spare');
  await app.close();
  ({ app, win } = await launch());
  assert.equal(await win.title(), 'BROKEN', 'a second go');
  await app.close();
  ({ app, win } = await launch());
  await win.getByText('Welcome to StudyBridge').waitFor();
  assert.equal(await win.title(), 'StudyBridge UPDATED', 'back on the last version that started');
  assert.equal((await win.evaluate(() => window.studybridge.updates.get())).current, '9.9.9');
  // ...it doesn't download that broken version again, and says so
  const after = await waitFor(win, (s) => s.state === 'up-to-date' || s.state === 'ready' || s.state === 'error', 'a check');
  assert.equal(after.state, 'up-to-date');
  assert.equal(after.skipped, '9.9.10');
  console.log('• A version that fails to start twice is set aside; the last good one opens');
  // Check now gives it another go
  await win.evaluate(() => window.studybridge.updates.check({ retry: true }));
  await waitFor(win, (s) => s.state === 'ready' && s.version === '9.9.10', 'Check now to try it again');
  console.log('• Check now tries it again');
  await app.close();
  ok = true;
  console.log('\nDesktop updates passed.');
} catch (e) {
  console.error('\nDesktop updates FAILED:', e.message);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=electron-update::${String(e.message).replace(/\n/g, ' ').slice(0, 900)}`);
} finally {
  server.close();
  process.exit(ok ? 0 : 1);
}
