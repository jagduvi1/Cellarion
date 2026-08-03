/**
 * findOrCreateWine service
 *
 * Resolves a wine definition from AI-extracted label data:
 *   0. Canonicalize the name — strip a redundant producer prefix
 *      ("Amisfield Pinot Noir" / "Amisfield" → "Pinot Noir")
 *   1. Exact match by normalizedKey (producer:name:appellation)
 *   1b. Unique producer+name sibling match (appellation-agnostic)
 *   2. Fuzzy similarity search using Meilisearch + scoring
 *   3. If no match above threshold: create wine + any missing taxonomy records
 *
 * Taxonomy helpers (findOrCreateCountry, findOrCreateRegion, findOrCreateGrapes)
 * use find-by-normalizedName before inserting to prevent duplicates.
 */

const WineDefinition = require('../models/WineDefinition');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const Appellation = require('../models/Appellation');
const searchService = require('./search');
const { generateWineKey, normalizeString, normalizeAppellation, normalizeAppellationKey, stripTrailingVintage, resolveGrapeName, resolveCountryName, isRecognizedCountry, isUnknownName, isJunkGrapeName } = require('../utils/normalize');
const { scoreAllMatches } = require('./wineMatching');
const { canonicalizeWineName } = require('../utils/producerPrefix');
const { computeCanonicalKey, canonicalSiblingPrefix } = require('../utils/wineIdentity');
const { buildSurfaceForms, inferGrapeIds } = require('./grapeInference');
const { resolveCanonicalProducerSpelling } = require('./producerSpelling');
const { resolveCanonicalAppellation } = require('./appellationResolve');
const { escapeRegex } = require('../utils/sanitize');

// Auto-match when combined score >= SIMILARITY_THRESHOLD (near-identical — e.g.
// token-order or punctuation differences the exact normalizedKey match missed).
// In the SOFT_ZONE_MIN..SIMILARITY_THRESHOLD band, surface candidates to the
// user ("did you mean one of these?") instead of silently creating a new wine.
// Below SOFT_ZONE_MIN the wines aren't close enough to be worth asking, so we
// just create. The soft-zone floor is deliberately high: a "did you mean?"
// prompt for a loose match (e.g. a Brut vs a Blanc de Blancs at ~50%) is noise.
const SIMILARITY_THRESHOLD = 0.95;
const SOFT_ZONE_MIN = 0.85;
const SOFT_ZONE_TOP_N = 5;
const POPULATE = ['country', 'region', 'grapes'];

// ── Taxonomy helpers ─────────────────────────────────────────────────────────

async function findOrCreateCountry(name, userId) {
  // "Unknown"/placeholder → null, never a Country doc named "Unknown". The
  // caller treats a null country as a 400 — honest, since country is required.
  if (isUnknownName(name)) return null;
  // Resolve alias → canonical name before lookup (e.g. "USA" → "United States",
  // "Tyskland" → "Germany") so localized/abbreviated AI output can't mint a
  // duplicate Country — mirrors the resolveGrapeName pattern below.
  const canonicalName = resolveCountryName(name);
  const normalizedName = normalizeString(canonicalName);
  let country = await Country.findOne({ normalizedName });
  if (country) return country;
  // Mint gate (support ticket 2026-07-26): a garbled label scan produced the
  // country "Espalda" (a misread "España") and this function happily created
  // it — any user's add could pollute the shared taxonomy. Only a recognized
  // real-world country may be minted; everything else is rejected loudly so
  // the caller can correct it, instead of silently growing a junk Country the
  // whole registry then trusts. Existing docs (matched above) are unaffected.
  if (!isRecognizedCountry(canonicalName)) {
    const err = new Error(
      `Unrecognized country "${String(name).trim().slice(0, 80)}" — use the country's English name (e.g. "Spain")`
    );
    err.status = 400;
    throw err;
  }
  country = new Country({ name: canonicalName.trim(), normalizedName, createdBy: userId });
  await country.save();
  return country;
}

