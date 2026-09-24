/**
 * Offline write queue (#1355). A queueable write (utils/offlineOps) that the
 * network can't take is stored on the device, applied to the device's copy at
 * once (the page carries on as if it had succeeded), and sent — in order, with
 * its Idempotency-Key and the preconditions of what the user saw — once the
 * network is back.
 *
 * Outcomes when sending:
 *   2xx                           → done, removed
 *   network error / 5xx / 429 /
 *   409 "in progress" / 401       → stays pending, sending stops until next time
 *   any other 4xx (the cellar
 *   changed meanwhile, a rule)    → "needs attention": the user chooses
 *                                   (discard / try again / apply anyway)
 * Nothing is ever dropped without the user seeing it. Ops are per account and
 * only ever sent for the account that made them; one left 7 days is dropped.
 */
import { putQueued, deleteQueued, readQueue } from './offlineStore';
import { buildOp, queueableKind, responseFor } from './offlineOps';
import { getWorkingIndex, rebuildWorking } from './offlineSnapshot';
import { isOfflineModeEnabled } from './offlineMode';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SENT_KEEP_MS = 60 * 60 * 1000;
export const QUEUE_CHANGED_EVENT = 'cellarion-offline-queue';

let status = { pending: 0, attention: 0, syncing: false };
const listeners = new Set();

function notify() {
  for (const fn of listeners) { try { fn(status); } catch { /* a listener's problem */ } }
}
export function getQueueStatus() { return status; }
export function subscribeQueueStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Recount this user's queue (and drop ops older than a week). */
export async function refreshQueueStatus(userId) {
  const all = await readQueue();
  const now = Date.now();
  const mine = [];
  for (const op of all) {
    if (now - Date.parse(op.createdAt) > MAX_AGE_MS) { await deleteQueued(op.id); continue; }
    // A sent op whose confirming refresh never came (offline mode switched
    // off meanwhile, …): the server has it; stop laying it over the copy.
    if (op.status === 'sent' && now - Date.parse(op.sentAt) > SENT_KEEP_MS) { await deleteQueued(op.id); continue; }
    if (String(op.userId) === String(userId)) mine.push(op);
  }
  status = {
    ...status,
    pending: mine.filter((o) => o.status === 'pending').length,
    attention: mine.filter((o) => o.status === 'attention').length,
  };
  notify();
  return mine;
}

/** The user's ops that need their decision, oldest first. */
export async function listAttention(userId) {
  return (await refreshQueueStatus(userId))
    .filter((o) => o.status === 'attention')
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

function newKey() {
  try { return crypto.randomUUID().replace(/-/g, ''); } catch { /* old browser */ }
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

/**
 * An Idempotency-Key for a write that could be queued, or null. The LIVE
 * attempt carries it too: if that request reached the server but its reply
 * never came back, the queued retry is answered with the stored result instead
 * of being applied twice.
 */
export function writeKeyFor(url, method, userId) {
  if (!userId || !isOfflineModeEnabled() || !queueableKind(url, method)) return null;
  return newKey();
}

/**
 * Queue a write the network could not take. Returns the Response the page
 * expects (built from the device copy with the write applied), or null when
 * it cannot be queued — the caller then fails as before.
 */
export async function queueWrite({ url, method, body, key, userId }) {
  if (!key || !userId || !isOfflineModeEnabled()) return null;
  const idx = await getWorkingIndex(userId);
  if (!idx) return null;
  let parsed = null;
  try { parsed = typeof body === 'string' ? JSON.parse(body) : body || null; } catch { return null; }
  const op = buildOp({ url, method, body: parsed, idx, id: key, userId });
  if (!op) return null;
  if (!(await putQueued(op))) return null;
  const after = await rebuildWorking(userId);
  await refreshQueueStatus(userId);
  announce();
  return new Response(JSON.stringify(responseFor(op, after, idx)), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-Cellarion-Offline': 'queued' },
  });
}

function announce() {
  try { window.dispatchEvent(new Event(QUEUE_CHANGED_EVENT)); } catch { /* noop */ }
}

let flushing = false;

/**
 * Send this user's pending writes, oldest first. `apiFetch` is the app's own
 * (auth + refresh); `__direct` keeps it from queueing them again. Returns the
 * number sent. Across tabs a Web Lock makes sure only one tab sends.
 */
export async function flushQueue(apiFetch, userId) {
  if (!userId || flushing || !isOfflineModeEnabled()) return 0;
  const run = async () => {
    flushing = true;
    status = { ...status, syncing: true };
    notify();
    let sent = 0;
    try {
      const ops = (await refreshQueueStatus(userId))
        .filter((o) => o.status === 'pending')
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      for (const op of ops) {
        let res;
        try {
          res = await apiFetch(op.url, {
            method: op.method,
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': op.id },
            body: op.body ? JSON.stringify(op.body) : undefined,
            __direct: true,
          });
        } catch {
          break; // still offline — try again later
        }
        if (res.ok) {
          // Kept, as 'sent', laid over the device copy until a copy fetched
          // after now arrives (offlineSnapshot.refreshSnapshot) — otherwise a
          // bottle just consumed would reappear until the next refresh.
          await putQueued({ ...op, status: 'sent', sentAt: new Date().toISOString() });
          sent++;
          continue;
        }
        const busy = res.status === 409 && res.headers?.get?.('Retry-After');
        if (res.status >= 500 || res.status === 429 || res.status === 401 || busy) break;
        let data = {};
        try { data = await res.json(); } catch { /* not JSON */ }
        await putQueued({
          ...op,
          status: 'attention',
          error: data.error || `HTTP ${res.status}`,
          code: data.code || null,
          current: data.current || null,
          httpStatus: res.status,
        });
      }
    } finally {
      await rebuildWorking(userId);
      await refreshQueueStatus(userId);
      flushing = false;
      status = { ...status, syncing: false };
      notify();
      if (sent) {
        announce();
        // The server now holds these changes: bring the device copy up to date.
        try { window.dispatchEvent(new Event('cellarion-api-mutation')); } catch { /* noop */ }
      }
    }
    return sent;
  };
  try {
    if (navigator.locks?.request) {
      return await navigator.locks.request('cellarion-offline-queue', { ifAvailable: true }, (lock) => (lock ? run() : 0));
    }
  } catch { /* fall through */ }
  return run();
}

/** Strip the "what I saw" preconditions: apply the change to the cellar as it is now. */
function withoutPreconditions(op) {
  const body = op.body ? { ...op.body } : null;
  if (body) {
    delete body.ifActive;
    delete body.ifUnchanged;
    delete body.expectOccupant;
    delete body.expectFrom;
    delete body.expectTo;
  }
  return { ...op, body, url: op.url.split('?')[0] };
}

/**
 * The user's decision on an op that needs attention:
 *   'discard' — drop it;  'retry' — send it again as it was;
 *   'force'   — send it without its preconditions (keep mine / apply anyway).
 * A retried op gets a new key: the old one's stored answer is the refusal.
 */
export async function resolveAttention(opId, action, userId) {
  const op = (await readQueue()).find((o) => o.id === opId && String(o.userId) === String(userId));
  if (!op) return;
  if (action === 'discard') {
    await deleteQueued(op.id);
  } else {
    const next = action === 'force' ? withoutPreconditions(op) : op;
    await deleteQueued(op.id);
    await putQueued({
      ...next, id: newKey(), status: 'pending', error: null, code: null, current: null, httpStatus: null,
    });
  }
  await rebuildWorking(userId);
  await refreshQueueStatus(userId);
  announce();
}
