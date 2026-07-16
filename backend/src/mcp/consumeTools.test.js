/**
 * MCP consume tools — write-safety invariants.
 *
 * Pins the layers that make the first mutating tools safe: scope gating
 * (read-only tokens never see them), access re-verification before any
 * mutation, the already-consumed conflict guard, idempotency replay (the
 * original result comes back, the op does NOT run again), the undo ledger,
 * and token attribution (id only, never the credential).
 */

const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

jest.mock('../models/Cellar', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({
  find: jest.fn(), findById: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn(),
}));
jest.mock('../models/Rack', () => ({ find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WishlistItem', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/JournalEntry', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/WineEmbedding', () => ({ findOne: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../utils/rackGeometry', () => ({ getMaxPosition: jest.fn(() => 12) }));
jest.mock('../services/search', () => ({
  getIsAvailable: jest.fn(() => false), search: jest.fn(), searchBottles: jest.fn(),
}));
jest.mock('../services/statsService', () => ({ computeOverview: jest.fn(), buildEmptyStats: jest.fn() }));
jest.mock('../services/vectorStore', () => ({ getPoints: jest.fn(), searchSimilar: jest.fn() }));
jest.mock('../config/aiConfig', () => ({ get: jest.fn(() => ({ vectorIndex: 'v1' })) }));
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(),
  restoreBottle: jest.fn(),
  removeFromRacks: jest.fn(),
  RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  addBottle: jest.fn(),
  updateBottleFields: jest.fn(),
  removeBottleCascade: jest.fn(),
  UPDATABLE_FIELDS: ['price', 'currency', 'notes', 'occasion', 'rating', 'ratingScale', 'drinkFrom', 'drinkTo'],
}));

const mongoose = require('mongoose');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const McpActionLog = require('../models/McpActionLog');
const bottleOps = require('../services/bottleOps');
const { allTools, toolsForScopes } = require('./registry');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const STRANGER = oid('b');
const REQ = { user: { id: ME, roles: ['user'] }, headers: {}, apiToken: { id: 't1', scopes: ['consume'] } };
const CTX = { user: { id: ME }, scopes: ['consume'], req: REQ };

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

const ownBottle = (over = {}) => {
  Bottle.findById.mockReturnValue(chain({
    _id: oid('d'), cellar: oid('c'), status: 'active', vintage: '2015', ...over,
  }));
  Cellar.findById.mockReturnValue(chain({ _id: oid('c'), user: ME, members: [], deletedAt: null }));
};

beforeEach(() => {
  jest.clearAllMocks();
  McpActionLog.findOne.mockReturnValue(chain(null));
  McpActionLog.create.mockResolvedValue({});
});

describe('scope gating', () => {
  test('consume tools exist, carry the consume scope + honest annotations', () => {
    for (const name of ['consume_bottle', 'restore_bottle']) {
      expect(tool(name).scope).toBe('consume');
      expect(tool(name).annotations.readOnlyHint).toBe(false);
    }
    // undo_last reverses BOTH consume- and write-scoped mutations, so it is
    // reachable by either scope.
    expect(tool('undo_last').scope).toEqual(['consume', 'write']);
    expect(tool('consume_bottle').annotations.destructiveHint).toBe(true);
    expect(tool('consume_bottle').annotations.idempotentHint).toBe(false);
    expect(tool('restore_bottle').annotations.idempotentHint).toBe(true);
  });

  test('undo_last is reachable by a WRITE-only token too (it reverses write actions)', () => {
    const writeNames = toolsForScopes(['write'], ['user']).map((t) => t.name);
    expect(writeNames).toContain('undo_last');
    expect(writeNames).toContain('add_bottle');
  });

  test('a read-only token NEVER sees the consume tools; a consume token sees them but not read tools', () => {
    const readNames = toolsForScopes(['read']).map((t) => t.name);
    expect(readNames).not.toContain('consume_bottle');
    expect(readNames).not.toContain('undo_last');
    const consumeNames = toolsForScopes(['consume']).map((t) => t.name);
    expect(consumeNames).toEqual(expect.arrayContaining(['consume_bottle', 'restore_bottle', 'undo_last', 'get_source_info']));
    expect(consumeNames).not.toContain('search_bottles');
  });
});

