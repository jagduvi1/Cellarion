// meilisearch-js v0.50+ renamed the client export `MeiliSearch` → `Meilisearch`.
// Alias it back to MeiliSearch locally so the rest of this file is unchanged.
const { Meilisearch: MeiliSearch } = require('meilisearch');
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const Discussion = require('../models/Discussion');
const { WINE_POPULATE, CONSUMED_STATUSES } = require('../config/constants');
const { stripHtml } = require('../utils/sanitize');
const { resolveGrapeDisplayName } = require('../utils/grapeDisplay');

const INDEX_NAME = 'wines';
const BOTTLES_INDEX_NAME = 'bottles';
const DISCUSSIONS_INDEX_NAME = 'discussions';

let client = null;
let index = null;
let bottlesIndex = null;
let discussionsIndex = null;
let isAvailable = false;

async function initialize() {
  const url = process.env.MEILI_URL || 'http://localhost:7700';
  const apiKey = process.env.MEILI_MASTER_KEY || '';

  try {
    client = new MeiliSearch({ host: url, apiKey });
    await client.health();

    index = client.index(INDEX_NAME);

    // Configure index settings
    await index.updateSettings({
      searchableAttributes: [
        'name',
        'producer',
        'appellation',
        'regionName',
        'grapeNames',
        'countryName'
      ],
      filterableAttributes: ['countryId', 'regionId', 'type', 'grapeIds'],
      sortableAttributes: ['name', 'producer', 'type', 'createdAt'],
      separatorTokens: ['.'],
      pagination: { maxTotalHits: 5000 }
    });

    // ── Bottles index ──
    bottlesIndex = client.index(BOTTLES_INDEX_NAME);

    await bottlesIndex.updateSettings({
      searchableAttributes: [
        'wineName',
        'producer',
        'appellation',
        'countryName',
        'regionName',
        'grapeNames',
        'type',
        'notes',
        'location',
        'vintage'
      ],
      filterableAttributes: [
        'cellarId',
        'status',
        'type',
        'countryId',
        'countryName',
        'regionId',
        'regionName',
        'appellation',
        'grapeIds',
        'vintage',
        'rating'
      ],
      sortableAttributes: ['wineName', 'vintage', 'price', 'rating', 'createdAt'],
      separatorTokens: ['.'],
      pagination: { maxTotalHits: 10000 }
    });

    // ── Discussions index ──
    discussionsIndex = client.index(DISCUSSIONS_INDEX_NAME);

    await discussionsIndex.updateSettings({
      // `replyContent` carries plain-text bodies of all non-deleted replies
      // joined together — lets users find threads where the OP didn't say it
      // but a reply did ("anyone tried this with foie gras?" buried in
      // reply 7 is now reachable). The single-index approach (vs separate
      // discussion_replies index) keeps the search query simple — Meilisearch
      // returns one hit per thread regardless of which field matched.
      searchableAttributes: ['title', 'body', 'replyContent', 'authorName', 'wineName'],
      filterableAttributes: ['category', 'isLocked', 'wineDefinitionId'],
      sortableAttributes: ['lastActivityAt', 'createdAt', 'replyCount'],
      separatorTokens: ['.'],
      pagination: { maxTotalHits: 5000 }
    });

    isAvailable = true;
    console.log(`Meilisearch connected: ${url}`);

    // Only do a full sync when an index is actually empty (first boot, or after
    // the meili-data volume is wiped). Meilisearch persists documents on its
    // volume, so on a normal restart the data is already there — re-uploading
    // the whole catalog every boot is wasteful. Live data changes are kept in
    // sync incrementally by indexWine/indexBottle/indexDiscussion. Set
    // MEILI_FORCE_REINDEX=1 to force a rebuild (e.g. after a settings change).
    //
    // The syncs run in the BACKGROUND: a full catalog upload takes minutes at
    // scale and initialize() is awaited before app.listen — blocking boot (and
    // the container healthcheck) on it would make first-boot/recovery deploys
    // fail. Search may briefly return partial results during an initial sync.
    (async () => {
      await syncIfNeeded(index, fullSync, 'wines');
      await syncIfNeeded(bottlesIndex, fullSyncBottles, 'bottles');
      await syncIfNeeded(discussionsIndex, fullSyncDiscussions, 'discussions');
    })().catch(err => console.error(`Meilisearch initial sync failed: ${err.message}`));
  } catch (err) {
    isAvailable = false;
    console.warn(`Meilisearch unavailable (${url}): ${err.message}. Falling back to MongoDB search.`);
  }
}

