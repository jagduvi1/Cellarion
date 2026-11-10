// Import matching: which registry wine an import row is, if any.
//
// One import row is looked up in the registry three ways, cheapest first: the
// exact dedup key (findExactRegistryWine), a known producer split off the
// front of a name that embeds it (splitKnownProducerPrefix), and the scored
// candidate search (findWineMatches). A row that states a colour never links
// to a wine of another colour without the user's choice (rowColourConflict).
//
// Callers: POST /api/bottles/import/validate and the draft-session reads in
// routes/import.js, which re-exports findWineMatches for its test.
//
// This module stays free of Express: `viewer` ({ userId, roles }) is passed in
// for the visibility of half-identified wines.

const WineDefinition = require('../models/WineDefinition');
const Country = require('../models/Country');
const searchService = require('./search');
const { scoreWineMatchVariants, stripProducerPrefix, stripAppellationPrefix, stripProducerBrackets, importQueryVariants } = require('./wineMatching');
const { conflictingStyleTerms } = require('../utils/styleTerms');
const { statedColourConflict } = require('../utils/wineColour');
const { wineVisibilityFilter } = require('./wineVisibility');
const { normalizeString, normalizeWineName, generateWineKey } = require('../utils/normalize');
const { escapeRegex } = require('../utils/sanitize');
const { IMPORT_FUZZY_THRESHOLD } = require('../config/constants');

// Every registry candidate the import compares against is populated the same
// way — the label sweetness term included, so the style guard reads a
// candidate's record and not only its name (utils/styleTerms.styleOf).
const WINE_READ_POPULATE = ['country', 'region', 'grapes', { path: 'labelSweetness', select: 'name band scale regulated -_id' }];
const FUZZY_THRESHOLD = IMPORT_FUZZY_THRESHOLD;

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
    appellation: item.appellation,
    // The region hint lets an appellation-first name ("Douro Old Vines
    // Reserva") shed its prefix when the file names the region, not the
    // appellation (registry backlog 2026-09-06).
    region: item.region
  });
}

/**
 * The colour gate: why this import row cannot be registry wine `wine`, or null.
 *
 * Neither the normalizedKey (`producer:name:appellation`) nor the scorer reads
 * colour, so a producer whose red and white share a name ("Châteauneuf-du-Pape"
 * for both) scores 1.0 either way, and the cascade filed a file's RED rows
 * under the registry's WHITE with status 'exact' — the one status users are
 * told needs no review. Where the row and the wine both state a colour and
 * the two differ, it is the other bottle of the pair. Same contract as
 * styleConflict: never auto-link it, carry the reason on the match, let the
 * user choose. Fails open — an untyped row, a style-typed row (no colour of
 * its own) or a wine of unknown colour is never a conflict.
 */
function rowColourConflict(item, wine) {
  return statedColourConflict(String((item && item.type) || '').trim().toLowerCase(), wine);
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
    .populate(WINE_READ_POPULATE);
  if (rawHit) return rawHit;

  const stripped = stripProducerPrefix(item.wineName, item.producer);
  if (!stripped) return null;
  const strippedKey = generateWineKey(stripped, item.producer, item.appellation);
  if (strippedKey === rawKey) return null; // same key — nothing new to try
  return WineDefinition.findOne({ normalizedKey: strippedKey })
    .populate(WINE_READ_POPULATE);
}

// Longest producer prefix tried against the registry, in tokens. Real
// producer names run to five tokens ("Domaine de la Romanée-Conti", "A.A.
// Badenhorst Family Wines"); six covers the rest without scanning a whole
// display name word by word.
const PRODUCER_PREFIX_MAX_TOKENS = 6;

/**
 * Split a producer-less display name on a producer the REGISTRY already knows.
 *
 * A CellarTracker export without a Producer column carries "Louis Jadot
 * Moulin-à-Vent Château des Jacques" in its Wine column. The client used to
 * guess the first word ("Louis"), which minted 285 wines under one-word
 * producers on 2026-09-12 and cost 121 curator corrections. The registry is
 * the better oracle: the longest leading token run that equals an existing
 * producer (normalizedKey is `<producer>:<name>:<appellation>`, so an
 * anchored prefix on the unique index is one cheap read per length) is the
 * producer, and the rest is the wine's own name. Nothing matches → null, and
 * the row goes to the model with the full display name instead.
 *
 * Pending and draft rows are excluded by construction (their key namespaces
 * start with `pending~` / `draft~`), non-wine records explicitly.
 */
