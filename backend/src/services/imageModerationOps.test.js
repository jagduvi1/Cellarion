/**
 * services/imageModerationOps — the photo decisions shared by the admin image
 * queue and the sommelier's MCP tools.
 *
 * The admin page's own behaviour is pinned by routes/admin/images.*.test.js
 * (which now run through this module). This suite pins what the MCP surface
 * added on top:
 *   - `official: false` never makes a photo the wine's picture, even when the
 *     wine has none — a back label published first must not become the picture;
 *   - `official: true` on a wine that already has a picture is refused BEFORE
 *     anything is written, unless replaceMain;
 *   - a reject reason reaches the uploader, and a too-long one writes nothing;
 *   - answering a report clears its flag but keeps the reports;
 *   - an MCP call is marked `via: 'mcp'` in the audit row, a web call is not.
 */

jest.mock('../models/BottleImage', () => ({ findById: jest.fn(), updateMany: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn(), findByIdAndUpdate: jest.fn() }));
jest.mock('../models/Bottle', () => ({ findById: jest.fn(), updateMany: jest.fn() }));
jest.mock('./search', () => ({ indexWine: jest.fn() }));
jest.mock('./imageProcessor', () => ({
  unlinkImageFiles: jest.fn().mockResolvedValue(undefined),
  discardOriginal: jest.fn().mockResolvedValue(undefined),
  processImage: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));
jest.mock('./notifications', () => ({ createNotification: jest.fn() }));
jest.mock('../utils/cellarCred', () => ({ incrementCred: jest.fn().mockResolvedValue(undefined) }));

const BottleImage = require('../models/BottleImage');
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const { logAudit } = require('./audit');
const { createNotification } = require('./notifications');
const { unlinkImageFiles } = require('./imageProcessor');
const ops = require('./imageModerationOps');

const IMAGE_ID = '64b0000000000000000000e1';
const BOTTLE_ID = '64b0000000000000000000b1';
const WINE_ID = '64b0000000000000000000f1';
const ACTOR = '64b000000000000000000001';
const UPLOADER = '64b000000000000000000002';
const PROC = '/api/uploads/processed/front.webp';
const OTHER = '/api/uploads/processed/current.webp';

const makeImage = (overrides = {}) => ({
  _id: IMAGE_ID,
  kind: 'bottle',
  status: 'processed',
  visibility: 'public',
  bottle: BOTTLE_ID,
  wineDefinition: null,
  assignedToWine: false,
  keepBackground: false,
  processedUrl: PROC,
  originalUrl: null,
  credit: null,
  reportedAt: null,
  reports: [],
  uploadedBy: UPLOADER,
  save: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

const bottleOfWine = () => Bottle.findById.mockReturnValue({
  select: () => ({ lean: () => Promise.resolve({ _id: BOTTLE_ID, wineDefinition: WINE_ID }) }),
});
const wineWithPicture = (image) => ({ _id: WINE_ID, name: 'Riesling', producer: 'Weingut X', image });

beforeEach(() => {
  jest.clearAllMocks();
  BottleImage.updateMany.mockResolvedValue({});
  WineDefinition.findByIdAndUpdate.mockResolvedValue({});
  Bottle.updateMany.mockResolvedValue({});
});

describe('approveImage — which photo becomes the wine\'s picture', () => {
  test('official:false publishes the photo but never makes it the picture, even on a wine with none', async () => {
    const image = makeImage();
    BottleImage.findById.mockResolvedValue(image);
    bottleOfWine();
    WineDefinition.findById.mockResolvedValue(wineWithPicture(null));

    const r = await ops.approveImage({ imageId: IMAGE_ID, actorId: ACTOR, visibility: 'public', official: false, via: 'mcp' });

    expect(r.ok).toBe(true);
    expect(r.madeOfficial).toBe(false);
    expect(image.status).toBe('approved');
    expect(image.wineDefinition).toBe(WINE_ID);
    expect(image.assignedToWine).toBe(false);
    expect(WineDefinition.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(undefined, 'admin.image.approve', { type: 'image', id: IMAGE_ID },
      expect.objectContaining({ visibility: 'public', official: false, via: 'mcp' }));
  });

  test('official:"auto" (the admin page) keeps its rule: the picture when the wine has none, and no via in the audit', async () => {
    const image = makeImage();
    BottleImage.findById.mockResolvedValue(image);
    bottleOfWine();
    WineDefinition.findById.mockResolvedValue(wineWithPicture(null));

    const r = await ops.approveImage({ imageId: IMAGE_ID, actorId: ACTOR, visibility: 'public', official: 'auto' });

    expect(r.madeOfficial).toBe(true);
    expect(image.assignedToWine).toBe(true);
    expect(WineDefinition.findByIdAndUpdate).toHaveBeenCalledWith(WINE_ID, { image: PROC, imageCredit: null, updatedAt: expect.any(Date) });
    const detail = logAudit.mock.calls[0][3];
    expect(detail).not.toHaveProperty('via');
    expect(detail).not.toHaveProperty('official');
  });

  test('official:true on a wine that already has a picture is refused and NOTHING is written', async () => {
    const image = makeImage();
    BottleImage.findById.mockResolvedValue(image);
    bottleOfWine();
    WineDefinition.findById.mockResolvedValue(wineWithPicture(OTHER));

    const r = await ops.approveImage({ imageId: IMAGE_ID, actorId: ACTOR, visibility: 'public', official: true, via: 'mcp' });

    expect(r).toMatchObject({ ok: false, code: 'conflict', currentPicture: OTHER });
    expect(image.save).not.toHaveBeenCalled();
    expect(image.status).toBe('processed');
    expect(WineDefinition.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('official:true with replaceMain replaces the picture and says which one it replaced', async () => {
    const image = makeImage();
    BottleImage.findById.mockResolvedValue(image);
    bottleOfWine();
    WineDefinition.findById.mockResolvedValue(wineWithPicture(OTHER));

    const r = await ops.approveImage({ imageId: IMAGE_ID, actorId: ACTOR, visibility: 'public', official: true, replaceMain: true, via: 'mcp' });

    expect(r).toMatchObject({ ok: true, madeOfficial: true, replacedImage: OTHER });
    expect(BottleImage.updateMany).toHaveBeenCalledWith({ wineDefinition: WINE_ID, assignedToWine: true }, { assignedToWine: false });
    expect(image.assignedToWine).toBe(true);
    expect(WineDefinition.findByIdAndUpdate).toHaveBeenCalledWith(WINE_ID, { image: PROC, imageCredit: null, updatedAt: expect.any(Date) });
  });

  test('official:true on a photo with no wine at all is a conflict, nothing written', async () => {
    const image = makeImage({ bottle: null });
    BottleImage.findById.mockResolvedValue(image);

    const r = await ops.approveImage({ imageId: IMAGE_ID, actorId: ACTOR, visibility: 'public', official: true });

    expect(r).toMatchObject({ ok: false, code: 'conflict' });
    expect(image.save).not.toHaveBeenCalled();
  });

  test('a private photo cannot be made the picture', async () => {
    BottleImage.findById.mockResolvedValue(makeImage());
    const r = await ops.approveImage({ imageId: IMAGE_ID, actorId: ACTOR, visibility: 'private', official: true });
    expect(r).toMatchObject({ ok: false, code: 'invalid_input' });
  });
});

describe('rejectImage — the uploader is told why', () => {
  test('the reason reaches the uploader and the audit row; files are deleted', async () => {
    const image = makeImage({ wineDefinition: WINE_ID });
    BottleImage.findById.mockResolvedValue(image);
    WineDefinition.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(wineWithPicture(null)) }) });

    const r = await ops.rejectImage({ imageId: IMAGE_ID, actorId: ACTOR, reason: 'This photo shows a different wine.', via: 'mcp' });

    expect(r.ok).toBe(true);
    expect(image.status).toBe('rejected');
    expect(unlinkImageFiles).toHaveBeenCalledWith(image);
    expect(image.processedUrl).toBeNull();
    expect(createNotification).toHaveBeenCalledWith(UPLOADER, 'image_rejected', 'Image rejected',
      'Your image for "Riesling" by Weingut X was rejected. Reason: This photo shows a different wine.', null);
    expect(logAudit.mock.calls[0][3]).toEqual({ reason: 'This photo shows a different wine.', via: 'mcp' });
  });

  test('a bottle photo names its bottle\'s wine, not "a wine"', async () => {
    BottleImage.findById.mockResolvedValue(makeImage({ wineDefinition: null }));
    bottleOfWine();
    WineDefinition.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(wineWithPicture(null)) }) });

    const r = await ops.rejectImage({ imageId: IMAGE_ID, actorId: ACTOR, reason: 'Wrong wine.' });

    expect(r.wineId).toBe(WINE_ID);
    expect(createNotification.mock.calls[0][3]).toBe('Your image for "Riesling" by Weingut X was rejected. Reason: Wrong wine.');
  });

  test('without a reason the admin page\'s wording is unchanged', async () => {
    BottleImage.findById.mockResolvedValue(makeImage({ wineDefinition: null, bottle: null }));
    await ops.rejectImage({ imageId: IMAGE_ID, actorId: ACTOR });
    expect(createNotification.mock.calls[0][3]).toBe('Your image for a wine was rejected by an admin.');
    expect(logAudit.mock.calls[0][3]).toEqual({});
  });

  test('a reason over the limit is refused before anything is touched', async () => {
    const r = await ops.rejectImage({ imageId: IMAGE_ID, actorId: ACTOR, reason: 'x'.repeat(ops.REJECT_REASON_MAX + 1) });
    expect(r).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(BottleImage.findById).not.toHaveBeenCalled();
    expect(unlinkImageFiles).not.toHaveBeenCalled();
  });
});