// While an index's INITIAL sync is in flight (first boot / wiped volume),
// searches against it must fail so callers take their MongoDB fallback —
// callers like the cellar route treat zero Meili hits as authoritative, and
// a half-built index would confidently return empty results for minutes.
const initialSyncing = { wines: false, bottles: false, discussions: false };

function assertIndexReady(label) {
  if (initialSyncing[label]) {
    throw new Error(`Meilisearch '${label}' index initial sync in progress`);
  }
}

// Run `syncFn` only if `idx` has no documents yet (or a rebuild is forced).
const FORCE_REINDEX = process.env.MEILI_FORCE_REINDEX === '1' || process.env.MEILI_FORCE_REINDEX === 'true';
const SYNC_CHECK_MAX_RETRIES = 5;
async function syncIfNeeded(idx, syncFn, label, attempt = 0) {
  try {
    if (FORCE_REINDEX) {
      console.log(`Meilisearch: MEILI_FORCE_REINDEX set — rebuilding '${label}'`);
      initialSyncing[label] = true;
      try { await syncFn(); } finally { initialSyncing[label] = false; }
      return;
    }
    const stats = await idx.getStats();
    if (!stats || stats.numberOfDocuments === 0) {
      console.log(`Meilisearch: '${label}' index empty — running initial sync`);
      initialSyncing[label] = true;
      try { await syncFn(); } finally { initialSyncing[label] = false; }
    } else {
      console.log(`Meilisearch: '${label}' already populated (${stats.numberOfDocuments} docs) — skipping sync`);
    }
  } catch (err) {
    // Fail CLOSED on the stats check: a transient error must not trigger a
    // full catalog re-upload — at scale that is the most expensive operation
    // in the system, and it used to fire exactly when Meilisearch was
    // struggling. But an EMPTY index whose stats keep erroring would stay
    // empty forever, so retry the check a few times (covers Meili still
    // warming up at boot) before giving up loudly.
    if (attempt < SYNC_CHECK_MAX_RETRIES) {
      const delayMs = 30_000 * (attempt + 1);
      console.warn(`Meilisearch: could not check '${label}' stats (${err.message}) — retrying in ${delayMs / 1000}s (${attempt + 1}/${SYNC_CHECK_MAX_RETRIES})`);
      setTimeout(() => {
        syncIfNeeded(idx, syncFn, label, attempt + 1).catch(() => {});
      }, delayMs).unref?.();
    } else {
      console.error(`Meilisearch: '${label}' stats check failed ${SYNC_CHECK_MAX_RETRIES} times (${err.message}) — giving up; set MEILI_FORCE_REINDEX=1 if the index is empty`);
    }
  }
}

// Canonical grape names, plus any regionally correct display name that
// applies to THIS wine ("Tinta Roriz" alongside "Tempranillo" on a Douro
// row) — additive recall so the label-true spelling matches too, while
// grapeIds filters stay on the single canonical vocabulary. Wines with no
// applicable mapping index exactly what they indexed before. Shared by
// buildDocument AND buildBottleDocument: bottle cards show the same regional
// label, so cellar search must match on it too (audit 2026-08-11).
function wineGrapeSearchNames(wine) {
  const names = [];
  for (const g of wine.grapes || []) {
    if (!g || !g.name) continue;
    names.push(g.name);
    const display = resolveGrapeDisplayName(g, { countryId: wine.country, regionId: wine.region });
    if (display && display !== g.name) names.push(display);
  }
  return names.join(', ');
}

function buildDocument(wine) {
  return {
    id: wine._id.toString(),
    name: wine.name,
    producer: wine.producer,
    appellation: wine.appellation || '',
    type: wine.type || '',
    countryId: wine.country?._id?.toString() || wine.country?.toString() || '',
    countryName: wine.country?.name || '',
    regionId: wine.region?._id?.toString() || wine.region?.toString() || '',
    regionName: wine.region?.name || '',
    grapeIds: (wine.grapes || []).map(g => (g._id || g).toString()),
    grapeNames: wineGrapeSearchNames(wine),
    image: wine.image || '',
    createdAt: wine.createdAt ? Math.floor(new Date(wine.createdAt).getTime() / 1000) : 0
  };
}

