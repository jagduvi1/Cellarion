/**
 * MCP Phase-3 write tools — auto_arrange (preview→apply→undo) and
 * capture_tasting_note invariants.
 *
 * Pins the write-safety stack on the two new mutating tools: the stored
 * server-side plan (client cannot swap it), staleness detection (any rack
 * change since preview = conflict), the atomic preview claim, the one-save
 * atomic apply, the arrange undo's exact-state guard, rating validation before
 * any write, ledger prev snapshots, and idempotency replay.
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
  find: jest.fn(), findById: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn(), distinct: jest.fn(),
}));
jest.mock('../models/Rack', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/WishlistItem', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/JournalEntry', () => ({ create: jest.fn(), deleteOne: jest.fn(), findOneAndDelete: jest.fn(), find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/WineEmbedding', () => ({ findOne: jest.fn() }));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../services/search', () => ({ getIsAvailable: jest.fn(() => false), search: jest.fn(), searchBottles: jest.fn() }));
jest.mock('../services/statsService', () => ({ computeOverview: jest.fn(), buildEmptyStats: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('./mutationBudget', () => ({ takeMutationSlot: jest.fn(() => true), WRITE_WINDOW_MS: 900000 }));
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), addBottle: jest.fn(), updateBottleFields: jest.fn(),
  removeBottleCascade: jest.fn(), RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  UPDATABLE_FIELDS: ['price', 'currency', 'notes', 'occasion', 'rating', 'ratingScale', 'drinkFrom', 'drinkTo'],
}));

const mongoose = require('mongoose');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const Rack = require('../models/Rack');
const JournalEntry = require('../models/JournalEntry');
const WineVintageProfile = require('../models/WineVintageProfile');
const McpActionLog = require('../models/McpActionLog');
const { takeMutationSlot } = require('./mutationBudget');
const bottleOps = require('../services/bottleOps');
const { logAudit } = require('../services/audit');
const { allTools, toolsForScopes } = require('./registry');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const CTX = { user: { id: ME }, scopes: ['write'], req: { user: { id: ME }, headers: {} } };
const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

const THIS_YEAR = new Date().getFullYear();

const bottleDoc = (id, { vintage = '2015', type = 'red', name = 'Wine', drinkTo } = {}) => ({
  _id: new mongoose.Types.ObjectId(oid(id)),
  vintage,
  drinkTo,
  wineDefinition: { _id: new mongoose.Types.ObjectId(), name, producer: 'P', type },
});

/** A 2×2 grid rack with two bottles that are NOT in maturity order. */
function mkRack() {
  return {
    _id: new mongoose.Types.ObjectId(oid('e')),
    cellar: new mongoose.Types.ObjectId(oid('c')),
    name: 'Rack A',
    type: 'grid', rows: 2, cols: 2, isModular: false,
    disabledPositions: [],
    slots: [
      { position: 1, bottle: bottleDoc('1', { drinkTo: THIS_YEAR + 5, name: 'Fresh' }) },   // peak
      { position: 2, bottle: bottleDoc('2', { drinkTo: THIS_YEAR - 1, name: 'Urgent' }) },  // declining → belongs first
    ],
    save: jest.fn().mockResolvedValue({}),
  };
}

function wireRackLoad(rack) {
  Rack.findOne
    .mockReturnValueOnce(chain({ cellar: rack.cellar }))  // access stub
    .mockReturnValueOnce(chain(rack));                     // populated doc
  Cellar.findById.mockReturnValue(chain({ _id: rack.cellar, user: ME, members: [], deletedAt: null, name: 'Main' }));
  WineVintageProfile.find.mockReturnValue(chain([]));
}

beforeEach(() => {
  jest.clearAllMocks();
  takeMutationSlot.mockReturnValue(true);
  McpActionLog.findOne.mockReturnValue(chain(null));
  McpActionLog.create.mockResolvedValue({ _id: new mongoose.Types.ObjectId(oid('f')) });
  McpActionLog.findOneAndUpdate.mockResolvedValue({ _id: 'claimed' });
});

