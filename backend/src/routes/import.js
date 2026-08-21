const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const aiBurstLimiter = require('../middleware/aiBurstLimiter');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const Rack = require('../models/Rack');
const WineDefinition = require('../models/WineDefinition');
const Country = require('../models/Country');
const { getCellarRole } = require('../utils/cellarAccess');
const { logAudit } = require('../services/audit');
const { getOrCreateDailySnapshot } = require('../utils/exchangeRates');
const { resolveRating } = require('../utils/ratingUtils');
const { normalizeString, resolveCountryName } = require('../utils/normalize');
const { normalizeBottleSize, DEFAULT_SIZE } = require('../config/bottleSizes');
const searchService = require('../services/search');
const { identifyWineFromText } = require('../services/labelScan');
const aiProvider = require('../services/aiProvider');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const { scoreWineMatchVariants, stripProducerPrefix } = require('../services/wineMatching');
const { wineVisibilityFilter } = require('../services/wineVisibility');
const { tryDebitAi, isRefundableFailure } = require('../services/aiBudget');
const rateLimitsConfig = require('../config/rateLimits');
const { generateWineKey } = require('../utils/normalize');
const {
  CONSUMED_STATUSES,
  IMPORT_EXACT_THRESHOLD,
  IMPORT_FUZZY_THRESHOLD,
  MAX_IMPORT_SIZE,
  AI_CONCURRENCY,
} = require('../config/constants');
const { stripHtml, escapeRegex, sanitizeGrapeNames } = require('../utils/sanitize');
const { parseAndValidateVintage, parseDrinkYear } = require('../utils/validation');
const { ensurePendingVintageProfile } = require('../utils/vintageProfile');
const { extractAiExplanation } = require('../utils/jsonExtract');
const { getMaxPosition } = require('../utils/rackGeometry');
const { planRackCreations, placeBottlesInRack, VALID_ANCHORS, DEFAULT_ANCHOR } = require('../utils/rackImport');
const { RACK_TYPES } = require('../models/Rack');
const { validatePriceSanity } = require('../utils/priceValidation');
const { computeUserMediansByCurrency } = require('../services/priceWarnings');
const { runConcurrent } = require('../utils/concurrency');
const WineRequest = require('../models/WineRequest');
const WishlistItem = require('../models/WishlistItem');
const ImportSession = require('../models/ImportSession');

const router = express.Router();
// requireNonDemo: the CT/CSV importer spends AI on identify and creates registry
// wines; a throwaway demo must do neither. Demo users can't bulk-import.
router.use(requireAuth, requireNonDemo);

// Aliases for readability (imported from config/constants.js)
const EXACT_THRESHOLD = IMPORT_EXACT_THRESHOLD;
const FUZZY_THRESHOLD = IMPORT_FUZZY_THRESHOLD;

// Below this identification confidence the AI is going on inference, not
// knowledge ("0.5 = reasonably sure" in the prompt's own scale) — exactly the
// band that wrote a producer's home region onto wines from elsewhere and split
// one producer across region granularities (ticket 6a8162c5). Geography the
// AI proposed under this floor is dropped before it can mint; the curation
// backfill queue fills it from evidence instead.
//
// ⚠️ THIS FLOOR APPLIES TO AI-DERIVED GEOGRAPHY ONLY. It used to be justified
// by "import files carry no region/appellation columns, so this only ever
// strips AI inference — never user data", and that stopped being true:
// importMappers maps CellarTracker's Appellation, its
// Country/Region/SubRegion/Appellation Locale path, SubRegion and a generic
// appellation column, and findExactRegistryWine/scoreCandidate below have been
// matching on item.appellation all along. So the floor WAS deleting what the
// user typed. Measured 2026-08-21: one 231-wine import produced 86 null/null
// registry rows, and over half of a curation day went on putting back
// appellations the file had supplied. File geography now wins outright and is
// never subject to this floor — see buildProposedWine.
const AI_GEOGRAPHY_MIN_CONFIDENCE = 0.6;

// Distinct failure reasons kept in one import's audit row, and the length each
// is truncated to. Enough to name every failure mode a real file hits without
// letting a pathological one bloat the document.
const AUDIT_REASON_MAX_KINDS = 12;
const AUDIT_REASON_MAX_LEN = 160;

/**
 * Group per-row {reason} entries into { reason: count } for the audit.
 *
 * Deliberately reason-only: the row's wine name, producer and notes are the
 * user's data and the audit needs the failure MODE, not the record. Messages
 * that embed a caught err.message can vary per row, so they are truncated and
 * the tail is folded into one "+N more" bucket rather than dropped silently —
 * a cap that hides its own truncation is how you end up trusting a partial
 * picture.
 */
function summariseReasons(entries) {
  const counts = new Map();
  for (const e of entries) {
    const raw = (e && typeof e.reason === 'string' && e.reason.trim()) ? e.reason.trim() : '(no reason recorded)';
    const key = raw.length > AUDIT_REASON_MAX_LEN ? `${raw.slice(0, AUDIT_REASON_MAX_LEN)}…` : raw;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const kept = ranked.slice(0, AUDIT_REASON_MAX_KINDS);
  const out = Object.fromEntries(kept);
  const spilled = ranked.slice(AUDIT_REASON_MAX_KINDS);
  if (spilled.length) {
    out[`+${spilled.length} more reason kind(s)`] = spilled.reduce((s, [, n]) => s + n, 0);
  }
  return out;
}

/**
 * The wine a no-match row proposes to mint, built from the AI identification
 * and the user's own file row.
 *
 * PRECEDENCE: file geography beats AI geography, always. The file is what the
 * label says as the owner read it; the AI is recalling. The confidence floor
 * exists to stop the model ASSERTING a place it inferred, and it has no
 * business deleting a column the user filled in.
 *
 * Kept as a named function (rather than inline in the /validate loop) so the
 * precedence is unit-testable — it is the rule that decides what enters the
 * shared registry, and it was previously an expression buried 500 lines in.
 */
function buildProposedWine(aiData, item) {
  const clean = (v) => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s || null;
  };
  // Below the floor the model is inferring, not knowing (part B below).
  const lowGeoConfidence =
    !(typeof aiData.confidence === 'number' && aiData.confidence >= AI_GEOGRAPHY_MIN_CONFIDENCE);
  const fromAi = (v) => (lowGeoConfidence ? null : clean(v));

  return {
    name: aiData.name,
    producer: aiData.producer,
    // Country keeps the AI's value first: it is fed the file's country as a
    // hint and normalizes local-language names ("Deutschland" → "Germany"),
    // which the raw column does not. The file is the fallback, which is new —
    // a countryless identification used to cost the user the row entirely.
    country: clean(aiData.country) || clean(item && item.country),
    region: clean(item && item.region) || fromAi(aiData.region),
    appellation: clean(item && item.appellation) || fromAi(aiData.appellation),
    // Same floor as geography: a classification is an assertion of knowledge
    // (ticket 6a83f014 added the field to the identify prompt), and the file's
    // own value outranks it for the same reason.
    classification: clean(item && item.classification) || fromAi(aiData.classification),
    type: aiData.type,
    grapes: aiData.grapes,
    confidence: aiData.confidence,
  };
}

/**
 * Score a WineDefinition candidate against an import item.
 * Delegates to the shared wineMatching service. Variant-aware: import rows
 * often embed the producer inside the wine name (CellarTracker has no
 * Producer column), so the scorer takes the max over producer-embedded name
 * variants — strictly monotonic (only ever raises the score), so existing
 * matches keep their score and known wines stop being missed.
 */
function scoreCandidate(candidate, item) {
  return scoreWineMatchVariants(candidate, {
    name: item.wineName,
    producer: item.producer,
    appellation: item.appellation
  });
}

/**
 * Registry-first exact lookup for an import item — step (a) of the AI-saving
 * cascade. Tries the raw normalizedKey and, when the wine name embeds the
 * producer as a prefix, the prefix-stripped variant key. One indexed query,
 * zero AI.
 */
async function findExactRegistryWine(item) {
  if (!item.wineName || !item.producer) return null;
  // Prefer the exact-as-typed registry entry: query the RAW normalizedKey
  // first, and only fall back to the producer-prefix-stripped variant when
  // there is no raw hit. A single `$in: [rawKey, strippedKey]` returns an
  // ARBITRARY doc when the registry holds BOTH a clean entry and a
  // "producer-in-name" duplicate (~430 such duplicates exist pending cleanup),
  // making the import outcome depend on Mongo's storage order. Two cheap
  // indexed findOnes make it deterministic.
  const rawKey = generateWineKey(item.wineName, item.producer, item.appellation);
  const rawHit = await WineDefinition.findOne({ normalizedKey: rawKey })
    .populate(['country', 'region', 'grapes']);
  if (rawHit) return rawHit;

  const stripped = stripProducerPrefix(item.wineName, item.producer);
  if (!stripped) return null;
  const strippedKey = generateWineKey(stripped, item.producer, item.appellation);
  if (strippedKey === rawKey) return null; // same key — nothing new to try
  return WineDefinition.findOne({ normalizedKey: strippedKey })
    .populate(['country', 'region', 'grapes']);
}

