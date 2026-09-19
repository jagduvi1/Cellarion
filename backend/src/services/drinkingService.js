/**
 * "What should I drink" computations — ready-to-drink candidate selection,
 * shortlist enrichment (taste profile, rack position, open-bottle state) and
 * dish keyword scoring. ONE implementation for every surface: today the MCP
 * tools (mcp/tools/drinking.js) are the only consumer; a future UI feature
 * ("tonight" widget, pairing helper) imports THESE functions (one-impl rule).
 *
 * Access is the CALLER's job: functions take pre-authorized cellarIds — the
 * surface resolves which cellars the user may see before calling in.
 */
const User = require('../models/User');
const Bottle = require('../models/Bottle');
const Rack = require('../models/Rack');
const WineDefinition = require('../models/WineDefinition');
const { CONSUMED_STATUSES, WINE_POPULATE_LIST } = require('../config/constants');
const { classifyMaturity, buildProfileMap, maturityLabel, resolveEffectiveWindow } = require('../utils/maturityUtils');
const { toNormalized } = require('../utils/ratingUtils');
const { isReserved } = require('../utils/reservationUtils');

// Readiness order: already-open bottles first (finish before opening anew),
// then closing windows (drinking them tonight is a rescue), then peak.
// 'approaching' = not-ready but within APPROACHING_YEARS of its window: last,
// yet still on the table. Further out than that is excluded entirely.
const READINESS_RANK = { open: 0, declining: 1, late: 2, peak: 3, early: 4, unknown: 5, approaching: 6 };

// A wine a year or two short of its drink window is usually a fine bottle
// tonight — youthful, not wrong (support ticket 6aad5481: a 2025 Pfalz
// Riesling curated "from 2027" was hidden from a chili-snack pairing, and it
// was exactly the right wine). Hard-excluding it left the calling model
// unaware the bottle existed. Beyond this margin a wine is genuinely unready.
const APPROACHING_YEARS = 2;

const parseMl = (size) => {
  const n = parseInt(String(size || '750').replace(/[^0-9]/g, ''), 10);
  return Number.isInteger(n) && n > 0 ? n : 750;
};

/** True when a lean subdoc has any non-empty value (skeleton aiProfile → null). */
function hasContent(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return Object.values(obj).some((v) => {
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return hasContent(v);
    return true;
  });
}

/**
 * Unique registry ids from ranked entries. Pending registry bottles have no
 * wineDefinition, so drop absent ids before String conversion —
 * String(undefined) is truthy and survives filtering. Convert before Set so
 * equal ObjectId values dedupe by string value rather than object identity.
 */
function uniqueWineIds(entries) {
  return [...new Set(
    entries.map((r) => r.b.wineDefinition?._id).filter(Boolean).map(String)
  )];
}

/**
 * Select and rank ready-to-drink candidates within the given cellars.
 * Returns { ranked, profileMap, totalActive, considered, notReady, approaching,
 * reservedExcluded, priceWarning, composition }. `approaching` bottles are IN
 * `ranked` (readiness 'approaching'); `notReady` counts only those excluded.
 *
 * `totalActive` is the UNFILTERED live-bottle count in scope — what "screened
 * the cellar" honestly means. `considered` is what survived the reserved/type/
 * price filters. The tools' summaries must lead with totalActive (release-audit
 * M-2: leading with the filtered count on a wine_type call re-created the
 * "the AI can only see part of my cellar" misreading #946 exists to kill).
 */