describe('registration & scope', () => {
  test('both tools are write-scoped mutations, invisible to read tokens', () => {
    for (const name of ['auto_arrange', 'capture_tasting_note']) {
      expect(tool(name).scope).toBe('write');
      expect(tool(name).annotations.readOnlyHint).toBe(false);
    }
    const readNames = toolsForScopes(['read'], ['user']).map((t) => t.name);
    expect(readNames).not.toContain('auto_arrange');
    expect(readNames).not.toContain('capture_tasting_note');
  });
});

describe('auto_arrange preview', () => {
  test('computes the plan, stores it server-side, returns preview_id + human move list', async () => {
    const rack = mkRack();
    wireRackLoad(rack);
    const res = await tool('auto_arrange').handler({ rack_id: oid('e'), strategy: 'maturity' }, CTX);
    const body = parse(res);
    expect(body.data.bottles_moving).toBe(2); // the two swap places
    expect(body.data.moves[0]).toMatchObject({ from: 2, to: 1 });
    expect(body.data.moves[0].bottle).toContain('Urgent');
    const stored = McpActionLog.create.mock.calls[0][0];
    expect(stored.action).toBe('arrange_preview');
    expect(stored.prev.before).toEqual([
      { position: 1, bottleId: oid('1') }, { position: 2, bottleId: oid('2') },
    ]);
    expect(stored.prev.target[0]).toEqual({ position: 1, bottleId: oid('2') });
    expect(rack.save).not.toHaveBeenCalled(); // preview never mutates
  });

  test('already-arranged rack → no ledger row, nothing to apply', async () => {
    const rack = mkRack();
    // Swap so declining already sits first.
    rack.slots = [
      { position: 1, bottle: bottleDoc('2', { drinkTo: THIS_YEAR - 1 }) },
      { position: 2, bottle: bottleDoc('1', { drinkTo: THIS_YEAR + 5 }) },
    ];
    wireRackLoad(rack);
    const res = await tool('auto_arrange').handler({ rack_id: oid('e') }, CTX);
    expect(parse(res).summary).toMatch(/already arranged/);
    expect(McpActionLog.create).not.toHaveBeenCalled();
  });

  test('foreign rack → not_found (no oracle)', async () => {
    Rack.findOne.mockReturnValueOnce(chain(null));
    const res = await tool('auto_arrange').handler({ rack_id: oid('9') }, CTX);
    expect(parse(res).error.code).toBe('not_found');
  });

  test('more bottles than usable positions → conflict, never position:undefined targets', async () => {
    const rack = mkRack();
    rack.disabledPositions = [1, 2, 3]; // capacity 4, usable 1, but 2 bottles placed
    wireRackLoad(rack);
    const res = await tool('auto_arrange').handler({ rack_id: oid('e') }, CTX);
    const body = parse(res);
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toMatch(/usable position/);
    expect(McpActionLog.create).not.toHaveBeenCalled();
  });
});

