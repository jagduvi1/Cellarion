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

// ── Note-vs-record variety conflict (somm 6a870531) ─────────────────────────
// The curated grape vocabulary, cached: names change rarely and a batch run
// must not query per wine. 10-minute TTL so taxonomy edits land without a
// restart.
let grapeVocabCache = { at: 0, entries: [] };
async function grapeVocabulary() {
  if (Date.now() - grapeVocabCache.at > 10 * 60 * 1000) {
    const Grape = require('../models/Grape');
    const { normPlace, NON_VARIETY_VOCAB } = require('../utils/descriptionGrounding');
    const rows = await Grape.find({}).select('name synonyms').lean();
    grapeVocabCache = {
      at: Date.now(),
      entries: rows
        .filter((r) => !NON_VARIETY_VOCAB.has(normPlace(r.name)))
        .map((r) => ({
          name: r.name,
          forms: [r.name, ...(Array.isArray(r.synonyms) ? r.synonyms : [])].map(normPlace).filter(Boolean),
        })),
    };
  }
  return grapeVocabCache.entries;
}

// The clause must ASSERT what the bottling is, not describe what the producer
// is known for. Prod scan 2026-08-20: without this, "Braida is a known
// Barbera producer" (bio, on a Moscato) and "primarily known for Napa
// Cabernet" (bio) would hold rows whose notes are fine — while the real
// class always carries an assertion verb: "more commonly DOCUMENTED AS a
// Pinot Noir" (Les Gaudrettes), "is ACTUALLY a Viognier-Chardonnay blend"
// (Cantina Marilina).
const NOTE_ASSERTS_BOTTLING = /\b(documented as|actually an?|in fact an?|is really|listed as|labell?ed as|instead of|rather than|mislabell?ed|not an? )\b/i;

/**
 * Does the note ASSERT the bottling is a curated variety the record does not
 * carry? Synonym-aware — a note saying "Moscato" on a Muscat Blanc à Petits
 * Grains record names the record's own grape under another form and never
 * fires. Clause-scoped (split on ./;) so an assertion verb in one clause
 * cannot license a bio-mention in another. Returns the conflicting variety
 * name, or null.
 */
function findNoteVarietyConflict(note, recordGrapeNames, vocabEntries) {
  const { normPlace } = require('../utils/descriptionGrounding');
  const ownForms = new Set((recordGrapeNames || []).map((n) => normPlace(n)).filter(Boolean));
  const clauses = String(note || '').split(/[.;]/);
  for (const clause of clauses) {
    if (!NOTE_ASSERTS_BOTTLING.test(clause)) continue;
    const clauseNorms = normPlace(clause).split(' ').filter(Boolean);
    for (const entry of vocabEntries || []) {
      // The record's own grape, under any of its names, is never a conflict.
      if (entry.forms.some((f) => ownForms.has(f))) continue;
      for (const form of entry.forms) {
        const seq = form.split(' ');
        for (let i = 0; i + seq.length <= clauseNorms.length; i++) {
          if (seq.every((n, j) => clauseNorms[i + j] === n)) return entry.name;
        }
      }
    }
  }
  return null;
}

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
  kept: 0,              // reviewed published rows a would-hold regen preserved (stamp cleared)
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

// ── Web-search rescue: daily slot counter (pilot 2026-08-19) ────────────────
// In-memory per UTC day — a backend restart resets it, which for a pilot
// bound of ~5/day is an acceptable slack, not a budget hole. The searchUsed
// flag on rows is the durable record; this counter only enforces the cap.
let searchSlotDay = '';
let searchSlotsUsed = 0;
function takeSearchSlot(cap) {
  if (!(Number.isInteger(cap) && cap > 0)) return false;
  const today = new Date().toISOString().slice(0, 10);
  if (today !== searchSlotDay) { searchSlotDay = today; searchSlotsUsed = 0; }
  if (searchSlotsUsed >= cap) return false;
  searchSlotsUsed += 1;
  return true;
}

/** Test hook — the slot counter is module state, shared across a test file. */
function _resetSearchSlots() {
  searchSlotDay = '';
  searchSlotsUsed = 0;
}

