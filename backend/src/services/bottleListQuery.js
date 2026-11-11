const mongoose = require('mongoose');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const WineDefinition = require('../models/WineDefinition');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const { CONSUMED_STATUSES, NOT_IN_CELLAR_STATUSES, ORDERED_STATUS, WINE_POPULATE_LIST } = require('../config/constants');
const { escapeRegex } = require('../utils/sanitize');
const { bottleRating, filterByRating } = require('../utils/ratingUtils');
const {
  classifyMaturity, buildProfileMap, parseMaturityFilter, matchesMaturityFilter,
  buildMaturitySortKeys, compareMaturitySortKeys,
} = require('../utils/maturityUtils');
const { parsePagination } = require('../utils/pagination');
// What a card displays must be what search matches: the search haystack
// below holds each grape's regional display name beside its canonical one.
const { resolveGrapeDisplayName } = require('../utils/grapeDisplay');

const { isValidObjectId } = mongoose;

// The answer when no bottle can match and none was read: the user owns no
// cellar, or a filter names a country, region, grape or wine that does not exist.
const nothingCanMatch = (limit, skip) => ({ bottles: [], total: 0, limit, skip, maturityMap: null, nothingCanMatch: true });

/**
 * The bottle list of GET /api/bottles: the bottles in the cellars a user OWNS
 * (shared cellars are left out, as on the Statistics page, so a chart segment's
 * link lands on a list with the same count), narrowed, sorted and paged by the
 * request's query parameters. The route adds the photos and the grape display
 * names; no MCP tool calls this (search_bottles reads services/bottleSearch).
 *
 * Parameters (all optional, combinable; anything that is not one plain value is ignored):
 *   search       — free-text match against wine name / producer / notes / location / type / appellation / grape names
 *   type         — wine type, comma-separated allowed; 'unknown' is the bottles without a wine
 *   country      — country id or name, comma-separated allowed
 *   region       — region id or name, comma-separated allowed
 *   grapes       — grape id or name, comma-separated
 *   vintage      — vintage year string, comma-separated
 *   producer     — exact producer string (case-insensitive)
 *   bottleSize   — exact bottle-size string (e.g. "750ml")
 *   minRating    — minimum normalised rating (0-100)
 *   maxRating    — maximum normalised rating (0-100); with minRating it is a range
 *   maturity     — 'declining','late','peak','early','not-ready','none' — one, or
 *                  several comma-separated (OR-combined)
 *   sort         — 'createdAt'|'vintage'|'price'|'rating'|'name'|'maturity' with optional leading '-' for descending
 *                  (default '-createdAt')
 *   limit / offset — pagination (defaults: limit 30, max 200); `skip` and `page` as utils/pagination reads them
 *   status       — 'active' (the default), 'all', 'ordered', 'consumed', or one of drank / gifted / sold / other
 *   ratingBand   — one of the rating bands of the statistics (utils/ratingUtils RATING_BANDS)
 *   purchaseYear / consumedYear — the calendar year of the purchase / of the drinking
 *
 * @returns {{ bottles: object[], total: number, limit: number, skip: number,
 *   maturityMap: Map<string, string|null>|null, nothingCanMatch?: true }}
 *   `bottles` is the page (lean, wine populated); `maturityMap` (bottle id →
 *   stage) is set only when maturity was filtered or sorted on.
 */
