/**
 * update_bottle apply_to_lot — the drink window / price of ONE call written to
 * every active bottle of the same wine and vintage in the user's own cellars
 * (support ticket 2026-09-06: six identical calls for a case of six).
 *
 * Pins: only the lot-level fields travel to the siblings; each sibling runs
 * the shared validation and a refusal is reported, never fatal for the rest;
 * the ledger holds ONE lot_update row with prev keyed by bottle id, so
 * undo_last reverts the lot together; a call with no lot-level field warns
 * and stays an ordinary update.
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
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/WineEmbedding', () => ({ findOne: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), deleteOne: jest.fn(() => Promise.resolve({})) }));
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
jest.mock('../services/bottleLot', () => {
  const LOT_FIELDS = ['drinkFrom', 'drinkTo', 'peakFrom', 'peakUntil', 'price', 'currency'];
  return {
    LOT_FIELDS,
    LOT_LIMIT: 500,
    findLotSiblings: jest.fn(),
    pickLotFields: (fields) => Object.fromEntries(LOT_FIELDS.filter((k) => fields[k] !== undefined).map((k) => [k, fields[k]])),
  };
});

const mongoose = require('mongoose');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const McpActionLog = require('../models/McpActionLog');
const bottleOps = require('../services/bottleOps');
const { findLotSiblings } = require('../services/bottleLot');
const { allTools } = require('./registry');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const REQ = { user: { id: ME, roles: ['user'] }, headers: {}, apiToken: { id: 't1', scopes: ['read', 'write'] } };
const CTX = { user: { id: ME }, scopes: ['read', 'write'], req: REQ };

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

const primary = () => {
  Bottle.findById.mockReturnValue(chain({
    _id: new mongoose.Types.ObjectId(oid('d')), cellar: new mongoose.Types.ObjectId(oid('c')),
    status: 'active', vintage: '2019', wineDefinition: new mongoose.Types.ObjectId(oid('e')),
  }));
  Cellar.findById.mockReturnValue(chain({ _id: oid('c'), user: ME, members: [], deletedAt: null, name: 'Mine' }));
};
const sib = (c) => ({ _id: oid(c), cellar: oid('c'), status: 'active', vintage: '2019' });
const changed = (changes, prev) => ({ bottle: {}, changes, prev });

beforeEach(() => {
  jest.clearAllMocks();
  McpActionLog.findOne.mockReturnValue(chain(null));
  McpActionLog.create.mockResolvedValue({});
});

describe('update_bottle apply_to_lot', () => {
  test('lot-level fields go to every sibling, other fields stay on the bottle, one lot_update row keyed by bottle id', async () => {
    primary();
    findLotSiblings.mockResolvedValue([sib('1'), sib('2')]);
    bottleOps.updateBottleFields
      .mockResolvedValueOnce(changed({ drinkFrom: 2028, drinkTo: 2040, notes: 'case of six' }, { drinkFrom: null, drinkTo: null, notes: '' }))
      .mockResolvedValueOnce(changed({ drinkFrom: 2028, drinkTo: 2040 }, { drinkFrom: 2026, drinkTo: 2035 }))
      .mockResolvedValueOnce(changed({}, {})); // already matched
    const body = parse(await tool('update_bottle').handler(
      { bottle_id: oid('d'), drink_from: 2028, drink_to: 2040, notes: 'case of six', apply_to_lot: true }, CTX));

    expect(findLotSiblings).toHaveBeenCalledWith(ME, expect.objectContaining({ vintage: '2019' }));
    expect(bottleOps.updateBottleFields).toHaveBeenCalledTimes(3);
    // Siblings receive ONLY the lot-level fields — the note stays on the bottle.
    expect(bottleOps.updateBottleFields.mock.calls[1][1]).toEqual({ drinkFrom: 2028, drinkTo: 2040 });
    expect(bottleOps.updateBottleFields.mock.calls[2][1]).toEqual({ drinkFrom: 2028, drinkTo: 2040 });
    expect(body.data.changes).toEqual({ drinkFrom: 2028, drinkTo: 2040, notes: 'case of six' });
    expect(body.data.lot).toEqual({ count: 2, applied: [oid('1')], unchanged: 1, skipped: [] });

    const row = McpActionLog.create.mock.calls[0][0];
    expect(row.action).toBe('lot_update');
    expect(row.prev).toEqual({
      [oid('d')]: { drinkFrom: null, drinkTo: null, notes: '' },
      [oid('1')]: { drinkFrom: 2026, drinkTo: 2035 },
    });
    expect(row.detail).toMatchObject({ bottles: [oid('d'), oid('1')], lot: 2 });
    expect(row.detail.changed).toEqual(expect.arrayContaining(['drinkFrom', 'drinkTo', 'notes']));
  });

  test('a sibling the shared validation refuses lands in skipped; the rest still apply', async () => {
    primary();
    findLotSiblings.mockResolvedValue([sib('1'), sib('2')]);
    bottleOps.updateBottleFields
      .mockResolvedValueOnce(changed({ peakFrom: 2032 }, { peakFrom: null }))
      .mockResolvedValueOnce({ error: { status: 400, message: 'peakFrom cannot be before drinkFrom' } })
      .mockResolvedValueOnce(changed({ peakFrom: 2032 }, { peakFrom: 2030 }));
    const body = parse(await tool('update_bottle').handler({ bottle_id: oid('d'), peak_from: 2032, apply_to_lot: true }, CTX));
    expect(body.data.lot).toEqual({
      count: 2, applied: [oid('2')], unchanged: 0,
      skipped: [{ bottle_id: oid('1'), reason: 'peakFrom cannot be before drinkFrom' }],
    });
    expect(McpActionLog.create.mock.calls[0][0].prev).toEqual({ [oid('d')]: { peakFrom: null }, [oid('2')]: { peakFrom: 2030 } });
  });

  test('no lot-level field in the call: warning, ordinary update row, siblings never looked up', async () => {
    primary();
    bottleOps.updateBottleFields.mockResolvedValueOnce(changed({ notes: 'x' }, { notes: '' }));
    const body = parse(await tool('update_bottle').handler({ bottle_id: oid('d'), notes: 'x', apply_to_lot: true }, CTX));
    expect(findLotSiblings).not.toHaveBeenCalled();
    expect(body.warnings[0]).toMatch(/apply_to_lot ignored/);
    expect(McpActionLog.create.mock.calls[0][0]).toMatchObject({ action: 'update', prev: { notes: '' } });
  });

  test('bottle already matching but siblings changed: still a lot_update row, without the bottle in prev', async () => {
    primary();
    findLotSiblings.mockResolvedValue([sib('1')]);
    bottleOps.updateBottleFields
      .mockResolvedValueOnce(changed({}, {}))
      .mockResolvedValueOnce(changed({ price: 30, currency: 'EUR' }, { price: 25, currency: 'EUR' }));
    const body = parse(await tool('update_bottle').handler({ bottle_id: oid('d'), price: 30, currency: 'EUR', apply_to_lot: true }, CTX));
    expect(body.data.changes).toEqual({});
    expect(body.data.lot.applied).toEqual([oid('1')]);
    const row = McpActionLog.create.mock.calls[0][0];
    expect(row.action).toBe('lot_update');
    expect(row.prev).toEqual({ [oid('1')]: { price: 25, currency: 'EUR' } });
    expect(McpActionLog.deleteOne).not.toHaveBeenCalled();
  });

  test('nothing changed anywhere: fast path, no ledger row, lot still reported', async () => {
    primary();
    findLotSiblings.mockResolvedValue([sib('1')]);
    bottleOps.updateBottleFields.mockResolvedValue(changed({}, {}));
    const body = parse(await tool('update_bottle').handler({ bottle_id: oid('d'), drink_to: 2040, apply_to_lot: true }, CTX));
    expect(body.data.changes).toEqual({});
    expect(body.data.lot).toEqual({ count: 1, applied: [], unchanged: 1, skipped: [] });
    expect(McpActionLog.create).not.toHaveBeenCalled();
  });

  test('without apply_to_lot nothing about the lot appears and the row stays a plain update', async () => {
    primary();
    bottleOps.updateBottleFields.mockResolvedValueOnce(changed({ drinkTo: 2040 }, { drinkTo: 2035 }));
    const body = parse(await tool('update_bottle').handler({ bottle_id: oid('d'), drink_to: 2040 }, CTX));
    expect(findLotSiblings).not.toHaveBeenCalled();
    expect(body.data.lot).toBeUndefined();
    expect(McpActionLog.create.mock.calls[0][0]).toMatchObject({ action: 'update', prev: { drinkTo: 2035 } });
  });
});

describe('apply_to_lot guards (audit 2026-09-07)', () => {
  test("a price without a currency carries this bottle's currency to the siblings", async () => {
    Bottle.findById.mockReturnValue(chain({ _id: new mongoose.Types.ObjectId(oid('d')), cellar: new mongoose.Types.ObjectId(oid('c')), status: 'active', vintage: '2019', currency: 'SEK' }));
    Cellar.findById.mockReturnValue(chain({ _id: oid('c'), user: ME, members: [], deletedAt: null, name: 'Mine' }));
    findLotSiblings.mockResolvedValue([sib('1')]);
    bottleOps.updateBottleFields
      .mockResolvedValueOnce(changed({ price: 350 }, { price: 300 }))
      .mockResolvedValueOnce(changed({ price: 350, currency: 'SEK' }, { price: 20, currency: 'USD' }));
    await tool('update_bottle').handler({ bottle_id: oid('d'), price: 350, apply_to_lot: true }, CTX);
    expect(bottleOps.updateBottleFields.mock.calls[1][1]).toEqual({ price: 350, currency: 'SEK' });
  });

  test('from a bottle in a cellar shared with the user, the lot is skipped with a warning', async () => {
    Bottle.findById.mockReturnValue(chain({ _id: new mongoose.Types.ObjectId(oid('d')), cellar: new mongoose.Types.ObjectId(oid('c')), status: 'active', vintage: '2019' }));
    Cellar.findById.mockReturnValue(chain({ _id: oid('c'), user: oid('b'), members: [{ user: ME, role: 'editor' }], deletedAt: null, name: 'Theirs' }));
    bottleOps.updateBottleFields.mockResolvedValueOnce(changed({ drinkTo: 2040 }, { drinkTo: 2035 }));
    const body = parse(await tool('update_bottle').handler({ bottle_id: oid('d'), drink_to: 2040, apply_to_lot: true }, CTX));
    expect(findLotSiblings).not.toHaveBeenCalled();
    expect(body.warnings[0]).toMatch(/shared with you/);
    expect(McpActionLog.create.mock.calls[0][0].action).toBe('update');
  });
});
