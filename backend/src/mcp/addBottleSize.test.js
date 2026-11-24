/**
 * MCP add_bottle — the bottle's size. update_bottle could set it; add_bottle
 * could not, so a magnum was added as a standard bottle and corrected in a
 * second call. bottle_size is read the way update_bottle reads it (a volume or
 * a format name) and passed to the same bottleOps.addBottle the app uses. A
 * size that cannot be read is refused before a new wine is minted: the service
 * would store it as 750 ml. Harness from addBottleOnOrder.test.js.
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

const { addBottle } = require('../services/bottleOps');
const { findVisibleWine } = require('../services/wineVisibility');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const { resolveCellarAccess } = require('./toolUtil');
require('./tools/write');
const { allTools } = require('./registry');

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);
const refused = (res) => res.ok === false || !!res.error;
const CTX = { user: { id: 'u1', roles: ['user'] }, req: { user: { id: 'u1' } } };
const CELLAR = '0123456789abcdef01234567';
const WINE = 'aaaaaaaaaaaaaaaaaaaaaaa1';

beforeEach(() => {
  jest.clearAllMocks();
  resolveCellarAccess.mockResolvedValue({ cellar: { _id: CELLAR, name: 'Home' }, role: 'owner' });
  findVisibleWine.mockResolvedValue({ _id: WINE, name: 'Barolo', producer: 'Cantina' });
  addBottle.mockResolvedValue({ bottle: { _id: 'b1', vintage: '2019', status: 'active' } });
});

test.each([
  ['magnum', '1500ml'],
  ['Magnum', '1500ml'],
  ['1.5 L', '1500ml'],
  ['375ml', '375ml'],
  ['half', '375ml'],
  ['double magnum', '3000ml'],
])('bottle_size "%s" reaches the bottle as %s', async (said, stored) => {
  const res = parse(await tool('add_bottle').handler({ cellar_id: CELLAR, wine_id: WINE, vintage: '2019', bottle_size: said }, CTX));
  expect(refused(res)).toBe(false);
  expect(addBottle.mock.calls[0][2].bottleSize).toBe(stored);
});

test('left out, no size is passed: the service stores a standard bottle', async () => {
  await tool('add_bottle').handler({ cellar_id: CELLAR, wine_id: WINE, vintage: '2019' }, CTX);
  expect(addBottle.mock.calls[0][2].bottleSize).toBeUndefined();
});

test('a size that cannot be read is refused BEFORE a new wine is minted, with the sizes named', async () => {
  const res = parse(await tool('add_bottle').handler({
    cellar_id: CELLAR, new_wine: { name: 'Barolo', producer: 'Cantina', country: 'Italy', type: 'red' }, bottle_size: 'a big one',
  }, CTX));
  expect(refused(res)).toBe(true);
  expect(res.error.message).toMatch(/bottle_size "a big one" is not a size Cellarion can read/);
  expect(res.error.message).toMatch(/1500ml/);
  expect(findOrCreateWine).not.toHaveBeenCalled();
  expect(addBottle).not.toHaveBeenCalled();
});

test('add_bottle and update_bottle read a size the same way', async () => {
  const { resolveMcpBottleSize } = require('./tools/write');
  expect(tool('add_bottle').inputSchema.bottle_size).toBeDefined();
  expect(tool('update_bottle').inputSchema.bottle_size).toBeDefined();
  expect(resolveMcpBottleSize('imperial')).toBe('6000ml');
  expect(resolveMcpBottleSize('a big one')).toBeFalsy();
});
