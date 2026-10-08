// StudyBridge desktop app (Windows + Mac). One app for tutors and learners.
const { app, BrowserWindow, ipcMain, shell, session, desktopCapturer, systemPreferences, dialog, Tray, Menu, nativeImage, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { createUpdater } = require('./updater.cjs');

if (process.env.SB_USER_DATA) app.setPath('userData', process.env.SB_USER_DATA);
if (process.platform === 'win32') app.setAppUserModelId('app.studybridge.desktop');

const isTest = !!process.env.SB_TEST;
if (!isTest && !app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let tray = null;
let quitting = false;
let keepInBackground = false;
const lock = { on: false, attempt: null, lastBlur: 0 };
const updater = createUpdater({ getWindow: () => win, isLocked: () => lock.on });
let startFile = null;

function resource(name) {
  return app.isPackaged ? path.join(process.resourcesPath, name) : path.join(__dirname, '..', 'build', name);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 380,
    minHeight: 560,
    title: 'StudyBridge',
    backgroundColor: '#F6F4EF',
    show: false,
    icon: resource('icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  win.once('ready-to-show', () => {
    if (!process.env.SB_HIDDEN) win.show();
  });

  if (process.env.SB_DEV_URL) win.loadURL(process.env.SB_DEV_URL);
  else win.loadFile(startFile || (startFile = updater.startPage()));

  // Links open in the normal browser; the app never navigates away from itself
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:') && !(process.env.SB_DEV_URL && url.startsWith(process.env.SB_DEV_URL))) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  // Exam lockdown: block shortcuts that would leave or reload the app
  win.webContents.on('before-input-event', (e, input) => {
    if (!lock.on) return;
    const k = (input.key || '').toLowerCase();
    const mod = input.control || input.meta;
    const blocked =
      (mod && ['w', 'q', 'r', 'n', 't', 'm', 'h', 'tab'].includes(k)) ||
      (mod && input.shift && ['i', 'j', 'c'].includes(k)) ||
      ['f5', 'f11', 'f12'].includes(k) ||
      (input.alt && k === 'f4') ||
      (input.meta && k === 'tab');
    if (blocked) {
      e.preventDefault();
      report('Tried a shortcut to leave the exam');
    }
  });

  win.on('blur', () => {
    if (!lock.on) return;
    const now = Date.now();
    if (now - lock.lastBlur > 3000) report('Left the StudyBridge window');
    lock.lastBlur = now;
    setTimeout(() => {
      if (lock.on && win && !win.isDestroyed()) {
        win.show();
        win.focus();
        win.moveTop();
      }
    }, 80);
  });
  win.on('minimize', () => {
    if (lock.on) {
      win.restore();
      report('Tried to minimise the exam');
    }
  });
  win.on('leave-full-screen', () => {
    if (lock.on) setTimeout(() => win && !win.isDestroyed() && win.setFullScreen(true), 50);
  });
  win.on('close', (e) => {
    if (lock.on) {
      e.preventDefault();
      report('Tried to close StudyBridge during the exam');
      return;
    }
    if (keepInBackground && !quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });
}

function report(event) {
  if (win && !win.isDestroyed()) win.webContents.send('lockdown:event', { event, at: new Date().toISOString() });
}

function setLock(on) {
  if (!win) return;
  lock.on = on;
  if (on) {
    win.show();
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setKiosk(true);
    win.setFullScreen(true);
    win.setMinimizable(false);
    win.focus();
  } else {
    win.setKiosk(false);
    win.setFullScreen(false);
    win.setAlwaysOnTop(false);
    win.setMinimizable(true);
  }
}

function ensureTray() {
  if (tray || !keepInBackground) return;
  const img = nativeImage.createFromPath(resource('tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }));
  tray.setToolTip('StudyBridge');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open StudyBridge', click: () => showWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]),
  );
  tray.on('click', () => showWindow());
}

function showWindow() {
  if (!win) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

app.on('second-instance', () => showWindow());
app.on('before-quit', () => {
  quitting = true;
});

app.whenReady().then(() => {
  const ses = session.defaultSession;
  const allowed = new Set(['media', 'notifications', 'display-capture', 'fullscreen', 'clipboard-sanitized-write', 'clipboard-read']);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  // Screen sharing (live lessons + exam screen): share the whole screen
  ses.setDisplayMediaRequestHandler(async (_req, cb) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      cb(sources[0] ? { video: sources[0] } : {});
    } catch {
      cb({});
    }
  });
  createWindow();
  updater.start();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || isTest) app.quit();
});
app.on('activate', () => showWindow());

// ---------- IPC ----------
ipcMain.on('app:info', (e) => {
  e.returnValue = { version: app.getVersion(), platform: process.platform, desktop: true, updatesOn: updater.enabled };
});
ipcMain.handle('update:get', () => updater.status());
ipcMain.handle('update:check', () => updater.check());
ipcMain.handle('update:apply', () => updater.apply());
ipcMain.handle('update:ok', () => updater.confirm());
ipcMain.handle('app:focus', () => showWindow());
// "StudyBridge was updated: restart" (never during a locked exam)
ipcMain.handle('app:restart', () => {
  if (lock.on) return { error: 'Finish the exam first.' };
  app.relaunch();
  app.exit(0);
  return { ok: true };
});
ipcMain.handle('app:badge', (_e, n) => {
  try {
    app.setBadgeCount(Math.max(0, n | 0));
  } catch {}
  if (win && process.platform === 'win32') win.flashFrame(n > 0 && !win.isFocused());
});
ipcMain.handle('app:background', (_e, on) => {
  keepInBackground = !!on;
  if (on) ensureTray();
  else if (tray) {
    tray.destroy();
    tray = null;
  }
});
ipcMain.handle('lockdown:enter', (_e, attemptId) => {
  lock.attempt = attemptId;
  setLock(true);
  return true;
});
ipcMain.handle('lockdown:exit', () => {
  lock.attempt = null;
  setLock(false);
  return true;
});
ipcMain.handle('media:ask', async () => {
  if (process.platform !== 'darwin') return true;
  try {
    const cam = await systemPreferences.askForMediaAccess('camera');
    await systemPreferences.askForMediaAccess('microphone');
    return cam;
  } catch {
    return false;
  }
});
ipcMain.handle('file:save', async (_e, { name, bytes }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), name) });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(bytes));
  shell.showItemInFolder(r.filePath);
  return r.filePath;
});
// Exam boards' own websites only: reads a past-papers page or downloads one of their PDFs for the tutor.
// (Their sites don't let the app's pages fetch them directly.) Nothing is sent anywhere else.
const WEB_HOSTS = ['www.cambridgeinternational.org', 'cambridgeinternational.org', 'www.ibo.org', 'ibo.org'];
ipcMain.handle('web:fetch', async (_e, { url, as }) => {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { error: 'Not a web address.' };
  }
  if (u.protocol !== 'https:' || !WEB_HOSTS.includes(u.hostname)) return { error: 'StudyBridge only opens exam boards’ own websites here.' };
  try {
    // follow redirects ourselves, so every hop stays on an exam board's own site
    let r;
    for (let hop = 0; ; hop++) {
      r = await net.fetch(u.href, { redirect: 'manual', headers: { 'User-Agent': `Mozilla/5.0 StudyBridge/${app.getVersion()}`, Accept: as === 'text' ? 'text/html' : 'application/pdf,*/*' } });
      if (r.status < 300 || r.status >= 400) break;
      const loc = r.headers.get('location');
      if (!loc || hop >= 5) return { error: 'The exam board’s site sent StudyBridge somewhere unexpected.' };
      u = new URL(loc, u);
      if (u.protocol !== 'https:' || !WEB_HOSTS.includes(u.hostname)) return { error: 'That link leads away from the exam board’s site.' };
    }
    if (!r.ok) return { error: `The exam board’s site answered ${r.status}.`, status: r.status };
    const type = r.headers.get('content-type') || '';
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > (as === 'text' ? 8 : 60) * 1024 * 1024) return { error: 'That page or file is too big.' };
    if (as === 'text') return { text: buf.toString('utf8'), type };
    return { bytes: new Uint8Array(buf), type };
  } catch (e) {
    return { error: 'Couldn’t reach the exam board’s site. Check the internet connection.', detail: String(e && e.message) };
  }
});
ipcMain.handle('connector:save', async () => {
  const src = resource('studybridge.mcpb');
  if (!fs.existsSync(src)) return { error: 'The Claude connector is not included in this build.' };
  const dest = path.join(app.getPath('downloads'), 'StudyBridge for Claude.mcpb');
  fs.copyFileSync(src, dest);
  shell.showItemInFolder(dest);
  return { path: dest };
});
ipcMain.handle('connector:open', async () => {
  const src = resource('studybridge.mcpb');
  if (!fs.existsSync(src)) return { error: 'The Claude connector is not included in this build.' };
  const dest = path.join(app.getPath('downloads'), 'StudyBridge for Claude.mcpb');
  fs.copyFileSync(src, dest);
  const err = await shell.openPath(dest);
  return err ? { error: err, path: dest } : { path: dest };
});
