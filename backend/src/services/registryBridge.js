/**
 * Registry Bridge — the SELF-HOSTED side's domain logic (docs/registry-bridge.md).
 *
 * A self-hosted install with REGISTRY_BRIDGE_KEY set can, one wine at a time:
 *   - show registry identities next to its own add-bottle search results
 *     (registrySearch), and
 *   - ADOPT one of them: copy identity, tasting profile, drink windows and
 *     published values into its own database as a normal local wine, marked
 *     with `registryId` + `createdVia: 'bridge'` (adoptWine);
 *   - keep its copies fresh with one change check a week (refreshHeld);
 *   - forward the corrections, values and wine requests its users file to
 *     the hosted queues (forward*).
 *
 * The registry never arrives as a whole: every function here works on wines
 * the install's own users chose. Transport lives in registryBridgeClient.js
 * and never throws; this module returns { ok, code } results the routes map
 * to statuses, so a hosted-side outage degrades to local-only.
 */
const WineDefinition = require('../models/WineDefinition');
const WineVintageProfile = require('../models/WineVintageProfile');
const RegistryDataKey = require('../models/RegistryDataKey');
const RegistryDataValue = require('../models/RegistryDataValue');
const client = require('./registryBridgeClient');
const { generateWineKey } = require('../utils/normalize');
const { TYPES: VALUE_TYPES } = require('../utils/personalDataTypes');
// Loaded on first use, not at require time: the intake routes that forward
// contributions require this module, and findOrCreateWine / search pull in
// Meilisearch's ESM client, which route suites that never touch the registry
// do not (and should not have to) mock.
const taxonomy = () => require('./findOrCreateWine');
const searchService = () => require('./search');

const POPULATE = ['country', 'region', 'grapes'];
const WINE_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];
const PROFILE_FIELDS = ['body', 'tannin', 'acidity', 'sweetness', 'flavors', 'foodPairings', 'description', 'source', 'generatedAt', 'verifiedAt'];
const REGISTRY_NOTE = 'From the shared registry (cellarion.app)';
const isId = (v) => /^[a-f0-9]{24}$/i.test(String(v || ''));

// Weekly refresh switch. REGISTRY_BRIDGE_REFRESH in the install's .env wins
// ("off" | "weekly"); otherwise the admin toggle on the Settings card
// (SiteConfig 'registryBridge'.refresh); otherwise weekly. Read per run, so
// the toggle needs no restart; the env value does, like every env value.
const REFRESH_MODES = ['weekly', 'off'];
const SITE_CONFIG_KEY = 'registryBridge';
const siteConfigModel = () => require('../models/SiteConfig');

function refreshEnvMode() {
  const raw = String(process.env.REGISTRY_BRIDGE_REFRESH || '').trim().toLowerCase();
  if (!raw) return null;
  if (['off', 'false', '0', 'no', 'never', 'none'].includes(raw)) return 'off';
  return 'weekly';
}

/** { mode: 'weekly' | 'off', source: 'env' | 'settings' | 'default' } */
async function refreshMode() {
  const env = refreshEnvMode();
  if (env) return { mode: env, source: 'env' };
  try {
    const doc = await siteConfigModel().findOne({ key: SITE_CONFIG_KEY }).lean();
    const stored = doc?.value?.refresh;
    if (REFRESH_MODES.includes(stored)) return { mode: stored, source: 'settings' };
  } catch (err) {
    console.warn('[bridge] could not read the refresh setting, assuming weekly:', err.message);
  }
  return { mode: 'weekly', source: 'default' };
}

/** The admin toggle. Refused with env_override while the .env decides. */
async function setRefreshMode(mode, userId) {
  if (!REFRESH_MODES.includes(mode)) return { ok: false, code: 'invalid' };
  const env = refreshEnvMode();
  if (env) return { ok: false, code: 'env_override', mode: env, source: 'env' };
  const { updateSiteConfig } = require('../utils/siteConfig');
  await updateSiteConfig(SITE_CONFIG_KEY, { refresh: mode }, userId);
  return { ok: true, mode, source: 'settings' };
}

