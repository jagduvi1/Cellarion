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

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

beforeEach(() => jest.clearAllMocks());

test('scopes: read for the getter, write for the rest', () => {
  expect(tool('get_wine_public_data').scope).toBe('read');
  expect(tool('suggest_wine_public_value').scope).toBe('write');
  expect(tool('propose_registry_key').scope).toBe('write');
  expect(tool('review_registry_data').scope).toBe('write');
});

test('get_wine_public_data returns fields with blanks and my pending suggestion', async () => {
  ops.dataForWine.mockResolvedValue({
    ok: true,
    fields: [
      { key: { _id: KEY, name: 'ABV', type: 'decimal', unit: '%', enumOptions: null }, value: 13.5, contributedBy: 'kurt', mySuggestion: null },
      { key: { _id: oid('e'), name: 'Organic', type: 'boolean', unit: null, enumOptions: null }, value: null, contributedBy: null, mySuggestion: { value: true } },
    ],
  });
  const res = await tool('get_wine_public_data').handler({ wine_id: WINE }, USER_CTX);
  const body = parse(res);
  expect(ops.dataForWine).toHaveBeenCalledWith(WINE, ME);
  expect(body.data.fields[0]).toMatchObject({ key: 'ABV', value: 13.5, contributed_by: 'kurt' });
  expect(body.data.fields[1]).toMatchObject({ value: null, my_pending_suggestion: true });
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
  test('non-admin is refused before any service call', async () => {
    const res = await tool('review_registry_data').handler({}, USER_CTX);
    expect(parse(res).error.code).toBe('forbidden_scope');
    expect(ops.listReviewQueues).not.toHaveBeenCalled();
  });

  test('no ids → both queues', async () => {
    ops.listReviewQueues.mockResolvedValue({ ok: true, keys: [], values: [] });
    const res = await tool('review_registry_data').handler({}, ADMIN_CTX);
    expect(parse(res).data.proposed_keys).toEqual([]);
    expect(parse(res).data.suggested_values).toEqual([]);
  });

  test('decides one row per call, with per-kind decision vocabulary', async () => {
    ops.decideKey.mockResolvedValue({ ok: true, key: { _id: KEY, name: 'ABV', status: 'accepted' } });
    await tool('review_registry_data').handler({ key_id: KEY, decision: 'accept' }, ADMIN_CTX);
    expect(ops.decideKey).toHaveBeenCalledWith(ME, KEY, 'accept', undefined, { req: ADMIN_CTX.req });

    const both = await tool('review_registry_data').handler({ key_id: KEY, value_id: oid('9'), decision: 'accept' }, ADMIN_CTX);
    expect(both.isError).toBe(true);

    const wrongVocab = await tool('review_registry_data').handler({ value_id: oid('9'), decision: 'accept' }, ADMIN_CTX);
    expect(parse(wrongVocab).error.code).toBe('invalid_input');
    expect(ops.decideValue).not.toHaveBeenCalled();
  });
});