describe('reported photos', () => {
  test('dismissImageReport clears the flag but keeps the reports', async () => {
    const reports = [{ reason: 'not-this-wine' }];
    const image = makeImage({ status: 'approved', reportedAt: new Date(), reports });
    BottleImage.findById.mockResolvedValue(image);

    const r = await ops.dismissImageReport({ imageId: IMAGE_ID, actorId: ACTOR, via: 'mcp' });

    expect(r.ok).toBe(true);
    expect(image.reportedAt).toBeNull();
    expect(image.reports).toBe(reports);
    expect(image.reviewedBy).toBe(ACTOR);
    expect(logAudit).toHaveBeenCalledWith(undefined, 'admin.image.reportDismissed', { type: 'image', id: IMAGE_ID }, { reports: 1, via: 'mcp' });
  });

  test('dismissImageReport on a photo with no open report is a conflict', async () => {
    BottleImage.findById.mockResolvedValue(makeImage({ status: 'approved' }));
    const r = await ops.dismissImageReport({ imageId: IMAGE_ID, actorId: ACTOR });
    expect(r).toMatchObject({ ok: false, code: 'conflict' });
  });

  test('setImageVisibility with clearReport answers the report while making the photo private', async () => {
    const image = makeImage({ status: 'approved', wineDefinition: WINE_ID, assignedToWine: true, reportedAt: new Date() });
    BottleImage.findById.mockResolvedValue(image);
    const wine = { ...wineWithPicture(PROC), save: jest.fn().mockResolvedValue(undefined) };
    WineDefinition.findById.mockResolvedValue(wine);

    const r = await ops.setImageVisibility({ imageId: IMAGE_ID, actorId: ACTOR, visibility: 'private', clearReport: true, via: 'mcp' });

    expect(r.ok).toBe(true);
    expect(image.visibility).toBe('private');
    expect(image.assignedToWine).toBe(false);
    expect(wine.image).toBeNull();
    expect(image.reportedAt).toBeNull();
  });
});