// Stream a query through buildDoc into chunked addDocuments calls. Loading a
// whole collection into one array + one HTTP payload OOMs Node and exceeds
// Meilisearch's payload limit once the catalog is large; a cursor keeps
// memory flat at CHUNK documents.
const SYNC_CHUNK_SIZE = 2000;
async function syncViaCursor(query, buildDoc, idx, label) {
  let batch = [];
  let total = 0;
  // addDocuments only ENQUEUES a Meili task (202); collect the task uids so a
  // caller that needs done-means-done (the admin force-reindex) can wait on
  // them. Boot-time and fire-and-forget callers just ignore the return value —
  // their behavior is unchanged (audit 2026-07-29, reindex "awaited" claim).
  const taskUids = [];
  const cursor = query.cursor();
  for await (const doc of cursor) {
    batch.push(buildDoc(doc));
    if (batch.length >= SYNC_CHUNK_SIZE) {
      const task = await idx.addDocuments(batch, { primaryKey: 'id' });
      if (task?.taskUid != null) taskUids.push(task.taskUid);
      total += batch.length;
      batch = [];
    }
  }
  if (batch.length > 0) {
    const task = await idx.addDocuments(batch, { primaryKey: 'id' });
    if (task?.taskUid != null) taskUids.push(task.taskUid);
    total += batch.length;
  }
  console.log(`Meilisearch: synced ${total} ${label}`);
  return taskUids;
}

async function fullSync() {
  if (!isAvailable) return;

  try {
    return await syncViaCursor(
      // Quarantined non-wine rows (spirits/cider/sake kept for their owners —
      // registry audit 2026-07-26, policy: keep, hide) never enter the index.
      // Neither do pendingIdentity rows: a half-identified wine must not be
      // findable by strangers in registry search. The BOTTLES index is
      // deliberately untouched — an owner keeps finding their own bottle.
      WineDefinition.find({ nonWine: { $ne: true }, pendingIdentity: { $ne: true } })
        .populate('country', 'name')
        .populate('region', 'name')
        // regionalNames feed wineGrapeSearchNames (regional display recall).
        .populate('grapes', 'name regionalNames')
        .lean(),
      buildDocument,
      index,
      'wines'
    );
  } catch (err) {
    console.error(`Meilisearch full sync failed: ${err.message}`);
  }
}

async function indexWine(wineId) {
  if (!isAvailable) return;

  try {
    const wine = await WineDefinition.findById(wineId)
      .populate('country', 'name')
      .populate('region', 'name')
      // regionalNames feed wineGrapeSearchNames (regional display recall).
      .populate('grapes', 'name regionalNames')
      .lean();

    if (!wine) return;

    // A wine flagged non-wine after having been indexed must LEAVE the index —
    // indexWine is called on every save, so the flag toggle self-heals here.
    // pendingIdentity rides the same switch in BOTH directions: a pending mint
    // never enters, and the promoting write's own indexWine() call is what puts
    // the completed wine INTO the index (there is no separate "add on promote"
    // path to forget — this is it).
    if (wine.nonWine === true || wine.pendingIdentity === true) {
      await index.deleteDocument(String(wine._id));
      return;
    }

    await index.addDocuments([buildDocument(wine)], { primaryKey: 'id' });
  } catch (err) {
    console.error(`Meilisearch index wine ${wineId} failed: ${err.message}`);
  }
}

async function removeWine(wineId) {
  if (!isAvailable) return;

  try {
    await index.deleteDocument(wineId.toString());
  } catch (err) {
    console.error(`Meilisearch remove wine ${wineId} failed: ${err.message}`);
  }
}

async function search(query, { countryId, regionId, type, grapeIds, limit = 50, offset = 0, sort } = {}) {
  if (!isAvailable) {
    throw new Error('Meilisearch is not available');
  }
  assertIndexReady('wines');

  // Build filter array using Meilisearch array syntax (each element is ANDed).
  // Validate IDs as hex ObjectIds and type against an allowlist to prevent injection.
  const isObjectId = (v) => /^[a-f0-9]{24}$/i.test(String(v));
  const VALID_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];
  const filters = [];
  if (countryId && isObjectId(countryId)) filters.push(`countryId = "${countryId}"`);
  if (regionId && isObjectId(regionId)) filters.push(`regionId = "${regionId}"`);
  if (type && VALID_TYPES.includes(String(type).toLowerCase())) filters.push(`type = "${type}"`);
  if (grapeIds && grapeIds.length > 0) {
    for (const id of grapeIds) {
      if (isObjectId(id)) filters.push(`grapeIds = "${id}"`);
    }
  }

  // Build sort array
  const meiliSort = [];
  if (sort && typeof sort === 'string' && sort !== 'relevance') {
    const desc = sort.startsWith('-');
    const field = desc ? sort.slice(1) : sort;
    if (['name', 'producer', 'type', 'createdAt'].includes(field)) {
      meiliSort.push(`${field}:${desc ? 'desc' : 'asc'}`);
    }
  }

  const result = await index.search(query, {
    filter: filters.length > 0 ? filters : undefined,
    sort: meiliSort.length > 0 ? meiliSort : undefined,
    limit,
    offset
  });

  return {
    ids: result.hits.map(hit => hit.id),
    estimatedTotalHits: result.estimatedTotalHits || 0
  };
}

