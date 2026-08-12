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

describe('get_pending_wine_images — the point of the feature', () => {
  const primeWine = (over = {}) => {
    WineDefinition.findById.mockReturnValue(leanChain(null).select ? {
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: W1, name: 'Kaefferkopf', producer: '', pendingIdentity: true, scanImage: SCAN, ...over }),
      }),
    } : {});
    Bottle.distinct.mockResolvedValue([oid('7')]);
    BottleImage.find.mockReturnValue(leanChain([{ _id: IMG, kind: 'bottle', originalUrl: '/api/uploads/originals/b.jpg' }]));
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
    expect(parse(res).data.images[0]).toEqual({ image_id: String(SCAN), kind: 'label-scan', private: true });
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
    BottleImage.find.mockReturnValue(leanChain([]));

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

  /**
   * M-1 (security audit) — this tool ships other people's PRIVATE bottle photos
   * as base64 to an EXTERNAL model. The only thing that justifies it is a
   * curator reading a label they have been asked to identify, so the wine must
   * still be pending. Without the gate any somm token could pull the private
   * gallery of ANY wine in the registry. The REST sibling (routes/images.js)
   * always required pendingIdentity: true; this is the parity fix.
   */
  describe('M-1 — only PENDING wines release their owners\' photos', () => {
    const primeNonPending = (retainUntil = null) => {
      WineDefinition.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            _id: W1, name: 'Barolo', producer: 'Rinaldi', pendingIdentity: false, scanImage: SCAN,
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
      BottleImage.find.mockReturnValue(leanChain([{ _id: IMG, kind: 'bottle', originalUrl: '/api/uploads/originals/b.jpg' }]));
    };
    const daysFromNow = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

    test('a COMPLETED wine is refused — its photos are private, not curation evidence', async () => {
      primeNonPending();

      const res = await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX);
      const body = parse(res);

      expect(body.error.code).toBe('conflict');
      // Asserts the MEANING, not the sentence: a completed wine past its grace
      // window is refused and told the scan is gone. (The wording changed when
      // the no-scan case got its own message — behaviour here is unchanged.)
      expect(body.error.message).toMatch(/pending-identity queue/);
      expect(body.error.message).toMatch(/window has closed/);
    });

    test('no image is read from disk for a completed wine', async () => {
      primeNonPending();
      fs.promises.readFile.mockClear();

      await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX);

      expect(fs.promises.readFile).not.toHaveBeenCalled();
      expect(BottleImage.find).not.toHaveBeenCalled();
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
      expect(body.data.images).toEqual([{ image_id: String(SCAN), kind: 'label-scan', private: true }]);
      expect(body.data.guidance).toMatch(/correction window/i);
    });

    test('inside the window the owners\' BOTTLE photos are NOT released', async () => {
      primeNonPending(daysFromNow(4));

      const res = await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX);

      expect(BottleImage.find).not.toHaveBeenCalled();
      expect(res.content.filter((c) => c.type === 'image')).toHaveLength(1);
    });

    test('after the window closes it is refused again', async () => {
      primeNonPending(daysFromNow(-1));

      const body = parse(await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX));

      expect(body.error.code).toBe('conflict');
      expect(body.error.message).toMatch(/correction window has closed/);
    });

    // Found in use 2026-08-12: a curator asked about a wine that was never
    // added from a photo and was told its window "has closed" — asserting that
    // evidence had existed and they were too late. The three states must not
    // share one message.
    test('a wine with NO scan is told so, not told a window expired', async () => {
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

    test('a promoted wine whose scan was never stamped stays refused', async () => {
      primeNonPending(null);

      expect(parse(await tool('get_pending_wine_images').handler({ wine_id: W1 }, SOMM_CTX)).error.code)
        .toBe('conflict');
    });
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
