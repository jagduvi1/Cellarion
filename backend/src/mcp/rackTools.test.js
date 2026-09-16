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
// Real geometry (create_rack reports a cabinet's capacity through it); only
// the max-position lookup is stubbed.
jest.mock('../utils/rackGeometry', () => ({ ...jest.requireActual('../utils/rackGeometry'), getMaxPosition: jest.fn(() => 32) }));
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

describe('rack groups (support ticket 2026-09-06)', () => {
  test('list_racks reports each rack\'s group and names the groups in the summary', async () => {
    ownCellar();
    Rack.find.mockReturnValue(chain([
      { _id: oid('1'), name: 'Left', group: 'Basement', type: 'grid', rows: 4, cols: 8, slots: [], disabledPositions: [], zones: [] },
      { _id: oid('2'), name: 'Fridge', group: null, type: 'grid', rows: 2, cols: 3, slots: [], disabledPositions: [], zones: [] },
    ]));
    const body = parse(await tool('list_racks').handler({ cellar_id: oid('c') }, CTX));
    expect(body.data.map((r) => r.group)).toEqual(['Basement', null]);
    expect(body.summary).toMatch(/groups: Basement/);
  });

  test('create_rack type "cabinet" needs shelf_rows, builds typeConfig, reports capacity', async () => {
    ownCellar();
    const bad = parse(await tool('create_rack').handler({ cellar_id: oid('c'), name: 'Fridge', type: 'cabinet', rows: 2, cols: 5 }, CTX));
    expect(bad.error.code).toBe('invalid_input');
    expect(bad.error.message).toMatch(/shelf_rows is required/);
    expect(rackOps.createGridRack).not.toHaveBeenCalled();

    const misuse = parse(await tool('create_rack').handler({ cellar_id: oid('c'), name: 'G', rows: 2, cols: 5, shelf_rows: [1, 1] }, CTX));
    expect(misuse.error.message).toMatch(/type "cabinet" only/);

    rackOps.createGridRack.mockResolvedValue({ rack: { _id: oid('e'), name: 'Fridge', group: null } });
    const body = parse(await tool('create_rack').handler({ cellar_id: oid('c'), name: 'Fridge', type: 'cabinet', rows: 2, cols: 5, shelf_rows: [1, 4] }, CTX));
    expect(rackOps.createGridRack).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'cabinet', rows: 2, cols: 5, typeConfig: { shelfRows: [1, 4], twoDeep: true, stagger: true, alternate: false } }),
      expect.anything()
    );
    expect(body.data).toMatchObject({ type: 'cabinet', capacity: 25, shelf_rows: [1, 4], two_deep: true, stagger: true, alternate: false });
    expect(body.summary).toMatch(/wine cabinet "Fridge".*2 shelves, 5 across, 25 bottles/);
  });

  test('create_rack cabinet with alternate: the honeycomb rows (6/5, 5/6) set the capacity, and it is cabinet-only', async () => {
    ownCellar();
    const misuse = parse(await tool('create_rack').handler({ cellar_id: oid('c'), name: 'G', rows: 2, cols: 6, alternate: true }, CTX));
    expect(misuse.error.message).toMatch(/type "cabinet" only/);

    rackOps.createGridRack.mockResolvedValue({ rack: { _id: oid('e'), name: 'GrandCru', group: null } });
    const body = parse(await tool('create_rack').handler({ cellar_id: oid('c'), name: 'GrandCru', type: 'cabinet', rows: 2, cols: 6, shelf_rows: [2, 3], alternate: true }, CTX));
    expect(rackOps.createGridRack).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ typeConfig: { shelfRows: [2, 3], twoDeep: true, stagger: true, alternate: true } }),
      expect.anything()
    );
    // (6 + 5) + (6 + 5 + 5), not 6 × 5.
    expect(body.data).toMatchObject({ capacity: 27, alternate: true, shelf_cols: null, shelf_alternate: null });
    expect(body.summary).toMatch(/27 bottles/);
  });

  test('create_rack cabinet with shelf_cols / shelf_alternate: the GrandCru 5001 loading diagram is 196', async () => {
    ownCellar();
    rackOps.createGridRack.mockResolvedValue({ rack: { _id: oid('e'), name: '5001', group: null } });
    const body = parse(await tool('create_rack').handler({
      cellar_id: oid('c'), name: '5001', type: 'cabinet', rows: 5, cols: 6,
      shelf_rows: [8, 8, 8, 8, 8], shelf_cols: [4, 6, 6, 6, 4], shelf_alternate: [false, true, true, true, false],
    }, CTX));
    expect(rackOps.createGridRack).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ typeConfig: {
        shelfRows: [8, 8, 8, 8, 8], twoDeep: true, stagger: true, alternate: false,
        shelfCols: [4, 6, 6, 6, 4], shelfAlternate: [false, true, true, true, false],
      } }),
      expect.anything()
    );
    expect(body.data).toMatchObject({ capacity: 196, shelf_cols: [4, 6, 6, 6, 4], shelf_alternate: [false, true, true, true, false] });
    const misuse = parse(await tool('create_rack').handler({ cellar_id: oid('c'), name: 'G', rows: 2, cols: 6, shelf_cols: [4, 6] }, CTX));
    expect(misuse.error.message).toMatch(/type "cabinet" only/);
  });

  test('create_rack passes the group to the shared creator and echoes it back', async () => {
    ownCellar();
    rackOps.createGridRack.mockResolvedValue({ rack: { _id: oid('e'), name: 'Left', group: 'Basement' } });
    const body = parse(await tool('create_rack').handler({ cellar_id: oid('c'), name: 'Left', group: 'Basement' }, CTX));
    expect(rackOps.createGridRack).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: 'Left', group: 'Basement' }), expect.anything());
    expect(body.data.group).toBe('Basement');
  });
});
