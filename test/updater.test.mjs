// The desktop updater (electron/updater.cjs) with a pretend Electron. Each createUpdater() is one start of the app.
// On 28 Oct 2026 a second copy of StudyBridge set a good update aside as "didn't start", and the app went back to
// the version it was installed with (1.1.75, a month old) while saying it had the latest.
import test from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const served = {};
const fetched = [];
const userData = mkdtempSync(join(tmpdir(), 'sbupd-'));
const electron = {
  app: { getPath: () => userData, getVersion: () => '1.1.75', isPackaged: false, on() {}, relaunch() {}, exit() {} },
  net: {
    fetch: async (url) => {
      fetched.push(url);
      return served[url] ? { ok: true, arrayBuffer: async () => served[url] } : { ok: false, status: 404 };
    },
  },
  shell: { openPath() {} },
};
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? electron : load.call(this, request, ...rest);
};
const BASE = 'https://updates.example/';
process.env.SB_UPDATE_URL = BASE;
const { createUpdater, shellId } = createRequire(import.meta.url)('../electron/updater.cjs');
const SHELL = shellId();

// a release: the manifest and its .sbz bundle (gzip of a 4-byte header length, the header, the files)
function publish(version) {
  const page = Buffer.from(`<!doctype html><title>${version}</title>`);
  const header = Buffer.from(JSON.stringify([{ path: 'index.html', size: page.length }]));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);
  const sbz = gzipSync(Buffer.concat([len, header, page]));
  served[BASE + `app-${version}.sbz`] = sbz;
  const sha512 = createHash('sha512').update(sbz).digest('base64');
  served[BASE + 'manifest.json'] = Buffer.from(JSON.stringify({ version, shell: SHELL, bundle: { file: `app-${version}.sbz`, sha512 } }));
}
const start = () => createUpdater({ getWindow: () => null, isLocked: () => false });
// which version a start opens: a downloaded one's folder name, or "built-in"
const opens = (u) => {
  const page = u.startPage();
  return basename(dirname(page)) === 'dist' ? 'built-in' : basename(dirname(page));
};
// check() answers through status events, like the app sees them
const checked = async (u, opts) => (await u.check(opts), u.status());
const state = () => JSON.parse(readFileSync(join(userData, 'app-updates', 'state.json'), 'utf8'));

test('desktop updates: closed straight after updating gets a second go, then the last good version, never the old built-in one', async () => {
  // the first start knows this shell; a release comes out, downloads, and opens on the next start
  mkdirSync(join(userData, 'app-updates'), { recursive: true });
  const first = start();
  assert.equal(opens(first), 'built-in');
  publish('9.0.1');
  assert.equal((await checked(first)).state, 'ready');
  const second = start();
  assert.equal(opens(second), '9.0.1');
  second.confirm();
  assert.equal(state().good, '9.0.1');

  // the next release opens, but the app is closed (or the computer sleeps) before it says it started: one more go
  publish('9.0.2');
  assert.equal((await checked(second)).version, '9.0.2');
  assert.equal(opens(start()), '9.0.2');
  assert.equal(opens(start()), '9.0.2', 'a second go');
  assert.ok(!(state().bad || []).includes('9.0.2'));
  // a second miss: set aside, and the last version that started properly opens, not the built-in one
  const after = start();
  assert.equal(opens(after), '9.0.1');
  assert.ok(state().bad.includes('9.0.2'));
  // About says so instead of "You have the latest version", and Check now gives it another go
  assert.equal((await checked(after)).skipped, '9.0.2');
  const again = await checked(after, { retry: true });
  assert.equal(again.state, 'ready');
  assert.equal(again.version, '9.0.2');
  assert.ok(!state().bad.includes('9.0.2'));
  const next = start();
  assert.equal(opens(next), '9.0.2');
  next.confirm();
  assert.equal(state().good, '9.0.2');
  assert.equal(state().trying, null);
});

test('desktop updates: another start still on an older version never downloads over the open one or confirms it', async () => {
  // still running the built-in version (it never switched): it sees 9.0.2 is already here
  const old = start();
  const downloads = fetched.filter((u) => u.endsWith('.sbz')).length;
  const r = await checked(old);
  assert.equal(r.state, 'up-to-date');
  assert.equal(fetched.filter((u) => u.endsWith('.sbz')).length, downloads, 'nothing downloaded again');
  assert.ok(existsSync(join(userData, 'app-updates', '9.0.2', 'index.html')));

  // a new version is trying to start in another window: the old one saying "I started" doesn't count for it
  publish('9.0.3');
  const newest = start();
  await newest.check();
  const trying = start();
  assert.equal(opens(trying), '9.0.3');
  old.confirm();
  assert.equal(state().trying, '9.0.3');
  assert.equal(state().confirmed, false);
  trying.confirm();
  assert.equal(state().confirmed, true);
  assert.equal(state().good, '9.0.3');
});