describe('consume_bottle', () => {
  test('foreign bottle → not_found, and the mutation service is never touched', async () => {
    Bottle.findById.mockReturnValue(chain({ _id: oid('d'), cellar: oid('c') }));
    Cellar.findById.mockReturnValue(chain({ _id: oid('c'), user: STRANGER, members: [], deletedAt: null }));
    const res = await tool('consume_bottle').handler({ bottle_id: oid('d') }, CTX);
    expect(parse(res).error.code).toBe('not_found');
    expect(bottleOps.consumeBottle).not.toHaveBeenCalled();
  });

  test('already-consumed bottle → conflict (a looping agent cannot double-log)', async () => {
    ownBottle({ status: 'drank', consumedReason: 'drank', consumedAt: new Date('2026-07-01') });
    const res = await tool('consume_bottle').handler({ bottle_id: oid('d') }, CTX);
    expect(parse(res).error.code).toBe('conflict');
    expect(bottleOps.consumeBottle).not.toHaveBeenCalled();
  });

  test('success: shared service called with ctx.req; ledger row carries token id + reason, never the token value', async () => {
    ownBottle();
    bottleOps.consumeBottle.mockImplementation(async (bottle, opts) => {
      bottle.status = opts.reason; bottle.consumedAt = new Date();
      return { bottle };
    });
    const res = await tool('consume_bottle').handler(
      { bottle_id: oid('d'), reason: 'gifted', idempotency_key: 'k1' }, CTX);
    const body = parse(res);
    expect(body.data.status).toBe('gifted');
    expect(body.data.undo).toMatch(/restore_bottle/);
    expect(bottleOps.consumeBottle.mock.calls[0][2]).toBe(REQ);
    const row = McpActionLog.create.mock.calls[0][0];
    expect(row).toMatchObject({
      user: ME, tokenId: 't1', tool: 'consume_bottle', action: 'consume', idempotencyKey: 'k1',
    });
    expect(JSON.stringify(row)).not.toMatch(/cel_/);
  });

  test('idempotent replay: a seen key returns the ORIGINAL envelope without re-consuming', async () => {
    McpActionLog.findOne.mockReturnValue(chain({ result: { summary: 'Consumed once', data: { bottle_id: oid('d') } } }));
    const res = await tool('consume_bottle').handler({ bottle_id: oid('d'), idempotency_key: 'k1' }, CTX);
    expect(parse(res).summary).toBe('Consumed once');
    expect(bottleOps.consumeBottle).not.toHaveBeenCalled();
    expect(McpActionLog.create).not.toHaveBeenCalled();
  });

  test('service validation faults surface as invalid_input', async () => {
    ownBottle();
    bottleOps.consumeBottle.mockResolvedValue({ error: { status: 400, message: 'Invalid reason' } });
    const res = await tool('consume_bottle').handler({ bottle_id: oid('d'), reason: 'drank' }, CTX);
    expect(parse(res).error).toEqual({ code: 'invalid_input', message: 'Invalid reason' });
  });
});

