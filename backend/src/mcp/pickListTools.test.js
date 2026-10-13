/**
 * MCP pick-list tools — the wiring onto services/pickListOps (whose rules are
 * covered in services/pickListOps.test.js): scopes, snake_case params,
 * error-code mapping, update_pick_list doing several changes in one call,
 * and delete_pick_list needing confirm:true.
 */
jest.mock('../services/pickListOps', () => ({
  listPickLists: jest.fn(), createPickList: jest.fn(), renamePickList: jest.fn(),
  addToPickList: jest.fn(), removeFromPickList: jest.fn(), setPicked: jest.fn(),
  deletePickList: jest.fn(), getPickListView: jest.fn(),
}));

const ops = require('../services/pickListOps');
require('./tools/pickLists');
const { allTools } = require('./registry');

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);
const CTX = { user: { id: 'u1' }, req: { user: { id: 'u1' } } };
const L = '0123456789abcdef01234567';
const B1 = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const B2 = 'aaaaaaaaaaaaaaaaaaaaaaa2';

beforeEach(() => jest.clearAllMocks());

test('reads are read-scoped, changes write-scoped', () => {
  expect(tool('list_pick_lists').scope).toBe('read');
  expect(tool('get_pick_list').scope).toBe('read');
  for (const n of ['create_pick_list', 'update_pick_list', 'delete_pick_list']) expect(tool(n).scope).toBe('write');
});

test('get_pick_list: rack and slot per bottle; an unavailable bottle says nothing about itself', async () => {
  ops.getPickListView.mockResolvedValue({ list: { id: L, name: 'Dinner', count: 2, picked: 1, items: [
    { bottleId: B1, state: 'in_cellar', pickedAt: new Date(), wine: { producer: 'Brezza', name: 'Barolo' }, vintage: '2018', bottleSize: '750ml', cellar: { name: 'Home' }, rack: { rackName: 'Fridge', position: 12 }, location: null },
    { bottleId: B2, state: 'unavailable', pickedAt: null },
  ] } });
  const data = parse(await tool('get_pick_list').handler({ pick_list_id: L }, CTX)).data;
  expect(data.items[0]).toMatchObject({ wine: 'Brezza — Barolo', cellar: 'Home', rack: 'Fridge', slot: 12, picked: true });
  expect(data.items[1]).toEqual({ bottle_id: B2, state: 'unavailable', picked: false });
});

test('errors map to MCP codes', async () => {
  ops.getPickListView.mockResolvedValue({ error: { status: 404, message: 'Pick list not found' } });
  expect(parse(await tool('get_pick_list').handler({ pick_list_id: L }, CTX)).error.code).toBe('not_found');
  ops.createPickList.mockResolvedValue({ error: { status: 400, message: 'A pick list needs a name' } });
  expect(parse(await tool('create_pick_list').handler({ name: ' ' }, CTX)).error.code).toBe('invalid_input');
});

test('update_pick_list applies rename, add, remove and ticks in one call', async () => {
  ops.renamePickList.mockResolvedValue({ list: { name: 'Friday' } });
  ops.addToPickList.mockResolvedValue({ added: 1, skipped: [] });
  ops.removeFromPickList.mockResolvedValue({ removed: 1 });
  ops.setPicked.mockResolvedValue({ list: {}, matched: 1 });
  ops.getPickListView.mockResolvedValue({ list: { id: L, name: 'Friday', count: 2, picked: 1, items: [] } });
  const res = parse(await tool('update_pick_list').handler({
    pick_list_id: L, name: 'Friday', add_bottle_ids: [B1], remove_bottle_ids: [B2], picked_bottle_ids: [B1],
  }, CTX));
  expect(res.data).toMatchObject({ renamed: 'Friday', added: 1, removed: 1, ticked: 1 });
  expect(ops.addToPickList).toHaveBeenCalledWith('u1', L, [B1], CTX.req);
  expect(ops.setPicked).toHaveBeenCalledWith('u1', L, [B1], true);
  expect(parse(await tool('update_pick_list').handler({ pick_list_id: L }, CTX)).error.code).toBe('invalid_input');
});

// Release audit 2026-10-13: a later step failing hid the steps already applied.
test('update_pick_list: a failing later step says what was already applied', async () => {
  ops.renamePickList.mockResolvedValue({ list: { name: 'Friday' } });
  ops.addToPickList.mockResolvedValue({ error: { status: 400, message: 'A pick list holds at most 500 bottles' } });
  const res = parse(await tool('update_pick_list').handler({ pick_list_id: L, name: 'Friday', add_bottle_ids: [B1] }, CTX));
  expect(res.error.code).toBe('invalid_input');
  expect(res.error.message).toMatch(/already applied: \{"renamed":"Friday"\}/);
});

test('delete_pick_list needs confirm:true', async () => {
  expect(parse(await tool('delete_pick_list').handler({ pick_list_id: L }, CTX)).error.code).toBe('invalid_input');
  expect(ops.deletePickList).not.toHaveBeenCalled();
  ops.deletePickList.mockResolvedValue({ deleted: true });
  expect(parse(await tool('delete_pick_list').handler({ pick_list_id: L, confirm: true }, CTX)).data.deleted).toBe(true);
});