// Cap stored/compared field lengths at this single create chokepoint (covers
// the find-or-create route, CSV import, cellar-format import and label-scan).
// This bounds both the fuzzy-match cost and the persisted document size WITHOUT
// a schema maxlength validator — a validator re-runs on every .save() (full-
// document validation) and would make legacy rows that predate the cap
// un-editable. Module scope, not function scope: the taxonomy helpers below are
// called from the import paths too and need the same bound.
const MAX_FIELD = 200;

// Mirrors the route's cap so the import callers, which have none, get it too.
const MAX_GRAPES = 20;

/**
 * Bound a taxonomy name before it can be minted.
 *
 * The route caps `region` and grape names, but the two import callers
 * (services/cellarImport.js and routes/import.js) hand them straight through
 * from an uploaded file or a model response — so the cap has to live here, at
 * the chokepoint, not at one of three entrances.
 *
 * Interior whitespace collapses for the same reason `name`/`producer` collapse
 * it: two spellings that differ by a space are one wine to a human and two rows
 * to the registry. Newlines matter more than cosmetics here — these values are
 * substituted into the enrichment prompt, and a multi-line region name is how
 * you smuggle instructions into it.
 */
function sanitizeTaxonomyName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD);
}

async function findOrCreateRegion(rawName, countryId, userId) {
  const name = sanitizeTaxonomyName(rawName);
  // "Unknown"/placeholder → null region (the schema's representation of unknown)
  if (!name || isUnknownName(name) || !countryId) return null;
  const normalizedName = normalizeString(name);
  // Match the canonical name OR a per-document synonym ("Piemonte" finds the
  // Piedmont doc) — same design as the Grape lookup below, so a merged
  // duplicate region can't be re-minted by the next label scan.
  let region = await Region.findOne({
    country: countryId,
    $or: [{ normalizedName }, { normalizedSynonyms: normalizedName }],
  });
  if (region) return region;
  // Mint gates (registry audit 2026-07-26 RC-8). A comma means the caller
  // packed a hierarchy into one string ("Bordeaux, Haut-Médoc", "Niagara
  // Peninsula, Ontario") — never a region name; and a region that IS a
  // recognized country name belongs in the country field, not here (prod grew
  // region "Scotland" under country "England"). A null region is the honest
  // state — the schema allows it, and an admin can add real taxonomy
  // deliberately. (Cost: a US wine can't auto-mint a "Georgia" region — the
  // one state that collides with a country name; an existing doc still
  // matches above.)
  if (String(name).includes(',') || isRecognizedCountry(name)) return null;
  // pendingReview: a user write minted taxonomy — visible to admins (R3),
  // never blocking the user.
  region = new Region({ name: name.trim(), normalizedName, country: countryId, createdBy: userId, pendingReview: true });
  await region.save();
  return region;
}

async function findOrCreateGrapes(rawNames, userId) {
  if (!Array.isArray(rawNames) || rawNames.length === 0) return [];
  // Same chokepoint argument as findOrCreateRegion: the route caps the count and
  // each name, the import callers cap neither. Non-strings are dropped rather
  // than coerced — one reaching isJunkGrapeName's .trim() is a 500.
  const names = rawNames.map(sanitizeTaxonomyName).filter(Boolean).slice(0, MAX_GRAPES);
  const ids = [];
  const seen = new Set(); // deduplicate within the same call (e.g. AI returns "Shiraz" + "Syrah")
  for (const name of names) {
    // Placeholders and descriptions-instead-of-varietals ("unknown", "blend -
    // specific varieties unknown") are dropped — a blend is represented by its
    // actual varieties or an empty array, never a junk Grape document.
    if (isJunkGrapeName(name)) continue;
    // Resolve synonym → canonical name before lookup (e.g. "Shiraz" → "Syrah")
    const canonicalName = resolveGrapeName(name);
    const normalizedName = normalizeString(canonicalName);
    if (!normalizedName) continue; // e.g. a bare percentage stripped to ''
    if (seen.has(normalizedName)) continue; // skip intra-call duplicates
    seen.add(normalizedName);
    // Match the canonical name OR a per-document synonym ("Tinta Roriz" finds
    // the Tempranillo doc when the admin lists it as a synonym) — local names
    // resolve to one variety instead of minting a duplicate Grape.
    let grape = await Grape.findOne({
      $or: [{ normalizedName }, { normalizedSynonyms: normalizedName }],
    });
    if (!grape) {
      grape = new Grape({ name: canonicalName, normalizedName, createdBy: userId });
      await grape.save();
    }
    if (!ids.some(id => String(id) === String(grape._id))) ids.push(grape._id); // two synonyms may resolve to one doc

  }
  return ids;
}

