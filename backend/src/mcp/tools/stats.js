// Portfolio stats tool. Reuses services/statsService.computeOverview — the
// exact computation behind GET /api/stats/overview — then prunes the result to
// a token-efficient subset (the full stats object is built for a dashboard;
// an AI needs the headline numbers plus the maturity/urgency signals).
const { z } = require('zod');
const User = require('../../models/User');
const Cellar = require('../../models/Cellar');
const Bottle = require('../../models/Bottle');
const { CONSUMED_STATUSES, WINE_POPULATE_LIST } = require('../../config/constants');
const { registerTool } = require('../registry');
const { ok } = require('../toolUtil');

const topN = (v, n) => (Array.isArray(v) ? v.slice(0, n) : v);

// Computing stats loads the user's entire bottle set — the REST route shields
// that with a 2-min cache. MCP callers are automated and can repeat identical
// calls, so a short TTL cache here removes the recompute amplification (a 60s
// stale window is irrelevant for portfolio numbers). No invalidation signature:
// reads-only Phase 1 can't change the data through MCP anyway.
const statsCache = new Map(); // `${userId}:${currency}:${scale}` -> { at, result }
const STATS_TTL_MS = 60 * 1000;
const STATS_CACHE_MAX = 2000;

registerTool({
  name: 'cellar_stats',
  title: 'Cellar statistics & drink-window radar',
  description:
    'Portfolio overview across all cellars the user owns: bottle counts, total value, distribution by type / top ' +
    'countries / top grapes / top producers, maturity breakdown (too-young · ready · peak · past), the drink-window ' +
    'urgency ladder (what to drink soonest), and drinking pace. Call for "what is my cellar worth", "how is my ' +
    'collection distributed", "what should I drink soon", or any portfolio-level question.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    currency: z.string().regex(/^[A-Za-z]{3}$/, 'ISO 4217 code').optional().describe('ISO 4217 override; defaults to the user\'s preference'),
  },
  handler: async (args, ctx) => {
    const r = await buildStats(ctx.user.id, args.currency);
    return ok(r.summary, r.data, r.extra);
  },
});

// One implementation, two surfaces: the cellar_stats tool above and the
// cellar://stats resource. Returns { summary, data, extra } (cached 60s).
async function buildStats(userId, currencyOverride) {
  // statsService pulls exchange-rate utils — keep it off the module-load
  // path of the tool registry (same lazy pattern as services/search).
  const { computeOverview, buildEmptyStats } = require('../../services/statsService');

  const dbUser = await User.findById(userId).select('preferences').lean();
  const targetCurrency = (currencyOverride || dbUser?.preferences?.currency || 'USD').toUpperCase();
  const targetRatingScale = dbUser?.preferences?.ratingScale || '5';

  const cacheKey = `${userId}:${targetCurrency}:${targetRatingScale}`;
  const cached = statsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < STATS_TTL_MS) return cached.result;

  const cellars = await Cellar.find({ user: userId, deletedAt: null }).lean();
  if (cellars.length === 0) {
    // Same data shape as the populated case (by_type is an OBJECT map in
    // statsService) so the model never sees two envelopes.
    const empty = buildEmptyStats(targetCurrency);
    return {
      summary: 'No cellars yet',
      data: {
        currency: targetCurrency,
        rating_scale: targetRatingScale,
        overview: empty.overview,
        by_type: {},
        top_countries: [],
        top_grapes: [],
        top_producers: [],
        maturity: empty.maturity || {},
        urgency_ladder: [],
        pace: empty.pace || {},
      },
      extra: {},
    };
  }
  const scope = { user: userId, cellar: { $in: cellars.map((c) => c._id) } };
  const [activeBottles, consumedBottles] = await Promise.all([
    Bottle.find({ ...scope, status: { $nin: CONSUMED_STATUSES } }).populate(WINE_POPULATE_LIST).lean(),
    Bottle.find({ ...scope, status: { $in: CONSUMED_STATUSES } }).populate(WINE_POPULATE_LIST).lean(),
  ]);
  const stats = await computeOverview({ activeBottles, consumedBottles, cellars, targetCurrency, targetRatingScale });

  const result = {
    summary: `${activeBottles.length} active bottle(s) across ${cellars.length} cellar(s)`,
    data: {
      currency: targetCurrency,
      rating_scale: targetRatingScale,
      overview: stats.overview,
      by_type: stats.byType,
      top_countries: topN(stats.byCountry, 10),
      top_grapes: topN(stats.byGrape, 10),
      top_producers: topN(stats.topProducers, 5),
      maturity: stats.maturity,
      urgency_ladder: stats.urgencyLadder,
      pace: stats.pace,
    },
    extra: { warnings: ['Distributions truncated to top entries; full breakdowns are in the web app\'s Statistics page.'] },
  };
  if (statsCache.size >= STATS_CACHE_MAX) statsCache.clear();
  statsCache.set(cacheKey, { at: Date.now(), result });
  return result;
}

module.exports = { buildStats };
