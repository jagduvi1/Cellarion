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
const { generateWineKey, pendingProducerKey, pendingWineKey, normalizeString, normalizeAppellation, normalizeAppellationKey, stripTrailingVintage, resolveGrapeName, resolveCountryName, isRecognizedCountry, isUnknownName, isIdentitySentinel, isImplausibleIdentity, isJunkGrapeName, sanitizeTaxonomyName } = require('../utils/normalize');
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

// ── Pending identity ─────────────────────────────────────────────────────────
//
// The pending key namespace (PENDING_KEY_PREFIX / pendingProducerKey /
// pendingWineKey) now lives in utils/normalize.js, beside generateWineKey — the
// curation queue (services/pendingWineOps) has to build the same key and must
// not drag this module's dependency tree along to do it. Re-exported below, so
// existing importers are unchanged.

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
 *   { wine: null, noMatch: true } instead of minting a WineDefinition + taxonomy.
 *   Consumers: the registry-safe ephemeral-demo clone (so a throwaway account can't pollute
 *   the shared registry), POST /api/wines/identify-text, the MCP resolve_wine tool, and —
 *   since the UI went mint-at-commit — POST /api/wines/find-or-create, which resolves in
 *   step 1 of the add flows and leaves creation to the bottle/wishlist commit
 *   (services/wineCommit).
 *   ⚠️ Do NOT combine with confirmCreate outside the demo clone. The soft-zone candidate
 *   return sits ABOVE the matchOnly gate, so confirmCreate collapses every 0.85–0.95
 *   near-match into noMatch — for identify-text that would hide exactly the existing wines
 *   the user should have picked, which is the duplication the read-only change exists to stop.
 *   ⚠️ Not throw-free: the .trim() on name/producer runs before any option is consulted, so
 *   callers passing model output must normalize types first (identify-text does).
 * @param {boolean} [opts.allowPending=false] - COMMIT paths only. When the identity is
 *   incomplete — producer missing, a sentinel ("Unknown", "N/A", "-"), unusable, or a
 *   geography typed into the producer box — mint a pendingIdentity row instead of throwing
 *   400, so the user's bottle SAVES and a curator completes the wine later. Passed by
 *   services/wineCommit (bottle + wishlist + MCP add), routes/import.js /confirm and
 *   services/cellarImport. NEVER passed by the deliberate shared-registry curation
 *   surfaces (routes/admin/wines.js, routes/admin/wineRequests.js, MCP
 *   admin_add_registry_wine): a curator typing "Bordeaux" as producer SHOULD be told.
 */
