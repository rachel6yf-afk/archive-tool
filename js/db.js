// Minimal promise wrapper around IndexedDB. Stores: items, notes, timeline, meta.
const DB_NAME = 'archive-ocr', VERSION = 1;
let dbp;
export function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of ['items', 'notes', 'timeline']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
export const getAll = (store) => tx(store, 'readonly', (s) => req(s.getAll()));
export const get = (store, id) => tx(store, 'readonly', (s) => req(s.get(id)));
export const put = (store, obj) => tx(store, 'readwrite', (s) => { s.put(obj); });
export const putMany = (store, arr) => tx(store, 'readwrite', (s) => { for (const o of arr) s.put(o); });
export const del = (store, id) => tx(store, 'readwrite', (s) => { s.delete(id); });
export const clear = (store) => tx(store, 'readwrite', (s) => { s.clear(); });
export const uid = (p = '') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
