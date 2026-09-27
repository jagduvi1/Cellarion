/**
 * Offline snapshot (#1355) — the document a device keeps to show its user's
 * cellars, racks and bottles with no network.
 */
jest.mock('../models/Cellar', () => ({ find: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn() }));
jest.mock('../models/Rack', () => ({ find: jest.fn() }));
jest.mock('../utils/maturityUtils', () => ({
  buildProfileMap: jest.fn(async () => new Map()),
  classifyMaturity: jest.fn((b) => (b._id === 'b1' ? 'peak' : null)),
}));

const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const Rack = require('../models/Rack');
const { assembleSnapshot, buildOfflineSnapshot, SNAPSHOT_SCHEMA } = require('./offlineSnapshot');

const ME = 'u1';
const OWN = { _id: 'c1', user: { _id: ME, username: 'me' }, members: [], userColors: [{ user: ME, color: '#abc' }] };
const SHARED = { _id: 'c2', user: { _id: 'u9', username: 'friend' }, members: [{ user: ME, role: 'viewer' }] };
const WINE = { _id: 'w1', name: 'Barolo', producer: 'X' };

describe('assembleSnapshot', () => {
  const snapshot = () => assembleSnapshot({
    userId: ME,
    cellars: [OWN, SHARED],
    bottles: [
      { _id: 'b1', cellar: 'c1', wineDefinition: WINE, vintage: '2016' },
      { _id: 'b2', cellar: 'c1', wineDefinition: WINE, vintage: '2016' },
      { _id: 'b3', cellar: 'c2', wineDefinition: null, pendingWineRequest: { wineName: 'Pending' } },
      { _id: 'b4', cellar: 'c-deleted', wineDefinition: WINE },
    ],
    racks: [
      { _id: 'r1', cellar: 'c1', slots: [{ position: 1, bottle: 'b1' }, { position: 2, bottle: 'b-gone' }, { position: 3 }] },
      { _id: 'r2', cellar: 'c-deleted', slots: [] },
    ],
    maturity: new Map([['b1', 'peak']]),
    now: new Date('2026-09-24T12:00:00Z'),
  });

  test('carries the schema, time and user', () => {
    const s = snapshot();
    expect(s.schema).toBe(SNAPSHOT_SCHEMA);
    expect(s.generatedAt).toBe('2026-09-24T12:00:00.000Z');
    expect(s.userId).toBe(ME);
  });

  test('cellars carry the user\'s role and colour, shared ones included', () => {
    const [own, shared] = snapshot().cellars;
    expect(own).toMatchObject({ _id: 'c1', userRole: 'owner', userColor: '#abc' });
    expect(shared).toMatchObject({ _id: 'c2', userRole: 'viewer', userColor: null });
  });

  test('each wine is sent once; bottles reference it by id', () => {
    const s = snapshot();
    expect(Object.keys(s.wines)).toEqual(['w1']);
    expect(s.bottles.find((b) => b._id === 'b1').wineDefinition).toBe('w1');
    expect(s.bottles.find((b) => b._id === 'b2').wineDefinition).toBe('w1');
    expect(s.bottles.find((b) => b._id === 'b3').wineDefinition).toBeNull();
  });

  test('bottles carry their maturity status', () => {
    const s = snapshot();
    expect(s.bottles.find((b) => b._id === 'b1').maturityStatus).toBe('peak');
    expect(s.bottles.find((b) => b._id === 'b2').maturityStatus).toBeNull();
  });

  test('nothing from outside the user\'s cellars (a soft-deleted cellar\'s leftovers)', () => {
    const s = snapshot();
    expect(s.bottles.map((b) => b._id)).toEqual(['b1', 'b2', 'b3']);
    expect(s.racks.map((r) => r._id)).toEqual(['r1']);
  });

  test('rack slots reference snapshot bottles by id, and nothing else', () => {
    const slots = snapshot().racks[0].slots;
    expect(slots.map((sl) => sl.bottle)).toEqual(['b1', null, null]);
  });
});

