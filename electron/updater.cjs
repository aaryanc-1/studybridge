// Keeps StudyBridge up to date without reinstalling.
//
// Most updates only change the app's screens (the "bundle"): the app downloads
// the new bundle in the background, checks it, and switches to it on the next
// start. Works on Windows and Mac. If a new bundle fails to start, the app goes
// back to the one it came with.
//
// Rarely, the desktop shell itself changes (lockdown, camera permissions…).
// Then Windows downloads the new installer and runs it quietly on restart, and
// a Mac downloads the new .dmg and asks to drag it into Applications (Macs won't
// auto-install apps that aren't signed by an Apple developer account).
const { app, net, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// Which desktop shell this is: a fingerprint of the shell's own code. A bundle
// only runs on the exact shell it was built with.
function shellId() {
  const h = crypto.createHash('sha256');
  for (const f of ['main.cjs', 'preload.cjs', 'updater.cjs']) h.update(fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\r\n/g, '\n'));
  return h.digest('hex').slice(0, 16);
}

function config() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'build-config.json'), 'utf8'));
  } catch {}
  return {
    url: process.env.SB_UPDATE_URL || cfg.updateUrl || null,
    bundleVersion: cfg.bundleVersion || app.getVersion(),
  };
}

// "1.1.42" > "1.1.9"
function newer(a, b) {
  const pa = String(a || '0').split('.').map(Number);
  const pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

// .sbz bundle: gzip( 4-byte header length | JSON [{ path, size }] | file bytes … )
function unpack(buf, dir) {
  const raw = zlib.gunzipSync(buf);
  const n = raw.readUInt32BE(0);
  const files = JSON.parse(raw.subarray(4, 4 + n).toString('utf8'));
  let off = 4 + n;
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of files) {
    const dest = path.join(dir, f.path);
    if (!dest.startsWith(dir + path.sep)) throw new Error('Bad path in update');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, raw.subarray(off, off + f.size));
    off += f.size;
  }
  if (!fs.existsSync(path.join(dir, 'index.html'))) throw new Error('Update has no index.html');
}

