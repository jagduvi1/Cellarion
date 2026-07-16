/**
 * bulk_add — preview→apply contract invariants: nothing writes at preview,
 * blocked/invalid plans never apply, the batch charges the mutation budget
 * upfront, one ledger row per batch, previews are single-use, and batch undo
 * is all-or-nothing. Ledger refs use REAL ObjectIds (the masking-bug rule).
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
jest.mock('../utils/rackGeometry', () => ({ getMaxPosition: jest.fn(() => 12) }));
jest.mock('../services/search', () => ({ getIsAvailable: jest.fn(() => false), search: jest.fn(), searchBottles: jest.fn() }));
jest.mock('../services/statsService', () => ({ computeOverview: jest.fn(), buildEmptyStats: jest.fn() }));
jest.mock('../services/vectorStore', () => ({ getPoints: jest.fn(), searchSimilar: jest.fn() }));
jest.mock('../config/aiConfig', () => ({ get: jest.fn(() => ({ vectorIndex: 'v1' })) }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), removeFromRacks: jest.fn(),
  RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  addBottle: jest.fn(), updateBottleFields: jest.fn(), removeBottleCascade: jest.fn(),
  UPDATABLE_FIELDS: ['price', 'currency', 'notes', 'occasion', 'rating', 'ratingScale', 'drinkFrom', 'drinkTo'],
}));
jest.mock('./mutationBudget', () => ({ takeMutationSlot: jest.fn(() => true), WRITE_WINDOW_MS: 15 * 60 * 1000 }));

const mongoose = require('mongoose');
const Cellar = require('../models/Cellar');
const WineDefinition = require('../models/WineDefinition');
const McpActionLog = require('../models/McpActionLog');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const bottleOps = require('../services/bottleOps');
const { takeMutationSlot } = require('./mutationBudget');
const { allTools } = require('./registry');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const CTX = { user: { id: ME }, scopes: ['read', 'write'], req: { user: { id: ME }, headers: {}, apiToken: { id: 't1' } } };
const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);
const ownCellar = () => Cellar.findById.mockReturnValue(chain({ _id: oid('c'), user: ME, members: [], deletedAt: null, name: 'Mine' }));

const NEW = { name: 'Fresh Wine', producer: 'P', country: 'France', type: 'red' };

beforeEach(() => {
  jest.clearAllMocks();
  takeMutationSlot.mockReturnValue(true);
  McpActionLog.create.mockResolvedValue({ _id: oid('9') });
  McpActionLog.findOneAndUpdate.mockResolvedValue(null); // claims fail unless a test arms them
});

describe('preview', () => {
  test('resolves items without writing: matched → ready (upgraded to wine_id), unknown → will_create, similar → blocked', async () => {
    ownCellar();
    findOrCreateWine
      .mockResolvedValueOnce({ wine: { _id: oid('f'), name: 'Known', producer: 'P', grapes: [] }, created: false })
      .mockResolvedValueOnce({ wine: null, noMatch: true })
      .mockResolvedValueOnce({ wine: null, candidates: [{ wine: { _id: oid('e'), name: 'Close', producer: 'P', grapes: [] }, score: 0.9 }] });
    const res = await tool('bulk_add').handler({
      cellar_id: oid('c'),
      items: [{ new_wine: NEW }, { new_wine: NEW }, { new_wine: NEW }],
    }, CTX);
    const body = parse(res);
    expect(body.data.plan.map((p) => p.status)).toEqual(['ready', 'will_create', 'blocked_similar']);
    expect(body.data.plan[0].wine_id).toBe(oid('f'));
    expect(body.data.applyable).toBe(false); // blocked item present
    expect(bottleOps.addBottle).not.toHaveBeenCalled(); // nothing written
    // matchOnly on every preview resolution
    for (const call of findOrCreateWine.mock.calls) expect(call[2]).toEqual({ matchOnly: true });
    // plan persisted for the apply step
    expect(McpActionLog.create.mock.calls[0][0].action).toBe('bulk_preview');
  });

  test('invalid fields are flagged per item', async () => {
    ownCellar();
    const res = await tool('bulk_add').handler({
      cellar_id: oid('c'),
      items: [{ wine_id: oid('f'), vintage: 'not-a-year' }],
    }, CTX);
    expect(parse(res).data.plan[0].status).toBe('invalid');
  });
});

describe('apply', () => {
  const freshPreview = (over = {}) => ({
    _id: oid('9'), createdAt: new Date(), reversed: false, save: jest.fn(),
    prev: {
      cellarId: oid('c'),
      items: [{ wine_id: oid('f'), vintage: '2019' }, { new_wine: NEW }],
      plan: [{ index: 0, status: 'ready', wine_id: oid('f') }, { index: 1, status: 'will_create', new_wine: NEW }],
    },
    detail: {},
    ...over,
  });

  test('executes the stored plan: budget charged for the WHOLE batch, one ledger row, wine.create audited', async () => {
    McpActionLog.findOne.mockReturnValue(chain(freshPreview()));
    McpActionLog.findOneAndUpdate.mockResolvedValue(freshPreview()); // atomic claim wins
    ownCellar();
    WineDefinition.findById.mockReturnValue(chain({ _id: oid('f'), name: 'Known' }));
    findOrCreateWine.mockResolvedValue({ wine: { _id: oid('e'), name: 'Fresh Wine', producer: 'P' }, created: true });
    bottleOps.addBottle
      .mockResolvedValueOnce({ bottle: { _id: new mongoose.Types.ObjectId(oid('1')) } })
      .mockResolvedValueOnce({ bottle: { _id: new mongoose.Types.ObjectId(oid('2')) } });

    const res = await tool('bulk_add').handler({ mode: 'apply', preview_id: oid('9') }, CTX);
    const body = parse(res);
    expect(body.data.added_bottle_ids).toHaveLength(2);
    expect(body.data.wines_created).toBe(1);
    expect(takeMutationSlot).toHaveBeenCalledWith(ME, 2); // whole batch upfront
    // Unconfirmed will_create → soft-zone stays live (confirmCreate false)
    expect(findOrCreateWine.mock.calls[0][2]).toMatchObject({ confirmCreate: false, skipSiblingMatch: false, createdVia: 'mcp' });
    const ledger = McpActionLog.create.mock.calls.at(-1)[0];
    expect(ledger.action).toBe('bulk_add');
    expect(ledger.detail.bottles).toHaveLength(2);
  });

  test('refuses: exhausted budget, non-applyable plan, used/expired/foreign preview', async () => {
    // budget
    McpActionLog.findOne.mockReturnValue(chain(freshPreview()));
    ownCellar();
    takeMutationSlot.mockReturnValue(false);
    expect(parse(await tool('bulk_add').handler({ mode: 'apply', preview_id: oid('9') }, CTX)).error.code).toBe('rate_limited');

    // blocked plan
    takeMutationSlot.mockReturnValue(true);
    McpActionLog.findOne.mockReturnValue(chain(freshPreview({
      prev: { cellarId: oid('c'), items: [{ new_wine: NEW }], plan: [{ index: 0, status: 'blocked_similar' }] },
    })));
    expect(parse(await tool('bulk_add').handler({ mode: 'apply', preview_id: oid('9') }, CTX)).error.code).toBe('conflict');

    // expired
    McpActionLog.findOne.mockReturnValue(chain(freshPreview({ createdAt: new Date(Date.now() - 16 * 60 * 1000) })));
    expect(parse(await tool('bulk_add').handler({ mode: 'apply', preview_id: oid('9') }, CTX)).error.code).toBe('conflict');

    // used/foreign → findOne (user+reversed filters) misses
    McpActionLog.findOne.mockReturnValue(chain(null));
    expect(parse(await tool('bulk_add').handler({ mode: 'apply', preview_id: oid('9') }, CTX)).error.code).toBe('not_found');
    expect(bottleOps.addBottle).not.toHaveBeenCalled();
  });

  test('CONCURRENT double-apply: the atomic claim loser executes nothing (the audit-High race)', async () => {
    McpActionLog.findOne.mockReturnValue(chain(freshPreview()));
    ownCellar();
    McpActionLog.findOneAndUpdate.mockResolvedValue(null); // another request claimed first
    const res = await tool('bulk_add').handler({ mode: 'apply', preview_id: oid('9') }, CTX);
    expect(parse(res).error.code).toBe('conflict');
    expect(bottleOps.addBottle).not.toHaveBeenCalled();
    // and the claim was conditional on reversed:false
    expect(McpActionLog.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ reversed: false });
  });

  test('unconfirmed will_create items keep the soft-zone LIVE at apply (no confirmCreate bypass)', async () => {
    McpActionLog.findOne.mockReturnValue(chain(freshPreview()));
    McpActionLog.findOneAndUpdate.mockResolvedValue(freshPreview());
    ownCellar();
    WineDefinition.findById.mockReturnValue(chain({ _id: oid('f'), name: 'Known' }));
    // Candidates appeared between preview and apply (e.g. minted by an earlier batch item)
    findOrCreateWine.mockResolvedValue({ wine: null, candidates: [{ wine: { _id: oid('e') }, score: 0.9 }] });
    bottleOps.addBottle.mockResolvedValue({ bottle: { _id: new mongoose.Types.ObjectId(oid('1')) } });
    const body = parse(await tool('bulk_add').handler({ mode: 'apply', preview_id: oid('9') }, CTX));
    // item 0 (ready) added; item 1 (will_create, NOT despite_candidates) failed safely
    expect(findOrCreateWine.mock.calls[0][2].confirmCreate).toBe(false);
    expect(body.data.added_bottle_ids).toHaveLength(1);
    expect(body.data.failures[0].error).toMatch(/similar wines appeared/i);
  });
});

describe('undo of a bulk_add', () => {
  const Bottle = require('../models/Bottle');
  const bottleRef = (h) => new mongoose.Types.ObjectId(oid(h));

  test('all-or-nothing: one consumed bottle blocks the whole batch undo', async () => {
    const row = {
      _id: 'blk', action: 'bulk_add', reversed: false, save: jest.fn(),
      detail: { bottles: [oid('1'), oid('2')] }, cellar: oid('c'),
    };
    McpActionLog.findOne.mockReturnValue(chain(row));
    Cellar.findById.mockReturnValue(chain({ _id: oid('c'), user: ME, members: [], deletedAt: null }));
    Bottle.findById
      .mockReturnValueOnce(chain({ _id: bottleRef('1'), cellar: bottleRef('c'), status: 'active' }))
      .mockReturnValueOnce(chain({ _id: bottleRef('2'), cellar: bottleRef('c'), status: 'drank' }));
    const res = await tool('undo_last').handler({}, CTX);
    expect(parse(res).error.code).toBe('conflict');
    expect(bottleOps.removeBottleCascade).not.toHaveBeenCalled();
    expect(row.reversed).toBe(false);
  });

  test('clean batch: every bottle cascaded, row reversed, viaUndo record written', async () => {
    const row = {
      _id: 'blk', action: 'bulk_add', reversed: false, idempotencyKey: null, save: jest.fn(),
      detail: { bottles: [oid('1'), oid('2')] }, cellar: oid('c'),
    };
    McpActionLog.findOne.mockReturnValue(chain(row));
    Cellar.findById.mockReturnValue(chain({ _id: oid('c'), user: ME, members: [], deletedAt: null }));
    Bottle.findById
      .mockReturnValueOnce(chain({ _id: bottleRef('1'), cellar: bottleRef('c'), status: 'active' }))
      .mockReturnValueOnce(chain({ _id: bottleRef('2'), cellar: bottleRef('c'), status: 'active' }));
    bottleOps.removeBottleCascade.mockResolvedValue({ removed: true });
    McpActionLog.findOneAndUpdate.mockResolvedValue(row); // atomic claim wins
    const res = await tool('undo_last').handler({}, CTX);
    expect(parse(res).data.undone).toBe('bulk_add');
    expect(bottleOps.removeBottleCascade).toHaveBeenCalledTimes(2);
    // Reversal happens via the atomic conditional claim, not a plain save.
    expect(McpActionLog.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ reversed: false });
    expect(McpActionLog.create.mock.calls.at(-1)[0]).toMatchObject({ action: 'undo_add', viaUndo: true });
  });
});
