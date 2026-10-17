/**
 * Photo review MCP tools (list_image_queue / review_image).
 *
 * Pins: structural role gating (invisible to a plain member, visible to somm
 * and admin; a read-only somm token sees only the lister) and the in-handler
 * re-check; what the queue may contain (never a label scan, never an upload
 * abandoned before its bottle was saved); that the uploader is never named
 * (a pseudonymous uploader_ref only) and every read leaves an audit row; the
 * IMAGE block shape; and which shared-service call each decision makes —
 * including the two rules this queue exists for: a photo is only made the
 * wine's main picture on an explicit "public_main", and a reject always
 * carries a reason the uploader reads.
 *
 * services/imageModerationOps is mocked here — its behaviour is pinned by its
 * own suite and by routes/admin/images.*.test.js, which run through it.
 */

jest.mock('../models/BottleImage', () => ({
  find: jest.fn(), findById: jest.fn(), countDocuments: jest.fn(), aggregate: jest.fn(), updateOne: jest.fn(),
}));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/photoBytes', () => ({
  renderImage: jest.fn(async () => ({ data: 'aW1n', mimeType: 'image/jpeg', bytes: 1000 })),
}));
jest.mock('../services/imageModerationOps', () => ({
  REJECT_REASON_MAX: 500,
  approveImage: jest.fn(),
  rejectImage: jest.fn(),
  setOfficialImage: jest.fn(),
  setImageVisibility: jest.fn(),
  dismissImageReport: jest.fn(),
}));

const BottleImage = require('../models/BottleImage');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const McpActionLog = require('../models/McpActionLog');
const { logAudit } = require('../services/audit');
const { renderImage } = require('../services/photoBytes');
const ops = require('../services/imageModerationOps');
const { allTools, toolsForScopes } = require('./registry');
const { uploaderRef } = require('./tools/sommImages');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const UPLOADER = oid('9');
const SOMM_CTX = { user: { id: ME, roles: ['somm'] }, scopes: ['read', 'write'], req: { user: { id: ME, roles: ['somm'] }, headers: {} } };
const USER_CTX = { user: { id: ME, roles: ['user'] }, scopes: ['read', 'write'], req: { user: { id: ME, roles: ['user'] }, headers: {} } };

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);
const chain = (value) => {
  const c = {};
  for (const m of ['sort', 'skip', 'limit', 'select', 'populate']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(value));
  return c;
};

beforeEach(() => {
  jest.clearAllMocks();
  McpActionLog.create.mockResolvedValue({});
  BottleImage.updateOne.mockResolvedValue({});
});

describe('role gating', () => {
  test('invisible to a member, visible to somm and admin; a read-only somm token sees only the lister', () => {
    const names = (scopes, roles) => toolsForScopes(scopes, roles).map((t) => t.name);
    expect(names(['read', 'write'], ['user'])).not.toContain('list_image_queue');
    expect(names(['read', 'write'], ['user'])).not.toContain('review_image');
    for (const roles of [['somm'], ['admin']]) {
      expect(names(['read', 'write'], roles)).toEqual(expect.arrayContaining(['list_image_queue', 'review_image']));
    }
    expect(names(['read'], ['somm'])).toContain('list_image_queue');
    expect(names(['read'], ['somm'])).not.toContain('review_image');
  });

  test('handlers refuse a role-less ctx even if reached', async () => {
    for (const n of ['list_image_queue', 'review_image']) {
      const res = await tool(n).handler({ image_id: oid('1'), decision: 'public' }, USER_CTX);
      expect(parse(res).error.code).toBe('forbidden_scope');
    }
  });
});

