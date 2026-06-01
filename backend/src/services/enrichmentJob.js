/**
 * Background batch enrichment job.
 *
 * Generates an AI tasting/style profile (WineDefinition.aiProfile) for every
 * wine in the registry using Claude (services/labelScan.suggestProfile). The
 * profile feeds two things: the embedding text (so similarity search understands
 * taste, not just identity) and the bottle-page display.
 *
 * Only one job runs at a time. State is kept in memory and exposed via
 * getStatus() for the SuperAdmin AI tab — same pattern as embeddingJob.js.
 *
 * Modes
 * ------
 * incremental (default) – only enrich wines that have no aiProfile yet
 * full                  – re-enrich every wine, overwriting existing profiles
 *
 * Note: enrichment does NOT re-embed. After it runs, the next embedding job
 * (incremental) detects the changed embedding text via textHash and re-embeds
 * the affected wines automatically.
 */

const aiConfig = require('../config/aiConfig');
const { suggestProfile } = require('./labelScan');
const WineDefinition = require('../models/WineDefinition');

// ── In-memory job state ────────────────────────────────────────────────────

let job = {
  status: 'idle',       // 'idle' | 'running' | 'stopping' | 'done' | 'error'
  mode: null,
  model: null,
  total: 0,
  done: 0,
  enriched: 0,
  skipped: 0,
  errors: 0,
  startedAt: null,
  finishedAt: null,
  lastError: null,
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Main job logic ─────────────────────────────────────────────────────────

/**
 * Start the batch enrichment job.
 * @param {object} opts
 * @param {'incremental'|'full'} [opts.mode='incremental']
 * @param {number} [opts.limit=0]  Max wines to process this run (0 = no limit).
 *                                  Useful for a small/cheap test batch.
 */
async function start({ mode = 'incremental', limit = 0 } = {}) {
  if (job.status === 'running' || job.status === 'stopping') {
    throw new Error('A job is already running');
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const cfg = aiConfig.get();
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 0;

  stopRequested = false;
  job = {
    status: 'running',
    mode,
    limit: cap,
    model: cfg.enrichmentModel,
    total: 0,
    done: 0,
    enriched: 0,
    skipped: 0,
    errors: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    lastError: null,
  };

  // Run asynchronously — don't await so the HTTP response returns immediately
  runJob(cfg).catch(err => {
    job.status = 'error';
    job.lastError = err.message;
    job.finishedAt = new Date().toISOString();
    console.error('[enrichmentJob] Unexpected error:', err);
  });
}

async function runJob(cfg) {
  try {
    // In incremental mode, only fetch wines without a profile yet.
    const filter = job.mode === 'full'
      ? {}
      : { $or: [{ 'aiProfile.description': null }, { 'aiProfile.description': { $exists: false } }] };

    let q = WineDefinition.find(filter)
      .populate('country', 'name')
      .populate('region', 'name')
      .populate('grapes', 'name');
    // Cap the batch when a limit is set (cheap test runs).
    if (job.limit > 0) q = q.limit(job.limit);
    const wines = await q.lean();

    job.total = wines.length;
    console.log(`[enrichmentJob] Starting ${job.mode} job: ${job.total} wines${job.limit ? ` (capped at ${job.limit})` : ''}, model=${job.model}`);

    // Small pause between Claude calls — the SDK already retries 429/529, this
    // just smooths the request rate. Reuses the same knob as embedding batches.
    const delayMs = Math.min(cfg.embeddingBatchDelayMs ?? 0, 2000);

    for (const wine of wines) {
      if (stopRequested) {
        job.status = 'idle';
        job.finishedAt = new Date().toISOString();
        console.log('[enrichmentJob] Stopped by request');
        return;
      }

      try {
        const { data, debugReason } = await suggestProfile({
          name: wine.name,
          producer: wine.producer,
          vintage: 'NV', // vintage-neutral profile
          country: wine.country?.name,
          region: wine.region?.name,
          appellation: wine.appellation,
          classification: wine.classification,
          type: wine.type,
          grapes: (wine.grapes || []).map(g => g.name).filter(Boolean),
        });

        if (!data) {
          // ai_unknown / no_api_key / rate_limit / exception — count, keep going
          job.skipped++;
          if (debugReason && !debugReason.startsWith('ai_unknown')) {
            job.lastError = debugReason;
          }
        } else {
          await WineDefinition.updateOne(
            { _id: wine._id },
            {
              $set: {
                aiProfile: {
                  body:         data.body ?? null,
                  tannin:       data.tannin ?? null,
                  acidity:      data.acidity ?? null,
                  sweetness:    data.sweetness ?? null,
                  flavors:      Array.isArray(data.flavors) ? data.flavors.slice(0, 10) : [],
                  foodPairings: Array.isArray(data.foodPairings) ? data.foodPairings.slice(0, 8) : [],
                  description:  typeof data.description === 'string' ? data.description.trim() : null,
                  confidence:   typeof data.confidence === 'number' ? data.confidence : null,
                  model:        job.model,
                  generatedAt:  new Date(),
                },
                updatedAt: new Date(),
              },
            }
          );
          job.enriched++;
        }
      } catch (err) {
        job.errors++;
        job.lastError = err.message;
        console.error(`[enrichmentJob] Error enriching ${wine._id} (${wine.name}):`, err.message);
      }

      job.done++;
      if (delayMs > 0) await sleep(delayMs);
    }

    job.status = 'done';
    job.finishedAt = new Date().toISOString();
    console.log(`[enrichmentJob] Finished: ${job.enriched} enriched, ${job.skipped} skipped, ${job.errors} errors`);
  } catch (err) {
    job.status = 'error';
    job.lastError = err.message;
    job.finishedAt = new Date().toISOString();
    throw err;
  }
}

module.exports = { start, requestStop, getStatus };
