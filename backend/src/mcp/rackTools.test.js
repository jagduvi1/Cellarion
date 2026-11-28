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
jest.mock('../services/search', () => ({ getIsAvailable: jest.fn(() => false), search: jest.fn() }));
jest.mock('../services/statsService', () => ({ computeOverview: jest.fn(), buildEmptyStats: jest.fn() }));
jest.mock('../services/vectorStore', () => ({ getPoints: jest.fn(), searchSimilar: jest.fn() }));
jest.mock('../config/aiConfig', () => ({ get: jest.fn(() => ({ vectorIndex: 'v1' })) }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
// The move's role rule (MOVE_MIN_ROLE, findMoveDestination) is the real one;
// the mutations are mocked.
jest.mock('../services/rackOps', () => ({
  ...jest.requireActual('../services/rackOps'),
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
  // In a wall a position is a number nobody can check by eye; the answer
  // says the box and the spot, so a wrong pile is seen before the user walks
  // to the cellar.
  test('on a wall rack the answer says which box and spot the position is, and so does unplace', async () => {
    const wall = {
      _id: oid('e'), cellar: oid('c'), name: 'Cellar wall', type: 'wall', rows: 1, cols: 2,
      typeConfig: { boxes: [{ x: 0, y: 0, w: 1, h: 1, kind: 'x', perSection: 6 }, { x: 1, y: 0, w: 1, h: 1, kind: 'shelves', rows: 2, cols: 5 }] },
    };
    Rack.findOne.mockReturnValue(chain(wall));
    ownCellar();
    rackOps.placeBottleInRack.mockResolvedValue({ rack: {}, displaced: null, previousPosition: null, position: 9 });
    const placed = parse(await tool('place_bottle').handler({ rack_id: oid('e'), position: 9, bottle_id: oid('d') }, CTX));
    expect(placed.data).toMatchObject({ position: 9, wall: { box: 'A1', kind: 'x', section: 'left', slot: 3 } });
    expect(placed.summary).toBe('Placed bottle in "Cellar wall" position 9 (box A1, left pile, 3 from the bottom)');

    rackOps.clearRackSlot.mockResolvedValue({ cleared: oid('d') });
    const cleared = parse(await tool('unplace_bottle').handler({ rack_id: oid('e'), position: 32 }, CTX));
    expect(cleared.data).toMatchObject({ position: 32, wall: { box: 'B1', kind: 'shelves', row: 2, col: 3 } });
    expect(cleared.summary).toBe('Cleared position 32 (box B1, shelf 2, 3 from the left) in "Cellar wall"');
  });

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
  // Cellars by id: 'c' is the source, '2' the destination.
  const cellarsById = (src, dest) => Cellar.findById.mockImplementation((id) => chain(
    String(id) === oid('c') ? { _id: oid('c'), name: 'Src', deletedAt: null, ...src }
      : String(id) === oid('2') ? { _id: oid('2'), name: 'Dest', deletedAt: null, ...dest } : null,
  ));
  const own = { user: ME, members: [] };
  const sharedAs = (role) => ({ user: STRANGER, members: [{ user: ME, role }] });
  const move = async () => parse(await tool('move_bottle').handler({ bottle_id: oid('d'), to_cellar_id: oid('2') }, CTX));

  beforeEach(() => {
    Bottle.findById.mockReturnValue(chain({ _id: oid('d'), cellar: oid('c') }));
    rackOps.moveBottleToCellar.mockResolvedValue({ bottle: {}, from: { cellarId: oid('c'), cellarName: 'Src' } });
  });

  test('an editor moves a bottle into a shared cellar, and out of one into their own', async () => {
    cellarsById(own, sharedAs('editor'));
    expect((await move()).data.to_cellar_id).toBe(oid('2'));
    expect(rackOps.moveBottleToCellar).toHaveBeenLastCalledWith(
      expect.anything(), expect.objectContaining({ _id: oid('c') }), expect.objectContaining({ _id: oid('2'), user: STRANGER }), CTX.req,
    );

    cellarsById(sharedAs('editor'), own);
    expect((await move()).data.to_cellar_id).toBe(oid('2'));
    expect(rackOps.moveBottleToCellar).toHaveBeenCalledTimes(2);
  });

  test('a viewer of either cellar, or a cellar the user has no role in, is not_found', async () => {
    cellarsById(sharedAs('viewer'), own); // source only viewed
    expect((await move()).error.code).toBe('not_found');
    cellarsById(own, sharedAs('viewer')); // destination only viewed
    expect((await move()).error.code).toBe('not_found');
    cellarsById(own, { user: STRANGER, members: [] }); // destination a stranger's
    expect((await move()).error.code).toBe('not_found');
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

  describe('undo move', () => {
    const bottleRef = new mongoose.Types.ObjectId(oid('d'));
    const moveRow = () => structuralRow({ action: 'move', bottle: bottleRef, cellar: oid('2'), detail: { fromCellarId: oid('c'), toCellarId: oid('2') } });
    // Dest '2' holds the bottle now; 'c' is where it came from.
    const cellarsById = (origin, dest) => Cellar.findById.mockImplementation((id) => chain(
      String(id) === oid('2') ? { _id: oid('2'), name: 'Dest', deletedAt: null, ...dest }
        : String(id) === oid('c') ? { _id: oid('c'), name: 'Origin', deletedAt: null, ...origin } : null,
    ));

    beforeEach(() => {
      McpActionLog.findOne.mockReturnValue(chain(moveRow()));
      Bottle.findById.mockImplementation(() => chain({ _id: bottleRef, cellar: new mongoose.Types.ObjectId(oid('2')), status: 'active', save: jest.fn() }));
      McpActionLog.findOneAndUpdate.mockResolvedValue({ _id: 'row' });
      rackOps.moveBottleToCellar.mockResolvedValue({ bottle: {}, from: { cellarId: oid('2'), cellarName: 'Dest' } });
    });

    test('moves the bottle back to its origin while the user owns or edits both', async () => {
      cellarsById({ user: ME, members: [] }, { user: STRANGER, members: [{ user: ME, role: 'editor' }] });
      const res = await tool('undo_last').handler({}, CTX);
      expect(parse(res).data.undone).toBe('move_bottle');
      expect(rackOps.moveBottleToCellar).toHaveBeenCalledWith(
        expect.anything(), expect.objectContaining({ _id: oid('2') }), expect.objectContaining({ _id: oid('c'), name: 'Origin' }), CTX.req,
      );
    });

    test('refuses, and claims nothing, once the user no longer edits the cellar the bottle went into', async () => {
      cellarsById({ user: ME, members: [] }, { user: STRANGER, members: [{ user: ME, role: 'viewer' }] });
      expect(parse(await tool('undo_last').handler({}, CTX)).error.code).toBe('conflict');
      expect(McpActionLog.findOneAndUpdate).not.toHaveBeenCalled();
      expect(rackOps.moveBottleToCellar).not.toHaveBeenCalled();
    });

    test('refuses, and claims nothing, once the user no longer edits the origin cellar', async () => {
      cellarsById({ user: STRANGER, members: [] }, { user: ME, members: [] });
      expect(parse(await tool('undo_last').handler({}, CTX)).error.code).toBe('conflict');
      expect(McpActionLog.findOneAndUpdate).not.toHaveBeenCalled();
      expect(rackOps.moveBottleToCellar).not.toHaveBeenCalled();
    });
  });
});

describe('rack groups', () => {
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

  test('create_rack type "wall" needs boxes, stores them under the names the rack model has, and counts what they hold', async () => {
    ownCellar();
    const bad = parse(await tool('create_rack').handler({ cellar_id: oid('c'), name: 'Wall', type: 'wall', rows: 1, cols: 3 }, CTX));
    expect(bad.error.code).toBe('invalid_input');
    expect(bad.error.message).toMatch(/boxes is required for a wall/);
    const misuse = parse(await tool('create_rack').handler({ cellar_id: oid('c'), name: 'G', rows: 2, cols: 5, boxes: [{ x: 0, y: 0, kind: 'bin', per_pile: 4 }] }, CTX));
    expect(misuse.error.message).toMatch(/type "wall" only/);
    expect(rackOps.createGridRack).not.toHaveBeenCalled();

    rackOps.createGridRack.mockResolvedValue({ rack: { _id: oid('e'), name: 'Cellar wall', group: null } });
    const body = parse(await tool('create_rack').handler({
      cellar_id: oid('c'), name: 'Cellar wall', type: 'wall', rows: 1, cols: 3,
      boxes: [
        { x: 0, y: 0, kind: 'x', per_pile: 6 },
        { x: 1, y: 0, w: 1, h: 1, kind: 'rack', rows: 3, cols: 4 },
        { x: 2, y: 0, kind: 'closed' },
      ],
    }, CTX));
    expect(rackOps.createGridRack).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'wall', rows: 1, cols: 3,
        typeConfig: { boxes: [
          { x: 0, y: 0, w: 1, h: 1, kind: 'x', perSection: 6 },
          { x: 1, y: 0, w: 1, h: 1, kind: 'rack', rows: 3, cols: 4 },
          { x: 2, y: 0, w: 1, h: 1, kind: 'closed' },
        ] },
      }),
      expect.anything()
    );
    // 4 × 6 in the X, 3 × 4 in the rack, none behind the doors.
    expect(body.data).toMatchObject({ type: 'wall', rows: 1, cols: 3, capacity: 36, boxes: 3 });
    expect(body.summary).toMatch(/wall "Cellar wall".*3 cells wide, 1 high, 3 boxes, 36 bottles/);
    // What the tool hands on is a wall the server stores.
    const { validateWallConfig } = require('../utils/wallGeometry');
    const sent = rackOps.createGridRack.mock.calls[0][1];
    expect(validateWallConfig(sent.typeConfig, 'wall', sent.rows, sent.cols, false)).toBeNull();
  });

  // The shared check answers in the stored field name (perSection), which
  // this tool does not have: a model that then sends `perSection` has it
  // dropped and gets the same answer again.
  test('create_rack type "wall" says what a box lacks in its own field names, and stores only what the box uses', async () => {
    ownCellar();
    const call = (boxes, extra = {}) => tool('create_rack').handler({ cellar_id: oid('c'), name: 'W', type: 'wall', boxes, ...extra }, CTX);
    const noPile = parse(await call([{ x: 0, y: 0, kind: 'x' }]));
    expect(noPile.error).toMatchObject({ code: 'invalid_input' });
    expect(noPile.error.message).toBe('The "x" box at x 0, y 0 needs per_pile: the bottles in each of its piles (1 to 60)');
    const noRows = parse(await call([{ x: 1, y: 0, kind: 'shelves', rows: 3 }]));
    expect(noRows.error.message).toBe('The "shelves" box at x 1, y 0 needs rows and cols (1 to 20 each)');
    expect(rackOps.createGridRack).not.toHaveBeenCalled();

    // No rows or cols given: the wall is as large as its boxes reach.
    rackOps.createGridRack.mockResolvedValue({ rack: { _id: oid('e'), name: 'W', group: null } });
    const body = parse(await call([
      { x: 0, y: 0, kind: 'bin', per_pile: 5, rows: 9, cols: 9 },
      { x: 1, y: 0, w: 2, h: 2, kind: 'rack', rows: 2, cols: 3, per_pile: 7 },
    ]));
    const sent = rackOps.createGridRack.mock.calls[0][1];
    expect(sent).toMatchObject({ rows: 2, cols: 3 });
    expect(sent.typeConfig.boxes).toEqual([
      { x: 0, y: 0, w: 1, h: 1, kind: 'bin', perSection: 5 },
      { x: 1, y: 0, w: 2, h: 2, kind: 'rack', rows: 2, cols: 3 },
    ]);
    expect(body.data).toMatchObject({ rows: 2, cols: 3, capacity: 11 });
  });

  test('create_rack still makes a 4 × 8 grid when no size is given', async () => {
    ownCellar();
    rackOps.createGridRack.mockResolvedValue({ rack: { _id: oid('e'), name: 'R', group: null } });
    const body = parse(await tool('create_rack').handler({ cellar_id: oid('c'), name: 'R' }, CTX));
    expect(rackOps.createGridRack.mock.calls[0][1]).toMatchObject({ type: 'grid', rows: 4, cols: 8 });
    expect(body.data).toMatchObject({ rows: 4, cols: 8, capacity: 32 });
  });

  test('create_rack cabinet with head_to_tail passes it through, and it is cabinet-only', async () => {
    ownCellar();
    const misuse = parse(await tool('create_rack').handler({ cellar_id: oid('c'), name: 'G', rows: 2, cols: 6, head_to_tail: true }, CTX));
    expect(misuse.error.message).toMatch(/type "cabinet" only/);

    rackOps.createGridRack.mockResolvedValue({ rack: { _id: oid('e'), name: 'Cooler', group: null } });
    const body = parse(await tool('create_rack').handler({ cellar_id: oid('c'), name: 'Cooler', type: 'cabinet', rows: 2, cols: 7, shelf_rows: [1, 1], two_deep: false, head_to_tail: true }, CTX));
    expect(rackOps.createGridRack).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ typeConfig: expect.objectContaining({ twoDeep: false, headToTail: true }) }),
      expect.anything()
    );
    expect(body.data).toMatchObject({ capacity: 14, two_deep: false, head_to_tail: true });
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