describe('setOfficialImage', () => {
  const populatedImage = (overrides = {}) => {
    const image = makeImage({ status: 'approved', bottle: { _id: BOTTLE_ID, wineDefinition: WINE_ID }, ...overrides });
    BottleImage.findById.mockReturnValue({ populate: () => Promise.resolve(image) });
    return image;
  };

  test('replaceMain:false refuses when the wine already shows another picture, nothing written', async () => {
    const image = populatedImage();
    WineDefinition.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ image: OTHER }) }) });

    const r = await ops.setOfficialImage({ imageId: IMAGE_ID, actorId: ACTOR, replaceMain: false, via: 'mcp' });

    expect(r).toMatchObject({ ok: false, code: 'conflict', currentPicture: OTHER });
    expect(image.save).not.toHaveBeenCalled();
    expect(WineDefinition.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  test('the web click (default replaceMain) replaces and reports what it replaced', async () => {
    const image = populatedImage();
    WineDefinition.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ image: OTHER }) }) });

    const r = await ops.setOfficialImage({ imageId: IMAGE_ID, actorId: ACTOR });

    expect(r).toMatchObject({ ok: true, replacedImage: OTHER });
    expect(image.assignedToWine).toBe(true);
    expect(WineDefinition.findByIdAndUpdate).toHaveBeenCalledWith(WINE_ID, { image: PROC, imageCredit: null, updatedAt: expect.any(Date) });
  });
});