// ── Main find-or-create ──────────────────────────────────────────────────────

/**
 * Find an existing WineDefinition or create a new one.
 *
 * Three return shapes:
 *   { wine, created: false }                   — exact or auto-fuzzy match (>= SIMILARITY_THRESHOLD)
 *   { wine: null, candidates: [...] }          — soft zone: similar wines exist but not enough to auto-match.
 *                                                Caller (UI) should show a "did you mean?" prompt.
 *   { wine, created: true }                    — no match, new wine created
 *
 * Pass `confirmCreate: true` to bypass the soft-zone gate and force creation
 * — used when the user has explicitly confirmed "no, none of those, make a new one".
 *
 * @param {Object} wineData   - { name, producer, country, region, appellation, type, grapes[] }
 * @param {string} userId     - ObjectId string of the authenticated user (for createdBy)
 * @param {Object} [opts]
 * @param {boolean} [opts.confirmCreate=false] - Skip soft-zone candidate return and create directly
 * @param {boolean} [opts.skipSiblingMatch=false] - Skip step 1b. Pass when the user has
 *   explicitly rejected the suggested matches (find-or-create route with confirmCreate),
 *   so their "create anyway" isn't silently overridden by an appellation-variant sibling.
 * @param {boolean} [opts.matchOnly=false] - Never create. Resolve only to an existing
 *   registry wine (exact/sibling/fuzzy>=threshold); if nothing confident matches, return
 *   { wine: null, noMatch: true } instead of minting a WineDefinition + taxonomy. Two
 *   consumers: the registry-safe ephemeral-demo clone (so a throwaway account can't pollute
 *   the shared registry), and POST /api/wines/identify-text, which reports what the registry
 *   already holds and leaves creation to an explicit user confirmation.
 *   ⚠️ Do NOT combine with confirmCreate outside the demo clone. The soft-zone candidate
 *   return sits ABOVE the matchOnly gate, so confirmCreate collapses every 0.85–0.95
 *   near-match into noMatch — for identify-text that would hide exactly the existing wines
 *   the user should have picked, which is the duplication the read-only change exists to stop.
 *   ⚠️ Not throw-free: the .trim() on name/producer runs before any option is consulted, so
 *   callers passing model output must normalize types first (identify-text does).
 */
