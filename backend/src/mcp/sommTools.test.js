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
const SOMM_TOOLS = ['list_maturity_queue', 'set_vintage_maturity', 'defer_vintage_maturity', 'set_wine_profile', 'list_price_tracking_requests', 'set_vintage_price'];

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
    // "pending" is pending OR a deferral that has come due — see maturityOps.
    expect(WineVintageProfile.find.mock.calls[0][0].$or).toEqual([
      { status: 'pending' },
      { status: 'deferred', deferredUntil: { $ne: null, $lte: expect.any(Date) } },
    ]);
    expect(body.data[0].profile_id).toBe(oid('1'));
    expect(body.data[0].phases).toHaveProperty('peakFrom', null);
  });

  test('deferred rows carry their return date and reason; pending rows report neither', async () => {
    WineVintageProfile.countDocuments.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    WineVintageProfile.find.mockReturnValue(chain([{
      _id: oid('1'), vintage: '2027', status: 'deferred', relative: false,
      deferredUntil: new Date('2029-01-01T00:00:00Z'), deferredReason: 'not released',
      wineDefinition: { _id: oid('f'), name: 'Barolo', producer: 'P', grapes: [] },
    }]));
    const body = parse(await tool('list_maturity_queue').handler({ status: 'deferred' }, SOMM_CTX));
    expect(WineVintageProfile.find.mock.calls[0][0].status).toBe('deferred');
    expect(body.data[0].deferral_reason).toBe('not released');
    expect(new Date(body.data[0].deferred_until).toISOString()).toBe('2029-01-01T00:00:00.000Z');
  });

  test('an indefinite deferral reads as "indefinite", not null (null means "not deferred")', async () => {
    WineVintageProfile.countDocuments.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    WineVintageProfile.find.mockReturnValue(chain([{
      _id: oid('1'), vintage: '2027', status: 'deferred', relative: false, deferredUntil: null,
      wineDefinition: { _id: oid('f'), name: 'Barolo', producer: 'P', grapes: [] },
    }]));
    const body = parse(await tool('list_maturity_queue').handler({ status: 'deferred' }, SOMM_CTX));
    expect(body.data[0].deferred_until).toBe('indefinite');
  });

  // #787: the note was fetched but dropped in the row mapping — write-only data.
  test('reviewed rows carry the curator note; absent note reads as null', async () => {
    WineVintageProfile.countDocuments.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    WineVintageProfile.find.mockReturnValue(chain([
      {
        _id: oid('1'), vintage: '2023', status: 'reviewed', relative: false,
        sommNotes: 'Drink young — fruit fades fast.',
        wineDefinition: { _id: oid('f'), name: 'Pinot Noir', producer: 'Matua', grapes: [] },
      },
      {
        _id: oid('2'), vintage: '2019', status: 'reviewed', relative: false,
        wineDefinition: { _id: oid('f'), name: 'Barolo', producer: 'P', grapes: [] },
      },
    ]));
    const body = parse(await tool('list_maturity_queue').handler({ status: 'reviewed' }, SOMM_CTX));
    expect(body.data[0].somm_notes).toBe('Drink young — fruit fades fast.');
    expect(body.data[1].somm_notes).toBeNull();
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

  // #787: the write landed but the response echoed phases only, so a curator
  // had no way to confirm the note saved.
  test('echoes the note it just saved, and the pre-existing note when none is sent', async () => {
    const p = profile();
    let body = parse(await tool('set_vintage_maturity').handler(
      { profile_id: oid('1'), peak_from: 2026, somm_notes: 'Hold two more years.' }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(p.sommNotes).toBe('Hold two more years.');
    expect(body.data.somm_notes).toBe('Hold two more years.');

    profile({ sommNotes: 'Existing note.' });
    body = parse(await tool('set_vintage_maturity').handler({ profile_id: oid('1'), peak_from: 2026 }, SOMM_CTX));
    expect(body.data.somm_notes).toBe('Existing note.');

    profile();
    body = parse(await tool('set_vintage_maturity').handler({ profile_id: oid('1'), peak_from: 2026 }, SOMM_CTX));
    expect(body.data.somm_notes).toBeNull();
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

describe('defer_vintage_maturity', () => {
  // Dates are computed from today, not hardcoded: parseDeferUntil rejects the
  // past, so a literal would quietly turn this suite red on a future date.
  const futureISO = (years) => new Date(Date.UTC(new Date().getUTCFullYear() + years, 5, 1)).toISOString().slice(0, 10);

  const profile = (over = {}) => {
    const p = {
      _id: oid('1'), vintage: '2027', status: 'pending', relative: false,
      deferredUntil: null, deferredReason: '', deferredBy: null, deferredAt: null,
      wineDefinition: { _id: oid('f'), name: 'Barolo' },
      save: jest.fn().mockResolvedValue(undefined),
      ...over,
    };
    WineVintageProfile.findById.mockReturnValue(chain(p));
    return p;
  };

  // The date RULE itself is pinned with a fixed clock in maturityOps.test.js;
  // what matters here is that omitting defer_until reaches for that default
  // instead of leaving the row without a return date.
  test('omitting the date applies the computed default and leaves the phases untouched', async () => {
    const p = profile({ peakFrom: 2040 });
    const body = parse(await tool('defer_vintage_maturity').handler({ profile_id: oid('1') }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(p.status).toBe('deferred');
    expect(p.deferredUntil).toBeInstanceOf(Date);
    expect(p.deferredUntil.getTime()).toBeGreaterThan(Date.now() + 300 * 24 * 60 * 60 * 1000);
    expect(p.deferredBy).toBe(ME);
    // A deferral is "no judgement yet" — writing windows would be a judgement.
    expect(p.peakFrom).toBe(2040);
    expect(p.save).toHaveBeenCalled();
  });

  test('explicit null defers indefinitely; a chosen date is honoured', async () => {
    let p = profile();
    parse(await tool('defer_vintage_maturity').handler({ profile_id: oid('1'), defer_until: null }, SOMM_CTX));
    expect(p.deferredUntil).toBeNull();
    expect(p.status).toBe('deferred');

    p = profile();
    const chosen = futureISO(4);
    parse(await tool('defer_vintage_maturity').handler({ profile_id: oid('1'), defer_until: chosen }, SOMM_CTX));
    expect(new Date(p.deferredUntil).toISOString()).toBe(`${chosen}T00:00:00.000Z`);
  });

  test('refuses a reviewed profile — reset it first rather than hiding curated data', async () => {
    const p = profile({ status: 'reviewed' });
    const body = parse(await tool('defer_vintage_maturity').handler({ profile_id: oid('1') }, SOMM_CTX));
    expect(body.error.code).toBe('conflict');
    expect(p.save).not.toHaveBeenCalled();
    expect(p.status).toBe('reviewed');
  });

  test('rejects a past return date', async () => {
    const p = profile();
    const body = parse(await tool('defer_vintage_maturity').handler(
      { profile_id: oid('1'), defer_until: '2020-01-01' }, SOMM_CTX));
    expect(body.error.code).toBe('invalid_input');
    expect(p.save).not.toHaveBeenCalled();
  });

  test('ledger row is undoable and snapshots the PREVIOUS deferral, not just pending', async () => {
    const first = new Date('2028-01-01T00:00:00Z');
    profile({ status: 'deferred', deferredUntil: first, deferredReason: 'first', deferredBy: oid('b') });
    await tool('defer_vintage_maturity').handler(
      { profile_id: oid('1'), defer_until: futureISO(5), reason: 'second' }, SOMM_CTX);
    const row = McpActionLog.create.mock.calls[0][0];
    expect(row.action).toBe('somm_maturity_defer');
    expect(row.prev).toMatchObject({ status: 'deferred', deferredReason: 'first', deferredBy: oid('b') });
    expect(new Date(row.prev.deferredUntil).toISOString()).toBe('2028-01-01T00:00:00.000Z');
    expect(logAudit).toHaveBeenCalledWith(SOMM_CTX.req, 'somm.maturity.defer',
      expect.anything(), expect.objectContaining({ via: 'mcp' }));
  });

  test('undo puts the pair back exactly as it was', async () => {
    const row = {
      _id: 'sd', action: 'somm_maturity_defer', reversed: false,
      detail: { profileId: oid('1'), vintage: '2027' },
      prev: { status: 'pending', deferredUntil: null, deferredReason: '', deferredBy: null, deferredAt: null },
    };
    McpActionLog.findOne.mockReturnValue(chain(row));
    McpActionLog.findOneAndUpdate.mockResolvedValue(row);
    const p = {
      _id: oid('1'), status: 'deferred', deferredUntil: new Date('2029-01-01T00:00:00Z'),
      deferredReason: 'not released', deferredBy: oid('b'), deferredAt: new Date(),
      save: jest.fn().mockResolvedValue(undefined),
    };
    WineVintageProfile.findById.mockReturnValue(chain(p));
    const res = await tool('undo_last').handler({}, { ...SOMM_CTX, scopes: ['consume', 'write'] });
    expect(parse(res).data.undone).toBe('defer_vintage_maturity');
    expect(p.status).toBe('pending');
    expect(p.deferredUntil).toBeNull();
    expect(p.deferredReason).toBe('');
    expect(p.save).toHaveBeenCalled();
    // The ledger row must be CLAIMED, or undo_last would keep returning it.
    expect(McpActionLog.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'sd', reversed: false }, { $set: { reversed: true, idempotencyKey: null } });
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
