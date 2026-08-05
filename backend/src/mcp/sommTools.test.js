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
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn(), findById: jest.fn(), countDocuments: jest.fn(), deleteOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../models/WineVintagePrice', () => {
  const M = jest.fn(function (doc) { Object.assign(this, doc); this._id = 'price-1'; this.save = jest.fn().mockResolvedValue(undefined); });
  M.aggregate = jest.fn().mockResolvedValue([]);
  M.deleteOne = jest.fn();
  return M;
});
jest.mock('../models/PriceTrackingRequest', () => ({ find: jest.fn(), findOne: jest.fn(), findById: jest.fn(), deleteOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../models/PriceTrackingSkip', () => ({ find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), deleteOne: jest.fn() }));
jest.mock('../utils/rackGeometry', () => ({ getMaxPosition: jest.fn(() => 12) }));
jest.mock('../services/search', () => ({ getIsAvailable: jest.fn(() => false), search: jest.fn(), searchBottles: jest.fn(), indexWine: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/statsService', () => ({ computeOverview: jest.fn(), buildEmptyStats: jest.fn() }));
jest.mock('../services/vectorStore', () => ({ getPoints: jest.fn(), searchSimilar: jest.fn() }));
jest.mock('../config/aiConfig', () => ({ get: jest.fn(() => ({ vectorIndex: 'v1' })) }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/embeddingJob', () => ({ reembedActiveVintages: jest.fn().mockResolvedValue(undefined) }));
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
const SOMM_TOOLS = ['list_maturity_queue', 'set_vintage_maturity', 'remove_from_maturity_queue', 'set_wine_profile', 'list_price_tracking_requests', 'set_vintage_price', 'reject_price_request'];

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
    expect(readSomm).not.toContain('reject_price_request');
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

describe('remove_from_maturity_queue', () => {
  const profile = (over = {}) => {
    const p = {
      _id: oid('1'), vintage: '2027', status: 'pending', relative: false,
      wineDefinition: { _id: oid('f'), name: 'Barolo' },
      ...over,
    };
    WineVintageProfile.findById.mockReturnValue(chain(p));
    return p;
  };

  beforeEach(() => {
    WineVintageProfile.deleteOne.mockResolvedValue({ deletedCount: 1 });
  });

  test('deletes a pending row; the ledger prev carries wine+vintage so undo can re-seed', async () => {
    profile();
    const body = parse(await tool('remove_from_maturity_queue').handler(
      { profile_id: oid('1'), reason: '2027 not released' }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(WineVintageProfile.deleteOne).toHaveBeenCalledWith({ _id: oid('1') });
    const row = McpActionLog.create.mock.calls[0][0];
    expect(row.action).toBe('somm_maturity_remove');
    // The row being deleted, wine+vintage is ALL the undo has to work from.
    expect(row.prev).toEqual({ wineDefinition: oid('f'), vintage: '2027' });
    expect(logAudit).toHaveBeenCalledWith(SOMM_CTX.req, 'somm.maturity.remove',
      expect.anything(), expect.objectContaining({ reason: '2027 not released', via: 'mcp' }));
  });

  test('refuses a reviewed row — reset it first rather than silently retiring curated data', async () => {
    profile({ status: 'reviewed' });
    const body = parse(await tool('remove_from_maturity_queue').handler({ profile_id: oid('1') }, SOMM_CTX));
    expect(body.error.code).toBe('conflict');
    expect(WineVintageProfile.deleteOne).not.toHaveBeenCalled();
  });

  test('undo re-seeds the pending stub via upsert and CLAIMS the ledger row', async () => {
    const row = {
      _id: 'sr', action: 'somm_maturity_remove', reversed: false,
      detail: { profileId: oid('1'), vintage: '2027' },
      prev: { wineDefinition: oid('f'), vintage: '2027' },
    };
    McpActionLog.findOne.mockReturnValue(chain(row));
    McpActionLog.findOneAndUpdate.mockResolvedValue(row);
    WineVintageProfile.findOneAndUpdate.mockResolvedValue({});
    const res = await tool('undo_last').handler({}, { ...SOMM_CTX, scopes: ['consume', 'write'] });
    expect(parse(res).data.undone).toBe('remove_from_maturity_queue');
    // Upsert, not insert: a bottle add may already have re-seeded the pair, and
    // the undo must land on "it is in the queue again" either way.
    expect(WineVintageProfile.findOneAndUpdate).toHaveBeenCalledWith(
      { wineDefinition: oid('f'), vintage: '2027' },
      { $setOnInsert: { wineDefinition: oid('f'), vintage: '2027', status: 'pending' } },
      { upsert: true }
    );
    expect(McpActionLog.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'sr', reversed: false }, { $set: { reversed: true, idempotencyKey: null } });
  });
});

describe('set_wine_profile', () => {
  const wine = (over = {}) => {
    const w = {
      _id: oid('f'), name: 'Vintage Port', producer: 'Sandeman',
      aiProfile: { description: 'Built for immediate drinking.', source: 'ai', confidence: 0.6 },
      markModified: jest.fn(),
      save: jest.fn().mockResolvedValue(undefined),
      ...over,
    };
    WineDefinition.findById.mockResolvedValue(w);
    return w;
  };

  test('applies the patch, stamps curator provenance, and logs an undoable ledger row', async () => {
    const w = wine();
    const body = parse(await tool('set_wine_profile').handler(
      { wine_id: oid('f'), description: 'Among the longest-ageing wines in the Douro.' }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(w.aiProfile.description).toBe('Among the longest-ageing wines in the Douro.');
    // 'curator' is what stops enrichmentJob regenerating over the correction.
    expect(w.aiProfile.source).toBe('curator');
    expect(w.save).toHaveBeenCalled();
    const row = McpActionLog.create.mock.calls[0][0];
    expect(row.action).toBe('somm_wine_profile');
    expect(row.prev).toMatchObject({ description: 'Built for immediate drinking.', source: 'ai' });
    expect(logAudit).toHaveBeenCalledWith(SOMM_CTX.req, 'somm.wineProfile.update',
      expect.anything(), expect.objectContaining({ via: 'mcp' }));
  });

  test('undo restores the values AND the provenance, and CLAIMS the ledger row', async () => {
    // The claim is the point: without it undo_last keeps selecting the same
    // edit forever and a concurrent twin can restore the snapshot twice.
    const row = {
      _id: 'sw', action: 'somm_wine_profile', reversed: false,
      detail: { wineId: oid('f') },
      prev: { description: 'Built for immediate drinking.', source: 'ai', verifiedBy: null, verifiedAt: null, profileReviewedAt: null },
    };
    McpActionLog.findOne.mockReturnValue(chain(row));
    McpActionLog.findOneAndUpdate.mockResolvedValue(row);
    const w = wine({ aiProfile: { description: 'Corrected.', source: 'curator' } });
    const res = await tool('undo_last').handler({}, { ...SOMM_CTX, scopes: ['consume', 'write'] });
    expect(parse(res).data.undone).toBe('set_wine_profile');
    expect(w.aiProfile.source).toBe('ai');
    expect(w.aiProfile.description).toBe('Built for immediate drinking.');
    expect(McpActionLog.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'sw', reversed: false }, { $set: { reversed: true, idempotencyKey: null } });
  });

  test('a second undo of the same row is refused once it is claimed', async () => {
    const row = { _id: 'sw', action: 'somm_wine_profile', reversed: false, detail: { wineId: oid('f') }, prev: {} };
    McpActionLog.findOne.mockReturnValue(chain(row));
    McpActionLog.findOneAndUpdate.mockResolvedValue(null); // already claimed
    const w = wine();
    const res = await tool('undo_last').handler({}, { ...SOMM_CTX, scopes: ['consume', 'write'] });
    expect(parse(res).error.code).toBe('conflict');
    expect(w.save).not.toHaveBeenCalled();
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

describe('list_price_tracking_requests', () => {
  test('declined pairs (PriceTrackingSkip) no longer appear in the queue', async () => {
    const PriceTrackingRequest = require('../models/PriceTrackingRequest');
    const PriceTrackingSkip = require('../models/PriceTrackingSkip');
    PriceTrackingRequest.find.mockReturnValue(chain([
      { _id: oid('1'), wineDefinition: { _id: oid('e'), name: 'Kept', producer: 'A' }, vintage: '2019', requesters: [{ user: oid('b') }] },
      { _id: oid('2'), wineDefinition: { _id: oid('f'), name: 'Declined', producer: 'B' }, vintage: '2016', requesters: [{ user: oid('b') }] },
    ]));
    PriceTrackingSkip.find.mockReturnValue(chain([{ wineDefinition: oid('f'), vintage: '2016' }]));
    const body = parse(await tool('list_price_tracking_requests').handler({}, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].wine.name).toBe('Kept');
    expect(body.summary).toMatch(/1 actionable/);
  });

  test('a skip on the SAME wine but a DIFFERENT vintage does not hide the pair', async () => {
    const PriceTrackingRequest = require('../models/PriceTrackingRequest');
    const PriceTrackingSkip = require('../models/PriceTrackingSkip');
    PriceTrackingRequest.find.mockReturnValue(chain([
      { _id: oid('1'), wineDefinition: { _id: oid('f'), name: 'Barolo', producer: 'P' }, vintage: '2019', requesters: [] },
    ]));
    PriceTrackingSkip.find.mockReturnValue(chain([{ wineDefinition: oid('f'), vintage: '2016' }]));
    const body = parse(await tool('list_price_tracking_requests').handler({}, SOMM_CTX));
    expect(body.data).toHaveLength(1);
  });
});

describe('reject_price_request', () => {
  const PriceTrackingRequest = require('../models/PriceTrackingRequest');
  const PriceTrackingSkip = require('../models/PriceTrackingSkip');
  const { createNotification } = require('../services/notifications');

  const REQ_ID = oid('9');
  const WINE_ID = oid('f');
  const mkRequest = (over = {}) => ({
    _id: REQ_ID,
    wineDefinition: WINE_ID,
    vintage: '2019',
    requesters: [
      { user: oid('b'), requestedAt: new Date('2026-07-01'), note: 'please track' },
      { user: oid('c'), requestedAt: new Date('2026-07-02') },
    ],
    firstRequestedAt: new Date('2026-07-01'),
    lastRequestedAt: new Date('2026-07-02'),
    ...over,
  });

  beforeEach(() => {
    WineDefinition.findById.mockReturnValue(chain({ _id: WINE_ID, name: 'Everyday Shiraz', producer: 'Casella' }));
    PriceTrackingSkip.findOneAndUpdate.mockResolvedValue({ lastErrorObject: { updatedExisting: false }, value: null });
    PriceTrackingRequest.deleteOne.mockResolvedValue({ deletedCount: 1 });
  });

  test('requires a real plain-text reason — missing, too-short, and HTML-only all refused before any read', async () => {
    for (const reason of [undefined, 'no', '<b><i></i></b>', '<p>hey</p>']) {
      const res = await tool('reject_price_request').handler({ request_id: REQ_ID, reason }, SOMM_CTX);
      expect(parse(res).error.code).toBe('invalid_input');
    }
    expect(PriceTrackingRequest.findById).not.toHaveBeenCalled();
    expect(PriceTrackingSkip.findOneAndUpdate).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  test('declines: skip upserted with the stripped reason, request deleted, requesters notified verbatim, undoable ledger row', async () => {
    PriceTrackingRequest.findById.mockReturnValue(chain(mkRequest()));
    const body = parse(await tool('reject_price_request').handler(
      { request_id: REQ_ID, reason: '  <b>No secondary market</b> for this wine.  ' }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(body.data.suppressed).toBe(true);
    expect(body.data.requesters_notified).toBe(2);
    expect(body.data.reason).toBe('No secondary market for this wine.');

    // Suppression: the skip is upserted on the pair with the sanitized reason.
    const [skipFilter, skipUpdate] = PriceTrackingSkip.findOneAndUpdate.mock.calls[0];
    expect(skipFilter).toEqual({ wineDefinition: WINE_ID, vintage: '2019' });
    expect(skipUpdate.$setOnInsert).toMatchObject({ reason: 'No secondary market for this wine.', skippedBy: ME });

    expect(PriceTrackingRequest.deleteOne).toHaveBeenCalledWith({ _id: REQ_ID });

    // Every requester gets the wine label AND the reason, verbatim.
    expect(createNotification).toHaveBeenCalledTimes(2);
    expect(createNotification.mock.calls[0][1]).toBe('price_tracking_declined');
    expect(createNotification.mock.calls[0][3]).toMatch(/Casella — Everyday Shiraz 2019/);
    expect(createNotification.mock.calls[0][3]).toMatch(/Reason: No secondary market for this wine\./);

    // Same audit action string as the REST decline route.
    expect(logAudit).toHaveBeenCalledWith(SOMM_CTX.req, 'somm.price.decline',
      expect.anything(), expect.objectContaining({ reason: 'No secondary market for this wine.', via: 'mcp' }));

    const row = McpActionLog.create.mock.calls[0][0];
    expect(row.action).toBe('somm_price_decline');
    expect(row.tool).toBe('reject_price_request');
    // The request being deleted, prev is ALL the undo has to work from.
    expect(row.prev).toMatchObject({ wineDefinition: WINE_ID, vintage: '2019', skipCreated: true });
    expect(row.prev.requesters).toHaveLength(2);
    expect(row.prev.requesters[0]).toMatchObject({ user: oid('b'), note: 'please track' });
  });

  test('a pre-existing skip is kept as-is and prev.skipCreated records it (undo must not lift it)', async () => {
    PriceTrackingRequest.findById.mockReturnValue(chain(mkRequest()));
    PriceTrackingSkip.findOneAndUpdate.mockResolvedValue({ lastErrorObject: { updatedExisting: true }, value: { _id: 'sk1' } });
    const body = parse(await tool('reject_price_request').handler(
      { request_id: REQ_ID, reason: 'No secondary market.' }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(McpActionLog.create.mock.calls[0][0].prev.skipCreated).toBe(false);
  });

  test('double-decline: the second call is a clean not_found (request already gone), nothing mutated or re-notified', async () => {
    PriceTrackingRequest.findById.mockReturnValue(chain(null));
    const body = parse(await tool('reject_price_request').handler(
      { request_id: REQ_ID, reason: 'No secondary market.' }, SOMM_CTX));
    expect(body.error.code).toBe('not_found');
    expect(PriceTrackingSkip.findOneAndUpdate).not.toHaveBeenCalled();
    expect(PriceTrackingRequest.deleteOne).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(McpActionLog.create).not.toHaveBeenCalled();
  });

  test('undo restores the request (upsert) and lifts ONLY the suppression this decline created; role re-checked', async () => {
    const prev = {
      wineDefinition: WINE_ID, vintage: '2019',
      requesters: [{ user: oid('b'), requestedAt: '2026-07-01T00:00:00.000Z', note: 'please track' }],
      firstRequestedAt: '2026-07-01T00:00:00.000Z', lastRequestedAt: '2026-07-02T00:00:00.000Z',
      skipCreated: true,
    };
    const row = { _id: 'pd', action: 'somm_price_decline', reversed: false, detail: { requestId: REQ_ID, vintage: '2019' }, prev };
    McpActionLog.findOne.mockReturnValue(chain(row));

    // Role-less caller refused before any claim:
    let res = await tool('undo_last').handler({}, { ...USER_CTX, scopes: ['consume', 'write'] });
    expect(parse(res).error.code).toBe('forbidden_scope');
    expect(McpActionLog.findOneAndUpdate).not.toHaveBeenCalled();

    McpActionLog.findOneAndUpdate.mockResolvedValue(row);
    PriceTrackingRequest.findOneAndUpdate.mockResolvedValue({});
    PriceTrackingSkip.deleteOne.mockResolvedValue({ deletedCount: 1 });
    res = await tool('undo_last').handler({}, { ...SOMM_CTX, scopes: ['consume', 'write'] });
    expect(parse(res).data.undone).toBe('reject_price_request');
    // Upsert, not insert: a re-request may already have brought the pair back.
    expect(PriceTrackingRequest.findOneAndUpdate).toHaveBeenCalledWith(
      { wineDefinition: WINE_ID, vintage: '2019' },
      { $setOnInsert: expect.objectContaining({ requesters: prev.requesters }) },
      { upsert: true }
    );
    // The lift is scoped to the caller's own skip, like the somm_price delete.
    expect(PriceTrackingSkip.deleteOne).toHaveBeenCalledWith({ wineDefinition: WINE_ID, vintage: '2019', skippedBy: ME });
    expect(McpActionLog.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'pd', reversed: false }, { $set: { reversed: true, idempotencyKey: null } });
  });

  test('undo leaves a skip that pre-existed the decline in place (skipCreated false)', async () => {
    const row = {
      _id: 'pd2', action: 'somm_price_decline', reversed: false, detail: { requestId: REQ_ID, vintage: '2019' },
      prev: { wineDefinition: WINE_ID, vintage: '2019', requesters: [], skipCreated: false },
    };
    McpActionLog.findOne.mockReturnValue(chain(row));
    McpActionLog.findOneAndUpdate.mockResolvedValue(row);
    PriceTrackingRequest.findOneAndUpdate.mockResolvedValue({});
    const res = await tool('undo_last').handler({}, { ...SOMM_CTX, scopes: ['consume', 'write'] });
    expect(parse(res).error).toBeUndefined();
    expect(PriceTrackingSkip.deleteOne).not.toHaveBeenCalled();
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
