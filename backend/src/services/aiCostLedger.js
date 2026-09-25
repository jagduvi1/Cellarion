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
 * (unit tests with mocked models, a brief Mongo outage), for the same reason.
 *
 * The dollar figures are ESTIMATES from list prices. The Anthropic console is
 * the bill; this is for seeing where it goes and whether a change moved it.
 */
const mongoose = require('mongoose');
const AiCostStat = require('../models/AiCostStat');

// Anthropic list prices, USD per million tokens — platform.claude.com pricing,
// checked 2026-09-25 (Sonnet 5 kept its $2/$10 launch price; the increase
// scheduled for 2026-09-01 was cancelled). Keys are the model ids aiConfig
// stores. A model missing here (a self-hosted AI_PROVIDER=openai install) is
// recorded but not priced.
const PRICES_CHECKED_AT = '2026-09-25';
const PRICES_PER_MTOK = {
  'claude-sonnet-5':           { input: 2, output: 10 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'claude-haiku-4-5':          { input: 1, output: 5 },
  'claude-sonnet-4-6':         { input: 3, output: 15 },
  'claude-sonnet-4-5':         { input: 3, output: 15 },
  'claude-opus-4-6':           { input: 5, output: 25 },
  'claude-opus-4-8':           { input: 5, output: 25 },
  'claude-opus-5':             { input: 5, output: 25 },
  'claude-opus-5-5':           { input: 4, output: 20 },
};
// Prompt-cache multipliers on the input price (standard for these models).
const CACHE_READ = 0.1;
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const WEB_SEARCH_USD = 10 / 1000; // $10 per 1,000 searches

const RETENTION_DAYS = 400;
const MAX_SUMMARY_DAYS = 400;
const DAY_MS = 86400000;
const COUNTERS = ['calls', 'inputTokens', 'outputTokens', 'cacheReadTokens',
  'cacheWrite5mTokens', 'cacheWrite1hTokens', 'webSearches', 'reused'];

let isDbReady = () => mongoose.connection.readyState === 1;

const todayUTC = (now = new Date()) => now.toISOString().slice(0, 10);
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
const round = (v, places = 4) => Math.round(v * 10 ** places) / 10 ** places;

/** The $inc for one completed call, from the API's `usage` object. */
function usageIncrements(usage) {
  const split = usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : null;
  const write1h = split ? count(split.ephemeral_1h_input_tokens) : 0;
  // The per-TTL split arrives in usage.cache_creation. A response without it
  // (an older API shape, the OpenAI adapter) carries only the total, which is
  // priced as a 5-minute write — the cheaper assumption, never the dearer one.
  const write5m = split && split.ephemeral_5m_input_tokens !== undefined
    ? count(split.ephemeral_5m_input_tokens)
    : Math.max(0, count(usage.cache_creation_input_tokens) - write1h);
  return {
    calls: 1,
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens),
    cacheWrite5mTokens: write5m,
    cacheWrite1hTokens: write1h,
    webSearches: count(usage.server_tool_use && usage.server_tool_use.web_search_requests),
  };
}

async function bump(feature, model, inc, now = new Date()) {
  if (!isDbReady()) return;
  const filter = {
    date: todayUTC(now),
    feature: String(feature || 'other').slice(0, 64),
    model: String(model || 'unknown').slice(0, 100),
  };
  const update = { $inc: inc, $setOnInsert: { expiresAt: new Date(now.getTime() + RETENTION_DAYS * DAY_MS) } };
  try {
    await AiCostStat.updateOne(filter, update, { upsert: true });
  } catch (err) {
    let failure = err;
    // Two first calls of the day racing the upsert: the loser hits the unique
    // index. The row exists by then, so a plain increment lands.
    if (err && err.code === 11000) {
      try {
        await AiCostStat.updateOne(filter, { $inc: inc });
        return;
      } catch (retryErr) {
        failure = retryErr;
      }
    }
    console.warn('[aiCostLedger] could not record AI usage (non-fatal):', failure && failure.message);
  }
}

/**
 * Record one completed call. `feature` names what the call was for
 * ('label_scan', 'import_identify', …); `usage` is the response's usage object.
 * Never throws.
 */
function recordAiUsage({ feature, model, usage } = {}) {
  if (!usage || typeof usage !== 'object') return Promise.resolve();
  return bump(feature, model, usageIncrements(usage));
}

/** Record an answer served from memory instead of a call (it cost nothing). */
function recordReusedAnswer({ feature, model } = {}) {
  return bump(feature, model, { reused: 1 });
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

/**
 * Per-feature and per-day totals over the last `days` UTC days (today
 * included), with estimated dollars.
 *
 * `projectedUsdPer30Days` averages over the days the ledger has actually been
 * recording — not the whole window, which would read low for the first weeks
 * after the ledger shipped.
 */
async function summarizeCosts({ days = 30, now = new Date() } = {}) {
  const span = Math.min(Math.max(parseInt(days, 10) || 30, 1), MAX_SUMMARY_DAYS);
  const since = todayUTC(new Date(now.getTime() - (span - 1) * DAY_MS));
  const rows = await AiCostStat.find({ date: { $gte: since } }).lean();

  const byFeature = new Map();
  const byDay = new Map();
  const total = { ...blankCounters(), usd: 0 };
  const unpriced = new Set();

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

    const day = byDay.get(row.date) || { date: row.date, calls: 0, reused: 0, usd: 0 };
    day.calls += row.calls || 0;
    day.reused += row.reused || 0;
    day.usd += usd || 0;
    byDay.set(row.date, day);
  }

  const inputTotal = (f) => f.inputTokens + f.cacheReadTokens + f.cacheWrite5mTokens + f.cacheWrite1hTokens;
  const features = [...byFeature.values()]
    .map((f) => ({
      ...f,
      models: [...f.models].sort(),
      usd: round(f.usd),
      usdPerCall: f.calls > 0 ? round(f.usd / f.calls, 6) : null,
      // Share of this feature's input that was read from the prompt cache.
      cachedInputShare: inputTotal(f) > 0 ? round(f.cacheReadTokens / inputTotal(f), 3) : null,
    }))
    .sort((a, b) => b.usd - a.usd || b.calls - a.calls);

  const daily = [...byDay.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ ...d, usd: round(d.usd) }));

  const firstDate = daily.length ? daily[0].date : null;
  const recordingDays = firstDate
    ? Math.floor((Date.parse(todayUTC(now)) - Date.parse(firstDate)) / DAY_MS) + 1
    : 0;

  return {
    days: span,
    since,
    features,
    daily,
    total: { ...total, usd: round(total.usd) },
    recordingSince: firstDate,
    projectedUsdPer30Days: recordingDays > 0 ? round((total.usd / recordingDays) * 30, 2) : null,
    unpricedModels: [...unpriced].sort(),
    pricesCheckedAt: PRICES_CHECKED_AT,
  };
}

/** Test hook — replace the database-readiness check. */
function _setDbReadyCheckForTests(fn) {
  isDbReady = fn;
}

module.exports = {
  recordAiUsage,
  recordReusedAnswer,
  estimateUsd,
  summarizeCosts,
  usageIncrements,
  PRICES_PER_MTOK,
  _setDbReadyCheckForTests,
};