describe('auto_arrange apply', () => {
  const preview = (rack) => ({
    _id: new mongoose.Types.ObjectId(oid('f')),
    createdAt: new Date(),
    prev: {
      rackId: String(rack._id),
      strategy: 'maturity',
      before: [{ position: 1, bottleId: oid('1') }, { position: 2, bottleId: oid('2') }],
      target: [{ position: 1, bottleId: oid('2') }, { position: 2, bottleId: oid('1') }],
      moveList: [{ bottle: 'Urgent', from: 2, to: 1 }, { bottle: 'Fresh', from: 1, to: 2 }],
    },
  });

  test('applies the stored target in ONE save and records the undo snapshot', async () => {
    const rack = mkRack();
    McpActionLog.findOne.mockReturnValue(chain(preview(rack)));
    wireRackLoad(rack);
    const res = await tool('auto_arrange').handler({ mode: 'apply', preview_id: oid('f') }, CTX);
    const body = parse(res);
    expect(body.data.moved).toBe(2);
    expect(rack.save).toHaveBeenCalledTimes(1);
    expect(rack.slots.map((s) => ({ position: s.position, bottle: String(s.bottle) }))).toEqual([
      { position: 1, bottle: oid('2') }, { position: 2, bottle: oid('1') },
    ]);
    // Preview claimed + cleared; applied row carries prev.before for undo.
    expect(McpActionLog.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: preview(rack)._id, reversed: false }, { $set: { reversed: true, prev: null } });
    const appliedRow = McpActionLog.create.mock.calls.find((c) => c[0].action === 'arrange')[0];
    expect(appliedRow.prev.before).toEqual(preview(rack).prev.before);
    expect(appliedRow.detail.target).toEqual(preview(rack).prev.target);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'rack.arrange', expect.anything(), expect.objectContaining({ via: 'mcp' }));
  });

  test('rack changed since preview → conflict, nothing saved, budget untouched', async () => {
    const rack = mkRack();
    rack.slots[1].bottle = bottleDoc('3'); // someone re-placed a bottle since
    McpActionLog.findOne.mockReturnValue(chain(preview(rack)));
    wireRackLoad(rack);
    const res = await tool('auto_arrange').handler({ mode: 'apply', preview_id: oid('f') }, CTX);
    expect(parse(res).error.code).toBe('conflict');
    expect(rack.save).not.toHaveBeenCalled();
    expect(takeMutationSlot).not.toHaveBeenCalled();
  });

  test('expired preview → conflict; used/foreign preview → not_found', async () => {
    const rack = mkRack();
    const stale = { ...preview(rack), createdAt: new Date(Date.now() - 16 * 60 * 1000) };
    McpActionLog.findOne.mockReturnValue(chain(stale));
    let res = await tool('auto_arrange').handler({ mode: 'apply', preview_id: oid('f') }, CTX);
    expect(parse(res).error.code).toBe('conflict');

    McpActionLog.findOne.mockReturnValue(chain(null));
    res = await tool('auto_arrange').handler({ mode: 'apply', preview_id: oid('f') }, CTX);
    expect(parse(res).error.code).toBe('not_found');
  });

  test('concurrent apply: losing the claim aborts before any save', async () => {
    const rack = mkRack();
    McpActionLog.findOne.mockReturnValue(chain(preview(rack)));
    McpActionLog.findOneAndUpdate.mockResolvedValue(null); // the twin won
    wireRackLoad(rack);
    const res = await tool('auto_arrange').handler({ mode: 'apply', preview_id: oid('f') }, CTX);
    expect(parse(res).error.code).toBe('conflict');
    expect(rack.save).not.toHaveBeenCalled();
  });

  test('VersionError on save → clean conflict (optimistic concurrency)', async () => {
    const rack = mkRack();
    rack.save.mockRejectedValue(Object.assign(new Error('v'), { name: 'VersionError' }));
    McpActionLog.findOne.mockReturnValue(chain(preview(rack)));
    wireRackLoad(rack);
    const res = await tool('auto_arrange').handler({ mode: 'apply', preview_id: oid('f') }, CTX);
    expect(parse(res).error.code).toBe('conflict');
  });
});

