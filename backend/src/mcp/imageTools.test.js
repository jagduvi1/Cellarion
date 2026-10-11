/**
 * attach_bottle_image (plan §3.18) — the tool a real user hit as a gap.
 *
 * Pins: write scope + honest annotations, the URL/base64 XOR, access
 * re-check, delegation to the SHARED services/imageOps pipeline (so an
 * EXIF-laden or malformed image is rejected identically to the web upload),
 * the SSRF guard on image_url, the ledger row, idempotency replay, and the
 * undo branch (deletes only the caller's own, un-assigned image).
 */

const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

jest.mock('../models/Cellar', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), findById: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn(), distinct: jest.fn() }));
jest.mock('../models/BottleImage', () => ({ countDocuments: jest.fn().mockResolvedValue(0), find: jest.fn(), findOne: jest.fn(), deleteOne: jest.fn() }));
jest.mock('../models/Rack', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/WishlistItem', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/JournalEntry', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/WineEmbedding', () => ({ findOne: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../services/search', () => ({ getIsAvailable: jest.fn(() => false), search: jest.fn(), searchBottles: jest.fn() }));
jest.mock('../services/statsService', () => ({ computeOverview: jest.fn(), buildEmptyStats: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('./mutationBudget', () => ({ takeMutationSlot: jest.fn(() => true), WRITE_WINDOW_MS: 900000 }));
jest.mock('../services/imageOps', () => ({ ingestBottleImage: jest.fn() }));
jest.mock('../utils/safeImageFetch', () => ({ safeFetchImage: jest.fn() }));
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), addBottle: jest.fn(), updateBottleFields: jest.fn(),
  removeBottleCascade: jest.fn(), RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  UPDATABLE_FIELDS: ['price', 'currency', 'notes', 'occasion', 'rating', 'ratingScale', 'drinkFrom', 'drinkTo'],
}));

const mongoose = require('mongoose');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const McpActionLog = require('../models/McpActionLog');
const { ingestBottleImage } = require('../services/imageOps');
const { safeFetchImage } = require('../utils/safeImageFetch');
const { allTools, toolsForScopes } = require('./registry');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const CTX = { user: { id: ME }, scopes: ['write'], req: { user: { id: ME }, headers: {} } };
const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

const ownBottle = (over = {}) => {
  const b = { _id: new mongoose.Types.ObjectId(oid('d')), cellar: new mongoose.Types.ObjectId(oid('c')), vintage: '2015', status: 'active', ...over };
  Bottle.findById.mockReturnValue(chain(b));
  Cellar.findById.mockReturnValue(chain({ _id: b.cellar, user: ME, members: [], deletedAt: null }));
  return b;
};

beforeEach(() => {
  jest.clearAllMocks();
  McpActionLog.findOne.mockReturnValue(chain(null));
  McpActionLog.create.mockResolvedValue({ _id: new mongoose.Types.ObjectId(oid('e')) });
  McpActionLog.findOneAndUpdate.mockResolvedValue({ _id: 'claimed' });
  ingestBottleImage.mockResolvedValue({ image: { _id: new mongoose.Types.ObjectId(oid('9')), status: 'uploaded' } });
});

describe('registration', () => {
  test('write-scoped mutation, invisible to read tokens', () => {
    expect(tool('attach_bottle_image').scope).toBe('write');
    expect(tool('attach_bottle_image').annotations.readOnlyHint).toBe(false);
    expect(toolsForScopes(['read'], ['user']).map((t) => t.name)).not.toContain('attach_bottle_image');
  });
});

