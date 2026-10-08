// Choices that belong to this device, not the account (1.6): appearance (light, dark or the computer's own
// setting) and data saver (for learners on phone data: smaller photos, PDFs a page at a time, pictures on
// tap, lighter live lessons).
import { useSyncExternalStore } from 'react';

const get = (k, d) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const put = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* blocked storage: the choice lasts until the app closes */
  }
};
const listeners = new Set();
const changed = () => listeners.forEach((f) => f());
const subscribe = (f) => (listeners.add(f), () => listeners.delete(f));

// ---------------- appearance ----------------
export const themeChoice = () => get('sb.theme', 'light'); // 'light' | 'dark' | 'auto'
const darkQuery = () => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null);
export function applyTheme() {
  const c = themeChoice();
  const dark = c === 'dark' || (c === 'auto' && !!darkQuery()?.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
export function setTheme(c) {
  put('sb.theme', c);
  applyTheme();
  changed();
}
darkQuery()?.addEventListener?.('change', () => themeChoice() === 'auto' && applyTheme());
export const useTheme = () => useSyncExternalStore(subscribe, themeChoice);

// ---------------- text size ----------------
// The whole app scales, so buttons and menus grow with the text. Parents start on Large.
const ZOOM = { normal: 1, large: 1.12, xl: 1.25 };
let roleDefault = 'normal';
export const textSizeChoice = () => get('sb.textsize', '') || roleDefault; // 'normal' | 'large' | 'xl'
export function applyTextSize(role) {
  if (role !== undefined) roleDefault = role === 'parent' ? 'large' : 'normal';
  const z = ZOOM[textSizeChoice()] || 1;
  document.documentElement.style.zoom = z === 1 ? '' : String(z);
}
export function setTextSize(c) {
  put('sb.textsize', c);
  applyTextSize();
  changed();
}
export const useTextSize = () => useSyncExternalStore(subscribe, textSizeChoice);

// ---------------- data saver ----------------
export const dataSaver = () => get('sb.datasaver', '0') === '1';
export const liveMode = () => get('sb.datasaver.live', 'low'); // 'low' (low-quality video) | 'audio' (audio only)
export function setDataSaver(on) {
  put('sb.datasaver', on ? '1' : '0');
  changed();
}
export function setLiveMode(m) {
  put('sb.datasaver.live', m);
  changed();
}
export const useDataSaver = () => useSyncExternalStore(subscribe, dataSaver);
export const useLiveMode = () => useSyncExternalStore(subscribe, liveMode);
// The connection looks slow or the phone asked to save data (Chrome, Android and the desktop app can tell)
export function slowConnection() {
  const c = typeof navigator !== 'undefined' ? navigator.connection : null;
  return !!c && (!!c.saveData || ['slow-2g', '2g', '3g'].includes(c.effectiveType));
}
// How much data saver has saved on this device, roughly
export const savedBytes = () => Number(get('sb.saved', '0')) || 0;
export function addSaved(bytes) {
  if (!(bytes > 0)) return;
  put('sb.saved', String(savedBytes() + Math.round(bytes)));
  changed();
}
export const useSavedBytes = () => useSyncExternalStore(subscribe, savedBytes);
