// meilisearch-js v0.50+ renamed the client export `MeiliSearch` → `Meilisearch`.
// Alias it back to MeiliSearch locally so the rest of this file is unchanged.
const { Meilisearch: MeiliSearch } = require('meilisearch');
const WineDefinition = require('../models/WineDefinition');
const Discussion = require('../models/Discussion');
const { stripHtml } = require('../utils/sanitize');
const { grapeSearchNames } = require('../utils/grapeDisplay');

const INDEX_NAME = 'wines';
const DISCUSSIONS_INDEX_NAME = 'discussions';
// Indexes this code no longer uses. `bottles` held a copy of every bottle —
// private notes included — until cellar search moved to MongoDB
// (services/bottleSearch, 2026-09). Deleted at boot when still present.
const RETIRED_INDEXES = ['bottles'];

let client = null;
let index = null;
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
      // `language`: the forum's language sections (2026-08-31). NOTE for
      // deploys — adding a filterable attribute makes Meili re-index, but the
      // stored documents only gain the field once they are re-uploaded, so a
      // release that adds one needs MEILI_FORCE_REINDEX=1 (or an empty index)
      // or search silently answers across every language until the next edit
      // to each thread.
      filterableAttributes: ['category', 'isLocked', 'wineDefinitionId', 'language'],
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
    // sync incrementally by indexWine/indexDiscussion. Set
    // MEILI_FORCE_REINDEX=1 to force a rebuild (e.g. after a settings change).
    //
    // The syncs run in the BACKGROUND: a full catalog upload takes minutes at
    // scale and initialize() is awaited before app.listen — blocking boot (and
    // the container healthcheck) on it would make first-boot/recovery deploys
    // fail. Search may briefly return partial results during an initial sync.
    (async () => {
      await dropRetiredIndexes();
      await syncIfNeeded(index, fullSync, 'wines');
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
const initialSyncing = { wines: false, discussions: false };

// Delete what is left of a retired index (RETIRED_INDEXES). Rolling back to a
// release that still uses one is safe: its boot recreates the index and, finding
// it empty, runs the initial sync.
async function dropRetiredIndexes() {
  for (const uid of RETIRED_INDEXES) {
    try {
      await client.getRawIndex(uid);
    } catch {
      continue; // already gone
    }
    try {
      await client.deleteIndex(uid);
      console.log(`Meilisearch: deleted the retired '${uid}' index`);
    } catch (err) {
      console.warn(`Meilisearch: could not delete the retired '${uid}' index: ${err.message}`);
    }
  }
}

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
// applies to THIS wine — see utils/grapeDisplay.grapeSearchNames, which cellar
// search (services/bottleSearch) shares. Wines with no applicable mapping
// index exactly what they indexed before.
function wineGrapeSearchNames(wine) {
  return grapeSearchNames(wine).join(', ');
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
      // findable by strangers in registry search. Cellar search
      // (services/bottleSearch) is unaffected — an owner keeps finding their
      // own bottle.
      // Canary rows (registry lockdown L4) are not searchable either: a
      // customer must never be able to find, let alone add, a wine that
      // does not exist. They stay reachable by id/slug on purpose.
      WineDefinition.find({ nonWine: { $ne: true }, pendingIdentity: { $ne: true }, canary: { $ne: true } })
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
    if (wine.nonWine === true || wine.pendingIdentity === true || wine.canary === true) {
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
    // Threads written before language sections existed carry no field; they
    // are English, which is also what the schema default gives new ones.
    language: discussion.language || 'en',
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
async function searchDiscussions(query, { category, language, limit = 20, offset = 0 } = {}) {
  if (!isAvailable) {
    throw new Error('Meilisearch is not available');
  }
  assertIndexReady('discussions');

  const { CATEGORIES: VALID_CATEGORIES } = require('../models/Discussion');
  const filters = [];
  if (category && VALID_CATEGORIES.includes(String(category))) {
    filters.push(`category = "${category}"`);
  }
  // Language section. The caller resolves the code (routes/discussions.js →
  // services/forumLanguages), so it is already a known value; the character
  // guard is belt-and-braces against a quote reaching the filter DSL, which
  // has no parameter binding.
  if (language && /^[a-z]{2,3}(-[a-z]{2,4})?$/.test(String(language))) {
    // English also matches documents indexed before the field existed, whose
    // `language` is NOT SET rather than 'en' — the same legacy-row problem
    // that emptied the English forum on the MongoDB path (2026-08-31). A
    // reindex fills them in, but search must not depend on one having run.
    filters.push(language === 'en'
      ? '(language = "en" OR language NOT EXISTS)'
      : `language = "${language}"`);
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
const RECONCILABLE_INDEXES = ['wines'];

const indexByLabel = (label) => {
  if (label === 'wines') return index;
  return null;
};

/**
 * One page of document ids from an index, oldest-first by Meilisearch's
 * internal order (stable within a run — deleteDocuments only ENQUEUES a task,
 * so nothing shifts under the paging while a sweep is walking).
 *
 * `fields: ['id']` keeps the payload to ids: a full document page would be
 * megabytes for no purpose.
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
  waitForTasks,
  fullSyncDiscussions,
  indexWine,
  removeWine,
  search,
  indexDiscussion,
  removeDiscussion,
  searchDiscussions,
  getIsAvailable,
  RECONCILABLE_INDEXES,
  listIndexDocumentIds,
  deleteIndexDocuments,
};
