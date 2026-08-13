/**
 * Pending-identity MCP tools (list_pending_wines / get_pending_wine_images /
 * fix_pending_wine).
 *
 * Pins: structural role gating (the registry never advertises them to a
 * non-somm) AND the in-handler re-check; the anonymised list projection (no
 * creator identity crosses this surface — it is the #930 rule and the payload
 * leaves the building); the IMAGE CONTENT-BLOCK shape, which is the point of
 * the feature — a real MCP image part the model can look at, downscaled
 * server-side; and the write tool's shared-validator delegation, matching audit
 * action string, and McpActionLog entry.
 *
 * sharp is mocked: this suite asserts the CONTRACT (a resize is requested, the
 * bytes ride as base64 with a mimeType), not libvips.
 */

jest.mock('../models/Cellar', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), findById: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn(), distinct: jest.fn() }));
jest.mock('../models/Rack', () => ({ find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WishlistItem', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/JournalEntry', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/BottleImage', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/Grape', () => ({ findOne: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/WineEmbedding', () => ({ findOne: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn(), findById: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn(), deleteOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../models/WineVintagePrice', () => {
  const M = jest.fn(function (doc) { Object.assign(this, doc); this._id = 'price-1'; this.save = jest.fn().mockResolvedValue(undefined); });
  M.aggregate = jest.fn().mockResolvedValue([]);
  M.deleteOne = jest.fn();
  return M;
});
jest.mock('../models/PriceTrackingRequest', () => ({ find: jest.fn(), findOne: jest.fn(), findById: jest.fn(), deleteOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../models/PriceTrackingSkip', () => ({ find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), deleteOne: jest.fn() }));
jest.mock('../models/WineCorrectionProposal', () => ({ create: jest.fn(), findById: jest.fn(), deleteOne: jest.fn() }));
jest.mock('../models/WineOwnerInquiry', () => ({ populate: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../utils/rackGeometry', () => ({ getMaxPosition: jest.fn(() => 12) }));
jest.mock('../services/search', () => ({ getIsAvailable: jest.fn(() => false), search: jest.fn(), searchBottles: jest.fn(), indexWine: jest.fn().mockResolvedValue(undefined), bulkIndexBottles: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/statsService', () => ({ computeOverview: jest.fn(), buildEmptyStats: jest.fn() }));
jest.mock('../services/vectorStore', () => ({ getPoints: jest.fn(), searchSimilar: jest.fn() }));
jest.mock('../config/aiConfig', () => ({ get: jest.fn(() => ({ vectorIndex: 'v1' })) }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/embeddingJob', () => ({ reembedActiveVintages: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/notifications', () => ({ createNotification: jest.fn().mockResolvedValue(undefined), createNotifications: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/exchangeRates', () => ({ getOrCreateDailySnapshot: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn(), findOrCreateRegion: jest.fn() }));
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), removeFromRacks: jest.fn(),
  RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  addBottle: jest.fn(), updateBottleFields: jest.fn(), removeBottleCascade: jest.fn(),
  UPDATABLE_FIELDS: ['price'],
}));
jest.mock('./mutationBudget', () => ({ takeMutationSlot: jest.fn(() => true), WRITE_WINDOW_MS: 15 * 60 * 1000 }));
jest.mock('../services/ownerInquiryOps', () => ({
  QUESTION_MIN: 10, QUESTION_MAX: 500,
  createOwnerInquiry: jest.fn(), sweepExpiredInquiries: jest.fn().mockResolvedValue(0), queryInquiryPage: jest.fn(),
}));
jest.mock('../services/pendingWineOps', () => ({
  queryPendingWines: jest.fn(),
  validatePendingFix: jest.fn(),
  applyPendingFix: jest.fn(),
  loadPendingWine: jest.fn(),
  CREATED_VIA_FILTERS: ['ui', 'import', 'mcp', 'ai'],
  FIELD_MAX: 200,
  MAX_BOTTLE_IMAGES: 3,
}));
jest.mock('../services/imageProcessor', () => ({ safeUploadPath: jest.fn((p) => `/app/uploads/${p}`) }));
jest.mock('fs', () => ({ promises: { readFile: jest.fn() } }));
// sharp is a real backend dependency (services/imageSanitizer) — mocked here so
// the suite pins the RESIZE CONTRACT, not libvips.
jest.mock('sharp', () => {
  const api = {
    rotate: jest.fn(() => api),
    resize: jest.fn(() => api),
    jpeg: jest.fn(() => api),
    toBuffer: jest.fn(async () => Buffer.from('downscaled-jpeg-bytes')),
  };
  const factory = jest.fn(() => api);
  factory.__api = api;
  return factory;
});

const sharp = require('sharp');
const fs = require('fs');
const WineDefinition = require('../models/WineDefinition');
const BottleImage = require('../models/BottleImage');
const Bottle = require('../models/Bottle');
const McpActionLog = require('../models/McpActionLog');
const { logAudit } = require('../services/audit');
const {
  queryPendingWines, validatePendingFix, applyPendingFix, loadPendingWine,
} = require('../services/pendingWineOps');
const { allTools, toolsForScopes } = require('./registry');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const W1 = oid('f');
const SCAN = oid('5');
const IMG = oid('6');
const CREATOR = oid('9');

const SOMM_CTX = { user: { id: ME, roles: ['somm'] }, scopes: ['read', 'write'], req: { user: { id: ME, roles: ['somm'] }, headers: {} } };
const USER_CTX = { user: { id: ME, roles: ['user'] }, scopes: ['read', 'write'], req: { user: { id: ME, roles: ['user'] }, headers: {} } };

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

const leanChain = (rows) => {
  const c = {};
  for (const m of ['select', 'sort', 'limit', 'populate']) c[m] = jest.fn(() => c);
  c.lean = jest.fn().mockResolvedValue(rows);
  return c;
};

const ROW = {
  _id: W1,
  name: 'Kaefferkopf',
  producer: null,
  appellation: null,
  regionName: 'Alsace',
  countryName: 'France',
  grapeNames: ['Riesling'],
  type: 'white',
  createdAt: new Date('2026-08-11T09:00:00Z'),
  createdVia: 'ui',
  bottleCount: 1,
  scanImageId: String(SCAN),
  bottleImageIds: [String(IMG)],
  imageUrls: { [String(SCAN)]: '/api/uploads/originals/scan.jpg', [String(IMG)]: '/api/uploads/originals/b.jpg' },
};

beforeEach(() => {
  jest.clearAllMocks();
  queryPendingWines.mockResolvedValue({ rows: [ROW], total: 1, pendingTotal: 7 });
  fs.promises.readFile.mockResolvedValue(Buffer.from('original-bytes'));
  sharp.__api.toBuffer.mockResolvedValue(Buffer.from('downscaled-jpeg-bytes'));
});

describe('role + scope gating', () => {
  test('all three tools are INVISIBLE without the somm/admin role', () => {
    const plain = toolsForScopes(['read', 'write'], ['user']).map((t) => t.name);
    for (const n of ['list_pending_wines', 'get_pending_wine_images', 'fix_pending_wine']) {
      expect(plain).not.toContain(n);
    }
    for (const role of ['somm', 'admin']) {
      const names = toolsForScopes(['read', 'write'], [role]).map((t) => t.name);
      for (const n of ['list_pending_wines', 'get_pending_wine_images', 'fix_pending_wine']) {
        expect(names).toContain(n);
      }
    }
  });

  test('a read-only somm token can read the queue and the photos but never write a fix', () => {
    const readSomm = toolsForScopes(['read'], ['somm']).map((t) => t.name);
    expect(readSomm).toContain('list_pending_wines');
    expect(readSomm).toContain('get_pending_wine_images');
    expect(readSomm).not.toContain('fix_pending_wine');
  });

  test('defense-in-depth: handlers refuse a role-less ctx even if reached', async () => {
    for (const n of ['list_pending_wines', 'get_pending_wine_images', 'fix_pending_wine']) {
      const res = await tool(n).handler({ wine_id: W1, producer: 'X' }, USER_CTX);
      expect(parse(res).error.code).toBe('forbidden_scope');
    }
  });
});

describe('list_pending_wines', () => {
  test('reads the shared queue and never exposes a creator', async () => {
    const res = await tool('list_pending_wines').handler({ limit: 20, offset: 0 }, SOMM_CTX);
    const body = parse(res);

    expect(queryPendingWines).toHaveBeenCalledWith(
      { limit: 20, offset: 0, createdVia: undefined, includeUnavailable: false });
    expect(body.summary).toMatch(/7 wine\(s\) awaiting an identity/);
    expect(body.data[0]).toMatchObject({
      wine_id: W1, name: 'Kaefferkopf', producer: null,
      bottle_count: 1, scan_image_id: String(SCAN), has_images: true,
    });
    // Neither the creator nor the raw URLs cross the MCP surface: a model gets
    // pixels from get_pending_wine_images, and a URL it cannot fetch is noise.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(CREATOR);
    expect(raw).not.toContain('/api/uploads/');
  });

  test('created_via rides through as the burst filter', async () => {
    await tool('list_pending_wines').handler({ created_via: 'import', limit: 5, offset: 0 }, SOMM_CTX);
    expect(queryPendingWines).toHaveBeenCalledWith(expect.objectContaining({ createdVia: 'import' }));
  });
});

/**
 * Two BottleImage.find shapes now reach this tool, and they must be answered
 * separately or a test proves nothing:
 *   { status: 'approved', visibility: 'public', … } — the PUBLIC gallery, the
 *     same filter GET /api/images/wine/:id serves the web. Any wine.
 *   { $or: [{ wineDefinition }, { bottle }] }       — the owners' own photos.
 *     PENDING wines only (security audit M-1).
 */
const primeImageQueries = ({ gallery = [], owners = [] } = {}) => {
  BottleImage.find.mockImplementation((q) =>
    leanChain(q && q.status === 'approved' ? gallery : owners));
};
/**
 * Did the tool issue the PRIVATE both-ways query at all? The public GALLERY
 * query also carries an $or since the v1.111.0 hotfix (bottle-linked public
 * photos render on the wine page and must be served) — what distinguishes the
 * private query is the ABSENCE of the approved+public constraint.
 */
const privateQueryIssued = () =>
  BottleImage.find.mock.calls.some(([q]) => q && Array.isArray(q.$or) && q.status !== 'approved');

describe('get_pending_wine_images — the point of the feature', () => {
  const primeWine = (over = {}) => {
    WineDefinition.findById.mockReturnValue(leanChain(null).select ? {
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: W1, name: 'Kaefferkopf', producer: '', pendingIdentity: true, scanImage: SCAN, ...over }),
      }),
    } : {});
    Bottle.distinct.mockResolvedValue([oid('7')]);
    primeImageQueries({ owners: [{ _id: IMG, kind: 'bottle', originalUrl: '/api/uploads/originals/b.jpg' }] });
    BottleImage.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: SCAN, kind: 'label-scan', originalUrl: '/api/uploads/originals/scan.jpg' }),
      }),
    });
  };

  test('returns real MCP image content blocks, scan FIRST, with base64 + mimeType', async () => {
    primeWine();

    const res = await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX);

    // A text part first (so the model reads the instruction), then images.
    expect(res.content[0].type).toBe('text');
    const images = res.content.filter((c) => c.type === 'image');
    expect(images).toHaveLength(2);
    for (const img of images) {
      expect(img.mimeType).toBe('image/jpeg');
      expect(typeof img.data).toBe('string');
      expect(Buffer.from(img.data, 'base64').toString()).toBe('downscaled-jpeg-bytes');
    }
    // The scanned LABEL is the primary evidence and comes first. `private`
    // rides along (audit M-1): these are the owner's own photos, released to
    // curation for one purpose, and the payload says so.
    expect(parse(res).data.images[0]).toEqual({ image_id: String(SCAN), kind: 'label-scan', side: 'front', private: true });
  });

  test('downscales server-side to <=1024px on the longest edge, never enlarging', async () => {
    primeWine();
    await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX);

    expect(sharp.__api.resize).toHaveBeenCalledWith(
      { width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true });
  });

  test('a wine with no stored photo says so instead of failing', async () => {
    WineDefinition.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: W1, name: 'Kaefferkopf', producer: '', pendingIdentity: true, scanImage: null }),
      }),
    });
    Bottle.distinct.mockResolvedValue([]);
    primeImageQueries();

    const res = await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX);
    const body = parse(res);

    expect(res.isError).toBeUndefined();
    expect(body.data.images).toBe(0);
    expect(body.summary).toMatch(/No photos are stored/);
  });

  test('unreadable files degrade to `unavailable`, not a crash', async () => {
    primeWine();
    fs.promises.readFile.mockRejectedValue(new Error('ENOENT'));

    const res = await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX);
    expect(parse(res).error.code).toBe('unavailable');
  });

  test('a BOTTLE-linked approved public photo is served for a promoted wine — the wine page shows it, so must we (v1.111.0 hotfix)', async () => {
    // The somm's own example: Wynns "The Original", whose only photo hangs off
    // a bottle (wineDefinition: null) yet renders publicly on the wine page.
    WineDefinition.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: W1, name: 'The Original', producer: 'Wynns', pendingIdentity: false,
          scanImage: null, scanImageBack: null,
        }),
      }),
    });
    Bottle.distinct.mockResolvedValue([oid('7')]);
    BottleImage.find.mockReturnValue(leanChain([
      { _id: IMG, kind: 'bottle', status: 'approved', visibility: 'public', originalUrl: '/api/uploads/originals/b.jpg' },
    ]));

    const res = await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX);
    const body = parse(res);

    expect(res.isError).toBeUndefined();
    // The gallery query must reach for bottle-linked photos too.
    const galleryFilter = BottleImage.find.mock.calls[0][0];
    expect(galleryFilter.$or).toEqual(expect.arrayContaining([
      expect.objectContaining({ bottle: { $in: [oid('7')] } }),
    ]));
    expect(body.data.images.map((i) => i.image_id)).toContain(String(IMG));
  });

  test('per-image gating: an expired front frame does not ride the back frame\'s grace (release-audit M-2)', async () => {
    // Promoted wine, divergent retainUntil: front expired yesterday, back in
    // grace until tomorrow. The pair-level gate passes (either readable), but
    // only the still-readable frame may be served — the expired one is gone
    // evidence, whatever its sibling's clock says.
    const SCANB = oid('b');
    primeImageQueries();
    WineDefinition.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: W1, name: 'Barolo', producer: 'Rinaldi', pendingIdentity: false,
          scanImage: SCAN, scanImageBack: SCANB,
        }),
      }),
    });
    BottleImage.findById.mockImplementation((id) => ({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(String(id) === String(SCAN)
          ? { _id: SCAN, kind: 'label-scan', side: 'front', originalUrl: '/api/uploads/originals/scan.jpg', retainUntil: new Date(Date.now() - 24 * 60 * 60 * 1000) }
          : { _id: SCANB, kind: 'label-scan', side: 'back', originalUrl: '/api/uploads/originals/scanb.jpg', retainUntil: new Date(Date.now() + 24 * 60 * 60 * 1000) }),
      }),
    }));

    const res = await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX);
    const body = parse(res);
    const ids = body.data.images.map((i) => i.image_id);
    expect(ids).toContain(String(SCANB));
    expect(ids).not.toContain(String(SCAN));
  });

  /**
   * M-1 (security audit) — this tool ships other people's PRIVATE bottle photos
   * as base64 to an EXTERNAL model. The only thing that justifies it is a
   * curator reading a label they have been asked to identify, so the wine must
   * still be pending. Without the gate any somm token could pull the private
   * gallery of ANY wine in the registry. The REST sibling (routes/images.js)
   * always required pendingIdentity: true; this is the parity fix.
   */
  describe('M-1 — only PENDING wines release their owners\' PRIVATE photos', () => {
    const OWNER_PHOTO = { _id: IMG, kind: 'bottle', originalUrl: '/api/uploads/originals/b.jpg' };
    const primeNonPending = (retainUntil = null, { scanImage = SCAN, gallery = [] } = {}) => {
      WineDefinition.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            _id: W1, name: 'Barolo', producer: 'Rinaldi', pendingIdentity: false, scanImage,
          }),
        }),
      });
      BottleImage.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            _id: SCAN, kind: 'label-scan', originalUrl: '/api/uploads/originals/scan.jpg', retainUntil,
          }),
        }),
      });
      Bottle.distinct.mockResolvedValue([oid('7')]);
      primeImageQueries({ gallery, owners: [OWNER_PHOTO] });
    };
    const daysFromNow = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

    test('a COMPLETED wine with no evidence left is refused — its photos are private', async () => {
      primeNonPending();

      const res = await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX);
      const body = parse(res);

      expect(body.error.code).toBe('conflict');
      // Asserts the MEANING, not the sentence: the scan is gone AND the wine
      // publishes nothing, so there is genuinely nothing to look at.
      expect(body.error.message).toMatch(/correction window has closed/);
      expect(body.error.message).toMatch(/no public gallery photo/);
    });

    test('no image is read from disk, and the PRIVATE query is never issued', async () => {
      primeNonPending();
      fs.promises.readFile.mockClear();

      await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX);

      expect(fs.promises.readFile).not.toHaveBeenCalled();
      // The public-gallery lookup happens (it is what decides the refusal); the
      // owners' both-ways query must not.
      expect(privateQueryIssued()).toBe(false);
    });

    test('the payload marks the photos PRIVATE and says what they may be used for', async () => {
      primeWine();

      const res = await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX);
      const body = parse(res);

      expect(body.data.images.every((i) => i.private === true)).toBe(true);
      expect(body.data.guidance).toMatch(/private photos/i);
    });

    /**
     * The GRACE WINDOW. A completed identity can be WRONG, and until now the
     * label became unreadable the instant the row promoted — so nothing could
     * ever check it (the "Increíble"/"Increíble" row reached the maturity queue
     * in exactly that state). The scan therefore outlives the queue by
     * PROMOTED_SCAN_GRACE_DAYS, and only the scan: the owners' BOTTLE photos
     * are private again the moment the row promotes.
     */
    test('day 3 after promotion: the LABEL SCAN is still served', async () => {
      primeNonPending(daysFromNow(4)); // stamped 7 days out, 3 days ago

      const res = await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX);
      const body = parse(res);

      expect(res.isError).toBeUndefined();
      expect(body.data.still_pending).toBe(false);
      expect(body.data.images).toEqual([{ image_id: String(SCAN), kind: 'label-scan', side: 'front', private: true }]);
      expect(body.data.guidance).toMatch(/correction window/i);
    });

    test('inside the window the owners\' PRIVATE photos are still NOT released', async () => {
      primeNonPending(daysFromNow(4));

      const res = await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX);

      expect(privateQueryIssued()).toBe(false);
      expect(res.content.filter((c) => c.type === 'image')).toHaveLength(1);
      expect(parse(res).data.images.map((i) => i.image_id)).not.toContain(String(IMG));
    });

    test('after the window closes, with nothing published, it is refused again', async () => {
      primeNonPending(daysFromNow(-1));

      const body = parse(await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX));

      expect(body.error.code).toBe('conflict');
      expect(body.error.message).toMatch(/correction window has closed/);
    });

    // Found in use 2026-08-12: a curator asked about a wine that was never
    // added from a photo and was told its window "has closed" — asserting that
    // evidence had existed and they were too late. The states must not share
    // one message.
    test('a wine with NO scan and nothing published is told so, not told a window expired', async () => {
      primeNonPending(null, { scanImage: null });
      WineDefinition.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            _id: W1, name: 'Rosé Poulsard', producer: 'Domaine Rolet', pendingIdentity: false, scanImage: null,
          }),
        }),
      });

      const body = parse(await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX));

      expect(body.error.code).toBe('conflict');
      expect(body.error.message).toMatch(/has no label scan/);
      expect(body.error.message).not.toMatch(/window has closed/);
      expect(body.error.message).toMatch(/ask_bottle_owner/);
    });

    test('a promoted wine whose scan was never stamped, with nothing published, stays refused', async () => {
      primeNonPending(null);

      expect(parse(await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX)).error.code)
        .toBe('conflict');
    });

    /**
     * PROD 2026-08-13 — the inversion the somm reported: this tool refused a
     * wine whose APPROVED PUBLIC photo the wine page renders to anonymous
     * visitors, in the name of privacy. Serving it here is zero new exposure,
     * and the refusal was simply false.
     */
    describe('the PUBLIC gallery is served for any wine, pending or not', () => {
      const PUB = oid('c');
      const publicPhoto = {
        _id: PUB, kind: 'bottle', status: 'approved', visibility: 'public',
        credit: 'Photo: Anna B.', originalUrl: '/api/uploads/originals/pub.jpg',
      };

      test('scan EXPIRED but the wine publishes a photo → the photo is served, truthfully captioned', async () => {
        primeNonPending(daysFromNow(-1), { gallery: [publicPhoto] });

        const res = await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX);
        const body = parse(res);

        expect(res.isError).toBeUndefined();
        expect(body.data.images).toEqual([{
          image_id: String(PUB), kind: 'bottle', private: false,
          public_gallery: true, credit: 'Photo: Anna B.',
        }]);
        // The caption says what it is — a gallery shot is not a label frame and
        // a model must not read it as one.
        const captions = res.content.filter((c) => c.type === 'text').map((c) => c.text);
        expect(captions.some((t) => /PUBLIC gallery photo/.test(t) && /Anna B\./.test(t))).toBe(true);
        expect(body.data.guidance).toMatch(/No label scan is available/);
        // …and the expired scan itself is still gone.
        expect(body.data.images.map((i) => i.image_id)).not.toContain(String(SCAN));
      });

      test('a wine that never had a scan is served its gallery instead of a refusal', async () => {
        primeNonPending(null, { scanImage: null, gallery: [publicPhoto] });
        WineDefinition.findById.mockReturnValue({
          select: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue({
              _id: W1, name: 'Barolo', producer: 'Rinaldi', pendingIdentity: false, scanImage: null,
            }),
          }),
        });

        const body = parse(await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX));

        expect(body.error).toBeUndefined();
        expect(body.data.images.map((i) => i.image_id)).toEqual([String(PUB)]);
      });

      test('the gallery never widens M-1 — the owners\' private photos stay out', async () => {
        primeNonPending(daysFromNow(-1), { gallery: [publicPhoto] });

        const body = parse(await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX));

        expect(privateQueryIssued()).toBe(false);
        expect(body.data.images.map((i) => i.image_id)).not.toContain(String(IMG));
      });

      test('the gallery filter IS the web page\'s — approved + public, never a label scan', async () => {
        primeNonPending(daysFromNow(-1), { gallery: [publicPhoto] });

        await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX);

        const galleryQuery = BottleImage.find.mock.calls.map(([q]) => q)
          .find((q) => q && q.status === 'approved');
        // Both linkage forms, same public constraint (v1.111.0 hotfix): the
        // wine page renders wine-linked AND bottle-linked approved+public
        // photos, so the gallery asks for both — never anything private.
        expect(galleryQuery.status).toBe('approved');
        expect(galleryQuery.visibility).toBe('public');
        expect(galleryQuery.kind).toEqual({ $ne: 'label-scan' });
        expect(galleryQuery.$or).toEqual(expect.arrayContaining([{ wineDefinition: W1 }]));
      });

      test('a scan still in its window comes FIRST, with the gallery after it', async () => {
        primeNonPending(daysFromNow(4), { gallery: [publicPhoto] });

        const body = parse(await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX));

        expect(body.data.images.map((i) => i.image_id)).toEqual([String(SCAN), String(PUB)]);
        expect(body.data.images[0].private).toBe(true);
        expect(body.data.images[1].public_gallery).toBe(true);
      });
    });
  });

  test('a PENDING wine does not show the same photo twice when it is also published', async () => {
    // The owners' both-ways query already sweeps in an approved+public photo
    // linked to the wine; the gallery pass must not append it a second time.
    const shared = {
      _id: IMG, kind: 'bottle', status: 'approved', visibility: 'public',
      originalUrl: '/api/uploads/originals/b.jpg',
    };
    WineDefinition.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: W1, name: 'Kaefferkopf', producer: '', pendingIdentity: true, scanImage: SCAN,
        }),
      }),
    });
    BottleImage.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: SCAN, kind: 'label-scan', originalUrl: '/api/uploads/originals/scan.jpg' }),
      }),
    });
    Bottle.distinct.mockResolvedValue([]);
    primeImageQueries({ gallery: [shared], owners: [shared] });

    const body = parse(await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX));

    expect(body.data.images.map((i) => i.image_id)).toEqual([String(SCAN), String(IMG)]);
  });
});