describe('auto_arrange undo (structuralUndo branch)', () => {
  const { undoStructural } = require('./structuralUndo');
  const H = { ok: (s, d) => ({ ok: true, summary: s, data: d }), fail: (c, m) => ({ ok: false, code: c, message: m }), logAction: jest.fn() };
  const row = (rack) => ({
    _id: new mongoose.Types.ObjectId(oid('f')),
    action: 'arrange',
    cellar: rack.cellar,
    detail: { rackId: String(rack._id), target: [{ position: 1, bottleId: oid('2') }, { position: 2, bottleId: oid('1') }] },
    prev: { before: [{ position: 1, bottleId: oid('1') }, { position: 2, bottleId: oid('2') }] },
  });

  test('restores the before-layout while the rack still matches the applied target', async () => {
    const rack = mkRack();
    rack.slots = [ // currently in APPLIED (target) state
      { position: 1, bottle: new mongoose.Types.ObjectId(oid('2')) },
      { position: 2, bottle: new mongoose.Types.ObjectId(oid('1')) },
    ];
    Rack.findOne.mockReturnValue(chain(rack));
    Cellar.findById.mockReturnValue(chain({ _id: rack.cellar, user: ME, members: [], deletedAt: null }));
    const res = await undoStructural(row(rack), { user: { id: ME }, scopes: ['write'], req: {} }, H);
    expect(res.ok).toBe(true);
    expect(rack.slots.map((s) => String(s.bottle))).toEqual([oid('1'), oid('2')]);
    expect(rack.save).toHaveBeenCalledTimes(1);
  });

  test('rack changed after the arrangement → conflict, no restore', async () => {
    const rack = mkRack();
    rack.slots = [{ position: 1, bottle: new mongoose.Types.ObjectId(oid('2')) }]; // a bottle was removed since
    Rack.findOne.mockReturnValue(chain(rack));
    Cellar.findById.mockReturnValue(chain({ _id: rack.cellar, user: ME, members: [], deletedAt: null }));
    const res = await undoStructural(row(rack), { user: { id: ME }, scopes: ['write'], req: {} }, H);
    expect(res).toMatchObject({ ok: false, code: 'conflict' });
    expect(rack.save).not.toHaveBeenCalled();
    expect(McpActionLog.findOneAndUpdate).not.toHaveBeenCalled(); // no claim burned
  });
});

