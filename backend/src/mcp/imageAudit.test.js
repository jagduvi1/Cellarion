/**
 * The MCP photo tools leave the audit rows to the shared services
 * (services/imageOps), the same code the web routes run — so a photo change
 * writes the same row on both surfaces, exactly once.
 *
 * Pins: attach_bottle_image names its surface ('mcp') to the shared pipeline
 * and writes no attach row of its own; set_bottle_default_image and its
 * undo_last reversal hand the request to the shared service, so the row names
 * the acting member.
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
  find: jest.fn(), findById: jest.fn(), findOne: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn(), exists: jest.fn(),
}));
jest.mock('../models/BottleImage', () => ({ countDocuments: jest.fn(), find: jest.fn(), findOne: jest.fn(), deleteOne: jest.fn() }));
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
jest.mock('../services/search', () => ({ getIsAvailable: jest.fn(() => false), search: jest.fn(), searchBottles: jest.fn() }));
jest.mock('../services/statsService', () => ({ computeOverview: jest.fn(), buildEmptyStats: jest.fn() }));
jest.mock('../services/vectorStore', () => ({ getPoints: jest.fn(), searchSimilar: jest.fn() }));
jest.mock('../config/aiConfig', () => ({ get: jest.fn(() => ({ vectorIndex: 'v1' })) }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('./mutationBudget', () => ({ takeMutationSlot: jest.fn(() => true), WRITE_WINDOW_MS: 900000 }));
jest.mock('../services/imageOps', () => ({
  ingestBottleImage: jest.fn(), setBottleDefaultImage: jest.fn(), deleteOwnImage: jest.fn(),
}));
jest.mock('../utils/safeImageFetch', () => ({ safeFetchImage: jest.fn() }));
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), removeFromRacks: jest.fn(),
  RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  addBottle: jest.fn(), updateBottleFields: jest.fn(), removeBottleCascade: jest.fn(),
  changeBottleWine: jest.fn(), snapshotBottleForDelete: jest.fn(), restoreDeletedBottle: jest.fn(),
  UPDATABLE_FIELDS: ['price', 'currency', 'notes'],
}));

const mongoose = require('mongoose');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const McpActionLog = require('../models/McpActionLog');
const imageOps = require('../services/imageOps');
const { logAudit } = require('../services/audit');
const { allTools } = require('./registry');
const { revertLedgerRow } = require('./revert');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const REQ = { user: { id: ME, roles: ['user'] }, headers: {} };
const CTX = { user: { id: ME, roles: ['user'] }, scopes: ['read', 'write'], req: REQ };
const HELPERS = {
  ok: (summary, data) => ({ ok: true, summary, data }),
  fail: (code, message) => ({ ok: false, code, message }),
};
const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

const myBottle = (over = {}) => {
  const b = {
    _id: new mongoose.Types.ObjectId(oid('d')), cellar: new mongoose.Types.ObjectId(oid('c')),
    status: 'active', vintage: '2019', wineDefinition: null, ...over,
  };
  Bottle.findById.mockReturnValue(chain(b));
  Cellar.findById.mockReturnValue(chain({ _id: oid('c'), user: ME, members: [], deletedAt: null }));
  return b;
};

beforeEach(() => {
  jest.clearAllMocks();
  McpActionLog.findOne.mockReturnValue(chain(null));
  McpActionLog.create.mockResolvedValue({ _id: new mongoose.Types.ObjectId(oid('e')) });
  McpActionLog.findOneAndUpdate.mockResolvedValue({ _id: 'row' });
  BottleImage.countDocuments.mockResolvedValue(0);
  imageOps.ingestBottleImage.mockResolvedValue({ image: { _id: new mongoose.Types.ObjectId(oid('9')), status: 'uploaded' } });
});

describe('attach_bottle_image', () => {
  test('names the MCP surface to the shared pipeline, which writes the attach row — the tool writes none of its own', async () => {
    myBottle();
    const b64 = Buffer.from('jpeg-bytes').toString('base64');
    const body = parse(await tool('attach_bottle_image').handler({ bottle_id: oid('d'), image_base64: b64 }, CTX));
    expect(body.error).toBeUndefined();
    expect(imageOps.ingestBottleImage).toHaveBeenCalledWith(expect.objectContaining({ via: 'mcp' }), REQ);
    expect(logAudit.mock.calls.map((c) => c[1])).not.toContain('image.attach');
  });
});

describe('set_bottle_default_image', () => {
  test('hands the request to the shared service, which audits the choice', async () => {
    const bottle = myBottle();
    imageOps.setBottleDefaultImage.mockImplementation(async (b, id) => { b.defaultImage = id; return { bottle: b, prev: null }; });
    const body = parse(await tool('set_bottle_default_image').handler({ bottle_id: oid('d'), image_id: oid('4') }, CTX));
    expect(body.error).toBeUndefined();
    expect(imageOps.setBottleDefaultImage).toHaveBeenCalledWith(bottle, oid('4'), REQ);
  });

  test('undo_last puts the previous choice back through the same service, with the request', async () => {
    myBottle({ defaultImage: new mongoose.Types.ObjectId(oid('4')) });
    imageOps.setBottleDefaultImage.mockResolvedValue({ bottle: {}, prev: oid('4') });
    const res = await revertLedgerRow(
      { _id: 'row', action: 'default_image', bottle: oid('d'), detail: { imageId: oid('4') }, prev: { defaultImage: oid('3') } },
      CTX, HELPERS);
    expect(res.ok).toBe(true);
    expect(imageOps.setBottleDefaultImage).toHaveBeenCalledWith(expect.anything(), oid('3'), REQ);
  });

  test('an undo whose old photo is gone clears the choice, also with the request', async () => {
    myBottle({ defaultImage: new mongoose.Types.ObjectId(oid('4')) });
    imageOps.setBottleDefaultImage
      .mockResolvedValueOnce({ error: { status: 404, message: 'Image not found or not associated with this bottle' } })
      .mockResolvedValueOnce({ bottle: {}, prev: oid('4') });
    const res = await revertLedgerRow(
      { _id: 'row', action: 'default_image', bottle: oid('d'), detail: { imageId: oid('4') }, prev: { defaultImage: oid('3') } },
      CTX, HELPERS);
    expect(res.ok).toBe(true);
    expect(imageOps.setBottleDefaultImage).toHaveBeenLastCalledWith(expect.anything(), null, REQ);
  });
});