describe('list_image_queue', () => {
  const PHOTO = {
    _id: oid('1'), bottle: oid('b'), wineDefinition: null, uploadedBy: UPLOADER,
    processedUrl: '/api/uploads/processed/front.webp', originalUrl: null, status: 'processed',
    visibility: 'public', keepBackground: false, assignedToWine: false, vintage: '2019', createdAt: new Date('2026-10-16'),
  };

  function seedPage(rows) {
    BottleImage.find.mockImplementation((filter) => {
      if (filter.bottle) return chain([{ _id: oid('1'), bottle: oid('b') }, { _id: oid('2'), bottle: oid('b') }]); // same-bottle lookup
      if (filter.assignedToWine) return chain([]);
      return chain(rows);
    });
    BottleImage.countDocuments.mockImplementation(async (filter) => (filter.bottle === null ? 3 : rows.length));
    BottleImage.aggregate.mockImplementation(async (pipeline) => {
      const match = pipeline[0].$match;
      if (match.uploadedBy) return [{ _id: UPLOADER, n: 4 }];
      return [];
    });
    Bottle.find.mockReturnValue(chain([{ _id: oid('b'), wineDefinition: oid('f'), vintage: '2019' }]));
    WineDefinition.find.mockReturnValue(chain([{ _id: oid('f'), name: 'Riesling Trocken', producer: 'Weingut X', type: 'white', image: null }]));
  }

  test('the pending queue excludes label scans and abandoned uploads, oldest first', async () => {
    seedPage([PHOTO]);
    await tool('list_image_queue').handler({}, SOMM_CTX);
    const queueFilter = BottleImage.find.mock.calls.map((c) => c[0]).find((f) => f.status === 'processed' && f.$or);
    expect(queueFilter).toEqual({
      kind: { $ne: 'label-scan' },
      status: 'processed',
      $or: [{ bottle: { $ne: null } }, { wineDefinition: { $ne: null } }],
    });
    const sortCall = BottleImage.find.mock.results[0].value.sort.mock.calls[0][0];
    expect(sortCall).toEqual({ createdAt: 1 });
  });

  test('each photo comes as a caption + image block with its wine, siblings and a pseudonymous uploader — never the uploader id', async () => {
    seedPage([PHOTO]);
    const res = await tool('list_image_queue').handler({}, SOMM_CTX);

    expect(res.content).toHaveLength(3);
    expect(res.content[1]).toEqual({ type: 'text', text: expect.stringContaining('image_id ' + oid('1')) });
    expect(res.content[1].text).toContain('"Weingut X — Riesling Trocken" 2019');
    expect(res.content[2]).toEqual({ type: 'image', data: 'aW1n', mimeType: 'image/jpeg' });
    expect(renderImage).toHaveBeenCalledWith('/api/uploads/processed/front.webp', { maxEdge: 1024 });

    const body = parse(res);
    const p = body.data.photos[0];
    expect(p).toMatchObject({
      image_id: oid('1'),
      wine: { wine_id: oid('f'), producer: 'Weingut X', name: 'Riesling Trocken', type: 'white' },
      vintage: '2019',
      wine_main_picture: 'none',
      same_bottle_in_queue: [oid('2')],
      uploader_ref: uploaderRef(UPLOADER),
      uploader_photos_in_queue: 4,
      image_included: true,
    });
    expect(body.data.abandoned_uploads).toBe(3);
    expect(res.content[0].text).not.toContain(UPLOADER);
  });

  test('a read that showed photos leaves an audit row naming the image ids', async () => {
    seedPage([PHOTO]);
    await tool('list_image_queue').handler({}, SOMM_CTX);
    expect(logAudit).toHaveBeenCalledWith(SOMM_CTX.req, 'image.moderation_read', { type: 'image', id: null },
      { imageIds: [oid('1')], queue: 'pending', via: 'mcp' });
  });

  test('the reported queue lists published photos with an open report, with the reasons but not the reporters', async () => {
    const reported = { ...PHOTO, status: 'approved', reportedAt: new Date(), reports: [{ user: oid('7'), reason: 'not-this-wine', detail: 'This is the rosé', createdAt: new Date() }] };
    seedPage([reported]);
    const res = await tool('list_image_queue').handler({ queue: 'reported' }, SOMM_CTX);

    const filter = BottleImage.find.mock.calls[0][0];
    expect(filter).toEqual({ kind: { $ne: 'label-scan' }, reportedAt: { $ne: null }, status: { $ne: 'rejected' } });
    const p = parse(res).data.photos[0];
    expect(p.reports).toEqual([{ reason: 'not-this-wine', detail: 'This is the rosé', at: expect.any(String) }]);
    expect(res.content[0].text).not.toContain(oid('7'));
    expect(res.content[1].text).toContain('reported: not-this-wine');
  });

  test('an empty queue says so, and names the abandoned uploads left to the cleanup', async () => {
    seedPage([]);
    const body = parse(await tool('list_image_queue').handler({}, SOMM_CTX));
    expect(body.summary).toMatch(/empty .*3 abandoned/);
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('review_image', () => {
  const pendingPhoto = (overrides = {}) => BottleImage.findById.mockReturnValue(chain({
    _id: oid('1'), kind: 'bottle', status: 'processed', visibility: 'public', reportedAt: null, bottle: oid('b'), wineDefinition: null, ...overrides,
  }));
  const approved = (extra = {}) => ({ ok: true, image: { _id: oid('1'), wineDefinition: oid('f') }, ...extra });

  test('a reject needs a reason; replace_main only goes with public_main', async () => {
    let res = await tool('review_image').handler({ image_id: oid('1'), decision: 'reject' }, SOMM_CTX);
    expect(parse(res).error.code).toBe('invalid_input');
    res = await tool('review_image').handler({ image_id: oid('1'), decision: 'public', replace_main: true }, SOMM_CTX);
    expect(parse(res).error.code).toBe('invalid_input');
    expect(BottleImage.findById).not.toHaveBeenCalled();
  });

  test('a label scan, an abandoned upload or a missing id is not in the queue', async () => {
    for (const doc of [null, { _id: oid('1'), kind: 'label-scan', status: 'uploaded' }, { _id: oid('1'), kind: 'bottle', status: 'processed', bottle: null, wineDefinition: null }]) {
      BottleImage.findById.mockReturnValue(chain(doc));
      const res = await tool('review_image').handler({ image_id: oid('1'), decision: 'public' }, SOMM_CTX);
      expect(parse(res).error.code).toBe('not_found');
    }
  });

  test('an already-decided photo without a report is a conflict, nothing called', async () => {
    pendingPhoto({ status: 'approved' });
    const res = await tool('review_image').handler({ image_id: oid('1'), decision: 'public' }, SOMM_CTX);
    expect(parse(res).error.code).toBe('conflict');
    expect(ops.approveImage).not.toHaveBeenCalled();
  });

  test('"public" publishes WITHOUT making it the main picture; side is recorded; the ledger row is written', async () => {
    pendingPhoto();
    ops.approveImage.mockResolvedValue(approved({ madeOfficial: false, replacedImage: null }));

    const res = await tool('review_image').handler({ image_id: oid('1'), decision: 'public', side: 'back' }, SOMM_CTX);

    expect(ops.approveImage).toHaveBeenCalledWith(expect.objectContaining({
      imageId: oid('1'), actorId: ME, visibility: 'public', official: false, replaceMain: false, via: 'mcp',
    }));
    expect(BottleImage.updateOne).toHaveBeenCalledWith({ _id: oid('1') }, { $set: { side: 'back' } });
    const body = parse(res);
    expect(body.data).toMatchObject({ decision: 'public', was: 'pending', main_picture: false, side: 'back', uploader_notified: true });
    expect(McpActionLog.create).toHaveBeenCalledWith(expect.objectContaining({ tool: 'review_image', action: 'somm_image_review' }));
  });

  test('"public_main" asks for the main picture, and a wine that has one comes back as a conflict with a hint', async () => {
    pendingPhoto();
    ops.approveImage.mockResolvedValue({ ok: false, code: 'conflict', message: 'The wine already has a picture', currentPicture: '/x.webp' });
    Bottle.findById.mockReturnValue(chain({ wineDefinition: oid('f') }));

    const res = await tool('review_image').handler({ image_id: oid('1'), decision: 'public_main' }, SOMM_CTX);

    expect(ops.approveImage).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'public', official: true, replaceMain: false }));
    const err = parse(res).error;
    expect(err.code).toBe('conflict');
    expect(err.message).toContain(`get_photo (wine_id ${oid('f')})`);
    expect(err.message).toContain('Nothing was changed');
    expect(McpActionLog.create).not.toHaveBeenCalled();
  });

  test('"private" approves for the uploader only', async () => {
    pendingPhoto();
    ops.approveImage.mockResolvedValue(approved({ madeOfficial: false }));
    await tool('review_image').handler({ image_id: oid('1'), decision: 'private' }, SOMM_CTX);
    expect(ops.approveImage).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'private', official: false }));
  });

  test('"reject" passes the reason through and never records a side', async () => {
    pendingPhoto();
    ops.rejectImage.mockResolvedValue(approved());
    await tool('review_image').handler({ image_id: oid('1'), decision: 'reject', reason: 'This is a different wine.', side: 'front' }, SOMM_CTX);
    expect(ops.rejectImage).toHaveBeenCalledWith(expect.objectContaining({ reason: 'This is a different wine.', via: 'mcp' }));
    expect(BottleImage.updateOne).not.toHaveBeenCalled();
  });

  describe('on a reported photo', () => {
    const reportedPhoto = (visibility = 'public') => pendingPhoto({ status: 'approved', visibility, reportedAt: new Date() });

    test('"public" on a published photo dismisses the report', async () => {
      reportedPhoto();
      ops.dismissImageReport.mockResolvedValue(approved());
      const res = await tool('review_image').handler({ image_id: oid('1'), decision: 'public' }, SOMM_CTX);
      expect(ops.dismissImageReport).toHaveBeenCalled();
      expect(parse(res).data).toMatchObject({ was: 'reported', uploader_notified: false });
    });

    test('"private" takes it out of the gallery and answers the report', async () => {
      reportedPhoto();
      ops.setImageVisibility.mockResolvedValue(approved());
      await tool('review_image').handler({ image_id: oid('1'), decision: 'private' }, SOMM_CTX);
      expect(ops.setImageVisibility).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'private', clearReport: true }));
    });

    test('"public_main" makes it the picture without replacing one unless asked', async () => {
      reportedPhoto();
      ops.setOfficialImage.mockResolvedValue(approved({ replacedImage: null }));
      await tool('review_image').handler({ image_id: oid('1'), decision: 'public_main' }, SOMM_CTX);
      expect(ops.setOfficialImage).toHaveBeenCalledWith(expect.objectContaining({ replaceMain: false, clearReport: true }));
    });
  });
});
