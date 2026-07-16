// Portfolio-intelligence read tools (plan Phase 3): cellar_health_check,
// find_gaps, value_report. All three follow the §5.2 cost rule — they return
// STRUCTURED analysis for the calling model to reason over; no LLM runs here,
// so every call is $0 to Cellarion.
//
// They share one load-and-compute pipeline built on services/statsService
// (the exact computation behind GET /api/stats/overview and cellar_stats) plus
// their own targeted passes. Like stats.js, results are TTL-cached per user —
// automated callers repeat identical questions, and a 60s stale window is
// irrelevant for portfolio-level numbers.
//
// statsService / exchangeRates / valuation are lazy-required inside handlers to
// keep the registry's module-load path lean (same pattern as stats.js).
const { z } = require('zod');
const User = require('../../models/User');
const Cellar = require('../../models/Cellar');
const Bottle = require('../../models/Bottle');
const WishlistItem = require('../../models/WishlistItem');
const { CONSUMED_STATUSES, WINE_POPULATE_LIST } = require('../../config/constants');
const { classifyMaturity, buildProfileMap } = require('../../utils/maturityUtils');
const { registerTool } = require('../registry');
const { ok } = require('../toolUtil');

const WINE_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];

const cache = new Map(); // `${tool}:${userId}:${currency}` -> { at, result }
const TTL_MS = 60 * 1000;
const CACHE_MAX = 2000;

