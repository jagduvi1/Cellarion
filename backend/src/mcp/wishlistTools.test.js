/**
 * MCP wishlist tools — add_to_wishlist / update_wishlist_item /
 * remove_from_wishlist, the twins of REST POST/PUT/DELETE /api/wishlist
 * through services/wishlistOps.
 *
 * Pins: a wine the registry does not know can be wished for (new_wine mints
 * through the MCP chokepoint, stamped createdVia:'mcp' and audited); every
 * item field is checked BEFORE a mint, so a refusal leaves no wine behind;
 * the duplicate check names the item already there; a foreign item is
 * not_found; a removal needs confirm:true; the audit rows say via:'mcp'.
 */

const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

jest.mock('../models/WishlistItem', () => ({
  find: jest.fn(), countDocuments: jest.fn(), findOne: jest.fn(), findById: jest.fn(), create: jest.fn(),
}));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), deleteOne: jest.fn(() => Promise.resolve({})) }));
jest.mock('../services/search', () => ({ getIsAvailable: jest.fn(() => false), search: jest.fn() }));
jest.mock('../services/statsService', () => ({ computeOverview: jest.fn(), buildEmptyStats: jest.fn() }));
jest.mock('../services/vectorStore', () => ({ getPoints: jest.fn(), searchSimilar: jest.fn() }));
jest.mock('../config/aiConfig', () => ({ get: jest.fn(() => ({ vectorIndex: 'v1' })) }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
// The rest stays real: toolUtil reads its CURATION_ROLES.
jest.mock('../services/wineVisibility', () => ({
  ...jest.requireActual('../services/wineVisibility'), findVisibleWine: jest.fn(),
}));

const WishlistItem = require('../models/WishlistItem');
const { logAudit } = require('../services/audit');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const { findVisibleWine } = require('../services/wineVisibility');
const { allTools, toolsForScopes } = require('./registry');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const STRANGER = oid('b');
const WINE_ID = oid('f');
const ITEM_ID = oid('e');
const REQ = { user: { id: ME, roles: ['user'] }, headers: {}, apiToken: { id: 't1', scopes: ['read', 'write'] } };
const CTX = { user: { id: ME, roles: ['user'] }, scopes: ['read', 'write'], req: REQ };

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (name, args) => parse(await tool(name).handler(args, CTX));

const WINE = { _id: WINE_ID, name: 'Riesling Steinberg', producer: 'Weingut Klein', type: 'white' };
const populatedItem = (fields = {}) => ({
  _id: ITEM_ID,
  wineDefinition: { ...WINE, country: { name: 'Germany' }, region: null },
  priority: 'medium',
  status: 'wanted',
  createdAt: new Date('2026-11-28T10:00:00Z'),
  ...fields,
});

const NEW_WINE = { name: 'Riesling Steinberg', producer: 'Weingut Klein', country: 'Germany', type: 'white' };

beforeEach(() => {
  jest.clearAllMocks();
  WishlistItem.findOne.mockResolvedValue(null);
  WishlistItem.create.mockImplementation(async (doc) => ({ _id: ITEM_ID, ...doc }));
  WishlistItem.findById.mockReturnValue(chain(populatedItem()));
  findVisibleWine.mockResolvedValue({ _id: WINE_ID, name: WINE.name });
});

describe('scope', () => {
  test('the three wishlist writes carry write scope; a read token sees list_wishlist only', () => {
    for (const name of ['add_to_wishlist', 'update_wishlist_item', 'remove_from_wishlist']) {
      expect(tool(name).scope).toBe('write');
    }
    const read = toolsForScopes(['read']).map((t) => t.name);
    expect(read).toContain('list_wishlist');
    expect(read).not.toContain('add_to_wishlist');
    expect(read).not.toContain('update_wishlist_item');
    expect(read).not.toContain('remove_from_wishlist');
  });
});

describe('add_to_wishlist', () => {
  test('a registry wine by wine_id goes on the wishlist, audited via mcp', async () => {
    const body = await call('add_to_wishlist', { wine_id: WINE_ID, vintage: '2021', priority: 'high' });

    expect(WishlistItem.create).toHaveBeenCalledWith(expect.objectContaining({
      user: ME, wineDefinition: WINE_ID, vintage: '2021', priority: 'high',
    }));
    expect(logAudit).toHaveBeenCalledWith(REQ, 'wishlist.add',
      { type: 'wishlistItem', id: ITEM_ID }, { wineDefinitionId: WINE_ID, via: 'mcp' });
    expect(body.data.wishlist_item).toEqual(expect.objectContaining({
      wishlist_id: ITEM_ID, status: 'wanted',
      wine: expect.objectContaining({ wine_id: WINE_ID, name: WINE.name, country: 'Germany' }),
    }));
    expect(body.data.wine_created).toBe(false);
    expect(findOrCreateWine).not.toHaveBeenCalled();
  });

  test('a wine the registry does not know is minted through the MCP chokepoint and wished for', async () => {
    findOrCreateWine.mockResolvedValue({ wine: { ...WINE, pendingIdentity: false }, created: true });

    const body = await call('add_to_wishlist', {
      new_wine: NEW_WINE, shop_url: 'https://shop.example/riesling-steinberg',
    });

    expect(findOrCreateWine).toHaveBeenCalledWith(NEW_WINE, ME, expect.objectContaining({
      createdVia: 'mcp', skipSiblingMatch: false, allowPending: true, draft: false, nonWine: false,
    }));
    expect(logAudit).toHaveBeenCalledWith(REQ, 'wine.create', { type: 'wine', id: WINE_ID },
      expect.objectContaining({ via: 'mcp', name: WINE.name }));
    expect(WishlistItem.create).toHaveBeenCalledWith(expect.objectContaining({
      wineDefinition: WINE_ID, shopUrl: 'https://shop.example/riesling-steinberg',
    }));
    expect(body.summary).toMatch(/new registry wine created/);
    expect(body.data.wine_created).toBe(true);
  });

  test('a wine without a producer is filed for sommelier completion, and the answer says so', async () => {
    findOrCreateWine.mockResolvedValue({ wine: { ...WINE, producer: '', pendingIdentity: true }, created: true });

    const body = await call('add_to_wishlist', { new_wine: { ...NEW_WINE, producer: undefined } });

    expect(body.data.wine_pending_identity).toBe(true);
    expect(body.summary).toMatch(/sommelier completion/);
  });

  test('a refused item field stops the add BEFORE any wine is minted', async () => {
    const body = await call('add_to_wishlist', { new_wine: NEW_WINE, shop_url: 'ftp://shop.example/x' });

    expect(body.error.code).toBe('invalid_input');
    expect(findOrCreateWine).not.toHaveBeenCalled();
    expect(WishlistItem.create).not.toHaveBeenCalled();
  });

  test('new_wine without a type is refused before the registry is touched', async () => {
    const body = await call('add_to_wishlist', { new_wine: { ...NEW_WINE, type: undefined } });

    expect(body.error.code).toBe('invalid_input');
    expect(findOrCreateWine).not.toHaveBeenCalled();
  });

  test('close candidates are a conflict naming them, and nothing is written', async () => {
    findOrCreateWine.mockResolvedValue({ wine: null, candidates: [{ wine: { _id: oid('d'), name: 'Riesling Steinberg GG', producer: 'Weingut Klein' }, score: 0.9 }] });

    const body = await call('add_to_wishlist', { new_wine: NEW_WINE });

    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toContain(oid('d'));
    expect(WishlistItem.create).not.toHaveBeenCalled();
  });

  test('the same wine and vintage still wanted is a conflict naming the item already there', async () => {
    WishlistItem.findOne.mockResolvedValue({ _id: oid('9') });

    const body = await call('add_to_wishlist', { wine_id: WINE_ID, vintage: '2021' });

    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toContain(oid('9'));
    expect(body.error.message).toContain('update_wishlist_item');
    expect(WishlistItem.create).not.toHaveBeenCalled();
  });

  test('a wine the caller cannot see is not_found', async () => {
    findVisibleWine.mockResolvedValue(null);

    const body = await call('add_to_wishlist', { wine_id: WINE_ID });

    expect(body.error.code).toBe('not_found');
    expect(findVisibleWine).toHaveBeenCalledWith(WINE_ID, expect.objectContaining({ userId: ME, noDrafts: true }));
  });

  test('exactly one of wine_id and new_wine', async () => {
    expect((await call('add_to_wishlist', {})).error.code).toBe('invalid_input');
    expect((await call('add_to_wishlist', { wine_id: WINE_ID, new_wine: NEW_WINE })).error.code).toBe('invalid_input');
  });
});

describe('update_wishlist_item', () => {
  const ownItem = (fields = {}) => ({
    _id: ITEM_ID, user: { toString: () => ME }, status: 'wanted', save: jest.fn(async () => {}), ...fields,
  });

  test('marking an item bought stamps boughtAt and is audited via mcp', async () => {
    const item = ownItem();
    WishlistItem.findById
      .mockReturnValueOnce(item)
      .mockReturnValueOnce(chain(populatedItem({ status: 'bought' })));

    const body = await call('update_wishlist_item', { wishlist_id: ITEM_ID, status: 'bought', notes: null });

    expect(item.status).toBe('bought');
    expect(item.boughtAt).toBeInstanceOf(Date);
    expect(item.notes).toBeUndefined();
    expect(item.save).toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(REQ, 'wishlist.update', { type: 'wishlistItem', id: ITEM_ID }, { via: 'mcp' });
    expect(body.data.status).toBe('bought');
  });

  test('another user\'s item is not_found, and nothing is saved', async () => {
    const item = ownItem({ user: { toString: () => STRANGER } });
    WishlistItem.findById.mockReturnValueOnce(item);

    const body = await call('update_wishlist_item', { wishlist_id: ITEM_ID, priority: 'low' });

    expect(body.error.code).toBe('not_found');
    expect(item.save).not.toHaveBeenCalled();
  });

  test('a call that changes nothing is refused before the item is read', async () => {
    const body = await call('update_wishlist_item', { wishlist_id: ITEM_ID });

    expect(body.error.code).toBe('invalid_input');
    expect(WishlistItem.findById).not.toHaveBeenCalled();
  });
});

describe('remove_from_wishlist', () => {
  test('needs confirm:true, and then removes the user\'s own item', async () => {
    const item = { _id: ITEM_ID, user: { toString: () => ME }, wineDefinition: WINE_ID, deleteOne: jest.fn(async () => {}) };
    WishlistItem.findById.mockReturnValue(item);

    const refused = await call('remove_from_wishlist', { wishlist_id: ITEM_ID });
    expect(refused.error.code).toBe('invalid_input');
    expect(item.deleteOne).not.toHaveBeenCalled();

    const body = await call('remove_from_wishlist', { wishlist_id: ITEM_ID, confirm: true });
    expect(item.deleteOne).toHaveBeenCalled();
    expect(body.data).toEqual({ wishlist_id: ITEM_ID, removed: true });
    expect(logAudit).toHaveBeenCalledWith(REQ, 'wishlist.remove', { type: 'wishlistItem', id: ITEM_ID }, { via: 'mcp' });
  });

  test('a missing item is not_found', async () => {
    WishlistItem.findById.mockReturnValue(null);

    const body = await call('remove_from_wishlist', { wishlist_id: ITEM_ID, confirm: true });

    expect(body.error.code).toBe('not_found');
  });
});
