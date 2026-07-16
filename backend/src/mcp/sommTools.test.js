/**
 * Somm MCP tools — role-gating + shared-data safety invariants.
 *
 * Pins: structural invisibility without the somm/admin role (registry level)
 * AND the in-handler re-check; the NV-relative vs absolute-year validation
 * mirror; phase ordering; prev snapshots for undo; append-only price entries
 * with currency validation; ledger attribution.
 */

const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

jest.mock('../models/Cellar', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), findById: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/Rack', () => ({ find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WishlistItem', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/JournalEntry', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/WineEmbedding', () => ({ findOne: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn(), findById: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WineVintagePrice', () => {
  const M = jest.fn(function (doc) { Object.assign(this, doc); this._id = 'price-1'; this.save = jest.fn().mockResolvedValue(undefined); });
  M.aggregate = jest.fn().mockResolvedValue([]);
  M.deleteOne = jest.fn();
  return M;
});
jest.mock('../models/PriceTrackingRequest', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../utils/rackGeometry', () => ({ getMaxPosition: jest.fn(() => 12) }));
jest.mock('../services/search', () => ({ getIsAvailable: jest.fn(() => false), search: jest.fn(), searchBottles: jest.fn() }));
jest.mock('../services/statsService', () => ({ computeOverview: jest.fn(), buildEmptyStats: jest.fn() }));
jest.mock('../services/vectorStore', () => ({ getPoints: jest.fn(), searchSimilar: jest.fn() }));
jest.mock('../config/aiConfig', () => ({ get: jest.fn(() => ({ vectorIndex: 'v1' })) }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/notifications', () => ({ createNotification: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/exchangeRates', () => ({ getOrCreateDailySnapshot: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), removeFromRacks: jest.fn(),
  RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  addBottle: jest.fn(), updateBottleFields: jest.fn(), removeBottleCascade: jest.fn(),
  UPDATABLE_FIELDS: ['price', 'currency', 'notes', 'occasion', 'rating', 'ratingScale', 'drinkFrom', 'drinkTo'],
}));
jest.mock('./mutationBudget', () => ({ takeMutationSlot: jest.fn(() => true), WRITE_WINDOW_MS: 15 * 60 * 1000 }));

const WineVintageProfile = require('../models/WineVintageProfile');
const WineVintagePrice = require('../models/WineVintagePrice');
const WineDefinition = require('../models/WineDefinition');
const McpActionLog = require('../models/McpActionLog');
const { logAudit } = require('../services/audit');
const { allTools, toolsForScopes } = require('./registry');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const SOMM_CTX = { user: { id: ME, roles: ['somm'] }, scopes: ['read', 'write'], req: { user: { id: ME, roles: ['somm'] }, headers: {}, apiToken: { id: 't1' } } };
const USER_CTX = { user: { id: ME, roles: ['user'] }, scopes: ['read', 'write'], req: { user: { id: ME, roles: ['user'] }, headers: {} } };

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);
const SOMM_TOOLS = ['list_maturity_queue', 'set_vintage_maturity', 'list_price_tracking_requests', 'set_vintage_price'];

beforeEach(() => {
  jest.clearAllMocks();
  McpActionLog.create.mockResolvedValue({});
});

describe('role gating (structural + in-handler)', () => {
  test('somm tools are INVISIBLE without the role, visible with somm or admin', () => {
    const plain = toolsForScopes(['read', 'write'], ['user']).map((t) => t.name);
    for (const n of SOMM_TOOLS) expect(plain).not.toContain(n);
    const somm = toolsForScopes(['read', 'write'], ['somm']).map((t) => t.name);
    const admin = toolsForScopes(['read', 'write'], ['admin']).map((t) => t.name);
    for (const n of SOMM_TOOLS) {
      expect(somm).toContain(n);
      expect(admin).toContain(n);
    }
    // scope still applies on top of role: read-only somm token sees listers only
    const readSomm = toolsForScopes(['read'], ['somm']).map((t) => t.name);
    expect(readSomm).toContain('list_maturity_queue');
    expect(readSomm).not.toContain('set_vintage_maturity');
  });

  test('defense-in-depth: handlers refuse a role-less ctx even if reached', async () => {
    for (const n of SOMM_TOOLS) {
      const res = await tool(n).handler({ profile_id: oid('1'), wine_id: oid('2'), vintage: 'NV', price: 1 }, USER_CTX);
      expect(parse(res).error.code).toBe('forbidden_scope');
    }
  });
});

