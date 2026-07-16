// Portfolio-intelligence read tools (plan Phase 3): cellar_health_check,
// find_gaps, value_report. All three follow the §5.2 cost rule — they return
// STRUCTURED analysis for the calling model to reason over; no LLM runs here,
// so every call is $0 to Cellarion.
//
// The computations live in services/insightsService.js — ONE implementation
// shared with any future UI page (one-impl rule, like statsService). This file
// is only the MCP adapter: zod schemas, descriptions, the per-user TTL cache
// (automated callers repeat identical questions; a 60s stale window is
// irrelevant for portfolio numbers) and the ok() envelope.
//
// insightsService is lazy-required inside handlers: it pulls statsService →
// exchangeRates at require time, which stays off the registry's load path
// (same pattern as stats.js).
const { z } = require('zod');
const { registerTool } = require('../registry');
const { ok } = require('../toolUtil');

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

const CURRENCY_ARG = {
  currency: z.string().regex(/^[A-Za-z]{3}$/, 'ISO 4217 code').optional().describe('ISO 4217 override; defaults to the user\'s preference'),
};

const asEnvelope = (r) => ok(r.summary, r.data, r.warnings ? { warnings: r.warnings } : {});

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
  inputSchema: CURRENCY_ARG,
  handler: async (args, ctx) => {
    const { computeHealthCheck } = require('../../services/insightsService');
    const userId = String(ctx.user.id);
    const result = await cached('health', userId, (args.currency || 'pref').toUpperCase(),
      () => computeHealthCheck(userId, args.currency));
    return asEnvelope(result);
  },
});

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
  inputSchema: CURRENCY_ARG,
  handler: async (args, ctx) => {
    const { computeGaps } = require('../../services/insightsService');
    const userId = String(ctx.user.id);
    const result = await cached('gaps', userId, (args.currency || 'pref').toUpperCase(),
      () => computeGaps(userId, args.currency));
    return asEnvelope(result);
  },
});

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
  inputSchema: CURRENCY_ARG,
  handler: async (args, ctx) => {
    const { computeValueReport } = require('../../services/insightsService');
    const userId = String(ctx.user.id);
    const result = await cached('value', userId, (args.currency || 'pref').toUpperCase(),
      () => computeValueReport(userId, args.currency));
    return asEnvelope(result);
  },
});

module.exports = {};
