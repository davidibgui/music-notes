// ספריית השירים: במכשיר (IndexedDB) או בענן (Supabase) כשמחוברים.
import * as cloud from './cloud.js';

function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('music-notes', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
      if (!d.objectStoreNames.contains('songs')) d.createObjectStore('songs', { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function tx(store, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
  }));
}

export const local = {
  list: async () => {
    const all = (await tx('songs', 'readonly', (s) => s.getAll())) || [];
    return all.map(({ id, title, updatedAt, createdAt }) => ({ id, title, updatedAt, createdAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },
  get: (id) => tx('songs', 'readonly', (s) => s.get(id)),
  put: async (song, audio) => {
    const prev = audio ? null : await tx('songs', 'readonly', (s) => s.get(song.id));
    const rec = { ...song, audio: audio || prev?.audio || null, updatedAt: Date.now() };
    await tx('songs', 'readwrite', (s) => s.put(rec));
  },
  remove: (id) => tx('songs', 'readwrite', (s) => s.delete(id)),
  getFile: (key) => tx('files', 'readonly', (s) => s.get(key)),
  removeFile: (key) => tx('files', 'readwrite', (s) => s.delete(key)),
};

export const useCloud = () => !!cloud.user;

export async function listSongs() {
  return useCloud() ? cloud.listSongs() : local.list();
}
export async function getSong(id) {
  return useCloud() ? cloud.getSong(id) : local.get(id);
}
/** audio: Blob רק כשצריך לשמור/להחליף את קובץ השמע */
export async function saveSong(song, audio) {
  return useCloud() ? cloud.saveSong(song, audio) : local.put(song, audio);
}
export async function deleteSong(id) {
  return useCloud() ? cloud.deleteSong(id) : local.remove(id);
}

/** העברת כל השירים מהמכשיר לחשבון בענן. */
export async function migrateLocalToCloud(onProgress) {
  const list = await local.list();
  let done = 0;
  for (const meta of list) {
    const song = await local.get(meta.id);
    const { audio, ...rest } = song;
    await cloud.saveSong(rest, audio || null);
    await local.remove(meta.id);
    onProgress?.(++done, list.length);
  }
  return done;
}