/**
 * Find best wine matches for a single import item.
 * Strategy:
 *   1. Try Meilisearch fuzzy search (fast, covers typos)
 *   2. Fallback to MongoDB text search + normalized key lookup
 *   3. Score all candidates with combinedSimilarity
 *
 * `viewer` ({ userId, roles }) gates pendingIdentity rows exactly as the
 * resolver does. It matters here more than anywhere: a CellarTracker row with
 * no producer scores 1.0 against a PENDING row, whose stored producer is ''
 * — so without the gate an import would offer, and then attach bottles to,
 * ANOTHER USER's hidden half-identified wine (security audit). Strategy 3 was
 * the worst of the three: `normalizedKey: /:<name>:/` is unanchored, and the
 * pending namespace `pending~<uid>:<name>:` contains that substring by
 * construction. The creator still matches their OWN pending rows, which is
 * what keeps /validate's preview honest about what /confirm will do (the
 * commit path passes allowPending and resolves to the same row).
 */
async function findWineMatches(item, viewer = {}) {
  const candidates = new Map(); // id -> { wine, score }
  const visible = wineVisibilityFilter(viewer);

  // Strategy 1: Meilisearch search (if available)
  if (searchService.getIsAvailable()) {
    try {
      // Search with combined producer + name for best fuzzy results
      const query = `${item.producer || ''} ${item.wineName || ''}`.trim();
      const searchOpts = { limit: 15 };

      // Add country filter if we can resolve it
      if (item.country) {
        const normalizedCountry = normalizeString(item.country);
        const countryDoc = await Country.findOne({ normalizedName: normalizedCountry }).lean();
        if (countryDoc) searchOpts.countryId = countryDoc._id.toString();
      }

      const { ids } = await searchService.search(query, searchOpts);
      if (ids.length > 0) {
        // Pending rows are not in the Meili index at all; the clause is here so
        // the gate holds if that ever changes (all three strategies, one rule).
        const wines = await WineDefinition.find({ _id: { $in: ids }, ...visible })
          .populate(['country', 'region', 'grapes'])
          .lean();

        for (const wine of wines) {
          const score = scoreCandidate(wine, item);
          if (score >= FUZZY_THRESHOLD) {
            candidates.set(wine._id.toString(), { wine, score });
          }
        }
      }
    } catch (err) {
      console.error('Meilisearch search failed during import, falling back to MongoDB:', err.message);
    }
  }

  // Strategy 2: MongoDB text search fallback
  if (candidates.size < 3) {
    try {
      const searchTerms = `${item.producer || ''} ${item.wineName || ''}`.trim();
      if (searchTerms) {
        const mongoWines = await WineDefinition.find(
          { $text: { $search: searchTerms }, ...visible },
          { score: { $meta: 'textScore' } }
        )
          .populate(['country', 'region', 'grapes'])
          .sort({ score: { $meta: 'textScore' } })
          .limit(10)
          .lean();

        for (const wine of mongoWines) {
          const id = wine._id.toString();
          if (!candidates.has(id)) {
            const score = scoreCandidate(wine, item);
            if (score >= FUZZY_THRESHOLD) {
              candidates.set(id, { wine, score });
            }
          }
        }
      }
    } catch (err) {
      console.error('MongoDB text search failed during import (text index may not exist):', err.message);
    }
  }

  // Strategy 3: Direct normalized name/producer lookup
  if (candidates.size < 3 && item.producer && item.wineName) {
    const normalizedProducer = normalizeString(item.producer);
    const normalizedName = normalizeString(item.wineName);

    const keyMatch = {
      $or: [
        { normalizedKey: { $regex: `^${escapeRegex(normalizedProducer)}:` } },
        { normalizedKey: { $regex: `:${escapeRegex(normalizedName)}:` } }
      ]
    };
    // $and, not a spread: `visible` is itself an $or for non-curators, and two
    // $or keys in one object would silently drop the first.
    const directMatches = await WineDefinition.find(
      visible.$or ? { $and: [keyMatch, visible] } : { ...keyMatch, ...visible }
    )
      .populate(['country', 'region', 'grapes'])
      .limit(20)
      .lean();

    for (const wine of directMatches) {
      const id = wine._id.toString();
      if (!candidates.has(id)) {
        const score = scoreCandidate(wine, item);
        if (score >= FUZZY_THRESHOLD) {
          candidates.set(id, { wine, score });
        }
      }
    }
  }

  // Sort by score descending, return top 5
  const sorted = [...candidates.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return sorted;
}

/**
 * POST /api/bottles/import/validate
 *
 * Accepts an array of bottles in master import format.
 * Returns match results for each item with wine candidates.
 *
 * Body: { cellarId, items: [{ wineName, producer, country, ... }] }
 * Response: { results: [{ index, item, status, matches: [{ wine, score }] }] }
 */
router.post('/validate', aiBurstLimiter, async (req, res) => {
  try {
    const { cellarId, items } = req.body;
    // Who the candidate pool is being built FOR — see findWineMatches.
    const viewer = { userId: req.user.id, roles: req.user.roles };

    if (!cellarId) {
      return res.status(400).json({ error: 'cellarId is required' });
    }
    if (!mongoose.Types.ObjectId.isValid(cellarId)) {
      return res.status(400).json({ error: 'Invalid cellarId' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array is required and must not be empty' });
    }
    if (items.length > MAX_IMPORT_SIZE) {
      return res.status(400).json({ error: `Maximum ${MAX_IMPORT_SIZE} items per import` });
    }

    // Verify cellar access
    const cellar = await Cellar.findById(cellarId);
    if (!cellar || cellar.deletedAt) {
      return res.status(404).json({ error: 'Cellar not found' });
    }
    const role = getCellarRole(cellar, req.user.id);
    if (!role || role === 'viewer') {
      return res.status(403).json({ error: 'Not authorized to import bottles to this cellar' });
    }

    // Build preResults array and validate required fields. `forceAi` is a
    // client-side hint sent by the per-row "Look up" button: it bypasses the
    // registry-first cascade below so an explicit user request always gets an
    // AI attempt (subject to the daily budget). It is stripped from the item
    // to keep it out of the stored/echoed row.
    const preResults = [];
    for (let i = 0; i < items.length; i++) {
      const { forceAi, ...item } = items[i];
      if (!item.wineName && !item.producer) {
        preResults.push({ index: i, item, errorMsg: 'Wine name or producer is required' });
      } else {
        preResults.push({ index: i, item, matches: [], forceAi: forceAi === true });
      }
    }

    // Pass 1: AI identification for all valid items (deduplicated), preceded
    // by a registry-first cascade. AI is better at distinguishing similar
    // wines (e.g. single vineyard vs generic Barolo), but for wines the
    // registry ALREADY knows, the AI's canonicalized result would dedup to
    // the same registry wine anyway — so a confident registry match skips the
    // AI call with an outcome-identical result (audit M-2 cost defense).
    //
    // The dedup-by-wine-key + Pass 1a cascade run regardless of whether AI is
    // configured: a no-AI self-hosted install still gets ONE shared registry
    // lookup per unique wine — previously every row of a keyless install fell
    // through to a sequential per-row findWineMatches in Pass 3, defeating
    // the cascade's own "zero AI for known wines" intent. Only the AI fan-out
    // itself (Pass 1b) is gated on availability.
    const aiConfigured = aiProvider.isConfigured(); // invariant for the whole request
    const cascadeEligible = preResults.filter(pr => !pr.errorMsg && pr.item.wineName && pr.item.producer);

    // Build unique wine keys — one cascade/AI attempt per unique wine, not per bottle
    const aiKeyMap = new Map(); // normalizedKey -> preResult (representative)
    for (const pr of cascadeEligible) {
      const key = `${normalizeString(pr.item.wineName)}:${normalizeString(pr.item.producer)}`;
      if (!aiKeyMap.has(key)) aiKeyMap.set(key, pr);
      if (pr.forceAi) aiKeyMap.get(key).forceAi = true; // any row's Look-up button forces the key
    }
    const uniquePrs = [...aiKeyMap.values()];

    // Latch a client disconnect as EARLY as possible — BEFORE the sequential
    // Pass 1a cascade — so a disconnect during Pass 1a (which can be long for a
    // big batch) still stops us LAUNCHING (and debiting) the AI fan-out below.
    // res 'close' fires when the underlying connection closes; writableEnded
    // distinguishes a premature client disconnect from normal completion.
    // (req 'close' fires on message completion in Node >= 15, so it can't be
    // used for disconnect detection here.)
    let aiBudgetExhausted = false;
    let clientDisconnected = false;
    res.on('close', () => { if (!res.writableEnded) clientDisconnected = true; });

    // ── Pass 1a: registry-first cascade (zero AI for known wines) ──────────
    // (a) exact normalizedKey match (raw + producer-prefix-stripped variant);
    // (b) existing fuzzy scorer at the exact threshold (>= 0.95) — at that
    //     score the AI path's findOrCreateWine would auto-match the same
    //     registry wine, so skipping AI is outcome-identical;
    // (c) everything else goes to AI exactly as before.
    for (const pr of uniquePrs) {
      if (clientDisconnected) break; // requester gone — stop the cascade, skip AI entirely
      // forceAi bypasses the cascade only when there is an AI to reach; with
      // no key configured the shared cascade is the best available outcome.
      if (pr.forceAi && aiConfigured) continue;
      const exactWine = await findExactRegistryWine(pr.item);
      if (exactWine) {
        pr.registryWine = { wine: exactWine, score: 1 };
        continue;
      }
      const matches = await findWineMatches(pr.item, viewer);
      pr.preMatches = matches; // reused by Pass 3 if this row ends up on the fuzzy path
      if (matches.length > 0 && matches[0].score >= EXACT_THRESHOLD) {
        pr.registryWine = { wine: matches[0].wine, score: matches[0].score };
      }
    }

    // ── Pass 1b: AI fan-out for the remaining unique wines ─────────────────
    // Guarded by (audit M-2): a per-request fan-out cap, the shared per-user
    // daily AI budget + global daily cap (debited per actual Anthropic call,
    // refunded on transport failure), and a client-disconnect check that
    // stops LAUNCHING new calls once the requester has gone away. All three
    // degrade gracefully to the fuzzy path (aiSkipped: true) — never an error.
    const needAi = aiConfigured ? uniquePrs.filter(pr => !pr.registryWine) : [];
    const perRequestCap = rateLimitsConfig.get().aiImportPerRequestCap?.max
      ?? rateLimitsConfig.defaults.aiImportPerRequestCap.max;
    const aiRun = needAi.slice(0, perRequestCap);
    for (const pr of needAi.slice(perRequestCap)) pr.aiSkipped = true;

    const AI_SKIPPED = Symbol('aiSkipped');
    const aiSettled = await runConcurrent(
      aiRun.map(pr => async () => {
        // Checked at launch time: in-flight calls finish, new ones stop.
        if (clientDisconnected || aiBudgetExhausted) {
          pr.aiSkipped = true;
          return AI_SKIPPED;
        }
        const debit = await tryDebitAi(req.user.id, { isDemo: req.user.isDemo });
        if (!debit.ok) {
          aiBudgetExhausted = true;
          pr.aiSkipped = true;
          return AI_SKIPPED;
        }
        try {
          const result = await identifyWineFromText({
            name: pr.item.wineName,
            producer: pr.item.producer,
            vintage: pr.item.vintage,
            country: pr.item.country,
            // The file's own geography, as hints. Asking the model to place a
            // wine while withholding the appellation the user's export states
            // was making it infer what we had already been handed — and the
            // confidence floor then deleted the inference. Precedence still
            // lives in buildProposedWine; this only stops the blind guess.
            appellation: pr.item.appellation,
            region: pr.item.region,
          });
          // A transport-level failure never produced a billable completion —
          // give the debit back so failed calls don't burn the user's budget.
          if (!result.data && isRefundableFailure(result.debugReason)) await debit.refund();
          return result;
        } catch (err) {
          await debit.refund();
          throw err;
        }
      }),
      AI_CONCURRENCY
    );

    // Build a key -> AI result lookup (only wines that actually went to AI)
    const aiByKey = new Map();
    for (let j = 0; j < aiRun.length; j++) {
      const key = `${normalizeString(aiRun[j].item.wineName)}:${normalizeString(aiRun[j].item.producer)}`;
      aiByKey.set(key, aiSettled[j]);
    }

    // Attach the shared cascade/AI result to every eligible preResult with
    // that key (duplicates share the representative's outcome, as before).
    for (const pr of cascadeEligible) {
      const key = `${normalizeString(pr.item.wineName)}:${normalizeString(pr.item.producer)}`;
      const rep = aiKeyMap.get(key);
      if (rep.registryWine) { pr.registryWine = rep.registryWine; continue; }
      if (rep.preMatches && !pr.preMatches) pr.preMatches = rep.preMatches;
      if (rep.aiSkipped) { pr.aiSkipped = true; continue; }
      const settled = aiByKey.get(key);
      if (!settled) continue;
      if (settled.status === 'fulfilled') {
        if (settled.value === AI_SKIPPED) { pr.aiSkipped = true; continue; }
        pr.aiIdentified = settled.value.data;
        pr.aiDebugRaw    = settled.value.debugRaw;
        pr.aiDebugReason = settled.value.debugReason;
      } else {
        pr.aiError = settled.reason?.message;
      }
    }

    // ── Post-AI hygiene (ticket 6a8162c5) — BEFORE any matching, so the
    // cleaned values feed Pass 2, the client preview, and /confirm alike. ──
    //
    // A) One producer, one country per batch. Rows are identified one at a
    //    time, so an obscure producer can come back with a different guessed
    //    country per row ("Thomas Allen": South Africa on one, Australia on
    //    another — both minted, and the different-country guard then keeps
    //    them apart forever). Rows whose FILE stated a country are anchors
    //    and are never overwritten; when the file is silent, every row of a
    //    producer adopts one country — the anchors' (when they agree), else
    //    the highest-confidence AI row's.
    const aiRowsByProducer = new Map();
    for (const pr of preResults) {
      if (!pr.aiIdentified || typeof pr.aiIdentified.producer !== 'string') continue;
      const prodKey = normalizeString(pr.aiIdentified.producer);
      if (!prodKey) continue;
      if (!aiRowsByProducer.has(prodKey)) aiRowsByProducer.set(prodKey, []);
      aiRowsByProducer.get(prodKey).push(pr);
    }
    // Countries compare through the SAME fold the mint uses — alias resolve
    // then normalize — so "USA" and "United States" are one country here
    // exactly as they become one Country doc there (audit 2026-08-16:
    // normalizeString alone treated aliases as two countries and the pass
    // silently no-opped on the very splits it exists to prevent).
    const countryKey = (v) =>
      (typeof v === 'string' && v.trim()) ? normalizeString(resolveCountryName(v)) : '';
    for (const rows of aiRowsByProducer.values()) {
      // The FILE is the anchor, and its STATED VALUE is the anchor value —
      // not the AI's echo of it (audit 2026-08-16: anchoring on the echo let
      // an AI that contradicted the file spread the contradiction to the
      // whole group). Step one: any anchored row whose AI disagrees with its
      // own file column is corrected back to the file's value, which is also
      // what /confirm then mints.
      for (const pr of rows) {
        const fileKey = countryKey(pr.item.country);
        if (fileKey && countryKey(pr.aiIdentified.country) !== fileKey) {
          pr.aiIdentified.country = pr.item.country;
        }
      }
      const rowKey = (pr) => countryKey(pr.aiIdentified.country);
      const distinct = new Set(rows.map(rowKey).filter(Boolean));
      if (distinct.size === 0) continue; // no row knows a country — nothing to spread
      const anchors = rows.filter((pr) => countryKey(pr.item.country));
      let adopted = null;
      if (distinct.size === 1) {
        // Group already agrees — only rows the AI left countryless (which
        // could not mint at all) inherit it below.
        adopted = rows.find((pr) => rowKey(pr)).aiIdentified.country;
      } else if (anchors.length > 0) {
        // The file knows best — but only when it names ONE country. Two
        // file-backed countries for one producer is real information
        // (a brand genuinely bottling on two continents): touch nothing.
        const anchorKeys = new Set(anchors.map((pr) => countryKey(pr.item.country)));
        if (anchorKeys.size !== 1) continue;
        adopted = anchors[0].item.country;
      } else {
        // Highest-confidence row THAT HAS a country decides — a countryless
        // 0.9 row must not null the adoption and silently no-op the pass
        // (audit 2026-08-16).
        const withCountry = rows.filter((pr) => rowKey(pr));
        const best = withCountry.reduce((a, b) =>
          ((b.aiIdentified.confidence ?? 0) > (a.aiIdentified.confidence ?? 0) ? b : a));
        adopted = best.aiIdentified.country;
      }
      if (!adopted) continue;
      const adoptedKey = countryKey(adopted);
      for (const pr of rows) {
        // Never overwrite a row the file itself anchored.
        if (countryKey(pr.item.country)) continue;
        const own = rowKey(pr);
        if (own === adoptedKey) continue;
        if (!own) { pr.aiIdentified.country = adopted; continue; } // fill the gap
        // A row the model is CONFIDENT about keeps its own country: one
        // producer string can be two wineries on two continents (Domaine
        // Chandon FR vs Bodegas Chandon AR — the guard findOrCreateWine
        // documents), and overriding it here would bypass that guard at the
        // mint. Only sub-floor disagreements adopt the group country.
        const conf = pr.aiIdentified.confidence;
        if (typeof conf === 'number' && conf >= AI_GEOGRAPHY_MIN_CONFIDENCE) continue;
        pr.aiIdentified.country = adopted;
      }
    }
    //
    // B) Low-confidence geography never MINTS — but it still MATCHES. The
    //    strip is applied when the PROPOSAL is built in Pass 2, never to
    //    aiIdentified itself: the exact/canonical dedup keys embed the
    //    appellation, and stripping before matching made precisely the
    //    low-confidence rows most likely to duplicate lose their registry
    //    match and mint a twin (audit 2026-08-16 — an anti-fragmentation
    //    change causing fragmentation). Matching with an uncertain
    //    appellation is resolution, not assertion; nothing below the floor
    //    is ever WRITTEN.

    // Pass 2: resolve AI-identified items against the registry, deduplicated by
    // wine key. findOrCreateWine internally does fuzzy matching using the
    // AI-refined name/producer, which is more accurate than matching raw import
    // data. matchOnly — /validate is a PREVIEW and must never write to the
    // shared registry (security audit 2026-08-03 H-1: every cancelled, re-run
    // or column-remapped validate minted rows, and this route has no demo
    // gate). When nothing matches, the canonical AI identification rides back
    // to the client as `aiProposed`; /confirm creates the wine only for rows
    // the user actually imports.
    const matchedWineCache = new Map(); // normalizedKey -> { wine } | { proposed } | { error }
    for (const pr of preResults) {
      if (pr.registryWine || !pr.aiIdentified) continue;
      const key = `${normalizeString(pr.aiIdentified.name)}:${normalizeString(pr.aiIdentified.producer)}`;
      if (matchedWineCache.has(key)) {
        const cached = matchedWineCache.get(key);
        if (cached.wine) pr.aiWine = cached.wine;
        else if (cached.proposed) pr.aiProposed = cached.proposed;
        else pr.aiWineError = cached.error;
      } else {
        try {
          // Import-supplied grape names (optional `item.grapes`, e.g. from a
          // CellarTracker export) supplement the AI identification only when
          // the AI returned no grapes of its own. Grape taxonomy resolution
          // (synonyms, find-or-create) happens at /confirm and only for NEW
          // wines — matched registry wines are never mutated.
          const importGrapes = sanitizeGrapeNames(pr.item.grapes);
          const aiHasGrapes = Array.isArray(pr.aiIdentified.grapes) && pr.aiIdentified.grapes.length > 0;
          const wineData = (importGrapes.length > 0 && !aiHasGrapes)
            ? { ...pr.aiIdentified, grapes: importGrapes }
            : pr.aiIdentified;
          const { wine, noMatch } = await findOrCreateWine(wineData, req.user.id, { matchOnly: true });
          if (noMatch) {
            // A countryless identification can never mint — /confirm's
            // findOrCreateWine throws 'Country is required' and the row
            // error would silently cost the user their bottle (the exact
            // shape allowPending exists to prevent, with no escape hatch for
            // country; audit 2026-08-16). Demote to the no-match flow, where
            // the user picks an existing wine or files a request instead of
            // being offered a create that is guaranteed to fail.
            //
            // Tested against the PROPOSAL, not the AI object: the file's own
            // country column is a legitimate fallback now, so a row the model
            // could not place but the user could is minted instead of refused.
            const proposedCountry = buildProposedWine(wineData, pr.item).country;
            if (!(typeof proposedCountry === 'string' && proposedCountry.trim())) {
              const msg = 'The wine was recognised but its country could not be determined — match it to an existing wine or request it';
              matchedWineCache.set(key, { error: msg });
              pr.aiWineError = msg;
              continue;
            }
            // Explicit field list, not the raw AI object: this rides to the
            // client and back into /confirm, so it should carry exactly what
            // findOrCreateWine consumes (plus confidence for display).
            // buildProposedWine holds the file-beats-AI precedence and the
            // geography floor (part B above) in one testable place.
            const proposed = buildProposedWine(wineData, pr.item);
            matchedWineCache.set(key, { proposed });
            pr.aiProposed = proposed;
          } else {
            matchedWineCache.set(key, { wine });
            pr.aiWine = wine;
          }
        } catch (err) {
          matchedWineCache.set(key, { error: err.message });
          pr.aiWineError = err.message;
        }
      }
    }

    // Pass 3: fuzzy matching fallback for items without AI results
    // (API key not set, AI failed or was budget/cap/disconnect-skipped, or
    // missing name/producer for AI). Cascade matches from Pass 1a are reused
    // instead of re-querying.
    for (const pr of preResults) {
      if (pr.errorMsg || pr.aiWine || pr.registryWine) continue; // skip errors and matched items
      const matches = pr.preMatches ?? await findWineMatches(pr.item, viewer);
      pr.matches = matches;
    }

    // Pass 4: build final results (aiConfigured hoisted above — don't re-derive per row)
    const results = [];
    for (const pr of preResults) {
      if (pr.errorMsg) {
        results.push({ index: pr.index, item: pr.item, status: 'error', error: pr.errorMsg, matches: [] });
        continue;
      }

      let status, resultMatches, aiDebug = null;

      if (pr.registryWine) {
        // Registry-first cascade hit (exact key or >= EXACT_THRESHOLD fuzzy):
        // the registry already knows this wine, so no AI was needed. Treated
        // as an exact match — same wineId the AI path would have resolved to.
        const { wine, score } = pr.registryWine;
        status = 'exact';
        resultMatches = [{
          wineId: wine._id,
          name: wine.name,
          producer: wine.producer,
          country: wine.country?.name || null,
          region: wine.region?.name || null,
          appellation: wine.appellation || null,
          type: wine.type,
          image: wine.image || null,
          score: Math.round(score * 100) / 100
        }];
      } else if (pr.aiWine) {
        // AI identified the wine and the registry already knows it
        status = 'ai_match';
        resultMatches = [{
          wineId: pr.aiWine._id,
          name: pr.aiWine.name,
          producer: pr.aiWine.producer,
          country: pr.aiWine.country?.name || null,
          region: pr.aiWine.region?.name || null,
          appellation: pr.aiWine.appellation || null,
          type: pr.aiWine.type,
          image: pr.aiWine.image || null,
          score: pr.aiIdentified.confidence ?? 1,
          aiIdentified: true
        }];
      } else if (pr.aiProposed) {
        // AI identified the wine but the registry doesn't know it yet. NOTHING
        // was created — the proposal (attached below) rides back to the client
        // and /confirm mints it only for rows the user actually imports. Fuzzy
        // candidates from the raw import fields are still offered so the user
        // can pick an existing wine instead of creating.
        status = 'ai_new';
        resultMatches = (pr.matches || []).map(m => ({
          wineId: m.wine._id,
          name: m.wine.name,
          producer: m.wine.producer,
          country: m.wine.country?.name || null,
          region: m.wine.region?.name || null,
          appellation: m.wine.appellation || null,
          type: m.wine.type,
          image: m.wine.image || null,
          score: Math.round(m.score * 100) / 100
        }));
      } else if (pr.matches.length > 0) {
        // AI failed or unavailable, but fuzzy matching found candidates
        const { matches } = pr;
        if (matches[0].score >= EXACT_THRESHOLD) {
          status = 'exact';
        } else {
          status = 'fuzzy';
        }
        resultMatches = matches.map(m => ({
          wineId: m.wine._id,
          name: m.wine.name,
          producer: m.wine.producer,
          country: m.wine.country?.name || null,
          region: m.wine.region?.name || null,
          appellation: m.wine.appellation || null,
          type: m.wine.type,
          image: m.wine.image || null,
          score: Math.round(m.score * 100) / 100
        }));
      } else {
        // No match from either AI or fuzzy
        status = 'no_match';
        resultMatches = [];

        // Include AI debug info when AI was attempted but failed (not when it
        // was skipped by budget/cap/disconnect — those rows carry aiSkipped)
        if (!pr.aiSkipped && aiConfigured && (pr.item.wineName || pr.item.producer)) {
          const aiStatus = pr.aiError || pr.aiDebugReason === 'rate_limit_exceeded' ||
            (pr.aiDebugReason && pr.aiDebugReason.startsWith('exception'))
            ? 'failed' : (pr.aiWineError ? 'create_failed' : 'searched');
          const aiExplanation = aiStatus === 'create_failed' && pr.aiWineError
            ? pr.aiWineError
            : extractAiExplanation(pr.aiDebugRaw);
          aiDebug = { aiStatus, ...(aiExplanation && { aiExplanation }) };
        }
      }

      const result = { index: pr.index, item: pr.item, status, matches: resultMatches };
      if (pr.aiProposed) result.aiProposed = pr.aiProposed;
      if (aiDebug) result.aiDebug = aiDebug;
      // Flag rows whose AI identify was skipped (daily budget exhausted,
      // per-request cap, or client disconnect) — they fell through to the
      // fuzzy path above. Informational only; the row itself never errors.
      if (pr.aiSkipped) result.aiSkipped = true;
      results.push(result);
    }

    // ── Per-item price sanity warnings (non-blocking) ────────────────────────
    // Computes the user's per-currency median ONCE from the active cellar
    // and reuses it for every row, instead of querying per-bottle.
    // Wine-vintage market price is skipped here (matches resolve later when
    // the user picks a candidate). See utils/priceValidation.
    const userMedians = await computeUserMediansByCurrency(cellar.user);
    for (const r of results) {
      const price = Number(r.item?.price);
      if (!isFinite(price) || price <= 0) continue;
      const currency = (r.item?.currency || 'USD').toUpperCase();
      const m = userMedians[currency];
      r.priceWarnings = validatePriceSanity({
        price,
        currency,
        userMedianPrice:  m?.median ?? null,
        userMedianSample: m?.sample ?? 0,
      });
    }

    res.json({
      cellarId,
      results,
      summary: {
        total: results.length,
        exact: results.filter(r => r.status === 'exact').length,
        fuzzy: results.filter(r => r.status === 'fuzzy').length,
        aiMatch: results.filter(r => r.status === 'ai_match').length,
        aiNew: results.filter(r => r.status === 'ai_new').length,
        noMatch: results.filter(r => r.status === 'no_match').length,
        errors: results.filter(r => r.status === 'error').length,
        priceWarnings: results.filter(r => r.priceWarnings?.length).length,
        // Present only when the shared daily AI budget (or the global cap)
        // ran out mid-import: remaining rows were matched fuzzily instead of
        // via AI (aiSkipped: true per row). The import still succeeds.
        ...(aiBudgetExhausted && { aiBudgetExhausted: true })
      }
    });
  } catch (error) {
    console.error('Import validate error:', error);
    res.status(500).json({ error: 'Validation failed' });
  }
});

/**
 * POST /api/bottles/import/confirm
 *
 * Creates bottles for validated import items.
 * Each item must have a confirmed wineDefinition ID.
 *
 * Body: { cellarId, items: [{ wineDefinition, vintage, price, currency, ... }] }
 * Optional per-item fields (additive — items without them behave as before):
 *   grapes          — array of grape-name strings; suggestions for NEW wines
 *                     only (request-wine path → WineRequest.suggestedGrapes);
 *                     matched registry wines are never mutated
 *   drinkFrom/drinkTo — integer years (1900–2200, from <= to); stored as the
 *                     user's own per-bottle drink window (Bottle.drinkFrom/
 *                     drinkTo — never the shared registry). Invalid values
 *                     are silently dropped, never failing the row.
 *   addToWishlist   — the row becomes a WishlistItem for the importing user
 *                     instead of a Bottle (requires a matched registry wine;
 *                     request-wine rows are reported as per-row errors).
 *                     Duplicates — in-batch or already-wanted — are skipped.
 * Response: { created, skipped, errors[], wishlistCreated, ... }
 */
router.post('/confirm', async (req, res) => {
  try {
    const { cellarId, items, positionAnchor: rawAnchor, rackConfigs: rawRackConfigs, defaultCurrency: rawDefaultCurrency, importNotes: rawImportNotes, importOccasion: rawImportOccasion } = req.body;

    if (!cellarId) {
      return res.status(400).json({ error: 'cellarId is required' });
    }
    if (!mongoose.Types.ObjectId.isValid(cellarId)) {
      return res.status(400).json({ error: 'Invalid cellarId' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array is required and must not be empty' });
    }
    if (items.length > MAX_IMPORT_SIZE) {
      return res.status(400).json({ error: `Maximum ${MAX_IMPORT_SIZE} items per import` });
    }

    const positionAnchor = VALID_ANCHORS.includes(rawAnchor) ? rawAnchor : DEFAULT_ANCHOR;

    // Currency to apply when an import item has no Currency column of its own.
    // We accept any 3-letter ISO code here so the user's profile preference
    // (or a future addition to the frontend CURRENCIES list) flows through
    // without backend changes. Falls back to USD when no preference is set.
    const defaultCurrency = (typeof rawDefaultCurrency === 'string' && /^[A-Z]{3}$/i.test(rawDefaultCurrency))
      ? rawDefaultCurrency.toUpperCase()
      : 'USD';

    // Whole-import comment/occasion (support ticket 2026-07-30): typed once on
    // the confirm screen, they land on every BOTTLE this import creates.
    // Fill-blank only — a row that carries its own note from the file keeps it
    // (imports never overwrite file data). Wishlist rows are deliberately
    // excluded: "bought at the estate sale" describes bottles owned, not wines
    // wanted. Caps mirror the Bottle schema (notes 5000, occasion 500).
    const importNotes = typeof rawImportNotes === 'string' ? stripHtml(rawImportNotes).slice(0, 5000) : '';
    const importOccasion = typeof rawImportOccasion === 'string' ? stripHtml(rawImportOccasion).slice(0, 500) : '';

    // Validate user-supplied per-rack configuration.
    // Shape: { [rackName]: { skip?, type?, rows?, cols?, typeConfig?: {...}, disabledPositions?: [Number] } }
    // skip — when true, drop this rack from auto-creation AND placement;
    //   bottles referencing it land in the cellar without rack placement
    // type — one of RACK_TYPES (defaults to 'grid' if absent/invalid)
    // rows/cols — clamped to 1..20
    // typeConfig — optional shape config (bottlesPerCell, bottlesPerSection,
    //   moduleRows, moduleCols, backCols), each clamped to model bounds
    // disabledPositions — global 1-indexed positions marked unusable (e.g.
    //   Oeno-export cabinets); deduped here, clamped to the created rack's
    //   capacity at creation time below
    const rackConfigs = {};
    const clampInt = (v, min, max) => {
      const n = parseInt(v, 10);
      if (isNaN(n)) return undefined;
      return Math.max(min, Math.min(max, n));
    };
    if (rawRackConfigs && typeof rawRackConfigs === 'object') {
      for (const [name, cfg] of Object.entries(rawRackConfigs)) {
        if (!cfg || typeof cfg !== 'object') continue;

        // skip:true short-circuits — no rows/cols required since the rack
        // won't be created and no bottles will be placed.
        if (cfg.skip === true) {
          rackConfigs[String(name)] = { skip: true };
          continue;
        }

        const rows = clampInt(cfg.rows, 1, 20);
        const cols = clampInt(cfg.cols, 1, 20);
        if (!rows || !cols) continue;

        const entry = { rows, cols };
        if (cfg.type && RACK_TYPES.includes(cfg.type)) entry.type = cfg.type;

        if (cfg.typeConfig && typeof cfg.typeConfig === 'object') {
          const tc = {};
          const mr = clampInt(cfg.typeConfig.moduleRows, 1, 10);
          const mc = clampInt(cfg.typeConfig.moduleCols, 1, 10);
          const bpc = clampInt(cfg.typeConfig.bottlesPerCell, 1, 20);
          const bps = clampInt(cfg.typeConfig.bottlesPerSection, 1, 30);
          const bc = clampInt(cfg.typeConfig.backCols, 0, 20);
          if (mr !== undefined) tc.moduleRows = mr;
          if (mc !== undefined) tc.moduleCols = mc;
          if (bpc !== undefined) tc.bottlesPerCell = bpc;
          if (bps !== undefined) tc.bottlesPerSection = bps;
          if (bc !== undefined) tc.backCols = bc;
          if (Object.keys(tc).length > 0) entry.typeConfig = tc;
        }

        if (Array.isArray(cfg.disabledPositions)) {
          const dp = [...new Set(
            cfg.disabledPositions
              .map(p => parseInt(p, 10))
              .filter(p => !isNaN(p) && p >= 1)
          )];
          if (dp.length > 0) entry.disabledPositions = dp;
        }

        rackConfigs[String(name)] = entry;
      }
    }

    // Verify cellar access
    const cellar = await Cellar.findById(cellarId);
    if (!cellar || cellar.deletedAt) {
      return res.status(404).json({ error: 'Cellar not found' });
    }
    const role = getCellarRole(cellar, req.user.id);
    if (!role || role === 'viewer') {
      return res.status(403).json({ error: 'Not authorized to import bottles to this cellar' });
    }

    // Ensure exchange rate snapshot exists if any items have prices
    const hasPrice = items.some(i => i.price != null && i.price !== '');
    if (hasPrice) {
      await getOrCreateDailySnapshot().catch(err => console.error('Failed to fetch daily exchange rate snapshot:', err.message));
    }

    // Auto-create any racks referenced in the import that don't already exist
    // in this cellar. User-supplied rackConfigs take precedence over inferred
    // dimensions. Runs once up-front so the bottle-placement step below can
    // rely on every rack being present.
    const createdRacks = [];
    try {
      const rackPlan = planRackCreations(items);
      if (rackPlan.size > 0) {
        const existing = await Rack.find({
          cellar: cellarId,
          name: { $in: Array.from(rackPlan.keys()) },
          deletedAt: null
        }).select('name').lean();
        const existingNames = new Set(existing.map(r => r.name));

        for (const [name, spec] of rackPlan.entries()) {
          if (existingNames.has(name)) continue;
          const override = rackConfigs[name];
          // User opted out of creating this rack — bottles will be imported
          // into the cellar without placement (handled in the placement loop).
          if (override?.skip) continue;
          const rows = override?.rows || spec.rows;
          const cols = override?.cols || spec.cols;
          const chosenType = override?.type || spec.type;
          const safeType = RACK_TYPES.includes(chosenType) ? chosenType : 'grid';
          const rackData = {
            cellar: cellarId,
            user: cellar.user,
            name,
            type: safeType,
            rows,
            cols
          };
          if (override?.typeConfig) rackData.typeConfig = override.typeConfig;
          const rack = new Rack(rackData);
          // Disabled positions beyond the created geometry address cells that
          // don't exist — drop them rather than storing dead entries.
          if (override?.disabledPositions?.length) {
            const rackMax = getMaxPosition(rack);
            rack.disabledPositions = override.disabledPositions.filter(p => p <= rackMax);
          }
          await rack.save();
          createdRacks.push({ name, type: safeType, rows, cols, typeConfig: override?.typeConfig });
          logAudit(req, 'rack.create', { type: 'rack', id: rack._id }, { source: 'import', name });
        }
      }
    } catch (err) {
      console.error('Failed to auto-create racks during import (non-fatal):', err.message);
    }

    let created = 0;
    // Split of `created` for the done-screen breakdown: active bottles vs
    // those that were created already-consumed (addToHistory=true), e.g.
    // Oeno-export rows with a Consumed On date.
    let createdActive = 0;
    let createdHistory = 0;
    // Rows flagged addToWishlist (e.g. a Vivino scan-history import sent to
    // the wishlist) become WishlistItems for the IMPORTING user — wishlists
    // are personal, unlike bottles which belong to the cellar owner.
    let wishlistCreated = 0;
    // In-batch wishlist dedup: scan-history files routinely list the same
    // wine several times. Keyed wineDefinition|vintage, same identity the
    // existing-wishlist duplicate check uses.
    const wishlistSeen = new Set();
    const skipped = [];
    const errors = [];
    const createdBottleIds = []; // Track IDs for Meilisearch bulk sync
    // Dedup map: "wineName|producer" -> WineRequest doc created in this batch
    const pendingRequestCache = new Map();
    // Dedup map for AI-proposed NEW wines confirmed at review: an import file
    // routinely repeats the same wine, and each unique one must resolve to ONE
    // registry row per batch. normalizedKey-style key, same as /validate.
    const aiWineCache = new Map();
    // Wines this batch minted with an incomplete identity (no usable producer,
    // or a geography in the producer column — the classic one-column-off
    // mapping). Their BOTTLES imported normally; only the registry entry waits
    // on a curator. Reported once, as a plain line on the done screen.
    let pendingIdentityCount = 0;
    // Collected rack-placement intents from this batch; processed per-rack
    // after the main loop so multiple bottles claiming the same slot can
    // overflow cleanly into adjacent free slots.
    // Shape: [{ rackName, item, bottleId, sourceIndex }]
    const pendingPlacements = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      if (!item.wineDefinition && !item.requestWine && !item.aiWine) {
        skipped.push({ index: i, reason: 'No wine selected' });
        continue;
      }

      // Validate vintage up front. A single typo'd row is reported as an
      // error and skipped, but doesn't abort the whole batch.
      const vintageCheck = parseAndValidateVintage(item.vintage);
      if (!vintageCheck.ok) {
        errors.push({ index: i, reason: vintageCheck.error });
        continue;
      }
      const canonicalVintage = vintageCheck.value;

      try {
        let wineDoc = null;

        // AI-identified NEW wine, confirmed by the user at review. This is the
        // single place the import flow may write to the shared registry —
        // /validate is read-only (matchOnly) since the 2026-08-03 H-1 fix.
        // findOrCreateWine still matches first, so a wine minted meanwhile (a
        // parallel import, another user) dedupes instead of duplicating.
        if (!item.wineDefinition && !item.requestWine && item.aiWine) {
          // Demo accounts never reach here — the router-level requireNonDemo
          // (top of this file) is the gate, same one /api/wines/find-or-create
          // uses, so registry writes stay barred at ONE chokepoint.
          const ai = item.aiWine;
          // findOrCreateWine .trim()s name/producer before consulting any
          // option — a non-string must become a row error here, not a throw.
          const str = (v) => (typeof v === 'string' && v.trim() ? v : undefined);
          // Name only. A row whose producer the file/AI could not supply used
          // to die here — the strict mint gate 400'd, the catch turned it into
          // a row error, and the user SILENTLY LOST the bottle. With
          // allowPending the bottle lands and the wine goes to the somm queue,
          // which is the exact friction this feature exists to remove.
          if (typeof ai !== 'object' || !str(ai.name)) {
            errors.push({ index: i, reason: 'AI wine data is missing its name' });
            continue;
          }
          const aiKey = `${normalizeString(ai.name)}:${normalizeString(ai.producer || '')}`;
          let wine = aiWineCache.get(aiKey);
          if (!wine) {
            const { wine: resolved, created, producerRejected } = await findOrCreateWine({
              name: ai.name,
              producer: str(ai.producer) || '',
              country: str(ai.country),
              region: str(ai.region),
              appellation: str(ai.appellation),
              classification: str(ai.classification),
              type: str(ai.type),
              grapes: sanitizeGrapeNames(ai.grapes),
            }, req.user.id, { createdVia: 'import', allowPending: true });
            // findOrCreateWine can return { wine: null, candidates } — the soft
            // zone. Unguarded, `wine._id` two lines down threw and took the
            // whole /confirm batch with it (audit L-7). Skip the row and report
            // it, which is what every other unresolvable row here does.
            if (!resolved) {
              errors.push({ index: i, reason: 'Could not resolve this wine in the registry — very similar wines already exist' });
              continue;
            }
            wine = resolved;
            aiWineCache.set(aiKey, wine);
            if (created) {
              if (wine.pendingIdentity) pendingIdentityCount++;
              // Same action name as the MCP/admin/find-or-create surfaces so
              // registry writes read as one audit stream (2026-08-03 M-1).
              logAudit(req, 'wine.create', { type: 'wine', id: wine._id },
                { via: 'import', name: wine.name, producer: wine.producer || null,
                  ...(wine.pendingIdentity ? { pendingIdentity: true } : {}),
                  // What the CSV actually said, when the gate refused it
                  // (audit MED-1) — the pending row itself stores ''.
                  ...(producerRejected
                    ? { rejectedProducer: producerRejected.producer, rejectedByCheck: producerRejected.check }
                    : {}) });
            }
          }
          // Hand the resolved doc straight to the bottle-creation flow below —
          // item.wineDefinition keeps the wishlist branch working, wineDoc
          // skips the redundant findById re-fetch.
          item.wineDefinition = wine._id;
          wineDoc = wine;
        }

        // Wishlist destination (e.g. a Vivino scan-history import sent to
        // the wishlist): the row becomes a WishlistItem instead of a Bottle.
        // WishlistItem requires a registry wine, so request-wine rows can't
        // be wishlisted — reported per-row, never failing the batch.
        if (item.addToWishlist) {
          if (item.requestWine || !item.wineDefinition) {
            errors.push({ index: i, reason: 'Only wines matched to the registry can be added to the wishlist' });
            continue;
          }
          if (!mongoose.Types.ObjectId.isValid(item.wineDefinition)) {
            errors.push({ index: i, reason: 'Invalid wine definition ID' });
            continue;
          }
          const wishWine = await WineDefinition.findById(item.wineDefinition);
          if (!wishWine) {
            errors.push({ index: i, reason: 'Wine definition not found' });
            continue;
          }

          // Dedup within this batch, then against the existing wishlist —
          // same identity POST /api/wishlist uses (user + wine + vintage,
          // 'wanted' only, blank vintage matching null/absent/'').
          const wishKey = `${item.wineDefinition}|${canonicalVintage || ''}`;
          if (wishlistSeen.has(wishKey)) {
            skipped.push({ index: i, reason: 'Duplicate wishlist row in this import' });
            continue;
          }
          const dupFilter = { user: req.user.id, wineDefinition: item.wineDefinition, status: 'wanted' };
          if (canonicalVintage) {
            dupFilter.vintage = canonicalVintage;
          } else {
            dupFilter.$or = [{ vintage: null }, { vintage: { $exists: false } }, { vintage: '' }];
          }
          const existingWish = await WishlistItem.findOne(dupFilter);
          if (existingWish) {
            wishlistSeen.add(wishKey);
            skipped.push({ index: i, reason: 'Already on your wishlist' });
            continue;
          }

          await WishlistItem.create({
            user: req.user.id,
            wineDefinition: item.wineDefinition,
            vintage: canonicalVintage || undefined,
            notes: (stripHtml(item.notes) || '').slice(0, 2000) || undefined,
            priority: 'medium'
          });
          wishlistSeen.add(wishKey);
          wishlistCreated++;
          continue;
        }

        // Optional personal drink window (drinkFrom/drinkTo years, e.g.
        // CellarTracker BeginConsume/EndConsume) — stored on the bottle
        // itself, never on the shared registry. Invalid values are silently
        // dropped: a bad imported year must never fail the row. An inverted
        // pair (from > to) is dropped whole — we can't tell which side is
        // wrong. undefined fields are simply omitted from the document.
        const fromCheck = parseDrinkYear(item.drinkFrom, 'drinkFrom');
        const toCheck = parseDrinkYear(item.drinkTo, 'drinkTo');
        let drinkFrom = fromCheck.ok ? fromCheck.value : undefined;
        let drinkTo = toCheck.ok ? toCheck.value : undefined;
        if (drinkFrom !== undefined && drinkTo !== undefined && drinkFrom > drinkTo) {
          drinkFrom = undefined;
          drinkTo = undefined;
        }

        if (item.requestWine) {
          // No match — create a pending WineRequest and bottle without wineDefinition
          if (!item.wineName && !item.producer) {
            errors.push({ index: i, reason: 'Wine name or producer is required' });
            continue;
          }

          const requestKey = `${(item.wineName || '').trim().toLowerCase()}|${(item.producer || '').trim().toLowerCase()}`;
          let wineRequest = pendingRequestCache.get(requestKey);

          if (!wineRequest) {
            // Optional import-supplied grape names ride along as suggestions —
            // the admin sees them when resolving the request and decides which
            // taxonomy grapes the new wine definition gets (registry integrity:
            // imports never write taxonomy directly on this path).
            const suggestedGrapes = sanitizeGrapeNames(item.grapes);
            wineRequest = new WineRequest({
              requestType: 'new_wine',
              wineName: (item.wineName || item.producer || '').trim(),
              producer: (item.producer || '').trim() || undefined,
              user: req.user.id,
              status: 'pending',
              ...(suggestedGrapes.length > 0 ? { suggestedGrapes } : {})
            });
            await wineRequest.save();
            pendingRequestCache.set(requestKey, wineRequest);
          }

          // Validate rating if provided — the frontend sends rating/ratingScale
          // for request-wine rows too; dropping them here silently lost the
          // user's rating on every imported bottle whose wine had to be
          // requested (mirrors the matched-wine branch below).
          const { rating: resolvedRating, ratingScale: resolvedScale, error: ratingError } =
            resolveRating(item.rating, item.ratingScale);
          if (ratingError) {
            errors.push({ index: i, reason: ratingError });
            continue;
          }

          // Validate consumed rating if adding to history
          const { rating: resolvedConsumedRating, ratingScale: resolvedConsumedScale, error: consumeRatingError } =
            item.addToHistory ? resolveRating(item.consumedRating, item.consumedRatingScale) : { rating: undefined, ratingScale: undefined, error: null };
          if (consumeRatingError) {
            errors.push({ index: i, reason: consumeRatingError });
            continue;
          }

          if (item.addToHistory && item.consumedReason && !CONSUMED_STATUSES.includes(item.consumedReason)) {
            errors.push({ index: i, reason: 'Invalid consumed reason' });
            continue;
          }

          const priceSetAt = (item.price != null && item.price !== '') ? new Date() : undefined;

          const bottle = new Bottle({
            cellar: cellarId,
            user: cellar.user,
            pendingWineRequest: wineRequest._id,
            vintage: canonicalVintage,
            price: item.price || undefined,
            currency: item.currency || defaultCurrency,
            priceSetAt,
            bottleSize: normalizeBottleSize(item.bottleSize) || DEFAULT_SIZE,
            purchaseDate: item.purchaseDate || undefined,
            purchaseLocation: stripHtml(item.purchaseLocation),
            location: stripHtml(item.location),
            notes: stripHtml(item.notes) || importNotes || undefined,
            occasion: (stripHtml(item.occasion) || '').slice(0, 500) || importOccasion || undefined,
            rating: resolvedRating,
            ratingScale: resolvedScale,
            drinkFrom,
            drinkTo
          });

          if (item.dateAdded) bottle.createdAt = new Date(item.dateAdded);

          // Seed the cellar journey like POST /api/bottles does — honours a
          // backdated dateAdded so the journey timeline and time-in-cellar
          // stats start at the real added date, not the import date.
          bottle.addedToCellarAt = bottle.createdAt || new Date();
          bottle.cellarHistory = [{ cellar: cellar._id, cellarName: cellar.name, enteredAt: bottle.addedToCellarAt }];

          if (item.addToHistory) {
            const reason = item.consumedReason || 'drank';
            bottle.status = reason;
            bottle.consumedReason = reason;
            bottle.consumedAt = item.consumedAt ? new Date(item.consumedAt) : new Date();
            if (item.consumedNote) bottle.consumedNote = stripHtml(item.consumedNote);
            if (resolvedConsumedRating !== undefined) {
              bottle.consumedRating = resolvedConsumedRating;
              bottle.consumedRatingScale = resolvedConsumedScale;
            }
          }

          await bottle.save();
          created++;
          // Index every created bottle (consumed history rows too — H3).
          createdBottleIds.push(bottle._id);
          if (item.addToHistory) {
            createdHistory++;
          } else {
            createdActive++;
          }

          // Queue rack placement for unmatched bottles too
          const hasPlacement = item.rackName && (item.rackPosition || (item.row && item.col));
          if (hasPlacement && bottle.status === 'active' && !rackConfigs[String(item.rackName)]?.skip) {
            pendingPlacements.push({ rackName: String(item.rackName), item, bottleId: bottle._id, sourceIndex: i });
          }
          continue;
        }

        // Verify wine definition exists (already resolved for aiWine rows)
        if (!wineDoc) {
          if (!mongoose.Types.ObjectId.isValid(item.wineDefinition)) {
            errors.push({ index: i, reason: 'Invalid wine definition ID' });
            continue;
          }
          wineDoc = await WineDefinition.findById(item.wineDefinition);
          if (!wineDoc) {
            errors.push({ index: i, reason: 'Wine definition not found' });
            continue;
          }
        }

        // Validate rating if provided
        const { rating: resolvedRating, ratingScale: resolvedScale, error: ratingError } =
          resolveRating(item.rating, item.ratingScale);
        if (ratingError) {
          errors.push({ index: i, reason: ratingError });
          continue;
        }

        // Validate consumed rating if adding to history
        const { rating: resolvedConsumedRating, ratingScale: resolvedConsumedScale, error: consumeRatingError } =
          item.addToHistory ? resolveRating(item.consumedRating, item.consumedRatingScale) : { rating: undefined, ratingScale: undefined, error: null };
        if (consumeRatingError) {
          errors.push({ index: i, reason: consumeRatingError });
          continue;
        }

        if (item.addToHistory && item.consumedReason && !CONSUMED_STATUSES.includes(item.consumedReason)) {
          errors.push({ index: i, reason: 'Invalid consumed reason' });
          continue;
        }

        const priceSetAt = (item.price != null && item.price !== '')
          ? new Date()
          : undefined;

        const bottle = new Bottle({
          cellar: cellarId,
          user: cellar.user,
          wineDefinition: item.wineDefinition,
          vintage: canonicalVintage,
          price: item.price || undefined,
          currency: item.currency || defaultCurrency,
          priceSetAt,
          bottleSize: normalizeBottleSize(item.bottleSize) || DEFAULT_SIZE,
          purchaseDate: item.purchaseDate || undefined,
          purchaseLocation: stripHtml(item.purchaseLocation),
          location: stripHtml(item.location),
          notes: stripHtml(item.notes) || importNotes || undefined,
          occasion: (stripHtml(item.occasion) || '').slice(0, 500) || importOccasion || undefined,
          rating: resolvedRating,
          ratingScale: resolvedScale,
          drinkFrom,
          drinkTo
        });

        // Allow backdating
        if (item.dateAdded) bottle.createdAt = new Date(item.dateAdded);

        // Seed the cellar journey like POST /api/bottles does (see the
        // requestWine branch above for the rationale).
        bottle.addedToCellarAt = bottle.createdAt || new Date();
        bottle.cellarHistory = [{ cellar: cellar._id, cellarName: cellar.name, enteredAt: bottle.addedToCellarAt }];

        // Allow adding directly to history
        if (item.addToHistory) {
          const reason = item.consumedReason || 'drank';
          bottle.status = reason;
          bottle.consumedReason = reason;
          bottle.consumedAt = item.consumedAt ? new Date(item.consumedAt) : new Date();
          if (item.consumedNote) bottle.consumedNote = stripHtml(item.consumedNote);
          if (resolvedConsumedRating !== undefined) {
            bottle.consumedRating = resolvedConsumedRating;
            bottle.consumedRatingScale = resolvedConsumedScale;
          }
        }

        await bottle.save();
        created++;
        // Index EVERY created bottle for Meilisearch, consumed history rows
        // included — the History tab searches/filters via Meili, so leaving
        // them out made imported consumed bottles unsearchable (grand-audit H3).
        createdBottleIds.push(bottle._id);
        if (item.addToHistory) {
          createdHistory++;
        } else {
          createdActive++;
        }

        // Queue rack placement — actual slot assignment runs per-rack after
        // the bottle loop so multiple bottles claiming the same slot can
        // overflow into adjacent free slots instead of being silently dropped.
        const hasPlacement = item.rackName && (item.rackPosition || (item.row && item.col));
        if (hasPlacement && bottle.status === 'active' && !rackConfigs[String(item.rackName)]?.skip) {
          pendingPlacements.push({ rackName: String(item.rackName), item, bottleId: bottle._id, sourceIndex: i });
        }

        // Seed the sommelier maturity queue for this wine+vintage (no-op for
        // "Unknown"). Fire-and-forget — best-effort relative to the import.
        ensurePendingVintageProfile(wineDoc._id, canonicalVintage);
      } catch (err) {
        errors.push({ index: i, reason: err.message });
      }
    }

    // Bulk-index created bottles in Meilisearch (fire-and-forget)
    searchService.bulkIndexBottles(createdBottleIds);

    // Per-rack two-pass placement: for each rack referenced in this import,
    // assign each item to its requested slot first (or, for shelf racks, the
    // first slot of the requested shelf), then overflow extras into the
    // nearest empty slot on the same rack.
    let placedCount = 0;
    let overflowedCount = 0;
    const unplacedDetails = []; // [{ sourceIndex, rackName, requestedPosition, reason }]
    if (pendingPlacements.length > 0) {
      // Group by rackName
      const byRack = new Map();
      for (const p of pendingPlacements) {
        if (!byRack.has(p.rackName)) byRack.set(p.rackName, []);
        byRack.get(p.rackName).push(p);
      }

      for (const [rackName, group] of byRack.entries()) {
        try {
          const rack = await Rack.findOne({ cellar: cellarId, name: rackName, deletedAt: null });
          if (!rack) {
            for (const p of group) {
              unplacedDetails.push({ sourceIndex: p.sourceIndex, rackName, requestedPosition: null, reason: 'Rack not found' });
            }
            continue;
          }

          const { placements, unplaced } = placeBottlesInRack(
            {
              type: rack.type,
              rows: rack.rows,
              cols: rack.cols,
              // Pass typeConfig as a plain object — for Mongoose subdocs the
              // .toObject() shape is what the helper expects.
              typeConfig: rack.typeConfig?.toObject ? rack.typeConfig.toObject() : rack.typeConfig,
              slots: rack.slots,
              maxPosition: getMaxPosition(rack),
              disabledPositions: rack.disabledPositions
            },
            group,
            positionAnchor
          );

          for (const pl of placements) {
            rack.slots.push({ position: pl.position, bottle: pl.bottle });
          }
          for (const u of unplaced) {
            unplacedDetails.push({ ...u, rackName });
          }

          // Count placements only AFTER the save succeeds — a swallowed save
          // failure (e.g. VersionError from a concurrent rack edit) used to
          // report bottles as placed that never persisted.
          if (placements.length > 0) {
            try {
              await rack.save();
              for (const pl of placements) {
                placedCount++;
                if (pl.overflowed) overflowedCount++;
              }
            } catch (err) {
              console.error(`Failed to save rack ${rackName} during import:`, err.message);
              for (const pl of placements) {
                const src = group.find(p => String(p.bottleId) === String(pl.bottle));
                unplacedDetails.push({ sourceIndex: src?.sourceIndex ?? null, rackName, requestedPosition: pl.position, reason: `Rack save failed: ${err.message}` });
              }
            }
          }
        } catch (err) {
          console.error(`Failed placement for rack ${rackName}:`, err.message);
          for (const p of group) {
            unplacedDetails.push({ sourceIndex: p.sourceIndex, rackName, requestedPosition: null, reason: err.message });
          }
        }
      }
    }

    logAudit(req, 'bottle.import', { type: 'cellar', id: cellarId }, {
      created,
      createdActive,
      createdHistory,
      wishlistCreated,
      skipped: skipped.length,
      errors: errors.length,
      // WHY rows failed, not just how many (2026-08-21). A real import
      // rejected 15 of 46 rows at 06:05; the user fixed their file and re-ran
      // the 15 six minutes later. The audit recorded the COUNT and threw the
      // reasons away, so afterwards the cause could only be guessed at — four
      // separate prod queries reconstructed which wines were involved and
      // still could not say WHY, because the reason strings this route builds
      // per row were never persisted anywhere.
      //
      // Reasons, not rows: grouped with counts so one line stays readable and
      // no wine name, producer or note enters the audit — a row's identity is
      // the user's data and the audit only needs the failure mode. Capped
      // because a pathological file could otherwise carry hundreds of
      // distinct messages into one document.
      ...(errors.length ? { errorReasons: summariseReasons(errors) } : {}),
      ...(skipped.length ? { skippedReasons: summariseReasons(skipped) } : {}),
      total: items.length,
      racksCreated: createdRacks.length,
      placed: placedCount,
      overflowed: overflowedCount,
      unplaced: unplacedDetails.length,
      // Extends the EXISTING import audit rather than inventing a second
      // action: how many registry rows this import left for curation is part
      // of the same event, and splitting it would break the one-line-per-import
      // reading of the audit stream.
      pendingIdentity: pendingIdentityCount
    });

    res.json({
      created,
      createdActive,
      createdHistory,
      wishlistCreated,
      skipped,
      errors,
      total: items.length,
      racksCreated: createdRacks,
      placed: placedCount,
      overflowed: overflowedCount,
      unplaced: unplacedDetails,
      pendingIdentityCount
    });
  } catch (error) {
    console.error('Import confirm error:', error);
    res.status(500).json({ error: 'Import failed' });
  }
});

// ─── Import Session routes ────────────────────────────────────────────────────
//
// POST   /api/bottles/import/sessions         – create (or replace) draft session
// GET    /api/bottles/import/sessions?cellarId – list draft sessions for a cellar
// GET    /api/bottles/import/sessions/:id      – load session; refreshes 'request' items
// PUT    /api/bottles/import/sessions/:id      – update selections/manualWines
// DELETE /api/bottles/import/sessions/:id      – delete session

/**
 * POST /api/bottles/import/sessions
 *
 * Creates (or replaces) the user's draft session for a cellar.
 * One draft per user+cellar — the old one is deleted before creating the new one
 * so stale sessions don't accumulate.
 */
router.post('/sessions', async (req, res) => {
  try {
    const { cellarId, fileName, detectedFormat, results, selections, manualWines, positionAnchor, rackConfigs, defaultCurrency, importWarnings, detectedEncoding, ctTable, ctTextFallback } = req.body;

    if (!cellarId || !mongoose.Types.ObjectId.isValid(cellarId)) {
      return res.status(400).json({ error: 'Valid cellarId is required' });
    }
    if (!Array.isArray(results) || results.length === 0) {
      return res.status(400).json({ error: 'results array is required' });
    }

    const cellar = await Cellar.findById(cellarId);
    if (!cellar || cellar.deletedAt) {
      return res.status(404).json({ error: 'Cellar not found' });
    }
    const role = getCellarRole(cellar, req.user.id);
    if (!role || role === 'viewer') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Replace any existing draft for this user+cellar
    await ImportSession.deleteMany({ cellar: cellarId, user: req.user.id, status: 'draft' });

    const session = new ImportSession({
      cellar: cellarId,
      user: req.user.id,
      fileName,
      detectedFormat,
      results,
      selections: selections || {},
      manualWines: manualWines || {},
      positionAnchor: positionAnchor || 'top-left',
      rackConfigs: rackConfigs || {},
      defaultCurrency: defaultCurrency || 'USD',
      importWarnings: Array.isArray(importWarnings) ? importWarnings : [],
      detectedEncoding: detectedEncoding || undefined,
      ctTable: ctTable || undefined,
      ctTextFallback: Array.isArray(ctTextFallback) ? ctTextFallback : []
    });
    await session.save();

    res.status(201).json({ sessionId: session._id });
  } catch (err) {
    console.error('Create import session error:', err);
    res.status(500).json({ error: 'Failed to save session' });
  }
});

/**
 * GET /api/bottles/import/sessions?cellarId=...
 *
 * Lists draft sessions for the authenticated user in a cellar.
 */
router.get('/sessions', async (req, res) => {
  try {
    const { cellarId } = req.query;
    if (!cellarId || !mongoose.Types.ObjectId.isValid(cellarId)) {
      return res.status(400).json({ error: 'Valid cellarId is required' });
    }

    const cellar = await Cellar.findById(cellarId);
    if (!cellar || cellar.deletedAt) {
      return res.status(404).json({ error: 'Cellar not found' });
    }
    if (!getCellarRole(cellar, req.user.id)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const sessions = await ImportSession.find({
      cellar: cellarId,
      user: req.user.id,
      status: 'draft'
    })
      .select('fileName detectedFormat createdAt updatedAt')
      .sort({ updatedAt: -1 })
      .lean();

    res.json({ sessions });
  } catch (err) {
    console.error('List import sessions error:', err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

/**
 * GET /api/bottles/import/sessions/:id
 *
 * Loads a draft session.  For any item whose selection is 'request', re-runs wine
 * matching — if a wine has since been added to the library (e.g. admin resolved the
 * request), the new match is returned in `refreshed` so the frontend can update the
 * selection automatically.
 */
router.get('/sessions/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = await ImportSession.findById(req.params.id).lean();
    if (!session || session.status !== 'draft') {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (session.user.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Re-match items that were marked 'request' to detect wines added since last save
    const refreshed = {}; // { [index]: match object }
    const requestedIndices = Object.entries(session.selections || {})
      .filter(([, sel]) => sel === 'request')
      .map(([idx]) => Number(idx));

    for (const idx of requestedIndices) {
      const result = (session.results || []).find(r => r.index === idx);
      if (!result?.item) continue;
      try {
        const matches = await findWineMatches(result.item, { userId: req.user.id, roles: req.user.roles });
        if (matches.length > 0 && matches[0].score >= EXACT_THRESHOLD) {
          const m = matches[0];
          refreshed[idx] = {
            wineId: m.wine._id,
            name: m.wine.name,
            producer: m.wine.producer,
            country: m.wine.country?.name || null,
            region: m.wine.region?.name || null,
            appellation: m.wine.appellation || null,
            type: m.wine.type,
            score: Math.round(m.score * 100) / 100
          };
        }
      } catch (err) {
        console.error('Failed to re-match import session item (non-fatal):', err.message);
      }
    }

    res.json({ session, refreshed });
  } catch (err) {
    console.error('Load import session error:', err);
    res.status(500).json({ error: 'Failed to load session' });
  }
});

/**
 * PUT /api/bottles/import/sessions/:id
 *
 * Updates selections and/or manualWines for an existing draft session.
 */
router.put('/sessions/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = await ImportSession.findById(req.params.id);
    if (!session || session.status !== 'draft') {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (session.user.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const { results, selections, manualWines, positionAnchor, rackConfigs, defaultCurrency, importWarnings, detectedEncoding, ctTable, ctTextFallback } = req.body;
    // Results change when a per-row AI look-up rewrites a row — persist them
    // so a resumed session doesn't show stale "No match found" rows whose
    // selection references a wine absent from the stored matches.
    if (Array.isArray(results)) session.results = results;
    if (selections !== undefined) session.selections = selections;
    if (manualWines !== undefined) session.manualWines = manualWines;
    if (positionAnchor !== undefined) session.positionAnchor = positionAnchor;
    if (rackConfigs !== undefined) session.rackConfigs = rackConfigs;
    if (defaultCurrency !== undefined) session.defaultCurrency = defaultCurrency;
    // Parse-time notices/metadata — persisted so the ct-truncated banner (and
    // the encoding/table/fallback notes) survive a resume.
    if (importWarnings !== undefined) session.importWarnings = importWarnings;
    if (detectedEncoding !== undefined) session.detectedEncoding = detectedEncoding;
    if (ctTable !== undefined) session.ctTable = ctTable;
    if (ctTextFallback !== undefined) session.ctTextFallback = ctTextFallback;
    await session.save();

    res.json({ ok: true });
  } catch (err) {
    console.error('Update import session error:', err);
    res.status(500).json({ error: 'Failed to update session' });
  }
});

/**
 * DELETE /api/bottles/import/sessions/:id
 *
 * Deletes a session (called after a successful import).
 */
router.delete('/sessions/:id', async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = await ImportSession.findById(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.user.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await session.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete import session error:', err);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

module.exports = router;
// Exported for its own unit test: this function decides what geography enters
// the SHARED registry from an import, and the rule it encodes (file beats AI,
// and the confidence floor never touches the file) is worth pinning
// independently of the 700-line /validate route around it.
module.exports.buildProposedWine = buildProposedWine;
module.exports.summariseReasons = summariseReasons;