// ── Which doubts actually have to withhold the profile ──────────────────────
//
// The flag was split on 2026-08-17 (see models/WineDefinition.aiProfile
// .producerUnknown) because one boolean was answering two questions:
//
//   producerSuspect  — the Producer FIELD is wrong: a brand line, a place, a
//                      retailer, a label term. Fabelhaft, which is a Niepoort
//                      label. The record is not describing a real house, so a
//                      profile written for it is fiction about a company that
//                      may not exist. HOLD, at any confidence.
//   producerUnknown  — the name reads like a real winery, the model just
//                      cannot place it. Chateau Hautes Graves, Thomas Allen,
//                      most small estates on earth. The record is FINE and an
//                      appellation-level note is honest and useful. PUBLISH,
//                      with the doubt recorded on the row.
//
// Holding both was measurably wrong: ~47% of a 250-wine enrichment run was
// withheld, almost all of it the second kind, and those held rows then blocked
// the sommelier's maturity queue — a held profile shows no tasting note, and
// a drink window cannot be judged without one.
//
// ONE case still holds an otherwise-fine unknown producer: prose that talks
// about the house as an entity while admitting it cannot place it. The prompt
// now forbids that directly, so this is a backstop rather than the main gate.
//
// CONFIDENCE REJOINED THE DECISION on 2026-08-18 (ticket 6a83e765) — as a
// calibrated FLOOR, not the old hold-on-any-doubt. The split above was right
// about the flags, but it left confidence read by NOBODY: the day after it
// shipped, profiles were publishing at 0.2 while the one held row sat at 0.3.
// Calibrated on prod over 5,836 published AI profiles: the confidence mass
// sits at 0.5–0.7, a 0.40 floor holds ~300 all-time, and 0.45 is measurably
// too aggressive (1,158 — the mass sits in the 0.4 band). An UNKNOWN producer
// additionally holds below a higher bar (0.55): unknown + weak confidence is
// regional guesswork, while unknown + strong confidence is the honest
// appellation-level majority the split released (171 of 190 unknown-flagged
// rows sat under 0.55). A null confidence (old/custom prompt, unusable model
// output) skips both checks — the same degrade-to-no-doubt rule as the flags;
// the admin low-confidence queue still catches those rows. Thresholds live in
// aiConfig (enrichmentHoldConfidenceFloor / enrichmentHoldUnknownConfidenceBar)
// so tuning never needs a release.
//
// Words that only appear when a description is talking about the PRODUCER
// rather than the wine. Deliberately generous: a false positive costs one
// withheld tasting note a curator can release in a click, a false negative
// publishes a fabricated house.
const PRODUCER_CLAIM_RX =
  /\b(n[ée]gociant|winery|winemaker|domaine|estate|ch[âa]teau|house|producer|winehouse|family|founded|generation)\b/i;

/**
 * @param {object} profile — the CLEANED profile about to be stored
 *   (nulls already normalised by cleanConfidence/cleanProse).
 * @param {boolean} profile.producerSuspect — the field is not a producer
 * @param {boolean} profile.producerUnknown — real name, cannot be placed
 * @param {string|null} profile.description
 * @param {number|null} profile.confidence — cleanConfidence output
 * @param {boolean} profile.dataSufficient — the RECORD carries enough to
 *   write a true regional estimate: (appellation OR region) AND
 *   (grapes OR type). Somm ticket 6a855285 (2026-08-19): the queue's bulk
 *   was data-rich wines held only because the model didn't recognise the
 *   BOTTLING — "you can know Pommard perfectly well and have never heard of
 *   the grower". The unknown-producer bar therefore applies only when the
 *   identity is data-INSUFFICIENT; a rich record's unknown-producer profile
 *   publishes at the base floor as a labelled regional estimate — the exact
 *   population the 2026-08-17 flag split released, which the 08-18 bar had
 *   re-caught. The junk floor itself is unchanged.
 * @param {object} [thresholds] — aiConfig gate values; a missing/non-numeric
 *   threshold disables that check (degrade open, never to a spurious hold).
 * @param {number} [thresholds.floor] — hold ANY profile under this
 * @param {number} [thresholds.unknownBar] — hold DATA-INSUFFICIENT
 *   unknown-producer rows under this
 * @returns {string|null} the hold reason ('producer_suspect' |
 *   'low_confidence' | 'unknown_low_confidence' | 'producer_claim'), or null
 *   to publish. Stored as aiProfile.heldReason so the release queue can say
 *   WHY a row is held.
 */
function shouldHoldProfile({ producerSuspect, producerUnknown, description, confidence, dataSufficient = false }, { floor, unknownBar } = {}) {
  if (producerSuspect) return 'producer_suspect';
  if (typeof confidence === 'number') {
    if (typeof floor === 'number' && confidence < floor) return 'low_confidence';
    if (producerUnknown && !dataSufficient && typeof unknownBar === 'number' && confidence < unknownBar) return 'unknown_low_confidence';
  }
  if (producerUnknown && PRODUCER_CLAIM_RX.test(description || '')) return 'producer_claim';
  return null;
}

/**
 * Enough registry identity to write a TRUE appellation/grape-level estimate:
 * a place axis (appellation or region) AND a what axis (grapes or type).
 * Shared by the gate and the reset-misheld migration — one definition.
 */
