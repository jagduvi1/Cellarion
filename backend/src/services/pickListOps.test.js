/**
 * Pick lists (forum request 2026-10-13) — the shared service behind REST
 * /api/pick-lists and the MCP pick-list tools. Pinned: only bottles the user
 * can see and that are still in the cellar go on a list; the caps; the
 * duplicate-proof atomic add; another user's list reads as not found; and the
 * view's walking order (cellar → rack group/creation → slot, unplaced last,
 * drunk after, unavailable last) with live rack positions.
 */
const mongoose = require('mongoose');

const chain = (v) => {
  const q = {
    select: () => q, populate: () => q, sort: () => q, limit: () => q,
    lean: async () => v,
    then: (res, rej) => Promise.resolve(v).then(res, rej),
  };
  return q;
};

jest.mock('../models/PickList', () => {
  const M = {
    find: jest.fn(), findOne: jest.fn(), create: jest.fn(), countDocuments: jest.fn(),
    findOneAndUpdate: jest.fn(), findOneAndDelete: jest.fn(),
  };
  M.MAX_ITEMS_PER_LIST = 500;
  M.MAX_LISTS_PER_USER = 50;
  return M;
});
jest.mock('../models/Bottle', () => ({ find: jest.fn() }));
jest.mock('../models/Cellar', () => ({ find: jest.fn() }));
jest.mock('../models/Rack', () => ({ find: jest.fn() }));
jest.mock('../models/CellarLayout', () => ({ find: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));

const PickList = require('../models/PickList');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const Rack = require('../models/Rack');
const CellarLayout = require('../models/CellarLayout');
const { logAudit } = require('./audit');
const ops = require('./pickListOps');

const oid = (n) => new mongoose.Types.ObjectId(String(n).padStart(24, '0'));
const ME = String(oid('a1'));
const OTHER = String(oid('a2'));
const REQ = { user: { id: ME } };
const C1 = oid('c1');
const C2 = oid('c2');
const FOREIGN = oid('c9');
const B = (n) => String(oid(`b${n}`));

beforeEach(() => {
  jest.clearAllMocks();
  Cellar.find.mockImplementation(() => chain([
    { _id: C1, name: 'Home', user: oid('a1'), members: [] },
    { _id: C2, name: 'Basement', user: oid('a3'), members: [{ user: oid('a1'), role: 'viewer' }] },
    { _id: FOREIGN, name: 'Not mine', user: oid('a3'), members: [] },
  ]));
});

describe('createPickList', () => {
  test('a name is required, capped, and stripped of HTML', async () => {
    expect((await ops.createPickList(ME, { name: '  ' }, REQ)).error.status).toBe(400);
    expect((await ops.createPickList(ME, { name: 'x'.repeat(101) }, REQ)).error.status).toBe(400);
    PickList.countDocuments.mockResolvedValue(0);
    PickList.create.mockImplementation(async (doc) => ({ ...doc, _id: oid('f1'), toObject() { return this; } }));
    const res = await ops.createPickList(ME, { name: '<b>Saturday</b> dinner' }, REQ);
    expect(res.list.name).toBe('Saturday dinner');
    expect(logAudit).toHaveBeenCalledWith(REQ, 'picklist.create', { type: 'picklist', id: oid('f1') }, { name: 'Saturday dinner', bottles: 0 });
  });

  test('at most 50 lists per user', async () => {
    PickList.countDocuments.mockResolvedValue(50);
    const res = await ops.createPickList(ME, { name: 'One more' }, REQ);
    expect(res.error.status).toBe(400);
    expect(PickList.create).not.toHaveBeenCalled();
  });

  test('only bottles the user can see and that are in the cellar are added; the rest are skipped with a reason', async () => {
    PickList.countDocuments.mockResolvedValue(0);
    PickList.create.mockImplementation(async (doc) => ({ ...doc, _id: oid('f1'), toObject() { return this; } }));
    Bottle.find.mockReturnValue(chain([
      { _id: oid('b1'), cellar: C1, status: 'active' },
      { _id: oid('b2'), cellar: C2, status: 'active' },   // shared with me as viewer
      { _id: oid('b3'), cellar: C1, status: 'drank' },
      { _id: oid('b4'), cellar: FOREIGN, status: 'active' },
    ]));
    const res = await ops.createPickList(ME, { name: 'Dinner', bottleIds: [B(1), B(2), B(3), B(4), B(5), B(1)] }, REQ);
    expect(res.added).toBe(2);
    expect(PickList.create.mock.calls[0][0].items.map((it) => it.bottle)).toEqual([B(1), B(2)]);
    expect(res.skipped).toEqual([
      { id: B(3), reason: 'not_in_cellar' },
      { id: B(4), reason: 'not_found' },
      { id: B(5), reason: 'not_found' },
    ]);
  });

  test('bottle ids must be ids', async () => {
    expect((await ops.createPickList(ME, { name: 'x', bottleIds: ['nope'] }, REQ)).error.status).toBe(400);
    expect((await ops.createPickList(ME, { name: 'x', bottleIds: 'nope' }, REQ)).error.status).toBe(400);
  });
});

describe('addToPickList', () => {
  const list = (items = []) => ({ _id: oid('f1'), user: oid('a1'), name: 'Dinner', items });

  test('another user\'s list reads as not found', async () => {
    PickList.findOne.mockReturnValue(chain(null));
    const res = await ops.addToPickList(OTHER, String(oid('f1')), [B(1)], REQ);
    expect(res.error.status).toBe(404);
    expect(PickList.findOne).toHaveBeenCalledWith({ _id: String(oid('f1')), user: OTHER });
  });

  test('adds only new bottles, with a guarded atomic update (no duplicates, cap held)', async () => {
    PickList.findOne.mockReturnValue(chain(list([{ bottle: oid('b1'), pickedAt: null }])));
    Bottle.find.mockReturnValue(chain([
      { _id: oid('b1'), cellar: C1, status: 'active' },
      { _id: oid('b2'), cellar: C1, status: 'active' },
    ]));
    PickList.findOneAndUpdate.mockReturnValue(chain(list([{ bottle: oid('b1') }, { bottle: oid('b2') }])));
    const res = await ops.addToPickList(ME, String(oid('f1')), [B(1), B(2)], REQ);
    expect(res.added).toBe(1);
    expect(res.skipped).toEqual([{ id: B(1), reason: 'already_on_list' }]);
    const [filter, update] = PickList.findOneAndUpdate.mock.calls[0];
    expect(filter['items.bottle']).toEqual({ $nin: [oid('b2')] });
    expect(filter['items.499']).toEqual({ $exists: false });
    expect(update.$push.items.$each.map((it) => it.bottle)).toEqual([B(2)]);
  });

  test('a full list refuses more', async () => {
    const full = Array.from({ length: 500 }, (_, i) => ({ bottle: oid(`e${i}`) }));
    PickList.findOne.mockReturnValue(chain(list(full)));
    Bottle.find.mockReturnValue(chain([{ _id: oid('b2'), cellar: C1, status: 'active' }]));
    const res = await ops.addToPickList(ME, String(oid('f1')), [B(2)], REQ);
    expect(res.error.status).toBe(400);
    expect(PickList.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('remove, tick, rename, delete', () => {
  test('remove pulls the bottles and reports how many went', async () => {
    PickList.findOne.mockReturnValue(chain({ _id: oid('f1'), name: 'Dinner', items: [{ bottle: oid('b1') }, { bottle: oid('b2') }] }));
    PickList.findOneAndUpdate.mockReturnValue(chain({ _id: oid('f1'), name: 'Dinner', items: [{ bottle: oid('b2') }] }));
    const res = await ops.removeFromPickList(ME, String(oid('f1')), [B(1)], REQ);
    expect(res.removed).toBe(1);
    expect(PickList.findOneAndUpdate.mock.calls[0][1]).toEqual({ $pull: { items: { bottle: { $in: [oid('b1')] } } } });
  });

  test('tick sets pickedAt on the named bottles only (arrayFilters); untick clears it; picked must be a boolean', async () => {
    PickList.findOneAndUpdate.mockReturnValue(chain({ _id: oid('f1'), name: 'Dinner', items: [] }));
    await ops.setPicked(ME, String(oid('f1')), [B(1)], true);
    let [, update, opts] = PickList.findOneAndUpdate.mock.calls[0];
    expect(update.$set['items.$[it].pickedAt']).toBeInstanceOf(Date);
    expect(opts.arrayFilters).toEqual([{ 'it.bottle': { $in: [oid('b1')] } }]);
    await ops.setPicked(ME, String(oid('f1')), [B(1)], false);
    [, update] = PickList.findOneAndUpdate.mock.calls[1];
    expect(update.$set['items.$[it].pickedAt']).toBeNull();
    expect((await ops.setPicked(ME, String(oid('f1')), [B(1)], 'yes')).error.status).toBe(400);
  });

  test('rename and delete are scoped to the owner and audited', async () => {
    PickList.findOneAndUpdate.mockReturnValue(chain(null));
    expect((await ops.renamePickList(OTHER, String(oid('f1')), 'New', REQ)).error.status).toBe(404);
    PickList.findOneAndDelete.mockReturnValue(chain({ _id: oid('f1'), name: 'Dinner', items: [{}, {}] }));
    expect(await ops.deletePickList(ME, String(oid('f1')), REQ)).toEqual({ deleted: true });
    expect(PickList.findOneAndDelete).toHaveBeenCalledWith({ _id: String(oid('f1')), user: ME });
    expect(logAudit).toHaveBeenCalledWith(REQ, 'picklist.delete', { type: 'picklist', id: oid('f1') }, { name: 'Dinner', bottles: 2 });
  });
});

describe('getPickListView', () => {
  test('walking order: cellar by name → racks (group, then made) → slot; unplaced last; drunk after; unavailable last', async () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ bottle: oid(`b${n}`), addedAt: new Date(), pickedAt: n === 2 ? new Date() : null }));
    PickList.findOne.mockReturnValue(chain({ _id: oid('f1'), name: 'Dinner', items }));
    const wine = (name) => ({ _id: oid('dd1'), name, producer: 'P', type: 'red' });
    Bottle.find.mockReturnValue(chain([
      { _id: oid('b1'), cellar: C1, status: 'active', wineDefinition: wine('Home fridge 9'), vintage: '2019' },
      { _id: oid('b2'), cellar: C1, status: 'active', wineDefinition: wine('Home fridge 3'), vintage: '2019' },
      { _id: oid('b3'), cellar: C1, status: 'active', wineDefinition: wine('Home shelf 1'), vintage: '2019' },
      { _id: oid('b4'), cellar: C1, status: 'active', wineDefinition: wine('Home unplaced'), vintage: '2019', location: 'On the floor' },
      { _id: oid('b5'), cellar: C2, status: 'active', wineDefinition: wine('Basement 1'), vintage: '2019' },
      { _id: oid('b6'), cellar: C1, status: 'drank', wineDefinition: wine('Drunk'), vintage: '2019' },
      { _id: oid('b7'), cellar: FOREIGN, status: 'active', wineDefinition: wine('Secret'), vintage: '2019' },
      // b8 deleted
    ]));
    Rack.find.mockReturnValue(chain([
      // Made first but in group "Kitchen" with a later rack; "Shelf" is ungrouped.
      { _id: oid('aa1'), cellar: C1, name: 'Fridge', group: 'Kitchen', createdAt: new Date('2026-01-01'), slots: [{ position: 9, bottle: oid('b1') }, { position: 3, bottle: oid('b2') }] },
      { _id: oid('aa2'), cellar: C1, name: 'Shelf', group: null, createdAt: new Date('2025-01-01'), slots: [{ position: 1, bottle: oid('b3') }] },
      { _id: oid('aa3'), cellar: C2, name: 'Rack A', group: null, createdAt: new Date('2025-06-01'), slots: [{ position: 1, bottle: oid('b5') }] },
    ]));
    CellarLayout.find.mockReturnValue(chain([{ cellar: C1, rackPlacements: [{ rack: oid('aa1') }] }]));

    const { list } = await ops.getPickListView(ME, String(oid('f1')));
    expect(list.items.map((it) => it.wine?.name || it.state)).toEqual([
      'Basement 1', // cellar "Basement" sorts before "Home"
      'Home fridge 3', 'Home fridge 9', // grouped rack first, by slot
      'Home shelf 1', // ungrouped rack after the groups
      'Home unplaced', // not in a rack: last in its cellar
      'Drunk', // no longer in the cellar
      'unavailable', 'unavailable', // a cellar I can't see, and a deleted bottle — nothing about them
    ]);
    const fridge3 = list.items[1];
    expect(fridge3.rack).toMatchObject({ rackName: 'Fridge', position: 3, inRoom: true });
    expect(fridge3.pickedAt).toBeInstanceOf(Date);
    expect(list.items[4]).toMatchObject({ rack: null, location: 'On the floor' });
    expect(list.items[5].state).toBe('drunk');
    expect(list.items[6]).toEqual(expect.objectContaining({ state: 'unavailable' }));
    expect(list.items[6].wine).toBeUndefined();
    expect(list.count).toBe(8);
    expect(list.picked).toBe(1);
  });
});
