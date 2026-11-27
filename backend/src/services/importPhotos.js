/**
 * The photos an import copies in from the owner's other cellar app, after the
 * bottles exist (routes/import.js /confirm). A file links each wine to the
 * photo its owner took in that app. The browser keeps those links and sends
 * them only with /confirm, and only when the owner ticked "bring in the
 * photos" (frontend utils/importPhotoLinks); here each one is downloaded from
 * an allowed photo store only (config/importPhotoSources, checked on every
 * redirect too), through the SSRF guard (utils/safeImageFetch), and handed to
 * the SAME pipeline as an upload (services/imageOps.ingestBottleImage) with its
 * background KEPT: it is the owner's own photo, and it comes in as they took
 * it (sanitised, metadata stripped, at most 2048 px, as every kept photo is),
 * never cut out. Whether others may see it is decided as for any member's
 * photo: on a server that reviews photos, by the image curator; on one whose
 * admin turned review off, it goes live as an upload there does
 * (services/trustedContributions). Nothing here publishes a photo itself.
 *
 * In memory, one photo at a time for the whole server, taking the imports
 * that wait in turn (one photo each), so a large import does not hold back a
 * small one. A member queues at most DAILY_PHOTOS_PER_USER photos a day; what
 * does not fit is counted, answered and audited, never dropped unseen. A link
 * is used once and never stored. The backend is one process, as its other
 * queues assume; a restart drops what is still waiting, and the shutdown drain
 * lets the photo in hand finish and writes the summary row of every import cut
 * short.
 */
const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const Cellar = require('../models/Cellar');
const { importPhotoSource } = require('../config/importPhotoSources');
const { MAX_IMPORT_SIZE } = require('../config/constants');
const { safeFetchImage } = require('../utils/safeImageFetch');
const { getCellarRole } = require('../utils/cellarAccess');
const { photoVintage } = require('../utils/imageVintage');
const { snapshotRequest } = require('../mcp/requestSnapshot');
const { ingestBottleImage } = require('./imageOps');
const { logger, logAudit } = require('./audit');

// Room for a few full imports at once; beyond it a link is not queued, and
// says so (photosNotQueued, the summary row).
const MAX_WAITING = 5000;
// One full import's worth a day: a member re-sending the same file cannot
// make the server download and store without end. The upload route has its
// own, tighter per-hour cap for photos sent one by one.
const DAILY_PHOTOS_PER_USER = MAX_IMPORT_SIZE;
const DAY_MS = 24 * 60 * 60 * 1000;

// The imports with photos still to add, served in turn.
const batches = [];
// userId → { since, count }: photos queued in the current day window.
const queuedToday = new Map();
let running = null;
let stopping = false;

// What became of one photo, counted in the import's summary row.
const OUTCOME = {
  added: 'added',
  gone: 'bottle_gone',
  noAccess: 'no_access',
  hasPhoto: 'already_has_photo',
  fetchFailed: 'fetch_failed',
  notAnImage: 'not_an_image',
  photoLimit: 'photo_limit',
  storeFailed: 'store_failed',
  notRun: 'not_run',
  error: 'error',
};

// The reason goes to the log; never the link, whose query is the owner's token.
const warn = (bottleId, reason) => logger.warn({ bottleId: String(bottleId), reason }, '[importPhotos] photo not added');

const waitingCount = () => batches.reduce((n, b) => n + b.jobs.length, 0);

// One form per photo: the fragment is never sent, and spaces around a link
// are not part of it, so neither makes the same photo a second one.
function canonicalLink(url) {
  if (typeof url !== 'string' || !importPhotoSource(url.trim())) return null;
  const u = new URL(url.trim());
  return `${u.origin}${u.pathname}${u.search}`;
}

const onAllowedStore = (urlObj) => !!importPhotoSource(urlObj.href);

/** The one job for a photo: its bottle, its link and the import it belongs to. */
async function addPhoto({ bottleId, url }, batch) {
  const bottle = await Bottle.findById(bottleId);
  if (!bottle) return OUTCOME.gone;
  const cellar = await Cellar.findById(bottle.cellar).select('user members deletedAt').lean();
  const role = cellar && !cellar.deletedAt ? getCellarRole(cellar, batch.req.user.id) : null;
  if (role !== 'owner' && role !== 'editor') return OUTCOME.noAccess;

  const wineDefinitionId = bottle.wineDefinition ? String(bottle.wineDefinition) : null;
  const vintage = photoVintage(bottle.vintage);
  // A file imported again adds no second copy of a photo this member already
  // has for this bottle, or for this wine and vintage (which shows on all
  // their bottles of it). A photo the curator turned down counts too: an
  // import does not hand them the same one again.
  const hasPhoto = await BottleImage.exists({
    uploadedBy: batch.req.user.id,
    kind: { $ne: 'label-scan' },
    $or: [
      { bottle: bottle._id },
      ...(wineDefinitionId && vintage ? [{ wineDefinition: wineDefinitionId, vintage }] : []),
    ],
  });
  if (hasPhoto) return OUTCOME.hasPhoto;

  let buffer;
  try {
    ({ buffer } = await safeFetchImage(url, { allowUrl: onAllowedStore }));
  } catch (err) {
    warn(bottle._id, err.message);
    return OUTCOME.fetchFailed;
  }
  const result = await ingestBottleImage({
    buffer, userId: batch.req.user.id, userRoles: batch.req.user.roles, bottle, wineDefinitionId,
    keepBackground: true, via: 'import',
  }, batch.req);
  if (result.error) {
    warn(bottle._id, result.error.message);
    if (result.error.code === 'photo_limit') return OUTCOME.photoLimit;
    return result.error.status >= 500 ? OUTCOME.storeFailed : OUTCOME.notAnImage;
  }
  return OUTCOME.added;
}

