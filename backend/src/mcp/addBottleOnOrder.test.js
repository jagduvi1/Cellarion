/**
 * MCP add_bottle — bottles bought but not delivered yet. The app could add a
 * bottle "on order" (and now change an order's quantity); MCP could not, so
 * an order could not be raised from Claude. on_order + expected_arrival pass
 * through to the same bottleOps.addBottle the app uses, which validates them.
 */
jest.mock('../services/bottleOps', () => ({ addBottle: jest.fn(), updateBottleFields: jest.fn() }));
jest.mock('../services/wineVisibility', () => ({ findVisibleWine: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('./actionLedger', () => ({ logAction: jest.fn(), replay: jest.fn(async () => null), releaseClaim: jest.fn() }));
jest.mock('./toolUtil', () => ({
  ...jest.requireActual('./toolUtil'),
  resolveCellarAccess: jest.fn(),
}));

const { addBottle } = require('../services/bottleOps');
const { findVisibleWine } = require('../services/wineVisibility');
const { resolveCellarAccess } = require('./toolUtil');
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
