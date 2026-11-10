const express = require('express');
const mongoose = require('mongoose');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const aiBurstLimiter = require('../middleware/aiBurstLimiter');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const Grape = require('../models/Grape');
const { getCellarRole } = require('../utils/cellarAccess');
const { logAudit } = require('../services/audit');
const { getOrCreateDailySnapshot } = require('../utils/exchangeRates');
const { resolveRating } = require('../utils/ratingUtils');
const { normalizeString, normalizeWineName, resolveCountryName, isIdentitySentinel } = require('../utils/normalize');
const { normalizeBottleSize, DEFAULT_SIZE } = require('../config/bottleSizes');
const { identifyWineFromText } = require('../services/labelScan');
const aiProvider = require('../services/aiProvider');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const { findVisibleWine } = require('../services/wineVisibility');
const { tryDebitAi, isRefundableFailure } = require('../services/aiBudget');
const rateLimitsConfig = require('../config/rateLimits');
const {
  CONSUMED_STATUSES,
  ORDERED_STATUS,
  IMPORT_EXACT_THRESHOLD,
  MAX_IMPORT_SIZE,
  AI_CONCURRENCY,
} = require('../config/constants');
const { stripHtml, sanitizeGrapeNames } = require('../utils/sanitize');
const { parseAndValidateVintage, parseDrinkYear } = require('../utils/validation');
const { ensurePendingVintageProfile } = require('../utils/vintageProfile');
const { extractAiExplanation } = require('../utils/jsonExtract');
const { sanitizeRackConfigs, VALID_ANCHORS, DEFAULT_ANCHOR } = require('../utils/rackImport');
const { RACK_TYPES } = require('../models/Rack');
// The racks a file names: created before the bottles, filled after them.
const { createImportRacks, placeImportedBottles } = require('../services/importRacks');
const { validatePriceSanity } = require('../utils/priceValidation');
const { computeUserMediansByCurrency } = require('../services/priceWarnings');
const { parseCurrency, currencyOrFallback, isSupportedCurrency } = require('../config/currencies');
const { runConcurrent } = require('../utils/concurrency');
const WineRequest = require('../models/WineRequest');
const { findOrCreatePendingRequest, pickImportHints } = require('../services/wineRequestIntake');
const WishlistItem = require('../models/WishlistItem');
const { parseExpectedArrival } = require('../utils/onOrder');
// Which registry wine a row is, if any: the exact key, a known producer
// split off the name, the scored candidates and the colour gate.
const {
  rowColourConflict, findExactRegistryWine, splitKnownProducerPrefix, findWineMatches,
} = require('../services/importMatching');
// What a row says a wine is: the proposed wine from file and AI, which
// source supplied each field, and the rows that need no AI at all.
const {
  AI_GEOGRAPHY_MIN_CONFIDENCE, buildProposedWine, computeIdentityProvenance, fileCompleteIdentity,
} = require('../services/importIdentity');
// The failure reasons grouped for the audit row, and the archive of the
// file's identity columns.
const { summariseReasons, writeImportArchive } = require('../services/importArchive');

/**
 * A row flagged `onOrder` (a CellarTracker pending purchase, or a receipt the
 * review marked "not delivered yet") becomes a bottle ON ORDER, with its
 * expected month when the row has a usable one. Forgiving like the rest of
 * the import: an unreadable date imports the bottle without one rather than
 * failing the row. Never applied to a row going straight into history.
 */
function applyOnOrder(bottle, item) {
  if (item.onOrder !== true) return;
  bottle.status = ORDERED_STATUS;
  const ea = parseExpectedArrival(item.expectedArrival);
  if (ea.ok && ea.value) bottle.expectedArrival = ea.value;
}

const router = express.Router();
// requireNonDemo: the CT/CSV importer spends AI on identify and creates registry
// wines; a throwaway demo must do neither. Demo users can't bulk-import.
router.use(requireAuth, requireNonDemo);