async function queryUserBottles(userId, params) {
  const cellarIds = await Cellar.find({ user: userId, deletedAt: null }).distinct('_id');
  const { limit, offset: skip } = parsePagination(params, { limit: 30, maxLimit: 200 });

  if (cellarIds.length === 0) {
    return nothingCanMatch(limit, skip);
  }

  // Defensive scalar coercion: Express's qs query parser turns inputs
  // like `?bottleSize[$ne]=1` into `{ bottleSize: { $ne: '1' } }`,
  // which would bypass per-field guards and leak Mongo operators into
  // the filter we build below. Reject anything that isn't a plain
  // string so every value below is guaranteed to be primitive.
  const q = (v) => (typeof v === 'string' ? v : undefined);
  const search           = q(params.search);
  const type             = q(params.type);
  const country          = q(params.country);
  const region           = q(params.region);
  const grapes           = q(params.grapes);
  const vintage          = q(params.vintage);
  const producer         = q(params.producer);
  const bottleSize       = q(params.bottleSize);
  const minRating        = q(params.minRating);
  const maxRating        = q(params.maxRating);
  const ratingBandParam  = q(params.ratingBand); // one of RATING_BANDS (a statistics band link)
  // null when absent; a Set of statuses otherwise (multi-select, OR).
  const maturityFilter   = parseMaturityFilter(q(params.maturity));
  const sort             = q(params.sort) || '-createdAt';
  // Lifecycle filters — default is active-only, matching the
  // Statistics page's by-type / by-country / etc. aggregates.
  const statusFilter     = q(params.status);
  // Purchase / consumption year filters apply to bottle.purchaseDate
  // and bottle.consumedAt respectively — driven by the Statistics
  // page's Purchase History and Consumption History charts.
  const purchaseYear     = q(params.purchaseYear);
  const consumedYear     = q(params.consumedYear);

  const sortField = sort.startsWith('-') ? sort.substring(1) : sort;
  const sortDir = sort.startsWith('-') ? -1 : 1;

  const filter = {
    user: userId,
    cellar: { $in: cellarIds },
  };

  // Status / lifecycle scope
  if (!statusFilter || statusFilter === 'active') {
    filter.status = { $nin: NOT_IN_CELLAR_STATUSES };
  } else if (statusFilter === 'all') {
    // no status constraint — include everything
  } else if (statusFilter === ORDERED_STATUS) {
    // Bought, not delivered yet
    filter.status = ORDERED_STATUS;
  } else if (CONSUMED_STATUSES.includes(statusFilter)) {
    filter.status = statusFilter;
  } else if (statusFilter === 'consumed') {
    filter.status = { $in: CONSUMED_STATUSES };
  } else {
    // Unknown value — fall back to the default active scope
    filter.status = { $nin: NOT_IN_CELLAR_STATUSES };
  }

  if (vintage) {
    const vintages = String(vintage).split(',').map(v => v.trim()).filter(Boolean);
    filter.vintage = vintages.length === 1 ? vintages[0] : { $in: vintages };
  }

  if (bottleSize) {
    filter.bottleSize = String(bottleSize);
  }

  // Year-range filters on purchaseDate / consumedAt. Using $gte/$lt of
  // Jan 1 of the year and Jan 1 of next year lets MongoDB use the
  // existing date indexes and avoids JS-side getFullYear() iteration.
  const yearRange = (yearStr) => {
    const y = parseInt(yearStr, 10);
    if (isNaN(y) || y < 1900 || y > 2200) return null;
    return { $gte: new Date(y, 0, 1), $lt: new Date(y + 1, 0, 1) };
  };

  if (purchaseYear) {
    const range = yearRange(purchaseYear);
    if (range) filter.purchaseDate = range;
  }
  if (consumedYear) {
    const range = yearRange(consumedYear);
    if (range) filter.consumedAt = range;
  }

  // Pre-query WineDefinition for taxonomy / type / producer filters.
  // country/region values may be ObjectIds OR display names — the
  // Statistics charts only know names (the byCountry/byRegion stats
  // aggregate by name), so we resolve names to IDs on the fly here
  // so the same query param works from both worlds.
  const wdFilter = {};

  const resolveTaxonomy = async (raw, Model) => {
    const ids = [];
    const names = [];
    for (const v of String(raw).split(',').map(s => s.trim()).filter(Boolean)) {
      if (isValidObjectId(v)) ids.push(v);
      else names.push(v);
    }
    if (names.length > 0) {
      const found = await Model.find({ name: { $in: names } }).distinct('_id');
      ids.push(...found.map(id => id.toString()));
    }
    return ids;
  };

  if (country) {
    const ids = await resolveTaxonomy(country, Country);
    if (ids.length === 0) {
      return nothingCanMatch(limit, skip);
    }
    wdFilter.country = ids.length === 1 ? ids[0] : { $in: ids };
  }
  if (region) {
    const ids = await resolveTaxonomy(region, Region);
    if (ids.length === 0) {
      return nothingCanMatch(limit, skip);
    }
    wdFilter.region = ids.length === 1 ? ids[0] : { $in: ids };
  }
  // Grapes can also be passed as names (the byGrape stat is a name list)
  if (grapes) {
    const grapeIds2 = await resolveTaxonomy(grapes, Grape);
    if (grapeIds2.length === 0) {
      return nothingCanMatch(limit, skip);
    }
    wdFilter.grapes = grapeIds2.length === 1 ? grapeIds2[0] : { $in: grapeIds2 };
  }
  // 'unknown' is the stats bucket for bottles WITHOUT a wine definition
  // (typically pending wine requests from an import) — no WineDefinition
  // ever has that type, so it must match null-wineDefinition bottles
  // instead of going into the wd pre-query.
  let includeNoWine = false;
  if (type) {
    const types = String(type).split(',').map(t => t.trim()).filter(Boolean);
    includeNoWine = types.includes('unknown');
    const realTypes = types.filter(t => t !== 'unknown');
    if (realTypes.length > 0) {
      wdFilter.type = realTypes.length === 1 ? realTypes[0] : { $in: realTypes };
    }
  }
  if (producer) {
    // Producer is a free-text field on WineDefinition; match case-insensitively
    // with an anchored regex so chart segments that pass the exact value
    // (e.g. "Château Margaux") find that producer's bottles.
    const escaped = escapeRegex(producer);
    wdFilter.producer = new RegExp(`^${escaped}$`, 'i');
  }

  if (Object.keys(wdFilter).length > 0) {
    const wdIds = await WineDefinition.find(wdFilter).distinct('_id');
    if (wdIds.length === 0 && !includeNoWine) {
      return nothingCanMatch(limit, skip);
    }
    // $in with null matches bottles whose wineDefinition is null or absent.
    filter.wineDefinition = includeNoWine ? { $in: [...wdIds, null] } : { $in: wdIds };
  } else if (includeNoWine) {
    filter.wineDefinition = null;
  }

  // A list that holds history bottles sorts "by rating" on the rating each
  // bottle counts with — for a drunk one the rating given when drinking —
  // as it filters (utils/ratingUtils.bottleRating), so in memory.
  const holdsHistory = statusFilter === 'all' || statusFilter === 'consumed' || CONSUMED_STATUSES.includes(statusFilter);
  const directSortFields = ['createdAt', 'vintage', 'price', ...(holdsHistory ? [] : ['rating'])];
  const canSortInDb = directSortFields.includes(sortField);
  const needsInMemoryFilter = !!(search || minRating || maxRating || ratingBandParam || maturityFilter);
  const canPaginateInDb = canSortInDb && !needsInMemoryFilter;

  let query = Bottle.find(filter).populate(WINE_POPULATE_LIST);
  if (canSortInDb) query = query.sort({ [sortField]: sortDir });
  if (canPaginateInDb) {
    query = query.skip(skip).limit(limit);
  } else {
    // Fallback (text search / min-rating / maturity filters, or in-memory
    // sorts) hydrates the set for in-memory processing — cap it like the
    // cellars.js fallbacks so one request can't load an unbounded
    // collection. When there's no DB sort to cap on, anchor on newest-added
    // so the >10k slice is at least deterministic.
    if (!canSortInDb) query = query.sort({ createdAt: -1 });
    query = query.limit(10000);
  }
  let bottles = await query.lean();
  let totalCount = canPaginateInDb ? await Bottle.countDocuments(filter) : null;

  // ── In-memory text search (multi-word AND across populated fields) ─────────
  if (search) {
    const stripAccents = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const words = stripAccents(String(search).toLowerCase()).split(/\s+/).filter(Boolean);
    bottles = bottles.filter(b => {
      const allText = [
        b.wineDefinition?.name,
        b.wineDefinition?.producer,
        b.notes,
        b.location,
        b.wineDefinition?.country?.name,
        b.wineDefinition?.region?.name,
        b.wineDefinition?.appellation,
        b.wineDefinition?.type,
        // Canonical grape names PLUS the regional display name resolved for
        // this wine's own country/region when it differs ("Tinta Roriz" on
        // a Douro Port) — the card shows the regional label, so searching
        // it must hit. Undefineds fall to filter(Boolean).
        ...(b.wineDefinition?.grapes || []).flatMap(g => {
          const names = [g?.name];
          const display = resolveGrapeDisplayName(g, {
            countryId: b.wineDefinition.country,
            regionId: b.wineDefinition.region,
            wineName: b.wineDefinition.name,
          });
          if (display && display !== g?.name) names.push(display);
          return names;
        }),
      ].filter(Boolean).map(s => stripAccents(String(s).toLowerCase())).join(' ');
      return words.every(word => allText.includes(word));
    });
  }

  // ── Rating post-filter (rating scales must be normalised) ──────────────────
  // A drunk bottle counts with the rating given when drinking, and a band is
  // exactly the statistics' band (utils/ratingUtils).
  bottles = filterByRating(bottles, { minRating, maxRating, ratingBand: ratingBandParam });

  // ── Maturity post-filter / sort (needs WineVintageProfile lookup) ─────────
  let maturityMap = null;
  let maturitySortKeys = null;
  const needsMaturity = !!(maturityFilter || sortField === 'maturity');
  if (needsMaturity) {
    const profileMap = await buildProfileMap(bottles);
    maturityMap = new Map();
    for (const b of bottles) {
      maturityMap.set(b._id.toString(), classifyMaturity(b, profileMap));
    }
    if (sortField === 'maturity') maturitySortKeys = buildMaturitySortKeys(bottles, profileMap, maturityMap);
  }

  if (maturityFilter && maturityMap) {
    bottles = bottles.filter(b => matchesMaturityFilter(maturityMap.get(b._id.toString()), maturityFilter));
  }

  // ── In-memory sort for fields we couldn't sort in the DB ──────────────────
  if (!canSortInDb) {
    bottles.sort((a, b) => {
      // Stage, then the year that stage ends (utils/maturityUtils).
      if (maturitySortKeys) {
        return sortDir * compareMaturitySortKeys(
          maturitySortKeys.get(a._id.toString()), maturitySortKeys.get(b._id.toString()));
      }
      let aVal, bVal;
      if (sortField === 'name') {
        aVal = a.wineDefinition?.name || '';
        bVal = b.wineDefinition?.name || '';
      } else if (sortField === 'rating') {
        // Unrated last when sorting high to low, as the database sorts nulls.
        aVal = bottleRating(a) ?? -1;
        bVal = bottleRating(b) ?? -1;
      } else {
        aVal = a.createdAt;
        bVal = b.createdAt;
      }
      if (aVal < bVal) return -sortDir;
      if (aVal > bVal) return sortDir;
      return 0;
    });
  }

  if (!canPaginateInDb) {
    totalCount = bottles.length;
    bottles = bottles.slice(skip, skip + limit);
  }

  return { bottles, total: totalCount, limit, skip, maturityMap };
}

module.exports = { queryUserBottles };
