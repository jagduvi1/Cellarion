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
 * After a profile is written, the wine's active (wine, vintage) pairs are
 * re-embedded immediately (embedSinglePair) so the new taste data reaches Qdrant
 * without a separate manual embedding job. The textHash check inside
 * embedSinglePair means this only does real work when the text actually changed.
 */

const mongoose = require('mongoose');
const aiConfig = require('../config/aiConfig');
const { stripMarkdown } = require('../utils/stripMarkdown');
const { tryDebitAi, isRefundableFailure } = require('./aiBudget');
const { suggestProfile } = require('./labelScan');
const aiProvider = require('./aiProvider');
const { embedSinglePair } = require('./embeddingJob');
const { isValidId } = require('../utils/validation');
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');

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

// Fixed pause between Claude calls during the batch — a small constant so the
// request rate is smooth. It is a hardcoded literal (NOT derived from config or
// any request input), so no user-controlled value can ever reach setTimeout.
const BATCH_PAUSE_MS = 250;
function sleep() {
  return new Promise(resolve => setTimeout(resolve, BATCH_PAUSE_MS));
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
  aiProvider.assertConfigured(); // throws when the active AI provider lacks config

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

    for (const wine of wines) {
      if (stopRequested) {
        job.status = 'idle';
        job.finishedAt = new Date().toISOString();
        console.log('[enrichmentJob] Stopped by request');
        return;
      }

      try {
        const { result, reason } = await enrichWine(wine, job.model);
        if (result === 'enriched') job.enriched++;
        else {
          job.skipped++;
          if (reason) job.lastError = reason;
        }
      } catch (err) {
        job.errors++;
        job.lastError = err.message;
        console.error(`[enrichmentJob] Error enriching ${wine._id} (${wine.name}):`, err.message);
      }

      job.done++;
      await sleep();
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

// ── Single-wine enrichment (shared by the batch loop + bottle-add hook) ──────

/**
 * Enrich one wine: ask Claude for a vintage-neutral tasting profile, store it on
 * the WineDefinition, then re-embed the wine's active vintages so the new taste
 * data reaches Qdrant immediately.
 *
 * @param {object} wine   – populated WineDefinition (country/region/grapes names)
 * @param {string} model  – embedding/enrichment model label to stamp on the profile
 * @returns {{ result: 'enriched'|'skipped', reason: string|null }}
 *   `reason` carries a non-trivial skip cause; only the batch loop writes it
 *   to the module-level job state, so a fire-and-forget enrichWineById can't
 *   pollute the admin job status.
 */
async function enrichWine(wine, model) {
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
    // ai_unknown / no_api_key / rate_limit / exception — surface non-trivial reasons
    const reason = debugReason && !debugReason.startsWith('ai_unknown') ? debugReason : null;
    return { result: 'skipped', reason };
  }

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
          // Strip markdown, don't just trim: the model reaches for emphasis even
          // when told not to, and the raw string is served un-rendered by the MCP
          // tools. Load-bearing half of the fix — the prompt is only advisory,
          // and a self-hoster can override it via SiteConfig.
          description:  typeof data.description === 'string' ? (stripMarkdown(data.description) || null) : null,
          confidence:   typeof data.confidence === 'number' ? data.confidence : null,
          // The model's own doubt about the producer FIELD (registry audit
          // follow-up: "Arcane" — a range sold as a producer — sailed past
          // every string gate AND 49 audit agents; only this model hedged).
          // Strict true-check: absent on old/custom prompts → false.
          producerSuspect: data.producerSuspect === true,
          producerNote: typeof data.producerNote === 'string'
            ? (stripMarkdown(data.producerNote).slice(0, 300) || null)
            : null,
          model:        model || aiConfig.get().enrichmentModel,
          generatedAt:  new Date(),
        },
        updatedAt: new Date(),
      },
    }
  );

  // Re-embed this wine's active vintages so the new profile reaches Qdrant
  // immediately. embedSinglePair is a no-op when the text/hash is unchanged and
  // self-skips during a batch embedding job. Best-effort — never fail enrichment.
  try {
    const vintages = await Bottle.distinct('vintage', { wineDefinition: wine._id, status: 'active' });
    for (const v of vintages) {
      await embedSinglePair(wine._id, v).catch(() => {});
    }
  } catch (embedErr) {
    console.warn(`[enrichmentJob] re-embed after enrich failed (${wine._id}):`, embedErr.message);
  }

  return { result: 'enriched', reason: null };
}

/**
 * Fire-and-forget enrichment for a single wine by id — used when a brand-new
 * wine is created so it gets a tasting profile (and updated embedding) without
 * waiting for the next batch run. Skips silently if the wine already has a
 * profile or AI isn't configured. Never throws.
 *
 * When triggered by a user action (bottle-add), pass `budgetUserId` so the
 * Anthropic call is debited against that user's shared daily AI budget
 * (SECURITY_AUDIT_2026-07-08 L-14). Over budget → skip silently (the profile
 * arrives with the next admin batch run instead — graceful degradation, the
 * user's own action still succeeds). The admin-run batch job calls
 * enrichWine() directly and is exempt.
 *
 * @param {string|object} wineDefId
 * @param {object}  [opts]
 * @param {string}  [opts.budgetUserId] – user to debit for this AI call
 */
async function enrichWineById(wineDefId, { budgetUserId } = {}) {
  // Validate + cast the (caller-supplied) id to a real ObjectId before it touches
  // the query, so a non-id value can never shape the database lookup. The cast
  // value (idStr/oid), never the raw input, is used everywhere below.
  const idStr = String(wineDefId);
  if (!isValidId(idStr)) return;
  const oid = new mongoose.Types.ObjectId(idStr);
  try {
    if (!aiProvider.isConfigured()) {
      console.warn('[enrichmentJob] enrichWineById skipped: AI provider not configured');
      return;
    }
    // Intentionally NOT skipped while a batch job runs: a batch snapshots its
    // wine list at start, so a just-created wine isn't covered by it — skipping
    // here would leave new wines permanently un-enriched. The already-enriched
    // guard below prevents redundant work.
    const wine = await WineDefinition.findById(oid)
      .populate('country', 'name')
      .populate('region', 'name')
      .populate('grapes', 'name')
      .lean();
    if (!wine) return;
    if (wine.aiProfile && wine.aiProfile.description) return; // already enriched

    if (budgetUserId) {
      const debit = await tryDebitAi(String(budgetUserId));
      if (!debit.ok) {
        // Over the shared daily AI budget — skip silently; the next admin
        // batch run picks the wine up. The triggering action never fails.
        console.warn('[enrichmentJob] enrichWineById skipped (%s): ai budget exhausted (%s)', idStr, debit.reason);
        return;
      }
      try {
        const { result, reason } = await enrichWine(wine, aiConfig.get().enrichmentModel);
        // A transport-level failure never produced a billable completion
        if (result === 'skipped' && isRefundableFailure(reason)) await debit.refund();
      } catch (err) {
        await debit.refund();
        throw err; // handled by the outer catch below
      }
    } else {
      await enrichWine(wine, aiConfig.get().enrichmentModel);
    }
    console.log('[enrichmentJob] Auto-enriched new wine: %s', wine.name);
  } catch (err) {
    console.warn('[enrichmentJob] enrichWineById failed (%s): %s', idStr, err.message);
  }
}

module.exports = { start, requestStop, getStatus, enrichWineById };
