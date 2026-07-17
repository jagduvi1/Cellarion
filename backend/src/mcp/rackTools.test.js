/**
 * Rack/cellar/placement MCP tools + structural undo — scope gating, access
 * checks (foreign/viewer refused), ledger detail sufficiency for undo, and the
 * undo reversals (create→soft-delete-if-empty, place→clear, move→move-back).
 * Ledger refs use REAL ObjectIds (the masking-bug rule).
 */

const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

jest.mock('../models/Cellar', () => ({ find: jest.fn(), findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), findById: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/Rack', () => ({ find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WishlistItem', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/JournalEntry', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/WineEmbedding', () => ({ findOne: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../utils/rackGeometry', () => ({ getMaxPosition: jest.fn(() => 32) }));
jest.mock('../services/search', () => ({ getIsAvailable: jest.fn(() => false), search: jest.fn(), searchBottles: jest.fn() }));
jest.mock('../services/statsService', () => ({ computeOverview: jest.fn(), buildEmptyStats: jest.fn() }));
jest.mock('../services/vectorStore', () => ({ getPoints: jest.fn(), searchSimilar: jest.fn() }));
jest.mock('../config/aiConfig', () => ({ get: jest.fn(() => ({ vectorIndex: 'v1' })) }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/rackOps', () => ({
  createCellar: jest.fn(), createGridRack: jest.fn(), placeBottleInRack: jest.fn(),
  clearRackSlot: jest.fn(), moveBottleToCellar: jest.fn(),
}));
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), removeFromRacks: jest.fn(),
  RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  addBottle: jest.fn(), updateBottleFields: jest.fn(), removeBottleCascade: jest.fn(),
  UPDATABLE_FIELDS: [],
}));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('./mutationBudget', () => ({ takeMutationSlot: jest.fn(() => true), WRITE_WINDOW_MS: 15 * 60 * 1000 }));

const mongoose = require('mongoose');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const Rack = require('../models/Rack');
const McpActionLog = require('../models/McpActionLog');
const rackOps = require('../services/rackOps');
const { allTools, toolsForScopes } = require('./registry');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const STRANGER = oid('b');
const CTX = { user: { id: ME, roles: ['user'] }, scopes: ['read', 'write'], req: { user: { id: ME, roles: ['user'] }, headers: {}, apiToken: { id: 't1' } } };
const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);
const ownCellar = () => Cellar.findById.mockReturnValue(chain({ _id: oid('c'), user: ME, members: [], deletedAt: null, name: 'Mine' }));

beforeEach(() => {
  jest.clearAllMocks();
  McpActionLog.findOne.mockReturnValue(chain(null));
  McpActionLog.create.mockResolvedValue({});
  McpActionLog.findOneAndUpdate.mockResolvedValue(null);
});

describe('scope gating', () => {
  test('all five tools are write-scoped and hidden from read tokens', () => {
    const names = ['create_cellar', 'create_rack', 'place_bottle', 'unplace_bottle', 'move_bottle'];
    for (const n of names) expect(tool(n).scope).toBe('write');
    const readNames = toolsForScopes(['read'], ['user']).map((t) => t.name);
    for (const n of names) expect(readNames).not.toContain(n);
  });
});

describe('create_cellar / create_rack', () => {
  test('create_cellar delegates + ledgers cellar_create', async () => {
    rackOps.createCellar.mockResolvedValue({ cellar: { _id: oid('c'), name: 'New' } });
    const res = await tool('create_cellar').handler({ name: 'New' }, CTX);
    expect(parse(res).data.cellar_id).toBe(oid('c'));
    expect(McpActionLog.create.mock.calls[0][0]).toMatchObject({ action: 'cellar_create', cellar: oid('c') });
  });

  test('create_rack needs cellar editor access; foreign → not_found', async () => {
    Cellar.findById.mockReturnValue(chain({ _id: oid('c'), user: STRANGER, members: [], deletedAt: null }));
    expect(parse(await tool('create_rack').handler({ cellar_id: oid('c'), name: 'R' }, CTX)).error.code).toBe('not_found');
    expect(rackOps.createGridRack).not.toHaveBeenCalled();

    ownCellar();
    rackOps.createGridRack.mockResolvedValue({ rack: { _id: oid('e'), name: 'R' } });
    const res = await tool('create_rack').handler({ cellar_id: oid('c'), name: 'R', rows: 3, cols: 4 }, CTX);
    expect(parse(res).data.rack_id).toBe(oid('e'));
    expect(McpActionLog.create.mock.calls[0][0].detail.rackId).toBe(oid('e'));
  });
});