// ── Bottle index helpers ─────────────────────────────────────────────────────

function buildBottleDocument(bottle) {
  const wd = bottle.wineDefinition || {};
  return {
    id: bottle._id.toString(),
    cellarId: (bottle.cellar?._id || bottle.cellar || '').toString(),
    status: bottle.status || 'active',
    wineDefinitionId: (wd._id || '').toString(),
    wineName: wd.name || '',
    producer: wd.producer || '',
    appellation: wd.appellation || '',
    type: wd.type || '',
    countryId: (wd.country?._id || wd.country || '').toString(),
    countryName: wd.country?.name || '',
    regionId: (wd.region?._id || wd.region || '').toString(),
    regionName: wd.region?.name || '',
    grapeIds: (wd.grapes || []).map(g => (g._id || g).toString()),
    // Same helper as the wines index (never duplicate its logic): canonical
    // names first, then any regional display name that applies to this wine —
    // byte-identical to the old plain join when no mapping applies.
    grapeNames: wineGrapeSearchNames(wd),
    vintage: bottle.vintage || '',
    price: bottle.price || 0,
    rating: bottle.rating || 0,
    ratingScale: bottle.ratingScale || '',
    notes: bottle.notes || '',
    location: bottle.location || '',
    createdAt: bottle.createdAt ? Math.floor(new Date(bottle.createdAt).getTime() / 1000) : 0
  };
}

async function fullSyncBottles() {
  if (!isAvailable) return;

  try {
    // Sync ALL bottles (active + consumed) so history search works too
    return await syncViaCursor(
      Bottle.find().populate(WINE_POPULATE).lean(),
      buildBottleDocument,
      bottlesIndex,
      'bottles'
    );
  } catch (err) {
    console.error(`Meilisearch bottle full sync failed: ${err.message}`);
  }
}

async function indexBottle(bottleId) {
  if (!isAvailable) return;

  try {
    const bottle = await Bottle.findById(bottleId)
      .populate(WINE_POPULATE)
      .lean();

    if (!bottle) return;

    // Always re-index (including consumed bottles for history search)
    await bottlesIndex.addDocuments([buildBottleDocument(bottle)], { primaryKey: 'id' });
  } catch (err) {
    console.error(`Meilisearch index bottle ${bottleId} failed: ${err.message}`);
  }
}

async function removeBottle(bottleId) {
  if (!isAvailable) return;

  try {
    await bottlesIndex.deleteDocument(bottleId.toString());
  } catch (err) {
    console.error(`Meilisearch remove bottle ${bottleId} failed: ${err.message}`);
  }
}

// Batch removal — one Meilisearch call for many ids (used by GDPR erasure,
// where a user may own thousands of bottles).
async function removeBottles(bottleIds) {
  if (!isAvailable || !bottleIds || bottleIds.length === 0) return;

  try {
    await bottlesIndex.deleteDocuments(bottleIds.map(id => id.toString()));
  } catch (err) {
    console.error(`Meilisearch remove ${bottleIds.length} bottles failed: ${err.message}`);
  }
}

async function bulkIndexBottles(bottleIds) {
  if (!isAvailable || !bottleIds || bottleIds.length === 0) return;

  try {
    const bottles = await Bottle.find({ _id: { $in: bottleIds } })
      .populate(WINE_POPULATE)
      .lean();

    const documents = bottles.map(buildBottleDocument);

    if (documents.length > 0) {
      await bottlesIndex.addDocuments(documents, { primaryKey: 'id' });
    }
  } catch (err) {
    console.error(`Meilisearch bulk index bottles failed: ${err.message}`);
  }
}