describe('buildOfflineSnapshot', () => {
  const chain = (result) => {
    const q = { populate: () => q, sort: () => q, lean: async () => result };
    return q;
  };

  test('loads only the user\'s cellars, their unconsumed bottles and live racks', async () => {
    Cellar.find.mockReturnValue(chain([OWN]));
    Bottle.find.mockReturnValue(chain([{ _id: 'b1', cellar: 'c1', wineDefinition: WINE }]));
    Rack.find.mockReturnValue(chain([]));
    const attach = jest.fn(async (bs) => bs.map((b) => ({ ...b, defaultImageUrl: '/api/uploads/processed/x.png' })));

    const s = await buildOfflineSnapshot(ME, { attachBottleImageUrls: attach });

    expect(Cellar.find).toHaveBeenCalledWith({ $or: [{ user: ME }, { 'members.user': ME }], deletedAt: null });
    const bottleQuery = Bottle.find.mock.calls[0][0];
    expect(bottleQuery.cellar).toEqual({ $in: ['c1'] });
    expect(bottleQuery.status.$nin).toEqual(expect.arrayContaining(['drank', 'gifted', 'sold']));
    expect(Rack.find).toHaveBeenCalledWith({ cellar: { $in: ['c1'] }, deletedAt: null });
    expect(attach).toHaveBeenCalledWith(expect.any(Array), ME);
    expect(s.bottles[0]).toMatchObject({ _id: 'b1', wineDefinition: 'w1', defaultImageUrl: '/api/uploads/processed/x.png', maturityStatus: 'peak' });
  });

  test('a user with no cellars gets an empty snapshot without further queries', async () => {
    Cellar.find.mockReturnValue(chain([]));
    Bottle.find.mockClear();
    Rack.find.mockClear();
    const s = await buildOfflineSnapshot(ME, { attachBottleImageUrls: async (b) => b });
    expect(s).toMatchObject({ cellars: [], bottles: [], racks: [], wines: {} });
    expect(Bottle.find).not.toHaveBeenCalled();
    expect(Rack.find).not.toHaveBeenCalled();
  });
});

// The 304 check (routes/offline): one small query decides whether anything the
// device's copy holds may have changed. It must move for every change the copy
// shows, and only then, so an unchanged check answers 304 and a changed one
// rebuilds.
describe('snapshotTag', () => {
  const { snapshotTag, TAG_MAX_AGE_MS } = require('./offlineSnapshot');
  const { bumpDataVersion } = require('./dataVersion');
  const sharedWith = (rows) => {
    const q = { select: () => q, lean: async () => rows };
    Cellar.find.mockReturnValue(q);
  };
  // Mid-bucket, so a minute either way stays inside the same 30-minute window.
  const T = 1000 * TAG_MAX_AGE_MS + TAG_MAX_AGE_MS / 2;

  beforeEach(() => sharedWith([{ _id: 'c2', user: 'tag-friend' }]));

  test('the same state gives the same tag, as a weak ETag', async () => {
    const a = await snapshotTag('tag-me', T);
    expect(a).toMatch(/^W\/"[A-Za-z0-9_-]{27}"$/);
    expect(await snapshotTag('tag-me', T + 60 * 1000)).toBe(a);
    expect(Cellar.find).toHaveBeenCalledWith({ 'members.user': 'tag-me', deletedAt: null });
  });

  test('a change in the user\'s own cellars moves it', async () => {
    const a = await snapshotTag('tag-me', T);
    bumpDataVersion('tag-me');
    expect(await snapshotTag('tag-me', T)).not.toBe(a);
  });

  test('a change by the owner of a cellar shared with the user moves it', async () => {
    const a = await snapshotTag('tag-me', T);
    bumpDataVersion('tag-friend');
    expect(await snapshotTag('tag-me', T)).not.toBe(a);
  });

  test('a change by someone unrelated does not', async () => {
    const a = await snapshotTag('tag-me', T);
    bumpDataVersion('tag-stranger');
    expect(await snapshotTag('tag-me', T)).toBe(a);
  });

  test('being added to (or removed from) a shared cellar moves it', async () => {
    const a = await snapshotTag('tag-me', T);
    sharedWith([{ _id: 'c2', user: 'tag-friend' }, { _id: 'c3', user: 'tag-friend' }]);
    expect(await snapshotTag('tag-me', T)).not.toBe(a);
  });

  test('it moves on at least every 30 minutes, for changes the data version cannot see', async () => {
    const a = await snapshotTag('tag-me', T);
    expect(await snapshotTag('tag-me', T + TAG_MAX_AGE_MS)).not.toBe(a);
  });
});