describe('place_bottle', () => {
  test('reports the displaced bottle + records rack/position for undo', async () => {
    Rack.findOne.mockReturnValue(chain({ _id: oid('e'), cellar: oid('c') }));
    ownCellar();
    rackOps.placeBottleInRack.mockResolvedValue({ rack: {}, displaced: oid('9'), previousPosition: 2, position: 5 });
    const res = await tool('place_bottle').handler({ rack_id: oid('e'), position: 5, bottle_id: oid('d') }, CTX);
    const body = parse(res);
    expect(body.data.displaced_bottle_id).toBe(oid('9'));
    const row = McpActionLog.create.mock.calls[0][0];
    expect(row).toMatchObject({ action: 'place', detail: { rackId: oid('e'), position: 5 } });
  });

  test('foreign rack → not_found, service untouched', async () => {
    Rack.findOne.mockReturnValue(chain({ _id: oid('e'), cellar: oid('c') }));
    Cellar.findById.mockReturnValue(chain({ _id: oid('c'), user: STRANGER, members: [], deletedAt: null }));
    expect(parse(await tool('place_bottle').handler({ rack_id: oid('e'), position: 5, bottle_id: oid('d') }, CTX)).error.code).toBe('not_found');
    expect(rackOps.placeBottleInRack).not.toHaveBeenCalled();
  });

  test('idempotency_key: a seen key replays the stored result without re-placing (MCP-audit M4-ergo)', async () => {
    // Claim-first replay: the atomic upsert reports an existing completed row.
    McpActionLog.findOneAndUpdate.mockResolvedValueOnce({
      lastErrorObject: { updatedExisting: true },
      value: { tool: 'place_bottle', pending: false, result: { summary: 'Placed once', data: { position: 5 } } },
    });
    const res = await tool('place_bottle').handler({ rack_id: oid('e'), position: 5, bottle_id: oid('d'), idempotency_key: 'k1' }, CTX);
    expect(parse(res).summary).toBe('Placed once');
    expect(rackOps.placeBottleInRack).not.toHaveBeenCalled(); // did NOT act twice
  });
});

describe('move_bottle', () => {
  test('needs OWNER of source and OWNER of destination', async () => {
    // Source not owner → not_found
    Bottle.findById.mockReturnValue(chain({ _id: oid('d'), cellar: oid('c') }));
    Cellar.findById.mockReturnValue(chain({ _id: oid('c'), user: STRANGER, members: [{ user: ME, role: 'editor' }], deletedAt: null }));
    expect(parse(await tool('move_bottle').handler({ bottle_id: oid('d'), to_cellar_id: oid('2') }, CTX)).error.code).toBe('not_found');

    // Source owned, dest not owned → not_found
    Bottle.findById.mockReturnValue(chain({ _id: oid('d'), cellar: oid('c') }));
    Cellar.findById
      .mockReturnValueOnce(chain({ _id: oid('c'), user: ME, members: [], deletedAt: null, name: 'Src' }))  // source
      .mockReturnValueOnce(chain({ _id: oid('2'), user: STRANGER, members: [], deletedAt: null }));         // dest
    expect(parse(await tool('move_bottle').handler({ bottle_id: oid('d'), to_cellar_id: oid('2') }, CTX)).error.code).toBe('not_found');
    expect(rackOps.moveBottleToCellar).not.toHaveBeenCalled();
  });
});

