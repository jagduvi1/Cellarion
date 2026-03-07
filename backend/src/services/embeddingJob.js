/**
 * Background batch embedding job.
 *
 * Scans every unique (WineDefinition, vintage) pair that exists in the Bottle
 * collection and creates / refreshes its embedding in Qdrant + WineEmbedding.
 *
 * Only one job can run at a time. The job state is kept in memory and exposed
 * via getStatus() for the admin dashboard.
 *
 * Modes
 * ------
 * incremental (default) – skip pairs that already have an up-to-date embedding
 *                         (same model, indexVersion, and textHash)
 * full                  – wipe the target Qdrant collection and re-embed everything
 *
 * Throttle
 * ---------
 * embeddingBatchDelayMs from aiConfig is slept between each Voyage AI call to
 * stay within the free-tier 3 RPM limit. The embedding service itself retries
 * on 429, providing a second line of defence.
 */

const crypto = require('crypto');
const { randomUUID } = require('crypto');
const aiConfig = require('../config/aiConfig');
const { embedSingle, buildEmbeddingText } = require('./embedding');
const vectorStore = require('./vectorStore');
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

  const cfg = aiConfig.get();

  stopRequested = false;
  job = {
    status: 'running',
    mode,
    model: cfg.embeddingModel,
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
  const { embeddingModel: model, vectorIndex, embeddingBatchDelayMs } = cfg;

  try {
    // Ensure the Qdrant collection exists before we start
    await vectorStore.ensureCollection(vectorIndex);

    // Full mode: wipe existing WineEmbedding records for this model+version
    if (job.mode === 'full') {
      await vectorStore.dropCollection(vectorIndex);
      await vectorStore.ensureCollection(vectorIndex);
      await WineEmbedding.deleteMany({ model, indexVersion: vectorIndex });
      console.log(`[embeddingJob] Full mode — cleared collection wines_${vectorIndex}`);
    }

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
          .populate('grapes', 'name')
          .lean();

        if (!wine) {
          job.skipped++;
          job.done++;
          continue;
        }

        const text = buildEmbeddingText(wine, vintage);
        const textHash = sha256(text);

        // In incremental mode, skip if embedding is already current
        if (job.mode === 'incremental') {
          const existing = await WineEmbedding.findOne({
            wineDefinition: wineDefId,
            vintage,
            model,
            indexVersion: vectorIndex
          });
          if (existing && existing.textHash === textHash && existing.status === 'ok') {
            job.skipped++;
            job.done++;
            continue;
          }
        }

        // Embed
        const vector = await embedSingle(text, { model });

        // Upsert into Qdrant
        const pointId = randomUUID();
        await vectorStore.upsertPoints(vectorIndex, [{
          id: pointId,
          vector,
          payload: {
            wineDefinitionId: wineDefId.toString(),
            vintage,
            name: wine.name,
            producer: wine.producer,
            type: wine.type || 'unknown'
          }
        }]);

        // Save / update WineEmbedding record
        await WineEmbedding.findOneAndUpdate(
          { wineDefinition: wineDefId, vintage, model, indexVersion: vectorIndex },
          {
            wineDefinition: wineDefId,
            vintage,
            model,
            indexVersion: vectorIndex,
            qdrantPointId: pointId,
            textHash,
            embeddedAt: new Date(),
            status: 'ok',
            errorMessage: null
          },
          { upsert: true, new: true }
        );

        job.done++;
      } catch (err) {
        job.errors++;
        job.done++;
        job.lastError = err.message;
        console.error(`[embeddingJob] Error embedding (${wineDefId}, ${vintage}):`, err.message);

        // Mark as error in DB so admins can see which ones failed
        try {
          await WineEmbedding.findOneAndUpdate(
            { wineDefinition: wineDefId, vintage, model, indexVersion: vectorIndex },
            {
              wineDefinition: wineDefId,
              vintage,
              model,
              indexVersion: vectorIndex,
              qdrantPointId: randomUUID(),
              textHash: '',
              embeddedAt: new Date(),
              status: 'error',
              errorMessage: err.message
            },
            { upsert: true }
          );
        } catch (_) { /* non-critical */ }
      }

      // Throttle between calls to respect Voyage free-tier RPM
      await sleep(embeddingBatchDelayMs);
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
 *  - VOYAGE_API_KEY is not configured
 *  - the pair already has an up-to-date embedding (same textHash + status ok)
 *  - a batch job is currently running (it will cover the pair itself)
 *
 * @param {string|object} wineDefId  – WineDefinition _id (string or ObjectId)
 * @param {string}        vintage    – e.g. '2019' or 'NV'
 */
async function embedSinglePair(wineDefId, vintage) {
  if (!process.env.VOYAGE_API_KEY) return;
  // Let the running batch job handle it to avoid concurrent Voyage calls
  if (job.status === 'running') return;

  const cfg = aiConfig.get();
  if (!cfg.chatEnabled) return;

  const { embeddingModel: model, vectorIndex } = cfg;

  try {
    const wine = await WineDefinition.findById(wineDefId)
      .populate('country', 'name')
      .populate('region', 'name')
      .populate('grapes', 'name')
      .lean();

    if (!wine) return;

    const text = buildEmbeddingText(wine, vintage);
    const textHash = sha256(text);

    // Skip if already embedded and current
    const existing = await WineEmbedding.findOne({
      wineDefinition: wineDefId,
      vintage,
      model,
      indexVersion: vectorIndex
    });
    if (existing && existing.textHash === textHash && existing.status === 'ok') return;

    await vectorStore.ensureCollection(vectorIndex);

    const vector = await embedSingle(text, { model });
    const pointId = randomUUID();

    await vectorStore.upsertPoints(vectorIndex, [{
      id: pointId,
      vector,
      payload: {
        wineDefinitionId: wineDefId.toString(),
        vintage,
        name: wine.name,
        producer: wine.producer,
        type: wine.type || 'unknown'
      }
    }]);

    await WineEmbedding.findOneAndUpdate(
      { wineDefinition: wineDefId, vintage, model, indexVersion: vectorIndex },
      {
        wineDefinition: wineDefId,
        vintage,
        model,
        indexVersion: vectorIndex,
        qdrantPointId: pointId,
        textHash,
        embeddedAt: new Date(),
        status: 'ok',
        errorMessage: null
      },
      { upsert: true, new: true }
    );

    console.log(`[embeddingJob] Real-time embedded: ${wine.name} ${vintage}`);
  } catch (err) {
    // Non-fatal — the batch job will retry on next run
    console.warn(`[embeddingJob] Real-time embed failed (${wineDefId}, ${vintage}):`, err.message);
  }
}

module.exports = { start, requestStop, getStatus, embedSinglePair };