function identityDataSufficient(wine) {
  const hasPlace = !!(wine.appellation || wine.region);
  const hasWhat = (Array.isArray(wine.grapes) && wine.grapes.length > 0) || !!wine.type;
  return hasPlace && hasWhat;
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
    kept: 0,
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
    // Canaries (registry lockdown L4) carry hand-written profiles and are never regenerated.
    const keepCurated = { 'aiProfile.source': { $ne: 'curator' }, pendingIdentity: { $ne: true }, canary: { $ne: true } };
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
      .populate('grapes', 'name color');
    // Cap the batch when a limit is set (cheap test runs).
    if (job.limit > 0) q = q.limit(job.limit);
    const wines = await q.lean();

    // Incremental mode also reclaims STALE rows: a profile whose stored inputs
    // no longer match the record was generated against an identity this wine
    // no longer has, so its description — and its producer-suspect flag — are
    // about a different wine (somm 6a86bb3b; the 08-11 bulk triage left two
    // Friuli benchmarks flagged over a note about "Giuli Ballarin"). Full mode
    // regenerates everything anyway, so it needs no second pass.
    //
    // Filtered in JS, not Mongo: the snapshot is a JSON rendering of eight
    // fields including sorted grape ids, and expressing that as an aggregation
    // would encode the format twice and let the two drift apart. The candidate
    // set is bounded — only rows enriched since the field shipped have one.
    //
    // NOT gated on heldAt: a changed identity is exactly what can void a hold
    // ("Fabelhaft" → "Niepoort" and the doubt is gone), which is the same
    // reasoning reenrichAfterRecordEdit carries.
    if (job.mode !== 'full') {
      const seen = new Set(wines.map((w) => String(w._id)));
      const candidates = await WineDefinition.find({
        ...keepCurated,
        'aiProfile.inputsSnapshot': { $ne: null },
        // A profile a human deliberately released is never regenerated
        // unattended: the release is a judgement about doubt the model had,
        // and a re-run that re-holds would null the description they chose to
        // publish. Those surface in the sommelier's stale list instead.
        profileReviewedAt: null,
      })
        .populate('country', 'name')
        .populate('region', 'name')
        .populate('grapes', 'name color')
        .lean();
      const stale = candidates.filter(
        (w) => !seen.has(String(w._id)) && w.aiProfile.inputsSnapshot !== profileInputsSnapshot(w)
      );
      if (stale.length) {
        console.log(`[enrichmentJob] +${stale.length} stale profile(s) queued for regeneration`);
        wines.push(...(job.limit > 0 ? stale.slice(0, Math.max(0, job.limit - wines.length)) : stale));
      }
    }

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
        else if (result === 'kept') job.kept++; // reviewed profile preserved, stamp cleared — not an error
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
async function enrichWine(wine, model, { publishSuspect = false, curatorContext = null } = {}) {
  const { data, debugReason } = await suggestProfile({
    name: wine.name,
    producer: wine.producer,
    vintage: 'NV', // vintage-neutral profile
    curatorContext,
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

  const now = new Date();
  const gateCfg = aiConfig.get();
  // Loaded once per wine (module-cached) — assess() is a sync closure and the
  // note-vs-record check inside it must not await.
  const grapeVocab = await grapeVocabulary();
  // Same constraint, same shape: resolved once per wine so the suspect
  // downgrade chain inside assess() stays sync. Reads the wine's appellation
  // against the curated taxonomy (somm 6a8eb2a9) — false on lookup trouble,
  // so a taxonomy hiccup can only ever KEEP a flag, never clear one.
  const { appellationHasGeography } = require('./appellationResolve');
  const apHasGeo = await appellationHasGeography(wine.appellation);

  // Derive everything the gate and the writes need from ONE model response.
  // A closure so the search-rescue retry below can re-derive from a second
  // response without duplicating the rules. Strict true-checks on the flags:
  // absent on an old or custom prompt → false, degrading to "no doubt
  // recorded" rather than to a spurious hold.
  const assess = (d, searchUsed) => {
    let suspect = d.producerSuspect === true;
    let unknown = d.producerUnknown === true;
    const confidence = cleanConfidence(d.confidence);
    const description = cleanProse(d.description);
    // Deterministic contradiction check (somm ticket 6a85f961): the generator
    // keeps setting producerSuspect on records whose own note calls the entity
    // a cooperative, an estate or a grower. That is a real producer the model
    // cannot place — producerUnknown — and leaving it suspect puts a permanent
    // "cannot be verified" caveat on a small winery's wine and inflates
    // upheld-count. Prompt rules have failed to stop two classes like this
    // already; a rule that reads the model's own words does not need it to
    // cooperate. See utils/producerSuspectCheck for the discrimination.
    let downgradedBy = null;
    if (suspect) {
      const {
        noteAssertsProducer, noteIsEpistemicOnly, noteDoubtsCuveeNotProducer,
        notePlaceConflict, producerFieldLooksPlaceholder, DOWNGRADE_RULES,
      } = require('../utils/producerSuspectCheck');
      const note = cleanProse(d.producerNote, 300);
      // Blockers before rules (somm audit 6a86dad6: 14 of the first 166
      // downgrades should not have moved). A placeholder producer field has
      // nothing to verify, and a note grounding its estimate in a place the
      // record contradicts is describing a different wine — downgrading
      // either publishes the problem with its caveat removed. Blocked rows
      // stay suspect and a human judges them.
      const blocked =
        producerFieldLooksPlaceholder(wine.producer, wine.name) ||
        notePlaceConflict(note, {
          region: wine.region?.name,
          appellation: wine.appellation,
          country: wine.country?.name,
        });
      // Two disjoint rules, checked strongest-claim first. The second was the
      // population the first deliberately left alone on 2026-08-19; see
      // noteIsEpistemicOnly for why that call was reversed (somm 6a86baca).
      // The tag records which rule FIRED under this precedence, not which
      // shape the note best fits — accepted trade (6a86dad6 part 2A) over
      // loosening PRODUCER_CLASS, which shipped five false downgrades once.
      if (!blocked && noteAssertsProducer(note, wine.producer)) {
        suspect = false;
        unknown = true;
        downgradedBy = DOWNGRADE_RULES.ASSERTS_PRODUCER;
      } else if (!blocked && noteIsEpistemicOnly(note, wine.producer)) {
        suspect = false;
        unknown = true;
        downgradedBy = DOWNGRADE_RULES.EPISTEMIC_ONLY;
      } else if (!blocked) {
        // Third rule (somm 6a872291): the doubt is about the CUVÉE while the
        // producer is affirmed in the same note — eleven documented estates
        // carried owner-visible caveats this way, and the assertion rule can
        // never reach them because the affirmation sits after the contrast
        // cut. Lands clean, or on producerUnknown when the note also carries
        // first-person doubt about the producer.
        const cuvee = noteDoubtsCuveeNotProducer(note, wine.producer, wine.name);
        if (cuvee) {
          suspect = false;
          unknown = cuvee.unknown === true;
          downgradedBy = DOWNGRADE_RULES.CUVEE_NOT_PRODUCER;
        } else if (apHasGeo) {
          // Fourth rule (somm 6a8eb2a9): record-based, the fallback when no
          // note rule fires. The wine's appellation resolves to a curated
          // entry WITH geography — a Châteauneuf or a Coonawarra has a
          // knowable house behind whatever the producer string is, so the
          // "record is wrong" claim cannot carry an owner-visible caveat.
          // producerUnknown stays true: the house was still not identified.
          // Ordered last on purpose — the note rules say WHY the model's own
          // words disagree with its flag; this one only says the flag cannot
          // matter here. Shares the placeholder/place-conflict blockers: a
          // placeholder producer has nothing to verify however real the
          // appellation is, and a note describing a different place puts the
          // appellation itself in doubt.
          suspect = false;
          unknown = true;
          downgradedBy = DOWNGRADE_RULES.APPELLATION_GEOGRAPHY;
        }
      }
    }
    const meta = {
      confidence,
      producerSuspect: suspect,
      producerUnknown: unknown,
      producerNote:    cleanProse(d.producerNote, 300),
      suspectDowngradedBy: downgradedBy,
      model:           model || aiConfig.get().enrichmentModel,
      source:          'ai',
      generatedAt:     now,
      // What this profile was generated FROM, so a later bulk edit that
      // bypasses reenrichAfterRecordEdit is still detectable as staleness.
      inputsSnapshot:  profileInputsSnapshot(wine),
      // Pilot marker (2026-08-19): this generation used the web-search
      // rescue. Rescue rate and searched-profile quality are queryable
      // from this flag alone.
      searchUsed:      searchUsed === true,
    };
    // HOLD, don't publish, when the doubt is about the RECORD rather than
    // the model's own reach, or the confidence sits under the calibrated
    // floor — see shouldHoldProfile for the reasons and their history.
    let holdReason = shouldHoldProfile(
      { producerSuspect: suspect, producerUnknown: unknown, description, confidence, dataSufficient: identityDataSufficient(wine) },
      { floor: gateCfg.enrichmentHoldConfidenceFloor, unknownBar: gateCfg.enrichmentHoldUnknownConfidenceBar }
    );
    // Deterministic taxonomy cross-check (ticket 6a8464ea phase 2): a value
    // at the OPPOSITE structural extreme of what every grape on the wine is
    // defined by (a high-acid Bacchus) is a regional-prior hallucination no
    // confidence gate can catch — the model believes it.
    if (!holdReason) {
      const { findGrapeStyleConflict } = require('../data/grapeStyleTypicals');
      const conflict = findGrapeStyleConflict(
        (wine.grapes || []).map((g) => g.name),
        { acidity: cleanDescriptor('acidity', d.acidity), tannin: cleanDescriptor('tannin', d.tannin) },
        require('../utils/normalize').normalizeString
      );
      if (conflict) {
        holdReason = 'taxonomy_conflict';
        if (!meta.producerNote) meta.producerNote = `Style conflict: ${conflict}`;
      }
    }
    // Third deterministic cross-check (somm ticket 6a870531, HIGH): the
    // generator's own note against the record's grape list. Les Gaudrettes
    // published a Chardonnay profile while its producerNote said the cuvée is
    // "more commonly documented as a Pinot Noir" — the model recorded a
    // record-contradiction in the one field nothing reads, then published.
    // If the note names a curated variety the record does not carry (and the
    // record HAS grapes — on a grapeless record a named variety is added
    // information, not contradiction), the row holds and a curator decides
    // which side is wrong. The note itself is the evidence and stays.
    if (!holdReason && meta.producerNote && (wine.grapes || []).length) {
      const mentioned = findNoteVarietyConflict(
        meta.producerNote,
        wine.grapes.map((g) => g.name),
        grapeVocab
      );
      if (mentioned) {
        holdReason = 'note_record_conflict';
      }
    }
    // Second deterministic cross-check (somm ticket 6a85ad44): the wine's own
    // type against the curated colour of its grapes. Unlike the style conflict
    // above this reads NO model output — it is a fact about the record — so a
    // profile generated on top of it would be a careful description of a wine
    // that cannot exist. Hold rather than publish, and let a curator say which
    // of the two fields is the wrong one. See utils/grapeColourCheck for why
    // the two directions are treated differently.
    if (!holdReason) {
      const { findGrapeColourConflict } = require('../utils/grapeColourCheck');
      const clash = findGrapeColourConflict(wine);
      if (clash) {
        holdReason = 'grape_colour_conflict';
        if (!meta.producerNote) meta.producerNote = `Colour conflict: ${clash}`;
      }
    }
    return { data: d, description, meta, holdReason };
  };

  let a = assess(data, false);

  // Web-search rescue (pilot, Johan-approved 2026-08-19): a generation that
  // would HOLD for a confidence reason gets ONE search-assisted retry — the
  // gate itself is the difficulty detector, so ordinary wines never spend a
  // search. Confidence reasons only: a suspect field or a taxonomy conflict
  // is not a knowledge gap a search fixes. Anthropic-provider only; capped
  // per UTC day; kill-switch in aiConfig. The searched result replaces the
  // first attempt WHATEVER its outcome — a still-held searched row records
  // the attempt (searchUsed) so the pilot's rescue rate counts misses too.
  const SEARCH_RETRYABLE = new Set(['low_confidence', 'unknown_low_confidence']);
  if (!publishSuspect && a.holdReason && SEARCH_RETRYABLE.has(a.holdReason)
      && gateCfg.enrichmentSearchEnabled
      && !aiProvider.effectiveModels() // Anthropic-only: web_search is an Anthropic server-side tool
      && takeSearchSlot(gateCfg.enrichmentSearchDailyCap)) {
    const second = await suggestProfile({
      name: wine.name,
      producer: wine.producer,
      vintage: 'NV',
      curatorContext,
      allowSearch: true,
      country: wine.country?.name,
      region: wine.region?.name,
      appellation: wine.appellation,
      classification: wine.classification,
      type: wine.type,
      grapes: (wine.grapes || []).map(g => g.name).filter(Boolean),
    });
    if (second.data) {
      a = assess(second.data, true);
      console.log(`[enrichmentJob] search rescue ${wine._id}: ${a.holdReason || 'published'}`);
    }
  }

  // ── Generation gate (somm 6a82bfb7, the ticket's last open build) ─────────
  // On a record with NO region and NO appellation, every geographic claim in
  // the candidate prose is ungrounded by construction — the class that taught
  // a curator four wrong drink windows. The prompt asks for disclosure-shaped
  // prose up front; this is the guarantee the prompt cannot give. An
  // assertion-grade draft gets ONE corrective retry naming exactly what it
  // asserted; a second violation HOLDS rather than publishes. Disclosure
  // prose (the Petersons shape) passes by design — forcing silence would
  // train enrichment toward blank confidence, the somm's own warning.
  // Grounded records are out of scope entirely: prose legitimately goes finer
  // than the record, and judging that needs a gazetteer (the 1,612 lesson).
  const placeless = !wine.region && !wine.appellation;
  if (!publishSuspect && placeless && !a.holdReason && a.description) {
    const { gradeDescription } = require('../utils/descriptionGrounding');
    // The record's grapes ground under every name they carry — a "Moscato"
    // mention on a Muscat Blanc à Petits Grains record is the record's own
    // grape, not a claim (same synonym rule as the note-conflict check).
    const ownNames = (wine.grapes || []).map((g) => g.name).filter(Boolean);
    const { normPlace } = require('../utils/descriptionGrounding');
    const ownNorm = new Set(ownNames.map(normPlace));
    const grapeForms = [
      ...ownNames,
      ...grapeVocab.filter((e) => e.forms.some((f) => ownNorm.has(f))).flatMap((e) => e.forms),
    ];
    const grounding = {
      country: wine.country?.name,
      producer: wine.producer,
      grapes: grapeForms,
      varietyVocabulary: grapeVocab.map((e) => e.name),
    };
    const firstGrade = gradeDescription(a.description, grounding);
    if (firstGrade.grade === 'assertion') {
      const asserted = firstGrade.claims.filter((c) => !c.framed).map((c) => c.claim).join(', ');
      const second = await suggestProfile({
        name: wine.name,
        producer: wine.producer,
        vintage: 'NV',
        curatorContext,
        retryDirective:
          `Your previous draft stated the following as facts about this wine: ${asserted}. ` +
          'This record does not carry them, so they are unverified. Rewrite the description without asserting ' +
          'any of them — style-only prose, or name explicitly what is unknown.',
        country: wine.country?.name,
        region: wine.region?.name,
        appellation: wine.appellation,
        classification: wine.classification,
        type: wine.type,
        grapes: (wine.grapes || []).map(g => g.name).filter(Boolean),
      });
      if (second.data) {
        const b = assess(second.data, a.meta.searchUsed === true);
        const secondGrade = b.description ? gradeDescription(b.description, grounding) : { grade: 'ok' };
        a = b;
        if (!a.holdReason && secondGrade.grade === 'assertion') {
          a.holdReason = 'ungrounded_description';
          if (!a.meta.producerNote) {
            a.meta.producerNote = `Ungrounded description: asserted ${secondGrade.claims.filter((c) => !c.framed).map((c) => c.claim).join(', ').slice(0, 200)}`;
          }
        }
        console.log(`[enrichmentJob] grounding retry ${wine._id}: ${a.holdReason || 'published'}`);
      } else {
        // Retry failed to generate — the violating first draft must not
        // publish as-is. Hold with the first draft's evidence.
        a.holdReason = 'ungrounded_description';
        if (!a.meta.producerNote) a.meta.producerNote = `Ungrounded description: asserted ${asserted.slice(0, 200)}`;
      }
    }
  }

  // `publishSuspect` is the human override — profile-reviewed uses it after
  // an admin has looked at the doubt and judged the identity fine. A held
  // row stores ONLY the doubt; the null description keeps every read surface
  // naturally silent, and heldAt keeps the retry guards from looping on it.
  if (!publishSuspect && a.holdReason) {
    // A REVIEWED published profile is a human decision — an automated
    // regeneration (identity edit, full batch) must never null it (somm
    // report 2026-08-19: proposal approvals re-generated curator-released
    // rows). The doubtful regen is discarded, the old profile stays, and the
    // cleared stamp drops the row back into the review worklists — a human
    // decides, exactly like the first time.
    if (wine.profileReviewedAt && wine.aiProfile && wine.aiProfile.description) {
      await WineDefinition.updateOne(
        { _id: wine._id },
        { $set: { profileReviewedAt: null, updatedAt: now } }
      );
      console.log(`[enrichmentJob] kept reviewed profile ${wine._id}: regen would hold (${a.holdReason}) — review stamp cleared instead`);
      return { result: 'kept', reason: a.holdReason };
    }
    await WineDefinition.updateOne(
      { _id: wine._id },
      {
        $set: {
          aiProfile: {
            body: null, tannin: null, acidity: null, sweetness: null,
            flavors: [], foodPairings: [],
            description: null,
            ...a.meta,
            heldAt: now,
            heldReason: a.holdReason,
          },
          updatedAt: now,
        },
      }
    );
    // Re-embed on HOLD too (audit 2026-08-16): a force re-enrich that ends in
    // a hold has just nulled a previously PUBLISHED profile, and without this
    // the old description keeps living in the Qdrant vectors — cellar chat
    // would keep retrieving the wine by the very claims the hold silenced.
    // embedSinglePair rebuilds from the now-profile-less text (textHash makes
    // it a no-op for never-published rows). Best-effort, like the publish path.
    try {
      const vintages = await Bottle.distinct('vintage', { wineDefinition: wine._id, status: 'active' });
      for (const v of vintages) {
        await embedSinglePair(wine._id, v).catch(() => {});
      }
    } catch (embedErr) {
      console.warn(`[enrichmentJob] re-embed after hold failed (${wine._id}):`, embedErr.message);
    }
    return { result: 'held', reason: a.holdReason };
  }

  // A regeneration must not trade a BETTER profile for a WORSE one (somm
  // ticket 6a894676, 2026-08-22). Frogtown Cellars carried a search-assisted
  // profile at 0.6 with the producer identified; a curator filled in the
  // correct appellation, the forced re-enrich that followed could not get a
  // search slot — the rescue is capped per UTC day and curation burns the cap
  // in minutes — and the search-less rerun landed 0.4 with producerUnknown
  // true and a thinner description. Filling in a correct field made the
  // record worse, which is the opposite of what re-enrichment is for.
  //
  // Narrow on purpose. Only a regen that lost the web search AND came back
  // less confident is refused; an honest re-assessment that lowers confidence
  // on its own merits still lands, because the record really may have got
  // harder to describe. Like the reviewed-profile guard above, the old
  // profile stays and the row drops back into the worklists for a human.
  const prev = wine.aiProfile;
  const lostSearch = prev && prev.searchUsed === true && a.meta.searchUsed !== true;
  const lessSure = prev && Number.isFinite(prev.confidence)
    && Number.isFinite(a.meta.confidence) && a.meta.confidence < prev.confidence;
  if (prev && prev.description && lostSearch && lessSure) {
    await WineDefinition.updateOne(
      { _id: wine._id },
      { $set: { profileReviewedAt: null, updatedAt: now } }
    );
    console.log(`[enrichmentJob] kept searched profile ${wine._id}: regen lost search and dropped ${prev.confidence} → ${a.meta.confidence}`);
    return { result: 'kept', reason: 'would_downgrade_searched_profile' };
  }

  await WineDefinition.updateOne(
    { _id: wine._id },
    {
      $set: {
        aiProfile: {
          body:         cleanDescriptor('body', a.data.body),
          tannin:       cleanDescriptor('tannin', a.data.tannin),
          acidity:      cleanDescriptor('acidity', a.data.acidity),
          sweetness:    cleanDescriptor('sweetness', a.data.sweetness),
          flavors:      cleanStringList(a.data.flavors, 'flavors'),
          foodPairings: cleanStringList(a.data.foodPairings, 'foodPairings'),
          // Markdown-stripped, not just trimmed (computed above, beside the
          // hold decision that reads it): the model reaches for emphasis even
          // when told not to, and the raw string is served un-rendered by the
          // MCP tools. Load-bearing half of the fix — the prompt is only
          // advisory, and a self-hoster can override it via SiteConfig.
          description: a.description,
          ...a.meta,
          heldAt: null,
        },
        updatedAt: now,
        // Fresh content is unreviewed content: a stamp from before this
        // regeneration attested the OLD profile, and carrying it forward
        // would fake the audit trail the scaling review depends on.
        ...(wine.profileReviewedAt ? { profileReviewedAt: null } : {}),
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
/**
 * @param {object} [opts]
 * @param {'add'} [opts.trigger] — this call is the automatic per-add hook, so
 *   the enrichmentOnAdd policy applies. Absent means a deliberate call (batch
 *   loop, curator release, identity-edit follow-through) which the policy
 *   never gates: those are chosen, not incidental.
 */
async function enrichWineById(wineDefId, { budgetUserId, force = false, publishSuspect = false, curatorContext = null, trigger = null } = {}) {
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
      .populate('grapes', 'name color')
      .lean();
    if (!wine) return;
    // Same rule as the batch filter above, and it matters MORE here: this is
    // the fire-and-forget call services/bottleOps.js makes on every bottle add,
    // so without it the very add that mints a pending row would immediately
    // spend the adding user's daily AI budget describing a producerless wine.
    if (wine.pendingIdentity === true) return;
    if (wine.canary === true) return; // registry lockdown L4 — a canary's profile is the evidence; never touch it
    if (wine.aiProfile && wine.aiProfile.source === 'curator') return; // hand-corrected — never regenerate (force included)
    // Per-add policy (Johan 2026-08-21). Checked AFTER the wine is loaded
    // because 'sufficient' reads the record, and before any spend. Only the
    // automatic hook is gated: a curator release or an identity-edit
    // follow-through is a deliberate act and always runs.
    if (trigger === 'add') {
      const mode = aiConfig.get().enrichmentOnAdd;
      if (mode === 'off') return;
      if (mode === 'sufficient' && !identityDataSufficient(wine)) {
        // Not a failure: the record cannot support a true statement about
        // place or variety yet, and the sommelier researches exactly this
        // while setting its drink window.
        console.log(`[enrichmentJob] on-add skipped (${idStr}): identity too thin for an honest profile`);
        return undefined;
      }
    }
    if (!force) {
      if (wine.aiProfile && wine.aiProfile.description) return; // already enriched
      // HELD is a decision awaiting a human, not a gap to retry: without this
      // guard every later bottle add of the same wine would re-spend the
      // adder's AI budget re-generating a profile we would hold again.
      if (wine.aiProfile && wine.aiProfile.heldAt) return;
    }

    // The OUTCOME is returned ('enriched' | 'held' | 'skipped' | undefined on
    // guard/error) so a deliberate caller — releaseHeldProfile — can act only
    // on success. Fire-and-forget callers keep ignoring it; this function
    // still never throws.
    let outcome;
    if (budgetUserId) {
      const debit = await tryDebitAi(String(budgetUserId));
      if (!debit.ok) {
        // Over the shared daily AI budget — skip silently; the next admin
        // batch run picks the wine up. The triggering action never fails.
        console.warn('[enrichmentJob] enrichWineById skipped (%s): ai budget exhausted (%s)', idStr, debit.reason);
        return undefined;
      }
      try {
        const { result, reason } = await enrichWine(wine, aiConfig.get().enrichmentModel, { publishSuspect, curatorContext });
        outcome = result;
        // A transport-level failure never produced a billable completion
        if (result === 'skipped' && isRefundableFailure(reason)) await debit.refund();
      } catch (err) {
        await debit.refund();
        throw err; // handled by the outer catch below
      }
    } else {
      outcome = (await enrichWine(wine, aiConfig.get().enrichmentModel, { publishSuspect, curatorContext })).result;
    }
    console.log('[enrichmentJob] Auto-enriched new wine: %s', wine.name);
    return outcome;
  } catch (err) {
    console.warn('[enrichmentJob] enrichWineById failed (%s): %s', idStr, err.message);
    return undefined;
  }
}

/**
 * Release a HELD profile after a human reviewed the doubt: force-regenerate,
 * publish past the suspect flag, and stamp profileReviewedAt ONLY when the
 * publish actually happened. Stamping first (the v1.116.0 shape) hid the row
 * forever when the AI call failed — the outstanding queue compares
 * reviewedAt against generatedAt and the incremental job skips held rows by
 * design, so a failed release had no surface that would ever re-show it
 * (audit 2026-08-16, confirmed by three independent traces). On failure the
 * row simply STAYS in the queue, ready for another click.
 *
 * @returns {Promise<boolean>} true when the profile published and the review
 *   stamp landed.
 */
async function releaseHeldProfile(wineDefId, { context = null } = {}) {
  const outcome = await enrichWineById(wineDefId, { force: true, publishSuspect: true, curatorContext: context });
  if (outcome !== 'enriched') return false;
  await WineDefinition.updateOne(
    { _id: wineDefId },
    { $set: { profileReviewedAt: new Date() } }
  );
  return true;
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
 * Does the stored profile still describe this record?
 *
 * Exact, not heuristic: compares the inputs the profile was generated from
 * against the record's current values. A row enriched before the snapshot
 * shipped has nothing to compare and is reported NOT stale — unknown is not
 * the same as wrong, and treating it as stale would queue the whole registry
 * for a re-spend.
 *
 * @param {object} wine  WineDefinition, populated or not
 */
function isProfileStale(wine) {
  const snap = wine && wine.aiProfile && wine.aiProfile.inputsSnapshot;
  if (!snap) return false;
  return snap !== profileInputsSnapshot(wine);
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
  // enrichmentOnAdd 'off' means wine data is somm-owned (Johan, 2026-08-22):
  // the AI writes NOTHING automatically, and that includes this hook. It also
  // settles the deferred half of somm ticket 6a872818 — an approval-triggered
  // regeneration recomputed doubt flags from scratch, silently removing held
  // and suspect rows from the queue with nobody deciding, and once discarded
  // a curator's prepared release context. Under somm-owned data the somm
  // rewrites the profile as part of the same correction session (exactly what
  // they already did on the Gritelles row), so the staleness this hook fixed
  // resolves by hand instead.
  if (aiConfig.get().enrichmentOnAdd === 'off') return Promise.resolve();
  if (!wine || !wine.aiProfile || !wine.aiProfile.generatedAt) return Promise.resolve();
  if (wine.aiProfile.source === 'curator') return Promise.resolve();
  return enrichWineById(wine._id, { force: true }).catch(() => {});
}

module.exports = {
  start, requestStop, getStatus, enrichWineById, releaseHeldProfile,
  profileInputsSnapshot, reenrichAfterRecordEdit, isProfileStale,
  // exported for unit tests + the reset-misheld migration
  cleanDescriptor, cleanStringList, cleanProse, cleanConfidence, shouldHoldProfile, identityDataSufficient, findNoteVarietyConflict,
  _resetSearchSlots,
};