describe('restore_bottle', () => {
  test('snapshots the consumed fields into prev BEFORE the restore clears them', async () => {
    ownBottle({ status: 'drank', consumedReason: 'drank', consumedNote: 'great', consumedRating: 4, consumedRatingScale: '5', consumedAt: new Date() });
    bottleOps.restoreBottle.mockImplementation(async (bottle) => {
      bottle.status = 'active'; bottle.consumedReason = undefined;
      return { bottle, from: 'drank' };
    });
    await tool('restore_bottle').handler({ bottle_id: oid('d') }, CTX);
    const row = McpActionLog.create.mock.calls[0][0];
    expect(row.action).toBe('restore');
    expect(row.prev).toEqual({ reason: 'drank', note: 'great', rating: 4, ratingScale: '5' });
  });

  test('expired window surfaces as conflict', async () => {
    ownBottle({ status: 'drank' });
    bottleOps.restoreBottle.mockResolvedValue({ error: { status: 400, message: 'too old', code: 'restore_window_expired' } });
    const res = await tool('restore_bottle').handler({ bottle_id: oid('d') }, CTX);
    expect(parse(res).error.code).toBe('conflict');
  });
});

describe('undo_last', () => {
  // REGRESSION (audit HIGH, second occurrence of the class): McpActionLog.bottle
  // is an ObjectId INSTANCE on a hydrated doc — a string-typed mock here masked
  // resolveBottleAccess rejecting every real undo. Always mock the ref as a
  // real ObjectId.
  const bottleRef = () => new mongoose.Types.ObjectId(oid('d'));

  test('nothing to undo → not_found', async () => {
    McpActionLog.findOne.mockReturnValue(chain(null));
    const res = await tool('undo_last').handler({}, CTX);
    expect(parse(res).error.code).toBe('not_found');
  });

  test('query is per-user, un-reversed, and recency-bounded to the restore window', async () => {
    McpActionLog.findOne.mockReturnValue(chain(null));
    await tool('undo_last').handler({}, CTX);
    const q = McpActionLog.findOne.mock.calls[0][0];
    expect(q.user).toBe(ME);
    expect(q.reversed).toBe(false);
    expect(q.createdAt.$gte).toBeInstanceOf(Date);
    expect(Date.now() - q.createdAt.$gte.getTime()).toBeLessThanOrEqual(2 * 24 * 3600 * 1000 + 5000);
  });

  test('undoes a consume by restoring (ObjectId ref!), snapshots prev for the reverse row, marks reversed', async () => {
    const entry = { _id: 'log1', action: 'consume', bottle: bottleRef(), reversed: false, save: jest.fn() };
    McpActionLog.findOne.mockReturnValue(chain(entry));
    ownBottle({ status: 'drank', consumedReason: 'gifted', consumedNote: 'oops', consumedRating: 4, consumedRatingScale: '5' });
    bottleOps.restoreBottle.mockImplementation(async (bottle) => { bottle.status = 'active'; return { bottle, from: 'gifted' }; });
    const res = await tool('undo_last').handler({}, CTX);
    expect(parse(res).data.undone).toBe('consume_bottle');
    expect(entry.reversed).toBe(true);
    expect(entry.save).toHaveBeenCalled();
    // The undo's own ledger row must carry the pre-restore snapshot, so a
    // second undo re-consumes with the ORIGINAL values, not defaults.
    const row = McpActionLog.create.mock.calls[0][0];
    expect(row.action).toBe('restore');
    expect(row.prev).toEqual({ reason: 'gifted', note: 'oops', rating: 4, ratingScale: '5' });
  });

  test('undoes a restore by re-consuming with the ORIGINAL prev fields', async () => {
    const entry = {
      _id: 'log2', action: 'restore', bottle: bottleRef(), reversed: false, save: jest.fn(),
      prev: { reason: 'gifted', note: 'to Anna', rating: 4, ratingScale: '5' },
    };
    McpActionLog.findOne.mockReturnValue(chain(entry));
    ownBottle({ status: 'active' });
    bottleOps.consumeBottle.mockImplementation(async (bottle, opts) => { bottle.status = opts.reason; return { bottle }; });
    const res = await tool('undo_last').handler({}, CTX);
    expect(parse(res).data.undone).toBe('restore_bottle');
    expect(bottleOps.consumeBottle.mock.calls[0][1]).toEqual({ reason: 'gifted', note: 'to Anna', rating: 4, ratingScale: '5' });
    expect(entry.reversed).toBe(true);
  });

  test('refuses to undo a restore when the bottle was consumed again since (state moved on)', async () => {
    const entry = { _id: 'log3', action: 'restore', bottle: bottleRef(), reversed: false, save: jest.fn(), prev: {} };
    McpActionLog.findOne.mockReturnValue(chain(entry));
    ownBottle({ status: 'drank' }); // re-consumed via the UI since the restore
    const res = await tool('undo_last').handler({}, CTX);
    expect(parse(res).error.code).toBe('conflict');
    expect(bottleOps.consumeBottle).not.toHaveBeenCalled();
    expect(entry.reversed).toBe(false); // nothing changed → row stays undoable-looking but untouched
  });
});

