/**
 * Public vocabulary MCP tools (#985 Slice B) — get_wine_public_data,
 * suggest_wine_public_value, propose_registry_key, review_registry_data.
 *
 * Pins: scope split; delegation to the SHARED registryDataOps service; the
 * admin gate on review_registry_data; and the one-row-per-decision rule.
 */

jest.mock('../services/registryDataOps', () => ({
  dataForWine: jest.fn(), suggestValue: jest.fn(), proposeKey: jest.fn(),
  listReviewQueues: jest.fn(), decideKey: jest.fn(), decideValue: jest.fn(),
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), removeFromRacks: jest.fn(),
  RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  addBottle: jest.fn(), updateBottleFields: jest.fn(), removeBottleCascade: jest.fn(),
  UPDATABLE_FIELDS: ['price', 'currency', 'notes', 'occasion', 'rating', 'ratingScale', 'drinkFrom', 'drinkTo'],
}));

const ops = require('../services/registryDataOps');
const { allTools } = require('./registry');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const WINE = oid('b');
const KEY = oid('c');
const USER_CTX = { user: { id: ME, roles: ['user'] }, scopes: ['read', 'write'], req: { user: { id: ME }, headers: {} } };
const ADMIN_CTX = { user: { id: ME, roles: ['admin'] }, scopes: ['read', 'write'], req: { user: { id: ME }, headers: {} } };
const SOMM_CTX = { user: { id: ME, roles: ['somm'] }, scopes: ['read', 'write'], req: { user: { id: ME }, headers: {} } };

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

beforeEach(() => jest.clearAllMocks());

test('scopes: read for the getter, write for the rest; admin tool is STRUCTURALLY gated', () => {
  expect(tool('get_wine_public_data').scope).toBe('read');
  expect(tool('suggest_wine_public_value').scope).toBe('write');
  expect(tool('propose_registry_key').scope).toBe('write');
  expect(tool('review_registry_data').scope).toBe('write');
  // requireRole makes the tool invisible to non-admin connections (the
  // registry filters on it) — the pattern every admin tool follows.
  expect(tool('review_registry_data').requireRole).toEqual(['admin']);
});

test('get_wine_public_data passes roles (visibility) and surfaces any-pending + mine', async () => {
  ops.dataForWine.mockResolvedValue({
    ok: true,
    fields: [
      { key: { _id: KEY, name: 'ABV', type: 'decimal', unit: '%', enumOptions: null }, value: 13.5, contributedBy: 'kurt', hasPendingSuggestion: false, mySuggestion: null },
      { key: { _id: oid('e'), name: 'Organic', type: 'boolean', unit: null, enumOptions: null }, value: null, contributedBy: null, hasPendingSuggestion: true, mySuggestion: { value: true } },
    ],
  });
  const res = await tool('get_wine_public_data').handler({ wine_id: WINE }, USER_CTX);
  const body = parse(res);
  expect(ops.dataForWine).toHaveBeenCalledWith(WINE, ME, { roles: USER_CTX.user.roles });
  expect(body.data.fields[0]).toMatchObject({ key: 'ABV', value: 13.5, contributed_by: 'kurt', suggestion_pending: false });
  expect(body.data.fields[1]).toMatchObject({ value: null, suggestion_pending: true, my_pending_suggestion: true });
});

test('suggest_wine_public_value delegates and maps limit → rate_limited', async () => {
  ops.suggestValue.mockResolvedValue({ ok: true, value: { _id: oid('9'), key: { name: 'ABV', unit: '%' }, value: 13.5 } });
  await tool('suggest_wine_public_value').handler({ wine_id: WINE, key_id: KEY, value: 13.5 }, USER_CTX);
  expect(ops.suggestValue).toHaveBeenCalledWith(ME,
    expect.objectContaining({ wineId: WINE, keyId: KEY, value: 13.5 }),
    { via: 'mcp', req: USER_CTX.req });

  ops.suggestValue.mockResolvedValue({ ok: false, code: 'limit', message: 'cap' });
  const res = await tool('suggest_wine_public_value').handler({ wine_id: WINE, key_id: KEY, value: 13.5 }, USER_CTX);
  expect(parse(res).error.code).toBe('rate_limited');
});

