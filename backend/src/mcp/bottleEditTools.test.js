/**
 * change_bottle_wine, delete_bottle, set_bottle_default_image and
 * delete_bottle_image — the bottle-page actions the MCP lacked — and their
 * undo_last reversals.
 *
 * Pins: each tool runs the shared service (the same code as the app) and
 * logs a ledger row whose prev is exactly what the reversal needs; the two
 * destructive tools refuse without confirm:true; delete_bottle is reversible
 * from its snapshot (restored under the same id), change_bottle_wine moves
 * every bottle back to the wine it came from, the default photo choice is
 * restored; delete_bottle_image is never undo-eligible.
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
  find: jest.fn(), findById: jest.fn(), findOne: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn(),
}));
jest.mock('../models/Rack', () => ({ find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn(), updateMany: jest.fn() }));
jest.mock('../models/WishlistItem', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/JournalEntry', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/WineEmbedding', () => ({ findOne: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({
  create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn(() => Promise.resolve({})),
  deleteOne: jest.fn(() => Promise.resolve({})),
}));
jest.mock('../utils/rackGeometry', () => ({ getMaxPosition: jest.fn(() => 12) }));
jest.mock('../services/search', () => ({
  getIsAvailable: jest.fn(() => false), search: jest.fn(), searchBottles: jest.fn(),
}));
jest.mock('../services/statsService', () => ({ computeOverview: jest.fn(), buildEmptyStats: jest.fn() }));
jest.mock('../services/vectorStore', () => ({ getPoints: jest.fn(), searchSimilar: jest.fn() }));
jest.mock('../config/aiConfig', () => ({ get: jest.fn(() => ({ vectorIndex: 'v1' })) }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../services/wineVisibility', () => ({ findVisibleWine: jest.fn(), wineVisibilityFilter: jest.fn(() => ({})) }));
jest.mock('../services/imageOps', () => ({
  ingestBottleImage: jest.fn(), setBottleDefaultImage: jest.fn(), deleteOwnImage: jest.fn(),
}));
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), removeFromRacks: jest.fn(),
  RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  addBottle: jest.fn(), updateBottleFields: jest.fn(), removeBottleCascade: jest.fn(),
  changeBottleWine: jest.fn(), deleteBottleRecoverably: jest.fn(), restoreDeletedBottle: jest.fn(),
  UPDATABLE_FIELDS: ['price', 'currency', 'notes'],
}));
jest.mock('../services/bottleLot', () => ({
  LOT_FIELDS: ['drinkFrom', 'drinkTo', 'peakFrom', 'peakUntil', 'price', 'currency'],
  LOT_FIELDS_ON_REQUEST: ['notes', 'purchaseDate', 'purchaseLocation', 'purchaseUrl'],
  LOT_LIMIT: 500,
  findLotSiblings: jest.fn(),
  pickLotFields: jest.fn(() => ({})),
}));

const mongoose = require('mongoose');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const McpActionLog = require('../models/McpActionLog');
const bottleOps = require('../services/bottleOps');
const imageOps = require('../services/imageOps');
const { findVisibleWine } = require('../services/wineVisibility');
const { findLotSiblings } = require('../services/bottleLot');
const { allTools } = require('./registry');
const { revertLedgerRow, WRITE_REVERSIBLE } = require('./revert');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const REQ = { user: { id: ME, roles: ['user'] }, headers: {}, apiToken: { id: 't1', scopes: ['read', 'write'] } };
const CTX = { user: { id: ME, roles: ['user'] }, scopes: ['read', 'write'], req: REQ };
const HELPERS = {
  ok: (summary, data) => ({ ok: true, summary, data }),
  fail: (code, message) => ({ ok: false, code, message }),
};

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

const WHITE = { _id: oid('e'), producer: 'Domaine X', name: 'Blanc' };
const RED = { _id: oid('f'), producer: 'Domaine X', name: 'Rouge' };

const bottleDoc = (over = {}) => ({
  _id: new mongoose.Types.ObjectId(oid('d')), cellar: new mongoose.Types.ObjectId(oid('c')),
  status: 'active', vintage: '2019', wineDefinition: new mongoose.Types.ObjectId(oid('e')), ...over,
});
const myCellar = () => Cellar.findById.mockReturnValue(chain({ _id: oid('c'), user: ME, members: [], deletedAt: null, name: 'Mine' }));
const primary = (over) => { Bottle.findById.mockReturnValue(chain(bottleDoc(over))); myCellar(); };

beforeEach(() => {
  jest.clearAllMocks();
  McpActionLog.findOne.mockReturnValue(chain(null));
  McpActionLog.create.mockResolvedValue({});
  McpActionLog.findOneAndUpdate.mockResolvedValue({ _id: 'row' });
  findVisibleWine.mockImplementation(async (id) => ({ [oid('e')]: WHITE, [oid('f')]: RED }[String(id)] || null));
});

describe('change_bottle_wine', () => {
  test('moves the bottle through the shared service and records where it came from', async () => {
    primary();
    bottleOps.changeBottleWine.mockResolvedValue({ bottle: {}, from: oid('e') });
    const body = parse(await tool('change_bottle_wine').handler({ bottle_id: oid('d'), wine_id: oid('f') }, CTX));
    expect(bottleOps.changeBottleWine).toHaveBeenCalledWith(expect.objectContaining({ vintage: '2019' }), RED, REQ);
    expect(body.summary).toMatch(/from Domaine X — Blanc to Domaine X — Rouge/);
    const row = McpActionLog.create.mock.calls[0][0];
    expect(row).toMatchObject({ tool: 'change_bottle_wine', action: 'change_wine', prev: { [oid('d')]: oid('e') } });
    expect(row.detail).toMatchObject({ from: oid('e'), to: oid('f'), bottles: 1 });
  });

  test('apply_to_lot moves the old wine\'s lot too, each recorded for the undo', async () => {
    primary();
    findLotSiblings.mockResolvedValue([bottleDoc({ _id: oid('1') }), bottleDoc({ _id: oid('2') })]);
    bottleOps.changeBottleWine
      .mockResolvedValueOnce({ bottle: {}, from: oid('e') })
      .mockResolvedValueOnce({ bottle: {}, from: oid('e') })
      .mockResolvedValueOnce({ error: { status: 409, message: 'modified' } });
    const body = parse(await tool('change_bottle_wine').handler({ bottle_id: oid('d'), wine_id: oid('f'), apply_to_lot: true }, CTX));
    expect(body.data.lot).toEqual({ count: 2, moved: [oid('1')] });
    expect(McpActionLog.create.mock.calls[0][0].prev).toEqual({ [oid('d')]: oid('e'), [oid('1')]: oid('e') });
  });

  test('a wine the caller cannot see is not_found; the same wine is invalid_input; nothing is logged', async () => {
    primary();
    const hidden = await tool('change_bottle_wine').handler({ bottle_id: oid('d'), wine_id: oid('9') }, CTX);
    expect(hidden.isError).toBe(true);
    expect(parse(hidden).error.code).toBe('not_found');
    bottleOps.changeBottleWine.mockResolvedValue({ error: { status: 400, code: 'same_wine', message: 'The bottle is already this wine' } });
    const same = parse(await tool('change_bottle_wine').handler({ bottle_id: oid('d'), wine_id: oid('e') }, CTX));
    expect(same.error.code).toBe('invalid_input');
    expect(McpActionLog.create).not.toHaveBeenCalled();
  });
});

describe('delete_bottle', () => {
  test('refuses without confirm:true and touches nothing', async () => {
    primary();
    const res = await tool('delete_bottle').handler({ bottle_id: oid('d'), confirm: false }, CTX);
    expect(parse(res).error.code).toBe('invalid_input');
    expect(bottleOps.deleteBottleRecoverably).not.toHaveBeenCalled();
    expect(McpActionLog.create).not.toHaveBeenCalled();
  });

  test('deletes through the recoverable service and keeps the snapshot as prev', async () => {
    primary();
    const snapshot = { bottle: { _id: oid('d'), cellar: oid('c') }, rack: { rackId: oid('7'), position: 4 }, registryPhotoIds: [], wineRequest: null };
    bottleOps.deleteBottleRecoverably.mockResolvedValue({ snapshot, ownPhotosDeleted: 2 });
    const body = parse(await tool('delete_bottle').handler({ bottle_id: oid('d'), confirm: true }, CTX));
    expect(bottleOps.deleteBottleRecoverably).toHaveBeenCalledWith(expect.objectContaining({ vintage: '2019' }), REQ, { via: 'mcp' });
    expect(body.summary).toMatch(/Deleted bottle .* \(Domaine X — Blanc 2019\) from "Mine"; its 2 own photo\(s\) were deleted permanently/);
    expect(body.data).toMatchObject({ rack_slot_freed: 4, own_photos_deleted: 2, status_was: 'active' });
    const row = McpActionLog.create.mock.calls[0][0];
    expect(row).toMatchObject({ tool: 'delete_bottle', action: 'delete', prev: snapshot });
    expect(row.detail).toMatchObject({ own_photos_deleted: 2, status: 'active' });
  });
});

describe('set_bottle_default_image / delete_bottle_image', () => {
  test('the default photo choice is set through imageOps and the previous one kept for undo', async () => {
    primary();
    imageOps.setBottleDefaultImage.mockImplementation(async (b, id) => { b.defaultImage = id; return { bottle: b, prev: oid('3') }; });
    const body = parse(await tool('set_bottle_default_image').handler({ bottle_id: oid('d'), image_id: oid('4') }, CTX));
    expect(body.data).toMatchObject({ default_image_id: oid('4'), previous_image_id: oid('3') });
    expect(McpActionLog.create.mock.calls[0][0]).toMatchObject({ action: 'default_image', prev: { defaultImage: oid('3') } });
  });

  test('a photo that is not the bottle\'s is not_found', async () => {
    primary();
    imageOps.setBottleDefaultImage.mockResolvedValue({ error: { status: 404, message: 'Image not found or not associated with this bottle' } });
    expect(parse(await tool('set_bottle_default_image').handler({ bottle_id: oid('d'), image_id: oid('4') }, CTX)).error.code).toBe('not_found');
  });

  test('delete_bottle_image needs confirm:true, then deletes the caller\'s own photo; it is never undo-eligible', async () => {
    const refused = await tool('delete_bottle_image').handler({ image_id: oid('4'), confirm: false }, CTX);
    expect(parse(refused).error.code).toBe('invalid_input');
    expect(imageOps.deleteOwnImage).not.toHaveBeenCalled();

    imageOps.deleteOwnImage.mockResolvedValue({ image: { _id: oid('4'), bottle: oid('d'), wineDefinition: oid('e') } });
    const body = parse(await tool('delete_bottle_image').handler({ image_id: oid('4'), confirm: true }, CTX));
    expect(imageOps.deleteOwnImage).toHaveBeenCalledWith(oid('4'), ME, REQ);
    expect(body.summary).toBe(`Deleted photo ${oid('4')}`);
    expect(McpActionLog.create.mock.calls[0][0]).toMatchObject({ action: 'delete_image', detail: { imageId: oid('4') } });
    expect(WRITE_REVERSIBLE).not.toContain('delete_image');
  });

  test('a registry picture is refused as a conflict', async () => {
    imageOps.deleteOwnImage.mockResolvedValue({ error: { status: 409, code: 'assigned_to_wine', message: 'This photo is being used as the wine\'s picture' } });
    expect(parse(await tool('delete_bottle_image').handler({ image_id: oid('4'), confirm: true }, CTX)).error.code).toBe('conflict');
  });
});

describe('undo_last reversals', () => {
  test('delete: restored from the snapshot, access checked on the cellar', async () => {
    myCellar();
    bottleOps.restoreDeletedBottle.mockResolvedValue({ bottle: { _id: oid('d'), vintage: '2019', status: 'active', cellar: oid('c') }, placed: true, position: 4 });
    const snapshot = { bottle: { _id: oid('d'), cellar: oid('c') }, rack: { rackId: oid('7'), position: 4 } };
    const res = await revertLedgerRow({ _id: 'row', action: 'delete', prev: snapshot, detail: { own_photos_deleted: 1 } }, CTX, HELPERS);
    expect(res.ok).toBe(true);
    expect(bottleOps.restoreDeletedBottle).toHaveBeenCalledWith(snapshot, REQ);
    expect(res.summary).toMatch(/is back in its rack slot 4; its 1 own photo\(s\) could not be restored/);
  });

  test('delete: a refused restore releases the claim and changes nothing', async () => {
    myCellar();
    bottleOps.restoreDeletedBottle.mockResolvedValue({ error: { status: 409, message: 'Its wine has been merged or removed from the registry since' } });
    const res = await revertLedgerRow({ _id: 'row', action: 'delete', prev: { bottle: { _id: oid('d'), cellar: oid('c') } } }, CTX, HELPERS);
    expect(res).toMatchObject({ ok: false, code: 'conflict' });
    expect(McpActionLog.updateOne).toHaveBeenCalledWith({ _id: 'row' }, { $set: { reversed: false } });
  });

  test('change_wine: every moved bottle goes back to the wine it came from', async () => {
    primary({ wineDefinition: new mongoose.Types.ObjectId(oid('f')) });
    bottleOps.changeBottleWine.mockResolvedValue({ bottle: {} });
    const res = await revertLedgerRow({ _id: 'row', action: 'change_wine', prev: { [oid('d')]: oid('e') } }, CTX, HELPERS);
    expect(res.ok).toBe(true);
    expect(bottleOps.changeBottleWine).toHaveBeenCalledWith(expect.anything(), WHITE, REQ);
    expect(res.data.restored).toEqual([oid('d')]);
  });

  test('change_wine: a bottle that had no wine before cannot be moved back', async () => {
    const res = await revertLedgerRow({ _id: 'row', action: 'change_wine', prev: { [oid('d')]: null } }, CTX, HELPERS);
    expect(res).toMatchObject({ ok: false, code: 'conflict' });
    expect(bottleOps.changeBottleWine).not.toHaveBeenCalled();
  });

  test('default_image: the previous choice comes back', async () => {
    primary();
    imageOps.setBottleDefaultImage.mockResolvedValue({ bottle: {}, prev: oid('4') });
    const res = await revertLedgerRow({ _id: 'row', action: 'default_image', bottle: oid('d'), prev: { defaultImage: oid('3') } }, CTX, HELPERS);
    expect(res.ok).toBe(true);
    expect(imageOps.setBottleDefaultImage).toHaveBeenCalledWith(expect.anything(), oid('3'));
  });

  test('the three reversible actions are undo-eligible for a write connection', () => {
    expect(WRITE_REVERSIBLE).toEqual(expect.arrayContaining(['delete', 'change_wine', 'default_image']));
  });
});
