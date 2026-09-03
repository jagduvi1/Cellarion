/**
 * POST /api/wine-lists/:id/add-bottles — the wines of many bottles onto a
 * list in one step (the cellar view's select mode, ticket 6a9949e3).
 *
 * Pinned: entries collapse on wine + vintage + size (a case of twelve is one
 * line; a second identical bottle is skipped as already_on_list), a wine
 * already on the ACTIVE container is skipped, a pendingIdentity wine is
 * refused (the list may be published), a bottle in a cellar the caller does
 * not own reads as not_found, and a custom-structured list needs a section
 * unless it has exactly one.
 */
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

jest.mock('../models/WineList', () => ({ findOne: jest.fn(), find: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findOne: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/wineListPdf', () => ({ generateWineListPdf: jest.fn() }));
jest.mock('../services/imageSanitizer', () => ({ stripImageMetadata: jest.fn() }));
jest.mock('../services/wineListData', () => ({
  loadWineMap: jest.fn(), loadCellarWines: jest.fn(), entryKey: jest.fn(), allEntries: jest.fn(() => []),
}));
jest.mock('../services/wineListLogos', () => ({
  LOGO_DIR: '/tmp/logos', ensureLogoDir: jest.fn(), deleteLogoFile: jest.fn(), copyLogoFile: jest.fn(),
}));

const WineList = require('../models/WineList');
const Cellar = require('../models/Cellar');
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const { logAudit } = require('../services/audit');
const router = require('./wineLists');

jest.setTimeout(20000);

const USER = '64b000000000000000000001';
const LIST = '64b0000000000000000000a1';
const OWNED = '64b0000000000000000000c1';
const FOREIGN = '64b0000000000000000000c2';
const W1 = '64b0000000000000000000e1';
const W2 = '64b0000000000000000000e2';
const W3 = '64b0000000000000000000e3';
const B = (n) => `64b0000000000000000000b${n}`;

const selectLean = (rows) => ({ select: () => ({ lean: async () => rows }) });

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/wine-lists', router);
  return a;
}

function postJson(a, path, body) {
  const token = jwt.sign({ id: USER, roles: ['user'] }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const server = http.createServer(a);
    server.listen(0, () => {
      const req = http.request({
        port: server.address().port, path, method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end(payload);
    });
  });
}

const makeList = (over = {}) => ({
  _id: LIST, name: 'Menu', user: USER, cellar: OWNED, structureMode: 'auto',
  autoGroupEntries: [{ wine: W3, vintage: '2018', bottleSize: '750ml', sortOrder: 0 }],
  sections: [],
  save: jest.fn().mockResolvedValue(undefined),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  // Ownership: only OWNED belongs to USER.
  Cellar.findOne.mockImplementation(async (q) => (String(q._id) === OWNED ? { _id: OWNED, user: USER } : null));
  WineDefinition.find.mockReturnValue(selectLean([
    { _id: W1, pendingIdentity: false },
    { _id: W2, pendingIdentity: true },
    { _id: W3, pendingIdentity: false },
  ]));
});

describe('POST /api/wine-lists/:id/add-bottles', () => {
  test('auto list: adds one line per wine+vintage+size, and reports every skip with its reason', async () => {
    const list = makeList();
    WineList.findOne.mockResolvedValue(list);
    Bottle.find.mockReturnValue(selectLean([
      { _id: B(1), cellar: OWNED, wineDefinition: W1, vintage: '2019', bottleSize: '750ml' },
      { _id: B(2), cellar: OWNED, wineDefinition: W1, vintage: '2019', bottleSize: '750ml' }, // same line as B1
      { _id: B(3), cellar: OWNED, wineDefinition: W2, vintage: '2020', bottleSize: '750ml' }, // pending identity
      { _id: B(4), cellar: OWNED, wineDefinition: null, vintage: 'NV', bottleSize: '750ml' },  // no registry wine
      { _id: B(5), cellar: FOREIGN, wineDefinition: W1, vintage: '2019', bottleSize: '750ml' }, // not my cellar
      { _id: B(6), cellar: OWNED, wineDefinition: W3, vintage: '2018', bottleSize: '750ml' }, // already on the list
      { _id: B(7), cellar: OWNED, wineDefinition: W1, vintage: '2019', bottleSize: '1500ml' }, // magnum = its own line
    ]));

    const { status, body } = await postJson(app(), `/api/wine-lists/${LIST}/add-bottles`, {
      bottleIds: [B(1), B(2), B(3), B(4), B(5), B(6), B(7), B(8)],
    });

    expect(status).toBe(200);
    expect(body.added).toBe(2);
    expect(body.skipped).toEqual([
      { id: B(2), reason: 'already_on_list' },
      { id: B(3), reason: 'pending_wine' },
      { id: B(4), reason: 'no_wine' },
      { id: B(5), reason: 'not_found' },
      { id: B(6), reason: 'already_on_list' },
      { id: B(8), reason: 'not_found' },
    ]);
    expect(body.list).toEqual({ _id: LIST, name: 'Menu' });
    expect(list.autoGroupEntries).toHaveLength(3);
    expect(list.autoGroupEntries[1]).toMatchObject({ wine: W1, vintage: '2019', bottleSize: '750ml', sortOrder: 1 });
    expect(list.autoGroupEntries[2]).toMatchObject({ wine: W1, vintage: '2019', bottleSize: '1500ml', sortOrder: 2 });
    expect(list.save).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'winelist.entry.add', expect.objectContaining({ type: 'winelist', id: LIST }), { added: 2, requested: 8, via: 'bulk' });
  });

  test('custom list: needs a section when it has several; an existing title matches case-insensitively, a new one is created', async () => {
    const twoSections = makeList({
      structureMode: 'custom', autoGroupEntries: [],
      sections: [{ title: 'Reds', sortOrder: 0, entries: [] }, { title: 'Whites', sortOrder: 1, entries: [] }],
    });
    WineList.findOne.mockResolvedValue(twoSections);
    Bottle.find.mockReturnValue(selectLean([{ _id: B(1), cellar: OWNED, wineDefinition: W1, vintage: '2019', bottleSize: '750ml' }]));

    let res = await postJson(app(), `/api/wine-lists/${LIST}/add-bottles`, { bottleIds: [B(1)] });
    expect(res.status).toBe(400);
    expect(twoSections.save).not.toHaveBeenCalled();

    res = await postJson(app(), `/api/wine-lists/${LIST}/add-bottles`, { bottleIds: [B(1)], section: 'reds' });
    expect(res.status).toBe(200);
    expect(twoSections.sections[0].entries).toHaveLength(1);

    res = await postJson(app(), `/api/wine-lists/${LIST}/add-bottles`, { bottleIds: [B(1)], section: 'Dessert' });
    expect(res.status).toBe(200);
    expect(twoSections.sections).toHaveLength(3);
    expect(twoSections.sections[2]).toMatchObject({ title: 'Dessert' });
    expect(twoSections.sections[2].entries).toHaveLength(1);
  });

  test('an unknown list is 404; nothing is saved when every bottle is skipped', async () => {
    WineList.findOne.mockResolvedValue(null);
    let res = await postJson(app(), `/api/wine-lists/${LIST}/add-bottles`, { bottleIds: [B(1)] });
    expect(res.status).toBe(404);

    const list = makeList();
    WineList.findOne.mockResolvedValue(list);
    Bottle.find.mockReturnValue(selectLean([]));
    res = await postJson(app(), `/api/wine-lists/${LIST}/add-bottles`, { bottleIds: [B(1)] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ added: 0, skipped: [{ id: B(1), reason: 'not_found' }] });
    expect(list.save).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });
});
