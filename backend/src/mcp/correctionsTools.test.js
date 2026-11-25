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
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
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

test('accepts type and grapes alongside the identity fields', () => {
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

// `newGrapes` is the WEB grape picker's "this variety is deliberately new"
// modifier. It is not part of this tool: a name an assistant gets wrong must
// keep being refused at filing. The schema does not declare it (zod strips
// it), and the handler drops it as well — that second half is what a test can
// pin, since handlers are called here without the SDK's parsing in front.
test('newGrapes never reaches the service over the connector, and the schema does not declare it', async () => {
  ops.createFieldCorrection.mockResolvedValue({
    ok: true,
    proposal: { _id: oid('9'), proposedFields: { grapes: ['Merlot'] } },
    wine: { producer: 'Cloudy Bay', name: 'Sauvignon Blanc' },
  });
  await tool().handler({
    wine_id: WINE,
    fields: { grapes: ['Merlot', 'Souvignier Grisx'], newGrapes: ['Souvignier Grisx'] },
    reason: 'An assistant trying to wave a typo through.',
  }, CTX);
  const sent = ops.createFieldCorrection.mock.calls[0][1].fields;
  expect(sent).toEqual({ grapes: ['Merlot', 'Souvignier Grisx'] });
  expect(sent).not.toHaveProperty('newGrapes');
  expect(Object.keys(tool().inputSchema.fields.shape)).not.toContain('newGrapes');
});

// Filing on one's own pending suggestion amends it.
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

describe('idempotency', () => {
  const McpActionLog = require('../models/McpActionLog');
  beforeEach(() => { McpActionLog.create.mockReset(); McpActionLog.findOneAndUpdate.mockReset(); });

  test('a filed suggestion records a suggest_correction ledger row carrying the replayable envelope', async () => {
    ops.createFieldCorrection.mockResolvedValue({ ok: true, amended: false, proposal: { _id: 'p1', proposedFields: { region: 'Rioja' } }, wine: { _id: WINE, producer: 'Muga', name: 'Reserva' } });
    const body = parse(await tool().handler({ wine_id: WINE, fields: { region: 'Rioja' }, reason: 'Label says Rioja DOCa' }, CTX));
    expect(body.data.proposal_id).toBe('p1');
    expect(McpActionLog.create).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'suggest_wine_correction', action: 'suggest_correction', idempotencyKey: null,
      detail: expect.objectContaining({ proposalId: 'p1', fields: ['region'], amended: false }),
    }));
  });

  test('a retry with the same idempotency_key replays and never reaches the proposal service', async () => {
    McpActionLog.findOneAndUpdate.mockResolvedValueOnce({ lastErrorObject: { updatedExisting: true }, value: { tool: 'suggest_wine_correction', pending: false, result: { ok: true, summary: 'Suggestion filed', data: { proposal_id: 'p1' } } } });
    const body = parse(await tool().handler({ wine_id: WINE, fields: { region: 'Rioja' }, reason: 'Label says Rioja DOCa', idempotency_key: 'k-9' }, CTX));
    expect(body.data.proposal_id).toBe('p1');
    expect(ops.createFieldCorrection).not.toHaveBeenCalled();
    expect(tool().description).toMatch(/read back/);
  });
});

