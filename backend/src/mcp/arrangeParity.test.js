/**
 * MCP auto_arrange plans from the same data as the web Arrange preview
 * (POST /api/racks/:id/arrange/preview): the same bottle fields reach the
 * maturity classifier, and the same positions count as usable.
 *
 * The populated rack load here answers with ONLY the fields its populate
 * selects, as MongoDB would — so a field the tool forgets to select is
 * missing from the plan's input, not silently present from the fixture.
 */

const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

const pick = (doc, select) => {
  const out = { _id: doc._id };
  for (const f of select.split(/\s+/)) if (doc[f] !== undefined) out[f] = doc[f];
  return out;
};

/** Rack.findOne(...).populate(opts) → the rack with each bottle projected to opts.select. */
function projectedChain(rack) {
  const c = {};
  let opts = null;
  c.populate = jest.fn((o) => { opts = o; return c; });
  c.then = (res, rej) => Promise.resolve().then(() => ({
    ...rack,
    slots: rack.slots.map((s) => {
      const b = pick(s.bottle, opts.select);
      if (b.wineDefinition && opts.populate) b.wineDefinition = pick(s.bottle.wineDefinition, opts.populate.select);
      return { ...s, bottle: b };
    }),
  })).then(res, rej);
  return c;
}

jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({ findOne: jest.fn() }));
jest.mock('../models/Rack', () => ({ findOne: jest.fn(), updateMany: jest.fn() }));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), find: jest.fn(), deleteMany: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/bottleOps', () => ({ removeFromRacks: jest.fn() }));
jest.mock('./mutationBudget', () => ({ takeMutationSlot: jest.fn(() => true), ipKeyFor: jest.fn(() => null) }));

const mongoose = require('mongoose');
const Cellar = require('../models/Cellar');
const Rack = require('../models/Rack');
const WineVintageProfile = require('../models/WineVintageProfile');
const McpActionLog = require('../models/McpActionLog');
const { ARRANGE_SLOT_POPULATE } = require('../services/rackOps');
const { allTools } = require('./registry');
require('./tools/arrange');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const CTX = { user: { id: ME }, scopes: ['write'], req: { user: { id: ME }, headers: {} } };
const autoArrange = (args) => allTools().find((t) => t.name === 'auto_arrange').handler(args, CTX);
const parse = (res) => JSON.parse(res.content[0].text);

const THIS_YEAR = new Date().getFullYear();
const NV_WINE = new mongoose.Types.ObjectId(oid('9'));

const bottleDoc = (id, fields = {}) => ({
  _id: new mongoose.Types.ObjectId(oid(id)),
  vintage: '2015',
  status: 'active',
  wineDefinition: { _id: new mongoose.Types.ObjectId(), name: `Wine ${id}`, producer: 'P', type: 'red' },
  createdAt: new Date(Date.UTC(THIS_YEAR - 1, 0, 15)),
  ...fields,
});

function mkRack(slots, disabledPositions = []) {
  return {
    _id: new mongoose.Types.ObjectId(oid('e')),
    cellar: new mongoose.Types.ObjectId(oid('c')),
    name: 'Rack A',
    type: 'grid', rows: 2, cols: 2, isModular: false,
    disabledPositions,
    slots,
    save: jest.fn().mockResolvedValue({}),
  };
}

let populated;
function wireRackLoad(rack, profiles = []) {
  populated = projectedChain(rack);
  Rack.findOne
    .mockReturnValueOnce(chain({ cellar: rack.cellar })) // access stub
    .mockReturnValueOnce(populated);                      // populated doc
  Cellar.findById.mockReturnValue(chain({ _id: rack.cellar, user: ME, members: [], deletedAt: null, name: 'Main' }));
  WineVintageProfile.find.mockReturnValue(chain(profiles));
}

beforeEach(() => {
  jest.clearAllMocks();
  McpActionLog.create.mockResolvedValue({ _id: new mongoose.Types.ObjectId(oid('f')) });
  McpActionLog.find.mockReturnValue(chain([]));
  McpActionLog.deleteMany.mockResolvedValue({ deletedCount: 0 });
});

describe('auto_arrange plans with the same data as the web preview', () => {
  test('loads the rack with the shared arrange populate (purchaseDate + createdAt included)', async () => {
    const rack = mkRack([{ position: 1, bottle: bottleDoc('1', { drinkTo: THIS_YEAR + 5 }) }]);
    wireRackLoad(rack);
    await autoArrange({ rack_id: oid('e') });
    expect(populated.populate).toHaveBeenCalledWith(ARRANGE_SLOT_POPULATE);
    const fields = populated.populate.mock.calls[0][0].select.split(/\s+/);
    expect(fields).toEqual(expect.arrayContaining(['purchaseDate', 'createdAt']));
  });

  test('an NV bottle under a curated relative window ranks by that window, not as "no window"', async () => {
    // Bought ten years ago; the reviewed NV profile's peak ended three years
    // after purchase → declining → it belongs in the first slot.
    const nv = bottleDoc('2', {
      vintage: 'NV',
      wineDefinition: { _id: NV_WINE, name: 'Old NV', producer: 'House', type: 'sparkling' },
      purchaseDate: new Date(Date.UTC(THIS_YEAR - 10, 5, 1)),
    });
    const rack = mkRack([
      { position: 1, bottle: bottleDoc('1', { drinkTo: THIS_YEAR + 5 }) }, // peak
      { position: 2, bottle: nv },
    ]);
    wireRackLoad(rack, [{
      wineDefinition: NV_WINE, vintage: 'NV', status: 'reviewed', relative: true,
      earlyFrom: 0, peakFrom: 1, peakUntil: 3,
    }]);

    const body = parse(await autoArrange({ rack_id: oid('e'), strategy: 'maturity' }));

    expect(body.data.bottles_moving).toBe(2);
    expect(body.data.moves[0]).toMatchObject({ from: 2, to: 1 });
    expect(body.data.moves[0].bottle).toContain('Old NV');
    expect(McpActionLog.create.mock.calls[0][0].prev.target[0]).toEqual({ position: 1, bottleId: oid('2') });
  });

  test('usable positions are counted like the web: a disabled entry twice or beyond the rack does not shrink it', async () => {
    // 2×2 rack, position 1 disabled → 3 usable, 3 bottles fit. The extra
    // entries (99 twice) are not positions of this rack.
    const rack = mkRack([
      { position: 2, bottle: bottleDoc('1', { vintage: '2020' }) },
      { position: 3, bottle: bottleDoc('2', { vintage: '2010' }) },
      { position: 4, bottle: bottleDoc('3', { vintage: '2000' }) },
    ], [1, 99, 99]);
    wireRackLoad(rack);

    const body = parse(await autoArrange({ rack_id: oid('e'), strategy: 'vintage' }));

    expect(body.error).toBeUndefined();
    expect(body.data.bottles_total).toBe(3);
    const target = McpActionLog.create.mock.calls[0][0].prev.target;
    expect(target.map((t) => t.position)).toEqual([2, 3, 4]);
    expect(target[0].bottleId).toBe(oid('3')); // oldest vintage first
  });

  test('more bottles than usable positions still refuses with conflict', async () => {
    const rack = mkRack([
      { position: 3, bottle: bottleDoc('1') },
      { position: 4, bottle: bottleDoc('2') },
    ], [1, 2, 3]);
    wireRackLoad(rack);
    const body = parse(await autoArrange({ rack_id: oid('e') }));
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toMatch(/only 1 usable position/);
    expect(McpActionLog.create).not.toHaveBeenCalled();
  });
});
