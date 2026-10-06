// Which StudyBridge server (Supabase project) this app talks to.
// Release builds have the StudyBridge server built in (set when the app is built),
// so nobody types a URL or key. Builds without one fall back to the old way: the
// tutor enters their own server once, and learners get it inside their invite.
const KEY = 'sb.server';
const BUILT_IN = import.meta.env?.VITE_SB_URL && import.meta.env?.VITE_SB_KEY ? { url: import.meta.env.VITE_SB_URL.replace(/\/+$/, ''), key: import.meta.env.VITE_SB_KEY } : null;
export const builtInServer = BUILT_IN;

export const desktop = typeof window !== 'undefined' && window.studybridge ? window.studybridge : null;

export function getServer() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s && s.url && s.key) return s;
  } catch {}
  return BUILT_IN;
}

export function setServer(s) {
  localStorage.setItem(KEY, JSON.stringify({ url: normaliseUrl(s.url), key: s.key.trim() }));
}

export function clearServer() {
  localStorage.removeItem(KEY);
}

export function normaliseUrl(u) {
  let url = String(u || '').trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  // People sometimes paste the dashboard or REST URL
  url = url.replace(/\/rest\/v1$/, '');
  const m = url.match(/^https:\/\/supabase\.com\/dashboard\/project\/([a-z0-9]+)/i);
  if (m) url = `https://${m[1]}.supabase.co`;
  return url;
}

export function validateServer({ url, key }) {
  const u = normaliseUrl(url);
  if (!u) return 'Paste your Project URL.';
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    return 'That doesn’t look like a web address.';
  }
  const local = ['localhost', '127.0.0.1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !local) return 'The Project URL should start with https://';
  if (!key || key.trim().length < 20) return 'Paste the anon / publishable key (it’s a long piece of text).';
  if (/service_role|sb_secret_/.test(key) || keyRole(key) === 'service_role') {
    return 'That’s the secret key. Use the anon / publishable key instead; the secret key must never go in the app.';
  }
  return null;
}

function keyRole(key) {
  try {
    const p = key.split('.')[1];
    return JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/'))).role;
  } catch {
    return null;
  }
}

const b64url = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));

// Invites carry the server details, so learners never type a URL or key.
export function encodeInvite({ url, key, code }) {
  // (a dash, not a dot, so chat apps don't turn it into a fake web link)
  return 'SB1-' + b64url(JSON.stringify({ u: url, k: key, c: code }));
}

export function decodeInvite(text) {
  const t = String(text || '').trim();
  const m = t.match(/SB1[.-]([A-Za-z0-9_-]+)/);
  if (m) {
    try {
      const o = JSON.parse(unb64url(m[1]));
      if (o.u && o.k && o.c) return { url: o.u, key: o.k, code: o.c };
    } catch {}
    return null;
  }
  const code = t.replace(/\s+/g, '').toUpperCase();
  if (/^P?[0-9A-F]{10}$/.test(code)) return { code };
  return null;
}

// Phone setup link: <web address>#connect=...
export function connectLink(webUrl, server) {
  const base = String(webUrl || '').trim().replace(/#.*$/, '');
  return `${base}#connect=${b64url(JSON.stringify({ u: server.url, k: server.key }))}`;
}

export function readConnectFromHash() {
  const m = location.hash.match(/connect=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  try {
    const o = JSON.parse(unb64url(m[1]));
    history.replaceState(null, '', location.pathname + location.search);
    return o.u && o.k ? { url: o.u, key: o.k } : null;
  } catch {
    return null;
  }
}

export function timezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
