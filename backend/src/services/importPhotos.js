/**
 * The photos an import copies in from the owner's other cellar app, after the
 * bottles exist (routes/import.js /confirm). A file links each wine to the
 * photo its owner took in that app; the photo is downloaded here, from an
 * allowed photo store only (config/importPhotoSources), through the SSRF guard
 * (utils/safeImageFetch), and handed to the SAME pipeline as an upload
 * (services/imageOps.ingestBottleImage): sanitised, stored, background
 * removed, and waiting for the image check like any member's photo. Nothing
 * here publishes a photo.
 *
 * In memory, one photo at a time for the whole server, the next one only once
 * no background removal is running: an import of hundreds of wines must not
 * start hundreds of rembg runs. The backend is one process, as its other
 * queues assume. A link is used once and never stored; a restart drops what
 * is still waiting (the shutdown drain lets the current photo finish and says
 * how many were left).
 */
const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const Cellar = require('../models/Cellar');
const { importPhotoSource } = require('../config/importPhotoSources');
const { safeFetchImage } = require('../utils/safeImageFetch');
const { getCellarRole } = require('../utils/cellarAccess');
const { photoVintage } = require('../utils/imageVintage');
const { snapshotRequest } = require('../mcp/requestSnapshot');
const { ingestBottleImage } = require('./imageOps');
const { whenProcessingIdle } = require('./imageProcessor');
const { logger, logAudit } = require('./audit');

// More waiting photos than any one import can bring (an import is at most
// MAX_IMPORT_SIZE rows); beyond it a link is dropped and counted.
const MAX_WAITING = 5000;

const waiting = [];
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
  storeFailed: 'store_failed',
  error: 'error',
};

// The reason goes to the log; never the link, whose query is the owner's token.
const warn = (bottleId, reason) => logger.warn({ bottleId: String(bottleId), reason }, '[importPhotos] photo not added');

/** The one job for a photo: its bottle, its link and the import it belongs to. */
async function addPhoto({ bottleId, url, batch }) {
  const bottle = await Bottle.findById(bottleId);
  if (!bottle) return OUTCOME.gone;
  const cellar = await Cellar.findById(bottle.cellar).select('user members deletedAt').lean();
  const role = cellar && !cellar.deletedAt ? getCellarRole(cellar, batch.req.user.id) : null;
  if (role !== 'owner' && role !== 'editor') return OUTCOME.noAccess;

  const wineDefinitionId = bottle.wineDefinition ? String(bottle.wineDefinition) : null;
  // A file imported twice adds no second copy: a photo of this wine and
  // vintage from this member shows on all their bottles of it already.
  const hasPhoto = await BottleImage.exists({
    uploadedBy: batch.req.user.id,
    status: { $ne: 'rejected' },
    kind: { $ne: 'label-scan' },
    $or: [
      { bottle: bottle._id },
      ...(wineDefinitionId ? [{ wineDefinition: wineDefinitionId, vintage: photoVintage(bottle.vintage) }] : []),
    ],
  });
  if (hasPhoto) return OUTCOME.hasPhoto;

  let buffer;
  try {
    ({ buffer } = await safeFetchImage(url));
  } catch (err) {
    warn(bottle._id, err.message);
    return OUTCOME.fetchFailed;
  }
  const result = await ingestBottleImage({
    buffer, userId: batch.req.user.id, userRoles: batch.req.user.roles, bottle, wineDefinitionId,
    keepBackground: false, via: 'import',
  }, batch.req);
  if (result.error) {
    warn(bottle._id, result.error.message);
    return result.error.status >= 500 ? OUTCOME.storeFailed : OUTCOME.notAnImage;
  }
  return OUTCOME.added;
}

function finishBatch(batch) {
  const { added = 0, ...notAdded } = batch.outcomes;
  logAudit(batch.req, 'import.photos', { type: 'cellar', id: batch.cellarId, cellarId: batch.cellarId }, {
    queued: batch.queued,
    added,
    ...(Object.keys(notAdded).length ? { notAdded } : {}),
  });
}

async function work() {
  while (waiting.length > 0 && !stopping) {
    const job = waiting.shift();
    let outcome;
    try {
      outcome = await addPhoto(job);
    } catch (err) {
      warn(job.bottleId, err.message);
      outcome = OUTCOME.error;
    }
    const { batch } = job;
    batch.outcomes[outcome] = (batch.outcomes[outcome] || 0) + 1;
    batch.left -= 1;
    if (batch.left === 0) finishBatch(batch);
    await whenProcessingIdle();
  }
}

function start() {
  if (running || stopping) return;
  running = work()
    .catch((err) => logger.warn({ err: err.message }, '[importPhotos] queue stopped'))
    .finally(() => {
      running = null;
      if (waiting.length > 0 && !stopping) start();
    });
}

/**
 * Queue the photos of one import: rows of { bottleId, url } for the bottles
 * /confirm just created. Links outside config/importPhotoSources are left
 * out, and rows that share a link (the bottles of one wine) give one photo,
 * on the first of them. Called by routes/import.js /confirm; returns how many
 * photos were queued.
 */
function queueImportPhotos(req, rows, { cellarId } = {}) {
  const seen = new Set();
  const jobs = [];
  for (const row of rows || []) {
    if (!row || !importPhotoSource(row.url) || seen.has(row.url)) continue;
    seen.add(row.url);
    jobs.push({ bottleId: row.bottleId, url: row.url });
  }
  const room = Math.max(0, MAX_WAITING - waiting.length);
  if (jobs.length > room) {
    logger.warn({ dropped: jobs.length - room, userId: req?.user?.id }, '[importPhotos] queue full, photos dropped');
    jobs.length = room;
  }
  if (jobs.length === 0) return 0;
  const batch = { req: snapshotRequest(req), cellarId, queued: jobs.length, left: jobs.length, outcomes: {} };
  for (const job of jobs) waiting.push({ ...job, batch });
  start();
  return jobs.length;
}

/**
 * Shutdown drain (server.js): take no further photo, let the current one
 * finish, and log how many were still waiting.
 */
async function stopImportPhotos() {
  stopping = true;
  if (waiting.length > 0) logger.warn({ left: waiting.length }, '[importPhotos] shutting down with photos still waiting');
  await running;
}

/** Test seam: an empty queue that takes photos again. */
function resetImportPhotosForTest() {
  waiting.length = 0;
  stopping = false;
}

/** Resolves once the queue has nothing left to do. */
async function whenImportPhotosIdle() {
  while (running) await running;
}

module.exports = { queueImportPhotos, stopImportPhotos, whenImportPhotosIdle, resetImportPhotosForTest };
