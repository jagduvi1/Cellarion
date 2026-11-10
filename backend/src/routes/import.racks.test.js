/**
 * POST /api/bottles/import/confirm — the racks a file names.
 *
 * An import file may say where each bottle lies (a rack name plus a slot).
 * Pinned as the endpoint behaves today:
 *   - a rack the cellar does not have is created before the bottles are, from
 *     the dimensions the file implies; one that exists by name is left alone
 *   - what the user chose in the review (rackConfigs) wins over what the file
 *     implies; a skipped rack is not created and its bottles are imported
 *     without a place
 *   - a created rack belongs to the cellar's OWNER, also when an editor imports
 *   - a cabinet is stored with one shelf entry per shelf; disabled positions
 *     beyond the rack are dropped
 *   - a rack that cannot be created never fails the import
 *   - bottles take the slot the file gives; a second bottle on a taken slot
 *     moves to the nearest free one; what cannot be placed is reported per row
 *     and the bottle is imported anyway
 *
 * The pure parts (plan, positions, the configuration check) have their own
 * unit tests in utils/rackImport.test.js. Real router, requireAuth (HS256
 * test tokens) and rack helpers; the models are mocked.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/search', () => ({
  getIsAvailable: () => false,
  search: async () => ({ ids: [] }),
  indexWine: () => {},
  bulkIndexBottles: jest.fn(),
}));
jest.mock('../services/labelScan', () => ({ identifyWineFromText: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../middleware/aiBurstLimiter', () => (req, res, next) => next());
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({ getOrCreateDailySnapshot: jest.fn().mockResolvedValue(null) }));
jest.mock('../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn().mockResolvedValue(undefined) }));

jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn(), find: jest.fn() }));
// The visibility rule has its own suites; here every wine id resolves.
jest.mock('../services/wineVisibility', () => ({
  wineVisibilityFilter: () => ({}),
  findVisibleWine: (id) => require('../models/WineDefinition').findById(id),
}));
jest.mock('../models/Country', () => ({ findOne: jest.fn() }));
jest.mock('../models/ImportSession', () => ({ deleteMany: jest.fn().mockResolvedValue({}) }));
jest.mock('../models/ImportArchive', () => ({ create: jest.fn(() => Promise.resolve({})) }));
jest.mock('../models/WishlistItem', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../models/WineRequest', () => {
  function WineRequest() {}
  WineRequest.findOne = jest.fn().mockResolvedValue(null);
  return WineRequest;
});

// Constructor mocks keep every instance, so a test can read what the route
// stored. The schema defaults the route relies on are set by hand.
jest.mock('../models/Bottle', () => {
  const instances = [];
  function Bottle(data) {
    this.status = 'active';
    Object.assign(this, data);
    this._id = `bottle-${instances.length}`;
    this.save = jest.fn().mockResolvedValue(this);
    instances.push(this);
  }
  Bottle.__instances = instances;
  return Bottle;
});
jest.mock('../models/Rack', () => {
  const instances = [];
  function Rack(data) {
    this.slots = [];
    this.disabledPositions = [];
    Object.assign(this, data);
    this._id = `rack-${instances.length}`;
    this.save = jest.fn().mockResolvedValue(this);
    instances.push(this);
  }
  Rack.__instances = instances;
  Rack.RACK_TYPES = jest.requireActual('../models/Rack').RACK_TYPES;
  Rack.find = jest.fn();
  Rack.findOne = jest.fn();
  return Rack;
});

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const Rack = require('../models/Rack');
const { logAudit } = require('../services/audit');
const importRouter = require('./import');

const USER_ID = '64b000000000000000000001';
const OWNER_ID = '64b000000000000000000002';
const CELLAR_ID = '64b0000000000000000000bb';
const WINE_ID = '64b0000000000000000000cc';

function confirm(items, extra = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/bottles/import', importRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = JSON.stringify({ cellarId: CELLAR_ID, items, ...extra });
      const req = http.request(
        {
          port: server.address().port,
          path: '/api/bottles/import/confirm',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            authorization: `Bearer ${jwt.sign({ id: USER_ID, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' })}`,
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
      req.write(payload);
      req.end();
    });
  });
}

// One bottle of the test wine in a named rack.
const row = (rackName, fields = {}) => ({ wineDefinition: WINE_ID, vintage: '2018', rackName, ...fields });
// The racks the cellar already has, as the lookup before creation sees them.
const cellarHasRacks = (names) => Rack.find.mockReturnValue({ select: () => ({ lean: async () => names.map((name) => ({ name })) }) });
const auditOf = (action) => logAudit.mock.calls.filter((c) => c[1] === action);

let consoleError;

beforeEach(() => {
  jest.clearAllMocks();
  Bottle.__instances.length = 0;
  Rack.__instances.length = 0;
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, name: 'Main', user: USER_ID, members: [], deletedAt: null });
  WineDefinition.findById.mockResolvedValue({ _id: WINE_ID, name: 'Test Wine', producer: 'Test Prod' });
  cellarHasRacks([]);
  // The placement step loads each rack by name: here, the one just created.
  Rack.findOne.mockImplementation(async ({ name }) => Rack.__instances.find((r) => r.name === name) || null);
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('creating the racks a file names', () => {
  test('a rack the cellar does not have is created from what the file implies, and audited', async () => {
    const { status, body } = await confirm([row('Kitchen', { rackPosition: 3 }), row('Kitchen', { rackPosition: 9 })]);

    expect(status).toBe(200);
    expect(Rack.find).toHaveBeenCalledWith({ cellar: CELLAR_ID, name: { $in: ['Kitchen'] }, deletedAt: null });
    expect(Rack.__instances).toHaveLength(1);
    const rack = Rack.__instances[0];
    // Highest slot 9: two rows of six.
    expect(rack).toMatchObject({ cellar: CELLAR_ID, user: USER_ID, name: 'Kitchen', type: 'grid', rows: 2, cols: 6 });
    expect(rack.typeConfig).toBeUndefined();
    expect(rack.save).toHaveBeenCalled();
    expect(body.racksCreated).toEqual([{ name: 'Kitchen', type: 'grid', rows: 2, cols: 6 }]);

    expect(auditOf('rack.create')).toHaveLength(1);
    expect(auditOf('rack.create')[0].slice(2)).toEqual([
      { type: 'rack', id: rack._id, cellarId: CELLAR_ID },
      { source: 'import', name: 'Kitchen' },
    ]);
    expect(auditOf('bottle.import')[0][3]).toMatchObject({ racksCreated: 1, placed: 2, overflowed: 0, unplaced: 0 });
  });

  test('each rack is created once, however many rows name it; a row without a rack creates none', async () => {
    const { body } = await confirm([row('A', { rackPosition: 1 }), row('B', { rackPosition: 1 }), row('A', { rackPosition: 2 }), row(undefined)]);

    expect(body.created).toBe(4);
    expect(Rack.__instances.map((r) => r.name)).toEqual(['A', 'B']);
    expect(body.racksCreated.map((r) => r.name)).toEqual(['A', 'B']);
  });

  test('a rack the cellar already has by name is not created again', async () => {
    cellarHasRacks(['Kitchen']);
    const existing = { _id: 'rack-existing', name: 'Kitchen', type: 'grid', rows: 2, cols: 6, slots: [], disabledPositions: [], save: jest.fn().mockResolvedValue() };
    Rack.findOne.mockResolvedValue(existing);

    const { body } = await confirm([row('Kitchen', { rackPosition: 4 })]);

    expect(Rack.__instances).toHaveLength(0);
    expect(body.racksCreated).toEqual([]);
    expect(auditOf('rack.create')).toHaveLength(0);
    // The bottle still goes into the existing rack.
    expect(body.placed).toBe(1);
    expect(existing.slots).toEqual([{ position: 4, bottle: 'bottle-0' }]);
  });

  test('a created rack belongs to the cellar owner when an editor imports', async () => {
    Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, name: 'Shared', user: OWNER_ID, members: [{ user: USER_ID, role: 'editor' }], deletedAt: null });

    await confirm([row('Kitchen', { rackPosition: 1 })]);

    expect(Rack.__instances[0].user).toBe(OWNER_ID);
    expect(auditOf('rack.create')[0][2]).toEqual({ type: 'rack', id: 'rack-0', cellarId: CELLAR_ID });
  });

  test('the type comes from the file; one the model does not know becomes a grid', async () => {
    const { body } = await confirm([row('S', { rackPosition: 1, rackType: 'Shelf' }), row('P', { rackPosition: 1, rackType: 'pyramid' })]);

    expect(Rack.__instances.map((r) => [r.name, r.type])).toEqual([['S', 'shelf'], ['P', 'grid']]);
    expect(body.racksCreated.map((r) => r.type)).toEqual(['shelf', 'grid']);
  });
});

describe('what the user chose in the review (rackConfigs)', () => {
  test('wins over the dimensions and the type the file implies', async () => {
    const { body } = await confirm(
      [row('Kitchen', { rackPosition: 3 })],
      { rackConfigs: { Kitchen: { rows: 5, cols: 8, type: 'shelf', typeConfig: { bottlesPerCell: 2 } } } },
    );

    expect(Rack.__instances[0]).toMatchObject({ name: 'Kitchen', type: 'shelf', rows: 5, cols: 8, typeConfig: { bottlesPerCell: 2 } });
    expect(body.racksCreated).toEqual([{ name: 'Kitchen', type: 'shelf', rows: 5, cols: 8, typeConfig: { bottlesPerCell: 2 } }]);
  });

  test('a skipped rack is not created, and its bottles are imported without a place', async () => {
    const { body } = await confirm([row('Kitchen', { rackPosition: 3 })], { rackConfigs: { Kitchen: { skip: true } } });

    expect(Rack.__instances).toHaveLength(0);
    expect(body).toMatchObject({ created: 1, racksCreated: [], placed: 0, unplaced: [] });
    // Not looked up for placement either.
    expect(Rack.findOne).not.toHaveBeenCalled();
    expect(Bottle.__instances).toHaveLength(1);
  });

  test('a cabinet is stored with one shelf entry per shelf, also when none was sent', async () => {
    await confirm([row('Fridge', { rackPosition: 1 })], { rackConfigs: { Fridge: { rows: 3, cols: 6, type: 'cabinet' } } });

    const rack = Rack.__instances[0];
    expect(rack).toMatchObject({ type: 'cabinet', rows: 3, cols: 6 });
    expect(rack.typeConfig.shelfRows).toHaveLength(3);
  });

  test('disabled positions beyond the created rack are dropped', async () => {
    await confirm([row('Kitchen', { rackPosition: 1 })], { rackConfigs: { Kitchen: { rows: 2, cols: 3, disabledPositions: [2, 6, 7, 99] } } });

    expect(Rack.__instances[0].disabledPositions).toEqual([2, 6]);
  });
});

describe('a rack that cannot be created', () => {
  test('never fails the import: the bottle is created and reported as not placed', async () => {
    Rack.find.mockReturnValue({ select: () => ({ lean: async () => { throw new Error('lookup down'); } }) });

    const { status, body } = await confirm([row('Kitchen', { rackPosition: 3 })]);

    expect(status).toBe(200);
    expect(body).toMatchObject({ created: 1, racksCreated: [], placed: 0 });
    expect(body.unplaced).toEqual([{ sourceIndex: 0, rackName: 'Kitchen', requestedPosition: null, reason: 'Rack not found' }]);
    expect(auditOf('bottle.import')[0][3]).toMatchObject({ racksCreated: 0, placed: 0, unplaced: 1 });
  });
});

describe('placing the bottles', () => {
  test('each bottle takes the slot the file gives', async () => {
    const { body } = await confirm([row('Kitchen', { rackPosition: 3 }), row('Kitchen', { rackPosition: 9 })]);

    expect(body).toMatchObject({ created: 2, placed: 2, overflowed: 0, unplaced: [] });
    expect(Rack.__instances[0].slots).toEqual([
      { position: 3, bottle: 'bottle-0' },
      { position: 9, bottle: 'bottle-1' },
    ]);
    // Once to create the rack, once to store the slots.
    expect(Rack.__instances[0].save).toHaveBeenCalledTimes(2);
  });

  test('a row and column are read from the corner the file numbers from', async () => {
    const items = [row('Kitchen', { row: 1, col: 1, rackRows: 2, rackCols: 3 })];
    await confirm(items);
    expect(Rack.__instances[0].slots).toEqual([{ position: 1, bottle: 'bottle-0' }]);

    Rack.__instances.length = 0;
    Bottle.__instances.length = 0;
    await confirm(items, { positionAnchor: 'bottom-right' });
    expect(Rack.__instances[0].slots).toEqual([{ position: 6, bottle: 'bottle-0' }]);
  });

  test('a second bottle on a taken slot moves to the next free one, or back from the end of the rack, and counts as overflowed', async () => {
    const { body } = await confirm(
      [row('Kitchen', { rackPosition: 6 }), row('Kitchen', { rackPosition: 6 }), row('Kitchen', { rackPosition: 3 }), row('Kitchen', { rackPosition: 3 })],
      { rackConfigs: { Kitchen: { rows: 1, cols: 6 } } },
    );

    expect(body).toMatchObject({ placed: 4, overflowed: 2, unplaced: [] });
    // Every bottle with a free slot first, then the others in file order.
    expect(Rack.__instances[0].slots).toEqual([
      { position: 6, bottle: 'bottle-0' },
      { position: 3, bottle: 'bottle-2' },
      { position: 5, bottle: 'bottle-1' },
      { position: 4, bottle: 'bottle-3' },
    ]);
  });

  test('a slot beyond the rack is reported for its row; the bottle is imported anyway', async () => {
    const { body } = await confirm(
      [row('Kitchen', { rackPosition: 2 }), row('Kitchen', { rackPosition: 40 })],
      { rackConfigs: { Kitchen: { rows: 1, cols: 4 } } },
    );

    expect(body).toMatchObject({ created: 2, placed: 1 });
    expect(body.unplaced).toEqual([
      { sourceIndex: 1, requestedPosition: 40, reason: 'Slot 40 exceeds rack capacity (4)', rackName: 'Kitchen' },
    ]);
  });

  test('a bottle imported straight to history is not placed', async () => {
    const { body } = await confirm([row('Kitchen', { rackPosition: 3, addToHistory: true })]);

    expect(body).toMatchObject({ created: 1, createdHistory: 1, placed: 0, unplaced: [] });
    // The rack is still created: the plan is made from the file, before the bottles.
    expect(Rack.__instances).toHaveLength(1);
    expect(Rack.__instances[0].slots).toEqual([]);
  });

  test('slots that could not be stored are reported as not placed, never counted', async () => {
    cellarHasRacks(['Kitchen']);
    Rack.findOne.mockResolvedValue({
      _id: 'rack-existing', name: 'Kitchen', type: 'grid', rows: 2, cols: 6, slots: [], disabledPositions: [],
      save: jest.fn().mockRejectedValue(new Error('version conflict')),
    });

    const { status, body } = await confirm([row('Kitchen', { rackPosition: 5 })]);

    expect(status).toBe(200);
    expect(body).toMatchObject({ created: 1, placed: 0, overflowed: 0 });
    expect(body.unplaced).toEqual([
      { sourceIndex: 0, rackName: 'Kitchen', requestedPosition: 5, reason: 'Rack save failed: version conflict' },
    ]);
  });

  test('a rack that cannot be loaded leaves its rows unplaced with the reason, and the other racks placed', async () => {
    Rack.findOne.mockImplementation(async ({ name }) => {
      if (name === 'Bad') throw new Error('read failed');
      return Rack.__instances.find((r) => r.name === name) || null;
    });

    const { body } = await confirm([row('Bad', { rackPosition: 1 }), row('Good', { rackPosition: 1 })]);

    expect(body).toMatchObject({ created: 2, placed: 1 });
    expect(body.unplaced).toEqual([{ sourceIndex: 0, rackName: 'Bad', requestedPosition: null, reason: 'read failed' }]);
    expect(Rack.findOne).toHaveBeenCalledWith({ cellar: CELLAR_ID, name: 'Good', deletedAt: null });
  });
});
