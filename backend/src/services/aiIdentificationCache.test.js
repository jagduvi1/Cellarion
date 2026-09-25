/**
 * services/aiIdentificationCache — the import lookup's answer memory
 * (2026-09-25).
 *
 * Pins: only a definite answer is remembered (an identification, or the
 * model's "unknown" — never a transport error or a parse failure a fresh call
 * could answer differently); the key follows the exact text the prompt sees
 * plus the model and prompt, so a configuration change never serves a stale
 * answer; the vintage is not part of the key (one lookup per wine, like the
 * import's own dedup); and without a database it stays out of the way.
 */
jest.mock('../models/AiIdentificationCache', () => ({
  findOne: jest.fn(),
  updateOne: jest.fn(),
}));
jest.mock('../config/aiConfig', () => ({ get: jest.fn() }));
jest.mock('./aiCostLedger', () => ({ recordReusedAnswer: jest.fn() }));

const AiIdentificationCache = require('../models/AiIdentificationCache');
const aiConfig = require('../config/aiConfig');
const { recordReusedAnswer } = require('./aiCostLedger');
const cache = require('./aiIdentificationCache');

const ROW = { name: 'Pingus', producer: 'Dominio de Pingus', vintage: '2015', country: 'Spain', appellation: 'Ribera del Duero', region: '' };
const ANSWER = { data: { name: 'Pingus', producer: 'Dominio de Pingus', grapes: [] }, debugRaw: '{"name":"Pingus"}', debugReason: null };

beforeEach(() => {
  jest.clearAllMocks();
  aiConfig.get.mockReturnValue({ importLookupModel: 'claude-sonnet-5', importLookupPrompt: 'TEMPLATE v1' });
  AiIdentificationCache.updateOne.mockResolvedValue({});
  cache._setDbReadyCheckForTests(() => true);
});

describe('keyFor', () => {
  test('the vintage is not part of the key; every hint is', () => {
    expect(cache.keyFor({ ...ROW, vintage: '2019' })).toBe(cache.keyFor(ROW));
    expect(cache.keyFor({ ...ROW, appellation: 'Toro' })).not.toBe(cache.keyFor(ROW));
    expect(cache.keyFor({ ...ROW, country: '' })).not.toBe(cache.keyFor(ROW));
  });

  test('the exact text matters — case is not folded, only the prompt\'s own whitespace cleaning applies', () => {
    expect(cache.keyFor({ ...ROW, name: '  Pingus \n' })).toBe(cache.keyFor(ROW));
    expect(cache.keyFor({ ...ROW, name: 'PINGUS' })).not.toBe(cache.keyFor(ROW));
  });

  test('a different model or prompt template is a different key', () => {
    const before = cache.keyFor(ROW);
    aiConfig.get.mockReturnValue({ importLookupModel: 'claude-haiku-4-5-20251001', importLookupPrompt: 'TEMPLATE v1' });
    expect(cache.keyFor(ROW)).not.toBe(before);
    aiConfig.get.mockReturnValue({ importLookupModel: 'claude-sonnet-5', importLookupPrompt: 'TEMPLATE v2' });
    expect(cache.keyFor(ROW)).not.toBe(before);
  });
});

describe('lookupIdentification', () => {
  const found = (doc) => AiIdentificationCache.findOne.mockReturnValue({ lean: async () => doc });

  test('a remembered answer comes back in identifyWineFromText\'s shape and is counted as reused', async () => {
    found({ data: ANSWER.data, debugRaw: ANSWER.debugRaw, debugReason: null });
    const res = await cache.lookupIdentification(ROW);
    expect(res).toEqual(ANSWER);
    expect(AiIdentificationCache.findOne).toHaveBeenCalledWith({ key: cache.keyFor(ROW), expiresAt: { $gt: expect.any(Date) } });
    expect(recordReusedAnswer).toHaveBeenCalledWith({ feature: 'import_identify', model: 'claude-sonnet-5' });
  });

  test('a remembered "unknown" comes back as the no-match it was', async () => {
    found({ data: null, debugRaw: '{"error":"unknown"}', debugReason: 'ai_unknown: unknown' });
    const res = await cache.lookupIdentification(ROW);
    expect(res).toEqual({ data: null, debugRaw: '{"error":"unknown"}', debugReason: 'ai_unknown: unknown' });
  });

  test('a miss is null and counts nothing', async () => {
    found(null);
    expect(await cache.lookupIdentification(ROW)).toBeNull();
    expect(recordReusedAnswer).not.toHaveBeenCalled();
  });

  test('without a database it never queries', async () => {
    cache._setDbReadyCheckForTests(() => false);
    expect(await cache.lookupIdentification(ROW)).toBeNull();
    expect(AiIdentificationCache.findOne).not.toHaveBeenCalled();
  });

  test('a lookup error is a miss, never a failure', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    AiIdentificationCache.findOne.mockReturnValue({ lean: async () => { throw new Error('mongo down'); } });
    expect(await cache.lookupIdentification(ROW)).toBeNull();
    warn.mockRestore();
  });
});

describe('rememberIdentification', () => {
  test('an identification is stored under the row\'s key with a 90-day expiry', async () => {
    await cache.rememberIdentification(ROW, ANSWER);
    const [filter, update, opts] = AiIdentificationCache.updateOne.mock.calls[0];
    expect(filter).toEqual({ key: cache.keyFor(ROW) });
    expect(update.$set).toMatchObject({ data: ANSWER.data, debugRaw: ANSWER.debugRaw, debugReason: null });
    const days = (update.$set.expiresAt - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThanOrEqual(90);
    expect(opts).toEqual({ upsert: true });
  });

  test('the model\'s definite "unknown" is remembered too', async () => {
    await cache.rememberIdentification(ROW, { data: null, debugRaw: '{"error":"unknown"}', debugReason: 'ai_unknown: unknown' });
    expect(AiIdentificationCache.updateOne).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['a transport error', 'exception: socket hang up'],
    ['a rate limit', 'rate_limit_exceeded'],
    ['a parse failure', 'parse_error: Unexpected token'],
    ['an answer missing its name', 'missing_name_or_producer_in_response'],
  ])('%s is never remembered — a fresh call could answer differently', async (_label, reason) => {
    await cache.rememberIdentification(ROW, { data: null, debugRaw: 'x', debugReason: reason });
    expect(AiIdentificationCache.updateOne).not.toHaveBeenCalled();
  });

  test('the raw answer is bounded', async () => {
    await cache.rememberIdentification(ROW, { ...ANSWER, debugRaw: 'y'.repeat(10000) });
    expect(AiIdentificationCache.updateOne.mock.calls[0][1].$set.debugRaw).toHaveLength(4000);
  });

  test('a concurrent write of the same key is fine; other errors never reach the import', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    AiIdentificationCache.updateOne.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }));
    await expect(cache.rememberIdentification(ROW, ANSWER)).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    AiIdentificationCache.updateOne.mockRejectedValueOnce(new Error('mongo down'));
    await expect(cache.rememberIdentification(ROW, ANSWER)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('without a database it never writes', async () => {
    cache._setDbReadyCheckForTests(() => false);
    await cache.rememberIdentification(ROW, ANSWER);
    expect(AiIdentificationCache.updateOne).not.toHaveBeenCalled();
  });
});