async function findOrCreateWine({ name, producer, country, region, appellation, type, grapes }, userId, { confirmCreate = false, skipSiblingMatch = false, matchOnly = false, createdVia = null } = {}) {
  // Internal whitespace collapses too, not just the ends: a double space is
  // invisible in every UI and every normalized key, so "Wrights  Estate" and
  // "Wrights Estate" would otherwise coexist as two display spellings forever
  // (found by the unify script's first prod-data dry run).
  let trimmedName = name.trim().replace(/\s+/g, ' ').slice(0, MAX_FIELD);
  const trimmedProducer = producer.trim().replace(/\s+/g, ' ').slice(0, MAX_FIELD);
  // Canonicalize the appellation (strip a trailing DOCG/DOC/AOC/… tier) so
  // "Barolo" and "Barolo DOCG" resolve to / create ONE registry appellation
  // instead of two (ticket #2C). The tier belongs in classification.
  // Then adopt the curated spelling when the Appellation taxonomy knows this
  // one (strategy R2) — BEFORE key generation, so a synonym ("Chateauneuf du
  // Pape") produces the same normalizedKey as the canonical form and the
  // exact-match stage collapses them instead of minting a sibling.
  const trimmedAppellation = await resolveCanonicalAppellation(
    normalizeAppellation((typeof appellation === 'string' ? appellation.trim() : '')).slice(0, MAX_FIELD)
  );

  // 0. Registry canon: the registry is vintage-neutral — a trailing year on
  // the name ("Reserve Cabernet Sauvignon 2023") belongs on the user's
  // Bottle.vintage, never on the shared wine (audit 2026-07-26: 19 such rows;
  // no write path stripped it). BEFORE the producer strip, so "Pinot Noir
  // Amisfield 2019" sheds the year first and the suffix strip still sees the
  // producer at the tail.
  trimmedName = stripTrailingVintage(trimmedName);

  // Registry canon: a wine's name never embeds its producer. Cellar-format
  // imports and the occasional non-compliant AI response arrive as
  // name "Amisfield Pinot Noir" + producer "Amisfield" — or as a SUFFIX,
  // "Fiano di Avellino Mastroberardino" (the launch-day admin report) —
  // canonicalize BEFORE any matching so that input resolves to (or creates)
  // the producer-free entry instead of minting a producer-in-name duplicate
  // the admin tool has to clean up later. The key-prefix twin also catches
  // producer VARIANTS — name "Felton Road Block 3 Pinot Noir" with producer
  // "Felton Road Wines Ltd" — which the exact-string strip can't see (the
  // shape behind most July-2026 prod duplicates).
  trimmedName = canonicalizeWineName(trimmedName, trimmedProducer);

  // Different-country guard for every non-exact auto-link below: an identical
  // canonical producer+name can still be two wineries (Domaine Chandon, Napa
  // vs Bodegas Chandon, Mendoza — the "Garden Spritz" false positive). When
  // BOTH sides state a country and they disagree, never link silently — fall
  // through so the soft zone (or creation) decides.
  const queryCountryKey = (typeof country === 'string' && country.trim() && !isUnknownName(country))
    ? normalizeString(resolveCountryName(country))
    : '';
  const conflictsCountry = (candidate) => {
    if (!queryCountryKey) return false;
    const candidateCountry = candidate && candidate.country && candidate.country.name
      ? normalizeString(candidate.country.name)
      : '';
    return Boolean(candidateCountry && candidateCountry !== queryCountryKey);
  };

  // 1. Exact match by normalizedKey
  const normalizedKey = generateWineKey(trimmedName, trimmedProducer, trimmedAppellation);
  let wine = await WineDefinition.findOne({ normalizedKey }).populate(POPULATE);
  if (wine) return { wine, created: false };

  // 1a. Canonical-identity match: collapses producer spelling variants,
  // producer-in-name embeds and appellation tiers, so ANY spelling of an
  // already-registered wine lands here before fuzzy scoring ever runs — a
  // canonical duplicate cannot be minted because this lookup finds the
  // original first (dup analysis 2026-07-22, phase 1). ≥2 hits mean the
  // registry ALREADY holds a duplicate cluster for this identity — never pick
  // one arbitrarily; fall through so the soft zone / admin queue handles it.
  // Deliberately not gated on skipSiblingMatch: like the exact key above, an
  // identity-level hit is the same wine (the different-country guard covers
  // the distinct-winery collisions).
  const canonicalKey = computeCanonicalKey(trimmedName, trimmedProducer, trimmedAppellation);
  const canonicalHits = await WineDefinition.find({ canonicalKey })
    .limit(2)
    .populate(POPULATE);
  if (canonicalHits.length === 1 && !conflictsCountry(canonicalHits[0])) {
    return { wine: canonicalHits[0], created: false };
  }

  // 1b. Sibling match: same producer + same canonical name, ANY appellation.
  // Import files and AI output often carry a different appellation granularity
  // than the registry ("Cromwell" vs the registry's "Central Otago") — the
  // full-key match above misses and the fuzzy score lands around 0.90, below
  // the auto-match threshold, so without this step a non-interactive caller
  // (confirmCreate) would mint a near-duplicate. A UNIQUE hit is overwhelmingly
  // the same wine; with several siblings we fall through to the fuzzy scorer so
  // the soft zone can disambiguate instead of picking one arbitrarily.
  // Canonical prefix first (variant-tolerant); the raw normalizedKey prefix is
  // kept as a fallback for rows that predate canonicalKey on instances that
  // haven't run the backfill — they converge organically as docs save.
  if (!skipSiblingMatch) {
    const canonicalSiblings = await WineDefinition.find({
      canonicalKey: new RegExp(`^${escapeRegex(canonicalSiblingPrefix(trimmedName, trimmedProducer))}`),
    })
      .limit(2)
      .populate(POPULATE);
    if (canonicalSiblings.length === 1 && !conflictsCountry(canonicalSiblings[0])) {
      return { wine: canonicalSiblings[0], created: false };
    }
    if (canonicalSiblings.length === 0) {
      const siblingPrefix = `${normalizeString(trimmedProducer)}:${normalizeString(trimmedName)}:`;
      const siblings = await WineDefinition.find({ normalizedKey: new RegExp(`^${escapeRegex(siblingPrefix)}`) })
        .limit(2)
        .populate(POPULATE);
      if (siblings.length === 1 && !conflictsCountry(siblings[0])) {
        return { wine: siblings[0], created: false };
      }
    }
  }

  // 2. Fuzzy similarity search
  const searchQuery = `${trimmedName} ${trimmedProducer}`.trim();
  let candidates = [];

  if (searchService.getIsAvailable()) {
    try {
      const { ids } = await searchService.search(searchQuery, { limit: 20 });
      if (ids.length > 0) {
        candidates = await WineDefinition.find({ _id: { $in: ids } }).populate(POPULATE);
      }
    } catch (err) {
      console.warn('Meilisearch unavailable in findOrCreateWine:', err.message);
    }
  }

  // MongoDB text-search fallback
  if (candidates.length === 0) {
    try {
      candidates = await WineDefinition.find({ $text: { $search: searchQuery } })
        .populate(POPULATE)
        .limit(20);
    } catch {
      // No text-index match — proceed to creation
    }
  }

  // When creation proceeds PAST a soft-zone-level top candidate (confirmCreate
  // callers skip the "did you mean?" gate), report that near-miss back so
  // non-interactive callers (cellar import) can audit-log it for later review.
  let nearMiss = null;

  if (candidates.length > 0) {
    const ranked = scoreAllMatches(
      { name: trimmedName, producer: trimmedProducer, appellation: trimmedAppellation },
      candidates,
      { redistribute: false }
    );

    // Auto-match: best confident hit that doesn't conflict on country. A
    // conflicting >=0.95 candidate falls through to the soft zone below, so
    // the caller/user still sees it — it just never links silently.
    const autoHit = ranked.find(r => r.score >= SIMILARITY_THRESHOLD && !conflictsCountry(r.wine));
    if (autoHit) {
      return { wine: autoHit.wine, created: false };
    }

    // Soft zone: top score is suggestive but not confident. Surface up to N
    // candidates and let the user choose, unless the caller has already
    // confirmed they want to create regardless.
    if (!confirmCreate && ranked[0].score >= SOFT_ZONE_MIN) {
      const softCandidates = ranked
        .filter(r => r.score >= SOFT_ZONE_MIN)
        .slice(0, SOFT_ZONE_TOP_N)
        .map(r => ({ wine: r.wine, score: Math.round(r.score * 100) / 100 }));
      return { wine: null, candidates: softCandidates };
    }

    if (ranked[0].score >= SOFT_ZONE_MIN) {
      nearMiss = {
        wineId: ranked[0].wine._id,
        name: ranked[0].wine.name,
        producer: ranked[0].wine.producer,
        score: Math.round(ranked[0].score * 100) / 100,
      };
    }
  }

  // Match-only callers (the registry-safe demo clone) never create: if no
  // confident match was found above, report no-match so the caller can skip the
  // item instead of minting a WineDefinition + taxonomy per use.
  if (matchOnly) return { wine: null, noMatch: true };

  // 3. Create new wine — producer sanity gate first (registry audit
  // 2026-07-26, RC-2): a producer that IS a place is never right — the LWIN
  // import's comma-split wrote "Bordeaux" / "California" / "Tuscany" into the
  // producer field ~45 times, and every add matching such a string would
  // compound it. Exact normalized full-string match only, so "Marchesi di
  // Barolo" and "La Rioja Alta" pass while bare "Barolo" / "La Rioja" do not.
  // Mint-time only (like the country gate): existing rows keep resolving
  // above until the data cleanup re-points them.
  const producerNorm = normalizeString(trimmedProducer);
  if (producerNorm.length < 2) {
    const err = new Error(`"${trimmedProducer}" is not a usable producer name`);
    err.status = 400;
    throw err;
  }
  const [placeCountry, placeRegion, placeAppellation] = await Promise.all([
    Country.exists({ normalizedName: producerNorm }),
    Region.exists({ $or: [{ normalizedName: producerNorm }, { normalizedSynonyms: producerNorm }] }),
    // Appellation keys fold hyphens to spaces (normalizeAppellationKey) —
    // querying with plain normalizeString would MISS every hyphenated
    // appellation doc ("Châteauneuf-du-Pape") and silently reopen the
    // place-as-producer hole for exactly the places the seed script promotes
    // (audit 2026-07-29 A3). Both keys queried: legacy docs may still carry
    // the old fold until the backfill script has run.
    Appellation.exists({ normalizedName: { $in: [producerNorm, normalizeAppellationKey(trimmedProducer)] } }),
  ]);
  if (placeCountry || placeRegion || placeAppellation) {
    const err = new Error(
      `"${trimmedProducer}" is a wine region, not a producer — put the actual winery in the producer field`
    );
    err.status = 400;
    throw err;
  }

  // Adopt the registry's majority spelling for this producer (accent, case
  // and punctuation variants — "Cave de Ribeauville" → "Cave de Ribeauvillé").
  // Display-only: every derived key (normalizedKey, canonicalKey, slug) folds
  // both spellings identically, which is precisely why nothing upstream of
  // this point needs recomputing and why no key-based net ever caught these.
  const producerToStore = await resolveCanonicalProducerSpelling(trimmedProducer, producerNorm);

  // Resolve taxonomy
  const countryDoc = await findOrCreateCountry(country, userId);
  if (!countryDoc) {
    const err = new Error('Country is required to create a wine');
    err.status = 400;
    throw err;
  }

  const regionDoc = await findOrCreateRegion(region, countryDoc._id, userId);
  let grapeIds = await findOrCreateGrapes(grapes, userId);

  // Ticket #2A: when no grapes were supplied, infer them from the name
  // ("… Pinot Noir" → Pinot Noir) so the wine still counts in the Statistics
  // by-grape breakdown and the grapes= filter. trimmedName already has the
  // producer stripped (step 0). Only tags grapes already in the taxonomy —
  // never mints one — and stays silent when nothing matches.
  if (grapeIds.length === 0) {
    const grapeDocs = await Grape.find({}).select('name normalizedName normalizedSynonyms').lean();
    grapeIds = inferGrapeIds(trimmedName, trimmedAppellation, buildSurfaceForms(grapeDocs));
  }

  const validTypes = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];
  const wineType = validTypes.includes(type) ? type : 'red';

  const newWine = new WineDefinition({
    name: trimmedName,
    producer: producerToStore,
    country: countryDoc._id,
    region: regionDoc?._id || null,
    appellation: trimmedAppellation || null,
    type: wineType,
    grapes: grapeIds,
    normalizedKey,
    createdBy: userId,
    // Surface provenance ('mcp' = minted by a connected AI) — reviewable as a
    // class by admins; see WineDefinition.createdVia.
    createdVia
  });

  try {
    await newWine.save();
  } catch (err) {
    if (err.code === 11000) {
      // Race condition: another request created the same wine concurrently
      wine = await WineDefinition.findOne({ normalizedKey }).populate(POPULATE);
      return { wine, created: false };
    }
    throw err;
  }

  await newWine.populate(POPULATE);

  // Sync to Meilisearch (fire-and-forget)
  searchService.indexWine(newWine._id);

  return nearMiss
    ? { wine: newWine, created: true, nearMiss }
    : { wine: newWine, created: true };
}

module.exports = { findOrCreateWine, findOrCreateCountry, findOrCreateRegion, findOrCreateGrapes };
