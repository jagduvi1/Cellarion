// Bottle read tools: search/list, one-bottle detail, and the drinking log.
//
// Scoping mirrors the REST API exactly:
//  - without cellar_id → the user's OWN bottles across cellars they OWN
//    (same as GET /api/bottles: { user, cellar: { $in: ownedCellarIds } });
//  - with cellar_id    → all bottles of that cellar after a member/owner
//    access check (same as the per-cellar routes).
//
// services/search (Meilisearch) is required LAZILY inside the handler — the
// meilisearch package is ESM-only and a top-level require would drag it into
// every jest suite that loads the tool registry (the #702 failure mode).
const { z } = require('zod');
const Bottle = require('../../models/Bottle');
const Cellar = require('../../models/Cellar');
const Rack = require('../../models/Rack');
const { WINE_POPULATE, WINE_POPULATE_LIST, CONSUMED_STATUSES } = require('../../config/constants');
const { registerTool } = require('../registry');
const {
  ok, fail, resolveCellarAccess, resolveBottleAccess, accessibleCellars,
  wineSummary, bottleSummary, pageParams, hasContent,
} = require('../toolUtil');

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'must be a 24-hex id');

function statusToMongo(status) {
  if (status === 'all') return {};
  if (status === 'consumed') return { status: { $in: CONSUMED_STATUSES } };
  return { status: { $nin: CONSUMED_STATUSES } }; // active (default)
}

registerTool({
  name: 'search_bottles',
  title: 'Search / list bottles',
  description:
    'Searches the user\'s bottles. Filters: free-text query (wine name, producer, region, grape, notes), cellar_id, ' +
    'status (active | consumed | all), vintage, wine type. Paginated and bounded; every item includes its rating, ' +
    'so filter by rating yourself from the results. Call for any "what do I have…", "find my…", "do I own…" question. ' +
    'Prefer filters over fetching everything.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  // No min_rating filter on purpose: stored ratings are on per-bottle scales
  // (5/20/100) and the search index holds the RAW value, so a server-side
  // threshold compares across scales incorrectly (REST normalizes in memory).
  // Ratings ship in every result; the calling model filters better than a
  // wrong index query would. A normalized filter can come with Phase 3.
  inputSchema: {
    query: z.string().max(200).optional().describe('Free-text search (name, producer, region, grape…)'),
    cellar_id: objectId.optional().describe('Restrict to one cellar (any cellar you own or are a member of)'),
    status: z.enum(['active', 'consumed', 'all']).default('active'),
    vintage: z.string().max(10).optional().describe('e.g. "2015" or "NV"'),
    type: z.enum(['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified']).optional(),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).default(0),
  },
  handler: async (args, ctx) => {
    const { limit, offset } = pageParams(args, 20, 50);
    const warnings = [];

    // Resolve the cellar scope first (access model in the header comment).
    let cellarIds;
    if (args.cellar_id) {
      const access = await resolveCellarAccess(ctx.user.id, args.cellar_id);
      if (!access) return fail('not_found', 'No such cellar, or you have no access to it. Use list_cellars for valid ids.');
      cellarIds = [access.cellar._id];
    } else {
      cellarIds = await Cellar.find({ user: ctx.user.id, deletedAt: null }).distinct('_id');
    }

    // Meilisearch path — handles text + all filters with correct pagination.
    const searchService = require('../../services/search');
    if (args.query && searchService.getIsAvailable()) {
      try {
        const res = await searchService.searchBottles(args.query, {
          cellarIds: cellarIds.map(String),
          statusFilter: args.status || 'active',
          type: args.type,
          vintage: args.vintage,
          limit,
          offset,
        });
        // Same ownership contract as the Mongo path below: without cellar_id
        // this lists the user's OWN bottles, so re-apply the user filter here —
        // the search index can't express it, and owned cellars may contain
        // bottles added by shared-cellar editors.
        const docs = await Bottle.find({
          _id: { $in: res.ids },
          ...(args.cellar_id ? {} : { user: ctx.user.id }),
        }).populate(WINE_POPULATE_LIST).lean();
        const byId = new Map(docs.map((d) => [String(d._id), d]));
        const items = res.ids.map((id) => byId.get(String(id))).filter(Boolean).map(bottleSummary);
        return ok(`${items.length} of ${res.estimatedTotalHits} matching bottle(s)`, items, {
          page: { limit, offset, total: res.estimatedTotalHits },
        });
      } catch (err) {
        warnings.push('Text search engine unavailable — fell back to basic filters without free-text matching.');
      }
    } else if (args.query) {
      warnings.push('Text search engine unavailable — fell back to basic filters without free-text matching.');
    }

    // Mongo fallback: cellar/status/vintage are DB-filterable; type and
    // min_rating live on the populated wine / vary by rating scale, so they
    // are dropped here with an explicit warning rather than half-applied.
    const filter = {
      cellar: { $in: cellarIds },
      ...(args.cellar_id ? {} : { user: ctx.user.id }),
      ...statusToMongo(args.status),
      ...(args.vintage ? { vintage: args.vintage } : {}),
    };
    if (args.type) warnings.push('type filter requires the search engine — ignored in this response.');
    const [total, docs] = await Promise.all([
      Bottle.countDocuments(filter),
      Bottle.find(filter).populate(WINE_POPULATE_LIST)
        .sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
    ]);
    return ok(`${docs.length} of ${total} bottle(s)`, docs.map(bottleSummary), {
      page: { limit, offset, total },
      ...(warnings.length ? { warnings } : {}),
    });
  },
});