// Local changes win. A window or value row the bridge wrote carries
// REGISTRY_NOTE and the sync time; a row written by someone on this install,
// or touched after the last sync, is theirs and is never overwritten by an
// adoption or a refresh. A seeded placeholder (no dates, no note) is not an
// edit, so the registry still fills it.
const EDIT_SLACK_MS = 5000;
const WINDOW_FIELDS = ['earlyFrom', 'earlyUntil', 'peakFrom', 'peakUntil', 'lateFrom', 'lateUntil'];

function touchedAfterSync(at, syncedAt) {
  if (!at || !syncedAt) return false;
  return new Date(at).getTime() > new Date(syncedAt).getTime() + EDIT_SLACK_MS;
}

function windowEditedLocally(row, syncedAt) {
  if (!row) return false;
  if (row.sommNotes !== REGISTRY_NOTE) {
    return row.status === 'reviewed' || WINDOW_FIELDS.some((f) => row[f] !== null && row[f] !== undefined);
  }
  return touchedAfterSync(row.setAt, syncedAt);
}

function valueEditedLocally(row, syncedAt) {
  if (!row) return false;
  if (row.reason !== REGISTRY_NOTE) return true;
  return touchedAfterSync(row.decidedAt, syncedAt);
}

let lastRefresh = null;

const isEnabled = () => client.isEnabled();

/** The profile fields a registry wine carries, or null when it has none. */
function profileFrom(p) {
  if (!p || typeof p !== 'object') return null;
  const out = {};
  for (const f of PROFILE_FIELDS) if (p[f] !== undefined && p[f] !== null) out[f] = p[f];
  if (!out.description && !out.body) return null;
  out.source = p.source === 'curator' ? 'curator' : 'ai';
  return out;
}

/** Registry strings → this install's taxonomy rows (minted locally when missing). */
async function resolveTaxonomy(w, userId) {
  const { findOrCreateCountry, findOrCreateRegion, findOrCreateGrapes, regionForAppellation } = taxonomy();
  let country = null;
  let region = null;
  if (w.country) {
    try { country = await findOrCreateCountry(w.country, userId); } catch { country = null; }
  }
  if (country && w.appellation) region = await regionForAppellation(w.appellation, country._id);
  if (!region && country && w.region) region = await findOrCreateRegion(w.region, country._id, userId);
  const grapes = Array.isArray(w.grapes) && w.grapes.length ? await findOrCreateGrapes(w.grapes, userId) : [];
  return { country, region, grapes };
}

function identityFields(w, tax) {
  return {
    name: w.name,
    producer: w.producer || null,
    appellation: w.appellation || null,
    classification: w.classification || null,
    ...(WINE_TYPES.includes(w.type) ? { type: w.type } : {}),
    ...(tax.country ? { country: tax.country._id } : {}),
    region: tax.region ? tax.region._id : null,
    grapes: tax.grapes,
    // A URL into the hosted site, never bytes; the card renderer accepts it.
    image: w.image || null,
    imageCredit: w.imageCredit || null,
    lwin: w.lwin || null,
  };
}