describe('fix_pending_wine', () => {
  const wine = { _id: W1, name: 'Kaefferkopf', producer: 'Cave de Kaysersberg', appellation: null, type: 'white', pendingIdentity: false };

  beforeEach(() => {
    validatePendingFix.mockReturnValue({ ok: true, clean: { producer: 'Cave de Kaysersberg' } });
    loadPendingWine.mockResolvedValue({ ok: true, wine });
    applyPendingFix.mockResolvedValue({
      ok: true, wine, promoted: true,
      diff: { producer: { from: null, to: 'Cave de Kaysersberg' } },
    });
  });

  test('maps snake_case to the SHARED validator, audits with the REST action string, logs the action', async () => {
    const res = await tool('fix_pending_wine').handler(
      { wine_id: W1, producer: 'Cave de Kaysersberg', region: 'Alsace', country: 'France', grapes: ['Riesling'] },
      SOMM_CTX,
    );
    const body = parse(res);

    expect(validatePendingFix).toHaveBeenCalledWith({
      producer: 'Cave de Kaysersberg', regionName: 'Alsace', countryName: 'France', grapeNames: ['Riesling'],
    });
    expect(body.data.promoted).toBe(true);
    expect(body.summary).toMatch(/identity completed/);

    // Same audit action string as the REST PATCH — REST and MCP must not drift.
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'wine.pending_fix', { type: 'wine', id: W1 },
      expect.objectContaining({ promoted: true, via: 'mcp' }));
    // …and the write is on the MCP action ledger like every other write tool.
    expect(McpActionLog.create).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'fix_pending_wine', action: 'somm_pending_fix',
    }));
  });

  test('a still-incomplete fix reports still_pending and says what is missing', async () => {
    applyPendingFix.mockResolvedValue({ ok: true, wine: { ...wine, producer: '', pendingIdentity: true }, promoted: false, diff: {} });

    const body = parse(await tool('fix_pending_wine').handler({ wine_id: W1, appellation: 'Kaefferkopf' }, SOMM_CTX));

    expect(body.data.still_pending).toBe(true);
    expect(body.data.note).toMatch(/Send a producer/);
  });

  /**
   * "No producer on the label" — a LAST-RESORT disposition, described as such
   * on the argument, and routed through the SAME shared validator as every
   * other field so REST and MCP cannot drift on it.
   */
  test('identity_unavailable maps to the shared validator and reports the disposition', async () => {
    validatePendingFix.mockReturnValue({ ok: true, clean: { identityUnavailable: true } });
    applyPendingFix.mockResolvedValue({
      ok: true,
      wine: { ...wine, producer: '', pendingIdentity: true, identityUnavailable: true },
      promoted: false,
      diff: { identityUnavailable: { from: false, to: true } },
    });

    const body = parse(await tool('fix_pending_wine').handler(
      { wine_id: W1, identity_unavailable: true }, SOMM_CTX));

    expect(validatePendingFix).toHaveBeenCalledWith({ identityUnavailable: true });
    expect(body.data.identity_unavailable).toBe(true);
    expect(body.data.promoted).toBe(false);
    expect(body.data.still_pending).toBe(true);   // it is NOT in the registry
    expect(body.summary).toMatch(/no producer on the label/);
    expect(body.data.note).toMatch(/identity_unavailable: false/);  // reversible, and it says so
  });

  test('the argument is described as a last resort, after asking the owner', async () => {
    const schema = tool('fix_pending_wine').inputSchema.identity_unavailable;
    expect(schema.description).toMatch(/LAST RESORT/);
    expect(schema.description).toMatch(/ask_bottle_owner/);
  });

  test('service refusals map straight to the MCP error taxonomy', async () => {
    loadPendingWine.mockResolvedValue({ ok: false, code: 'conflict', message: 'not in the queue' });
    expect(parse(await tool('fix_pending_wine').handler({ wine_id: W1, producer: 'X' }, SOMM_CTX)).error.code).toBe('conflict');

    loadPendingWine.mockResolvedValue({ ok: false, code: 'not_found', message: 'gone' });
    expect(parse(await tool('fix_pending_wine').handler({ wine_id: W1, producer: 'X' }, SOMM_CTX)).error.code).toBe('not_found');

    validatePendingFix.mockReturnValue({ ok: false, error: 'nope' });
    expect(parse(await tool('fix_pending_wine').handler({ wine_id: W1 }, SOMM_CTX)).error.code).toBe('invalid_input');
  });

  test('a refused fix writes NO action-ledger row', async () => {
    validatePendingFix.mockReturnValue({ ok: false, error: 'nope' });
    await tool('fix_pending_wine').handler({ wine_id: W1 }, SOMM_CTX);
    expect(McpActionLog.create).not.toHaveBeenCalled();
  });
});

