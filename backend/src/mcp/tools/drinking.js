// "What should I drink" tools (plan Phase 3): what_should_i_open_tonight and
// pair_with_dish. Both are candidate-shortlist generators over the SAME core —
// they select ready-to-drink bottles, attach the structured facts a sommelier
// would weigh (maturity + urgency, taste profile, rating, price, rack position,
// open-bottle state) and let the CALLING model make the actual choice. No LLM
// runs here (§5.2): the server curates data, the caller reasons.
const { z } = require('zod');
const Cellar = require('../../models/Cellar');
const Bottle = require('../../models/Bottle');
const Rack = require('../../models/Rack');
const WineDefinition = require('../../models/WineDefinition');
const { CONSUMED_STATUSES, WINE_POPULATE_LIST } = require('../../config/constants');
const { classifyMaturity, buildProfileMap, maturityLabel } = require('../../utils/maturityUtils');
const { toNormalized } = require('../../utils/ratingUtils');
const { registerTool } = require('../registry');
const { ok, fail, objectId, MSG_CELLAR_NOT_FOUND, resolveCellarAccess, hasContent } = require('../toolUtil');

const WINE_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];
const MAX_LIMIT = 15;

// Readiness order: already-open bottles first (finish before opening anew),
// then closing windows (drinking them tonight is a rescue), then peak.
// 'not-ready' is excluded from candidates entirely.
const READINESS_RANK = { open: 0, declining: 1, late: 2, peak: 3, early: 4, unknown: 5 };

const parseMl = (size) => {
  const n = parseInt(String(size || '750').replace(/[^0-9]/g, ''), 10);
  return Number.isInteger(n) && n > 0 ? n : 750;
};

/**
 * Select and rank ready-to-drink candidates.
 * Scope: the user's OWN cellars by default (cellar-view semantics, like
 * search_bottles); an explicit cellar_id may be any cellar they can view.
 * Returns { candidates, considered, notReady, cellarName } or { error }.
 */
async function readyCandidates(ctx, args) {
  let cellarIds;
  let cellarName = null;
  if (args.cellar_id) {
    const access = await resolveCellarAccess(ctx.user.id, args.cellar_id);
    if (!access) return { error: fail('not_found', MSG_CELLAR_NOT_FOUND) };
    cellarIds = [access.cellar._id];
    cellarName = access.cellar.name;
  } else {
    const cellars = await Cellar.find({ user: ctx.user.id, deletedAt: null }).select('_id').lean();
    cellarIds = cellars.map((c) => c._id);
  }
  if (cellarIds.length === 0) return { candidates: [], considered: 0, notReady: 0, cellarName };

  const bottles = await Bottle.find({ cellar: { $in: cellarIds }, status: { $nin: CONSUMED_STATUSES } })
    .populate(WINE_POPULATE_LIST).lean();

  let pool = bottles;
  if (args.wine_type) pool = pool.filter((b) => b.wineDefinition?.type === args.wine_type);

  let priceWarning = null;
  if (args.max_price != null) {
    const { getOrCreateDailySnapshot, convertCurrency } = require('../../utils/exchangeRates');
    const User = require('../../models/User');
    const dbUser = await User.findById(ctx.user.id).select('preferences').lean();
    const target = (args.currency || dbUser?.preferences?.currency || 'USD').toUpperCase();
    let rates = null;
    try { rates = (await getOrCreateDailySnapshot())?.rates || null; } catch (_) {}
    const before = pool.length;
    pool = pool.filter((b) => {
      const v = b.price ? convertCurrency(b.price, b.currency || 'USD', target, rates) : null;
      return v != null && v <= args.max_price;
    });
    priceWarning = `max_price ${args.max_price} ${target}: ${before - pool.length} bottle(s) without a comparable price were excluded.`;
  }

  const profileMap = await buildProfileMap(pool);
  let notReady = 0;
  const ranked = [];
  for (const b of pool) {
    const status = classifyMaturity(b, profileMap);
    if (status === 'not-ready') { notReady++; continue; }
    const readiness = b.openedAt ? 'open' : (status || 'unknown');
    ranked.push({ b, status, readiness, rank: READINESS_RANK[readiness] });
  }
  ranked.sort((a, x) => {
    if (a.rank !== x.rank) return a.rank - x.rank;
    const ra = a.b.rating ? toNormalized(a.b.rating, a.b.ratingScale || '5') : -1;
    const rx = x.b.rating ? toNormalized(x.b.rating, x.b.ratingScale || '5') : -1;
    if (ra !== rx) return rx - ra; // better-rated first within a readiness band
    return String(a.b.vintage).localeCompare(String(x.b.vintage));
  });

  return { ranked, profileMap, considered: pool.length, notReady, cellarName, cellarIds, priceWarning };
}