describe('mutation rate budget (write-limiter parity at the tool layer)', () => {
  const { budgetedHandler, takeMutationSlot } = require('./server');
  const mkTool = (readOnly) => ({
    name: 'x', annotations: { readOnlyHint: readOnly }, handler: async () => ({ content: [] }),
  });

  test('mutating tools share the admin-tunable write cap per user; reads are exempt', async () => {
    const max = require('../config/rateLimits').get().write.max;
    const userId = 'u-budget-test';
    for (let i = 0; i < max; i++) expect(takeMutationSlot(userId)).toBe(true);
    expect(takeMutationSlot(userId)).toBe(false); // window exhausted

    const ctx = { user: { id: userId }, scopes: ['consume'] };
    const blocked = await budgetedHandler(mkTool(false), ctx, { calls: 0 })({});
    expect(blocked.isError).toBe(true);
    expect(JSON.parse(blocked.content[0].text).error.code).toBe('rate_limited');

    // Read-only tools never touch the mutation budget.
    const readRes = await budgetedHandler(mkTool(true), ctx, { calls: 0 })({});
    expect(readRes.isError).toBeUndefined();

    // Other users are unaffected (per-user windows).
    expect(takeMutationSlot('someone-else')).toBe(true);
  });
});

describe('undo_last walk-backward + scope gating (e2e-caught regression)', () => {
  test('the candidate query excludes undo-generated rows and respects the write grant', async () => {
    McpActionLog.findOne.mockReturnValue(chain(null));
    await tool('undo_last').handler({}, CTX); // CTX has scopes ['consume'] only
    let q = McpActionLog.findOne.mock.calls[0][0];
    expect(q.viaUndo).toEqual({ $ne: true });
    expect(q.action.$in).toEqual(['consume', 'restore']); // no add/update without write

    McpActionLog.findOne.mockClear();
    McpActionLog.findOne.mockReturnValue(chain(null));
    await tool('undo_last').handler({}, { ...CTX, scopes: ['consume', 'write'] });
    q = McpActionLog.findOne.mock.calls[0][0];
    expect(q.action.$in).toEqual(['consume', 'restore', 'add', 'update', 'bulk_add', 'somm_maturity', 'somm_price',
      'cellar_create', 'rack_create', 'place', 'unplace', 'move']);
  });

  test('the reverse row is marked viaUndo and the undone row frees its idempotency key', async () => {
    const entry = {
      _id: 'log9', action: 'consume', bottle: new mongoose.Types.ObjectId(oid('d')),
      reversed: false, idempotencyKey: 'k-once', save: jest.fn(),
    };
    McpActionLog.findOne.mockReturnValue(chain(entry));
    ownBottle({ status: 'drank' });
    bottleOps.restoreBottle.mockImplementation(async (bottle) => { bottle.status = 'active'; return { bottle, from: 'drank' }; });
    await tool('undo_last').handler({}, CTX);
    expect(entry.reversed).toBe(true);
    expect(entry.idempotencyKey).toBeNull();
    expect(McpActionLog.create.mock.calls[0][0].viaUndo).toBe(true);
  });
});
