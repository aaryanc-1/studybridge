// Updates arrive by themselves (10 Oct 2026). The app looks for a new version when it opens, every 15 minutes and
// when you come back to it, and switches to it when that's safe: as you come back to the app (from the tray, a
// minimised window or another app), or after 10 minutes without touching it. Never during an exam, a test, a live
// lesson or a video, with something typed or drawn on the page, with unsaved changes, an open box or anything
// waiting to send. Then the "new version is ready" bar waits for you. (Screens: UpdateBanner in Shell.jsx.)
import { desktop } from './config.js';

export const CHECK_EVERY = 15 * 60 * 1000;
export const RECHECK_ON_RETURN = 5 * 60 * 1000;
export const IDLE = 10 * 60 * 1000;
export const AWAY = 2 * 60 * 1000;

// After the desktop app restarts into a new version, open the page you were on. This file is imported first
// (main.jsx), before the app reads the address.
const RESUME = 'sb.resume';
try {
  const r = JSON.parse(localStorage.getItem(RESUME) || 'null');
  localStorage.removeItem(RESUME);
  if (r?.hash && Date.now() - r.at < 2 * 60 * 1000 && !location.hash.replace(/^#\/?/, '')) history.replaceState(null, '', r.hash);
} catch {
  /* no storage: start on Home */
}

// Restart the desktop app (into the downloaded version), back on the same page
export async function restartDesktop() {
  try {
    localStorage.setItem(RESUME, JSON.stringify({ hash: location.hash, at: Date.now() }));
  } catch {}
  const r = await desktop.restart();
  if (r?.error) {
    try {
      localStorage.removeItem(RESUME);
    } catch {}
  }
  return r;
}

// When the app was last used (a key, a click, a tap, the wheel), and whether anything was typed or drawn on this page
let lastActive = Date.now();
let typed = false;
const TYPING = 'textarea, [contenteditable], math-field, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=search])';
if (typeof window !== 'undefined') {
  const used = () => {
    lastActive = Date.now();
  };
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) addEventListener(ev, used, { capture: true, passive: true });
  addEventListener('input', (e) => e.target?.matches?.(TYPING) && (typed = true), { capture: true, passive: true });
  addEventListener('pointerdown', (e) => e.target?.closest?.('canvas') && (typed = true), { capture: true, passive: true });
}
export const idleFor = () => Date.now() - lastActive;
// a new page: what was typed on the last one was saved or left behind
export const pageChanged = () => {
  typed = false;
};

// Is anything going on that a restart or reload would interrupt?
export function busyNow({ path = '', unsaved = false, pending = 0 } = {}) {
  if (typed || unsaved || pending > 0) return true;
  if (/^\/(attempt|live|watch)(\/|$)/.test(path)) return true;
  if (document.fullscreenElement) return true;
  if (document.querySelector('[role="dialog"], dialog[open]')) return true;
  if ([...document.querySelectorAll('video, audio')].some((m) => !m.paused && !m.ended)) return true;
  return false;
}

// Phone / browser: the app's main script, e.g. "./assets/index-B1x2.js". A new version has a new name.
export function mainScript(html) {
  for (const [tag] of String(html || '').matchAll(/<script\b[^>]*>/gi)) {
    const src = tag.match(/\ssrc="([^"]+)"/i);
    if (/type="module"/i.test(tag) && src) return src[1];
  }
  return null;
}
// Is a newer version of the web app on the server? ("fresh" skips the offline copy, see public/sw.js)
export async function webHasUpdate() {
  const mine = document.querySelector('script[type="module"][src]')?.getAttribute('src');
  if (!mine) return false;
  const r = await fetch(`./?fresh=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) return false;
  const theirs = mainScript(await r.text());
  return !!theirs && theirs !== mine;
}
