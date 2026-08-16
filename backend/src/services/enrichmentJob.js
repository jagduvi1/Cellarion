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
const { PROFILE_ENUMS, LIST_FIELDS, DESCRIPTION_MAX } = require('./wineProfileOps');
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');

// The model occasionally emits a placeholder STRING where the prompt asks for
// JSON null — support ticket 2026-07-30: 161 prod profiles carried the literal
// string "null" in tannin, which passes every truthiness check downstream and
// leaks the token into the embedding text. The prompt now spells out "never
// the quoted string", but a prompt is advisory; this is the guarantee. A value
// outside the field's enum is equally meaningless to the UI pickers and the
// embedding text, so both collapse to null.
const SENTINEL_VALUE_RX = /^(null|none|n\/?a|undefined|unknown|nil|-+|)$/i;

function cleanDescriptor(field, raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (SENTINEL_VALUE_RX.test(v)) return null;
  return PROFILE_ENUMS[field].includes(v) ? v : null;
}

// Bounds come from LIST_FIELDS rather than being repeated here, because the
// curator path already enforces them on the same fields of the same collection.
// Capping the array but not its elements meant a model could write unbounded
// strings into the SHARED registry — which then feed the embedding text and are
// served verbatim by the MCP profile tools — while a human editing the identical
// field was held to 40/60 characters. Two write surfaces, one collection, one
// set of limits.
function cleanStringList(raw, field) {
  if (!Array.isArray(raw)) return [];
  const { max, maxLen } = LIST_FIELDS[field];
  return raw
    .filter((x) => typeof x === 'string')
    .map((x) => x.trim().slice(0, maxLen))
    .filter((x) => x && !SENTINEL_VALUE_RX.test(x))
    .slice(0, max);
}

// Prose fields get the same sentinel guard after their existing cleanup — a
// description or producerNote of "null"/"N/A" is an absent value, not prose.
// Length-bounded for the same reason as the lists above: aiProfile.description
// has no maxlength on the schema and the write is an updateOne with $set, where
// update validators are off, so nothing else stops it.
function cleanProse(raw, maxLen = DESCRIPTION_MAX) {
  if (typeof raw !== 'string') return null;
  const v = stripMarkdown(raw);
  if (!v || SENTINEL_VALUE_RX.test(v.trim())) return null;
  return v.slice(0, maxLen);
}

// The generator is prompted for 0..1 but a prompt is advisory, and this number
// decides whether a row is ever reviewed: the low-confidence queue filters on
// `aiProfile.confidence: { $lte: threshold }`, so a value above the threshold —
// or a NaN, or a string — makes the row permanently invisible to the humans
// meant to check it. Clamped rather than trusted.
function cleanConfidence(raw) {
  // Typed narrowly on purpose: Number(null) and Number('') are both 0, so a
  // blanket Number() would invent a confidence of 0 for a field the model never
  // answered. 0 is a real value here — the lowest — and fabricating it is a
  // different lie from the one this function exists to prevent.
  const n =
    typeof raw === 'number' ? raw
      : (typeof raw === 'string' && raw.trim() !== '') ? Number(raw)
        : NaN;
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
}

// ── In-memory job state ────────────────────────────────────────────────────