registerTool({
  name: 'get_bottle',
  title: 'Get one bottle',
  description:
    'Full detail for one bottle: wine (incl. tasting profile when enriched), vintage, price, ratings, personal drink ' +
    'window, notes, purchase info, open-bottle state, rack placement, cellar, and consumption info if consumed. ' +
    'Call when the user asks about a specific bottle you already have a bottle_id for.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: { bottle_id: objectId.describe('Bottle id from search_bottles / list_history') },
  handler: async (args, ctx) => {
    const r = await buildBottleDetail(ctx.user.id, args.bottle_id);
    return r.error ? fail(r.error.code, r.error.message) : ok(r.summary, r.data);
  },
});

// One implementation, two surfaces: the get_bottle tool above and the
// cellar://bottle/{id} resource both read through this builder, so the access
// check and the response shape can never drift apart.
// Returns { error: { code, message } } or { summary, data }.
async function buildBottleDetail(userId, bottleId) {
  const access = await resolveBottleAccess(userId, bottleId);
  if (!access) {
    return { error: { code: 'not_found', message: 'No such bottle, or you have no access to it. Find ids via search_bottles.' } };
  }
  const { cellar, role } = access;
  const b = await Bottle.findById(access.bottle._id).populate(WINE_POPULATE).lean();
  const rack = await Rack.findOne({ 'slots.bottle': b._id, deletedAt: null })
    .select('name slots.position slots.bottle').lean();
  const slot = rack ? rack.slots.find((s) => String(s.bottle) === String(b._id)) : null;
  const wd = b.wineDefinition;
  return {
    summary: `${wd ? wd.name : 'Bottle'} ${b.vintage}`,
    data: {
      bottle_id: b._id,
      wine: wd ? {
        ...wineSummary(wd),
        classification: wd.classification || null,
        // Skeleton subdocs (0 reviews / never-enriched all-null profile) are
        // materialized by Mongoose defaults — return null, not empty shells.
        community_rating: wd.communityRating?.reviewCount ? wd.communityRating : null,
        tasting_profile: hasContent(wd.aiProfile) ? wd.aiProfile : null,
      } : { pending_registry_review: true, name: b.pendingWineRequest?.wineName || null },
      vintage: b.vintage,
      status: b.status,
      bottle_size: b.bottleSize,
      price: b.price ?? null,
      currency: b.currency || null,
      rating: b.rating ?? null,
      rating_scale: b.rating != null ? b.ratingScale : null,
      drink_from: b.drinkFrom ?? null,
      drink_to: b.drinkTo ?? null,
      notes: b.notes || null,
      occasion: b.occasion || null,
      purchase: { date: b.purchaseDate || null, location: b.purchaseLocation || null },
      open_bottle: b.openedAt
        ? { opened_at: b.openedAt, preservation: b.preservationMethod || null, pours: (b.pours || []).length }
        : null,
      consumed: CONSUMED_STATUSES.includes(b.status)
        ? { at: b.consumedAt, reason: b.consumedReason || b.status, note: b.consumedNote || null, rating: b.consumedRating ?? null }
        : null,
      placement: slot ? { rack_id: rack._id, rack_name: rack.name, position: slot.position } : null,
      cellar: { cellar_id: cellar._id, name: cellar.name, your_role: role },
      added_at: b.addedToCellarAt || b.createdAt,
    },
  };
}

registerTool({
  name: 'list_history',
  title: 'Drinking history (Cellar Book)',
  description:
    'The user\'s consumption log: consumed / gifted / sold bottles, newest first, with dates, reasons, ratings and notes. ' +
    'Call for "what did I drink…", tasting recaps, or to find a bottle_id to restore. Optional cellar and year filters.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    cellar_id: objectId.optional(),
    year: z.number().int().min(1900).max(2100).optional().describe('Calendar year the bottle was consumed'),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).default(0),
  },
  handler: async (args, ctx) => {
    const { limit, offset } = pageParams(args, 20, 50);
    let cellarIds;
    if (args.cellar_id) {
      const access = await resolveCellarAccess(ctx.user.id, args.cellar_id);
      if (!access) return fail('not_found', 'No such cellar, or you have no access to it.');
      cellarIds = [access.cellar._id];
    } else {
      cellarIds = (await accessibleCellars(ctx.user.id)).map((c) => c._id);
    }
    const filter = { cellar: { $in: cellarIds }, status: { $in: CONSUMED_STATUSES } };
    if (args.year) {
      // UTC year boundaries — deterministic across environments. Prod runs the
      // container in UTC, so this matches the web app's (server-local) year
      // filter there; only non-UTC self-hosts see a boundary-hour difference.
      filter.consumedAt = { $gte: new Date(Date.UTC(args.year, 0, 1)), $lt: new Date(Date.UTC(args.year + 1, 0, 1)) };
    }
    const [total, docs] = await Promise.all([
      Bottle.countDocuments(filter),
      Bottle.find(filter).populate(WINE_POPULATE_LIST)
        .sort({ consumedAt: -1 }).skip(offset).limit(limit).lean(),
    ]);
    const items = docs.map((b) => ({
      ...bottleSummary(b),
      consumed_at: b.consumedAt,
      consumed_reason: b.consumedReason || b.status,
      consumed_rating: b.consumedRating ?? null,
      consumed_note: b.consumedNote || null,
    }));
    return ok(`${items.length} of ${total} consumed bottle(s)`, items, { page: { limit, offset, total } });
  },
});
module.exports = { buildBottleDetail };