/** Serialize the top `limit` ranked entries, enriching with taste + position. */
async function serializeCandidates(ranked, profileMap, cellarIds, limit) {
  const top = ranked.slice(0, limit);
  const bottleIds = top.map((r) => r.b._id);
  const wineIds = [...new Set(top.map((r) => String(r.b.wineDefinition?._id)).filter(Boolean))];

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

  return top.map(({ b, status, readiness }) => {
    const profile = b.wineDefinition ? tasteOf.get(String(b.wineDefinition._id)) : null;
    const taste = profile && hasContent(profile)
      ? {
          body: profile.body || null,
          tannin: profile.tannin || null,
          acidity: profile.acidity || null,
          sweetness: profile.sweetness || null,
          flavors: profile.flavors || [],
          food_pairings: profile.foodPairings || [],
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
      readiness,
      maturity: status,
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

registerTool({
  name: 'what_should_i_open_tonight',
  title: 'Tonight\'s candidates (ready to drink)',
  description:
    'Ready-to-drink candidates from the user\'s cellar, best-first: already-open bottles (finish those first), then ' +
    'bottles in closing drink windows, then peak-maturity bottles — each with taste profile, rating, price, drink ' +
    'window and exact rack position. Call for "what should I open/drink tonight", picking a bottle for an occasion, ' +
    'or any drink-now decision. YOU choose for the occasion and explain why; the list is ranked by readiness only.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    wine_type: z.enum(WINE_TYPES).optional().describe('Only this style, if the user specified one'),
    cellar_id: objectId.optional().describe('Restrict to one cellar (default: all own cellars)'),
    max_price: z.number().min(0).optional().describe('Only bottles at or under this price (in `currency`)'),
    currency: z.string().regex(/^[A-Za-z]{3}$/).optional().describe('Currency for max_price; defaults to the user\'s preference'),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(8),
  },
  handler: async (args, ctx) => {
    const sel = await readyCandidates(ctx, args);
    if (sel.error) return sel.error;
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 8, 1), MAX_LIMIT);
    if (!sel.ranked || sel.ranked.length === 0) {
      return ok('No ready-to-drink bottles matched', [], {
        warnings: [
          `${sel.notReady || 0} bottle(s) are not ready yet; ${sel.considered || 0} matched the filters in total.`,
          ...(sel.priceWarning ? [sel.priceWarning] : []),
        ],
      });
    }
    const data = await serializeCandidates(sel.ranked, sel.profileMap, sel.cellarIds, limit);
    const openCount = data.filter((c) => c.readiness === 'open').length;
    const urgentCount = data.filter((c) => c.readiness === 'declining' || c.readiness === 'late').length;
    return ok(
      `${data.length} candidate(s)${sel.cellarName ? ` in "${sel.cellarName}"` : ''}` +
        `${openCount ? ` — ${openCount} already open` : ''}${urgentCount ? `, ${urgentCount} in closing windows` : ''}`,
      data,
      {
        warnings: [
          `Ranked by readiness, not by occasion — weigh price, occasion and taste yourself. ${sel.notReady} not-ready bottle(s) excluded.`,
          ...(sel.priceWarning ? [sel.priceWarning] : []),
        ],
      }
    );
  },
});

registerTool({
  name: 'pair_with_dish',
  title: 'Cellar candidates for a dish',
  description:
    'Bottles from the user\'s OWN cellar that fit a dish: matches the dish against each wine\'s stored food-pairing ' +
    'and flavour data (keyword evidence, listed per match) and returns ready-to-drink candidates with full taste ' +
    'profiles, plus a style spread of other ready bottles so every style is on the table. Call for "what goes with ' +
    'X", menu planning, or dinner-party picks. The keyword matches are HINTS — apply real pairing judgement over ' +
    'the taste profiles yourself. For buying ideas outside the cellar use semantic_search_wines instead.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    dish: z.string().min(2).max(200).describe('The dish, e.g. "duck confit", "grilled salmon with lemon"'),
    cellar_id: objectId.optional().describe('Restrict to one cellar (default: all own cellars)'),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(8),
  },
  handler: async (args, ctx) => {
    const sel = await readyCandidates(ctx, args);
    if (sel.error) return sel.error;
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 8, 1), MAX_LIMIT);
    if (!sel.ranked || sel.ranked.length === 0) {
      return ok('No ready-to-drink bottles to pair', [], {
        warnings: [`${sel.notReady || 0} bottle(s) are not ready yet. Suggest the user widens the pool or looks at the registry.`],
      });
    }

    // Keyword evidence: dish tokens vs stored foodPairings (weight 2) and
    // flavors (weight 1). Profiles are fetched once for the ready pool's wines.
    const tokens = [...new Set(String(args.dish).toLowerCase().split(/[^a-zà-ÿ]+/i).filter((t) => t.length >= 3))];
    const wineIds = [...new Set(sel.ranked.map((r) => String(r.b.wineDefinition?._id)).filter(Boolean))];
    const wines = wineIds.length
      ? await WineDefinition.find({ _id: { $in: wineIds } }).select('aiProfile.foodPairings aiProfile.flavors').lean()
      : [];
    const profOf = new Map(wines.map((w) => [String(w._id), w.aiProfile || {}]));

    const scoreOf = new Map(); // bottleId -> { score, terms }
    for (const r of sel.ranked) {
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

    const matched = sel.ranked
      .filter((r) => scoreOf.has(String(r.b._id)))
      .sort((a, b) => scoreOf.get(String(b.b._id)).score - scoreOf.get(String(a.b._id)).score || a.rank - b.rank);
    const rest = sel.ranked.filter((r) => !scoreOf.has(String(r.b._id)));

    // Style spread: best-readiness bottle or two per wine type from the rest,
    // so the model can pair by style knowledge even with zero keyword hits.
    const perType = new Map();
    for (const r of rest) {
      const t = r.b.wineDefinition?.type || 'unknown';
      const arr = perType.get(t) || [];
      if (arr.length < 2) { arr.push(r); perType.set(t, arr); }
    }
    const spread = [...perType.values()].flat();

    const matchedOut = await serializeCandidates(matched, sel.profileMap, sel.cellarIds, Math.min(matched.length, limit));
    for (const c of matchedOut) {
      const s = scoreOf.get(String(c.bottle_id));
      c.match = { score: s.score, matched_on: s.terms };
    }
    const spreadOut = await serializeCandidates(spread, sel.profileMap, sel.cellarIds, Math.max(limit - matchedOut.length, 3));

    return ok(
      `${matchedOut.length} keyword match(es) for "${args.dish}", ${spreadOut.length} style-spread candidate(s)`,
      { matched: matchedOut, style_spread: spreadOut },
      {
        warnings: [
          'Keyword matches come from stored pairing/flavour text — evidence, not verdicts. Wines without an enriched taste profile never keyword-match; judge those from grape, region and type.',
        ],
      }
    );
  },
});

module.exports = { readyCandidates };