let job = {
  status: 'idle',       // 'idle' | 'running' | 'stopping' | 'done' | 'error'
  mode: null,
  model: null,
  total: 0,
  done: 0,
  enriched: 0,
  held: 0,              // producer-suspect rows: generated but publication withheld
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

// ── Which suspicions actually have to withhold the profile ──────────────────
//
// v1.116.0 held EVERY producer-suspect profile. Measured against the 390
// suspect rows that predate it (prod, 2026-08-16): only 9 descriptions made
// any producer-identity claim at all, and ~2 were genuinely misleading. The
// rest were honest notes about wines that legitimately carry a brand or
// retailer in the producer field — an Aldi Riesling has no better answer, and
// withholding its tasting note serves nobody. 370 of those rows are attached
// to real users' bottles, so a blanket hold is a large, user-visible cost for
// a small harm.
//
// The doubt has to withhold the profile in exactly two cases:
//   1. the model is ALSO unsure of the wine (low/unknown confidence) — the
//      Epiphany shape: it could not place the bottling, so the prose is an
//      appellation-level guess dressed as a description; and
//   2. the prose makes claims about the PRODUCER AS AN ENTITY while we doubt
//      the producer is real — the Fabelhaft harm exactly (a biography of a
//      house that turned out to be a Niepoort label).
// Anything else publishes with the doubt recorded: producerSuspect and
// producerNote still ride on the row, and the admin queue still lists it
// regardless of threshold.
const SUSPECT_HOLD_CONFIDENCE_MAX = 0.45;
// Words that only appear when a description is talking about the PRODUCER
// rather than the wine. Deliberately generous — a false positive costs one
// withheld tasting note that a curator can release in a click, a false
// negative publishes a fabricated house.
const PRODUCER_CLAIM_RX =
  /\b(n[ée]gociant|winery|winemaker|domaine|estate|ch[âa]teau|house|producer|winehouse|family|founded|generation)\b/i;

/**
 * @param {object} profile — the CLEANED { confidence, description } about to
 *   be stored (nulls already normalised by cleanConfidence/cleanProse).
 * @returns {boolean} true when a producer-suspect profile must be held.
 */
function suspectHoldsProfile({ confidence, description }) {
  // Unknown confidence is the "nobody can vouch for this" state — the same
  // stance the admin low-confidence queue takes on a null.
  if (typeof confidence !== 'number') return true;
  if (confidence <= SUSPECT_HOLD_CONFIDENCE_MAX) return true;
  return PRODUCER_CLAIM_RX.test(description || '');
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
    held: 0,
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
    //
    // Either way, NEVER re-generate over a curator-corrected profile: a
    // sommelier fixed that row by hand because the model got it wrong, and a
    // full re-run would quietly restore the fiction. Incremental mode is
    // already safe (a corrected row has a description), so this only bites in
    // full mode — which is exactly the mode that would have destroyed the
    // most work. See WineDefinition.aiProfile.source.
    // A pendingIdentity row is never enriched — the SAME rule embeddingJob
    // carries, and it was missed here (security audit M-3). Its producer is ''
    // and its region is often the misplaced string that made it pending, so
    // the model would be asked to describe a wine nobody has identified yet:
    // an AI spend on a row strangers cannot see, whose output would then be
    // presented as the registry's tasting note the moment it is promoted.
    // The promoting write re-enriches (runPromotionFollowThrough), which is
    // when the wine genuinely enters.
    const keepCurated = { 'aiProfile.source': { $ne: 'curator' }, pendingIdentity: { $ne: true } };
    const filter = job.mode === 'full'
      ? keepCurated
      : {
          ...keepCurated,
          // A HELD row (producer-suspect, publication withheld) has a null
          // description by design — without this it would match the "not yet
          // enriched" branch and every incremental run would re-spend on it.
          // Held rows wait for a human (queue/identity fix/review override);
          // only FULL mode re-generates them.
          'aiProfile.heldAt': null,
          $or: [{ 'aiProfile.description': null }, { 'aiProfile.description': { $exists: false } }],
        };

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
        else if (result === 'held') job.held++;
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
async function enrichWine(wine, model, { publishSuspect = false } = {}) {
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

  // The model's own doubt about the producer FIELD (registry audit follow-up:
  // "Arcane" — a range sold as a producer — sailed past every string gate AND
  // 49 audit agents; only this model hedged). Strict true-check: absent on
  // old/custom prompts → false.
  const suspect = data.producerSuspect === true;
  const now = new Date();
  const confidence = cleanConfidence(data.confidence);
  const description = cleanProse(data.description);
  const meta = {
    confidence,
    producerSuspect: suspect,
    producerNote:    cleanProse(data.producerNote, 300),
    model:           model || aiConfig.get().enrichmentModel,
    source:          'ai',
    generatedAt:     now,
  };

  // HOLD, don't publish, when the producer doubt could make the PROSE
  // misleading (ticket 6a8162c5, narrowed 2026-08-16 — see
  // suspectHoldsProfile for the evidence that "suspect" alone is too broad).
  // A held row stores ONLY the doubt; the null description keeps every read
  // surface (bottle page, MCP, embedding text) naturally silent, and heldAt
  // keeps the retry guards from looping on it. `publishSuspect` is the human
  // override — profile-reviewed uses it after an admin has looked at the
  // doubt and judged the identity fine.
  if (suspect && !publishSuspect && suspectHoldsProfile({ confidence, description })) {
    await WineDefinition.updateOne(
      { _id: wine._id },
      {
        $set: {
          aiProfile: {
            body: null, tannin: null, acidity: null, sweetness: null,
            flavors: [], foodPairings: [],
            description: null,
            ...meta,
            heldAt: now,
          },
          updatedAt: now,
        },
      }
    );
    return { result: 'held', reason: null };
  }

  await WineDefinition.updateOne(
    { _id: wine._id },
    {
      $set: {
        aiProfile: {
          body:         cleanDescriptor('body', data.body),
          tannin:       cleanDescriptor('tannin', data.tannin),
          acidity:      cleanDescriptor('acidity', data.acidity),
          sweetness:    cleanDescriptor('sweetness', data.sweetness),
          flavors:      cleanStringList(data.flavors, 'flavors'),
          foodPairings: cleanStringList(data.foodPairings, 'foodPairings'),
          // Markdown-stripped, not just trimmed (computed above, beside the
          // hold decision that reads it): the model reaches for emphasis even
          // when told not to, and the raw string is served un-rendered by the
          // MCP tools. Load-bearing half of the fix — the prompt is only
          // advisory, and a self-hoster can override it via SiteConfig.
          description,
          ...meta,
          heldAt: null,
        },
        updatedAt: now,
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
 * @param {boolean} [opts.force] – regenerate even when a profile exists or is
 *   held. Used by the deliberate admin surfaces (identity edit, review
 *   override) — never by the fire-and-forget bottle-add hook. Curator-written
 *   profiles are still never regenerated, force or not.
 * @param {boolean} [opts.publishSuspect] – publish even when the model flags
 *   the producer as suspect (the human-override path: an admin reviewed the
 *   doubt and judged the identity fine).
 */
async function enrichWineById(wineDefId, { budgetUserId, force = false, publishSuspect = false } = {}) {
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
    // Same rule as the batch filter above, and it matters MORE here: this is
    // the fire-and-forget call services/bottleOps.js makes on every bottle add,
    // so without it the very add that mints a pending row would immediately
    // spend the adding user's daily AI budget describing a producerless wine.
    if (wine.pendingIdentity === true) return;
    if (wine.aiProfile && wine.aiProfile.source === 'curator') return; // hand-corrected — never regenerate (force included)
    if (!force) {
      if (wine.aiProfile && wine.aiProfile.description) return; // already enriched
      // HELD is a decision awaiting a human, not a gap to retry: without this
      // guard every later bottle add of the same wine would re-spend the
      // adder's AI budget re-generating a profile we would hold again.
      if (wine.aiProfile && wine.aiProfile.heldAt) return;
    }

    if (budgetUserId) {
      const debit = await tryDebitAi(String(budgetUserId));
      if (!debit.ok) {
        // Over the shared daily AI budget — skip silently; the next admin
        // batch run picks the wine up. The triggering action never fails.
        console.warn('[enrichmentJob] enrichWineById skipped (%s): ai budget exhausted (%s)', idStr, debit.reason);
        return;
      }
      try {
        const { result, reason } = await enrichWine(wine, aiConfig.get().enrichmentModel, { publishSuspect });
        // A transport-level failure never produced a billable completion
        if (result === 'skipped' && isRefundableFailure(reason)) await debit.refund();
      } catch (err) {
        await debit.refund();
        throw err; // handled by the outer catch below
      }
    } else {
      await enrichWine(wine, aiConfig.get().enrichmentModel, { publishSuspect });
    }
    console.log('[enrichmentJob] Auto-enriched new wine: %s', wine.name);
  } catch (err) {
    console.warn('[enrichmentJob] enrichWineById failed (%s): %s', idStr, err.message);
  }
}

// ── Record-edit follow-through (shared by the deliberate curation surfaces) ──

/**
 * The record fields suggestProfile reads, folded into one comparable string.
 * Snapshot BEFORE applying an edit, compare after save: the admin form
 * re-sends every field on save, so presence-in-body says nothing — only a
 * before/after difference means the stored profile now describes the wrong
 * record. Robust to populated and unpopulated refs (ids are folded either
 * way) and to grape order.
 */
function profileInputsSnapshot(wine) {
  const idOf = (v) => String(v && v._id ? v._id : (v || ''));
  return JSON.stringify({
    name: wine.name || '',
    producer: wine.producer || '',
    country: idOf(wine.country),
    region: idOf(wine.region),
    appellation: wine.appellation || '',
    classification: wine.classification || '',
    type: wine.type || '',
    grapes: (wine.grapes || []).map(idOf).sort(),
  });
}

/**
 * After a deliberate curation edit (admin wine PUT, proposal approve) changed
 * a field the profile generator reads, the stored AI profile describes the
 * OLD record — including a HELD one, whose doubt the edit may have just
 * resolved (rename "Fabelhaft" → "Niepoort" and the hold's reason is gone;
 * measured live 2026-08-16, where the approve path left the négociant
 * fiction attached until a manual re-enrich). Fire-and-forget forced
 * regeneration under the corrected record.
 *
 * Gates: `changed` is the CALLER's before/after profileInputsSnapshot
 * comparison — this helper never guesses; a never-enriched wine has nothing
 * stale (the bottle-add hook and batch runs cover fresh rows); curator
 * profiles are never regenerated (double-guarded — enrichWineById refuses
 * them too, force or not).
 *
 * Returns the floating promise so tests can await settlement; callers ignore it.
 */
function reenrichAfterRecordEdit(wine, changed) {
  if (!changed) return Promise.resolve();
  if (!wine || !wine.aiProfile || !wine.aiProfile.generatedAt) return Promise.resolve();
  if (wine.aiProfile.source === 'curator') return Promise.resolve();
  return enrichWineById(wine._id, { force: true }).catch(() => {});
}

module.exports = {
  start, requestStop, getStatus, enrichWineById,
  profileInputsSnapshot, reenrichAfterRecordEdit,
  // exported for unit tests
  cleanDescriptor, cleanStringList, cleanProse, cleanConfidence, suspectHoldsProfile,
};
