/**
 * Offline snapshot manager (#1355). Keeps the signed-in user's cellars, racks
 * and bottles on the device and answers the app's reads from them when the
 * network does not (utils/apiFetch → offlineAnswer).
 *
 *   refreshSnapshot  — fetch GET /api/offline/snapshot, store it, fetch photos
 *   offlineAnswer    — a Response for one GET from the stored snapshot, or null
 *   clearOfflineData — forget everything (logout, offline mode switched off)
 *
 * Only ever active with offline mode on (utils/offlineMode).
 */
import { indexSnapshot, answerOffline } from './offlineData';
import { readSnapshot, writeSnapshot, clearSnapshots } from './offlineStore';
import { isOfflineModeEnabled } from './offlineMode';
import { thumbUrl } from './thumbUrl';
import { getWineImageUrl } from './wineImageUrl';

export const SNAPSHOT_SCHEMA = 1;
export const PHOTO_CACHE = 'cellarion-photos';      // also named in public/service-worker.js
const PHOTO_BUDGET_BYTES = 25 * 1024 * 1024;         // prod 2026-09: the largest cellar needs ~7 MB

let current = null;           // { userId, idx, generatedAt }
let usingSaved = false;       // the last read was answered from the snapshot
const listeners = new Set();

function notify() {
  const status = getOfflineStatus();
  for (const fn of listeners) { try { fn(status); } catch { /* a listener's problem */ } }
}

/** { savedAt: ISO | null, usingSaved: boolean } */
export function getOfflineStatus() {
  return { savedAt: current?.generatedAt || null, usingSaved };
}

export function subscribeOfflineStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A real server answer arrived — the app is no longer showing the saved copy. */
export function markLive() {
  if (usingSaved) { usingSaved = false; notify(); }
}

async function loadIndex(userId) {
  const uid = String(userId);
  if (current?.userId === uid) return current.idx;
  const snap = await readSnapshot(uid);
  if (!snap || snap.schema !== SNAPSHOT_SCHEMA || String(snap.userId) !== uid) return null;
  current = { userId: uid, idx: indexSnapshot(snap), generatedAt: snap.generatedAt };
  notify();
  return current.idx;
}

/** Load the stored snapshot's timestamp for the banner (no network). */
export async function primeOfflineStatus(userId) {
  if (!userId || !isOfflineModeEnabled()) return;
  await loadIndex(userId);
}

/**
 * The offline answer to one GET as a Response (same shape as the server's),
 * or null. `X-Cellarion-Offline` carries when the copy was saved.
 */
export async function offlineAnswer(url, userId) {
  if (!userId || !isOfflineModeEnabled()) return null;
  const idx = await loadIndex(userId);
  const answer = idx && answerOffline(idx, url);
  if (!answer) return null;
  if (!usingSaved) { usingSaved = true; notify(); }
  return new Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers: { 'Content-Type': 'application/json', 'X-Cellarion-Offline': current.generatedAt || '' },
  });
}

/**
 * Fetch a fresh snapshot through the app's apiFetch and keep it. Returns true
 * when stored. Photos follow in the background.
 */
export async function refreshSnapshot(apiFetch, userId) {
  if (!userId || !isOfflineModeEnabled()) return false;
  let res;
  try { res = await apiFetch('/api/offline/snapshot'); } catch { return false; }
  if (!res.ok || res.headers?.get?.('X-Cellarion-Offline')) return false;
  let snap;
  try { snap = await res.json(); } catch { return false; }
  if (!snap || snap.schema !== SNAPSHOT_SCHEMA || String(snap.userId) !== String(userId)) return false;
  if (!(await writeSnapshot(snap))) return false;
  current = { userId: String(userId), idx: indexSnapshot(snap), generatedAt: snap.generatedAt };
  notify();
  syncPhotos(snap).catch(() => {});
  return true;
}

/** Card-size thumbnails of every photo the snapshot's bottles show. */
export function photoUrlsOf(snap) {
  const urls = new Set();
  const add = (raw) => {
    const full = raw ? getWineImageUrl(raw) : null;
    const thumb = full ? thumbUrl(full) : null;
    if (thumb && thumb !== full) urls.add(thumb);
  };
  for (const b of snap.bottles || []) { add(b.defaultImageUrl); add(b.pendingImageUrl); }
  for (const w of Object.values(snap.wines || {})) add(w?.image);
  return urls;
}

function metered() {
  const c = typeof navigator !== 'undefined' ? navigator.connection : null;
  return !!(c && (c.saveData || c.type === 'cellular' || /(^|-)2g$/.test(c.effectiveType || '')));
}

/**
 * Keep PHOTO_CACHE equal to the snapshot's thumbnails: drop the ones no longer
 * needed, fetch the missing ones up to the budget. Skipped on metered
 * connections (Save-Data, cellular — where the browser tells us).
 */
export async function syncPhotos(snap) {
  if (typeof caches === 'undefined' || metered()) return;
  const wanted = photoUrlsOf(snap);
  const cache = await caches.open(PHOTO_CACHE);
  let bytes = 0;
  const have = new Set();
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (!wanted.has(path)) { await cache.delete(req); continue; }
    have.add(path);
    const res = await cache.match(req);
    bytes += Number(res?.headers.get('Content-Length')) || 15000;
  }
  for (const url of wanted) {
    if (have.has(url)) continue;
    if (bytes >= PHOTO_BUDGET_BYTES) break;
    try {
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) continue;
      bytes += Number(res.headers.get('Content-Length')) || 15000;
      await cache.put(url, res);
    } catch {
      break; // the network went away — try again on the next refresh
    }
  }
}

/** Forget the offline copy on this device: snapshot and photos. */
export async function clearOfflineData() {
  current = null;
  usingSaved = false;
  await clearSnapshots();
  try { if (typeof caches !== 'undefined') await caches.delete(PHOTO_CACHE); } catch { /* noop */ }
  notify();
}
