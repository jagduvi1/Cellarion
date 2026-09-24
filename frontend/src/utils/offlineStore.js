/**
 * Device storage for offline mode (#1355), in IndexedDB — not localStorage: a
 * large cellar's snapshot runs to megabytes, and localStorage is small and
 * synchronous.
 *   snapshots — one record per account (the cellar copy)
 *   queue     — writes made offline, waiting to be sent (utils/offlineQueue)
 *
 * Every call degrades to "nothing stored" when IndexedDB is unavailable
 * (private windows on some browsers, blocked site data) — offline reads and
 * writes then simply don't happen, and nothing else breaks.
 */
const DB_NAME = 'cellarion-offline';
const DB_VERSION = 2;
const SNAPSHOTS = 'snapshots';
const QUEUE = 'queue';
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
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SNAPSHOTS)) db.createObjectStore(SNAPSHOTS, { keyPath: 'userId' });
      if (!db.objectStoreNames.contains(QUEUE)) db.createObjectStore(QUEUE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const result = fn(t.objectStore(store));
      t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

// ── Snapshots ──────────────────────────────────────────────────────────────
export async function readSnapshot(userId) {
  if (!marked()) return null;
  try { return (await tx(SNAPSHOTS, 'readonly', (s) => s.get(String(userId)))) || null; } catch { return null; }
}

export async function writeSnapshot(snapshot) {
  try { mark(true); await tx(SNAPSHOTS, 'readwrite', (s) => s.put(snapshot)); return true; } catch { return false; }
}

// ── Queue ──────────────────────────────────────────────────────────────────
export async function readQueue() {
  if (!marked()) return [];
  try { return (await tx(QUEUE, 'readonly', (s) => s.getAll())) || []; } catch { return []; }
}

export async function putQueued(op) {
  try { mark(true); await tx(QUEUE, 'readwrite', (s) => s.put(op)); return true; } catch { return false; }
}

export async function deleteQueued(id) {
  try { await tx(QUEUE, 'readwrite', (s) => s.delete(id)); } catch { /* gone */ }
}

// ── Clearing ───────────────────────────────────────────────────────────────
/**
 * Delete the stored snapshots (logout, offline mode switched off) and, unless
 * `keepQueue`, the queued writes too. An automatic sign-out keeps the queue so
 * the same user's changes still go out after they sign back in.
 */
export async function clearSnapshots({ keepQueue = false } = {}) {
  if (!marked()) return;
  try {
    await tx(SNAPSHOTS, 'readwrite', (s) => s.clear());
    if (!keepQueue) {
      await tx(QUEUE, 'readwrite', (s) => s.clear());
      mark(false);
    }
  } catch { /* nothing stored */ }
}