async function readyCandidates(userId, cellarIds, { wineType, maxPrice, currency } = {}) {
  if (!cellarIds.length) return { ranked: [], profileMap: new Map(), totalActive: 0, considered: 0, notReady: 0, reservedExcluded: 0, priceWarning: null };

  const bottles = await Bottle.find({ cellar: { $in: cellarIds }, status: { $nin: CONSUMED_STATUSES } })
    .populate(WINE_POPULATE_LIST).lean();

  let pool = bottles;
  // Reserved ("spoken for") bottles never surface as drink-now suggestions —
  // they are exactly the bottles the user has decided NOT to open yet. They
  // stay included in stats/value/export surfaces, which don't route here.
  const beforeReserved = pool.length;
  pool = pool.filter((b) => !isReserved(b));
  const reservedExcluded = beforeReserved - pool.length;
  if (wineType) pool = pool.filter((b) => b.wineDefinition?.type === wineType);

  let priceWarning = null;
  if (maxPrice != null) {
    const { getOrCreateDailySnapshot, convertCurrency } = require('../utils/exchangeRates');
    const dbUser = await User.findById(userId).select('preferences').lean();
    const target = (currency || dbUser?.preferences?.currency || 'USD').toUpperCase();
    let rates = null;
    try { rates = (await getOrCreateDailySnapshot())?.rates || null; } catch (_) {}
    const before = pool.length;
    pool = pool.filter((b) => {
      const v = b.price ? convertCurrency(b.price, b.currency || 'USD', target, rates) : null;
      return v != null && v <= maxPrice;
    });
    priceWarning = `max_price ${maxPrice} ${target}: ${before - pool.length} bottle(s) without a comparable price were excluded.`;
  }

  const profileMap = await buildProfileMap(pool);
  const currentYear = new Date().getFullYear();
  let notReady = 0;
  let approaching = 0;
  const ranked = [];
  for (const b of pool) {
    const status = classifyMaturity(b, profileMap);
    let yearsToWindow = null;
    if (status === 'not-ready') {
      const from = resolveEffectiveWindow(b, profileMap)?.drinkFrom;
      yearsToWindow = Number.isFinite(from) ? from - currentYear : null;
      if (yearsToWindow == null || yearsToWindow > APPROACHING_YEARS) { notReady++; continue; }
      approaching++;
    }
    const readiness = b.openedAt ? 'open' : (status === 'not-ready' ? 'approaching' : (status || 'unknown'));
    ranked.push({ b, status, readiness, rank: READINESS_RANK[readiness], yearsToWindow });
  }
  ranked.sort((a, x) => {
    if (a.rank !== x.rank) return a.rank - x.rank;
    const ra = a.b.rating ? toNormalized(a.b.rating, a.b.ratingScale || '5') : -1;
    const rx = x.b.rating ? toNormalized(x.b.rating, x.b.ratingScale || '5') : -1;
    if (ra !== rx) return rx - ra; // better-rated first within a readiness band
    return String(a.b.vintage).localeCompare(String(x.b.vintage));
  });

  return {
    ranked, profileMap, totalActive: bottles.length, considered: pool.length, notReady, approaching,
    reservedExcluded, priceWarning, composition: cellarComposition(bottles),
  };
}

/**
 * Whole-cellar headcount by wine type and by grape (every active bottle in
 * scope, ready or not, reserved included). A shortlist alone hides what else
 * is in the cellar: with zero keyword hits the model never learned nine
 * Rieslings were there to ask about (ticket 6aad5481). Grape counts include
 * blends, so they can sum past the bottle total.
 */
function cellarComposition(bottles) {
  const byType = {};
  const byGrape = {};
  for (const b of bottles) {
    const t = b.wineDefinition?.type || 'unknown';
    byType[t] = (byType[t] || 0) + 1;
    for (const g of b.wineDefinition?.grapes || []) {
      if (g?.name) byGrape[g.name] = (byGrape[g.name] || 0) + 1;
    }
  }
  const desc = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
  return { by_type: desc(byType), by_grape: desc(byGrape) };
}

/**
 * Collapse ranked entries to one per wine + vintage (an open bottle stays
 * apart — its state differs), preserving order. Identical bottles used to take
 * separate shortlist slots (3× the same Chenin in an 8-slot answer); now the
 * first entry stands for the group and carries the other bottle ids.
 */
function groupSameWine(ranked) {
  const groups = new Map();
  const out = [];
  for (const r of ranked) {
    const wdId = r.b.wineDefinition?._id;
    const key = wdId ? `${wdId}:${r.b.vintage}:${r.b.openedAt ? 'open' : ''}` : `bottle:${r.b._id}`;
    const g = groups.get(key);
    if (g) { g.otherBottleIds.push(r.b._id); continue; }
    const entry = { ...r, otherBottleIds: [] };
    groups.set(key, entry);
    out.push(entry);
  }
  return out;
}

