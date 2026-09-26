/**
 * AI spend ledger (2026-09-25) — records what every Claude call actually used,
 * and turns it into dollars for SuperAdmin → AI.
 *
 * Why: the AI bill is the platform's largest running cost, yet only Cellar Chat
 * ever recorded tokens. Every other call — label scans, import identification,
 * wine profiles — could only be estimated from prompt lengths, so a change meant
 * to lower the bill (prompt caching, a cheaper model) could not be measured.
 *
 * Recording is fire-and-forget and never fails the caller: a ledger outage must
 * not cost a user their scan. It is a no-op without a live database connection
 * (unit tests with mocked models, a brief Mongo outage), for the same reason —
 * the same rule as McpUsageStat.record.
 *
 * The dollar figures are ESTIMATES from list prices. The Anthropic console is
 * the bill; this is for seeing where it goes and whether a change moved it.
 */
const mongoose = require('mongoose');
const AiCostStat = require('../models/AiCostStat');

// Anthropic list prices, USD per million tokens — platform.claude.com pricing,
// checked 2026-09-25 (Sonnet 5 kept its $2/$10 launch price; the increase
// scheduled for 2026-09-01 was cancelled). One entry per model aiConfig can
// select (VALID_CHAT_MODELS). A model missing here (a self-hosted
// AI_PROVIDER=openai install) is recorded but not priced.
const PRICES_CHECKED_AT = '2026-09-25';
const PRICES_PER_MTOK = {
  'claude-sonnet-5':           { input: 2, output: 10 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'claude-sonnet-4-6':         { input: 3, output: 15 },
  'claude-opus-4-6':           { input: 5, output: 25 },
  'claude-opus-4-8':           { input: 5, output: 25 },
};
// Prompt-cache multipliers on the input price, the same for every model above.
const CACHE_READ = 0.1;
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const WEB_SEARCH_USD = 10 / 1000; // $10 per 1,000 searches

const RETENTION_DAYS = 400;
const MAX_SUMMARY_DAYS = 400;
const DAY_MS = 86400000;
const COUNTERS = ['calls', 'inputTokens', 'outputTokens', 'cacheReadTokens',
  'cacheWrite5mTokens', 'cacheWrite1hTokens', 'webSearches'];

const todayUTC = (now = new Date()) => now.toISOString().slice(0, 10);
const addDays = (date, n) => todayUTC(new Date(Date.parse(date) + n * DAY_MS));
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
const round = (v, places = 4) => Math.round(v * 10 ** places) / 10 ** places;

/**
 * The $inc for one completed call, from the API's `usage` object. The cache
 * write total is split by lifetime in usage.cache_creation; a response without
 * the split (the OpenAI adapter) prices its total as a 5-minute write.
 */
function usageIncrements(usage) {
  const write1h = count(usage.cache_creation && usage.cache_creation.ephemeral_1h_input_tokens);
  return {
    calls: 1,
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens),
    cacheWrite5mTokens: Math.max(0, count(usage.cache_creation_input_tokens) - write1h),
    cacheWrite1hTokens: write1h,
    webSearches: count(usage.server_tool_use && usage.server_tool_use.web_search_requests),
  };
}

/**
 * Record one completed call. `feature` names what the call was for
 * ('label_scan', 'import_identify', …); `usage` is the response's usage object.
 * Never throws; the returned promise never rejects.
 */
function recordAiUsage({ feature, model, usage } = {}) {
  if (!usage || typeof usage !== 'object' || mongoose.connection.readyState !== 1) return Promise.resolve();
  const now = new Date();
  return AiCostStat.updateOne(
    {
      date: todayUTC(now),
      feature: String(feature || 'other').slice(0, 64),
      model: String(model || 'unknown').slice(0, 100),
    },
    { $inc: usageIncrements(usage), $setOnInsert: { expiresAt: new Date(now.getTime() + RETENTION_DAYS * DAY_MS) } },
    { upsert: true }
  ).then(() => undefined, (err) => {
    console.warn('[aiCostLedger] could not record AI usage (non-fatal):', err.message);
  });
}

