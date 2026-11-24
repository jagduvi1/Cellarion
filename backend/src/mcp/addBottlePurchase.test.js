/**
 * MCP add_bottle — where a bottle was bought. update_bottle could set the shop,
 * the link and the day; add_bottle took the shop alone, so an assistant adding
 * a wine from a shop page needed a second call to keep the link. purchase_url
 * and purchase_date pass through to the same bottleOps.addBottle the app uses.
 * Both are checked before a new wine is minted, so a refusal leaves no wine
 * without its bottle. Harness from addBottleOnOrder.test.js.
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
const LINK = 'https://shop.example/wines/barolo-2019';
const NEW_WINE = { name: 'Barolo', producer: 'Cantina', country: 'Italy', type: 'red' };

beforeEach(() => {
  jest.clearAllMocks();
  resolveCellarAccess.mockResolvedValue({ cellar: { _id: CELLAR, name: 'Home' }, role: 'owner' });
  findVisibleWine.mockResolvedValue({ _id: WINE, name: 'Barolo', producer: 'Cantina' });
  addBottle.mockResolvedValue({ bottle: { _id: 'b1', vintage: '2019', status: 'active' } });
});

test('the shop, its link and the day bought reach the bottle in one call', async () => {
  const res = parse(await tool('add_bottle').handler({
    cellar_id: CELLAR, wine_id: WINE, vintage: '2019', price: 39, currency: 'EUR',
    purchase_location: 'Shop Example', purchase_url: LINK, purchase_date: '2026-11-20',
  }, CTX));
  expect(refused(res)).toBe(false);
  expect(addBottle).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
    purchaseLocation: 'Shop Example', purchaseUrl: LINK, purchaseDate: '2026-11-20',
  }), CTX.req);
});

test('left out, neither is set: the bottle gets no link and today as its day', async () => {
  await tool('add_bottle').handler({ cellar_id: CELLAR, wine_id: WINE, vintage: '2019' }, CTX);
  const fields = addBottle.mock.calls[0][2];
  expect(fields.purchaseUrl).toBeUndefined();
  expect(fields.purchaseDate).toBeUndefined();
});

test.each([
  ['a script link', 'javascript:alert(1)'],
  ['a link without a scheme', 'shop.example/wines/barolo'],
  ['a file link', 'file:///etc/passwd'],
])('%s is refused BEFORE a new wine is minted (nothing left behind)', async (_label, link) => {
  const res = parse(await tool('add_bottle').handler({ cellar_id: CELLAR, new_wine: NEW_WINE, purchase_url: link }, CTX));
  expect(refused(res)).toBe(true);
  expect(JSON.stringify(res)).toMatch(/purchase_url/);
  expect(findOrCreateWine).not.toHaveBeenCalled();
  expect(addBottle).not.toHaveBeenCalled();
});

test('a day that does not exist is refused BEFORE a new wine is minted', async () => {
  const res = parse(await tool('add_bottle').handler({ cellar_id: CELLAR, new_wine: NEW_WINE, purchase_date: '2026-02-30' }, CTX));
  expect(refused(res)).toBe(true);
  expect(JSON.stringify(res)).toMatch(/purchase_date/);
  expect(findOrCreateWine).not.toHaveBeenCalled();
  expect(addBottle).not.toHaveBeenCalled();
});

test('an empty link counts as no link', async () => {
  const res = parse(await tool('add_bottle').handler({ cellar_id: CELLAR, wine_id: WINE, purchase_url: '' }, CTX));
  expect(refused(res)).toBe(false);
  expect(addBottle).toHaveBeenCalledTimes(1);
});

test('the schema takes a day only as YYYY-MM-DD and a link of at most 2048 characters', () => {
  const { purchase_date: day, purchase_url: link } = tool('add_bottle').inputSchema;
  expect(day.safeParse('2026-11-20').success).toBe(true);
  expect(day.safeParse('20 November 2026').success).toBe(false);
  expect(day.safeParse('2026-11-20T10:00:00Z').success).toBe(false);
  expect(link.safeParse(LINK).success).toBe(true);
  expect(link.safeParse(`https://shop.example/${'a'.repeat(2048)}`).success).toBe(false);
});

test('add_bottle and update_bottle describe the same three purchase fields', () => {
  const add = tool('add_bottle').inputSchema;
  const update = tool('update_bottle').inputSchema;
  for (const field of ['purchase_location', 'purchase_url', 'purchase_date']) {
    expect(add[field]).toBeDefined();
    expect(update[field]).toBeDefined();
  }
});