/** Serialize the top `limit` ranked entries, enriching with taste + position. */
async function serializeCandidates(ranked, profileMap, cellarIds, limit) {
  const top = ranked.slice(0, limit);
  const bottleIds = top.map((r) => r.b._id);
  const wineIds = uniqueWineIds(top);

  // Taste profiles (WINE_POPULATE_LIST strips them from list loads) and rack
  // positions, fetched only for the shortlist.
  const [wines, racks] = await Promise.all([
    wineIds.length
      ? WineDefinition.find({ _id: { $in: wineIds } }).select('aiProfile').lean()
      : [],
    bottleIds.length
      ? Rack.find({ cellar: { $in: cellarIds }, deletedAt: null, 'slots.bottle': { $in: bottleIds } })
          .select('name slots.position slots.bottle').lean()
      : [],
  ]);
  const tasteOf = new Map(wines.map((w) => [String(w._id), w.aiProfile]));
  const positionOf = new Map();
  for (const rack of racks) {
    for (const s of rack.slots || []) {
      const bid = String(s.bottle);
      if (bottleIds.some((id) => String(id) === bid)) positionOf.set(bid, { rack: rack.name, position: s.position });
    }
  }

  return top.map(({ b, status, readiness, yearsToWindow, otherBottleIds }) => {
    const profile = b.wineDefinition ? tasteOf.get(String(b.wineDefinition._id)) : null;
    const taste = profile && hasContent(profile)
      ? {
          body: profile.body || null,
          tannin: profile.tannin || null,
          acidity: profile.acidity || null,
          sweetness: profile.sweetness || null,
          flavors: profile.flavors || [],
          food_pairings: profile.foodPairings || [],
          // Who wrote it and how sure: an AI profile at 0.65 is a guess, and
          // sweetness is often the field a pairing turns on (ticket 6aad5481).
          source: profile.source === 'curator' ? 'sommelier' : 'ai',
          confidence: profile.source === 'curator' ? null : (profile.confidence ?? null),
        }
      : null;
    const wdId = b.wineDefinition?._id ? String(b.wineDefinition._id) : null;
    const vintageProfile = wdId ? profileMap.get(`${wdId}:${b.vintage}`) : null;
    return {
      bottle_id: b._id,
      wine: {
        name: b.wineDefinition?.name || b.pendingWineRequest?.wineName || 'Unknown wine',
        producer: b.wineDefinition?.producer || null,
        type: b.wineDefinition?.type || null,
        grapes: (b.wineDefinition?.grapes || []).map((g) => g?.name).filter(Boolean),
        region: b.wineDefinition?.region?.name || null,
        country: b.wineDefinition?.country?.name || null,
      },
      vintage: b.vintage,
      bottles: 1 + (otherBottleIds?.length || 0),
      ...(otherBottleIds?.length ? { other_bottle_ids: otherBottleIds } : {}),
      readiness,
      maturity: status,
      ...(readiness === 'approaching' ? { years_until_window: yearsToWindow } : {}),
      window: maturityLabel(status, vintageProfile, b),
      open: b.openedAt
        ? {
            opened_at: b.openedAt,
            preservation: b.preservationMethod || null,
            remaining_ml: Math.max(parseMl(b.bottleSize) - (b.pours || []).reduce((s, p) => s + (p.ml || 0), 0), 0),
          }
        : null,
      rating: b.rating ?? null,
      rating_scale: b.rating != null ? b.ratingScale || '5' : undefined,
      price: b.price ?? null,
      currency: b.price != null ? b.currency || 'USD' : undefined,
      location: positionOf.get(String(b._id)) || null,
      taste,
    };
  });
}

/**
 * Dish keyword evidence: dish tokens vs stored foodPairings (weight 2) and
 * flavors (weight 1) of the ranked pool's wines. Returns Map<bottleIdString,
 * { score, terms }> for the bottles with at least one hit.
 */
async function scoreDishMatches(dish, ranked) {
  const tokens = [...new Set(String(dish).toLowerCase().split(/[^a-zà-ÿ]+/i).filter((t) => t.length >= 3))];
  const wineIds = uniqueWineIds(ranked);
  const wines = wineIds.length
    ? await WineDefinition.find({ _id: { $in: wineIds } }).select('aiProfile.foodPairings aiProfile.flavors').lean()
    : [];
  const profOf = new Map(wines.map((w) => [String(w._id), w.aiProfile || {}]));

  const scoreOf = new Map();
  for (const r of ranked) {
    const prof = r.b.wineDefinition ? profOf.get(String(r.b.wineDefinition._id)) : null;
    if (!prof) continue;
    const hay = [
      ...(prof.foodPairings || []).map((p) => ({ text: String(p).toLowerCase(), w: 2 })),
      ...(prof.flavors || []).map((f) => ({ text: String(f).toLowerCase(), w: 1 })),
    ];
    let score = 0;
    const terms = new Set();
    for (const t of tokens) {
      for (const h of hay) {
        if (h.text.includes(t)) { score += h.w; terms.add(h.text); }
      }
    }
    if (score > 0) scoreOf.set(String(r.b._id), { score, terms: [...terms].slice(0, 6) });
  }
  return scoreOf;
}

module.exports = {
  readyCandidates, serializeCandidates, scoreDishMatches, groupSameWine, READINESS_RANK, APPROACHING_YEARS,
};