function createUpdater({ getWindow, isLocked }) {
  const cfg = config();
  const SHELL = shellId();
  const root = path.join(app.getPath('userData'), 'app-updates');
  const stateFile = path.join(root, 'state.json');
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      return {};
    }
  };
  const write = (s) => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(s, null, 1));
  };
  let status = { state: 'idle', current: cfg.bundleVersion, shell: app.getVersion(), checkedAt: null };
  let installer = null; // downloaded installer waiting to run
  const send = () => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send('update:status', status);
  };
  const set = (patch) => {
    status = { ...status, ...patch };
    send();
  };

  // Which app files to load this time (called once, before the window opens)
  function startPage() {
    const builtIn = path.join(__dirname, '..', 'dist', 'index.html');
    const s = read();
    if (s.shell !== SHELL) {
      // a new desktop shell was installed: its own app files win
      if (s.current || s.pending) write({ shell: SHELL, bad: s.bad || [] });
      return builtIn;
    }
    // last time a new version didn't start properly: go back to the built-in one
    if (s.trying && !s.confirmed) {
      s.bad = [...new Set([...(s.bad || []), s.trying])];
      s.current = null;
      s.trying = null;
      write(s);
      return builtIn;
    }
    if (s.pending && !(s.bad || []).includes(s.pending) && fs.existsSync(path.join(root, s.pending, 'index.html'))) {
      if (s.current && s.current !== s.pending) fs.rmSync(path.join(root, s.current), { recursive: true, force: true });
      s.current = s.pending;
      s.pending = null;
      s.confirmed = false;
    }
    if (s.current && newer(s.current, cfg.bundleVersion) && fs.existsSync(path.join(root, s.current, 'index.html'))) {
      if (!s.confirmed) s.trying = s.current;
      write(s);
      status.current = s.current;
      return path.join(root, s.current, 'index.html');
    }
    return builtIn;
  }

  // The app started fine with this version
  function confirm() {
    const s = read();
    if (s.trying || !s.confirmed) {
      s.trying = null;
      s.confirmed = true;
      write(s);
    }
  }

  async function fetchBuf(url) {
    const r = await net.fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return Buffer.from(await r.arrayBuffer());
  }
  const sha512 = (b) => crypto.createHash('sha512').update(b).digest('base64');

  let checking = null;
  async function check() {
    if (!cfg.url) return status;
    if (checking) return checking;
    checking = (async () => {
      try {
        set({ state: 'checking' });
        const base = cfg.url.endsWith('/') ? cfg.url : cfg.url + '/';
        const m = JSON.parse((await fetchBuf(base + 'manifest.json')).toString('utf8'));
        const s = read();
        const have = s.pending || status.current;
        if (m.shell === SHELL) {
          if (!m.bundle || !newer(m.version, have) || (s.bad || []).includes(m.version)) return set({ state: 'up-to-date', checkedAt: Date.now() });
          set({ state: 'downloading', version: m.version });
          const buf = await fetchBuf(base + m.bundle.file);
          if (sha512(buf) !== m.bundle.sha512) throw new Error('The update didn’t download properly.');
          unpack(buf, path.join(root, m.version));
          write({ ...s, shell: SHELL, pending: m.version });
          return set({ state: 'ready', kind: 'restart', version: m.version, notes: m.notes || '', checkedAt: Date.now() });
        }
        // the desktop shell changed: needs the installer
        if (!newer(m.version, app.getVersion())) return set({ state: 'up-to-date', checkedAt: Date.now() });
        const key = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? (process.arch === 'arm64' ? 'mac_arm64' : 'mac_x64') : null;
        const inst = key && m.installers && m.installers[key];
        if (!inst) return set({ state: 'up-to-date', checkedAt: Date.now() });
        set({ state: 'downloading', version: m.version });
        const buf = await fetchBuf(base + inst.file);
        if (inst.sha512 && sha512(buf) !== inst.sha512) throw new Error('The update didn’t download properly.');
        const dest = path.join(process.platform === 'darwin' ? app.getPath('downloads') : app.getPath('temp'), inst.file);
        fs.writeFileSync(dest, buf);
        installer = dest;
        return set({ state: 'ready', kind: process.platform === 'darwin' ? 'mac-install' : 'install', version: m.version, notes: m.notes || '', checkedAt: Date.now() });
      } catch (e) {
        return set({ state: 'error', error: String(e.message || e), checkedAt: Date.now() });
      } finally {
        checking = null;
      }
    })();
    return checking;
  }

  // Apply the update now (never during a locked exam)
  function apply() {
    if (isLocked()) return { error: 'Finish the exam first.' };
    if (status.state !== 'ready') return { error: 'No update is ready.' };
    if (status.kind === 'mac-install') {
      shell.openPath(installer);
      return { opened: installer };
    }
    if (status.kind === 'install' && installer) {
      spawn(installer, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
      app.exit(0);
      return { ok: true };
    }
    app.relaunch();
    app.exit(0);
    return { ok: true };
  }

  // Windows: if the user just quits, still install the downloaded update
  app.on('will-quit', () => {
    if (status.state === 'ready' && status.kind === 'install' && installer && !isLocked()) {
      try {
        spawn(installer, ['--updated', '/S'], { detached: true, stdio: 'ignore' }).unref();
      } catch {}
    }
  });

  function start() {
    if (!cfg.url) return;
    const delay = Number(process.env.SB_UPDATE_CHECK_DELAY || 15000);
    setTimeout(check, delay);
    setInterval(check, 3 * 3600 * 1000).unref?.();
  }

  return { startPage, confirm, check, apply, start, status: () => status, enabled: !!cfg.url, shellId: SHELL };
}

module.exports = { createUpdater, shellId, unpack, newer };