/** Estimated USD for a ledger row, or null when the model has no known price. */
function estimateUsd(row) {
  const price = PRICES_PER_MTOK[row.model];
  if (!price) return null;
  const perMillion =
      (row.inputTokens || 0) * price.input
    + (row.outputTokens || 0) * price.output
    + (row.cacheReadTokens || 0) * price.input * CACHE_READ
    + (row.cacheWrite5mTokens || 0) * price.input * CACHE_WRITE_5M
    + (row.cacheWrite1hTokens || 0) * price.input * CACHE_WRITE_1H;
  return perMillion / 1e6 + (row.webSearches || 0) * WEB_SEARCH_USD;
}

const blankCounters = () => Object.fromEntries(COUNTERS.map((k) => [k, 0]));
const inputTotal = (f) => f.inputTokens + f.cacheReadTokens + f.cacheWrite5mTokens + f.cacheWrite1hTokens;

/**
 * Per-feature totals over the last `days` UTC days (today included), with
 * estimated dollars.
 *
 * `projectedUsdPer30Days` is the average of the FULL days in the window only:
 * today is still running, and the ledger's first day began at the deploy, so
 * counting either as a whole day would understate the rate. With no full day
 * yet it is null.
 */
async function summarizeCosts({ days = 30, now = new Date() } = {}) {
  const parsed = parseInt(days, 10);
  const span = Math.min(Math.max(Number.isNaN(parsed) ? 30 : parsed, 1), MAX_SUMMARY_DAYS);
  const today = todayUTC(now);
  const since = addDays(today, -(span - 1));

  const [rows, first] = await Promise.all([
    AiCostStat.find({ date: { $gte: since } }).lean(),
    AiCostStat.findOne({}, { date: 1 }).sort({ date: 1 }).lean(),
  ]);
  const recordingSince = first ? first.date : null;

  const byFeature = new Map();
  const total = { ...blankCounters(), usd: 0 };
  const unpriced = new Set();
  // Full days: after the ledger's (partial) first day, before today (running).
  const fullFrom = recordingSince && recordingSince >= since ? addDays(recordingSince, 1) : since;
  let fullDaysUsd = 0;

  for (const row of rows) {
    const usd = estimateUsd(row);
    if (usd === null && row.calls > 0) unpriced.add(row.model);

    const feature = byFeature.get(row.feature) || { feature: row.feature, ...blankCounters(), usd: 0, models: new Set() };
    for (const k of COUNTERS) {
      feature[k] += row[k] || 0;
      total[k] += row[k] || 0;
    }
    feature.usd += usd || 0;
    total.usd += usd || 0;
    if (row.calls > 0) feature.models.add(row.model);
    byFeature.set(row.feature, feature);

    if (row.date >= fullFrom && row.date < today) fullDaysUsd += usd || 0;
  }

  const features = [...byFeature.values()]
    .map((f) => ({
      ...f,
      models: [...f.models].sort(),
      inputTokensTotal: inputTotal(f),
      usd: round(f.usd),
      usdPerCall: f.calls > 0 ? round(f.usd / f.calls, 6) : null,
      // Share of this feature's input that was read from the prompt cache.
      cachedInputShare: inputTotal(f) > 0 ? round(f.cacheReadTokens / inputTotal(f), 3) : null,
    }))
    .sort((a, b) => b.usd - a.usd || b.calls - a.calls);

  const fullDays = fullFrom < today ? Math.round((Date.parse(today) - Date.parse(fullFrom)) / DAY_MS) : 0;

  return {
    days: span,
    since,
    features,
    total: { ...total, usd: round(total.usd) },
    recordingSince,
    projectedUsdPer30Days: fullDays > 0 ? round((fullDaysUsd / fullDays) * 30, 2) : null,
    unpricedModels: [...unpriced].sort(),
    pricesCheckedAt: PRICES_CHECKED_AT,
  };
}

module.exports = { recordAiUsage, estimateUsd, summarizeCosts, usageIncrements };
