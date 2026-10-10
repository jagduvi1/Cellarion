/**
 * GET /api/cellars/:id/vintages/:wineId/:vintage — one wine and vintage in a
 * cellar, the page behind a grouped "n identical bottles" entry (support
 * ticket 2026-10-09).
 *
 * WHY THIS TEST EXISTS:
 * The grouped cellar list had no page for a group; a click only expanded it.
 * This route is a VIEW over data that already exists: the bottles of that
 * wine and vintage in THIS cellar (never another cellar's, never a drunk or
 * on-order one in the list), each with its rack slot, what every bottle
 * shares (a note or window identical on all of them, shown once), how many
 * are on order or already drunk, and a bottle id the page hands to the
 * bottle-keyed history and personal-data cards. Any member may look; a
 * stranger gets 404 like every other cellar route.
 *
 * Real router + real requireAuth (HS256 test token); the models are small
 * in-memory fakes.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/bottleSearch', () => ({ searchBottles: jest.fn(), bottleFacets: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/rackOps', () => ({ createCellar: jest.fn() }));
jest.mock('../services/notifications', () => ({ createNotification: jest.fn() }));
jest.mock('../services/cellarTransfer', () => ({ transferCellarOwnership: jest.fn() }));
jest.mock('../services/mailgun', () => ({ sendCellarInviteEmail: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({ getSnapshotsForDates: jest.fn(), getOrCreateDailySnapshot: jest.fn(), convertCurrency: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn(), aggregate: jest.fn() }));
jest.mock('../models/Rack', () => ({ find: jest.fn() }));
jest.mock('../models/CellarLayout', () => ({ findOne: jest.fn() }));
jest.mock('../models/BottleImage', () => ({ find: jest.fn() }));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn() }));
jest.mock('../models/User', () => ({}));
jest.mock('../models/AuditLog', () => ({}));
jest.mock('../models/PendingShare', () => ({}));
jest.mock('../models/ClimateDevice', () => ({}));
jest.mock('../models/WineRequest', () => ({}));
jest.mock('../models/Country', () => ({}));
jest.mock('../models/Region', () => ({}));
jest.mock('../models/Grape', () => ({}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const Rack = require('../models/Rack');
const CellarLayout = require('../models/CellarLayout');
const BottleImage = require('../models/BottleImage');
const WineVintageProfile = require('../models/WineVintageProfile');
const WineDefinition = require('../models/WineDefinition');
const cellarsRouter = require('./cellars');

const USER_ID = '64b000000000000000000001';
const STRANGER = '64b000000000000000000002';
const CELLAR_ID = '64b0000000000000000000c1';
const WINE = '64b0000000000000000000aa';
const OTHER_WINE = '64b0000000000000000000ab';
const RACK = '64b0000000000000000000ee';
const id = (n) => `64b0000000000000000000${String(n).padStart(2, '0')}`;

function request(url, userId = USER_ID) {
  const app = express();
  app.use(express.json());
  app.use('/api/cellars', cellarsRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request({
        port: server.address().port, path: url, method: 'GET',
        headers: { authorization: `Bearer ${jwt.sign({ id: userId, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' })}` },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

const wineDoc = { _id: WINE, name: 'Château Margaux', producer: 'Château Margaux', image: '/api/uploads/processed/registry.webp' };
let ROWS;
let profileSelect;
const row = (n, over = {}) => ({
  _id: id(n), cellar: CELLAR_ID, user: USER_ID, wineDefinition: WINE, vintage: '2015', status: 'active',
  notes: 'Bought en primeur', drinkFrom: 2025, drinkTo: 2045, addedToCellarAt: new Date(Date.UTC(2026, 0, n)), ...over,
});

const inStatus = (r, filter) => {
  const s = filter.status;
  if (!s) return true;
  if (typeof s === 'string') return r.status === s;
  if (s.$in) return s.$in.includes(r.status);
  if (s.$nin) return !s.$nin.includes(r.status);
  return true;
};
const matchesVintage = (r, v) => (v && v.$in ? v.$in.includes(r.vintage) : r.vintage === v);
const matches = (r, filter) => {
  if (filter.user) return false; // the sibling-photo lookup in attachBottleImageUrls
  if (filter._id && filter._id.$in) return filter._id.$in.map(String).includes(r._id);
  return String(filter.cellar) === r.cellar && String(filter.wineDefinition) === r.wineDefinition
    && matchesVintage(r, filter.vintage) && inStatus(r, filter);
};
function bottleQuery(filter) {
  const q = {
    populate: () => q, select: () => q, sort: () => q, limit: () => q,
    lean: async () => ROWS.filter((r) => matches(r, filter)).map((r) => ({ ...r, wineDefinition: wineDoc })),
  };
  return q;
}

beforeEach(() => {
  jest.clearAllMocks();
  ROWS = [
    row(11),
    row(12),
    row(13, { vintage: '2016' }),                      // another vintage
    row(14, { wineDefinition: OTHER_WINE }),           // another wine
    row(15, { status: 'ordered' }),                    // on order: counted, not listed
    row(16, { status: 'drank', consumedAt: new Date() }), // drunk: counted, not listed
    row(17, { cellar: '64b0000000000000000000c2' }),   // another cellar: never
  ];
  const cellar = { _id: CELLAR_ID, name: 'Home', user: { _id: USER_ID, username: 'me' }, members: [], deletedAt: null, userColors: [] };
  Cellar.findById.mockImplementation(() => ({ populate: () => ({ lean: async () => cellar }) }));
  Bottle.find.mockImplementation(bottleQuery);
  Bottle.findOne.mockImplementation((filter) => ({
    populate: () => ({ sort: () => ({ lean: async () => ROWS.filter((r) => matches(r, filter)).map((r) => ({ ...r, wineDefinition: wineDoc }))[0] || null }) }),
  }));
  Bottle.countDocuments.mockImplementation(async (filter) => ROWS.filter((r) => matches(r, filter)).length);
  Rack.find.mockReturnValue({ select: () => ({ lean: async () => [
    { _id: RACK, name: 'Left wall', group: null, slots: [{ position: 3, bottle: id(11) }, { position: 9, bottle: id(99) }] },
  ] }) });
  CellarLayout.findOne.mockReturnValue({ select: () => ({ lean: async () => ({ rackPlacements: [{ rack: RACK }] }) }) });
  const imageChain = { sort: () => imageChain, lean: async () => [] };
  BottleImage.find.mockReturnValue(imageChain);
  WineVintageProfile.find.mockReturnValue({ lean: async () => [] });
  profileSelect = jest.fn(() => ({ lean: async () => ({ _id: WINE, aiProfile: { description: 'Cassis and cedar.', body: 'full', flavors: ['cassis'], source: 'curator' } }) }));
  WineDefinition.findById.mockReturnValue({ select: profileSelect });
});

const url = (vintage = '2015', wine = WINE, cellar = CELLAR_ID) => `/api/cellars/${cellar}/vintages/${wine}/${vintage}`;

describe('GET /api/cellars/:id/vintages/:wineId/:vintage', () => {
  test('lists only this cellar\'s in-cellar bottles of the wine and vintage, with their slots, and counts the rest', async () => {
    const { status, body } = await request(url());
    expect(status).toBe(200);
    expect(body.vintage).toBe('2015');
    expect(body.wine.name).toBe('Château Margaux');
    expect(body.bottles.map((b) => b._id)).toEqual([id(11), id(12)]);
    expect(body.total).toBe(2);
    expect(body.onOrderCount).toBe(1);
    expect(body.consumedCount).toBe(1);
    expect(body.historyBottleId).toBe(id(11));
    expect(body.cellar).toEqual(expect.objectContaining({ _id: CELLAR_ID, name: 'Home', userRole: 'owner' }));
    // Slots: 11 is in the rack (and the rack is in the 3D room), 12 is not placed.
    expect(body.bottles[0].rackInfo).toEqual({ rackId: RACK, rackName: 'Left wall', rackGroup: null, position: 3, inRoom: true });
    expect(body.bottles[1].rackInfo).toBeNull();
    expect(Rack.find).toHaveBeenCalledWith({ cellar: CELLAR_ID, deletedAt: null, 'slots.bottle': { $in: [id(11), id(12)] } });
    // The on-order and drunk counts are scoped exactly like the list.
    expect(Bottle.countDocuments).toHaveBeenCalledWith(expect.objectContaining({ cellar: CELLAR_ID, wineDefinition: WINE, vintage: '2015', status: 'ordered' }));
  });

  test('what every bottle shares is reported once; a value that differs between bottles is not', async () => {
    let { body } = await request(url());
    expect(body.shared).toEqual({ notes: 'Bought en primeur', drinkFrom: 2025, drinkTo: 2045, peakFrom: null, peakUntil: null });

    ROWS[1].notes = 'Gift from Anna';
    ROWS[1].drinkTo = null;
    ({ body } = await request(url()));
    expect(body.shared.notes).toBeNull();
    expect(body.shared.drinkFrom).toBe(2025);
    expect(body.shared.drinkTo).toBeNull();
  });

  test('NV matches the bottles the grouped list files under NV (an empty or missing vintage too)', async () => {
    ROWS.push(row(21, { vintage: 'NV' }), row(22, { vintage: '' }), row(23, { vintage: null }));
    const { body } = await request(url('NV'));
    expect(body.bottles.map((b) => b._id)).toEqual([id(21), id(22), id(23)]);
    expect(Bottle.find.mock.calls[0][0].vintage).toEqual({ $in: ['NV', '', null] });
  });

  test('a vintage that is all history still has a page: the wine comes from a drunk bottle, nothing is listed', async () => {
    ROWS = ROWS.filter((r) => !(r.vintage === '2015' && r.status === 'active' && r.cellar === CELLAR_ID));
    const { status, body } = await request(url());
    expect(status).toBe(200);
    expect(body.bottles).toEqual([]);
    expect(body.wine.name).toBe('Château Margaux');
    expect(body.consumedCount).toBe(1);
    expect(body.historyBottleId).toBe(id(16));
    expect(body.shared.notes).toBeNull();
  });

  test('nothing of that wine and vintage here → 404; a stranger → 404; bad ids → 400', async () => {
    expect((await request(url('1999'))).status).toBe(404);
    expect((await request(url(), STRANGER)).status).toBe(404);
    expect((await request(url('2015', 'not-an-id'))).status).toBe(400);
  });

  test('the wine carries its tasting profile — the display fields only — and a failed lookup leaves it out, never a 500', async () => {
    let { status, body } = await request(url());
    expect(status).toBe(200);
    expect(body.wine.aiProfile).toEqual({ description: 'Cassis and cedar.', body: 'full', flavors: ['cassis'], source: 'curator' });
    // Only the prose and descriptors the page shows are read, never the
    // registry's bookkeeping (confidence, held reason, producer doubts).
    expect(WineDefinition.findById).toHaveBeenCalledWith(WINE);
    const fields = profileSelect.mock.calls[0][0].split(' ');
    expect(fields).toEqual(expect.arrayContaining(['aiProfile.description', 'aiProfile.flavors', 'aiProfile.source']));
    expect(fields.some((f) => /confidence|held|producer/i.test(f))).toBe(false);

    WineDefinition.findById.mockReturnValue({ select: () => ({ lean: async () => { throw new Error('db down'); } }) });
    ({ status, body } = await request(url()));
    expect(status).toBe(200);
    expect(body.wine.name).toBe('Château Margaux');
    expect(body.wine.aiProfile).toBeUndefined();
  });

  test('a rack lookup failure degrades to "no slot shown", never a 500', async () => {
    Rack.find.mockReturnValue({ select: () => ({ lean: async () => { throw new Error('db down'); } }) });
    const { status, body } = await request(url());
    expect(status).toBe(200);
    expect(body.bottles.every((b) => b.rackInfo === null)).toBe(true);
  });
});
