/**
 * suggest_wine_correction MCP tool (#985 Slice A) — the regular-user
 * counterpart of the sommelier's propose_wine_correction.
 *
 * Pins: write scope; delegation to the SHARED wineProposalOps service
 * (semantics tested there, drift prevented here); and the service-code →
 * MCP fail-code mapping (limit → rate_limited, conflict → conflict).
 */

jest.mock('../services/wineProposalOps', () => ({
  createFieldCorrection: jest.fn(),
  listMineForWine: jest.fn(),
  pendingForWine: jest.fn(),
  FIELDS: ['producer', 'name', 'appellation', 'region', 'country', 'classification'],
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
// revert.js and tools/write.js top-require bottleOps (search/meili chain) —
// same load-time mock as every other MCP tool suite.
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), removeFromRacks: jest.fn(),
  RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  addBottle: jest.fn(), updateBottleFields: jest.fn(), removeBottleCascade: jest.fn(),
  UPDATABLE_FIELDS: ['price', 'currency', 'notes', 'occasion', 'rating', 'ratingScale', 'drinkFrom', 'drinkTo'],
}));

const ops = require('../services/wineProposalOps');
const { allTools } = require('./registry');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const WINE = oid('b');
const CTX = { user: { id: ME, roles: ['user'] }, scopes: ['read', 'write'], req: { user: { id: ME }, headers: {} } };

const tool = () => allTools().find((t) => t.name === 'suggest_wine_correction');
const parse = (res) => JSON.parse(res.content[0].text);

beforeEach(() => jest.clearAllMocks());

test('accepts type and grapes alongside the identity fields (support ticket 2026-09-06)', () => {
  const shape = tool().inputSchema.fields.shape;
  expect(Object.keys(shape)).toEqual(expect.arrayContaining(['producer', 'name', 'appellation', 'region', 'country', 'classification', 'type', 'grapes']));
  expect(shape.type.safeParse('white').success).toBe(true);
  expect(shape.type.safeParse('orange').success).toBe(false);
  expect(shape.grapes.safeParse(['Pinot Noir', 'Muscaris']).success).toBe(true);
  expect(shape.grapes.safeParse([]).success).toBe(false);
});

test('registered as a write tool for regular users (no somm gate)', () => {
  expect(tool().scope).toBe('write');
});

test('delegates to the shared service with the caller identity and via mcp', async () => {
  ops.createFieldCorrection.mockResolvedValue({
    ok: true,
    proposal: { _id: oid('9'), proposedFields: { appellation: 'Marlborough GI' } },
    wine: { producer: 'Cloudy Bay', name: 'Sauvignon Blanc' },
  });
  const res = await tool().handler({
    wine_id: WINE,
    fields: { appellation: 'Marlborough GI' },
    reason: 'Printed on the back label.',
    evidence_url: 'https://example.com/x',
  }, CTX);

  expect(ops.createFieldCorrection).toHaveBeenCalledWith(
    ME,
    { wineId: WINE, fields: { appellation: 'Marlborough GI' }, reason: 'Printed on the back label.', evidenceUrl: 'https://example.com/x' },
    { via: 'mcp', req: CTX.req }
  );
  const body = parse(res);
  expect(body.data.proposal_id).toBe(oid('9'));
  expect(body.data.amended).toBe(false);
  expect(body.summary).toContain('admin will review');
});

// Support ticket 2026-09-12: filing on one's own pending suggestion amends it.
test('an amended own suggestion is reported as such, with the full field set', async () => {
  ops.createFieldCorrection.mockResolvedValue({
    ok: true,
    amended: true,
    amendedFields: ['grapes'],
    proposal: { _id: oid('7'), amendments: [{ fields: ['grapes'] }], proposedFields: { toObject: () => ({ name: 'Château Martinat', grapes: ['Merlot', 'Malbec'] }) } },
    wine: { producer: 'Chateau Martinat', name: 'Grand Vin de Bordeaux' },
  });
  const res = await tool().handler({ wine_id: WINE, fields: { grapes: ['Merlot', 'Malbec'] }, reason: 'Importer data sheet.' }, CTX);
  const body = parse(res);
  expect(res.isError).toBeFalsy();
  expect(body.summary).toMatch(/amended with grapes/);
  expect(body.summary).toMatch(/now covers name, grapes/);
  expect(body.data).toMatchObject({ proposal_id: oid('7'), amended: true, fields: ['name', 'grapes'], status: 'pending', amendments: 1 });
  expect(body.data.note).toMatch(/no daily budget/);
});

test('a conflict carries the MCP-only pointer to get_wine, added by the transport', async () => {
  ops.createFieldCorrection.mockResolvedValue({ ok: false, code: 'conflict', message: 'Filed by another user.' });
  const res = await tool().handler({ wine_id: WINE, fields: { name: 'x' }, reason: 'long enough reason' }, CTX);
  expect(parse(res).error.message).toBe('Filed by another user. get_wine → pending_correction shows which fields it covers.');
});

test('the description states the per-wine (not per-user) limit and the amend rule', () => {
  expect(tool().description).toMatch(/ONE pending suggestion per wine, across ALL users/);
  expect(tool().description).toMatch(/AMENDS/);
  expect(tool().description).toMatch(/pending_correction/);
});

test.each([
  ['limit', 'rate_limited'],
  ['conflict', 'conflict'],
  ['banned', 'forbidden_scope'],
  ['not_found', 'not_found'],
  ['invalid', 'invalid_input'],
])('service code %s maps to MCP %s', async (svcCode, mcpCode) => {
  ops.createFieldCorrection.mockResolvedValue({ ok: false, code: svcCode, message: 'msg' });
  const res = await tool().handler({ wine_id: WINE, fields: {}, reason: 'long enough reason' }, CTX);
  expect(res.isError).toBe(true);
  expect(parse(res).error.code).toBe(mcpCode);
});