describe('attach_bottle_image', () => {
  test('image_url path: SSRF-guarded fetch → shared pipeline WITH the wine linkage → ledger row', async () => {
    ownBottle({ wineDefinition: new mongoose.Types.ObjectId(oid('f')) });
    safeFetchImage.mockResolvedValue({ buffer: Buffer.from('imgbytes'), contentType: 'image/jpeg' });
    const res = await tool('attach_bottle_image').handler({ bottle_id: oid('d'), image_url: 'https://cdn.example.com/label.jpg' }, CTX);
    const body = parse(res);
    expect(body.error).toBeUndefined();
    expect(safeFetchImage).toHaveBeenCalledWith('https://cdn.example.com/label.jpg');
    // The bytes go to the SAME pipeline the web upload uses — INCLUDING the
    // wine link, so one photo shows on every bottle of the wine (the launch-day
    // "attached 5 times for 5 identical bottles" report).
    expect(ingestBottleImage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: ME, buffer: expect.any(Buffer), wineDefinitionId: oid('f') }), CTX.req);
    expect(body.data.source).toBe('url');
    expect(body.data.shows_on_all_bottles_of_wine).toBe(true);
    const row = McpActionLog.create.mock.calls[0][0];
    expect(row.action).toBe('attach_image');
    expect(row.detail.imageId).toBeDefined();
  });

  test('photos added through MCP always go through background removal: keep_background is accepted but ignored', async () => {
    ownBottle();
    safeFetchImage.mockResolvedValue({ buffer: Buffer.from('imgbytes'), contentType: 'image/jpeg' });
    // Still accepted (an older caller is not refused) — and still removed.
    await tool('attach_bottle_image').handler({ bottle_id: oid('d'), image_url: 'https://cdn.example.com/label.jpg', keep_background: true }, CTX);
    expect(ingestBottleImage).toHaveBeenCalledWith(expect.objectContaining({ keepBackground: false }), CTX.req);

    ingestBottleImage.mockClear();
    await tool('attach_bottle_image').handler({ bottle_id: oid('d'), image_url: 'https://cdn.example.com/label.jpg' }, CTX);
    expect(ingestBottleImage).toHaveBeenCalledWith(expect.objectContaining({ keepBackground: false }), CTX.req);
  });

  test('label_only keeps the background of a photo of the label alone — background removal would cut its edges away', async () => {
    ownBottle();
    safeFetchImage.mockResolvedValue({ buffer: Buffer.from('imgbytes'), contentType: 'image/jpeg' });
    ingestBottleImage.mockImplementation(async () => ({ image: { _id: oid('9'), status: 'processed', keepBackground: true } }));
    const res = await tool('attach_bottle_image').handler({ bottle_id: oid('d'), image_url: 'https://cdn.example.com/label.jpg', label_only: true }, CTX);
    expect(ingestBottleImage).toHaveBeenCalledWith(expect.objectContaining({ keepBackground: true }), CTX.req);
    const body = parse(res);
    expect(body.data.background_kept).toBe(true);
    expect(body.data.state).toBe('awaiting_review');

    // label_only: false with keep_background: true keeps nothing — and the
    // answer says the background went (a fresh default answer: nothing kept).
    ingestBottleImage.mockReset();
    ingestBottleImage.mockResolvedValue({ image: { _id: oid('9'), status: 'uploaded' } });
    const res2 = await tool('attach_bottle_image').handler({ bottle_id: oid('d'), image_url: 'https://cdn.example.com/label.jpg', label_only: false, keep_background: true }, CTX);
    expect(ingestBottleImage).toHaveBeenCalledWith(expect.objectContaining({ keepBackground: false }), CTX.req);
    expect(parse(res2).data.background_kept).toBe(false);
    expect(parse(res2).data.state).toBe('queued');
  });

  test('a picture shaped like a whole bottle is cut out even with label_only, and the answer says why', async () => {
    const sharp = require('sharp');
    ownBottle();
    const picture = (width, height) => sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    // A retailer's bottle shot: 300×900.
    safeFetchImage.mockResolvedValue({ buffer: await picture(300, 900), contentType: 'image/jpeg' });
    const res = await tool('attach_bottle_image').handler({ bottle_id: oid('d'), image_url: 'https://shop.example.com/bottle.jpg', label_only: true }, CTX);
    expect(ingestBottleImage).toHaveBeenCalledWith(expect.objectContaining({ keepBackground: false }), CTX.req);
    expect(parse(res).warnings.join(' ')).toMatch(/tall and narrow like a whole bottle/);

    // A rectified label, 1000×1230: kept.
    ingestBottleImage.mockClear();
    const label = (await picture(1000, 1230)).toString('base64');
    const res2 = await tool('attach_bottle_image').handler({ bottle_id: oid('d'), image_base64: label, label_only: true }, CTX);
    expect(ingestBottleImage).toHaveBeenCalledWith(expect.objectContaining({ keepBackground: true }), CTX.req);
    expect(parse(res2).warnings || []).toEqual([]);
  });

  test('a caller that still sends keep_background is told it is ignored and what to use instead', async () => {
    ownBottle();
    safeFetchImage.mockResolvedValue({ buffer: Buffer.from('imgbytes'), contentType: 'image/jpeg' });
    const res = await tool('attach_bottle_image').handler({ bottle_id: oid('d'), image_url: 'https://cdn.example.com/label.jpg', keep_background: true }, CTX);
    expect(parse(res).warnings.join(' ')).toMatch(/keep_background is ignored.*label_only: true/);
  });

  test('the tool says which photos label_only is for, so a client does not find out by trial', () => {
    const t = tool('attach_bottle_image');
    expect(t.description).toMatch(/label_only/);
    // Clients that turn MCP tools into function definitions cut at 1024.
    expect(t.description.length).toBeLessThanOrEqual(1024);
    const schema = t.inputSchema;
    expect(schema.label_only.description).toMatch(/label alone/i);
    expect(schema.label_only.description).toMatch(/never set it for a retailer product image or any photo with the bottle in it/i);
    expect(schema.keep_background.description).toMatch(/label_only/);
  });

  test('a bottle with no registry wine yet attaches bottle-only (no wine linkage)', async () => {
    ownBottle(); // pending-wine-request bottles have no wineDefinition
    safeFetchImage.mockResolvedValue({ buffer: Buffer.from('imgbytes'), contentType: 'image/jpeg' });
    const res = await tool('attach_bottle_image').handler({ bottle_id: oid('d'), image_url: 'https://cdn.example.com/label.jpg' }, CTX);
    expect(parse(res).error).toBeUndefined();
    expect(ingestBottleImage).toHaveBeenCalledWith(
      expect.objectContaining({ wineDefinitionId: null }), CTX.req);
    expect(parse(res).data.shows_on_all_bottles_of_wine).toBe(false);
  });

  test('credit + roles are forwarded RAW to the shared pipeline — the admin gate lives there, not here', async () => {
    ownBottle();
    safeFetchImage.mockResolvedValue({ buffer: Buffer.from('imgbytes'), contentType: 'image/jpeg' });
    const roleCtx = { ...CTX, user: { id: ME, roles: ['user'] } };
    const res = await tool('attach_bottle_image').handler(
      { bottle_id: oid('d'), image_url: 'https://cdn.example.com/label.jpg', credit: 'Photo: somewhere' }, roleCtx);
    expect(parse(res).error).toBeUndefined();
    expect(ingestBottleImage).toHaveBeenCalledWith(
      expect.objectContaining({ credit: 'Photo: somewhere', userRoles: ['user'] }), roleCtx.req);
  });

  test('image_base64 path: strips a data: prefix and decodes', async () => {
    ownBottle();
    const b64 = Buffer.from('hello-png').toString('base64');
    const res = await tool('attach_bottle_image').handler({ bottle_id: oid('d'), image_base64: `data:image/png;base64,${b64}` }, CTX);
    expect(parse(res).error).toBeUndefined();
    const passed = ingestBottleImage.mock.calls[0][0].buffer;
    expect(passed.toString()).toBe('hello-png');
    expect(safeFetchImage).not.toHaveBeenCalled();
    expect(parse(res).data.source).toBe('upload');
  });

  test('neither / both inputs → invalid_input before any access or fetch', async () => {
    let res = await tool('attach_bottle_image').handler({ bottle_id: oid('d') }, CTX);
    expect(parse(res).error.code).toBe('invalid_input');
    res = await tool('attach_bottle_image').handler({ bottle_id: oid('d'), image_url: 'https://x/y.jpg', image_base64: 'aaa' }, CTX);
    expect(parse(res).error.code).toBe('invalid_input');
    expect(Bottle.findById).not.toHaveBeenCalled();
  });

  test('foreign bottle → not_found; a rejected fetch → invalid_input with the guard message', async () => {
    Bottle.findById.mockReturnValue(chain(null));
    let res = await tool('attach_bottle_image').handler({ bottle_id: oid('9'), image_url: 'https://x/y.jpg' }, CTX);
    expect(parse(res).error.code).toBe('not_found');

    ownBottle();
    safeFetchImage.mockRejectedValue(new Error('URL resolves to a private or reserved address'));
    res = await tool('attach_bottle_image').handler({ bottle_id: oid('d'), image_url: 'https://evil/y.jpg' }, CTX);
    expect(parse(res).error.code).toBe('invalid_input');
    expect(parse(res).error.message).toMatch(/private or reserved/);
    expect(ingestBottleImage).not.toHaveBeenCalled();
  });

  test('pipeline rejection (bad image) surfaces as invalid_input, no ledger row', async () => {
    ownBottle();
    safeFetchImage.mockResolvedValue({ buffer: Buffer.from('x'), contentType: 'image/jpeg' });
    ingestBottleImage.mockResolvedValue({ error: { status: 400, message: 'Image could not be processed' } });
    const res = await tool('attach_bottle_image').handler({ bottle_id: oid('d'), image_url: 'https://x/y.jpg' }, CTX);
    expect(parse(res).error.code).toBe('invalid_input');
    expect(McpActionLog.create).not.toHaveBeenCalled();
  });

  test('idempotency replay short-circuits before fetch/pipeline', async () => {
    // Claim-first replay (prior-audit M2).
    McpActionLog.findOneAndUpdate.mockResolvedValueOnce({
      lastErrorObject: { updatedExisting: true },
      value: { pending: false, result: { summary: 'seen', data: {} } },
    });
    const res = await tool('attach_bottle_image').handler({ bottle_id: oid('d'), image_url: 'https://x/y.jpg', idempotency_key: 'k1' }, CTX);
    expect(parse(res).summary).toBe('seen');
    expect(safeFetchImage).not.toHaveBeenCalled();
    expect(ingestBottleImage).not.toHaveBeenCalled();
  });
});
