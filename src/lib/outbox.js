// Changes made while offline wait here and are sent, in order, once the connection is back.
import * as store from './store.js';
import { sb, isOffline, friendly } from './supabase.js';
import { markOnline, invalidate } from './data.js';

const KEY = 'outbox';
let queue = null;
let flushing = false;
const subs = new Set();
let lastError = null;

async function load() {
  if (!queue) queue = (await store.get(KEY)) || [];
  return queue;
}
async function persist() {
  await store.set(KEY, queue);
  subs.forEach((f) => f());
}

export async function pending() {
  return (await load()).length;
}
export function subscribe(f) {
  subs.add(f);
  return () => subs.delete(f);
}
export function getLastError() {
  return lastError;
}

// item: { kind: 'rpc', fn, args, dedupe? } | { kind: 'upload', bucket, path, blobKey, contentType } | { kind: 'insert', table, row }
export async function enqueue(item) {
  await load();
  if (item.dedupe) queue = queue.filter((q) => q.dedupe !== item.dedupe);
  queue.push({ ...item, id: crypto.randomUUID(), at: Date.now() });
  await persist();
}

async function send(item) {
  const c = sb();
  if (item.kind === 'rpc') {
    const { error } = await c.rpc(item.fn, item.args);
    return error;
  }
  if (item.kind === 'insert') {
    const { error } = await c.from(item.table).insert(item.row);
    return error;
  }
  if (item.kind === 'upload') {
    const blob = await store.blobs.get(item.blobKey);
    if (!blob) return null;
    const { error } = await c.storage.from(item.bucket).upload(item.path, await blob.arrayBuffer(), { contentType: item.contentType, upsert: true });
    return error;
  }
  return null;
}

export async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    await load();
    while (queue.length) {
      const item = queue[0];
      let error;
      try {
        error = await send(item);
      } catch (e) {
        error = e;
      }
      if (error && isOffline(error)) {
        markOnline(false);
        break;
      }
      if (error) {
        // The server refused (e.g. time was up). Drop it and tell the person.
        lastError = { item, message: friendly(error) };
      }
      queue.shift();
      await persist();
      markOnline(true);
    }
    invalidate('attempt', 'myattempts', 'comments');
  } finally {
    flushing = false;
  }
}

// Try now; if the connection is down, queue it.
export async function sendOrQueue(item) {
  await load();
  if (queue.length === 0) {
    try {
      const error = await send(item);
      if (!error) {
        markOnline(true);
        return { sent: true };
      }
      if (!isOffline(error)) {
        const e = new Error(friendly(error));
        e.raw = error;
        throw e;
      }
    } catch (e) {
      if (!isOffline(e)) throw e;
    }
    markOnline(false);
  }
  await enqueue(item);
  if (navigator.onLine) flush();
  return { queued: true };
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => flush());
  setInterval(() => {
    if (queue && queue.length && navigator.onLine) flush();
  }, 20000);
}
