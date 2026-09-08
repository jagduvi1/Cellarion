/**
 * Registry Bridge — the HTTP client a SELF-HOSTED Cellarion uses to reach the
 * shared registry on cellarion.app (protocol v1, docs/registry-bridge.md).
 *
 * Off unless REGISTRY_BRIDGE_KEY is set. Transport only: every call returns a
 * plain result or null, never throws into a request handler — a self-hoster
 * adding a bottle must not see a 500 because the hosted side is unreachable
 * (local-only is the graceful state). The domain logic (adopting a wine,
 * refreshing copies, forwarding contributions) lives in registryBridge.js.
 *
 * Quota answers (429) and a dead key (401) are remembered briefly so a burst
 * of add-bottle searches does not hammer a closed door; the Settings panel
 * reads the same state to explain it.
 */
const DEFAULT_URL = 'https://cellarion.app';
const KEY_PREFIX = 'cbr_';
const TIMEOUT_MS = 8000;
const SEARCH_CACHE_TTL_MS = 60 * 1000;
const SEARCH_CACHE_MAX = 500;
const BACKOFF_MS = { quota: 5 * 60 * 1000, burst: 30 * 1000, rate_limited: 60 * 1000, invalid_key: 10 * 60 * 1000, no_key: 10 * 60 * 1000 };

const searchCache = new Map(); // q -> { at, wines }
let blockedUntil = 0;
let blockedReason = null;
let lastError = null;

function trimSlash(s) { return String(s || '').replace(/\/+$/, ''); }

function config() {
  const key = (process.env.REGISTRY_BRIDGE_KEY || '').trim();
  const url = trimSlash(process.env.REGISTRY_BRIDGE_URL || DEFAULT_URL);
  const own = trimSlash(process.env.FRONTEND_URL || '');
  const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return null; } };
  const selfTarget = !!own && hostOf(own) === hostOf(url);
  return {
    url,
    key,
    keyPrefix: key ? key.slice(0, 12) : null,
    // A key that is not a bridge key, or a bridge pointed at this very
    // install, is misconfiguration — disabled, and the status says why.
    enabled: !!key && key.startsWith(KEY_PREFIX) && !selfTarget,
    reason: !key ? 'no_key' : !key.startsWith(KEY_PREFIX) ? 'bad_key' : selfTarget ? 'self_target' : null,
    instanceHost: hostOf(own),
  };
}

function isEnabled() { return config().enabled; }

/** What the Settings panel and the status route show about the transport. */
function transportState() {
  const c = config();
  return {
    enabled: c.enabled,
    reason: c.reason,
    url: c.url,
    keyPrefix: c.keyPrefix,
    blocked: Date.now() < blockedUntil ? { reason: blockedReason, until: new Date(blockedUntil) } : null,
    lastError,
  };
}

function block(reason) {
  const ms = BACKOFF_MS[reason] || BACKOFF_MS.rate_limited;
  blockedUntil = Date.now() + ms;
  blockedReason = reason;
}

/**
 * One call to the hosted side. Returns { ok: true, status, body } or
 * { ok: false, status, code, message }; null when the bridge is off or
 * backing off. Network failures are { ok: false, status: 0, code: 'network' }.
 */
async function request(path, { method = 'GET', body, timeoutMs = TIMEOUT_MS } = {}) {
  const c = config();
  if (!c.enabled) return null;
  if (Date.now() < blockedUntil) return { ok: false, status: 0, code: blockedReason, message: 'bridge backing off' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${c.url}/api/bridge/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${c.key}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(c.instanceHost ? { 'X-Cellarion-Instance': c.instanceHost } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) { lastError = null; return { ok: true, status: res.status, body: json }; }
    const code = json.code || (res.status === 401 ? 'invalid_key' : res.status === 429 ? 'rate_limited' : 'error');
    if (res.status === 401 || res.status === 429) block(code);
    lastError = { at: new Date(), status: res.status, code, message: json.error || null };
    return { ok: false, status: res.status, code, message: json.error || null };
  } catch (err) {
    lastError = { at: new Date(), status: 0, code: 'network', message: err.name === 'AbortError' ? 'timeout' : err.message };
    return { ok: false, status: 0, code: 'network', message: lastError.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Up to 10 registry identities for a query; cached 60 s to spare the quota. */
async function search(q) {
  const query = String(q || '').trim();
  if (query.length < 2) return [];
  const hit = searchCache.get(query.toLowerCase());
  if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL_MS) return hit.wines;
  const r = await request(`/search?q=${encodeURIComponent(query)}`);
  if (!r || !r.ok) return [];
  const wines = Array.isArray(r.body.wines) ? r.body.wines : [];
  if (searchCache.size >= SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
  searchCache.set(query.toLowerCase(), { at: Date.now(), wines });
  return wines;
}

/** One wine in full, or null (not found, off, or unreachable). */
async function fetchWine(registryId) {
  if (!/^[a-f0-9]{24}$/i.test(String(registryId))) return null;
  const r = await request(`/wines/${registryId}`);
  if (!r || !r.ok) return r && r.status === 404 ? { removed: true } : null;
  return r.body.wine || null;
}

/** Which of these ids changed since `since` — chunked at the protocol's cap. */
async function changes(ids, since) {
  const out = { changed: [], removed: [], checked: 0, failed: false };
  for (let i = 0; i < ids.length; i += 5000) {
    const chunk = ids.slice(i, i + 5000);
    const r = await request('/wines/changes', { method: 'POST', body: { ids: chunk, since: since ? new Date(since).toISOString() : undefined } });
    if (!r || !r.ok) { out.failed = true; break; }
    out.changed.push(...(r.body.changed || []));
    out.removed.push(...(r.body.removed || []));
    out.checked += r.body.checked || chunk.length;
  }
  return out;
}

async function me() {
  const r = await request('/me');
  return r && r.ok ? r.body : null;
}

const forwardRequest = (payload) => request('/requests', { method: 'POST', body: payload });
const forwardCorrection = (payload) => request('/corrections', { method: 'POST', body: payload });
const forwardValue = (payload) => request('/values', { method: 'POST', body: payload });

/** Test hook: forget cached searches and any backoff. */
function _reset() { searchCache.clear(); blockedUntil = 0; blockedReason = null; lastError = null; }

module.exports = {
  config, isEnabled, transportState, request, search, fetchWine, changes, me,
  forwardRequest, forwardCorrection, forwardValue, _reset,
  DEFAULT_URL, TIMEOUT_MS, SEARCH_CACHE_TTL_MS,
};
