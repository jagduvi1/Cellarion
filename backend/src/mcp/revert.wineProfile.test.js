/**
 * revert.js — the somm_wine_profile branch: undoing set_wine_profile restores
 * the ledger row's `prev` through the real restoreProfile, so the wine gets
 * back its values, its provenance AND its hold.
 */

jest.mock('../models/Bottle', () => ({ exists: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/Rack', () => ({ exists: jest.fn() }));
jest.mock('../models/Grape', () => ({ findOne: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn() }));
jest.mock('../config/constants', () => ({ CONSUMED_STATUSES: ['drank', 'gifted', 'sold', 'other'], ORDERED_STATUS: 'ordered' }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/bottleOps', () => ({ RESTORE_WINDOW_MS: 5 * 86400000 }));
jest.mock('../services/search', () => ({ indexWine: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/embeddingJob', () => ({ reembedActiveVintages: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./toolUtil', () => ({ resolveBottleAccess: jest.fn() }));
jest.mock('./actionLedger', () => ({ logAction: jest.fn() }));

const McpActionLog = require('../models/McpActionLog');
const WineDefinition = require('../models/WineDefinition');
const { logAction } = require('./actionLedger');
const { revertLedgerRow } = require('./revert');

const ok = jest.fn((summary, data) => ({ ok: true, summary, data }));
const fail = jest.fn((code, message) => ({ ok: false, code, message }));
const H = { ok, fail };
const sommCtx = { user: { id: 'u1', roles: ['somm'] }, scopes: ['read', 'consume', 'write'], req: {} };

beforeEach(() => {
  jest.clearAllMocks();
  McpActionLog.findOneAndUpdate.mockResolvedValue({ _id: 'claimed' });
  McpActionLog.updateOne.mockResolvedValue({});
});

test('somm_wine_profile: restores row.prev — values, provenance and the hold', async () => {
  // The wine as set_wine_profile left it: curator-verified, hold ended.
  const wine = {
    _id: 'w1', name: 'Douro Tinto', producer: 'P', type: 'red', grapes: [],
    aiProfile: {
      description: 'curator prose', flavors: ['plum'], foodPairings: [],
      source: 'curator', verifiedBy: 'u1', verifiedAt: new Date(),
      heldAt: null, heldReason: 'low_confidence',
    },
    profileReviewedAt: new Date(),
    markModified: jest.fn(),
    save: jest.fn().mockResolvedValue(undefined),
  };
  WineDefinition.findById.mockResolvedValue(wine);

  // `prev` as the ledger hands it back: the snapshot taken before the write.
  const row = {
    _id: 'r1', action: 'somm_wine_profile', detail: { wineId: 'w1' },
    prev: {
      body: null, tannin: null, acidity: null, sweetness: null,
      flavors: [], foodPairings: [], description: null,
      source: 'ai', verifiedBy: null, verifiedAt: null, profileReviewedAt: null,
      type: 'red', colour: null, grapes: [],
      heldAt: '2026-08-18T09:00:00.000Z', heldReason: 'low_confidence',
    },
  };

  const res = await revertLedgerRow(row, sommCtx, H);

  expect(res.ok).toBe(true);
  expect(WineDefinition.findById).toHaveBeenCalledWith('w1');
  expect(McpActionLog.findOneAndUpdate).toHaveBeenCalledWith(
    { _id: 'r1', reversed: false }, { $set: { reversed: true, idempotencyKey: null } });
  expect(wine.save).toHaveBeenCalled();

  expect(wine.aiProfile.description).toBeNull();
  expect(wine.aiProfile.flavors).toEqual([]);
  expect(wine.aiProfile.source).toBe('ai');
  expect(wine.aiProfile.verifiedBy).toBeNull();
  expect(wine.profileReviewedAt).toBeNull();
  // Back in the held queue, with its reason.
  expect(wine.aiProfile.heldAt).toBeInstanceOf(Date);
  expect(wine.aiProfile.heldAt.toISOString()).toBe('2026-08-18T09:00:00.000Z');
  expect(wine.aiProfile.heldReason).toBe('low_confidence');

  expect(res.data).toMatchObject({ undone: 'set_wine_profile', wine_id: 'w1', source: 'ai' });
  expect(logAction.mock.calls[0][1]).toMatchObject({ viaUndo: true, action: 'somm_wine_profile' });
});
