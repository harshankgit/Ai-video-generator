// Tiny IndexedDB wrapper. Everything (projects, images, voice, final videos)
// is stored in the user's own browser, so it stays after download/refresh.

const DB_NAME = 'ai-story-studio';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let result;
        const r = fn(s);
        if (r && typeof r === 'object' && 'onsuccess' in r) r.onsuccess = () => (result = r.result);
        else result = r;
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('IndexedDB aborted (storage full?)'));
      }),
  );
}

export const db = {
  saveProject(p) {
    p.updatedAt = Date.now();
    return tx('projects', 'readwrite', (s) => s.put(JSON.parse(JSON.stringify(p))));
  },
  getProject(id) {
    return tx('projects', 'readonly', (s) => s.get(id));
  },
  async listProjects() {
    const all = await tx('projects', 'readonly', (s) => s.getAll());
    return (all || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  },
  async deleteProject(id) {
    await tx('projects', 'readwrite', (s) => s.delete(id));
    await this.deleteBlobsWithPrefix(id + '/');
  },
  putBlob(key, blob) {
    return tx('blobs', 'readwrite', (s) => s.put(blob, key));
  },
  getBlob(key) {
    return tx('blobs', 'readonly', (s) => s.get(key));
  },
  deleteBlob(key) {
    return tx('blobs', 'readwrite', (s) => s.delete(key));
  },
  deleteBlobsWithPrefix(prefix) {
    const range = IDBKeyRange.bound(prefix, prefix + '\uffff');
    return tx('blobs', 'readwrite', (s) => s.delete(range));
  },
  async estimate() {
    if (navigator.storage?.estimate) return navigator.storage.estimate();
    return null;
  },
  async persist() {
    try {
      if (navigator.storage?.persist) return await navigator.storage.persist();
    } catch {}
    return false;
  },
};
