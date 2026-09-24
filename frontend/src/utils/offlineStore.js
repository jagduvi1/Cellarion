/**
 * Device storage for the offline snapshot (#1355): one IndexedDB record per
 * account. IndexedDB, not localStorage — a large cellar's snapshot runs to
 * megabytes, and localStorage is small and synchronous.
 *
 * Every call degrades to "nothing stored" when IndexedDB is unavailable
 * (private windows on some browsers, blocked site data) — offline reads then
 * simply don't happen, and nothing else breaks.
 */
const DB_NAME = 'cellarion-offline';
const STORE = 'snapshots';
// Set once anything is stored, so clearing on logout never opens (and thereby
// creates) the database on a device that never used offline mode.
const STORED_MARK = 'cellarion-offline-stored';

function mark(on) {
  try { if (on) localStorage.setItem(STORED_MARK, '1'); else localStorage.removeItem(STORED_MARK); } catch { /* noop */ }
}
function marked() {
  try { return localStorage.getItem(STORED_MARK) === '1'; } catch { return true; }
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'userId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const result = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export async function readSnapshot(userId) {
  if (!marked()) return null;
  try { return (await tx('readonly', (s) => s.get(String(userId)))) || null; } catch { return null; }
}

export async function writeSnapshot(snapshot) {
  try { mark(true); await tx('readwrite', (s) => s.put(snapshot)); return true; } catch { return false; }
}

/** Delete every stored snapshot (logout, offline mode switched off). */
export async function clearSnapshots() {
  if (!marked()) return;
  try { await tx('readwrite', (s) => s.clear()); mark(false); } catch { /* nothing stored */ }
}
