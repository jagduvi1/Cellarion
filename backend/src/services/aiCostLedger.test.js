/**
 * services/aiCostLedger — the AI spend ledger (2026-09-25).
 *
 * Pins: how a response's `usage` becomes counters (cache reads and the two
 * cache-write lifetimes are priced differently, so they must never be lumped
 * into input); the dollar estimate from list prices; that recording never
 * throws into the caller and does nothing without a database; and the
 * per-feature summary SuperAdmin reads, whose projection only ever averages
 * FULL days.
 */
jest.mock('mongoose', () => ({ connection: { readyState: 1 } }));
jest.mock('../models/AiCostStat', () => ({
  updateOne: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
}));

const mongoose = require('mongoose');
const AiCostStat = require('../models/AiCostStat');
const ledger = require('./aiCostLedger');

beforeEach(() => {
  jest.clearAllMocks();
  mongoose.connection.readyState = 1;
  AiCostStat.updateOne.mockResolvedValue({});
});

describe('usageIncrements', () => {
  test('uncached input, output, cache reads and both write lifetimes stay separate', () => {
    const inc = ledger.usageIncrements({
      input_tokens: 520,
      output_tokens: 180,
      cache_read_input_tokens: 1800,
      cache_creation_input_tokens: 900,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 900 },
      server_tool_use: { web_search_requests: 2 },
    });
    expect(inc).toEqual({
      calls: 1,
      inputTokens: 520,
      outputTokens: 180,
      cacheReadTokens: 1800,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 900,
      webSearches: 2,
    });
  });

  test('a write total without the per-lifetime split is priced as a 5-minute write', () => {
    const inc = ledger.usageIncrements({ input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 1500 });
    expect(inc.cacheWrite5mTokens).toBe(1500);
    expect(inc.cacheWrite1hTokens).toBe(0);
  });

  test('missing or junk fields count as zero (the OpenAI adapter reports only input/output)', () => {
    const inc = ledger.usageIncrements({ input_tokens: -3, output_tokens: 'x' });
    expect(inc).toMatchObject({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, webSearches: 0 });
  });
});

describe('estimateUsd', () => {
  test('Sonnet 5 at $2/$10 with cache reads at 0.1x and a 1-hour write at 2x', () => {
    const usd = ledger.estimateUsd({
      model: 'claude-sonnet-5',
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 1_000_000,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 1_000_000,
      webSearches: 0,
    });
    // 2 + 1 + 0.2 + 4
    expect(usd).toBeCloseTo(7.2, 6);
  });

  test('web searches cost $10 per thousand on top of tokens', () => {
    expect(ledger.estimateUsd({ model: 'claude-haiku-4-5-20251001', webSearches: 3 })).toBeCloseTo(0.03, 6);
  });

  test('a model without a known price is null, not zero', () => {
    expect(ledger.estimateUsd({ model: 'llama3.1:70b', inputTokens: 1000 })).toBeNull();
  });
});

