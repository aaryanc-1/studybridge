// Switching accounts without signing out (1.6). Only on a device where the StudyBridge admin account has
// signed in: there, each account signed in on it is remembered (its sign-in, kept like the current one) and
// can be switched to with one click. Everyone else never has more than their own sign-in stored.
import { getServer } from './config.js';

const KEY = 'sb.accounts';
const AUTH = 'sb.auth'; // where the sign-in is kept (see supabase.js)

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
}
function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage full or blocked: switching just isn't offered */
  }
}
function currentSession() {
  try {
    return JSON.parse(localStorage.getItem(AUTH) || 'null');
  } catch {
    return null;
  }
}
const here = () => getServer()?.url || '';

// After signing in: remember this account if the admin account uses this device
export function rememberAccount(p) {
  if (!p?.id || !p.role) return;
  const list = read();
  if (p.role !== 'admin' && !list.some((a) => a.role === 'admin' && a.server === here())) return;
  const session = currentSession();
  if (!session?.refresh_token) return;
  const next = [{ id: p.id, email: p.email || session.user?.email || '', name: p.display_name || '', role: p.role, server: here(), session }, ...list.filter((a) => a.id !== p.id)];
  write(next.slice(0, 8));
}
// The sign-in is refreshed now and then: keep the remembered copy of the current account up to date
function saveCurrent(currentId) {
  const session = currentSession();
  if (!session?.refresh_token || !currentId) return;
  write(read().map((a) => (a.id === currentId ? { ...a, session } : a)));
}

export const otherAccounts = (currentId) => read().filter((a) => a.server === here() && a.id !== currentId);
export const canSwitch = () => read().some((a) => a.role === 'admin' && a.server === here());
export const forgetAccount = (id) => write(read().filter((a) => a.id !== id));

export function switchTo(currentId, id) {
  const target = read().find((a) => a.id === id);
  if (!target?.session) return;
  saveCurrent(currentId);
  localStorage.setItem(AUTH, JSON.stringify(target.session));
  window.location.hash = '#/';
  window.location.reload();
}
// Sign in to one more account on this device, keeping the current one remembered
export function addAccount(currentId) {
  saveCurrent(currentId);
  localStorage.removeItem(AUTH);
  localStorage.setItem('sb.seen', '1');
  window.location.hash = '#/';
  window.location.reload();
}