async function cached(tool, userId, currency, compute) {
  const key = `${tool}:${userId}:${currency}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.result;
  const result = await compute();
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, { at: Date.now(), result });
  return result;
}

/** Load the caller's full bottle portfolio (owned cellars only, like stats). */
async function loadPortfolio(userId, currencyOverride) {
  const dbUser = await User.findById(userId).select('preferences').lean();
  const targetCurrency = (currencyOverride || dbUser?.preferences?.currency || 'USD').toUpperCase();
  const targetRatingScale = dbUser?.preferences?.ratingScale || '5';
  const cellars = await Cellar.find({ user: userId, deletedAt: null }).lean();
  if (cellars.length === 0) {
    return { cellars, activeBottles: [], consumedBottles: [], targetCurrency, targetRatingScale };
  }
  const scope = { user: userId, cellar: { $in: cellars.map((c) => c._id) } };
  const [activeBottles, consumedBottles] = await Promise.all([
    Bottle.find({ ...scope, status: { $nin: CONSUMED_STATUSES } }).populate(WINE_POPULATE_LIST).lean(),
    Bottle.find({ ...scope, status: { $in: CONSUMED_STATUSES } }).populate(WINE_POPULATE_LIST).lean(),
  ]);
  return { cellars, activeBottles, consumedBottles, targetCurrency, targetRatingScale };
}

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const wineLabel = (b) => ({
  bottle_id: b._id,
  wine: b.wineDefinition?.name || 'Unknown wine',
  producer: b.wineDefinition?.producer || null,
  type: b.wineDefinition?.type || null,
  vintage: b.vintage,
});

// ── cellar_health_check ──────────────────────────────────────────────────────

registerTool({
  name: 'cellar_health_check',
  title: 'Cellar health check (dead stock & pace)',
  description:
    'Diagnostic analysis of the whole collection: drinking pace vs buying pace and runway, per-wine-type surplus ' +
    '(types piling up faster than they are drunk — dead-stock candidates), bottles past or near the end of their ' +
    'drink window, aging bottles with no window data, and when currently-cellared bottles reach their windows. ' +
    'Call for "is my cellar healthy", "what am I hoarding", "am I buying faster than I drink", or any dead-stock / ' +
    'balance question. Returns structured findings — YOU interpret them for the user.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    currency: z.string().regex(/^[A-Za-z]{3}$/, 'ISO 4217 code').optional().describe('ISO 4217 override; defaults to the user\'s preference'),
  },
  handler: async (args, ctx) => {
    const { computeOverview } = require('../../services/statsService');
    const userId = String(ctx.user.id);
    const currencyKey = (args.currency || 'pref').toUpperCase();

    const result = await cached('health', userId, currencyKey, async () => {
      const { cellars, activeBottles, consumedBottles, targetCurrency, targetRatingScale } =
        await loadPortfolio(userId, args.currency);
      if (activeBottles.length === 0 && consumedBottles.length === 0) {
        return { summary: 'No bottles yet — nothing to diagnose', data: { empty: true } };
      }
      const stats = await computeOverview({ activeBottles, consumedBottles, cellars, targetCurrency, targetRatingScale });

      // Per-type balance: active stock vs consumption rate over the last 5
      // calendar years. surplus_years = how long the current stock lasts at
      // that pace (null = this type is never drunk — the dead-stock signal).
      const WINDOW_YEARS = 5;
      const windowStart = new Date();
      windowStart.setFullYear(windowStart.getFullYear() - WINDOW_YEARS);
      const consumedRecentByType = {};
      for (const b of consumedBottles) {
        if (!b.consumedAt || new Date(b.consumedAt) < windowStart) continue;
        const t = b.wineDefinition?.type || 'unknown';
        consumedRecentByType[t] = (consumedRecentByType[t] || 0) + 1;
      }
      const typeBalance = Object.entries(stats.byType)
        .map(([type, active]) => {
          const perYear = round1((consumedRecentByType[type] || 0) / WINDOW_YEARS);
          return {
            type,
            active,
            consumed_per_year: perYear,
            surplus_years: perYear > 0 ? round1(active / perYear) : null,
            never_drunk_recently: perYear === 0 && active > 0,
          };
        })
        .sort((a, b) => b.active - a.active);

      // Aging blind spots: old-vintage bottles nobody has set a window for —
      // the bottles most at risk of silently dying in the rack.
      const profileMap = await buildProfileMap(activeBottles);
      const currentYear = new Date().getFullYear();
      const blind = [];
      for (const b of activeBottles) {
        const y = parseInt(b.vintage, 10);
        if (!Number.isInteger(y) || currentYear - y < 5) continue;
        if (classifyMaturity(b, profileMap) === null) blind.push(b);
      }
      blind.sort((a, b) => parseInt(a.vintage, 10) - parseInt(b.vintage, 10));

      const data = {
        currency: targetCurrency,
        totals: {
          active_bottles: activeBottles.length,
          consumed_bottles: consumedBottles.length,
          total_value: stats.overview.totalValue,
        },
        health: {
          score: stats.overview.healthScore,
          grade: stats.overview.healthGrade,
          past_peak_share_pct: stats.overview.regretIndex,
        },
        pace: stats.pace,
        maturity: stats.maturity,
        maturity_coverage: stats.maturityCoverage,
        urgent: stats.urgencyLadder,
        type_balance: typeBalance,
        aging_blind_spots: {
          count: blind.length,
          oldest: blind.slice(0, 5).map(wineLabel),
        },
        windows_opening: (stats.maturityForecast || []).slice(0, 6),
      };
      const flags = [];
      if (stats.maturity.declining > 0) flags.push(`${stats.maturity.declining} past peak`);
      if (stats.maturity.late > 0) flags.push(`${stats.maturity.late} in late window`);
      const dead = typeBalance.filter((t) => t.never_drunk_recently || (t.surplus_years !== null && t.surplus_years > 10));
      if (dead.length) flags.push(`${dead.length} type(s) oversupplied`);
      if (blind.length) flags.push(`${blind.length} aging bottle(s) without a drink window`);
      return {
        summary: `Health ${stats.overview.healthGrade || 'n/a'}${flags.length ? ' — ' + flags.join(', ') : ' — no issues flagged'}`,
        data,
      };
    });
    return ok(result.summary, result.data);
  },
});

// ── find_gaps ────────────────────────────────────────────────────────────────

registerTool({
  name: 'find_gaps',
  title: 'Collection coverage & gaps',
  description:
    'The complete coverage picture of the collection for gap analysis: every wine type (including the ones with ZERO ' +
    'bottles), full region / grape / country breakdowns, vintage-decade spread, price-band spread, what the user ' +
    'DRINKS vs what they HOLD, and what is already wishlisted. Call for "what is missing from my cellar", "what ' +
    'should I buy next", or collection-building advice. YOU judge which absences are real gaps for this user\'s taste.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    currency: z.string().regex(/^[A-Za-z]{3}$/, 'ISO 4217 code').optional().describe('ISO 4217 override for price bands'),
  },
  handler: async (args, ctx) => {
    const { computeOverview } = require('../../services/statsService');
    const { getOrCreateDailySnapshot, convertCurrency } = require('../../utils/exchangeRates');
    const userId = String(ctx.user.id);
    const currencyKey = (args.currency || 'pref').toUpperCase();

    const result = await cached('gaps', userId, currencyKey, async () => {
      const { cellars, activeBottles, consumedBottles, targetCurrency, targetRatingScale } =
        await loadPortfolio(userId, args.currency);
      if (activeBottles.length === 0) {
        return {
          summary: 'No active bottles — every style is a gap',
          data: { empty: true, by_type: WINE_TYPES.map((t) => ({ type: t, active: 0, consumed_all_time: 0 })) },
        };
      }
      const stats = await computeOverview({ activeBottles, consumedBottles, cellars, targetCurrency, targetRatingScale });

      // All canonical types, zeros included — an absent style IS the finding.
      const byType = [...new Set([...WINE_TYPES, ...Object.keys(stats.byType), ...Object.keys(stats.consumedByType)])]
        .map((t) => ({
          type: t,
          active: stats.byType[t] || 0,
          consumed_all_time: stats.consumedByType[t] || 0,
        }));

      // Vintage decades (NV kept separate).
      const decades = {};
      let nv = 0;
      for (const { year, count } of stats.byVintage) {
        if (year === 'NV') { nv += count; continue; }
        const d = `${Math.floor(parseInt(year, 10) / 10) * 10}s`;
        decades[d] = (decades[d] || 0) + count;
      }

      // Price bands in the target currency (today's rates, like all stats money).
      let rates = null;
      try { rates = (await getOrCreateDailySnapshot())?.rates || null; } catch (_) { /* bands skip cross-currency */ }
      const bands = { budget: 0, mid: 0, premium: 0, luxury: 0, unpriced: 0 };
      // Band edges are expressed in EUR-ish magnitudes and converted to the
      // target currency so "premium" means the same thing in SEK as in USD.
      const edge = (n) => convertCurrency(n, 'EUR', targetCurrency, rates);
      const [e1, e2, e3] = [edge(15), edge(40), edge(100)];
      for (const b of activeBottles) {
        const v = b.price ? convertCurrency(b.price, b.currency || 'USD', targetCurrency, rates) : null;
        if (v == null) { bands.unpriced++; continue; }
        if (e1 != null && v < e1) bands.budget++;
        else if (e2 != null && v < e2) bands.mid++;
        else if (e3 != null && v < e3) bands.premium++;
        else bands.luxury++;
      }

      const wishlist = await WishlistItem.find({ user: userId, status: 'wanted' })
        .populate({ path: 'wineDefinition', select: 'name producer type' })
        .sort({ createdAt: -1 }).limit(50).lean();

      const cap = (arr, n) => (Array.isArray(arr) ? arr.slice(0, n) : []);
      const data = {
        currency: targetCurrency,
        by_type: byType,
        styles_missing: byType.filter((t) => t.active === 0 && WINE_TYPES.includes(t.type)).map((t) => t.type),
        countries: stats.byCountry,
        regions: cap(stats.allRegions, 40),
        grapes: cap(stats.allGrapes, 40),
        producers: cap(stats.allProducers, 25),
        vintage_decades: [
          ...Object.entries(decades).sort((a, b) => a[0].localeCompare(b[0])).map(([decade, count]) => ({ decade, count })),
          ...(nv ? [{ decade: 'NV', count: nv }] : []),
        ],
        price_bands: { ...bands, band_edges: { budget_under: e1 ? round2(e1) : null, mid_under: e2 ? round2(e2) : null, premium_under: e3 ? round2(e3) : null } },
        // Drinks-vs-holds asymmetry: a type the user loves drinking but barely
        // stocks is as much a gap as a missing style.
        wishlist: {
          wanted: wishlist.length,
          items: wishlist.slice(0, 10).map((w) => ({
            name: w.wineDefinition?.name || null,
            producer: w.wineDefinition?.producer || null,
            type: w.wineDefinition?.type || null,
            vintage: w.vintage || null,
          })),
        },
      };
      const missing = data.styles_missing;
      return {
        summary: `${activeBottles.length} bottles over ${stats.byCountry.length} countries / ${stats.allRegions.length} regions${missing.length ? ` — no ${missing.join(', ')}` : ' — every style represented'}`,
        data,
        extra: { warnings: ['regions/grapes/producers capped at 40/40/25 entries (sorted by count) — totals reflect the full cellar.'] },
      };
    });
    return ok(result.summary, result.data, result.extra || {});
  },
});

// ── value_report ─────────────────────────────────────────────────────────────

registerTool({
  name: 'value_report',
  title: 'Cellar value report (cost vs market)',
  description:
    'Financial view of the collection: cost basis vs estimated replacement value (sommelier market snapshots and ' +
    'community release prices where available), the biggest gainers, most valuable holdings, value AT RISK in ' +
    'bottles past or near the end of their window, per-cellar totals, spend on bottles consumed this year, and the ' +
    'value trend. Call for "what is my cellar worth vs what I paid", "which bottles gained value", or "am I sitting ' +
    'on value I should drink". Replacement estimates only cover wines with market data — coverage is reported.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    currency: z.string().regex(/^[A-Za-z]{3}$/, 'ISO 4217 code').optional().describe('ISO 4217 override; defaults to the user\'s preference'),
  },
  handler: async (args, ctx) => {
    const { resolveReplacementForBottles } = require('../../services/valuation');
    const { getOrCreateDailySnapshot, convertCurrency } = require('../../utils/exchangeRates');
    const CellarValueSnapshot = require('../../models/CellarValueSnapshot');
    const userId = String(ctx.user.id);
    const currencyKey = (args.currency || 'pref').toUpperCase();

    const result = await cached('value', userId, currencyKey, async () => {
      const { cellars, activeBottles, consumedBottles, targetCurrency } =
        await loadPortfolio(userId, args.currency);
      if (activeBottles.length === 0) {
        return { summary: 'No active bottles — nothing to value', data: { empty: true, currency: targetCurrency } };
      }

      let rates = null;
      try { rates = (await getOrCreateDailySnapshot())?.rates || null; } catch (_) { /* cross-currency values drop out */ }
      const toTarget = (amount, from) => (amount && from ? convertCurrency(amount, from, targetCurrency, rates) : null);

      const replacement = await resolveReplacementForBottles(activeBottles);

      let costTotal = 0, costCount = 0;
      let estTotal = 0, estCount = 0;
      const bySource = { secondary: 0, currentRelease: 0, paid: 0 };
      const rows = []; // per-bottle for ranking
      for (const b of activeBottles) {
        const cost = toTarget(b.price, b.currency || 'USD');
        if (cost != null) { costTotal += cost; costCount++; }
        const rep = replacement.get(String(b._id));
        const est = rep ? toTarget(rep.amount, rep.currency) : null;
        if (est != null) { estTotal += est; estCount++; bySource[rep.source]++; }
        rows.push({ b, cost, est, source: rep?.source || null });
      }

      // Gainers: real market signal only (paid-source estimates are the cost
      // itself and would always report a 0% "gain").
      const gainers = rows
        .filter((r) => r.cost != null && r.est != null && r.source !== 'paid' && r.est > r.cost)
        .map((r) => ({
          ...wineLabel(r.b),
          cost: round2(r.cost),
          estimated: round2(r.est),
          gain: round2(r.est - r.cost),
          gain_pct: Math.round(((r.est - r.cost) / r.cost) * 100),
          source: r.source,
        }))
        .sort((a, b) => b.gain - a.gain)
        .slice(0, 8);

      const holdings = rows
        .filter((r) => (r.est ?? r.cost) != null)
        .map((r) => ({ ...wineLabel(r.b), value: round2(r.est ?? r.cost), basis: r.est != null ? 'estimated' : 'cost' }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 8);

      // Value at risk: worth money AND in a closing window — drink or lose it.
      const profileMap = await buildProfileMap(activeBottles);
      let atRiskTotal = 0;
      const atRisk = [];
      for (const r of rows) {
        const status = classifyMaturity(r.b, profileMap);
        if (status !== 'declining' && status !== 'late') continue;
        const v = r.est ?? r.cost;
        if (v == null) continue;
        atRiskTotal += v;
        atRisk.push({ ...wineLabel(r.b), value: round2(v), status });
      }
      atRisk.sort((a, b) => b.value - a.value);

      // Concentration: how much of the portfolio the top 5 bottles carry.
      const totalKnown = rows.reduce((s, r) => s + (r.est ?? r.cost ?? 0), 0);
      const top5 = rows.map((r) => r.est ?? r.cost ?? 0).sort((a, b) => b - a).slice(0, 5).reduce((s, v) => s + v, 0);

      // Spend drunk this year (cost of bottles consumed since Jan 1).
      const yearStart = new Date(new Date().getFullYear(), 0, 1);
      let consumedCost = 0, consumedCount = 0;
      for (const b of consumedBottles) {
        if (!b.consumedAt || new Date(b.consumedAt) < yearStart) continue;
        consumedCount++;
        const v = toTarget(b.price, b.currency || 'USD');
        if (v != null) consumedCost += v;
      }

      // Trend from the weekly value snapshots (stored in USD) over the last year.
      let trend = null;
      const since = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
      const snaps = await CellarValueSnapshot.find({ user: userId, date: { $gte: since } })
        .select('date totalValue replacementValue').sort({ date: 1 }).lean();
      if (snaps.length >= 2) {
        const byDate = new Map();
        for (const s of snaps) {
          const cur = byDate.get(s.date) || { cost: 0, est: 0 };
          cur.cost += s.totalValue || 0;
          cur.est += s.replacementValue || s.totalValue || 0;
          byDate.set(s.date, cur);
        }
        const dates = [...byDate.keys()].sort();
        const first = byDate.get(dates[0]);
        const last = byDate.get(dates[dates.length - 1]);
        const conv = (v) => { const c = convertCurrency(v, 'USD', targetCurrency, rates); return c != null ? round2(c) : null; };
        trend = {
          from_date: dates[0],
          to_date: dates[dates.length - 1],
          cost_basis_from: conv(first.cost),
          cost_basis_to: conv(last.cost),
          replacement_from: conv(first.est),
          replacement_to: conv(last.est),
        };
      }

      // Per-cellar rollup on the resolved values (est where known, else cost).
      const cellarName = new Map(cellars.map((c) => [String(c._id), c.name]));
      const perCellar = new Map();
      for (const r of rows) {
        const key = String(r.b.cellar);
        const cur = perCellar.get(key) || { cellar: cellarName.get(key) || 'Unknown', bottles: 0, value: 0 };
        cur.bottles++;
        cur.value += r.est ?? r.cost ?? 0;
        perCellar.set(key, cur);
      }

      const data = {
        currency: targetCurrency,
        cost_basis: { total: round2(costTotal), priced_bottles: costCount, unpriced_bottles: activeBottles.length - costCount },
        replacement: {
          total: round2(estTotal),
          covered_bottles: estCount,
          by_source: bySource,
          note: 'secondary = sommelier market snapshot, currentRelease = community release price, paid = falls back to what the user paid',
        },
        unrealized_gain: round2(estTotal - costTotal),
        top_gainers: gainers,
        top_holdings: holdings,
        value_at_risk: { total: round2(atRiskTotal), bottles: atRisk.slice(0, 8) },
        concentration_top5_pct: totalKnown > 0 ? Math.round((top5 / totalKnown) * 100) : null,
        per_cellar: [...perCellar.values()].map((c) => ({ ...c, value: round2(c.value) })).sort((a, b) => b.value - a.value),
        consumed_this_year: { bottles: consumedCount, cost: round2(consumedCost) },
        trend,
      };
      return {
        summary: `Cost basis ${round2(costTotal)} ${targetCurrency}, est. replacement ${round2(estTotal)} ${targetCurrency}${atRisk.length ? `, ${round2(atRiskTotal)} at risk in closing windows` : ''}`,
        data,
      };
    });
    return ok(result.summary, result.data);
  },
});

module.exports = { loadPortfolio, WINE_TYPES };
