/**
 * scripts/convert-inline-wine-images: wine pictures stored inline become files.
 *
 * WHY THIS TEST EXISTS:
 * Until 2026-09-06 an approved wine request copied its photo into the wine
 * record as a data: URI. This one-off moves those into files through the same
 * path an approval now uses (attachOfficialWineImage). It must change nothing
 * without --apply, keep a background-removed PNG as it is, record the approving
 * admin, move updatedAt (so Bridge installs pick the picture up), and leave a
 * wine alone when its value is unreadable or the conversion fails.
 */

jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), updateOne: jest.fn(async () => ({})) }));
jest.mock('../models/Bottle', () => ({ countDocuments: jest.fn(async () => 2) }));
jest.mock('../models/Country', () => ({}));
jest.mock('../models/Region', () => ({}));
jest.mock('../models/Grape', () => ({}));
jest.mock('../services/imageOps', () => ({
  ...jest.requireActual('../services/imageOps'),
  attachOfficialWineImage: jest.fn(),
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));

const WineDefinition = require('../models/WineDefinition');
const { attachOfficialWineImage } = require('../services/imageOps');
const { logAudit } = require('../services/audit');
const { convertInlineWineImages } = require('./convert-inline-wine-images');

// Real magic bytes, so the format sniffing is the real one.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a46494600010100', 'hex');
const inline = (buf, type) => `data:image/${type};base64,${buf.toString('base64')}`;

function wines(rows) {
  WineDefinition.find.mockReturnValue({ select: () => ({ lean: async () => rows }) });
}

const ADMIN = '64b0000000000000000000ad';
const quiet = () => {};

beforeEach(() => {
  jest.clearAllMocks();
  attachOfficialWineImage.mockImplementation(async ({ wineDefinitionId }) => ({
    image: { _id: `img-${wineDefinitionId}`, originalUrl: `/api/uploads/originals/${wineDefinitionId}.webp`, processedUrl: `/api/uploads/originals/${wineDefinitionId}.webp` },
  }));
});

test('a dry run lists what it would convert and changes nothing', async () => {
  wines([{ _id: 'w1', name: 'A', producer: 'P', image: inline(PNG, 'png'), createdBy: ADMIN }]);
  const lines = [];
  const summary = await convertInlineWineImages({ apply: false, log: (l) => lines.push(l) });
  expect(summary).toEqual({ found: 1, converted: 0, skipped: 0, failed: 0 });
  expect(lines.join('\n')).toMatch(/would convert w1 "A" \(P\): 0 kB inline, png, 2 bottle\(s\)/);
  expect(attachOfficialWineImage).not.toHaveBeenCalled();
  expect(WineDefinition.updateOne).not.toHaveBeenCalled();
});

test('--apply stores each as the official picture file, as the approving admin, and moves updatedAt', async () => {
  wines([
    { _id: 'w1', name: 'A', producer: 'P', image: inline(PNG, 'png'), imageCredit: 'Estate photo', createdBy: ADMIN },
    { _id: 'w2', name: 'B', producer: 'Q', image: inline(JPEG, 'jpeg'), createdBy: ADMIN },
  ]);
  const reindex = jest.fn(async () => {});
  const summary = await convertInlineWineImages({ apply: true, log: quiet, reindex });
  expect(summary).toEqual({ found: 2, converted: 2, skipped: 0, failed: 0 });
  expect(reindex.mock.calls).toEqual([['w1'], ['w2']]);

  const [first, second] = attachOfficialWineImage.mock.calls.map((c) => c[0]);
  expect(first).toMatchObject({ wineDefinitionId: 'w1', userId: ADMIN, userRoles: ['admin'], credit: 'Estate photo', keepBackground: true });
  expect(first.buffer.equals(PNG)).toBe(true);
  // Not background-removed yet: goes through removal like any admin upload.
  expect(second).toMatchObject({ wineDefinitionId: 'w2', keepBackground: false });

  expect(WineDefinition.updateOne).toHaveBeenCalledWith({ _id: 'w1' }, { $set: { updatedAt: expect.any(Date) } });
  expect(logAudit).toHaveBeenCalledWith(null, 'admin.wine.image.convert_inline', { type: 'wine', id: 'w1' },
    expect.objectContaining({ imageId: 'img-w1', url: '/api/uploads/originals/w1.webp' }));
});

test('an unreadable value, a wine without an approving admin, and a failed conversion are left as they are', async () => {
  wines([
    { _id: 'w1', name: 'A', image: 'data:image/png;base64,', createdBy: ADMIN },
    { _id: 'w2', name: 'B', image: inline(Buffer.from('not an image'), 'png'), createdBy: ADMIN },
    { _id: 'w3', name: 'C', image: inline(PNG, 'png'), createdBy: null },
    { _id: 'w4', name: 'D', image: inline(PNG, 'png'), createdBy: ADMIN },
  ]);
  attachOfficialWineImage.mockResolvedValueOnce({ error: { status: 400, message: 'Image could not be processed' } });
  const summary = await convertInlineWineImages({ apply: true, log: quiet });
  expect(summary).toEqual({ found: 4, converted: 0, skipped: 3, failed: 1 });
  expect(attachOfficialWineImage).toHaveBeenCalledTimes(1);
  expect(WineDefinition.updateOne).not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
});

test('nothing left to convert: nothing happens', async () => {
  wines([]);
  expect(await convertInlineWineImages({ apply: true, log: quiet })).toEqual({ found: 0, converted: 0, skipped: 0, failed: 0 });
});