/**
 * Drop index hits whose Mongo row is gone, and self-heal the index.
 *
 * PROD 2026-08-13: 567 of 9,918 documents in the `bottles` index named bottles
 * that no longer existed. Over MCP that read as "0 of 14"; across ~9 callers in
 * routes/cellars.js it produced phantom counts and short pages. Every delete
 * path DOES unindex — the debris was operational (a restore from backup, raw
 * scripts), and it will happen again, so the fix belongs here rather than at
 * the call sites: every caller of searchBottles inherits it and none of them
 * has to know.
 *
 * Cheap RELATIVE TO WHAT THE CALLER ALREADY DOES, which is the honest way to
 * put it: one `_id`-only covered query over the returned ids. The MCP tool
 * pages at ≤50 and the facet-only calls pass limit: 0 (arriving here with an
 * empty list and costing nothing), but the three cellar-list callers pass
 * limit: 10000 — and each of those follows this with
 * `Bottle.find({_id: {$in: ids}}).populate(WINE_POPULATE_LIST)` over the SAME
 * ids, a strictly heavier query. So the added cost is a covered-index
 * duplicate of a fetch that was happening anyway, never a new round trip
 * shape. Fire-and-forget on the removal — a search must never wait on, or fail
 * because of, a repair.
 *
 * FAIL-OPEN: if the verification itself errors (a Mongo hiccup, an index doc
 * whose id is not an ObjectId → CastError), the raw hits are served unchanged.
 * A resilience fix must not become a new way for search to break.
 *
 * @returns {Promise<{ids: string[], dropped: number}>}
 */
async function dropStaleBottleIds(ids) {
  if (!ids || ids.length === 0) return { ids: ids || [], dropped: 0 };
  try {
    const rows = await Bottle.find({ _id: { $in: ids } }).select('_id').lean();
    if (rows.length === ids.length) return { ids, dropped: 0 };
    const live = new Set(rows.map(r => String(r._id)));
    const missing = ids.filter(id => !live.has(String(id)));
    // Self-heal, unawaited: removeBottles swallows its own errors, so this
    // cannot reject, and the caller's response does not wait for Meilisearch to
    // process the deletion task.
    removeBottles(missing);
    console.warn(`Meilisearch: dropped ${missing.length} stale bottle hit(s) and queued them for removal`);
    return { ids: ids.filter(id => live.has(String(id))), dropped: missing.length };
  } catch (err) {
    console.warn(`Meilisearch bottle-hit verification failed (serving raw hits): ${err.message}`);
    return { ids, dropped: 0 };
  }
}

/**
 * The honest total after stale hits were dropped.
 *
 * Reduced by what this page dropped — an estimate is all Meilisearch offers
 * anyway, and a count that includes rows the user can never be shown is worse
 * than a slightly low one. Floored at 0, and never below what was actually
 * returned: "showing 12 of 8" is a bug report waiting to happen.
 */
const honestTotal = (estimated, dropped, returned) =>
  Math.max(returned, Math.max(0, (estimated || 0) - dropped));

