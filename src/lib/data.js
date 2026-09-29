// Data on screen: show the saved copy instantly (works offline), then refresh from the server.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as store from './store.js';

let scope = 'anon';
const cache = new Map(); // key -> data
const fetchers = new Map(); // key -> Set(run)
const inflight = new Map();

export function setScope(uid) {
  scope = uid || 'anon';
  cache.clear();
}

// ---- online status ----
let online = typeof navigator === 'undefined' ? true : navigator.onLine;
const onlineSubs = new Set();
function setOnline(v) {
  if (v === online) return;
  online = v;
  onlineSubs.forEach((f) => f());
}
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => setOnline(true));
  window.addEventListener('offline', () => setOnline(false));
}
export const markOnline = setOnline;
export const isOnline = () => online;
export function useOnline() {
  return useSyncExternalStore(
    (f) => (onlineSubs.add(f), () => onlineSubs.delete(f)),
    () => online,
  );
}

async function load(key, fetcher) {
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const d = await fetcher();
      cache.set(key, d);
      setOnline(true);
      store.set(`q:${scope}:${key}`, d).catch(() => {});
      return { data: d };
    } catch (e) {
      if (e.offline) setOnline(false);
      return { error: e };
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export function useQuery(key, fetcher, { enabled = true, poll = 0 } = {}) {
  const [state, setState] = useState(() => ({
    data: key && cache.has(key) ? cache.get(key) : undefined,
    error: null,
    loading: !!key && !cache.has(key),
    stale: false,
  }));
  const fref = useRef(fetcher);
  fref.current = fetcher;

  const run = useCallback(async () => {
    if (!key || !enabled) return;
    const r = await load(key, () => fref.current());
    setState((s) =>
      r.error
        ? { ...s, error: s.data === undefined ? r.error : null, loading: false, stale: true }
        : { data: r.data, error: null, loading: false, stale: false },
    );
  }, [key, enabled]);

  useEffect(() => {
    if (!key || !enabled) return;
    let alive = true;
    if (cache.has(key)) setState({ data: cache.get(key), error: null, loading: false, stale: false });
    else {
      setState({ data: undefined, error: null, loading: true, stale: false });
      store.get(`q:${scope}:${key}`).then((d) => {
        if (alive && d !== undefined && !cache.has(key)) setState((s) => (s.data === undefined ? { ...s, data: d, loading: false, stale: true } : s));
      });
    }
    run();
    if (!fetchers.has(key)) fetchers.set(key, new Set());
    fetchers.get(key).add(run);
    const t = poll ? setInterval(run, poll) : null;
    return () => {
      alive = false;
      fetchers.get(key)?.delete(run);
      if (t) clearInterval(t);
    };
  }, [key, enabled, run, poll]);

  const mutate = useCallback(
    (fn) => {
      setState((s) => {
        const d = typeof fn === 'function' ? fn(s.data) : fn;
        cache.set(key, d);
        store.set(`q:${scope}:${key}`, d).catch(() => {});
        return { ...s, data: d };
      });
    },
    [key],
  );

  return { ...state, refresh: run, mutate };
}

// Re-fetch every query whose key starts with one of the prefixes
export function invalidate(...prefixes) {
  for (const [k, runs] of fetchers) {
    if (prefixes.length === 0 || prefixes.some((p) => k === p || k.startsWith(p + ':') || k.startsWith(p + '/'))) {
      runs.forEach((r) => r());
    }
  }
}

export function peek(key) {
  return cache.get(key);
}