async function findOrCreateWine({ name, producer, country, region, appellation, type, grapes }, userId, { confirmCreate = false, skipSiblingMatch = false, matchOnly = false, createdVia = null, allowPending = false } = {}) {
  // Internal whitespace collapses too, not just the ends: a double space is
  // invisible in every UI and every normalized key, so "Wrights  Estate" and
  // "Wrights Estate" would otherwise coexist as two display spellings forever
  // (found by the unify script's first prod-data dry run).
  let trimmedName = name.trim().replace(/\s+/g, ' ').slice(0, MAX_FIELD);
  // A sentinel producer is MISSING information, not a producer — storing
  // "Unknown" would put it in the shared registry for everyone else's wines to
  // match against (prod grew a producer literally named "Unknown" that way).
  // Only consulted when the caller allows pending: without it the `.trim()`
  // below keeps its exact historical behaviour, including on non-strings.
  let producerMissing = allowPending && isIdentitySentinel(producer);
  let trimmedProducer = producerMissing
    ? ''
    : producer.trim().replace(/\s+/g, ' ').slice(0, MAX_FIELD);
  // Canonicalize the appellation (strip a trailing DOCG/DOC/AOC/… tier) so
  // "Barolo" and "Barolo DOCG" resolve to / create ONE registry appellation
  // instead of two (ticket #2C). The tier belongs in classification.
  // Then adopt the curated spelling when the Appellation taxonomy knows this
  // one (strategy R2) — BEFORE key generation, so a synonym ("Chateauneuf du
  // Pape") produces the same normalizedKey as the canonical form and the
  // exact-match stage collapses them instead of minting a sibling.
  let trimmedAppellation = await resolveCanonicalAppellation(
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

  // Pending-identity ISOLATION. A pending row is invisible to everyone but its
  // creator and curation, and that has to hold in the RESOLVER too — otherwise
  // user B's add silently attaches to user A's half-identified wine and the
  // registry quietly merges two strangers' records. Every match stage below is
  // gated on this predicate; the SAME creator still matches their own pending
  // row, which is what makes a retry (or a second bottle of the same wine)
  // resolve instead of minting again.
  const pendingBlocked = (candidate) =>
    !!candidate && candidate.pendingIdentity === true && String(candidate.createdBy) !== String(userId);

  // 1. Exact match by normalizedKey
  const normalizedKey = producerMissing
    ? pendingWineKey(trimmedName, userId, trimmedAppellation)
    : generateWineKey(trimmedName, trimmedProducer, trimmedAppellation);
  let wine = await WineDefinition.findOne({ normalizedKey }).populate(POPULATE);
  if (wine && !pendingBlocked(wine)) return { wine, created: false };

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
  // canonicalKey carries NO pending marker (it is computed by the model hook,
  // which cannot know the caller): a producerless row keys ':name:app'. That is
  // harmless because it is non-unique — but it does mean another creator's
  // pending row can land here, so the isolation gate is load-bearing, not
  // defensive. Filtered BEFORE the length check so a blocked row doesn't make a
  // real single hit look ambiguous.
  const canonicalHits = (await WineDefinition.find({ canonicalKey })
    .limit(2)
    .populate(POPULATE)).filter((c) => !pendingBlocked(c));
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
  // haven't run the backfill. Convergence is NOT organic beyond that: the
  // pre-validate hook rekeys a row only when name/producer/appellation change,
  // so after any change to key DERIVATION (e.g. the 2026-08-10 Saint fold /
  // year strip) stored keys stay stale until backfill-canonical-key.js --apply
  // is rerun — until then new-style lookups can only MISS old rows, never
  // mis-match them (folded query keys are a strict subset of fold-class
  // spellings; audit 2026-08-10).
  if (!skipSiblingMatch) {
    // Same isolation gate as the two stages above — a sibling scan on a
    // producerless query keys ':name:' and would otherwise sweep in every other
    // creator's producerless row of the same name.
    const canonicalSiblings = (await WineDefinition.find({
      canonicalKey: new RegExp(`^${escapeRegex(canonicalSiblingPrefix(trimmedName, trimmedProducer))}`),
    })
      .limit(2)
      .populate(POPULATE)).filter((c) => !pendingBlocked(c));
    if (canonicalSiblings.length === 1 && !conflictsCountry(canonicalSiblings[0])) {
      return { wine: canonicalSiblings[0], created: false };
    }
    if (canonicalSiblings.length === 0) {
      const siblingPrefix = producerMissing
        ? `${pendingProducerKey(userId)}:${normalizeString(trimmedName)}:`
        : `${normalizeString(trimmedProducer)}:${normalizeString(trimmedName)}:`;
      const siblings = (await WineDefinition.find({ normalizedKey: new RegExp(`^${escapeRegex(siblingPrefix)}`) })
        .limit(2)
        .populate(POPULATE)).filter((c) => !pendingBlocked(c));
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

  // Pending rows are not in Meilisearch at all, but the MongoDB $text fallback
  // above reads the collection directly — drop them here so neither the
  // auto-match nor the soft-zone "did you mean?" list can ever show a stranger
  // one (the soft zone would leak the row's existence even without linking it).
  candidates = candidates.filter((c) => !pendingBlocked(c));

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
  //
  // With allowPending each of these gates has a SECOND outcome: instead of
  // 400-ing away the user's bottle, the wine mints pendingIdentity and a
  // curator finishes it. Without allowPending the gates throw exactly as they
  // always have, byte-identical messages included — the deliberate
  // shared-registry curation surfaces must keep being told.
  let producerNorm = normalizeString(trimmedProducer);
  // KNOWN LIMIT — a NON-LATIN producer ("Мукузани", "獺祭", "ქართული ღვინო")
  // reaches this gate with producerNorm === '' and is therefore filed pending,
  // even though isIdentitySentinel now correctly says it is real information
  // (security audit H-4). That is deliberate for now, not an oversight: the
  // registry's normalizedKey is `normalizeString(producer):…`, so STORING such
  // a producer would key it as `:<name>:<appellation>` — indistinguishable from
  // every other non-Latin producer of a same-named wine, and the E11000
  // recovery below would then silently attach one user's wine to another's.
  // The pending namespace is per-creator and has no such collision. Promotion
  // works correctly (the model hook consults isIdentitySentinel alone), so a
  // curator CAN complete these rows; storing the original at mint needs a
  // script-aware key namespace, which is a registry-wide change.
  if (!producerMissing && producerNorm.length < 2) {
    if (!allowPending) {
      const err = new Error(`"${trimmedProducer}" is not a usable producer name`);
      err.status = 400;
      throw err;
    }
    // A producer that normalizes to nothing carries no information — the same
    // state as an absent one. Never stored.
    producerMissing = true;
    trimmedProducer = '';
    producerNorm = '';
  }
  if (!producerMissing) {
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
      if (!allowPending) {
        const err = new Error(
          `"${trimmedProducer}" is a wine region, not a producer — put the actual winery in the producer field`
        );
        err.status = 400;
        throw err;
      }
      // The user did not invent data — they put a real place in the wrong box.
      // MOVE it to the box it belongs in when that one is empty (the commonest
      // shape by far: an import column mapped one field left), otherwise just
      // drop it. Either way the producer is now missing → pending.
      const misplaced = trimmedProducer;
      if (placeCountry) {
        if (!(typeof country === 'string' && country.trim()) || isUnknownName(country)) country = misplaced;
      } else if (placeRegion) {
        if (!(typeof region === 'string' && region.trim()) || isUnknownName(region)) region = misplaced;
      } else if (!trimmedAppellation) {
        // Same canonicalisation the appellation field got at the top, so the
        // moved value keys identically to a typed one.
        trimmedAppellation = await resolveCanonicalAppellation(
          normalizeAppellation(misplaced).slice(0, MAX_FIELD)
        );
      }
      producerMissing = true;
      trimmedProducer = '';
      producerNorm = '';
    }
  }

  // Producer SHAPE gate — the same predicate the auto-promote hook uses
  // (utils/normalize.isImplausibleIdentity), so mint, promote and curation
  // share ONE definition, with the same two outcomes as the gates above:
  // pending for commit paths, a 400 for the deliberate curation surfaces.
  //
  // DELIBERATELY ALMOST EMPTY. It used to also refuse producer == name and
  // house-word-stripped containment, which condemned Château Margaux, Petrus,
  // Krug, Domaine de la Romanée-Conti / "Romanée-Conti" and 64 other real
  // wines — see the predicate's own comment. What survives here is the
  // all-house-words producer ("Domaine", "The Wine Estate"); the sub-2-char
  // case is already refused by the length gate above with its own message.
  // The echo is now a cross-field FLAG (producer-echoes-name.v1), reviewed by a
  // human with the label in front of them, never a refusal.
  if (!producerMissing && isImplausibleIdentity(trimmedProducer, trimmedName)) {
    if (!allowPending) {
      const err = new Error(
        `"${trimmedProducer}" is not a usable producer name — it is only house words (Domaine, Casa, Estate) with no winery attached to them`
      );
      err.status = 400;
      throw err;
    }
    producerMissing = true;
    trimmedProducer = '';
    producerNorm = '';
  }

  // CROSS-FIELD producer gate — the mint-time half of what the curation queue
  // already refuses (services/pendingWineOps.applyPendingFix), running the SAME
  // six rules the same DB-backed way
  // (utils/crossFieldChecks.IDENTITY_BLOCKING_CROSS_FIELD_CHECK_IDS).
  //
  // WHY, when the place gate above already asks three of these questions: prod
  // 2026-08-13 minted an ordinary, published registry wine from producer "Pays
  // d'Oc Organic Wine" / name "Chardonnay Reserve". The extraction was wrong but
  // COMPLETE-LOOKING, so nothing here had anything to complain about — a missing
  // producer is caught, a nonsense one was not. The rules close that: they read
  // the taxonomy's SYNONYMS as well as its canonical names (the place gate reads
  // only normalizedName), and they add the three shapes mint time never asked
  // about at all — a grape, a style term ("Roșu Demidulce"), and the multi-word
  // placeholders ("Domaine unknown") that isIdentitySentinel does not cover.
  //
  // ONE evaluation, on the CREATE path only: every resolve stage returns above
  // this line, so an add that matches an existing wine pays nothing. The
  // evaluation reads the four taxonomy collections (services/crossFieldScan
  // .loadContext) — the same cost the queue pays per fix, and a mint is rare.
  //
  // Same two outcomes as every gate above it: pending for the commit paths, an
  // untouched 400 for the deliberate curation surfaces.
  let producerRejected = null;
  if (!producerMissing) {
    // Lazy require, mirroring pendingWineOps' call site: the scan service pulls
    // the whole taxonomy + registry model tree, and this module is required at
    // boot by every write path.
    const { detectBlockingProducerIssue } = require('./crossFieldScan');
    const blocking = await detectBlockingProducerIssue({
      name: trimmedName,
      producer: trimmedProducer,
      appellation: trimmedAppellation,
    });
    if (blocking) {
      if (!allowPending) {
        const err = new Error(
          `"${trimmedProducer}" is not a usable producer name — cross-field rule ${blocking.check} ` +
          `matched "${blocking.detail}", which belongs in a different field`
        );
        err.status = 400;
        throw err;
      }
      // Never STORED, exactly like every other unusable producer on this path:
      // the row keys into the pending namespace with producer '' and a curator
      // writes the real one from the label photo. The string itself is handed
      // BACK to the caller so it survives in the audit log (services/wineCommit
      // puts it on the wine.create entry) — the pending queue has no field for
      // a rejected value, and losing it entirely would leave a curator with one
      // less clue than the user had.
      producerRejected = { producer: trimmedProducer, check: blocking.check, detail: String(blocking.detail) };
      producerMissing = true;
      trimmedProducer = '';
      producerNorm = '';
    }
  }

  // Resolve the country FIRST: the spelling stage below fences its wider
  // (decoration-variant) adoption by country, so the id has to exist before
  // the producer string is settled. Creating the Country doc marginally
  // earlier is harmless — the same request would create it either way.
  const countryDoc = await findOrCreateCountry(country, userId);
  if (!countryDoc) {
    const err = new Error('Country is required to create a wine');
    err.status = 400;
    throw err;
  }

  // Adopt the registry's spelling for this producer — accent/case/punctuation
  // variants ("Cave de Ribeauville" → "Cave de Ribeauvillé") and, same
  // country only, decoration variants ("Philipp Kuhn" → "Weingut Philipp
  // Kuhn"; the 130-cluster class the 2026-08-14 consolidation cleaned up).
  // SILENT and fail-open by contract: on any ambiguity the typed spelling is
  // kept and the add proceeds — this stage can only ever change what string
  // is stored, never whether the bottle saves.
  const producerToStore = producerMissing
    ? ''
    : await resolveCanonicalProducerSpelling(trimmedProducer, producerNorm, { countryId: countryDoc._id });

  // The key may have moved since step 1: a geography-as-producer MOVE changes
  // both the producer segment (→ pending) and possibly the appellation one —
  // and a DECORATION adoption above changes the producer segment too
  // ("philipp kuhn:…" → "weingut philipp kuhn:…"), unlike the same-string
  // stage, which is fold-invariant. Recompute from the string actually being
  // stored, so the row lands under the key a repeat submission will look it
  // up by (and so the E11000 recovery below re-queries the right one).
  const mintKey = producerMissing
    ? pendingWineKey(trimmedName, userId, trimmedAppellation)
    : generateWineKey(trimmedName, producerToStore, trimmedAppellation);

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
    normalizedKey: mintKey,
    createdBy: userId,
    // Surface provenance ('mcp' = minted by a connected AI) — reviewable as a
    // class by admins; see WineDefinition.createdVia.
    createdVia,
    // Hidden from everyone but its creator and curation until a somm completes
    // the identity (models/WineDefinition.pendingIdentity). The model's
    // pre-validate hook promotes it automatically once producer + name are both
    // real, so nothing has to remember to clear this.
    pendingIdentity: producerMissing,
  });

  try {
    await newWine.save();
  } catch (err) {
    if (err.code === 11000) {
      // Race condition: another request created the same wine concurrently
      wine = await WineDefinition.findOne({ normalizedKey: mintKey }).populate(POPULATE);
      // A raced row that is someone ELSE's pending wine must not be handed
      // over (the pending key namespace makes this unreachable — the creator id
      // is in the key — but the caller's 409-and-retry is the right answer if
      // it ever became reachable, not a silent cross-user attach).
      if (pendingBlocked(wine)) return { wine: null, created: false };
      return { wine, created: false };
    }
    throw err;
  }

  await newWine.populate(POPULATE);

  // Sync to Meilisearch (fire-and-forget). Called unconditionally, exactly like
  // the nonWine quarantine: indexWine owns index MEMBERSHIP and removes a
  // hidden row rather than adding it, so a later promotion re-adding the row is
  // the same one call.
  searchService.indexWine(newWine._id);

  const created = { wine: newWine, created: true };
  if (nearMiss) created.nearMiss = nearMiss;
  if (producerMissing) created.pendingIdentity = true;
  // The producer string the cross-field rules refused, for the caller's audit
  // entry. Only ever set on a create, and only when a rule actually fired.
  if (producerRejected) created.producerRejected = producerRejected;
  return created;
}

module.exports = {
  findOrCreateWine,
  findOrCreateCountry,
  findOrCreateRegion,
  findOrCreateGrapes,
  pendingProducerKey,
  pendingWineKey,
};
