/**
 * POST /api/bottles with `personalData` — custom fields typed on the add form.
 *
 * WHY THIS TEST EXISTS:
 * User ticket 6ab05cca asked to enter ABV while adding a bottle. The data
 * already existed (#986 personal typed entries) and ABV was already an
 * accepted public registry key — but both were reachable only from the bottle
 * page, so seven users had independently minted their own private "ABV" key
 * and the reporter, with 117 bottles, had never found the card at all.
 *
 * Pinned here:
 *   - fields ride the bottle create and reach the SHARED service, so the add
 *     form and the bottle page cannot drift on validation or visibility
 *   - dedupe is ON from this surface (a batch posts one wine-level field per
 *     bottle) and the level/vintageScoped flags survive the trip
 *   - a REJECTED field never fails the add: the bottle is still 201, and the
 *     reason rides back in customFieldErrors. The bottle exists by then, so a
 *     400 would be a lie and the form would strand a created bottle.
 *   - one bad field does not stop the next one
 *   - the array is bounded, and absent/empty `personalData` calls nothing
 *
 * Harness mirrors bottles.newWine.test.js: real router + real bottleOps, every
 * side-effect service mocked (no MongoDB).
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
jest.mock('../services/wineDraftOps', () => ({ touchDraft: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/embeddingJob', () => ({ embedSinglePair: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/enrichmentJob', () => ({ enrichWineById: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/restockChecker', () => ({
  checkRestockGap: jest.fn().mockResolvedValue(null),
  resolveRestockAlerts: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/imageProcessor', () => ({ unlinkImageFiles: jest.fn() }));
jest.mock('../services/priceWarnings', () => ({ gatherPriceWarnings: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/communityPrice', () => ({ getCurrentRelease: jest.fn() }));
jest.mock('../services/personalData', () => ({ createEntry: jest.fn() }));
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
jest.mock('../models/User', () => ({ exists: jest.fn(async () => ({ _id: 'demo1' })) }));
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
const { findVisibleWine } = require('../services/wineVisibility');
const personalData = require('../services/personalData');
const { logAudit } = require('../services/audit');
const bottlesRouter = require('./bottles');

jest.mock('../services/wineVisibility', () => ({ findVisibleWine: jest.fn() }));

const USER_ID = '64b000000000000000000001';
const CELLAR_ID = '64b0000000000000000000bb';
const WINE_ID = '64b0000000000000000000ff';
const KEY_ID = '64b000000000000000000ee1';

function post(body) {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles', bottlesRouter);
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
              { id: USER_ID, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' }
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

const ABV_FIELD = { level: 'wine', vintageScoped: true, keyId: KEY_ID, value: '13.5' };

const okEntry = (name = 'ABV') => ({
  ok: true,
  entry: { _id: '64b000000000000000000e01', key: { name } },
  keyCreated: false,
});

const base = (fields) => ({
  cellar: CELLAR_ID, wineDefinition: WINE_ID, vintage: '2019',
  ...(fields ? { personalData: fields } : {}),
});

beforeEach(() => {
  jest.clearAllMocks();
  Bottle.instances.length = 0;
  Cellar.findById.mockResolvedValue({
    _id: CELLAR_ID, name: 'Main', user: USER_ID, members: [], deletedAt: null,
  });
  findVisibleWine.mockResolvedValue({ _id: WINE_ID, name: 'Kaefferkopf', slug: 'kaefferkopf' });
  personalData.createEntry.mockResolvedValue(okEntry());
});

describe('POST /api/bottles — custom fields', () => {
  test('a field reaches the shared service with its level, scope and dedupe on', async () => {
    const { status, body } = await post(base([ABV_FIELD]));

    expect(status).toBe(201);
    expect(body.customFieldErrors).toBeUndefined();
    expect(personalData.createEntry).toHaveBeenCalledTimes(1);
    const [userId, bottle, spec, opts] = personalData.createEntry.mock.calls[0];
    expect(userId).toBe(USER_ID);
    expect(bottle).toBe(Bottle.instances[0]);
    expect(spec).toEqual({
      level: 'wine', keyId: KEY_ID, newKey: undefined, value: '13.5', vintageScoped: true,
    });
    // A batch posts the same wine-level field once per bottle; without this a
    // six-bottle add writes six identical rows onto one wine record.
    expect(opts).toEqual({ dedupe: true });
  });

  test('an unknown level is normalised to bottle, and vintageScoped only when literally true', async () => {
    await post(base([{ level: 'rack', value: 'x', vintageScoped: 'yes' }]));

    expect(personalData.createEntry.mock.calls[0][2]).toMatchObject({
      level: 'bottle', vintageScoped: false,
    });
  });

  test('a rejected field still returns 201 with the bottle, and reports why', async () => {
    personalData.createEntry.mockResolvedValue({
      ok: false, code: 'type_conflict', message: 'You already use "ABV" as a text key',
    });

    const { status, body } = await post(base([{ ...ABV_FIELD, newKey: { name: 'ABV' } }]));

    // The bottle exists by the time a field is written — a 400 here would
    // strand it, invisible to the form that just created it.
    expect(status).toBe(201);
    expect(body.bottle).toBeDefined();
    expect(body.customFieldErrors).toEqual([
      { key: 'ABV', error: 'You already use "ABV" as a text key' },
    ]);
  });

  test('one bad field does not stop the next', async () => {
    personalData.createEntry
      .mockResolvedValueOnce({ ok: false, code: 'invalid', message: 'not a number' })
      .mockResolvedValueOnce(okEntry('Cork'));

    const { status, body } = await post(base([
      { level: 'bottle', newKey: { name: 'ABV', type: 'decimal' }, value: 'abc' },
      { level: 'bottle', newKey: { name: 'Cork', type: 'text' }, value: 'sound' },
    ]));

    expect(status).toBe(201);
    expect(personalData.createEntry).toHaveBeenCalledTimes(2);
    expect(body.customFieldErrors).toEqual([{ key: 'ABV', error: 'not a number' }]);
  });

  test('a thrown service error is caught: the add survives and says so', async () => {
    personalData.createEntry.mockRejectedValue(new Error('mongo is down'));

    const { status, body } = await post(base([ABV_FIELD]));

    expect(status).toBe(201);
    expect(body.customFieldErrors).toEqual([{ key: null, error: 'Could not be saved' }]);
  });

  test('a successful field is audited as a personal-data write from this surface', async () => {
    await post(base([ABV_FIELD]));

    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(),
      'personal_data.entry_create',
      expect.objectContaining({ type: 'wine', cellarId: CELLAR_ID }),
      expect.objectContaining({ key: 'ABV', via: 'add-bottle' })
    );
  });

  test('a deduped hit writes no audit row — nothing happened', async () => {
    personalData.createEntry.mockResolvedValue({ ...okEntry(), deduped: true });

    const { status } = await post(base([ABV_FIELD]));

    expect(status).toBe(201);
    expect(logAudit).not.toHaveBeenCalledWith(
      expect.anything(), 'personal_data.entry_create', expect.anything(), expect.anything()
    );
  });

  test('the array is bounded at 20, and what was dropped is reported', async () => {
    const many = Array.from({ length: 23 }, (_, i) => ({
      level: 'bottle', newKey: { name: `k${i}`, type: 'text' }, value: 'v',
    }));

    const { body } = await post(base(many));

    expect(personalData.createEntry).toHaveBeenCalledTimes(20);
    // A silent truncation is the one failure the caller cannot see: the add
    // is 201 and the field simply is not there.
    expect(body.customFieldErrors).toEqual([
      { key: 'k20', error: 'Too many custom fields in one add (max 20)' },
      { key: 'k21', error: 'Too many custom fields in one add (max 20)' },
      { key: 'k22', error: 'Too many custom fields in one add (max 20)' },
    ]);
  });

  test('no personalData, an empty array, or a non-array calls nothing', async () => {
    await post(base());
    await post(base([]));
    await post({ ...base(), personalData: 'ABV=13.5' });

    expect(personalData.createEntry).not.toHaveBeenCalled();
  });
});
