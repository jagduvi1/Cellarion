/**
 * MCP write tools — registry-integrity + write-safety invariants.
 *
 * Pins the two-step contract (resolve_wine → add_bottle), the soft-zone
 * conflict that stops an AI minting near-duplicates, provenance stamping +
 * wine.create audit, ledger rows (REAL ObjectId refs — the masking-bug rule),
 * idempotency replay, and scope gating (read sees resolve_wine but never
 * add/update; write sees them all).
 */

const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

jest.mock('../models/Cellar', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({
  find: jest.fn(), findById: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn(),
}));
jest.mock('../models/Rack', () => ({ find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn(), updateMany: jest.fn() }));
jest.mock('../models/WishlistItem', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/JournalEntry', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/WineEmbedding', () => ({ findOne: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../utils/rackGeometry', () => ({ getMaxPosition: jest.fn(() => 12) }));
jest.mock('../services/search', () => ({
  getIsAvailable: jest.fn(() => false), search: jest.fn(), searchBottles: jest.fn(),
}));
jest.mock('../services/statsService', () => ({ computeOverview: jest.fn(), buildEmptyStats: jest.fn() }));
jest.mock('../services/vectorStore', () => ({ getPoints: jest.fn(), searchSimilar: jest.fn() }));
jest.mock('../config/aiConfig', () => ({ get: jest.fn(() => ({ vectorIndex: 'v1' })) }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), removeFromRacks: jest.fn(),
  RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  addBottle: jest.fn(), updateBottleFields: jest.fn(), removeBottleCascade: jest.fn(),
  UPDATABLE_FIELDS: ['price', 'currency', 'notes', 'occasion', 'rating', 'ratingScale', 'drinkFrom', 'drinkTo'],
}));

const mongoose = require('mongoose');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const McpActionLog = require('../models/McpActionLog');
const { logAudit } = require('../services/audit');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const bottleOps = require('../services/bottleOps');
const { allTools, toolsForScopes } = require('./registry');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const STRANGER = oid('b');
const REQ = { user: { id: ME, roles: ['user'] }, headers: {}, apiToken: { id: 't1', scopes: ['read', 'write'] } };
const CTX = { user: { id: ME }, scopes: ['read', 'write'], req: REQ };

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

const ownCellar = () => {
  Cellar.findById.mockReturnValue(chain({ _id: oid('c'), user: ME, members: [], deletedAt: null, name: 'Mine' }));
};

beforeEach(() => {
  jest.clearAllMocks();
  McpActionLog.findOne.mockReturnValue(chain(null));
  McpActionLog.create.mockResolvedValue({});
});

describe('scope gating', () => {
  test('write tools carry write scope; resolve_wine is read; read tokens never see add/update', () => {
    expect(tool('resolve_wine').scope).toBe('read');
    expect(tool('add_bottle').scope).toBe('write');
    expect(tool('update_bottle').scope).toBe('write');
    const readNames = toolsForScopes(['read']).map((t) => t.name);
    expect(readNames).toContain('resolve_wine');
    expect(readNames).not.toContain('add_bottle');
    const writeNames = toolsForScopes(['write']).map((t) => t.name);
    expect(writeNames).toEqual(expect.arrayContaining(['add_bottle', 'update_bottle', 'get_source_info']));
    expect(writeNames).not.toContain('consume_bottle'); // write ≠ consume
  });
});

describe('resolve_wine', () => {
  test('is a pure lookup (matchOnly) and maps all three outcomes', async () => {
    findOrCreateWine.mockResolvedValue({ wine: { _id: oid('f'), name: 'Barolo', producer: 'X', grapes: [] }, created: false });
    let body = parse(await tool('resolve_wine').handler({ name: 'Barolo', producer: 'X' }, CTX));
    expect(body.data.matched.wine_id).toBeDefined();
    expect(findOrCreateWine.mock.calls[0][2]).toEqual({ matchOnly: true });

    findOrCreateWine.mockResolvedValue({ wine: null, candidates: [{ wine: { _id: oid('f'), name: 'B', producer: 'X', grapes: [] }, score: 0.9 }] });
    body = parse(await tool('resolve_wine').handler({ name: 'B', producer: 'X' }, CTX));
    expect(body.data.candidates[0].score).toBe(0.9);

    findOrCreateWine.mockResolvedValue({ wine: null, noMatch: true });
    body = parse(await tool('resolve_wine').handler({ name: 'Z', producer: 'Q' }, CTX));
    expect(body.data.no_match).toBe(true);
  });
});

describe('add_bottle', () => {
  test('requires exactly one of wine_id / new_wine', async () => {
    expect(parse(await tool('add_bottle').handler({ cellar_id: oid('c') }, CTX)).error.code).toBe('invalid_input');
    expect(parse(await tool('add_bottle').handler(
      { cellar_id: oid('c'), wine_id: oid('f'), new_wine: { name: 'x', producer: 'y', country: 'z' } }, CTX
    )).error.code).toBe('invalid_input');
  });

  test('foreign cellar → not_found before any wine work', async () => {
    Cellar.findById.mockReturnValue(chain({ _id: oid('c'), user: STRANGER, members: [], deletedAt: null }));
    const res = await tool('add_bottle').handler({ cellar_id: oid('c'), wine_id: oid('f') }, CTX);
    expect(parse(res).error.code).toBe('not_found');
    expect(findOrCreateWine).not.toHaveBeenCalled();
    expect(bottleOps.addBottle).not.toHaveBeenCalled();
  });

  test('soft-zone candidates → conflict listing wine_ids; nothing created', async () => {
    ownCellar();
    findOrCreateWine.mockResolvedValue({
      wine: null,
      candidates: [{ wine: { _id: oid('f'), name: 'Close Wine', producer: 'P' }, score: 0.9 }],
    });
    const res = await tool('add_bottle').handler(
      { cellar_id: oid('c'), new_wine: { name: 'Close Wine', producer: 'P', country: 'France' } }, CTX);
    const body = parse(res);
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toContain(oid('f'));
    expect(bottleOps.addBottle).not.toHaveBeenCalled();
  });

  test('new wine: provenance createdVia mcp + sibling matching ON + wine.create audit + ledger add', async () => {
    ownCellar();
    findOrCreateWine.mockResolvedValue({
      wine: { _id: oid('f'), name: 'New Wine', producer: 'P', grapes: [] }, created: true,
    });
    bottleOps.addBottle.mockResolvedValue({ bottle: { _id: new mongoose.Types.ObjectId(oid('d')), vintage: '2019', cellar: oid('c') } });
    const res = await tool('add_bottle').handler({
      cellar_id: oid('c'),
      new_wine: { name: 'New Wine', producer: 'P', country: 'France' },
      confirm_new_wine: true,
      vintage: '2019',
      idempotency_key: 'k-add',
    }, CTX);
    const body = parse(res);
    expect(body.data.wine_created).toBe(true);

    const opts = findOrCreateWine.mock.calls[0][2];
    expect(opts).toMatchObject({ confirmCreate: true, skipSiblingMatch: false, createdVia: 'mcp' });
    expect(logAudit).toHaveBeenCalledWith(REQ, 'wine.create',
      { type: 'wine', id: oid('f') }, expect.objectContaining({ via: 'mcp' }));
    // Keyed ledger writes complete the pending claim (claim-first, M2).
    const [lQuery, lUpdate] = McpActionLog.findOneAndUpdate.mock.calls.at(-1);
    expect(lQuery).toEqual({ user: ME, idempotencyKey: 'k-add', pending: true });
    expect(lUpdate.$set).toMatchObject({ tokenId: 't1', action: 'add', idempotencyKey: 'k-add', pending: false });
    expect(bottleOps.addBottle.mock.calls[0][3]).toBe(REQ); // audit/SSE attribution rides the real req
  });

  test('existing wine_id: no findOrCreateWine call, no wine.create audit', async () => {
    ownCellar();
    WineDefinition.findById.mockReturnValue(chain({ _id: oid('f'), name: 'Known', producer: 'P', grapes: [] }));
    bottleOps.addBottle.mockResolvedValue({ bottle: { _id: oid('d'), vintage: 'NV', cellar: oid('c') } });
    const body = parse(await tool('add_bottle').handler({ cellar_id: oid('c'), wine_id: oid('f') }, CTX));
    expect(body.data.wine_created).toBe(false);
    expect(findOrCreateWine).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalledWith(expect.anything(), 'wine.create', expect.anything(), expect.anything());
  });

  test('idempotent replay short-circuits everything', async () => {
    // Claim-first replay (prior-audit M2): the atomic upsert reports the key
    // as already existing and completed — the stored envelope comes back.
    McpActionLog.findOneAndUpdate.mockResolvedValueOnce({
      lastErrorObject: { updatedExisting: true },
      value: { pending: false, result: { summary: 'Added once', data: { bottle_id: oid('d') } } },
    });
    const body = parse(await tool('add_bottle').handler(
      { cellar_id: oid('c'), wine_id: oid('f'), idempotency_key: 'k-add' }, CTX));
    expect(body.summary).toBe('Added once');
    expect(Cellar.findById).not.toHaveBeenCalled();
    expect(bottleOps.addBottle).not.toHaveBeenCalled();
  });
});

describe('update_bottle', () => {
  const ownBottle = () => {
    Bottle.findById.mockReturnValue(chain({ _id: new mongoose.Types.ObjectId(oid('d')), cellar: new mongoose.Types.ObjectId(oid('c')), status: 'active', vintage: '2019' }));
    ownCellar();
  };

  test('changes + prev land in the ledger; no-change is a fast path without a ledger row', async () => {
    ownBottle();
    bottleOps.updateBottleFields.mockResolvedValue({ bottle: { _id: oid('d'), cellar: oid('c') }, changes: { price: 30 }, prev: { price: 25 } });
    let body = parse(await tool('update_bottle').handler({ bottle_id: oid('d'), price: 30 }, CTX));
    expect(body.data.changes).toEqual({ price: 30 });
    const row = McpActionLog.create.mock.calls[0][0];
    expect(row).toMatchObject({ action: 'update', prev: { price: 25 } });

    McpActionLog.create.mockClear();
    bottleOps.updateBottleFields.mockResolvedValue({ bottle: { _id: oid('d') }, changes: {}, prev: {} });
    body = parse(await tool('update_bottle').handler({ bottle_id: oid('d'), price: 30 }, CTX));
    expect(body.data.changes).toEqual({});
    expect(McpActionLog.create).not.toHaveBeenCalled();
  });

  test('foreign bottle → not_found, service untouched', async () => {
    Bottle.findById.mockReturnValue(chain({ _id: oid('d'), cellar: oid('c') }));
    Cellar.findById.mockReturnValue(chain({ _id: oid('c'), user: STRANGER, members: [], deletedAt: null }));
    const res = await tool('update_bottle').handler({ bottle_id: oid('d'), price: 30 }, CTX);
    expect(parse(res).error.code).toBe('not_found');
    expect(bottleOps.updateBottleFields).not.toHaveBeenCalled();
  });
});