test('propose_registry_key delegates with the full definition', async () => {
  ops.proposeKey.mockResolvedValue({ ok: true, key: { _id: KEY, name: 'ABV', type: 'decimal' } });
  await tool('propose_registry_key').handler({
    name: 'ABV', type: 'decimal', unit: '%', rationale: 'Alcohol strength matters.',
  }, USER_CTX);
  expect(ops.proposeKey).toHaveBeenCalledWith(ME,
    expect.objectContaining({ name: 'ABV', type: 'decimal', unit: '%' }),
    { via: 'mcp', req: USER_CTX.req });
});

describe('review_registry_data', () => {
  test('no ids → both queues', async () => {
    ops.listReviewQueues.mockResolvedValue({ ok: true, keys: [], values: [] });
    const res = await tool('review_registry_data').handler({}, ADMIN_CTX);
    expect(parse(res).data.proposed_keys).toEqual([]);
    expect(parse(res).data.suggested_values).toEqual([]);
  });

  test('decides one row per call; the SERVICE owns the decision vocabulary', async () => {
    ops.decideKey.mockResolvedValue({ ok: true, key: { _id: KEY, name: 'ABV', status: 'accepted' } });
    await tool('review_registry_data').handler({ key_id: KEY, decision: 'accept' }, ADMIN_CTX);
    expect(ops.decideKey).toHaveBeenCalledWith(ME, KEY, 'accept', undefined, { req: ADMIN_CTX.req });

    const both = await tool('review_registry_data').handler({ key_id: KEY, value_id: oid('9'), decision: 'accept' }, ADMIN_CTX);
    expect(both.isError).toBe(true);

    // Wrong per-kind verb: delegated to the service, whose invalid → invalid_input
    ops.decideValue.mockResolvedValue({ ok: false, code: 'invalid', message: "decision must be 'publish' or 'reject'" });
    const wrongVocab = await tool('review_registry_data').handler({ value_id: oid('9'), decision: 'accept' }, ADMIN_CTX);
    expect(parse(wrongVocab).error.code).toBe('invalid_input');
    expect(ops.decideValue).toHaveBeenCalledWith(ME, oid('9'), 'accept', undefined, { req: ADMIN_CTX.req });
  });
});

// ---------------------------------------------------------------------------
// Sommeliers review public wine data (Johan, 2026-08-23). The queue is fed by
// ordinary users and was gated to admin, so the project owner was clearing it
// by hand — the same bottleneck somm-owned wine data exists to remove.
// ---------------------------------------------------------------------------
describe('sommelier access to the review queues', () => {
  const { toolsForScopes } = require('./registry');

  test('the tool is visible to somm and admin, invisible to a plain user', () => {
    const named = (roles) => toolsForScopes(['read', 'write'], roles).map((t) => t.name);
    expect(named(['somm'])).toContain('review_registry_data');
    expect(named(['admin'])).toContain('review_registry_data');
    expect(named(['user'])).not.toContain('review_registry_data');
  });

  test('a somm can list both queues', async () => {
    ops.listReviewQueues.mockResolvedValue({ keys: [], values: [] });
    const res = await tool('review_registry_data').handler({}, SOMM_CTX);
    expect(parse(res).error).toBeUndefined();
    expect(ops.listReviewQueues).toHaveBeenCalled();
  });

  test('a somm can publish a suggested VALUE — ordinary wine curation', async () => {
    ops.decideValue.mockResolvedValue({ ok: true, value: { _id: oid('9'), status: 'published' } });
    const res = await tool('review_registry_data').handler(
      { value_id: oid('9'), decision: 'publish' }, SOMM_CTX);
    expect(parse(res).error).toBeUndefined();
    expect(ops.decideValue).toHaveBeenCalled();
  });

  test('a somm can accept a proposed KEY — the vocabulary decision, guided by the description', async () => {
    ops.decideKey.mockResolvedValue({ ok: true, key: { _id: KEY, name: 'ABV', status: 'accepted' } });
    const res = await tool('review_registry_data').handler(
      { key_id: KEY, decision: 'accept' }, SOMM_CTX);
    expect(parse(res).error).toBeUndefined();
    expect(ops.decideKey).toHaveBeenCalled();
  });

  test('the description tells the reviewer the two queues are judged differently', () => {
    const d = tool('review_registry_data').description;
    expect(d).toMatch(/JUDGE THE TWO QUEUES DIFFERENTLY/);
    expect(d).toMatch(/what the registry TRACKS AT ALL/);
    expect(d).not.toMatch(/ADMIN only/);
  });
});