// Alias for readability (imported from config/constants.js)
const EXACT_THRESHOLD = IMPORT_EXACT_THRESHOLD;

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
    // No role answers like a missing cellar (no existence oracle), as
    // middleware/cellarAccess does; a viewer sees the cellar but cannot import.
    const role = getCellarRole(cellar, req.user.id);
    if (!role) {
      return res.status(404).json({ error: 'Cellar not found' });
    }
    if (role === 'viewer') {
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

    // A row that names the wine but not the producer (a CellarTracker export
    // without a Producer column: "Kim Crawford Pinot Gris" in one cell) is
    // split on a producer the registry already knows BEFORE any lookup, so it
    // joins the cascade as an ordinary row. The client no longer guesses the
    // first word (2026-09-12: 285 wines minted under "Louis", "Kim", "19"…);
    // rows the registry cannot split keep the full display name and go to
    // the model, which is told the producer is embedded in it.
    // Latch a client disconnect as EARLY as possible — before the split
    // probes and the Pass 1a cascade — so a requester that has gone away
    // stops us spending reads and, below, launching (and debiting) AI calls.
    // res 'close' fires when the underlying connection closes; writableEnded
    // distinguishes a premature client disconnect from normal completion.
    // (req 'close' fires on message completion in Node >= 15, so it can't be
    // used for disconnect detection here.)
    let aiBudgetExhausted = false;
    let clientDisconnected = false;
    res.on('close', () => { if (!res.writableEnded) clientDisconnected = true; });

    // ONE probe per distinct display name, not per row (a 2000-row file of
    // the same six wines is six probes), and a sentinel producer ("Unknown",
    // "-") counts as none — the CT mapper already sends '' for it, generic
    // CSV/Vivino rows did not (audit 2026-09-14 M2/L4).
    const splitByName = new Map(); // normalized display name → split result | null
    for (const pr of preResults) {
      if (clientDisconnected) break;
      if (pr.errorMsg || !pr.item.wineName) continue;
      if (pr.item.producer && !isIdentitySentinel(pr.item.producer)) continue;
      if (pr.item.producer) pr.item.producer = ''; // sentinel → genuinely producer-less
      const nameKey = normalizeWineName(pr.item.wineName);
      if (!splitByName.has(nameKey)) splitByName.set(nameKey, await splitKnownProducerPrefix(pr.item.wineName));
      const split = splitByName.get(nameKey);
      if (split) {
        pr.item.producer = split.producer;
        pr.item.wineName = split.wineName;
        // The file never stated this producer: the row may match the registry
        // (a) exactly or (b) fuzzily, but it must not be treated as a
        // complete, file-stated identity and minted without the model (c).
        pr.producerFromRegistry = true;
      }
    }
    const identifyEligible = preResults.filter(pr => !pr.errorMsg && pr.item.wineName);

    // Build unique wine keys — one cascade/AI attempt per unique wine, not per bottle
    const aiKeyMap = new Map(); // normalizedKey -> preResult (representative)
    for (const pr of identifyEligible) {
      const key = `${normalizeWineName(pr.item.wineName)}:${normalizeString(pr.item.producer)}`;
      if (!aiKeyMap.has(key)) aiKeyMap.set(key, pr);
      if (pr.forceAi) aiKeyMap.get(key).forceAi = true; // any row's Look-up button forces the key
    }
    const uniquePrs = [...aiKeyMap.values()];

    // (The client-disconnect latch — clientDisconnected / aiBudgetExhausted —
    // is armed above, before the producer-split probes.)

    // ── Pass 1a: registry-first cascade (zero AI for known wines) ──────────
    // (a) exact normalizedKey match (raw + producer-prefix-stripped variant);
    // (b) existing fuzzy scorer at the exact threshold (>= 0.95) — at that
    //     score the AI path's findOrCreateWine would auto-match the same
    //     registry wine, so skipping AI is outcome-identical;
    // (c) complete-data rows skip AI too (see fileCompleteIdentity): the file
    //     itself becomes the identification and Pass 2 treats it exactly like
    //     an AI answer — matchOnly probe, proposal, the lot;
    // (d) everything else goes to AI exactly as before.
    //
    // Grape-colour lookup for (c)'s type inference — built lazily, once, and
    // only if some row actually lacks a type column.
    let grapeColourOf = null;
    const getGrapeColourOf = async () => {
      if (grapeColourOf) return grapeColourOf;
      const docs = await Grape.find({}).select('name normalizedName normalizedSynonyms color').lean();
      const byKey = new Map();
      for (const g of docs) {
        if (!g.color) continue;
        for (const k of [g.normalizedName, normalizeString(g.name || ''), ...(g.normalizedSynonyms || [])]) {
          if (k) byKey.set(k, g.color);
        }
      }
      grapeColourOf = (grapeName) => byKey.get(normalizeString(String(grapeName || ''))) || null;
      return grapeColourOf;
    };
    for (const pr of uniquePrs) {
      if (clientDisconnected) break; // requester gone — stop the cascade, skip AI entirely
      // A row still without a producer after the registry split runs the
      // cascade too: (a) and (c) need a producer and simply return null, but
      // (b)'s query variants were built for exactly this display-name shape
      // (registry backlog 2026-09-06) and resolve a known wine at >= 0.95
      // with zero AI. Only an unknown wine then reaches the model.
      // forceAi bypasses the cascade only when there is an AI to reach; with
      // no key configured the shared cascade is the best available outcome.
      if (pr.forceAi && aiConfigured) continue;
      // An exact KEY is not an exact WINE when the colours differ: the key
      // carries no colour (rowColourConflict). Such a hit falls through to
      // (b), which offers the same wine with the conflict on the match.
      const exactWine = await findExactRegistryWine(pr.item);
      if (exactWine && !rowColourConflict(pr.item, exactWine)) {
        pr.registryWine = { wine: exactWine, score: 1 };
        continue;
      }
      const matches = await findWineMatches(pr.item, viewer);
      pr.preMatches = matches; // reused by Pass 3 if this row ends up on the fuzzy path
      // styleConflict gate: findOrCreateWine refuses a style-conflicting
      // >=0.95 hit and asks, so without the same gate here the (b) comment's
      // "outcome-identical" claim is false and the import files a Trocken
      // under its Halbtrocken sibling with status 'exact'. A conflicted top
      // match falls through to the AI/fuzzy path, where the user chooses.
      // colourConflict is gated the same way, for the same reason.
      if (matches.length > 0 && matches[0].score >= EXACT_THRESHOLD && !matches[0].styleConflict && !matches[0].colourConflict) {
        pr.registryWine = { wine: matches[0].wine, score: matches[0].score };
        continue;
      }
      // (c) the complete-row bypass. Needs the colour map only when the row
      // has grapes but no type, so the taxonomy read is lazy.
      // The colour map is only consulted when the row has grapes and no type
      // of its own; loading it is one taxonomy read for the whole request.
      const needsColourMap = !pr.item.type
        && Array.isArray(pr.item.grapes) && pr.item.grapes.length > 0;
      // A producer the REGISTRY supplied (splitKnownProducerPrefix) is not a
      // file-stated identity: such a row may match (a)/(b) above, but an
      // unknown wine goes to the model rather than being minted from the
      // guess (audit 2026-09-14 L3).
      const identity = pr.producerFromRegistry ? null : fileCompleteIdentity(
        pr.item,
        needsColourMap ? await getGrapeColourOf() : null
      );
      if (identity) {
        pr.aiIdentified = identity;
        pr.aiBypassed = true;
      }
    }

    // ── Pass 1b: AI fan-out for the remaining unique wines ─────────────────
    // Guarded by (audit M-2): a per-request fan-out cap, the shared per-user
    // daily AI budget + global daily cap (debited per actual Anthropic call,
    // refunded on transport failure), and a client-disconnect check that
    // stops LAUNCHING new calls once the requester has gone away. All three
    // degrade gracefully to the fuzzy path (aiSkipped: true) — never an error.
    // aiIdentified may already be set by the Pass 1a complete-row bypass —
    // those rows have their identification and must not spend a call on it.
    const needAi = aiConfigured ? uniquePrs.filter(pr => !pr.registryWine && !pr.aiIdentified) : [];
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
      const key = `${normalizeWineName(aiRun[j].item.wineName)}:${normalizeString(aiRun[j].item.producer)}`;
      aiByKey.set(key, aiSettled[j]);
    }

    // Attach the shared cascade/AI result to every eligible preResult with
    // that key (duplicates share the representative's outcome, as before).
    for (const pr of identifyEligible) {
      const key = `${normalizeWineName(pr.item.wineName)}:${normalizeString(pr.item.producer)}`;
      const rep = aiKeyMap.get(key);
      // The representative is chosen by name + producer, not colour: a file
      // listing a red and a white under one name shares one representative,
      // so its registry hit is re-checked against THIS row's colour. A row it
      // does not fit leaves here unresolved and is matched on its own below.
      if (rep.registryWine) {
        if (!rowColourConflict(pr.item, rep.registryWine.wine)) pr.registryWine = rep.registryWine;
        continue;
      }
      if (rep.preMatches && !pr.preMatches) pr.preMatches = rep.preMatches;
      if (rep.aiSkipped) { pr.aiSkipped = true; continue; }
      // A representative identified by the FILE (Pass 1a's complete-row
      // bypass) has no aiByKey entry — it never called AI — so before the
      // bypass shipped, `aiIdentified` could only ever arrive through
      // `settled` below and this fan-out was complete. Now it can be set
      // without one, and every duplicate row of that wine was being left
      // with no identity at all: a 6-bottle line minted once and sent the
      // other five to no-match, which is exactly the multi-bottle shape a
      // cellar export is made of. Fails safe (no mis-link), but it defeated
      // the bypass precisely where it saves the most calls.
      if (rep.aiIdentified && !pr.aiIdentified) {
        pr.aiIdentified = rep.aiIdentified;
        if (rep.aiBypassed) pr.aiBypassed = true;
      }
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

    // ── Post-AI hygiene — BEFORE any matching, so the
    // cleaned values feed Pass 2, the client preview, and /confirm alike. ──
    //
    // A) One producer, one country per batch. Rows are identified one at a
    //    time, so an obscure producer can come back with a different guessed
    //    country per row (South Africa on one, Australia on
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
      const key = `${normalizeWineName(pr.aiIdentified.name)}:${normalizeString(pr.aiIdentified.producer)}`;
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
        const aiColourConflict = rowColourConflict(pr.item, pr.aiWine);
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
          aiIdentified: true,
          // findOrCreateWine resolves by key, and the key carries no colour, so
          // the model's red can resolve to the registry's white of that name.
          // Only present when set: an ordinary ai_match keeps its exact shape
          // (pinned by import.validate.aiBudget.test.js).
          ...(aiColourConflict ? { colourConflict: aiColourConflict } : {})
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
          score: Math.round(m.score * 100) / 100,
          styleConflict: m.styleConflict || null,
          colourConflict: rowColourConflict(pr.item, m.wine)
        }));
      } else if (pr.matches.length > 0) {
        // AI failed or unavailable, but fuzzy matching found candidates.
        // A style- or colour-conflicting top match never earns 'exact' — that
        // status tells the user no review is needed, which is precisely wrong
        // for a range sibling or the other colour of a pair (see the
        // findWineMatches annotation). The colour is re-read against THIS row:
        // its matches may be a shared representative's.
        const { matches } = pr;
        if (matches[0].score >= EXACT_THRESHOLD && !matches[0].styleConflict && !rowColourConflict(pr.item, matches[0].wine)) {
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
          score: Math.round(m.score * 100) / 100,
          styleConflict: m.styleConflict || null,
          colourConflict: rowColourConflict(pr.item, m.wine)
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
      // Complete-data rows resolved without spending an AI call (Pass 1a's
      // fileCompleteIdentity) — informational, for transparency and debugging.
      if (pr.aiBypassed) result.aiBypassed = true;
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
      // A currency the app does not know ("kr", "€ EUR") is told here and
      // replaced by the import's default on confirm (audit 2026-10-14).
      const rawCurrency = typeof r.item?.currency === 'string' ? r.item.currency.trim() : '';
      const currency = currencyOrFallback(rawCurrency, 'USD');
      const m = userMedians[currency];
      r.priceWarnings = validatePriceSanity({
        price,
        currency,
        userMedianPrice:  m?.median ?? null,
        userMedianSample: m?.sample ?? 0,
      });
      if (rawCurrency && !isSupportedCurrency(rawCurrency)) {
        r.priceWarnings.push({ code: 'unknownCurrency', severity: 'warning', context: { currency: rawCurrency.slice(0, 20) } });
      }
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
 *   nonWineHint     — true when the file's Type/Category named a spirit; a
 *                     wine this row mints (aiWine) is created non-wine
 *                     flagged. A matched registry wine is never touched.
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

    // Currency to apply when an import item has no Currency column of its
    // own, or one the app does not know. The user's choice on the confirm
    // screen (their profile currency by default): a supported code or an
    // alias of one, as every other write path demands — this used to accept
    // any three letters (audit 2026-10-14). Falls back to USD when unset.
    const defaultCurrencyCheck = parseCurrency(rawDefaultCurrency);
    if (!defaultCurrencyCheck.ok) {
      return res.status(400).json({ error: defaultCurrencyCheck.error });
    }
    const defaultCurrency = defaultCurrencyCheck.value || 'USD';

    // Whole-import comment/occasion: typed once on
    // the confirm screen, they land on every BOTTLE this import creates.
    // Fill-blank only — a row that carries its own note from the file keeps it
    // (imports never overwrite file data). Wishlist rows are deliberately
    // excluded: "bought at the estate sale" describes bottles owned, not wines
    // wanted. Caps mirror the Bottle schema (notes 5000, occasion 500).
    const importNotes = typeof rawImportNotes === 'string' ? stripHtml(rawImportNotes).slice(0, 5000) : '';
    const importOccasion = typeof rawImportOccasion === 'string' ? stripHtml(rawImportOccasion).slice(0, 500) : '';

    // The per-rack configuration the user chose in the review, validated
    // (utils/rackImport).
    const rackConfigs = sanitizeRackConfigs(rawRackConfigs, { positionAnchor, rackTypes: RACK_TYPES });

    // Verify cellar access
    const cellar = await Cellar.findById(cellarId);
    if (!cellar || cellar.deletedAt) {
      return res.status(404).json({ error: 'Cellar not found' });
    }
    // No role answers like a missing cellar (no existence oracle), as
    // middleware/cellarAccess does; a viewer sees the cellar but cannot import.
    const role = getCellarRole(cellar, req.user.id);
    if (!role) {
      return res.status(404).json({ error: 'Cellar not found' });
    }
    if (role === 'viewer') {
      return res.status(403).json({ error: 'Not authorized to import bottles to this cellar' });
    }

    // Ensure exchange rate snapshot exists if any items have prices
    const hasPrice = items.some(i => i.price != null && i.price !== '');
    if (hasPrice) {
      await getOrCreateDailySnapshot().catch(err => console.error('Failed to fetch daily exchange rate snapshot:', err.message));
    }

    // Create the racks the file names that this cellar does not have yet.
    // Before the bottles, so the placement step below finds every rack
    // (services/importRacks).
    const createdRacks = await createImportRacks({ req, cellar, cellarId, items, rackConfigs });

    let created = 0;
    // Split of `created` for the done-screen breakdown: active bottles vs
    // those that were created already-consumed (addToHistory=true), e.g.
    // Oeno-export rows with a Consumed On date.
    let createdActive = 0;
    let createdHistory = 0;
    // Rows imported as bottles ON ORDER (bought, not delivered yet — a
    // CellarTracker pending purchase, a pro-forma or prepayment receipt).
    let createdOnOrder = 0;
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
    // Dedup map: "wineName|producer" -> WineRequest doc created in this batch
    const pendingRequestCache = new Map();
    // Dedup map for AI-proposed NEW wines confirmed at review: an import file
    // routinely repeats the same wine, and each unique one must resolve to ONE
    // registry row per batch. normalizedKey-style key, same as /validate.
    const aiWineCache = new Map();
    // What each confirmed AI proposal resolved to, by row index, for the
    // import archive below: 'created' when findOrCreateWine minted the wine
    // for this row, 'matched' when it found an existing one or the row repeats
    // a wine this batch already resolved; 'request' when the proposal
    // landed in the near-match zone and the bottle was filed under a
    // wine request instead.
    const aiOutcomes = new Map();
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
        // Set when a confirmed AI proposal lands in the near-match zone: the
        // identity the bottle is filed under as a wine request (see below).
        let nearMatchRequest = null;

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
          const aiKey = `${normalizeWineName(ai.name)}:${normalizeString(ai.producer || '')}`;
          let wine = aiWineCache.get(aiKey);
          let outcome = 'matched';
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
            }, req.user.id, {
              createdVia: 'import', allowPending: true,
              provenance: computeIdentityProvenance(item, ai),
              // The file's Type/Category named a spirit: a wine this row
              // mints is born non-wine flagged (see below).
              ...(item.nonWineHint === true ? { nonWine: true } : {}),
            });
            // findOrCreateWine can return { wine: null, candidates } — the soft
            // zone: similar wines exist, none close enough to be this one.
            // Unguarded, `wine._id` threw and took the whole /confirm batch
            // with it (audit L-7). The row used to be skipped as an error,
            // which LOST the bottle — typically a Syrah cuvée sitting next to
            // the Grenache one the same file had just minted.
            // Instead the bottle lands on a pending wine request under the
            // proposal the member confirmed, and a curator links it to one of
            // the near matches or creates the wine — the same path a row the
            // member marked "request" takes. The file's geography wins over
            // the AI's guess as the curator's hints.
            if (!resolved) {
              nearMatchRequest = {
                wineName: ai.name.trim(),
                producer: (str(ai.producer) || '').trim(),
                grapes: ai.grapes,
                hints: pickImportHints({
                  country: item.country || str(ai.country),
                  region: item.region || str(ai.region),
                  appellation: item.appellation || str(ai.appellation),
                  type: item.type || str(ai.type),
                }),
              };
            }
            wine = resolved;
            if (wine) aiWineCache.set(aiKey, wine);
            if (created) {
              outcome = 'created';
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
              // The file's Type/Category named a spirit, whisky, gin, …
              // (frontend utils/importMappers looksNonWine). The row this
              // import just minted carries the flag that
              // POST /admin/wines/:id/non-wine sets: the bottle lands and its
              // owner keeps the wine (services/ownHiddenWines), but it stays
              // out of public search, the maturity queue and embeddings.
              // findOrCreateWine created it flagged, so the one index call the
              // mint makes removes it and nothing is seeded that would need
              // removing; flagging it here instead would race that
              // fire-and-forget call. A hinted row that MATCHED an existing
              // wine is left to a curator: the file's category can be wrong.
              if (item.nonWineHint === true) {
                logAudit(req, 'wine.nonWine', { type: 'wine', id: wine._id },
                  { via: 'import', value: true, name: wine.name, producer: wine.producer || null });
              }
            }
          }
          if (nearMatchRequest) {
            aiOutcomes.set(i, 'request');
          } else {
            aiOutcomes.set(i, outcome);
            // Hand the resolved doc straight to the bottle-creation flow below —
            // item.wineDefinition keeps the wishlist branch working, wineDoc
            // skips the redundant findById re-fetch.
            item.wineDefinition = wine._id;
            wineDoc = wine;
          }
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
          // Audit 2026-09 D02-3: the registry's pendingIdentity visibility
          // rule applies here as everywhere else (services/wineVisibility.js).
          const wishWine = await findVisibleWine(item.wineDefinition, { userId: req.user.id, roles: req.user.roles, noDrafts: true });
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

        if (item.requestWine || nearMatchRequest) {
          // No match — create a pending WineRequest and bottle without wineDefinition.
          // A near-match AI proposal (above) arrives here with its own identity.
          // wineName is REQUIRED, not wineName-or-producer: the old fallback
          // filed the PRODUCER as the wine's name, and one broken export did
          // that 131 times in one import — junk requests no curator can
          // resolve, since many distinct cuvées sit behind one producer
          // string. The frontend mapper now skips nameless rows before they
          // get here; this is the API-side mirror for other clients.
          const requestIdentity = nearMatchRequest || {
            wineName: item.wineName,
            producer: item.producer,
            grapes: item.grapes,
            hints: pickImportHints(item),
          };
          if (!requestIdentity.wineName || !String(requestIdentity.wineName).trim()) {
            errors.push({ index: i, reason: 'A wine name is required to request a wine' });
            continue;
          }

          // One request per user + wine + producer, REUSED across imports
          // (a re-import used to mint a second pending request for every
          // wine still waiting), carrying the file's geography/type as hints
          // for the curator. Import-supplied grape names ride along as
          // suggestions — the admin decides which taxonomy grapes the new
          // wine definition gets (imports never write taxonomy on this path).
          const { wineRequest } = await findOrCreatePendingRequest({
            userId: req.user.id,
            wineName: requestIdentity.wineName,
            producer: requestIdentity.producer,
            suggestedGrapes: sanitizeGrapeNames(requestIdentity.grapes),
            hints: requestIdentity.hints,
            cache: pendingRequestCache,
          });

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
            currency: currencyOrFallback(item.currency, defaultCurrency),
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
          } else {
            applyOnOrder(bottle, item);
          }

          await bottle.save();
          created++;
          if (item.addToHistory) {
            createdHistory++;
          } else if (bottle.status === ORDERED_STATUS) {
            createdOnOrder++;
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
          wineDoc = await findVisibleWine(item.wineDefinition, { userId: req.user.id, roles: req.user.roles });
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
          currency: currencyOrFallback(item.currency, defaultCurrency),
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
        } else {
          applyOnOrder(bottle, item);
        }

        await bottle.save();
        created++;
        if (item.addToHistory) {
          createdHistory++;
        } else if (bottle.status === ORDERED_STATUS) {
          createdOnOrder++;
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
        // Not for a bottle on order: it is queued when it arrives (an en
        // primeur vintage may not be released yet).
        if (bottle.status !== ORDERED_STATUS) ensurePendingVintageProfile(wineDoc._id, canonicalVintage);
      } catch (err) {
        errors.push({ index: i, reason: err.message });
      }
    }

    // Place the bottles in their racks: the slot the file gives, or the
    // nearest free one on the same rack (services/importRacks).
    const { placedCount, overflowedCount, unplacedDetails } = await placeImportedBottles({ cellarId, pendingPlacements, positionAnchor });

    // cellarId as well as id: that is what moves the owner's data version
    // when an editor of a shared cellar imports (services/audit).
    logAudit(req, 'bottle.import', { type: 'cellar', id: cellarId, cellarId: cellar._id }, {
      created,
      createdActive,
      ...(createdOnOrder ? { createdOnOrder } : {}),
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

    // Archive what the file contained, identity columns only, for 30 days.
    // Not awaited and never failing: the import is finished and audited by
    // this point (services/importArchive.writeImportArchive).
    writeImportArchive({
      userId: req.user.id,
      cellarId,
      meta: req.body,
      items,
      // The import client sends a confirmed AI proposal as `aiWine`
      // (utils/importPayload); the loop above recorded what it resolved
      // to ('request' for the near-match zone). One it never resolved (a
      // missing name, a bad vintage) has no wineDefinition: the loop fills
      // that in only on a row it resolved.
      outcomeOf: (item, i) => (item.requestWine ? 'request'
        : (aiOutcomes.get(i)
          || (item.wineDefinition ? 'matched' : (item.aiWine ? 'unresolved' : 'other')))),
      summary: () => ({
        created, createdActive, createdHistory, wishlistCreated,
        ...(createdOnOrder ? { createdOnOrder } : {}),
        skipped: skipped.length, errors: errors.length,
        ...(errors.length ? { errorReasons: summariseReasons(errors) } : {}),
        pendingIdentity: pendingIdentityCount,
      }),
    });

    res.json({
      created,
      createdActive,
      // Only when some rows came in on order — the response shape is otherwise unchanged.
      ...(createdOnOrder ? { createdOnOrder } : {}),
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

// The draft sessions (save a reviewed import, resume it later) have their
// own file; mounted here, after this router's auth.
router.use(require('./importSessions'));

module.exports = router;
// Exported for its own unit test: this function decides what geography enters
// the SHARED registry from an import, and the rule it encodes (file beats AI,
// and the confidence floor never touches the file) is worth pinning
// independently of the 700-line /validate route around it.
module.exports.buildProposedWine = buildProposedWine;
module.exports.summariseReasons = summariseReasons;
// Exported for tests: the provenance rules must be pinnable without standing
// up a full import.
module.exports.computeIdentityProvenance = computeIdentityProvenance;
// Exported for the same reason as buildProposedWine: it is the OTHER rule that
// decides what enters the shared registry, and the two must agree about a
// Prädikat in the appellation column.
module.exports.fileCompleteIdentity = fileCompleteIdentity;
// The candidate finder, for the style-guard test (the guard must read a
// candidate's recorded label sweetness, which only a populated load carries).
module.exports.findWineMatches = findWineMatches;
