/**
 * POST /api/bottles with `newWine` — mint-at-commit.
 *
 * WHY THIS TEST EXISTS:
 * The UI used to mint the shared WineDefinition in STEP 1 of the add flow
 * (POST /api/wines/find-or-create), before any bottle existed — an abandoned
 * form left an orphan registry row forever (31 zero-bottle createdVia:'ui'
 * rows on prod 2026-08-10; the "Domaine de Riquewihr — Kaefferkopf" case).
 * The wine is now resolved-or-minted INSIDE the bottle create, the same
 * commit-time pattern as import /confirm (#899) and the MCP add_bottle tool.
 *
 * Pinned here:
 *   - exactly one of wineDefinition | newWine (400 otherwise)
 *   - newWine mints ONCE via findOrCreateWine (ui/ai provenance, confirmCreate
 *     → skipSiblingMatch parity with the old find-or-create route), audits
 *     wine.create with the same detail shape, pings IndexNow, and creates the
 *     bottle in the same request (201)
 *   - soft-zone candidates → 200 { candidates }, and NOTHING is created
 *   - the shared field caps reject junk BEFORE the service runs
 *   - cellar access is checked BEFORE any registry work (a viewer can't mint)
 *   - the by-id path is byte-for-byte untouched (no findOrCreateWine call)
 *
 * Real router + real bottleOps + real wineCommit; findOrCreateWine and every
 * side-effect service are mocked (no MongoDB), following bottles.restore.test.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/search', () => ({
  getIsAvailable: () => false,
  search: async () => ({ ids: [] }),
  indexBottle: jest.fn(),
  removeBottle: jest.fn(),
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../services/embeddingJob', () => ({ embedSinglePair: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/enrichmentJob', () => ({ enrichWineById: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/restockChecker', () => ({
  checkRestockGap: jest.fn().mockResolvedValue(null),
  resolveRestockAlerts: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/imageProcessor', () => ({ unlinkImageFiles: jest.fn() }));
jest.mock('../services/priceWarnings', () => ({ gatherPriceWarnings: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/communityPrice', () => ({ getCurrentRelease: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({
  getOrCreateDailySnapshot: jest.fn().mockResolvedValue(null),
  getSnapshotForDate: jest.fn().mockResolvedValue(null),
}));
jest.mock('../utils/vintageProfile', () => ({
  ensurePendingVintageProfile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/Rack', () => ({ updateMany: jest.fn() }));
jest.mock('../models/Country', () => ({}));
jest.mock('../models/Region', () => ({}));
jest.mock('../models/Grape', () => ({}));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('../models/PriceTrackingRequest', () => ({}));
jest.mock('../models/BottleImage', () => ({}));
jest.mock('../models/WineRequest', () => ({}));
// Demo tokens make requireAuth confirm the account still exists.
jest.mock('../models/User', () => ({ exists: jest.fn(async () => ({ _id: 'demo1' })) }));
// Constructor-capable mock: bottleOps.addBottle does `new Bottle(doc)`.
jest.mock('../models/Bottle', () => {
  function MockBottle(doc) {
    Object.assign(this, doc);
    this._id = '64b0000000000000000000dd';
    this.save = jest.fn().mockResolvedValue(this);
    this.populate = jest.fn().mockResolvedValue(this);
    MockBottle.instances.push(this);
  }
  MockBottle.instances = [];
  MockBottle.findById = jest.fn();
  return MockBottle;
});

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const { findOrCreateWine } = require('../services/findOrCreateWine');
const { logAudit } = require('../services/audit');
const { submitUrls } = require('../services/indexNow');
const bottlesRouter = require('./bottles');

const USER_ID = '64b000000000000000000001';
const OTHER_ID = '64b000000000000000000002';
const CELLAR_ID = '64b0000000000000000000bb';
const WINE_ID = '64b0000000000000000000ff';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles', bottlesRouter);
  return app;
}

function post(body, { userId = USER_ID, isDemo = false } = {}) {
  const app = buildApp();
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          port: server.address().port,
          path: '/api/bottles',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            authorization: `Bearer ${jwt.sign(
              { id: userId, roles: ['user'], ...(isDemo ? { isDemo: true } : {}) },
              'test-secret', { algorithm: 'HS256', expiresIn: '1h' }
            )}`,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
          });
        }
      );
      req.on('error', (e) => { server.close(); reject(e); });
      req.end(payload);
    });
  });
}

const NEW_WINE = {
  name: 'Kaefferkopf', producer: 'Cave de Kaysersberg', country: 'France',
  region: 'Alsace', appellation: 'Alsace Grand Cru', type: 'white', grapes: ['Gewürztraminer'],
};
const WINE_DOC = { _id: WINE_ID, name: 'Kaefferkopf', producer: 'Cave de Kaysersberg', slug: 'kaefferkopf' };

const ownCellar = () =>
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, name: 'Main', user: USER_ID, members: [], deletedAt: null });

beforeEach(() => {
  jest.clearAllMocks();
  Bottle.instances.length = 0;
  ownCellar();
  findOrCreateWine.mockResolvedValue({ wine: WINE_DOC, created: true });
});

describe('POST /api/bottles — wine reference contract', () => {
  test('neither wineDefinition nor newWine is a 400; nothing runs', async () => {
    const { status, body } = await post({ cellar: CELLAR_ID, vintage: '2019' });

    expect(status).toBe(400);
    expect(body.error).toMatch(/wineDefinition or newWine/);
    expect(findOrCreateWine).not.toHaveBeenCalled();
    expect(Bottle.instances).toHaveLength(0);
  });

  test('BOTH wineDefinition and newWine is a 400; nothing runs', async () => {
    const { status, body } = await post({
      cellar: CELLAR_ID, vintage: '2019', wineDefinition: WINE_ID, newWine: NEW_WINE,
    });

    expect(status).toBe(400);
    expect(body.error).toMatch(/not both/);
    expect(findOrCreateWine).not.toHaveBeenCalled();
    expect(Bottle.instances).toHaveLength(0);
  });

  test('the by-id path is untouched: loads the wine, never calls findOrCreateWine, never audits wine.create', async () => {
    // findOne, not findById: the by-id path resolves through
    // services/wineVisibility so a stranger's pendingIdentity row answers the
    // same 404 a missing id does (security audit M-4).
    WineDefinition.findOne.mockResolvedValue(WINE_DOC);

    const { status, body } = await post({ cellar: CELLAR_ID, vintage: '2019', wineDefinition: WINE_ID });

    expect(status).toBe(201);
    expect(body.bottle).toBeTruthy();
    expect(findOrCreateWine).not.toHaveBeenCalled();
    expect(submitUrls).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalledWith(expect.anything(), 'wine.create', expect.anything(), expect.anything());
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'bottle.add',
      expect.objectContaining({ type: 'bottle' }), expect.objectContaining({ wineName: 'Kaefferkopf' }));
  });
});

describe('POST /api/bottles — newWine mints at commit', () => {
  test('mints ONCE, creates the bottle in the same request, audits wine.create via ui, pings IndexNow → 201', async () => {
    const { status, body } = await post({ cellar: CELLAR_ID, vintage: '2019', newWine: NEW_WINE });

    expect(status).toBe(201);
    expect(body.bottle).toBeTruthy();
    expect(Bottle.instances).toHaveLength(1);
    expect(String(Bottle.instances[0].wineDefinition)).toBe(WINE_ID);

    // one resolve/mint, with the SAME options contract the old
    // find-or-create route used (confirmCreate off → sibling matching on)
    expect(findOrCreateWine).toHaveBeenCalledTimes(1);
    const [fields, userId, opts] = findOrCreateWine.mock.calls[0];
    expect(fields).toMatchObject({ name: 'Kaefferkopf', producer: 'Cave de Kaysersberg', country: 'France' });
    expect(fields.grapes).toEqual(['Gewürztraminer']);
    expect(userId).toBe(USER_ID);
    // allowPending: the commit path files an incomplete identity instead of
    // 400-ing the user's bottle away (pending-identity wines).
    expect(opts).toEqual({ confirmCreate: false, skipSiblingMatch: false, createdVia: 'ui', allowPending: true });

    // audit parity with every other registry-write surface: same action name,
    // same detail shape — plus IndexNow on a real creation
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'wine.create',
      { type: 'wine', id: WINE_ID }, { via: 'ui', name: 'Kaefferkopf', producer: 'Cave de Kaysersberg' });
    expect(submitUrls).toHaveBeenCalledWith('/wines/kaefferkopf');
    // and the bottle add is audited as usual
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'bottle.add',
      expect.objectContaining({ type: 'bottle' }), expect.objectContaining({ wineName: 'Kaefferkopf', vintage: '2019' }));
  });

  test("source:'ai' stamps createdVia 'ai' (accepted AI suggestion); provenance is allowlisted", async () => {
    await post({ cellar: CELLAR_ID, vintage: '2019', newWine: { ...NEW_WINE, source: 'ai' } });
    expect(findOrCreateWine.mock.calls[0][2].createdVia).toBe('ai');
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'wine.create',
      expect.anything(), expect.objectContaining({ via: 'ai' }));

    jest.clearAllMocks();
    ownCellar();
    findOrCreateWine.mockResolvedValue({ wine: WINE_DOC, created: true });
    await post({ cellar: CELLAR_ID, vintage: '2019', newWine: { ...NEW_WINE, source: 'made-up' } });
    expect(findOrCreateWine.mock.calls[0][2].createdVia).toBe('ui');
  });

  test('confirmCreate rides through with skipSiblingMatch — the explicit "create anyway" is not overridden', async () => {
    await post({ cellar: CELLAR_ID, vintage: '2019', newWine: { ...NEW_WINE, confirmCreate: true } });

    expect(findOrCreateWine.mock.calls[0][2]).toEqual({
      confirmCreate: true, skipSiblingMatch: true, createdVia: 'ui', allowPending: true,
    });
  });

  test('resolved to an EXISTING wine (created:false): bottle is created, but no wine.create audit and no IndexNow', async () => {
    findOrCreateWine.mockResolvedValue({ wine: WINE_DOC, created: false });

    const { status } = await post({ cellar: CELLAR_ID, vintage: '2019', newWine: NEW_WINE });

    expect(status).toBe(201);
    expect(Bottle.instances).toHaveLength(1);
    expect(logAudit).not.toHaveBeenCalledWith(expect.anything(), 'wine.create', expect.anything(), expect.anything());
    expect(submitUrls).not.toHaveBeenCalled();
  });

  test('soft-zone candidates → 200 { candidates } and NOTHING is created (no bottle, no audit, no IndexNow)', async () => {
    findOrCreateWine.mockResolvedValue({
      wine: null,
      candidates: [{ wine: { _id: WINE_ID, name: 'Kaefferkopf', producer: 'Cave Vinicole' }, score: 0.9 }],
    });

    const { status, body } = await post({ cellar: CELLAR_ID, vintage: '2019', newWine: NEW_WINE });

    expect(status).toBe(200);
    expect(body.candidates).toHaveLength(1);
    expect(body.bottle).toBeUndefined();
    expect(Bottle.instances).toHaveLength(0);
    expect(logAudit).not.toHaveBeenCalled();
    expect(submitUrls).not.toHaveBeenCalled();
  });

  test('service mint gates (400-status throws, e.g. place-as-producer) surface as 400', async () => {
    const gateErr = new Error('"Bordeaux" is a wine region, not a producer — put the actual winery in the producer field');
    gateErr.status = 400;
    findOrCreateWine.mockRejectedValue(gateErr);

    const { status, body } = await post({ cellar: CELLAR_ID, vintage: '2019', newWine: NEW_WINE });

    expect(status).toBe(400);
    expect(body.error).toMatch(/not a producer/);
    expect(Bottle.instances).toHaveLength(0);
  });
});

describe('POST /api/bottles — newWine validation caps (shared with the resolve route)', () => {
  test.each([
    // NAME stays hard-required on a commit path: a wine with no name is not an
    // incomplete identity, it is no identity at all. PRODUCER deliberately is
    // NOT here any more — see the pending-identity test below.
    ['missing name', { ...NEW_WINE, name: '' }, /name is required/],
    ['missing country', { ...NEW_WINE, country: undefined }, /country/],
    ['over-long name', { ...NEW_WINE, name: 'x'.repeat(201) }, /200 characters/],
    ['over-long region', { ...NEW_WINE, region: 'x'.repeat(201) }, /region/],
    ['grapes not an array', { ...NEW_WINE, grapes: 'Shiraz' }, /array/],
    ['21 grapes', { ...NEW_WINE, grapes: [...Array(21).keys()].map(String) }, /at most 20/],
    ['non-string grape', { ...NEW_WINE, grapes: [7] }, /each grape/],
  ])('%s → 400 before the service runs', async (_label, newWine, msg) => {
    const { status, body } = await post({ cellar: CELLAR_ID, vintage: '2019', newWine });

    expect(status).toBe(400);
    expect(body.error).toMatch(msg);
    expect(findOrCreateWine).not.toHaveBeenCalled();
    expect(Bottle.instances).toHaveLength(0);
  });

  // The behaviour change this feature exists for: an unreadable/absent producer
  // no longer refuses the add. The route hands it to the service, which files a
  // pendingIdentity row — the BOTTLE is what the user came for.
  test.each([
    ['absent producer', undefined],
    ['empty producer', ''],
    ['sentinel producer', 'Unknown'],
    ['non-string producer', 42],
  ])('%s no longer 400s — the bottle is created and the wine goes to the pending queue', async (_label, producer) => {
    findOrCreateWine.mockResolvedValue({
      wine: { ...WINE_DOC, producer: '', pendingIdentity: true },
      created: true,
      pendingIdentity: true,
    });

    const { status } = await post({
      cellar: CELLAR_ID, vintage: '2019', newWine: { ...NEW_WINE, producer },
    });

    expect(status).toBe(201);
    expect(findOrCreateWine).toHaveBeenCalledTimes(1);
    expect(Bottle.instances).toHaveLength(1);
    // A pending row has no public page — nothing is announced to IndexNow.
    expect(submitUrls).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'wine.create',
      expect.anything(), expect.objectContaining({ pendingIdentity: true, producer: null }));
  });
});

describe('POST /api/bottles — access gates run BEFORE any registry work', () => {
  test('a viewer cannot mint through a cellar they cannot add to (403, service untouched)', async () => {
    Cellar.findById.mockResolvedValue({
      _id: CELLAR_ID, name: 'Shared', user: OTHER_ID,
      members: [{ user: USER_ID, role: 'viewer' }], deletedAt: null,
    });

    const { status } = await post({ cellar: CELLAR_ID, vintage: '2019', newWine: NEW_WINE });

    expect(status).toBe(403);
    expect(findOrCreateWine).not.toHaveBeenCalled();
  });

  test('a demo account is rejected with 403 before anything runs (requireNonDemo)', async () => {
    const { status } = await post(
      { cellar: CELLAR_ID, vintage: '2019', newWine: NEW_WINE },
      { userId: 'demo1', isDemo: true }
    );

    expect(status).toBe(403);
    expect(findOrCreateWine).not.toHaveBeenCalled();
    expect(Bottle.instances).toHaveLength(0);
  });
});
