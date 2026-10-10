/**
 * Feature flags and early access.
 *
 * A larger change can ship to the users who chose "Try new features early"
 * (User.preferences.earlyAccess) before everyone gets it. Each flagged
 * feature has one state, set by a super admin without a deploy:
 *
 *   off      — nobody sees it: unfinished work can be merged and deployed
 *   beta     — only users with early access on
 *   everyone — all users; the flag and the branches it guards are deleted
 *              from the code in a later cleanup
 *
 * The user has ONE switch for all of them; there is no per-feature opt-in.
 *
 * The rule every flagged feature keeps: a flag changes what the screen
 * shows, never how data is stored. Whatever a beta screen saves lands in
 * fields the ordinary screens already read and edit, so switching early
 * access off — or dropping the feature — loses nothing. The server never
 * treats a beta user differently when saving, and data migrations are never
 * flagged.
 *
 * FEATURES is what the CODE knows. The live state of each flag is stored in
 * SiteConfig under 'featureFlags' ({ [key]: { state, betaAt, releasedAt,
 * forumPath, betaNotifiedAt, releasedNotifiedAt } }), cached in memory and
 * hot-reloaded on save like the announcement banner. A flag with no stored
 * row runs in its defaultState.
 */

const STATES = Object.freeze(['off', 'beta', 'everyone']);

// `title` is the English name admins see (the SuperAdmin panel, the subject
// of a beta-feedback ticket); users read the translated name from the
// frontend (earlyAccess.features.<key>.name). `since` is the day the flag
// entered the code — the "in beta since" date until a super admin moves it.
const FEATURES = Object.freeze([
  Object.freeze({
    key: 'vintagePage',
    title: 'One page per wine and vintage',
    defaultState: 'beta',
    since: '2026-10-10',
  }),
]);

const FEATURE_KEYS = Object.freeze(FEATURES.map((f) => f.key));

let stored = {};

function toIso(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// One stored row, cleaned: unknown states fall back to the default, dates to
// ISO strings, anything else is dropped.
function cleanRow(feature, row) {
  const r = row && typeof row === 'object' ? row : {};
  return {
    state: STATES.includes(r.state) ? r.state : feature.defaultState,
    betaAt: toIso(r.betaAt),
    releasedAt: toIso(r.releasedAt),
    forumPath: typeof r.forumPath === 'string' && r.forumPath ? r.forumPath : null,
    betaNotifiedAt: toIso(r.betaNotifiedAt),
    releasedNotifiedAt: toIso(r.releasedNotifiedAt),
  };
}

async function load() {
  try {
    // Lazy require to avoid a circular dependency at module load time.
    const SiteConfig = require('../models/SiteConfig');
    const doc = await SiteConfig.findOne({ key: 'featureFlags' }).lean();
    const value = doc && doc.value && typeof doc.value === 'object' ? doc.value : {};
    const next = {};
    for (const f of FEATURES) if (value[f.key]) next[f.key] = cleanRow(f, value[f.key]);
    stored = next;
  } catch (err) {
    console.warn('[featureFlags] Could not load config from DB, using defaults:', err.message);
  }
}

function featureOf(key) {
  return FEATURES.find((f) => f.key === key) || null;
}

// The flag as everything else reads it: its state, when it entered beta and
// when it went to everyone, and the forum thread a super admin linked. A
// flag that started in beta in the code reports the day it entered the code;
// one moved straight to everyone was never in beta and says so (null).
function get(key) {
  const f = featureOf(key);
  if (!f) return null;
  const row = stored[key] || cleanRow(f, null);
  return {
    key: f.key,
    title: f.title,
    state: row.state,
    betaAt: row.betaAt || (row.state === 'beta' ? toIso(f.since) : null),
    releasedAt: row.releasedAt,
    forumPath: row.forumPath,
    betaNotifiedAt: row.betaNotifiedAt,
    releasedNotifiedAt: row.releasedNotifiedAt,
  };
}

function list() {
  return FEATURES.map((f) => get(f.key));
}

// The keys a user sees: every feature out for everyone, plus the ones in
// beta when the user turned early access on.
function enabledKeys(earlyAccess) {
  return list()
    .filter((f) => f.state === 'everyone' || (f.state === 'beta' && earlyAccess === true))
    .map((f) => f.key);
}

// Replace the stored rows (the super-admin route saves through here after
// writing SiteConfig), keeping only known features.
function set(value) {
  const next = {};
  const v = value && typeof value === 'object' ? value : {};
  for (const f of FEATURES) if (v[f.key]) next[f.key] = cleanRow(f, v[f.key]);
  stored = next;
}

// The rows as SiteConfig stores them.
function storedValue() {
  const out = {};
  for (const f of FEATURES) out[f.key] = { ...(stored[f.key] || cleanRow(f, null)) };
  return out;
}

// The forum thread a super admin links to a beta feature, kept as an in-app
// path because Settings renders it as an in-app link. A full link to this
// site (or to cellarion.app) is cut down to its path; a link to any other
// site is refused. Empty clears it. Returns { ok, value } or { ok, error }.
const FORUM_PATH_MAX = 300;
function parseForumPath(input) {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (typeof input !== 'string') return { ok: false, error: 'forumPath must be a string' };
  const raw = input.trim();
  if (!raw) return { ok: true, value: null };
  if (raw.length > FORUM_PATH_MAX) return { ok: false, error: `forumPath must be ${FORUM_PATH_MAX} characters or fewer` };
  let path = raw;
  if (/^https?:\/\//i.test(raw)) {
    let url;
    try { url = new URL(raw); } catch { return { ok: false, error: 'forumPath is not a valid link' }; }
    const ownHosts = new Set(['cellarion.app', 'www.cellarion.app']);
    try { ownHosts.add(new URL(process.env.FRONTEND_URL || 'https://cellarion.app').host); } catch { /* keep the defaults */ }
    if (!ownHosts.has(url.host)) return { ok: false, error: 'forumPath must point to a page on this site' };
    path = `${url.pathname}${url.search}${url.hash}`;
  }
  if (!path.startsWith('/') || path.startsWith('//') || /[\s\\]/.test(path)) {
    return { ok: false, error: 'forumPath must be a path on this site, such as /community/discussions/…' };
  }
  return { ok: true, value: path };
}

module.exports = { STATES, FEATURES, FEATURE_KEYS, load, get, list, enabledKeys, set, storedValue, parseForumPath };