/**
 * The BACK-LABEL frame on the curation surfaces.
 *
 * A queue row can now carry two label photos of one bottle, and the thing that
 * has to hold is that a curator is never left guessing which is which: "the
 * producer is not printed on this one" means opposite things about a front and
 * a back label, and an id in a JSON list cannot say which position in the image
 * stream it occupies.
 */
describe('the back label reaches curation, labelled', () => {
  const BACK = oid('4');

  const primeBothFrames = () => {
    WineDefinition.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: W1, name: 'Kaefferkopf', producer: '', pendingIdentity: true,
          scanImage: SCAN, scanImageBack: BACK,
          scanFieldConflicts: [{ field: 'producer', front: 'Cave', back: 'Wolfberger' }],
        }),
      }),
    });
    Bottle.distinct.mockResolvedValue([]);
    BottleImage.find.mockReturnValue(leanChain([]));
    BottleImage.findById.mockImplementation((id) => ({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(String(id) === String(BACK)
          ? { _id: BACK, kind: 'label-scan', side: 'back', originalUrl: '/api/uploads/originals/back.jpg' }
          : { _id: SCAN, kind: 'label-scan', side: 'front', originalUrl: '/api/uploads/originals/scan.jpg' }),
      }),
    }));
  };

  test('both frames are served, front first, each preceded by a caption naming its face', async () => {
    primeBothFrames();

    const res = await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX);

    expect(res.content.filter((c) => c.type === 'image')).toHaveLength(2);
    const captions = res.content.filter((c) => c.type === 'text').map((c) => c.text);
    expect(captions.some((t) => /FRONT LABEL/.test(t))).toBe(true);
    expect(captions.some((t) => /BACK LABEL/.test(t))).toBe(true);

    const { images } = parse(res).data;
    expect(images).toEqual([
      { image_id: String(SCAN), kind: 'label-scan', side: 'front', private: true },
      { image_id: String(BACK), kind: 'label-scan', side: 'back', private: true },
    ]);
  });

  test('what the two labels disagreed about rides in the payload', async () => {
    primeBothFrames();

    const { front_back_disagreements: d } = parse(
      await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX)
    ).data;

    expect(d).toEqual([{ field: 'producer', front: 'Cave', back: 'Wolfberger' }]);
  });

  test('a wine with ONLY a back frame is served — the front scan 422\'d and its frame was abandoned', async () => {
    WineDefinition.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: W1, name: 'Kaefferkopf', producer: '', pendingIdentity: true,
          scanImage: null, scanImageBack: BACK,
        }),
      }),
    });
    Bottle.distinct.mockResolvedValue([]);
    BottleImage.find.mockReturnValue(leanChain([]));
    BottleImage.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: BACK, kind: 'label-scan', side: 'back', originalUrl: '/api/uploads/originals/back.jpg' }),
      }),
    });

    const res = await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX);

    expect(res.isError).toBeUndefined();
    expect(parse(res).data.images).toEqual([
      { image_id: String(BACK), kind: 'label-scan', side: 'back', private: true },
    ]);
  });

  test('list_pending_wines carries the back-frame id and the disagreements', async () => {
    queryPendingWines.mockResolvedValue({
      rows: [{
        ...ROW,
        scanImageBackId: String(BACK),
        scanFieldConflicts: [{ field: 'producer', front: 'Cave', back: 'Wolfberger' }],
      }],
      total: 1, pendingTotal: 1,
    });

    const [row] = parse(await tool('list_pending_wines').handler({}, SOMM_CTX)).data;

    expect(row.scan_image_back_id).toBe(String(BACK));
    expect(row.front_back_disagreements).toEqual([
      { field: 'producer', front: 'Cave', back: 'Wolfberger' },
    ]);
    expect(row.has_images).toBe(true);
  });

  test('a one-frame row omits the disagreement key entirely — most rows have nothing to say', async () => {
    queryPendingWines.mockResolvedValue({
      rows: [{ ...ROW, scanImageBackId: null, scanFieldConflicts: [] }],
      total: 1, pendingTotal: 1,
    });

    const [row] = parse(await tool('list_pending_wines').handler({}, SOMM_CTX)).data;

    expect(row.scan_image_back_id).toBeNull();
    expect(row).not.toHaveProperty('front_back_disagreements');
  });
});