describe('structural undo', () => {
  const structuralRow = (over) => ({ _id: 'row', reversed: false, ...over });

  test('undo cellar_create soft-deletes an EMPTY cellar; refuses if it has content', async () => {
    // has content → refuse, no claim
    McpActionLog.findOne.mockReturnValue(chain(structuralRow({ action: 'cellar_create', cellar: oid('c') })));
    Cellar.findOne.mockReturnValue(chain({ _id: oid('c'), user: ME, deletedAt: null, name: 'X', save: jest.fn() }));
    Bottle.countDocuments.mockResolvedValue(2);
    Rack.countDocuments.mockResolvedValue(0);
    let res = await tool('undo_last').handler({}, CTX);
    expect(parse(res).error.code).toBe('conflict');
    expect(McpActionLog.findOneAndUpdate).not.toHaveBeenCalled();

    // empty → claim + soft-delete
    const c = { _id: oid('c'), user: ME, deletedAt: null, name: 'X', save: jest.fn().mockResolvedValue(undefined) };
    Cellar.findOne.mockReturnValue(chain(c));
    Bottle.countDocuments.mockResolvedValue(0);
    McpActionLog.findOneAndUpdate.mockResolvedValue(structuralRow({ action: 'cellar_create' }));
    res = await tool('undo_last').handler({}, CTX);
    expect(parse(res).data.undone).toBe('create_cellar');
    expect(c.deletedAt).toBeInstanceOf(Date);
  });

  test('undo place clears the slot only if it still holds the placed bottle', async () => {
    const bottleRef = new mongoose.Types.ObjectId(oid('d'));
    McpActionLog.findOne.mockReturnValue(chain(structuralRow({ action: 'place', bottle: bottleRef, cellar: oid('c'), detail: { rackId: oid('e'), position: 5 } })));
    Rack.findOne.mockReturnValue(chain({ _id: oid('e'), cellar: oid('c'), slots: [{ position: 5, bottle: bottleRef }] }));
    ownCellar();
    McpActionLog.findOneAndUpdate.mockResolvedValue({ _id: 'row' });
    rackOps.clearRackSlot.mockResolvedValue({ rack: {}, cleared: oid('d') });
    const res = await tool('undo_last').handler({}, CTX);
    expect(parse(res).data.undone).toBe('place_bottle');
    expect(rackOps.clearRackSlot).toHaveBeenCalled();
  });

  test('undo move moves the bottle back to origin if still owned + still in dest', async () => {
    const bottleRef = new mongoose.Types.ObjectId(oid('d'));
    McpActionLog.findOne.mockReturnValue(chain(structuralRow({ action: 'move', bottle: bottleRef, cellar: oid('2'), detail: { fromCellarId: oid('c'), toCellarId: oid('2') } })));
    // resolveBottleAccess: bottle in dest cellar c2, owned by ME
    Bottle.findById
      .mockReturnValueOnce(chain({ _id: bottleRef, cellar: new mongoose.Types.ObjectId(oid('2')), status: 'active' })) // access resolution
      .mockReturnValueOnce(chain({ _id: bottleRef, cellar: oid('2'), status: 'active', save: jest.fn() }));            // re-fetch for move
    Cellar.findById.mockReturnValue(chain({ _id: oid('2'), user: ME, members: [], deletedAt: null, name: 'Dest' }));
    Cellar.findOne.mockReturnValue(chain({ _id: oid('c'), user: ME, deletedAt: null, name: 'Origin' }));
    McpActionLog.findOneAndUpdate.mockResolvedValue({ _id: 'row' });
    rackOps.moveBottleToCellar.mockResolvedValue({ bottle: {}, from: { cellarId: oid('2'), cellarName: 'Dest' } });
    const res = await tool('undo_last').handler({}, CTX);
    expect(parse(res).data.undone).toBe('move_bottle');
    expect(rackOps.moveBottleToCellar).toHaveBeenCalled();
  });
});