// The import's one audit row for its photos (imageOps writes none per photo).
function writeSummary(batch) {
  const { added = 0, ...notAdded } = batch.outcomes;
  logAudit(batch.req, 'import.photos', { type: 'cellar', id: batch.cellarId, cellarId: batch.cellarId }, {
    queued: batch.queued,
    added,
    ...(Object.keys(notAdded).length ? { notAdded } : {}),
    ...(batch.notQueued ? { notQueued: batch.notQueued } : {}),
  });
}

async function work() {
  while (batches.length > 0 && !stopping) {
    const batch = batches.shift();
    const job = batch.jobs.shift();
    let outcome;
    try {
      outcome = await addPhoto(job, batch);
    } catch (err) {
      warn(job.bottleId, err.message);
      outcome = OUTCOME.error;
    }
    batch.outcomes[outcome] = (batch.outcomes[outcome] || 0) + 1;
    // Back of the line while it has photos left: imports take turns.
    if (batch.jobs.length > 0) batches.push(batch);
    else writeSummary(batch);
  }
}

function start() {
  if (running || stopping) return;
  running = work()
    .catch((err) => logger.warn({ err: err.message }, '[importPhotos] queue stopped'))
    .finally(() => {
      running = null;
      if (batches.length > 0 && !stopping) start();
    });
}

// How many more photos this member may queue today.
function dailyRoom(userId) {
  const now = Date.now();
  const entry = queuedToday.get(userId);
  if (!entry || now - entry.since >= DAY_MS) return DAILY_PHOTOS_PER_USER;
  return Math.max(0, DAILY_PHOTOS_PER_USER - entry.count);
}

function countQueued(userId, n) {
  const now = Date.now();
  const entry = queuedToday.get(userId);
  if (!entry || now - entry.since >= DAY_MS) queuedToday.set(userId, { since: now, count: n });
  else entry.count += n;
}

/**
 * Queue the photos of one import: rows of { bottleId, url } for the bottles
 * /confirm just created. Links outside config/importPhotoSources are left
 * out, and rows that share a link (the bottles of one wine) give one photo,
 * on the first of them. Links beyond the member's daily room or the queue's,
 * or sent while the server shuts down, are not queued and are counted. Called
 * by routes/import.js /confirm; returns { queued, notQueued }.
 */
function queueImportPhotos(req, rows, { cellarId } = {}) {
  const seen = new Set();
  const jobs = [];
  for (const row of rows || []) {
    const url = row ? canonicalLink(row.url) : null;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    jobs.push({ bottleId: row.bottleId, url });
  }
  if (jobs.length === 0) return { queued: 0, notQueued: 0 };

  const userId = String(req?.user?.id || '');
  const room = stopping ? 0 : Math.min(dailyRoom(userId), Math.max(0, MAX_WAITING - waitingCount()));
  const notQueued = Math.max(0, jobs.length - room);
  if (notQueued > 0) {
    logger.warn({ notQueued, userId }, '[importPhotos] photos not queued (daily room, queue full or shutting down)');
    jobs.length = room;
  }
  const batch = { req: snapshotRequest(req), cellarId, queued: jobs.length, notQueued, jobs, outcomes: {} };
  if (jobs.length === 0) {
    writeSummary(batch);
    return { queued: 0, notQueued };
  }
  // Counted before start(): the queue takes its first job off `jobs` at once.
  const queued = jobs.length;
  countQueued(userId, queued);
  batches.push(batch);
  start();
  return { queued, notQueued };
}

/**
 * Shutdown drain (server.js): take no further photo, let the one in hand
 * finish, and write the summary row of every import cut short (its photos
 * not run counted as such).
 */
async function stopImportPhotos() {
  stopping = true;
  await running;
  const left = waitingCount();
  if (left > 0) logger.warn({ left }, '[importPhotos] shutting down with photos still waiting');
  for (const batch of batches.splice(0)) {
    batch.outcomes[OUTCOME.notRun] = (batch.outcomes[OUTCOME.notRun] || 0) + batch.jobs.length;
    batch.jobs.length = 0;
    writeSummary(batch);
  }
}

/** Test seam: an empty queue that takes photos again, with no day counted. */
function resetImportPhotosForTest() {
  batches.length = 0;
  queuedToday.clear();
  stopping = false;
}

/** Resolves once the queue has nothing left to do. */
async function whenImportPhotosIdle() {
  while (running) await running;
}

module.exports = {
  queueImportPhotos, stopImportPhotos, whenImportPhotosIdle, resetImportPhotosForTest, DAILY_PHOTOS_PER_USER,
};