describe('list_maturity_queue', () => {
  test('defaults to pending, reports the pending count, pages at ≤50', async () => {
    WineVintageProfile.countDocuments.mockResolvedValueOnce(7).mockResolvedValueOnce(7);
    WineVintageProfile.find.mockReturnValue(chain([{
      _id: oid('1'), vintage: '2019', status: 'pending', relative: false,
      wineDefinition: { _id: oid('f'), name: 'Barolo', producer: 'P', grapes: [] },
    }]));
    const res = await tool('list_maturity_queue').handler({}, SOMM_CTX);
    const body = parse(res);
    expect(body.summary).toMatch(/7 pending/);
    expect(WineVintageProfile.find.mock.calls[0][0]).toEqual({ status: 'pending' });
    expect(body.data[0].profile_id).toBe(oid('1'));
    expect(body.data[0].phases).toHaveProperty('peakFrom', null);
  });
});

describe('set_vintage_maturity', () => {
  const profile = (over = {}) => {
    const p = {
      _id: oid('1'), vintage: '2019', status: 'pending', relative: false,
      wineDefinition: { _id: oid('f'), name: 'Barolo' },
      save: jest.fn().mockResolvedValue(undefined),
      ...over,
    };
    WineVintageProfile.findById.mockReturnValue(chain(p));
    return p;
  };

  test('year vintages validate 1900–2200; ordering enforced', async () => {
    profile();
    let res = await tool('set_vintage_maturity').handler({ profile_id: oid('1'), peak_from: 1500 }, SOMM_CTX);
    expect(parse(res).error.message).toMatch(/1900–2200/);
    profile();
    res = await tool('set_vintage_maturity').handler({ profile_id: oid('1'), peak_from: 2030, peak_until: 2025 }, SOMM_CTX);
    expect(parse(res).error.message).toMatch(/cannot be before/);
    profile();
    res = await tool('set_vintage_maturity').handler({ profile_id: oid('1'), early_from: 2030, peak_from: 2025 }, SOMM_CTX);
    expect(parse(res).error.message).toMatch(/peak_from cannot be before early_from/);
  });

  test('NV vintages use relative offsets 0–100 and set relative=true', async () => {
    const p = profile({ vintage: 'NV' });
    let res = await tool('set_vintage_maturity').handler({ profile_id: oid('1'), peak_from: 1990 }, SOMM_CTX);
    expect(parse(res).error.message).toMatch(/relative offsets 0–100/);
    const p2 = profile({ vintage: 'NV' });
    res = await tool('set_vintage_maturity').handler({ profile_id: oid('1'), peak_from: 1, peak_until: 5 }, SOMM_CTX);
    expect(parse(res).error).toBeUndefined();
    expect(p2.relative).toBe(true);
    expect(p2.status).toBe('reviewed');
  });

  test('prev snapshot captures phases + review state for undo; audit uses the REST action string', async () => {
    const p = profile({ peakFrom: 2020, peakUntil: 2030, status: 'reviewed', setBy: oid('b'), setAt: new Date('2026-01-01') });
    await tool('set_vintage_maturity').handler({ profile_id: oid('1'), peak_from: 2026, peak_until: 2040 }, SOMM_CTX);
    const row = McpActionLog.create.mock.calls[0][0];
    expect(row.action).toBe('somm_maturity');
    expect(row.prev).toMatchObject({ peakFrom: 2020, peakUntil: 2030, status: 'reviewed', setBy: oid('b') });
    expect(logAudit).toHaveBeenCalledWith(SOMM_CTX.req, 'somm.maturity.review',
      expect.anything(), expect.objectContaining({ via: 'mcp' }));
    expect(p.setBy).toBe(ME);
  });
});