describe('the sweetness style', () => {
  const STYLE = { term: 'feinherb', source: 'trade', source_url: 'https://merchant.example/kabinett' };
  const wine = { _id: WINE, producer: 'Weingut Beispiel', name: 'Riesling Kabinett' };

  test('the schema takes a term, who names it and an optional link — nothing else as a source', () => {
    const { sweetness_style: style } = tool().inputSchema.fields.shape;
    expect(style.safeParse(STYLE).success).toBe(true);
    expect(style.safeParse({ term: 'feinherb', source: 'producer' }).success).toBe(true);
    expect(style.safeParse({ term: 'feinherb', source: 'critic', source_url: STYLE.source_url }).success).toBe(false);
    expect(style.safeParse({ source: 'trade', source_url: STYLE.source_url }).success).toBe(false);
    expect(style.safeParse({ term: 'x'.repeat(61), source: 'trade' }).success).toBe(false);
  });

  test('it reaches the service as sweetnessStyle { term, source, url }, with evidence_url beside it for the fallback', async () => {
    ops.createFieldCorrection.mockResolvedValue({
      ok: true, amended: false, wine,
      proposal: { _id: 'p1', proposedFields: { sweetnessStyle: { term: 'feinherb', source: 'trade', url: STYLE.source_url } } },
    });
    await tool().handler({ wine_id: WINE, fields: { sweetness_style: STYLE }, reason: 'The merchant calls it feinherb.', evidence_url: 'https://other.example/a' }, CTX);
    expect(ops.createFieldCorrection).toHaveBeenCalledWith(ME, {
      wineId: WINE,
      fields: { sweetnessStyle: { term: 'feinherb', source: 'trade', url: STYLE.source_url } },
      reason: 'The merchant calls it feinherb.',
      evidenceUrl: 'https://other.example/a',
    }, { via: 'mcp', req: CTX.req });
  });

  test('without source_url the style goes on with no link of its own, for the service to take evidence_url', async () => {
    ops.createFieldCorrection.mockResolvedValue({
      ok: true, amended: false, wine,
      proposal: { _id: 'p1', proposedFields: { sweetnessStyle: { term: 'feinherb', source: 'trade', url: 'https://other.example/a' } } },
    });
    await tool().handler({ wine_id: WINE, fields: { sweetness_style: { term: 'feinherb', source: 'trade' } }, reason: 'The merchant calls it feinherb.', evidence_url: 'https://other.example/a' }, CTX);
    const sent = ops.createFieldCorrection.mock.calls[0][1];
    expect(sent.fields).toEqual({ sweetnessStyle: { term: 'feinherb', source: 'trade', url: undefined } });
    expect(sent.evidenceUrl).toBe('https://other.example/a');
  });

  test('a style merged into the caller\'s own waiting suggestion is named as the tool takes it', async () => {
    ops.createFieldCorrection.mockResolvedValue({
      ok: true, amended: true, amendedFields: ['sweetnessStyle'], wine,
      proposal: { _id: 'p1', amendments: [{}], proposedFields: { grapes: ['Riesling'], sweetnessStyle: { term: 'feinherb', source: 'trade', url: STYLE.source_url } } },
    });
    const body = parse(await tool().handler({ wine_id: WINE, fields: { sweetness_style: STYLE }, reason: 'The merchant calls it feinherb.' }, CTX));
    expect(body.summary).toMatch(/was amended with sweetness_style — it now covers grapes, sweetness_style/);
    expect(JSON.stringify(body)).not.toMatch(/sweetnessStyle/);
  });

  test('a style that waits for review is reported under the tool\'s own field name', async () => {
    ops.createFieldCorrection.mockResolvedValue({
      ok: true, amended: false, wine,
      proposal: { _id: 'p1', proposedFields: { appellation: 'Mosel', sweetnessStyle: { term: 'feinherb', source: 'trade', url: STYLE.source_url } } },
    });
    const body = parse(await tool().handler({ wine_id: WINE, fields: { appellation: 'Mosel', sweetness_style: STYLE }, reason: 'The merchant calls it feinherb.' }, CTX));
    expect(body.data).toMatchObject({ status: 'pending', fields: ['appellation', 'sweetness_style'] });
  });

  test('a style that applied on filing says so, and not that the server skips review', async () => {
    ops.createFieldCorrection.mockResolvedValue({
      ok: true, amended: false, applied: true, appliedBecause: 'sweetness_style', wine,
      proposal: { _id: 'p1', proposedFields: { sweetnessStyle: { term: 'feinherb', source: 'trade', url: STYLE.source_url } } },
    });
    const body = parse(await tool().handler({ wine_id: WINE, fields: { sweetness_style: STYLE }, reason: 'The merchant calls it feinherb.' }, CTX));
    expect(body.summary).toBe('Applied to Weingut Beispiel — Riesling Kabinett: sweetness_style feinherb (named by the trade)');
    expect(body.data).toMatchObject({ status: 'approved', fields: ['sweetness_style'] });
    expect(body.data.note).toMatch(/needs no review/);
    expect(body.data.note).not.toMatch(/turned review of contributions off/);
  });

  test('the description says when a style applies at once and when it is reviewed', () => {
    expect(tool().description).toMatch(/sweetness_style/);
    expect(tool().description).toMatch(/APPLIES AT ONCE/);
    expect(tool().description).toMatch(/reviewed like the rest/);
    expect(tool().description).toMatch(/a term with a legal definition/);
    expect(tool().description).toMatch(/is merged into it/);
  });
});