describe('capture_tasting_note', () => {
  const ownBottle = (over = {}) => {
    const b = {
      _id: new mongoose.Types.ObjectId(oid('d')),
      cellar: new mongoose.Types.ObjectId(oid('c')),
      status: 'active', vintage: '2015', rating: 3, ratingScale: '5',
      save: jest.fn().mockResolvedValue({}),
      ...over,
    };
    Bottle.findById.mockReturnValue(chain(b));
    Cellar.findById.mockReturnValue(chain({ _id: b.cellar, user: ME, members: [], deletedAt: null }));
    // journalOps.validatePairingRefs re-verifies the pairing bottle ref (the
    // SAME pipeline the REST journal route runs) — let it find an owned bottle.
    Bottle.find.mockReturnValue(chain([{ _id: b._id, user: ME, cellar: { user: ME, members: [], deletedAt: null } }]));
    return b;
  };

  test('active bottle: rating via updateBottleFields, private entry with the bottle pairing, prev snapshot', async () => {
    const b = ownBottle();
    bottleOps.updateBottleFields.mockResolvedValue({ changes: { rating: 4 }, prev: { rating: 3 } });
    JournalEntry.create.mockResolvedValue({ _id: new mongoose.Types.ObjectId(oid('9')), visibility: 'private', people: [] });

    const res = await tool('capture_tasting_note').handler(
      { bottle_id: oid('d'), note: '<b>Cherries</b> and tar', rating: 4, rating_scale: '5', dish: 'brasato' }, CTX);
    const body = parse(res);
    expect(body.error).toBeUndefined();
    expect(bottleOps.updateBottleFields).toHaveBeenCalledWith(b, { rating: 4, ratingScale: '5' }, CTX.req);
    const entry = JournalEntry.create.mock.calls[0][0];
    expect(entry.visibility).toBe('private');
    expect(entry.people).toBeUndefined(); // never sent — no tagging over MCP
    expect(entry.notes).toBe('Cherries and tar'); // HTML stripped (journalOps pipeline)
    expect(entry.pairings[0]).toMatchObject({ bottle: String(b._id), dish: 'brasato' });
    const row = McpActionLog.create.mock.calls[0][0];
    expect(row.action).toBe('tasting_note');
    expect(row.prev).toMatchObject({ field: 'rating', rating: 3, ratingScale: '5' });
  });

  test('rating with NO scale on a 100-scale bottle stores the RESOLVED default (4/5), never 4/100 (audit M1)', async () => {
    const b = ownBottle({ rating: 92, ratingScale: '100' });
    bottleOps.updateBottleFields.mockResolvedValue({ changes: { rating: 4 }, prev: { rating: 92 } });
    JournalEntry.create.mockResolvedValue({ _id: new mongoose.Types.ObjectId(oid('9')), visibility: 'private' });

    const res = await tool('capture_tasting_note').handler({ bottle_id: oid('d'), note: 'x', rating: 4 }, CTX);
    expect(parse(res).error).toBeUndefined();
    // The resolved value+scale must be written — updateBottleFields would
    // otherwise default the missing scale to the bottle's CURRENT ('100'),
    // storing 4/100 while the envelope/ledger report 4/5.
    expect(bottleOps.updateBottleFields).toHaveBeenCalledWith(b, { rating: 4, ratingScale: '5' }, CTX.req);
    expect(parse(res).data.rating_recorded).toMatchObject({ value: 4, scale: '5' });
  });

  test('rating failure after the entry is created compensates by deleting the entry (all-or-nothing)', async () => {
    ownBottle();
    JournalEntry.create.mockResolvedValue({ _id: new mongoose.Types.ObjectId(oid('9')), visibility: 'private' });
    JournalEntry.findOneAndDelete.mockResolvedValue({ _id: oid('9') });
    bottleOps.updateBottleFields.mockResolvedValue({ error: { status: 400, message: 'nope' } });

    const res = await tool('capture_tasting_note').handler(
      { bottle_id: oid('d'), note: 'x', rating: 4 }, CTX);
    expect(parse(res).error.code).toBe('invalid_input');
    expect(JournalEntry.findOneAndDelete).toHaveBeenCalledWith(
      { _id: expect.anything(), user: ME });
    expect(McpActionLog.create).not.toHaveBeenCalled(); // no ledger row for a rolled-back action
  });

  test('consumed bottle: rating lands on consumedRating with its own prev snapshot', async () => {
    const b = ownBottle({ status: 'drank', consumedRating: null, consumedRatingScale: null });
    JournalEntry.create.mockResolvedValue({ _id: new mongoose.Types.ObjectId(oid('9')) });
    const res = await tool('capture_tasting_note').handler({ bottle_id: oid('d'), note: 'verdict: superb', rating: 5 }, CTX);
    expect(parse(res).error).toBeUndefined();
    expect(b.consumedRating).toBe(5);
    expect(b.save).toHaveBeenCalled();
    expect(bottleOps.updateBottleFields).not.toHaveBeenCalled();
    expect(McpActionLog.create.mock.calls[0][0].prev.field).toBe('consumedRating');
  });

  test('invalid rating → invalid_input BEFORE any write', async () => {
    ownBottle();
    const res = await tool('capture_tasting_note').handler({ bottle_id: oid('d'), note: 'x', rating: 9, rating_scale: '5' }, CTX);
    expect(parse(res).error.code).toBe('invalid_input');
    expect(JournalEntry.create).not.toHaveBeenCalled();
    expect(bottleOps.updateBottleFields).not.toHaveBeenCalled();
  });

  test('note that is empty after HTML stripping → invalid_input', async () => {
    ownBottle();
    const res = await tool('capture_tasting_note').handler({ bottle_id: oid('d'), note: '<p> <br/> </p>' }, CTX);
    expect(parse(res).error.code).toBe('invalid_input');
    expect(JournalEntry.create).not.toHaveBeenCalled();
  });

  test('future date → invalid_input; foreign bottle → not_found; replay short-circuits', async () => {
    ownBottle();
    let res = await tool('capture_tasting_note').handler(
      { bottle_id: oid('d'), note: 'x', date: new Date(Date.now() + 3 * 86400000).toISOString() }, CTX);
    expect(parse(res).error.code).toBe('invalid_input');

    Bottle.findById.mockReturnValue(chain(null));
    res = await tool('capture_tasting_note').handler({ bottle_id: oid('9'), note: 'x' }, CTX);
    expect(parse(res).error.code).toBe('not_found');

    McpActionLog.findOne.mockReturnValue(chain({ result: { summary: 'seen', data: {} } }));
    res = await tool('capture_tasting_note').handler({ bottle_id: oid('d'), note: 'x', idempotency_key: 'k1' }, CTX);
    expect(parse(res).summary).toBe('seen');
    expect(JournalEntry.create).not.toHaveBeenCalled();
  });
});