/** Reviewed windows from the registry replace whatever the copy had. */
async function applyWindows(wineId, windows, userId, now, syncedAt = null) {
  for (const win of windows || []) {
    if (!win || win.vintage === undefined || win.vintage === null) continue;
    const existing = await WineVintageProfile.findOne({ wineDefinition: wineId, vintage: String(win.vintage) });
    if (windowEditedLocally(existing, syncedAt)) continue;
    const phase = (p) => ({ from: p?.from ?? null, until: p?.until ?? null });
    const early = phase(win.early); const peak = phase(win.peak); const late = phase(win.late);
    await WineVintageProfile.findOneAndUpdate(
      { wineDefinition: wineId, vintage: String(win.vintage) },
      {
        $set: {
          relative: !!win.relative,
          earlyFrom: early.from, earlyUntil: early.until,
          peakFrom: peak.from, peakUntil: peak.until,
          lateFrom: late.from, lateUntil: late.until,
          status: 'reviewed', setBy: userId, setAt: now, sommNotes: REGISTRY_NOTE,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }
}

/** Published values: the key is matched by name locally (minted accepted when missing). */
async function applyValues(wineId, values, userId, now, syncedAt = null) {
  for (const f of values || []) {
    const name = f?.key?.name;
    if (!name) continue;
    const nameKey = String(name).trim().toLowerCase();
    let key = await RegistryDataKey.findOne({ nameKey, status: 'accepted' });
    if (!key) {
      key = await RegistryDataKey.create({
        name: String(name).trim(),
        type: VALUE_TYPES.includes(f.key.type) ? f.key.type : 'text',
        unit: f.key.unit || null,
        enumOptions: Array.isArray(f.key.enumOptions) ? f.key.enumOptions.slice(0, 20) : undefined,
        rationale: `${REGISTRY_NOTE}: accepted there, copied here with the first wine that carries it.`,
        status: 'accepted', proposedBy: userId, decidedBy: userId, decidedAt: now,
      });
    }
    const publish = async (vintage, value) => {
      if (value === undefined || value === null) return;
      const existing = await RegistryDataValue.findOne({ wineDefinition: wineId, key: key._id, vintage, status: 'published' });
      if (valueEditedLocally(existing, syncedAt)) return;
      await RegistryDataValue.findOneAndUpdate(
        { wineDefinition: wineId, key: key._id, vintage, status: 'published' },
        { $set: { value, suggestedBy: userId, decidedBy: userId, decidedAt: now, reason: REGISTRY_NOTE } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    };
    await publish(null, f.wineValue !== undefined && f.wineValue !== null ? f.wineValue : f.value);
    for (const o of f.overrides || []) if (o && o.vintage) await publish(String(o.vintage), o.value);
  }
}

function indexLocally(wineId) {
  try { Promise.resolve(searchService().indexWine(wineId)).catch(() => {}); } catch { /* local index is best-effort */ }
}

/**
 * Copy a registry wine into this install. Returns { ok, wine, created } or
 * { ok: false, code } with code ∈ disabled | invalid | not_found | unavailable.
 * A local wine typed before the bridge existed, with the same dedup key, is
 * LINKED rather than duplicated: blanks are filled, a locally curated
 * profile is kept.
 */
async function adoptWine(registryId, userId) {
  if (!isEnabled()) return { ok: false, code: 'disabled' };
  if (!isId(registryId)) return { ok: false, code: 'invalid' };
  const held = await WineDefinition.findOne({ registryId: { $eq: String(registryId) } }).populate(POPULATE);
  if (held) return { ok: true, wine: held, created: false };

  const w = await client.fetchWine(registryId);
  if (!w) return { ok: false, code: 'unavailable' };
  if (w.removed) return { ok: false, code: 'not_found' };

  const now = new Date();
  const tax = await resolveTaxonomy(w, userId);
  const normalizedKey = generateWineKey(w.name, w.producer || '', w.appellation || '');
  let wine = await WineDefinition.findOne({ normalizedKey });
  const profile = profileFrom(w.profile);
  if (wine) {
    wine.registryId = String(w.id);
    wine.registrySyncedAt = now;
    if (!wine.image && w.image) { wine.image = w.image; wine.imageCredit = w.imageCredit || null; }
    const locallyCurated = wine.aiProfile && wine.aiProfile.source === 'curator' && wine.aiProfile.description;
    if (profile && !locallyCurated) wine.aiProfile = profile;
    await wine.save();
  } else {
    wine = new WineDefinition({
      ...identityFields(w, tax),
      normalizedKey,
      createdBy: userId,
      createdVia: 'bridge',
      registryId: String(w.id),
      registrySyncedAt: now,
      ...(profile ? { aiProfile: profile } : {}),
    });
    try {
      await wine.save();
    } catch (err) {
      if (err && err.code === 11000) {
        // Minted concurrently under the same key: take that row instead.
        wine = await WineDefinition.findOne({ normalizedKey });
        if (!wine) throw err;
        if (!wine.registryId) { wine.registryId = String(w.id); wine.registrySyncedAt = now; await wine.save(); }
      } else {
        throw err;
      }
    }
  }
  await applyWindows(wine._id, w.windows, userId, now);
  await applyValues(wine._id, w.values, userId, now);
  indexLocally(wine._id);
  await wine.populate(POPULATE);
  return { ok: true, wine, created: !held };
}

/**
 * Registry identities for an add-bottle query, minus the ones this install
 * already holds (those are in the local results). Never throws.
 */
async function registrySearch(q, { limit = 10 } = {}) {
  if (!isEnabled()) return [];
  const found = await client.search(q);
  if (!found.length) return [];
  const held = await WineDefinition.find({ registryId: { $in: found.map((w) => w.id) } }).select('registryId').lean();
  const heldIds = new Set(held.map((h) => h.registryId));
  return found.filter((w) => !heldIds.has(w.id)).slice(0, limit).map((w) => ({ ...w, registryId: w.id, source: 'registry' }));
}

/** One changed wine → the local copy, keeping local identity edits. */
async function applyRegistryUpdate(local, w, now) {
  const wine = await WineDefinition.findById(local._id);
  if (!wine) return false;
  const prevSync = wine.registrySyncedAt || null;
  const untouchedLocally = !wine.registrySyncedAt || !wine.updatedAt || wine.updatedAt.getTime() <= wine.registrySyncedAt.getTime() + EDIT_SLACK_MS;
  if (untouchedLocally) {
    const tax = await resolveTaxonomy(w, wine.createdBy);
    Object.assign(wine, identityFields(w, tax));
    wine.normalizedKey = generateWineKey(w.name, w.producer || '', w.appellation || '');
  } else if (!wine.image && w.image) {
    wine.image = w.image; wine.imageCredit = w.imageCredit || null;
  }
  const profile = profileFrom(w.profile);
  // A profile a person on this install curated after the last sync stays.
  const ap = wine.aiProfile;
  const curatedHere = !!(ap && ap.source === 'curator'
    && (touchedAfterSync(ap.verifiedAt, prevSync) || touchedAfterSync(ap.generatedAt, prevSync)));
  if (profile && !curatedHere) wine.aiProfile = profile;
  wine.registrySyncedAt = now;
  try {
    await wine.save();
  } catch (err) {
    if (err && err.code === 11000) {
      // The registry's identity now collides with another local row: keep
      // the copy's old identity, take the rest.
      const fresh = await WineDefinition.findById(local._id);
      if (profile && !curatedHere) fresh.aiProfile = profile;
      fresh.registrySyncedAt = now;
      await fresh.save();
    } else {
      throw err;
    }
  }
  await applyWindows(wine._id, w.windows, wine.createdBy, now, prevSync);
  await applyValues(wine._id, w.values, wine.createdBy, now, prevSync);
  indexLocally(wine._id);
  return true;
}

/**
 * Weekly: one change check for every registry id this install holds, then
 * re-fetch the changed ones; wines the registry reports removed are marked
 * and left alone from then on. Returns a summary the status route shows.
 */
async function refreshHeld({ now = new Date() } = {}) {
  if (!isEnabled()) return { skipped: 'disabled' };
  const mode = await refreshMode();
  if (mode.mode === 'off') return { skipped: 'refresh_off', source: mode.source };
  const rows = await WineDefinition.find({ registryId: { $exists: true, $ne: null }, registryRemovedAt: null })
    .select('_id registryId registrySyncedAt updatedAt createdBy').lean();
  if (!rows.length) { lastRefresh = { at: now, checked: 0, changed: 0, updated: 0, removed: 0, failed: false }; return lastRefresh; }
  const since = rows.reduce((min, r) => (r.registrySyncedAt && (!min || r.registrySyncedAt < min) ? r.registrySyncedAt : min), null) || new Date(0);
  const r = await client.changes(rows.map((x) => x.registryId), since);
  const byRegistry = new Map(rows.map((x) => [x.registryId, x]));
  let updated = 0; let removed = 0;
  for (const c of r.changed) {
    const local = byRegistry.get(c.id);
    if (!local) continue;
    const w = await client.fetchWine(c.id);
    if (!w || w.removed) continue;
    if (await applyRegistryUpdate(local, w, now)) updated++;
  }
  for (const id of r.removed) {
    const local = byRegistry.get(id);
    if (!local) continue;
    await WineDefinition.updateOne({ _id: local._id }, { $set: { registryRemovedAt: now } });
    removed++;
  }
  lastRefresh = { at: now, checked: r.checked, changed: r.changed.length, updated, removed, failed: !!r.failed };
  console.log(`[bridge] refresh: ${r.checked} checked, ${updated} updated, ${removed} removed${r.failed ? ' (a chunk failed — quota or network)' : ''}`);
  return lastRefresh;
}

/** A local correction on an adopted wine → the hosted proposal queue. */
async function forwardCorrection(wine, { fields, reason, evidenceUrl }) {
  if (!isEnabled() || !wine?.registryId) return null;
  return client.forwardCorrection({ wineId: wine.registryId, fields, reason, evidenceUrl });
}

/** A local value suggestion on an adopted wine → the hosted review queue. */
async function forwardValueFor(wineId, { keyId, keyName, value, reason, evidenceUrl, vintage }) {
  if (!isEnabled() || !isId(wineId)) return null;
  // Ids come from the route params/body: validated above and pinned with $eq
  // so nothing but a plain string ever reaches the filter.
  const wine = await WineDefinition.findOne({ _id: { $eq: String(wineId) } }).select('registryId').lean();
  if (!wine?.registryId) return null;
  let name = typeof keyName === 'string' ? keyName : null;
  if (!name && isId(keyId)) {
    const key = await RegistryDataKey.findOne({ _id: { $eq: String(keyId) } }).select('name').lean();
    name = key?.name;
  }
  if (!name) return null;
  return client.forwardValue({ wineId: wine.registryId, keyName: name, value, reason, evidenceUrl, vintage });
}

/** A local wine request (a wine nobody has) → the hosted intake. */
async function forwardRequest({ wineName, sourceUrl, image }) {
  if (!isEnabled()) return null;
  const payload = { wineName, sourceUrl };
  if (image && /^https?:\/\//i.test(String(image))) payload.image = image;
  return client.forwardRequest(payload);
}

/** What the self-hosted Settings card shows. */
async function status() {
  const transport = client.transportState();
  if (!transport.enabled) return { ...transport, held: 0, removed: 0, lastRefresh: null, me: null };
  const [held, removed, me, refresh] = await Promise.all([
    WineDefinition.countDocuments({ registryId: { $exists: true, $ne: null }, registryRemovedAt: null }),
    WineDefinition.countDocuments({ registryRemovedAt: { $ne: null } }),
    client.me(),
    refreshMode(),
  ]);
  return { ...transport, held, removed, lastRefresh, refresh, me };
}

function _reset() { lastRefresh = null; }

module.exports = {
  isEnabled, adoptWine, registrySearch, refreshHeld, forwardCorrection, forwardValueFor, forwardRequest, status,
  refreshMode, setRefreshMode, REFRESH_MODES, profileFrom, REGISTRY_NOTE, _reset,
};
