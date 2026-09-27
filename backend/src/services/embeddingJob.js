/**
 * Background batch embedding job.
 *
 * Scans every unique (WineDefinition, vintage) pair that exists in the Bottle
 * collection and creates / refreshes its vector on its WineEmbedding row
 * (services/vectorStore searches them).
 *
 * Only one job can run at a time. The job state is kept in memory and exposed
 * via getStatus() for the admin dashboard.
 *
 * Modes
 * ------
 * incremental (default) – skip pairs that already have an up-to-date vector
 *                         (same model, indexVersion, textHash and dimension)
 * full                  – re-embed everything in place, then delete the rows
 *                         this run didn't write (old models, pairs no longer
 *                         in any cellar). Search keeps working throughout:
 *                         each row keeps its old vector until its new one
 *                         is written.
 *
 * Throttle
 * ---------
 * embeddingBatchDelayMs from aiConfig is slept between each Voyage AI call to
 * stay within the free-tier 3 RPM limit. The embedding service itself retries
 * on 429, providing a second line of defence.
 */

const crypto = require('crypto');
const aiConfig = require('../config/aiConfig');
const { embedSingle, buildEmbeddingText, isEmbeddingConfigured, getEmbeddingDimension } = require('./embedding');
const { encodeVector } = require('./vectorStore');
const WineEmbedding = require('../models/WineEmbedding');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');

// ── In-memory job state ────────────────────────────────────────────────────

let job = {
  status: 'idle',       // 'idle' | 'running' | 'stopping' | 'done' | 'error'
  mode: null,
  model: null,
  indexVersion: null,
  total: 0,
  done: 0,
  skipped: 0,
  errors: 0,
  startedAt: null,
  finishedAt: null,
  lastError: null
};

let stopRequested = false;

function getStatus() {
  return { ...job };
}