async function splitKnownProducerPrefix(displayName) {
  const tokens = String(displayName || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  for (let n = Math.min(PRODUCER_PREFIX_MAX_TOKENS, tokens.length - 1); n >= 1; n--) {
    const prefixKey = normalizeString(tokens.slice(0, n).join(' '));
    if (!prefixKey) continue;
    const filter = { normalizedKey: new RegExp(`^${escapeRegex(prefixKey)}:`), nonWine: { $ne: true } };
    const hit = await WineDefinition.findOne(filter).select('producer').lean();
    if (!hit || !hit.producer) continue;
    // A ONE-word producer is the shape the 2026-09-12 first-word guess left
    // behind ("Kim", "Louis", "19"), and those junk rows are still in the
    // registry until their purge. A single wine under a one-word producer is
    // not corroboration; two or more is (Hugel, Penfolds, Ridge all qualify).
    // Anything longer than one word is trusted as before (audit 2026-09-14 M1).
    if (n === 1) {
      const siblings = await WineDefinition.countDocuments(filter, { limit: 2 });
      if (siblings < 2) continue;
    }
    return { producer: hit.producer, wineName: tokens.slice(n).join(' ') };
  }
  return null;
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
      // Search with combined producer + name for best fuzzy results — then,
      // if that found nothing worth scoring, with the appellation prefix and
      // the producer's parenthetical removed (registry backlog 2026-09-06: a
      // CellarTracker re-import missed 44 known wines on those two habits).
      const queries = importQueryVariants(item);
      const searchOpts = { limit: 15 };

      // Add country filter if we can resolve it
      if (item.country) {
        const normalizedCountry = normalizeString(item.country);
        const countryDoc = await Country.findOne({ normalizedName: normalizedCountry }).lean();
        if (countryDoc) searchOpts.countryId = countryDoc._id.toString();
      }

      for (const query of queries) {
        const { ids } = await searchService.search(query, searchOpts);
        if (ids.length > 0) {
          // Pending rows are not in the Meili index at all; the clause is here so
          // the gate holds if that ever changes (all three strategies, one rule).
          const wines = await WineDefinition.find({ _id: { $in: ids }, ...visible })
            .populate(WINE_READ_POPULATE)
            .lean();

          for (const wine of wines) {
            const score = scoreCandidate(wine, item);
            if (score >= FUZZY_THRESHOLD) {
              candidates.set(wine._id.toString(), { wine, score });
            }
          }
        }
        if (candidates.size > 0) break;
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
          .populate(WINE_READ_POPULATE)
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
    const normalizedName = normalizeWineName(item.wineName);
    const bareProducer = stripProducerBrackets(item.producer);
    const bareName = stripAppellationPrefix(item.wineName, item.appellation) || stripAppellationPrefix(item.wineName, item.region);

    const keyMatch = {
      $or: [
        { normalizedKey: { $regex: `^${escapeRegex(normalizedProducer)}:` } },
        { normalizedKey: { $regex: `:${escapeRegex(normalizedName)}:` } },
        // The same two lookups on the appellation-stripped name and the
        // bracket-free producer (registry backlog 2026-09-06).
        ...(bareProducer ? [{ normalizedKey: { $regex: `^${escapeRegex(normalizeString(bareProducer))}:` } }] : []),
        ...(bareName ? [{ normalizedKey: { $regex: `:${escapeRegex(bareName)}:` } }] : []),
      ]
    };
    // $and, not a spread: `visible` is itself an $or for non-curators, and two
    // $or keys in one object would silently drop the first.
    const directMatches = await WineDefinition.find(
      visible.$or ? { $and: [keyMatch, visible] } : { ...keyMatch, ...visible }
    )
      .populate(WINE_READ_POPULATE)
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

  // Sort by score descending, return top 5. Each match carries the style
  // verdict (issue #1134 follow-up): where the import row and the candidate
  // NAME a different Prädikat or sweetness they are two wines from one range,
  // and no similarity score may auto-link them — a Trocken/Halbtrocken pair
  // from one vineyard measures 0.9543 through this scorer. Annotated here,
  // at the single place all three consumers get their matches, so the
  // >= EXACT_THRESHOLD gates and the client's preselection read one verdict.
  // colourConflict rides alongside for the same consumers (rowColourConflict).
  const sorted = [...candidates.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((m) => ({
      ...m,
      // The registry wine goes in whole, so its recorded label sweetness
      // counts beside its name (utils/styleTerms.styleOf).
      styleConflict: conflictingStyleTerms({ name: item.wineName }, m.wine),
      colourConflict: rowColourConflict(item, m.wine),
    }));

  return sorted;
}

module.exports = {
  scoreCandidate,
  rowColourConflict,
  findExactRegistryWine,
  splitKnownProducerPrefix,
  findWineMatches,
};
