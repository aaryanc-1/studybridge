// Local storage on this device (IndexedDB): cached data for offline use,
// answers in progress, queued changes and downloaded files.
const DB_NAME = 'studybridge';
const STORES = ['kv', 'blobs'];
let dbp = null;
const mem = { kv: new Map(), blobs: new Map() };
let broken = false;

function open() {
  if (broken || typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (!dbp) {
    dbp = new Promise((resolve) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        broken = true;
        resolve(null);
      };
    });
  }
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  if (!db) return fn(null);
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((r) => (out = r));
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const reqP = (r) => new Promise((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));

export async function get(key, store = 'kv') {
  const db = await open();
  if (!db) return mem[store].get(key);
  return tx(store, 'readonly', (s) => reqP(s.get(key)));
}

export async function set(key, value, store = 'kv') {
  const db = await open();
  if (!db) return void mem[store].set(key, value);
  return tx(store, 'readwrite', (s) => void s.put(value, key));
}

export async function del(key, store = 'kv') {
  const db = await open();
  if (!db) return void mem[store].delete(key);
  return tx(store, 'readwrite', (s) => void s.delete(key));
}

export async function keys(prefix = '', store = 'kv') {
  const db = await open();
  const all = db ? await tx(store, 'readonly', (s) => reqP(s.getAllKeys())) : [...mem[store].keys()];
  return all.filter((k) => String(k).startsWith(prefix));
}

export async function clearAll() {
  const db = await open();
  if (!db) {
    mem.kv.clear();
    mem.blobs.clear();
    return;
  }
  for (const s of STORES) await tx(s, 'readwrite', (st) => void st.clear());
}

export const blobs = {
  get: (k) => get(k, 'blobs'),
  set: (k, v) => set(k, v, 'blobs'),
  del: (k) => del(k, 'blobs'),
  keys: (p) => keys(p, 'blobs'),
};