function requestStop() {
  if (job.status === 'running') {
    stopRequested = true;
    job.status = 'stopping';
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// A row is current when its text, status and vector all match what the
// active provider would produce now. A row without a vector (not migrated, or
// written by an old version) or of another dimension (provider/model switch)
// is stale.
function isCurrent(row, textHash) {
  return !!row && row.textHash === textHash && row.status === 'ok' && row.dim === getEmbeddingDimension();
}

// Write a pair's fresh vector onto its row (upsert).
async function storeVector({ wineDefId, vintage, model, indexVersion, textHash, values }) {
  const { vector, norm, dim } = encodeVector(values);
  await WineEmbedding.findOneAndUpdate(
    { wineDefinition: wineDefId, vintage, model, indexVersion },
    { $set: { vector, norm, dim, textHash, embeddedAt: new Date(), status: 'ok', errorMessage: null } },
    { upsert: true }
  );
}

/**
 * Gather every unique (wineDefinitionId, vintage) pair from active Bottle docs.
 */
async function collectPairs() {
  const rows = await Bottle.aggregate([
    { $match: { status: 'active' } },
    { $group: { _id: { wineDefinition: '$wineDefinition', vintage: '$vintage' } } },
    { $project: { _id: 0, wineDefinition: '$_id.wineDefinition', vintage: '$_id.vintage' } }
  ]);
  return rows;
}

// ── Main job logic ─────────────────────────────────────────────────────────

/**
 * Start the batch embedding job.
 *
 * @param {object} opts
 * @param {'incremental'|'full'} [opts.mode='incremental']
 */
async function start({ mode = 'incremental' } = {}) {
  if (job.status === 'running' || job.status === 'stopping') {
    throw new Error('A job is already running');
  }
  // A broken embedding config (e.g. EMBEDDING_PROVIDER=openai without
  // EMBEDDING_DIMENSION) would fail every pair — say so up front.
  if (!isEmbeddingConfigured()) {
    throw new Error('Embedding provider is not configured — set VOYAGE_API_KEY, or EMBEDDING_BASE_URL/EMBEDDING_MODEL/EMBEDDING_DIMENSION for EMBEDDING_PROVIDER=openai');
  }

  const cfg = aiConfig.get();

  stopRequested = false;
  job = {
    status: 'running',
    mode,
    model: cfg.embeddingModel, // provider-resolved by aiConfig.get()
    indexVersion: cfg.vectorIndex,
    total: 0,
    done: 0,
    skipped: 0,
    errors: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    lastError: null
  };

  // Run asynchronously — don't await here so the HTTP response returns immediately
  runJob(cfg).catch(err => {
    job.status = 'error';
    job.lastError = err.message;
    job.finishedAt = new Date().toISOString();
    console.error('[embeddingJob] Unexpected error:', err);
  });
}

async function runJob(cfg) {
  // cfg.embeddingModel is provider-resolved by aiConfig.get(), so the
  // WineEmbedding bookkeeping records the model that actually embedded.
  const { embeddingModel: model, vectorIndex, embeddingBatchDelayMs } = cfg;

  try {
    // Full mode re-embeds every row in place; the rows it didn't write are
    // deleted once it completes (below) — stale records from a previous model
    // (e.g. after switching voyage-4-lite -> voyage-4-large) and pairs no
    // longer in any cellar. Until then every row keeps its old vector, so
    // search never goes empty mid-rebuild.
    const runStartedAt = new Date();

    const pairs = await collectPairs();
    job.total = pairs.length;
    console.log(`[embeddingJob] Starting ${job.mode} job: ${job.total} pairs, model=${model}, index=${vectorIndex}`);

    for (const { wineDefinition: wineDefId, vintage } of pairs) {
      if (stopRequested) {
        job.status = 'idle';
        job.finishedAt = new Date().toISOString();
        console.log('[embeddingJob] Stopped by request');
        return;
      }

      try {
        // Fetch the WineDefinition with populated refs
        const wine = await WineDefinition.findById(wineDefId)
          .populate('country', 'name')
          .populate('region', 'name')
          // regionalNames feed buildEmbeddingText's regional grape labels.
          .populate('grapes', 'name regionalNames')
          .lean();

        // A pendingIdentity wine is never embedded: its text would be
        // "<name> — " with no producer and often a misplaced region, so it
        // would pollute semantic search AND the similar-wines graph with a row
        // strangers must not see anyway. The promoting write re-embeds
        // (reembedActiveVintages), which is when the pair genuinely enters.
        // A canary (registry lockdown L4) is never embedded either: it must
        // not become anyone's "similar wine".
        if (!wine || wine.pendingIdentity === true || wine.canary === true) {
          job.skipped++;
          job.done++;
          continue;
        }

        const text = buildEmbeddingText(wine, vintage);
        const textHash = sha256(text);

        // In incremental mode, skip if the vector is already current
        if (job.mode === 'incremental') {
          const existing = await WineEmbedding.findOne({
            wineDefinition: wineDefId,
            vintage,
            model,
            indexVersion: vectorIndex
          }).select('textHash status dim').lean();
          if (isCurrent(existing, textHash)) {
            job.skipped++;
            job.done++;
            continue;
          }
        }

        // Embed, then write the vector onto the row
        const values = await embedSingle(text, { model });
        await storeVector({ wineDefId, vintage, model, indexVersion: vectorIndex, textHash, values });

        job.done++;
      } catch (err) {
        job.errors++;
        job.done++;
        job.lastError = err.message;
        console.error(`[embeddingJob] Error embedding (${wineDefId}, ${vintage}):`, err.message);

        // Mark as error in DB so admins can see which ones failed. A row that
        // already has a vector keeps it — searchable as before, and re-embedded
        // by the next run (the emptied textHash makes it stale).
        try {
          await WineEmbedding.findOneAndUpdate(
            { wineDefinition: wineDefId, vintage, model, indexVersion: vectorIndex },
            {
              $set: {
                textHash: '',
                embeddedAt: new Date(),
                status: 'error',
                errorMessage: err.message,
              },
              $setOnInsert: {
                wineDefinition: wineDefId,
                vintage,
                model,
                indexVersion: vectorIndex,
              },
            },
            { upsert: true }
          );
        } catch (_) { /* non-critical */ }
      }

      // Throttle between calls to respect Voyage free-tier RPM
      await sleep(embeddingBatchDelayMs);
    }

    // A completed full run: the rows it didn't write are stale (another
    // model, or a pair no longer in any cellar) — this is what dropping the
    // whole index used to achieve, minus the outage.
    if (job.mode === 'full') {
      const { deletedCount } = await WineEmbedding.deleteMany({ indexVersion: vectorIndex, embeddedAt: { $lt: runStartedAt } });
      if (deletedCount) console.log(`[embeddingJob] Full mode — removed ${deletedCount} rows this run did not rewrite`);
    }

    job.status = 'done';
    job.finishedAt = new Date().toISOString();
    console.log(`[embeddingJob] Finished: ${job.done} processed, ${job.skipped} skipped, ${job.errors} errors`);
  } catch (err) {
    job.status = 'error';
    job.lastError = err.message;
    job.finishedAt = new Date().toISOString();
    throw err;
  }
}

// ── Real-time single-pair embedding ───────────────────────────────────────

/**
 * Embed a single (wineDefinition, vintage) pair immediately.
 * Designed to be called fire-and-forget from the bottle creation / update
 * routes — errors are caught and logged, never thrown to the caller.
 *
 * Skips silently when:
 *  - the embedding provider is not configured
 *  - the pair already has an up-to-date embedding (same textHash + status ok)
 *
 * @param {string|object} wineDefId  – WineDefinition _id (string or ObjectId)
 * @param {string}        vintage    – e.g. '2019' or 'NV'
 */
async function embedSinglePair(wineDefId, vintage) {
  if (!isEmbeddingConfigured()) return;
  // Intentionally NOT skipped while a batch job runs: a batch snapshots its
  // (wine, vintage) list at start, so a just-added pair isn't covered by it.
  // The textHash check below makes a redundant re-embed a cheap no-op.

  const cfg = aiConfig.get();
  if (!cfg.chatEnabled) return;

  const { embeddingModel: model, vectorIndex } = cfg;

  try {
    const wine = await WineDefinition.findById(wineDefId)
      .populate('country', 'name')
      .populate('region', 'name')
      // regionalNames feed buildEmbeddingText's regional grape labels.
      .populate('grapes', 'name regionalNames')
      .lean();

    // Same rule as the batch loop: never embed a pending-identity row. This is
    // the fire-and-forget call every bottle add makes, so without it the very
    // add that mints a pending wine would immediately index it for semantic
    // search — the one surface that would leak it to strangers.
    if (!wine || wine.pendingIdentity === true || wine.canary === true) return;

    const text = buildEmbeddingText(wine, vintage);
    const textHash = sha256(text);

    // Skip if already embedded and current
    const existing = await WineEmbedding.findOne({
      wineDefinition: wineDefId,
      vintage,
      model,
      indexVersion: vectorIndex
    }).select('textHash status dim').lean();
    if (isCurrent(existing, textHash)) return;

    // The row keeps its old vector until the new one is written, so a failed
    // Voyage call below never leaves the wine missing from search.
    const values = await embedSingle(text, { model });
    await storeVector({ wineDefId, vintage, model, indexVersion: vectorIndex, textHash, values });

    console.log(`[embeddingJob] Real-time embedded: ${wine.name} ${vintage}`);
  } catch (err) {
    // Non-fatal — the batch job will retry on next run. Constant format string:
    // vintage is user-entered free text (Bottle.vintage), so it must stay out of
    // console.warn's format-string position (CodeQL js/tainted-format-string).
    console.warn('[embeddingJob] Real-time embed failed (%s, %s):', String(wineDefId), String(vintage), err.message);
  }
}

/**
 * Re-embed every ACTIVE vintage of one wine — the follow-through for any
 * write that changes what buildEmbeddingText produces (curator profile
 * corrections; enrichment already inlines the same loop). Without it the
 * stored vector keeps matching on the OLD profile until someone manually
 * runs the batch job — for the Sandeman case that motivated #853, the wrong
 * character would live on in semantic search after the curator fixed it.
 * Best-effort by design: embedding lag must never fail a curation write.
 */
async function reembedActiveVintages(wineDefId) {
  try {
    const vintages = await Bottle.distinct('vintage', { wineDefinition: wineDefId, status: 'active' });
    for (const v of vintages) {
      await embedSinglePair(wineDefId, v).catch(() => {});
    }
  } catch (err) {
    console.warn(`[embeddingJob] re-embed after correction failed (${wineDefId}):`, err.message);
  }
}

module.exports = { start, requestStop, getStatus, embedSinglePair, reembedActiveVintages };
