/**
 * MCP open-bottle tools (issue #835) — open_bottle / pour_glass / close_bottle.
 *
 * Pins: consume-scope gating, idempotency-by-state (repeat open reports the
 * existing state, NO second ledger row), implicit open on pour_glass, the
 * pour idempotency_key replay, the close prev-snapshot the undo needs, and
 * the three undo_last branches with their changed-since guards.
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
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn() }));
jest.mock('../utils/rackGeometry', () => ({ getMaxPosition: jest.fn(() => 12) }));
jest.mock('../services/search', () => ({
  getIsAvailable: jest.fn(() => false), search: jest.fn(), searchBottles: jest.fn(),
}));
jest.mock('../services/statsService', () => ({ computeOverview: jest.fn(), buildEmptyStats: jest.fn() }));
jest.mock('../services/vectorStore', () => ({ getPoints: jest.fn(), searchSimilar: jest.fn() }));
jest.mock('../config/aiConfig', () => ({ get: jest.fn(() => ({ vectorIndex: 'v1' })) }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(),
  restoreBottle: jest.fn(),
  removeFromRacks: jest.fn(),
  RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  addBottle: jest.fn(),
  updateBottleFields: jest.fn(),
  removeBottleCascade: jest.fn(),
  UPDATABLE_FIELDS: ['price', 'currency', 'notes', 'occasion', 'rating', 'ratingScale', 'drinkFrom', 'drinkTo'],
  openBottle: jest.fn(),
  pourFromBottle: jest.fn(),
  closeBottle: jest.fn(),
}));

const mongoose = require('mongoose');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const McpActionLog = require('../models/McpActionLog');
const bottleOps = require('../services/bottleOps');
const { logAudit } = require('../services/audit');
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
  const doc = {
    _id: oid('d'), cellar: oid('c'), status: 'active', vintage: '2015',
    bottleSize: '750ml', pours: [], openedAt: null, save: jest.fn(),
    ...over,
  };
  Bottle.findById.mockReturnValue(chain(doc));
  Cellar.findById.mockReturnValue(chain({ _id: oid('c'), user: ME, members: [], deletedAt: null }));
  return doc;
};

beforeEach(() => {
  jest.clearAllMocks();
  McpActionLog.findOne.mockReturnValue(chain(null));
  McpActionLog.create.mockResolvedValue({});
  McpActionLog.findOneAndUpdate.mockResolvedValue({ _id: 'claimed' });
  McpActionLog.updateOne.mockResolvedValue({});
});

describe('scope gating + annotations', () => {
  test('all three tools are consume-scoped, non-destructive, and invisible to a read token', () => {
    for (const name of ['open_bottle', 'pour_glass', 'close_bottle']) {
      expect(tool(name).scope).toBe('consume');
      expect(tool(name).annotations.readOnlyHint).toBe(false);
      expect(tool(name).annotations.destructiveHint).toBe(false);
    }
    expect(tool('open_bottle').annotations.idempotentHint).toBe(true);
    expect(tool('close_bottle').annotations.idempotentHint).toBe(true);
    expect(tool('pour_glass').annotations.idempotentHint).toBe(false); // every call adds pours

    const readNames = toolsForScopes(['read']).map((t) => t.name);
    for (const name of ['open_bottle', 'pour_glass', 'close_bottle']) {
      expect(readNames).not.toContain(name);
    }
    const consumeNames = toolsForScopes(['consume']).map((t) => t.name);
    expect(consumeNames).toEqual(expect.arrayContaining(['open_bottle', 'pour_glass', 'close_bottle']));
  });
});

describe('open_bottle', () => {
  test('foreign bottle → not_found, service untouched', async () => {
    Bottle.findById.mockReturnValue(chain({ _id: oid('d'), cellar: oid('c') }));
    Cellar.findById.mockReturnValue(chain({ _id: oid('c'), user: STRANGER, members: [], deletedAt: null }));
    const res = await tool('open_bottle').handler({ bottle_id: oid('d') }, CTX);
    expect(parse(res).error.code).toBe('not_found');
    expect(bottleOps.openBottle).not.toHaveBeenCalled();
  });

  test('consumed bottle with preserved open history → conflict, never a false "already open" success', async () => {
    // consume keeps openedAt/pours as drinking history — the shortcut must not
    // report a drunk bottle as currently open (2026-07-30 audit).
    ownBottle({ status: 'drank', consumedReason: 'drank', consumedAt: new Date('2026-07-25'), openedAt: new Date('2026-07-24'), preservationMethod: 'coravin', pours: [{ ml: 125 }] });
    const res = await tool('open_bottle').handler({ bottle_id: oid('d') }, CTX);
    const body = parse(res);
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toMatch(/already consumed/);
    expect(bottleOps.openBottle).not.toHaveBeenCalled();
    expect(McpActionLog.create).not.toHaveBeenCalled();
  });

  test('already-open bottle → idempotent ok reporting existing state, NO second ledger row (issue #835)', async () => {
    ownBottle({ openedAt: new Date('2026-07-27T18:00:00Z'), preservationMethod: 'vacuum', pours: [{ ml: 125 }] });
    const res = await tool('open_bottle').handler({ bottle_id: oid('d'), preservation_method: 'coravin' }, CTX);
    const body = parse(res);
    expect(body.error).toBeUndefined();
    expect(body.data.already_open).toBe(true);
    expect(body.data.preservation).toBe('vacuum'); // the EXISTING state, not the args
    expect(bottleOps.openBottle).not.toHaveBeenCalled();
    expect(McpActionLog.create).not.toHaveBeenCalled(); // nothing changed → nothing to undo
  });

  test('success: shared service gets method + opened_at + ctx.req; ledger row records the open for undo', async () => {
    const doc = ownBottle();
    bottleOps.openBottle.mockImplementation(async (bottle, { preservationMethod, openedAt }) => {
      bottle.openedAt = openedAt ? new Date(openedAt) : new Date();
      bottle.preservationMethod = preservationMethod;
      bottle.pours = [];
      return { bottle };
    });
    const res = await tool('open_bottle').handler(
      { bottle_id: oid('d'), preservation_method: 'coravin', opened_at: '2026-07-28' }, CTX);
    const body = parse(res);
    expect(body.data.open).toBe(true);
    expect(body.data.preservation).toBe('coravin');
    expect(body.data.freshness_days).toBe(90);
    expect(new Date(body.data.drink_by).getTime())
      .toBe(new Date('2026-07-28').getTime() + 90 * 86400000);
    expect(bottleOps.openBottle.mock.calls[0][1]).toEqual({ preservationMethod: 'coravin', openedAt: '2026-07-28' });
    expect(bottleOps.openBottle.mock.calls[0][2]).toBe(REQ);
    const row = McpActionLog.create.mock.calls[0][0];
    expect(row.action).toBe('open');
    expect(row.detail.preservationMethod).toBe('coravin');
    expect(row.detail.openedAt).toEqual(doc.openedAt);
  });

  test('service validation faults surface as invalid_input', async () => {
    ownBottle();
    bottleOps.openBottle.mockResolvedValue({ error: { status: 400, message: 'openedAt cannot be in the future' } });
    const res = await tool('open_bottle').handler({ bottle_id: oid('d'), opened_at: '2030-01-01' }, CTX);
    expect(parse(res).error).toEqual({ code: 'invalid_input', message: 'openedAt cannot be in the future' });
  });
});

describe('pour_glass', () => {
  test('closed bottle: opens implicitly first, then pours; ledger records implicitOpen for a full undo', async () => {
    const doc = ownBottle();
    bottleOps.openBottle.mockImplementation(async (bottle, { preservationMethod }) => {
      bottle.openedAt = new Date();
      bottle.preservationMethod = preservationMethod;
      return { bottle };
    });
    bottleOps.pourFromBottle.mockImplementation(async (bottle, { ml, count }) => {
      for (let i = 0; i < (count || 1); i += 1) bottle.pours.push({ at: new Date(), ml: ml || 125 });
      return { bottle };
    });
    const res = await tool('pour_glass').handler({ bottle_id: oid('d') }, CTX);
    const body = parse(res);
    expect(bottleOps.openBottle.mock.calls[0][1]).toEqual({ preservationMethod: 'recorked' });
    expect(bottleOps.pourFromBottle).toHaveBeenCalledTimes(1);
    expect(body.data.pours).toBe(1);
    expect(body.data.remaining_ml).toBe(625); // 750ml bottle - one 125ml glass
    const row = McpActionLog.create.mock.calls[0][0];
    expect(row.action).toBe('pour');
    expect(row.detail).toMatchObject({ count: 1, ml: 125, implicitOpen: true, openedAt: doc.openedAt });
  });

  test('open bottle: no implicit open; glasses=3 is ONE all-or-nothing service call (single save)', async () => {
    ownBottle({ openedAt: new Date(), preservationMethod: 'vacuum' });
    bottleOps.pourFromBottle.mockImplementation(async (bottle, { ml, count }) => {
      for (let i = 0; i < (count || 1); i += 1) bottle.pours.push({ at: new Date(), ml });
      return { bottle };
    });
    const res = await tool('pour_glass').handler({ bottle_id: oid('d'), glasses: 3, ml: 100 }, CTX);
    expect(bottleOps.openBottle).not.toHaveBeenCalled();
    expect(bottleOps.pourFromBottle).toHaveBeenCalledTimes(1);
    expect(bottleOps.pourFromBottle.mock.calls[0][1]).toEqual({ ml: 100, count: 3 });
    expect(parse(res).data.poured_ml).toBe(300);
    expect(McpActionLog.create.mock.calls[0][0].detail).toMatchObject({ count: 3, ml: 100, implicitOpen: false });
  });

  test('consumed bottle → conflict; the open-state history is never touched', async () => {
    ownBottle({ status: 'drank', consumedReason: 'drank', openedAt: new Date('2026-07-20'), preservationMethod: 'vacuum', pours: [{ ml: 125 }] });
    const res = await tool('pour_glass').handler({ bottle_id: oid('d') }, CTX);
    const body = parse(res);
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toMatch(/restore_bottle/);
    expect(bottleOps.openBottle).not.toHaveBeenCalled();
    expect(bottleOps.pourFromBottle).not.toHaveBeenCalled();
  });

  test('pour failure after an implicit open rolls the open back (no orphaned unledgered state)', async () => {
    const doc = ownBottle();
    const openedAt = new Date('2026-07-30T18:00:00Z');
    bottleOps.openBottle.mockImplementation(async (bottle) => {
      bottle.openedAt = openedAt;
      bottle.preservationMethod = 'recorked';
      return { bottle };
    });
    bottleOps.pourFromBottle.mockResolvedValue({ error: { status: 400, message: 'Too many pours recorded for this bottle' } });
    // The rollback re-loads the bottle fresh; hand it the same (still ours,
    // untouched) open state so the compensation may proceed.
    bottleOps.closeBottle.mockResolvedValue({ bottle: doc, prevOpenState: {} });
    const res = await tool('pour_glass').handler({ bottle_id: oid('d'), glasses: 2 }, CTX);
    expect(parse(res).error.code).toBe('invalid_input');
    expect(bottleOps.closeBottle).toHaveBeenCalledTimes(1); // the compensation
    expect(McpActionLog.create).not.toHaveBeenCalled();     // nothing to ledger
  });

  test('idempotent replay: a seen key returns the ORIGINAL envelope without pouring again', async () => {
    McpActionLog.findOneAndUpdate.mockResolvedValueOnce({
      lastErrorObject: { updatedExisting: true },
      value: { pending: false, tool: 'pour_glass', result: { summary: 'Poured once', data: { bottle_id: oid('d') } } },
    });
    const res = await tool('pour_glass').handler({ bottle_id: oid('d'), idempotency_key: 'k1' }, CTX);
    expect(parse(res).summary).toBe('Poured once');
    expect(bottleOps.pourFromBottle).not.toHaveBeenCalled();
    expect(McpActionLog.create).not.toHaveBeenCalled();
  });

  test('service faults on an already-open bottle surface as invalid_input (no rollback — the open is not ours)', async () => {
    ownBottle({ openedAt: new Date(), preservationMethod: 'vacuum' });
    bottleOps.pourFromBottle.mockResolvedValue({ error: { status: 400, message: 'Too many pours recorded for this bottle' } });
    const res = await tool('pour_glass').handler({ bottle_id: oid('d') }, CTX);
    expect(parse(res).error.code).toBe('invalid_input');
    expect(bottleOps.closeBottle).not.toHaveBeenCalled();
    expect(McpActionLog.create).not.toHaveBeenCalled();
  });
});

describe('close_bottle', () => {
  test('consumed bottle → conflict; preserved open history is never wiped', async () => {
    ownBottle({ status: 'drank', consumedReason: 'drank', openedAt: new Date('2026-07-24'), preservationMethod: 'coravin', pours: [{ ml: 125 }] });
    const res = await tool('close_bottle').handler({ bottle_id: oid('d') }, CTX);
    const body = parse(res);
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toMatch(/consumption record/);
    expect(bottleOps.closeBottle).not.toHaveBeenCalled();
  });

  test('not-open bottle → conflict pointing at consume_bottle', async () => {
    ownBottle();
    bottleOps.closeBottle.mockResolvedValue({ error: { status: 400, message: 'Bottle is not open', code: 'not_open' } });
    const res = await tool('close_bottle').handler({ bottle_id: oid('d') }, CTX);
    const body = parse(res);
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toMatch(/consume_bottle/);
  });

  test('success: ledger row carries the prev open-state snapshot the undo restores', async () => {
    const openedAt = new Date('2026-07-28T19:00:00Z');
    const prevOpenState = { openedAt, preservationMethod: 'coravin', pours: [{ at: openedAt, ml: 125 }], openBottleNotifiedAt: null };
    ownBottle({ openedAt, preservationMethod: 'coravin', pours: [{ at: openedAt, ml: 125 }] });
    bottleOps.closeBottle.mockImplementation(async (bottle) => {
      bottle.openedAt = null; bottle.preservationMethod = undefined; bottle.pours = [];
      return { bottle, prevOpenState };
    });
    const res = await tool('close_bottle').handler({ bottle_id: oid('d') }, CTX);
    const body = parse(res);
    expect(body.data.open).toBe(false);
    expect(body.data.pours_discarded).toBe(1);
    const row = McpActionLog.create.mock.calls[0][0];
    expect(row.action).toBe('close');
    expect(row.prev).toBe(prevOpenState);
  });
});

describe('undo_last on open/pour/close', () => {
  const bottleRef = () => new mongoose.Types.ObjectId(oid('d'));

  test('refuses ALL three undos once the bottle was consumed since (history is part of the consumption record)', async () => {
    // A web-UI consume writes no MCP ledger row, so the pour row is still the
    // newest candidate — but the pours it would splice out are preserved
    // drinking history now (2026-07-30 audit).
    const openedAt = new Date('2026-07-28T19:00:00Z');
    const entry = { _id: 'log0', action: 'pour', bottle: bottleRef(), reversed: false, detail: { count: 1, ml: 125, implicitOpen: false } };
    McpActionLog.findOne.mockReturnValue(chain(entry));
    const doc = ownBottle({ status: 'drank', consumedReason: 'drank', openedAt, preservationMethod: 'vacuum', pours: [{ at: openedAt, ml: 125 }] });
    const res = await tool('undo_last').handler({}, CTX);
    const body = parse(res);
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toMatch(/consumed since/);
    expect(doc.save).not.toHaveBeenCalled();
    expect(bottleOps.closeBottle).not.toHaveBeenCalled();
    // Not claimed either — the row stays available (the guard fired before the claim).
    expect(McpActionLog.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('open-undo: a thrown VersionError from closeBottle unclaims the row so the undo can be retried (M1 class)', async () => {
    const openedAt = new Date('2026-07-28T19:00:00Z');
    const entry = { _id: 'log7', action: 'open', bottle: bottleRef(), reversed: false, detail: { preservationMethod: 'vacuum', openedAt } };
    McpActionLog.findOne.mockReturnValue(chain(entry));
    ownBottle({ openedAt, preservationMethod: 'vacuum', pours: [] });
    const versionError = new Error('No matching document found');
    versionError.name = 'VersionError';
    bottleOps.closeBottle.mockRejectedValue(versionError);
    const res = await tool('undo_last').handler({}, CTX);
    const body = parse(res);
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toMatch(/mid-undo/);
    // Claimed, then released again so a retry finds the row un-reversed.
    expect(McpActionLog.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'log7', reversed: false }, { $set: { reversed: true, idempotencyKey: null } });
    expect(McpActionLog.updateOne).toHaveBeenCalledWith({ _id: 'log7' }, { $set: { reversed: false } });
    expect(McpActionLog.create).not.toHaveBeenCalled(); // no viaUndo row — nothing was undone
  });

  test('undoes an open via the shared closeBottle op', async () => {
    const openedAt = new Date('2026-07-28T19:00:00Z');
    const entry = { _id: 'log1', action: 'open', bottle: bottleRef(), reversed: false, detail: { preservationMethod: 'vacuum', openedAt } };
    McpActionLog.findOne.mockReturnValue(chain(entry));
    const doc = ownBottle({ openedAt, preservationMethod: 'vacuum', pours: [] });
    bottleOps.closeBottle.mockImplementation(async (bottle) => {
      bottle.openedAt = null;
      return { bottle, prevOpenState: { openedAt, preservationMethod: 'vacuum', pours: [], openBottleNotifiedAt: null } };
    });
    const res = await tool('undo_last').handler({}, CTX);
    expect(parse(res).data.undone).toBe('open_bottle');
    expect(bottleOps.closeBottle).toHaveBeenCalledWith(doc, REQ);
    expect(McpActionLog.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'log1', reversed: false }, { $set: { reversed: true, idempotencyKey: null } });
  });

  test('refuses to undo an open once pours were recorded since (they would be discarded)', async () => {
    const openedAt = new Date('2026-07-28T19:00:00Z');
    const entry = { _id: 'log2', action: 'open', bottle: bottleRef(), reversed: false, detail: { openedAt } };
    McpActionLog.findOne.mockReturnValue(chain(entry));
    ownBottle({ openedAt, preservationMethod: 'vacuum', pours: [{ ml: 125 }] });
    const res = await tool('undo_last').handler({}, CTX);
    expect(parse(res).error.code).toBe('conflict');
    expect(bottleOps.closeBottle).not.toHaveBeenCalled();
  });

  test('undoes a pour by removing exactly its pours; an implicit open is cleared with the last one', async () => {
    const openedAt = new Date('2026-07-28T19:00:00Z');
    const entry = {
      _id: 'log3', action: 'pour', bottle: bottleRef(), reversed: false,
      detail: { count: 1, ml: 125, implicitOpen: true, openedAt },
    };
    McpActionLog.findOne.mockReturnValue(chain(entry));
    const doc = ownBottle({ openedAt, preservationMethod: 'recorked', pours: [{ at: openedAt, ml: 125 }] });
    const res = await tool('undo_last').handler({}, CTX);
    const body = parse(res);
    expect(body.data.undone).toBe('pour_glass');
    expect(body.data.open).toBe(false); // implicit open cleared too
    expect(doc.pours).toHaveLength(0);
    expect(doc.openedAt).toBeNull();
    expect(doc.save).toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(REQ, 'bottle.open_undo', expect.anything());
  });

  test('refuses to undo a pour when the recorded pours changed since (hand-edit wins)', async () => {
    const entry = { _id: 'log4', action: 'pour', bottle: bottleRef(), reversed: false, detail: { count: 1, ml: 125, implicitOpen: false } };
    McpActionLog.findOne.mockReturnValue(chain(entry));
    const doc = ownBottle({ openedAt: new Date(), preservationMethod: 'vacuum', pours: [{ ml: 200 }] }); // different ml since
    const res = await tool('undo_last').handler({}, CTX);
    expect(parse(res).error.code).toBe('conflict');
    expect(doc.save).not.toHaveBeenCalled();
  });

  test('undoes a close by restoring the prev snapshot (openedAt, method, pours)', async () => {
    const openedAt = new Date('2026-07-28T19:00:00Z');
    const entry = {
      _id: 'log5', action: 'close', bottle: bottleRef(), reversed: false,
      prev: { openedAt, preservationMethod: 'coravin', pours: [{ at: openedAt, ml: 125 }, { at: openedAt, ml: 125 }], openBottleNotifiedAt: null },
    };
    McpActionLog.findOne.mockReturnValue(chain(entry));
    const doc = ownBottle(); // currently closed
    const res = await tool('undo_last').handler({}, CTX);
    const body = parse(res);
    expect(body.data.undone).toBe('close_bottle');
    expect(body.data.pours).toBe(2);
    expect(doc.openedAt).toEqual(openedAt);
    expect(doc.preservationMethod).toBe('coravin');
    expect(doc.pours).toHaveLength(2);
    expect(doc.save).toHaveBeenCalled();
  });

  test('refuses to undo a close when the bottle was re-opened since', async () => {
    const entry = { _id: 'log6', action: 'close', bottle: bottleRef(), reversed: false, prev: { openedAt: new Date('2026-07-01') } };
    McpActionLog.findOne.mockReturnValue(chain(entry));
    const doc = ownBottle({ openedAt: new Date(), preservationMethod: 'vacuum' }); // re-opened by hand
    const res = await tool('undo_last').handler({}, CTX);
    expect(parse(res).error.code).toBe('conflict');
    expect(doc.save).not.toHaveBeenCalled();
  });
});
