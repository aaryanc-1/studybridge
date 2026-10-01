import { createClient } from '@supabase/supabase-js';
import { getServer } from './config.js';

let client = null;
let clientFor = '';

export function sb() {
  const s = getServer();
  if (!s) throw new Error('No server set up yet.');
  const id = s.url + '|' + s.key;
  if (!client || clientFor !== id) {
    client = createClient(s.url, s.key, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'sb.auth', detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 5 } },
    });
    clientFor = id;
  }
  return client;
}

export function resetClient() {
  client = null;
  clientFor = '';
}

// Network trouble (as opposed to the server saying no)
export function isOffline(err) {
  if (!err) return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const m = String(err.message || err);
  return err.status === 0 || /Failed to fetch|FetchError|NetworkError|Load failed|network|ECONNREFUSED|fetch failed|timed out/i.test(m);
}

// Turn Supabase errors into sentences people can act on
export function friendly(err) {
  if (!err) return '';
  if (isOffline(err)) return 'You’re offline. This will work again once you’re connected.';
  const m = String(err.message || err.msg || err.error_description || err);
  if (/User is banned|user_banned/i.test(m)) return 'This account is paused. Contact StudyBridge if you think this is a mistake.';
  if (/Invalid login credentials/i.test(m)) return 'That email and password don’t match. Check them and try again.';
  if (/already registered|already exists/i.test(m)) return 'There’s already an account with that email. Sign in instead.';
  if (/Email not confirmed/i.test(m)) return 'This account still needs its email confirmed. Your tutor can turn off “Confirm email” in Supabase, or open the link in your inbox.';
  if (/Password should be at least/i.test(m)) return 'Use a password of at least 6 characters.';
  if (/row-level security|permission denied/i.test(m)) return 'You don’t have access to do that.';
  if (/JWT expired|invalid JWT/i.test(m)) return 'Your sign-in expired. Sign in again.';
  if (/relation .* does not exist|Could not find the (table|function)/i.test(m)) return 'The database isn’t set up yet. Run setup.sql in Supabase (see the setup guide).';
  return m.replace(/^.*?ERROR:\s*/, '');
}

// Unwrap { data, error } and throw readable errors
export async function run(p) {
  const { data, error } = await p;
  if (error) {
    const e = new Error(friendly(error));
    e.offline = isOffline(error);
    e.raw = error;
    throw e;
  }
  return data;
}