describe('set_vintage_price', () => {
  test('rejects unsupported currency; creates an append-only snapshot with setBy; ledger keeps entryId', async () => {
    let res = await tool('set_vintage_price').handler({ wine_id: oid('f'), vintage: '2019', price: 100, currency: 'XXX' }, SOMM_CTX);
    expect(parse(res).error.message).toMatch(/Unsupported currency/);

    WineDefinition.findById.mockReturnValue(chain({ _id: oid('f'), name: 'Barolo' }));
    const PriceTrackingRequest = require('../models/PriceTrackingRequest');
    PriceTrackingRequest.findOne.mockReturnValue(chain(null));
    res = await tool('set_vintage_price').handler({ wine_id: oid('f'), vintage: '2019', price: 100, currency: 'sek' }, SOMM_CTX);
    const body = parse(res);
    expect(body.error).toBeUndefined();
    expect(body.data.currency).toBe('SEK');
    const created = WineVintagePrice.mock.calls[0][0];
    expect(created).toMatchObject({ vintage: '2019', price: 100, currency: 'SEK', setBy: ME });
    const row = McpActionLog.create.mock.calls[0][0];
    expect(row.action).toBe('somm_price');
    expect(row.detail.entryId).toBe('price-1');
    expect(logAudit).toHaveBeenCalledWith(SOMM_CTX.req, 'somm.price.add', expect.anything(), expect.objectContaining({ via: 'mcp' }));
    // Requesters (none here) would be notified with the somm-prices link.
    const { createNotification } = require('../services/notifications');
    expect(createNotification).not.toHaveBeenCalled(); // no requesters on this pair
  });
});

describe('undo of somm actions', () => {
  test('undo somm_price deletes exactly the snapshot this user created; role re-checked', async () => {
    const row = {
      _id: 'sp', action: 'somm_price', reversed: false,
      detail: { entryId: 'price-1', vintage: '2019' },
    };
    McpActionLog.findOne.mockReturnValue(chain(row));
    // Role-less caller refused before any claim:
    let res = await tool('undo_last').handler({}, { ...USER_CTX, scopes: ['consume', 'write'] });
    expect(parse(res).error.code).toBe('forbidden_scope');
    expect(McpActionLog.findOneAndUpdate).not.toHaveBeenCalled();

    McpActionLog.findOneAndUpdate.mockResolvedValue(row);
    WineVintagePrice.deleteOne.mockResolvedValue({ deletedCount: 1 });
    res = await tool('undo_last').handler({}, { ...SOMM_CTX, scopes: ['consume', 'write'] });
    expect(parse(res).data.undone).toBe('set_vintage_price');
    expect(WineVintagePrice.deleteOne).toHaveBeenCalledWith({ _id: 'price-1', setBy: ME });
  });

  test('the somm undo record is viaUndo:true (excluded from candidacy → no undo-of-undo corruption)', async () => {
    const row = { _id: 'sp', action: 'somm_price', reversed: false, detail: { entryId: 'price-1', vintage: '2019' } };
    McpActionLog.findOne.mockReturnValue(chain(row));
    McpActionLog.findOneAndUpdate.mockResolvedValue(row);
    WineVintagePrice.deleteOne.mockResolvedValue({ deletedCount: 1 });
    await tool('undo_last').handler({}, { ...SOMM_CTX, scopes: ['consume', 'write'] });
    expect(McpActionLog.create.mock.calls.at(-1)[0]).toMatchObject({ action: 'somm_price', viaUndo: true });
  });

  test('undo somm_maturity re-applies the FULL prev snapshot (phases, notes, status, reviewer)', async () => {
    const row = {
      _id: 'sm', action: 'somm_maturity', reversed: false,
      detail: { profileId: oid('1'), vintage: '2019' },
      prev: { earlyFrom: null, earlyUntil: null, peakFrom: 2020, peakUntil: 2030, lateFrom: null, lateUntil: null, sommNotes: null, status: 'pending', relative: false, setBy: null, setAt: null },
    };
    McpActionLog.findOne.mockReturnValue(chain(row));
    McpActionLog.findOneAndUpdate.mockResolvedValue(row);
    const p = { _id: oid('1'), peakFrom: 2026, peakUntil: 2040, status: 'reviewed', save: jest.fn().mockResolvedValue(undefined) };
    WineVintageProfile.findById.mockReturnValue(chain(p));
    const res = await tool('undo_last').handler({}, { ...SOMM_CTX, scopes: ['consume', 'write'] });
    expect(parse(res).data.undone).toBe('set_vintage_maturity');
    expect(p.peakFrom).toBe(2020);
    expect(p.peakUntil).toBe(2030);
    expect(p.status).toBe('pending');
    expect(p.setBy).toBeNull();
    expect(p.save).toHaveBeenCalled();
  });
});