async function searchBottles(query, {
  cellarId,
  cellarIds,
  type,
  countryId,
  regionId,
  appellation,
  grapeIds,
  vintage,
  minRating,
  sort,
  statusFilter = 'active',  // 'active' | 'consumed' | 'all'
  limit = 30,
  offset = 0
} = {}) {
  if (!isAvailable) {
    throw new Error('Meilisearch is not available');
  }
  assertIndexReady('bottles');

  const isObjectId = (v) => /^[a-f0-9]{24}$/i.test(String(v));
  const VALID_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];
  const filters = [];

  // Scope to cellar(s). cellarId / cellarIds are server-set/access-checked, but
  // strip any double-quote defensively so a value can never break out of the
  // filter string. (We strip rather than drop on invalid input — dropping would
  // un-scope the search and leak across cellars.)
  // `cellarIds` (array) scopes across a set of cellars for the cross-cellar view;
  // `cellarId` (single) is kept for the per-cellar callers.
  const scopeIds = Array.isArray(cellarIds) && cellarIds.length > 0
    ? cellarIds
    : (cellarId ? [cellarId] : []);
  const cleanScopeIds = scopeIds.map(id => String(id).replace(/"/g, '')).filter(Boolean);
  if (cleanScopeIds.length === 1) {
    filters.push(`cellarId = "${cleanScopeIds[0]}"`);
  } else if (cleanScopeIds.length > 1) {
    filters.push(`cellarId IN ["${cleanScopeIds.join('","')}"]`);
  } else if (scopeIds.length > 0) {
    // A scope WAS requested but every id stripped to empty — push a filter that
    // matches nothing rather than no filter at all (which would un-scope the
    // search and leak across every cellar).
    filters.push('cellarId = ""');
  }
  // Status filter: active (exclude consumed), consumed (only consumed), or all
  if (statusFilter === 'active') {
    filters.push(`status NOT IN ["${CONSUMED_STATUSES.join('","')}"]`);
  } else if (statusFilter === 'consumed') {
    filters.push(`status IN ["${CONSUMED_STATUSES.join('","')}"]`);
  }

  // Type: single or comma-separated multi-select
  if (type) {
    const types = String(type).split(',').map(t => t.trim()).filter(t => VALID_TYPES.includes(t.toLowerCase()));
    if (types.length === 1) filters.push(`type = "${types[0]}"`);
    else if (types.length > 1) filters.push(`type IN ["${types.join('","')}"]`);
  }
  // Country: single or comma-separated ObjectIds
  if (countryId) {
    const ids = String(countryId).split(',').map(c => c.trim()).filter(isObjectId);
    if (ids.length === 1) filters.push(`countryId = "${ids[0]}"`);
    else if (ids.length > 1) filters.push(`countryId IN ["${ids.join('","')}"]`);
  }
  // Region: single or comma-separated ObjectIds
  if (regionId) {
    const ids = String(regionId).split(',').map(r => r.trim()).filter(isObjectId);
    if (ids.length === 1) filters.push(`regionId = "${ids[0]}"`);
    else if (ids.length > 1) filters.push(`regionId IN ["${ids.join('","')}"]`);
  }
  if (grapeIds && grapeIds.length > 0) {
    const validIds = grapeIds.filter(isObjectId);
    if (validIds.length === 1) filters.push(`grapeIds = "${validIds[0]}"`);
    else if (validIds.length > 1) filters.push(`grapeIds IN ["${validIds.join('","')}"]`);
  }
  // Appellation: single or comma-separated free-text values (e.g. "Barolo",
  // "Châteauneuf-du-Pape"). Values are the facet keys the client got back, so
  // they're echoed as-is — but strip any double-quote defensively so a value
  // can never break out of the quoted Meili filter string.
  if (appellation) {
    const apps = String(appellation)
      .split(',')
      .map(a => a.trim().replace(/"/g, ''))
      .filter(Boolean);
    if (apps.length === 1) filters.push(`appellation = "${apps[0]}"`);
    else if (apps.length > 1) filters.push(`appellation IN ["${apps.join('","')}"]`);
  }
  // Vintage: single or comma-separated. Only alphanumeric tokens (years / NV /
  // Unknown) are allowed — this drops anything containing a double-quote or
  // other special char that could inject into the Meili filter string.
  if (vintage) {
    const vintages = String(vintage).split(',').map(v => v.trim()).filter(v => /^[A-Za-z0-9]+$/.test(v));
    if (vintages.length === 1) filters.push(`vintage = "${vintages[0]}"`);
    else if (vintages.length > 1) filters.push(`vintage IN ["${vintages.join('","')}"]`);
  }
  if (minRating) filters.push(`rating >= ${parseFloat(minRating)}`);

  // Build sort
  const meiliSort = [];
  if (sort && typeof sort === 'string') {
    const desc = sort.startsWith('-');
    const field = desc ? sort.slice(1) : sort;
    const sortMap = { name: 'wineName', createdAt: 'createdAt', vintage: 'vintage', price: 'price', rating: 'rating' };
    if (sortMap[field]) {
      meiliSort.push(`${sortMap[field]}:${desc ? 'desc' : 'asc'}`);
    }
  }

  const result = await bottlesIndex.search(query || '', {
    filter: filters.length > 0 ? filters : undefined,
    sort: meiliSort.length > 0 ? meiliSort : undefined,
    facets: ['type', 'countryName', 'regionName', 'appellation', 'vintage', 'countryId', 'regionId', 'grapeIds'],
    limit,
    offset
  });

  // Verify the page against Mongo before anybody counts it (see
  // dropStaleBottleIds). Facet distributions are NOT adjusted: they are
  // Meilisearch's own aggregation over the whole index and cannot be corrected
  // from one page of ids — the reconcile job (services/searchReconcileJob) is
  // what makes them right, by emptying the index of debris in the first place.
  const { ids, dropped } = await dropStaleBottleIds(result.hits.map(hit => hit.id));

  return {
    ids,
    estimatedTotalHits: honestTotal(result.estimatedTotalHits, dropped, ids.length),
    facetDistribution: result.facetDistribution || {},
    facetStats: result.facetStats || {}
  };
}

// ── Discussion index helpers ─────────────────────────────────────────────────

// Cap on the concatenated reply-content field. 8 KB keeps the index
// reasonable (most threads stay well below); threads that exceed it lose
// their tail in search but still match on title/body/early replies.
const REPLY_CONTENT_MAX = 8000;

function buildDiscussionDocument(discussion, replyTexts = []) {
  const author = discussion.author || {};
  const wine = discussion.wineDefinition || {};
  // Concatenate reply texts with a paragraph break between each so the
  // tokenizer treats them as separate phrases. Pre-truncated; raw HTML is
  // stripped by the caller before passing in.
  const replyContent = replyTexts.length > 0
    ? replyTexts.join('\n\n').slice(0, REPLY_CONTENT_MAX)
    : '';
  return {
    id: discussion._id.toString(),
    slug: discussion.slug || '',
    title: discussion.title || '',
    // Index plain text — Meilisearch shouldn't tokenize HTML markup as content
    body: stripHtml(discussion.body || ''),
    replyContent,
    category: discussion.category || '',
    isLocked: !!discussion.isLocked,
    isPinned: !!discussion.isPinned,
    replyCount: discussion.replyCount || 0,
    authorId: (author._id || author).toString?.() || '',
    authorName: author.displayName || author.username || '',
    wineDefinitionId: (wine._id || wine || '').toString?.() || '',
    wineName: wine.name ? `${wine.name}${wine.producer ? ' ' + wine.producer : ''}` : '',
    lastActivityAt: discussion.lastActivityAt
      ? Math.floor(new Date(discussion.lastActivityAt).getTime() / 1000)
      : 0,
    createdAt: discussion.createdAt
      ? Math.floor(new Date(discussion.createdAt).getTime() / 1000)
      : 0
  };
}

// Helper: pull the plain-text bodies of non-deleted replies for a discussion,
// in chronological order, so search hits highlight the earliest matching
// reply when the index is rebuilt.
async function fetchReplyTextsForIndex(discussionId) {
  const DiscussionReply = require('../models/DiscussionReply');
  const replies = await DiscussionReply.find({
    discussion: discussionId,
    isDeleted: { $ne: true }
  })
    .sort({ createdAt: 1 })
    .select('body')
    .lean();
  return replies.map(r => stripHtml(r.body || '')).filter(Boolean);
}

async function fullSyncDiscussions() {
  if (!isAvailable) return;

  try {
    const DiscussionReply = require('../models/DiscussionReply');
    let batch = [];
    let total = 0;

    // Per chunk: fetch reply texts for just this chunk's discussions (one
    // $in query per chunk — batched, not N+1, and never the whole replies
    // collection in memory at once).
    const flush = async () => {
      if (batch.length === 0) return;
      const ids = batch.map(d => d._id);
      const replies = await DiscussionReply.find({ discussion: { $in: ids }, isDeleted: { $ne: true } })
        .sort({ discussion: 1, createdAt: 1 })
        .select('discussion body')
        .lean();
      const repliesByDiscussion = new Map();
      for (const r of replies) {
        const key = r.discussion.toString();
        if (!repliesByDiscussion.has(key)) repliesByDiscussion.set(key, []);
        repliesByDiscussion.get(key).push(stripHtml(r.body || ''));
      }
      const documents = batch.map(d =>
        buildDiscussionDocument(d, repliesByDiscussion.get(d._id.toString()) || [])
      );
      await discussionsIndex.addDocuments(documents, { primaryKey: 'id' });
      total += documents.length;
      batch = [];
    };

    const cursor = Discussion.find()
      .populate('author', 'username displayName')
      .populate({ path: 'wineDefinition', select: 'name producer' })
      .lean()
      .cursor();
    for await (const d of cursor) {
      batch.push(d);
      if (batch.length >= 500) await flush();
    }
    await flush();

    console.log(`Meilisearch: synced ${total} discussions (with reply content)`);
  } catch (err) {
    console.error(`Meilisearch discussion full sync failed: ${err.message}`);
  }
}

async function indexDiscussion(discussionId) {
  if (!isAvailable) return;

  try {
    const [discussion, replyTexts] = await Promise.all([
      Discussion.findById(discussionId)
        .populate('author', 'username displayName')
        .populate({ path: 'wineDefinition', select: 'name producer' })
        .lean(),
      fetchReplyTextsForIndex(discussionId)
    ]);

    if (!discussion) return;

    await discussionsIndex.addDocuments(
      [buildDiscussionDocument(discussion, replyTexts)],
      { primaryKey: 'id' }
    );
  } catch (err) {
    console.error(`Meilisearch index discussion ${discussionId} failed: ${err.message}`);
  }
}

async function removeDiscussion(discussionId) {
  if (!isAvailable) return;

  try {
    await discussionsIndex.deleteDocument(discussionId.toString());
  } catch (err) {
    console.error(`Meilisearch remove discussion ${discussionId} failed: ${err.message}`);
  }
}

// Search discussions by free-text query. Returns ordered IDs so the route
// handler can hydrate them from MongoDB and keep the API response shape
// consistent with the non-search list view.
async function searchDiscussions(query, { category, limit = 20, offset = 0 } = {}) {
  if (!isAvailable) {
    throw new Error('Meilisearch is not available');
  }
  assertIndexReady('discussions');

  const { CATEGORIES: VALID_CATEGORIES } = require('../models/Discussion');
  const filters = [];
  if (category && VALID_CATEGORIES.includes(String(category))) {
    filters.push(`category = "${category}"`);
  }

  const result = await discussionsIndex.search(query || '', {
    filter: filters.length > 0 ? filters : undefined,
    limit,
    offset
  });

  return {
    ids: result.hits.map(hit => hit.id),
    estimatedTotalHits: result.estimatedTotalHits || 0
  };
}

function getIsAvailable() {
  return isAvailable;
}

// ── Index reconciliation surface ─────────────────────────────────────────────
//
// The nightly sweep (services/searchReconcileJob) needs to walk what is IN an
// index and delete what Mongo no longer has. Both primitives live here rather
// than in the job, for the same reason every other Meilisearch call does: this
// module owns the client, and the `meilisearch` package is ESM-only — a second
// require of it elsewhere is the #702 jest failure mode all over again. The job
// requires THIS module, which every suite already knows how to mock.
const RECONCILABLE_INDEXES = ['wines', 'bottles'];

const indexByLabel = (label) => {
  if (label === 'wines') return index;
  if (label === 'bottles') return bottlesIndex;
  return null;
};

/**
 * One page of document ids from an index, oldest-first by Meilisearch's
 * internal order (stable within a run — deleteDocuments only ENQUEUES a task,
 * so nothing shifts under the paging while a sweep is walking).
 *
 * `fields: ['id']` keeps the payload to ids: a full document page of the
 * bottles index would be megabytes for no purpose.
 *
 * @returns {Promise<{ids: string[], total: number}>}
 */
async function listIndexDocumentIds(label, { limit = 1000, offset = 0 } = {}) {
  if (!isAvailable) return { ids: [], total: 0 };
  const idx = indexByLabel(label);
  if (!idx) throw new Error(`Unknown Meilisearch index '${label}'`);
  const page = await idx.getDocuments({ limit, offset, fields: ['id'] });
  const results = (page && page.results) || [];
  return {
    ids: results.map(d => d && d.id).filter(Boolean).map(String),
    total: (page && page.total) || 0,
  };
}

/** Batch delete by id from one index — the reconcile job's only write. */
async function deleteIndexDocuments(label, ids) {
  if (!isAvailable || !ids || ids.length === 0) return;
  const idx = indexByLabel(label);
  if (!idx) throw new Error(`Unknown Meilisearch index '${label}'`);
  await idx.deleteDocuments(ids.map(id => String(id)));
}

/**
 * Wait for enqueued Meili tasks to actually complete — done-means-done for
 * callers like the admin force-reindex, where responding before indexing
 * finishes recreates the stale-index window the button exists to close.
 */
async function waitForTasks(taskUids, { timeOutMs = 120000 } = {}) {
  if (!isAvailable || !Array.isArray(taskUids) || taskUids.length === 0) return;
  // meilisearch-js ≥0.38 moved task waiting to client.tasks and renamed the
  // options (timeout/interval, ms) — client.waitForTasks does not exist on
  // 0.58 and 500'd the admin reindex (prod 2026-08-11).
  await client.tasks.waitForTasks(taskUids, { timeout: timeOutMs, interval: 250 });
}

module.exports = {
  initialize,
  fullSync,
  fullSyncBottles,
  waitForTasks,
  fullSyncDiscussions,
  indexWine,
  removeWine,
  search,
  indexBottle,
  removeBottle,
  removeBottles,
  bulkIndexBottles,
  searchBottles,
  indexDiscussion,
  removeDiscussion,
  searchDiscussions,
  getIsAvailable,
  RECONCILABLE_INDEXES,
  listIndexDocumentIds,
  deleteIndexDocuments,
  // Pure document builder, exported for unit tests
  // (search.buildBottleDocument.test.js) — no client needed.
  buildBottleDocument,
};