describe('recordAiUsage', () => {
  test('upserts one row per day, feature and model with $inc counters and a TTL on insert', async () => {
    await ledger.recordAiUsage({
      feature: 'label_scan',
      model: 'claude-sonnet-5',
      usage: { input_tokens: 600, output_tokens: 150, cache_read_input_tokens: 1800 },
    });
    expect(AiCostStat.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update, opts] = AiCostStat.updateOne.mock.calls[0];
    expect(filter).toEqual({ date: new Date().toISOString().slice(0, 10), feature: 'label_scan', model: 'claude-sonnet-5' });
    expect(update.$inc).toMatchObject({ calls: 1, inputTokens: 600, outputTokens: 150, cacheReadTokens: 1800 });
    expect(update.$setOnInsert.expiresAt).toBeInstanceOf(Date);
    expect(opts).toEqual({ upsert: true });
  });

  test('does nothing without a database connection', async () => {
    mongoose.connection.readyState = 0;
    await ledger.recordAiUsage({ feature: 'chat', model: 'claude-sonnet-5', usage: { input_tokens: 1 } });
    expect(AiCostStat.updateOne).not.toHaveBeenCalled();
  });

  test('a response without usage records nothing', async () => {
    await ledger.recordAiUsage({ feature: 'chat', model: 'claude-sonnet-5', usage: undefined });
    expect(AiCostStat.updateOne).not.toHaveBeenCalled();
  });

  test('never rejects — a ledger failure must not cost a user their scan', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    AiCostStat.updateOne.mockRejectedValue(new Error('mongo down'));
    await expect(ledger.recordAiUsage({ feature: 'label_scan', model: 'm', usage: { input_tokens: 1 } })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('summarizeCosts', () => {
  const now = new Date('2026-09-25T12:00:00Z');
  const lean = (value) => ({ lean: async () => value });
  const firstRecorded = (date) => AiCostStat.findOne.mockReturnValue({ sort: () => lean(date ? { date } : null) });
  const row = (date, feature, extra = {}) => ({
    date, feature, model: 'claude-sonnet-5', calls: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, webSearches: 0, ...extra,
  });

  test('totals per feature, priced, sorted by spend, with the input total returned', async () => {
    firstRecorded('2026-09-10');
    AiCostStat.find.mockReturnValue(lean([
      row('2026-09-24', 'label_scan', { calls: 40, inputTokens: 100000, outputTokens: 8000 }),
      row('2026-09-25', 'label_scan', { calls: 10, inputTokens: 5000, outputTokens: 2000, cacheReadTokens: 15000, cacheWrite1hTokens: 1500 }),
      row('2026-09-25', 'import_identify', { calls: 2, inputTokens: 600, outputTokens: 300 }),
    ]));

    const out = await ledger.summarizeCosts({ days: 30, now });

    expect(AiCostStat.find).toHaveBeenCalledWith({ date: { $gte: '2026-08-27' } });
    expect(out.features.map((f) => f.feature)).toEqual(['label_scan', 'import_identify']);
    const scan = out.features[0];
    expect(scan.calls).toBe(50);
    // (105000*2 + 10000*10 + 15000*0.2 + 1500*4) / 1e6
    expect(scan.usd).toBeCloseTo(0.319, 4);
    expect(scan.usdPerCall).toBeCloseTo(0.00638, 5);
    expect(scan.inputTokensTotal).toBe(121500);
    expect(scan.cachedInputShare).toBe(0.123); // 15000 / 121500, to 3 places
    expect(scan.models).toEqual(['claude-sonnet-5']);
    expect(out.total.calls).toBe(52);
    expect(out.recordingSince).toBe('2026-09-10');
    expect(out.unpricedModels).toEqual([]);
  });

  test('the projection averages full days only — today is still running', async () => {
    firstRecorded('2026-09-01');
    AiCostStat.find.mockReturnValue(lean([
      row('2026-09-23', 'label_scan', { outputTokens: 100000 }), // $1.00
      row('2026-09-24', 'label_scan', { outputTokens: 100000 }), // $1.00
      row('2026-09-25', 'label_scan', { outputTokens: 10000 }),  // $0.10 so far today — left out
    ]));
    const out = await ledger.summarizeCosts({ days: 7, now });
    // 7-day window 09-19..09-25; full days 09-19..09-24 = 6 days, $2.00 → $10 per 30 days.
    expect(out.projectedUsdPer30Days).toBe(10);
  });

  test('the ledger\'s first day began at the deploy, so it is left out of the projection too', async () => {
    firstRecorded('2026-09-23');
    AiCostStat.find.mockReturnValue(lean([
      row('2026-09-23', 'label_scan', { outputTokens: 20000 }),  // partial first day
      row('2026-09-24', 'label_scan', { outputTokens: 100000 }), // the one full day: $1.00
      row('2026-09-25', 'label_scan', { outputTokens: 50000 }),  // today
    ]));
    const out = await ledger.summarizeCosts({ days: 30, now });
    expect(out.projectedUsdPer30Days).toBe(30);
  });

  test('with no full day yet there is no projection', async () => {
    firstRecorded('2026-09-25');
    AiCostStat.find.mockReturnValue(lean([row('2026-09-25', 'label_scan', { outputTokens: 50000 })]));
    expect((await ledger.summarizeCosts({ days: 30, now })).projectedUsdPer30Days).toBeNull();
    firstRecorded('2026-09-01');
    expect((await ledger.summarizeCosts({ days: 1, now })).projectedUsdPer30Days).toBeNull();
  });

  test('an unpriced model is listed, and counts nothing toward the dollars', async () => {
    firstRecorded('2026-09-25');
    AiCostStat.find.mockReturnValue(lean([
      { ...row('2026-09-25', 'chat', { calls: 3, inputTokens: 900, outputTokens: 300 }), model: 'llama3.1' },
    ]));
    const out = await ledger.summarizeCosts({ days: 7, now });
    expect(out.unpricedModels).toEqual(['llama3.1']);
    expect(out.total.usd).toBe(0);
  });

  test('the window is clamped to 1–400 days, and a missing one means 30', async () => {
    firstRecorded(null);
    AiCostStat.find.mockReturnValue(lean([]));
    expect((await ledger.summarizeCosts({ days: 0, now })).days).toBe(1);
    expect((await ledger.summarizeCosts({ days: -5, now })).days).toBe(1);
    expect((await ledger.summarizeCosts({ days: 5000, now })).days).toBe(400);
    expect((await ledger.summarizeCosts({ days: 'abc', now })).days).toBe(30);
    expect((await ledger.summarizeCosts({ now })).days).toBe(30);
  });
});
