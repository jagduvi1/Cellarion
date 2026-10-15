/**
 * MCP add_bottle — bottles bought but not delivered yet. The app could add a
 * bottle "on order" (and now change an order's quantity); MCP could not, so
 * an order could not be raised from Claude. on_order + expected_arrival pass
 * through to the same bottleOps.addBottle the app uses, which validates them.
 */
jest.mock('../services/bottleOps', () => ({ addBottle: jest.fn(), updateBottleFields: jest.fn(), markArrived: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../services/wineVisibility', () => ({ findVisibleWine: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('./actionLedger', () => ({ logAction: jest.fn(), replay: jest.fn(async () => null), releaseClaim: jest.fn() }));
jest.mock('./toolUtil', () => ({
  ...jest.requireActual('./toolUtil'),
  resolveCellarAccess: jest.fn(),
  resolveBottleAccess: jest.fn(),
}));

const { addBottle, updateBottleFields, markArrived } = require('../services/bottleOps');
const { findVisibleWine } = require('../services/wineVisibility');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const { resolveCellarAccess, resolveBottleAccess } = require('./toolUtil');
const { logAction } = require('./actionLedger');
require('./tools/write');
const { allTools } = require('./registry');

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);
const CTX = { user: { id: 'u1', roles: ['user'] }, req: { user: { id: 'u1' } } };
const CELLAR = '0123456789abcdef01234567';
const WINE = 'aaaaaaaaaaaaaaaaaaaaaaa1';

beforeEach(() => {
  jest.clearAllMocks();
  resolveCellarAccess.mockResolvedValue({ cellar: { _id: CELLAR, name: 'Home' }, role: 'owner' });
  findVisibleWine.mockResolvedValue({ _id: WINE, name: 'Léoville Barton', producer: 'Barton' });
});

test('on_order adds the bottle on order, with its expected month', async () => {
  addBottle.mockResolvedValue({ bottle: { _id: 'b1', vintage: '2023', status: 'ordered' } });
  const res = parse(await tool('add_bottle').handler({ cellar_id: CELLAR, wine_id: WINE, vintage: '2023', on_order: true, expected_arrival: '2027-03' }, CTX));
  expect(addBottle).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ onOrder: true, expectedArrival: '2027-03' }), CTX.req);
  expect(res.summary).toMatch(/on order/);
});

test('without on_order nothing changes: an ordinary bottle, and a stray month is not passed on', async () => {
  addBottle.mockResolvedValue({ bottle: { _id: 'b2', vintage: '2023', status: 'active' } });
  const res = parse(await tool('add_bottle').handler({ cellar_id: CELLAR, wine_id: WINE, vintage: '2023', expected_arrival: '2027-03' }, CTX));
  const fields = addBottle.mock.calls[0][2];
  expect(fields.onOrder).toBe(false);
  expect(fields.expectedArrival).toBeUndefined();
  expect(res.summary).not.toMatch(/on order/);
});

test('the schema takes a month only as YYYY-MM', () => {
  const schema = tool('add_bottle').inputSchema.expected_arrival;
  expect(schema.safeParse('2027-03').success).toBe(true);
  expect(schema.safeParse('March 2027').success).toBe(false);
});

test('a month that is not real is refused BEFORE a new wine is minted (nothing left behind)', async () => {
  const res = parse(await tool('add_bottle').handler({ cellar_id: CELLAR, new_wine: { name: 'X', producer: 'Y', country: 'France' }, on_order: true, expected_arrival: '2027-13' }, CTX));
  expect(res.ok === false || res.error).toBeTruthy();
  expect(findOrCreateWine).not.toHaveBeenCalled();
  expect(addBottle).not.toHaveBeenCalled();
});

describe('mark_arrived', () => {
  const BOTTLE = 'bbbbbbbbbbbbbbbbbbbbbbb1';
  const added = new Date('2026-09-01T10:00:00Z');
  beforeEach(() => {
    resolveBottleAccess.mockResolvedValue({ bottle: { _id: BOTTLE, status: 'ordered', addedToCellarAt: added, arrivalNotifiedAt: null, cellar: CELLAR }, cellar: { _id: CELLAR, name: 'Home' } });
  });

  test('brings a bottle on order into the cellar, with the day it came, and records how to undo it', async () => {
    markArrived.mockResolvedValue({ bottle: { _id: BOTTLE, status: 'active', vintage: '2023', arrivedAt: new Date('2026-10-14T12:00:00Z'), cellar: CELLAR } });
    const res = parse(await tool('mark_arrived').handler({ bottle_id: BOTTLE, arrived_on: '2026-10-14' }, CTX));
    expect(markArrived).toHaveBeenCalledWith(expect.objectContaining({ _id: BOTTLE }), { arrivedAt: '2026-10-14' }, CTX.req);
    expect(res.data.status).toBe('active');
    expect(logAction).toHaveBeenCalledWith(CTX, expect.objectContaining({ tool: 'mark_arrived', action: 'arrive', prev: { addedToCellarAt: added, arrivalNotifiedAt: null } }));
    expect(tool('mark_arrived').scope).toBe('write');
  });

  test('a bottle that is not on order: a conflict, nothing logged', async () => {
    markArrived.mockResolvedValue({ error: { status: 409, code: 'not_on_order', message: 'This bottle is not on order' } });
    const res = parse(await tool('mark_arrived').handler({ bottle_id: BOTTLE }, CTX));
    expect(JSON.stringify(res)).toMatch(/conflict/);
    expect(logAction).not.toHaveBeenCalled();
  });
});

test('update_bottle passes the month of an order on (the shared update keeps it on bottles on order only)', async () => {
  resolveBottleAccess.mockResolvedValue({ bottle: { _id: 'b1', status: 'ordered', cellar: CELLAR }, cellar: { _id: CELLAR, user: 'u1', name: 'Home' } });
  updateBottleFields.mockResolvedValue({ changes: { expectedArrival: true }, prev: { expectedArrival: null } });
  await tool('update_bottle').handler({ bottle_id: 'bbbbbbbbbbbbbbbbbbbbbbb1', expected_arrival: '2027-04' }, CTX);
  expect(updateBottleFields.mock.calls[0][1].expectedArrival).toBe('2027-04');
});

test('update_bottle refuses an expected month on a bottle that is not on order (never "no changes")', async () => {
  resolveBottleAccess.mockResolvedValue({ bottle: { _id: 'b2', status: 'active', cellar: CELLAR }, cellar: { _id: CELLAR, user: 'u1', name: 'Home' } });
  const res = parse(await tool('update_bottle').handler({ bottle_id: 'bbbbbbbbbbbbbbbbbbbbbbb2', expected_arrival: '2027-04' }, CTX));
  expect(JSON.stringify(res)).toMatch(/only to a bottle on order/);
  expect(updateBottleFields).not.toHaveBeenCalled();
});
