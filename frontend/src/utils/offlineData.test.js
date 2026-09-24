import { indexSnapshot, answerOffline } from './offlineData';

const C1 = 'c00000000000000000000001';
const C2 = 'c00000000000000000000002';
const R1 = 'a00000000000000000000001';
const b1 = 'b00000000000000000000001';
const b2 = 'b00000000000000000000002';
const b3 = 'b00000000000000000000003';
const b4 = 'b00000000000000000000004';
const b9 = 'b00000000000000000000009';

const SNAP = {
  schema: 1,
  generatedAt: '2026-09-24T12:00:00.000Z',
  userId: 'u1',
  cellars: [
    { _id: C1, name: 'Home', user: { _id: 'u1', username: 'me' }, userRole: 'owner', userColor: '#abc' },
    { _id: C2, name: "Friend's", user: { _id: 'u9', username: 'friend' }, userRole: 'viewer', userColor: null },
  ],
  wines: {
    w1: { _id: 'w1', name: 'Barolo Cannubi', producer: 'Brezza', type: 'red', country: { _id: 'it', name: 'Italy' }, grapes: [{ _id: 'neb', name: 'Nebbiolo' }] },
    w2: { _id: 'w2', name: 'Chablis', producer: 'Fèvre', type: 'white', country: { _id: 'fr', name: 'France' }, grapes: [] },
  },
  bottles: [
    { _id: b1, cellar: C1, wineDefinition: 'w1', vintage: '2016', createdAt: '2026-01-01', price: 50, maturityStatus: 'peak', defaultImageUrl: '/api/uploads/processed/x.png' },
    { _id: b2, cellar: C1, wineDefinition: 'w1', vintage: '2016', createdAt: '2026-02-01', price: 55, maturityStatus: 'peak' },
    { _id: b3, cellar: C1, wineDefinition: 'w2', vintage: '2021', createdAt: '2026-03-01', maturityStatus: 'early', reservedFor: 'Anna' },
    { _id: b4, cellar: C2, wineDefinition: 'w2', vintage: '2020', createdAt: '2026-04-01' },
  ],
  racks: [
    { _id: R1, cellar: C1, name: 'Wall', group: 'Basement', slots: [{ position: 3, bottle: b1 }, { position: 4, bottle: null }] },
  ],
};

const idx = indexSnapshot(SNAP);
const get = (url) => answerOffline(idx, url);
const ids = (items) => items.map((i) => i._id || i.bottles.map((b) => b._id).join('+'));

describe('offline answers — cellar list', () => {
  it('lists every cellar with the owner as an id, like GET /api/cellars', () => {
    const r = get('/api/cellars');
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
    expect(r.body.cellars[0]).toMatchObject({ _id: C1, user: 'u1', userRole: 'owner' });
    expect(r.body.cellars[1]).toMatchObject({ _id: C2, user: 'u9', userRole: 'viewer' });
  });
});

describe('offline answers — cellar detail', () => {
  it('returns the cellar (owner populated) and its bottles with their wines joined back', () => {
    const r = get(`/api/cellars/${C1}`);
    expect(r.body.cellar).toMatchObject({ _id: C1, user: { username: 'me' } });
    expect(r.body.bottles).toMatchObject({ total: 3, count: 3, limit: 30, skip: 0, grouped: false });
    expect(r.body.bottles.items[0].wineDefinition.name).toBe('Chablis');
  });

  it('newest first by default; sorts by name, vintage, price, maturity', () => {
    expect(ids(get(`/api/cellars/${C1}`).body.bottles.items)).toEqual([b3, b2, b1]);
    expect(ids(get(`/api/cellars/${C1}?sort=createdAt`).body.bottles.items)).toEqual([b1, b2, b3]);
    expect(get(`/api/cellars/${C1}?sort=name`).body.bottles.items[0].wineDefinition.name).toBe('Barolo Cannubi');
    expect(ids(get(`/api/cellars/${C1}?sort=-vintage`).body.bottles.items)[0]).toBe(b3);
    expect(ids(get(`/api/cellars/${C1}?sort=-price`).body.bottles.items)).toEqual([b2, b1, b3]); // no price last
    expect(ids(get(`/api/cellars/${C1}?sort=maturity`).body.bottles.items)[0]).toMatch(/b0+[12]$/); // peak before early
  });

  it('search matches wine, producer, grape and region words, accent-insensitive', () => {
    expect(ids(get(`/api/cellars/${C1}?search=fevre`).body.bottles.items)).toEqual([b3]);
    expect(ids(get(`/api/cellars/${C1}?search=nebbiolo%202016`).body.bottles.items).sort()).toEqual([b1, b2]);
    expect(get(`/api/cellars/${C1}?search=nothing`).body.bottles.total).toBe(0);
  });

  it('filters by type, vintage, country, grape, maturity and reserved', () => {
    expect(ids(get(`/api/cellars/${C1}?type=white`).body.bottles.items)).toEqual([b3]);
    expect(get(`/api/cellars/${C1}?vintage=2016`).body.bottles.total).toBe(2);
    expect(get(`/api/cellars/${C1}?country=fr`).body.bottles.total).toBe(1);
    expect(get(`/api/cellars/${C1}?grapes=neb`).body.bottles.total).toBe(2);
    expect(get(`/api/cellars/${C1}?maturity=early`).body.bottles.total).toBe(1);
    expect(ids(get(`/api/cellars/${C1}?reserved=1`).body.bottles.items)).toEqual([b3]);
  });

  it('unplaced, by rack and by rack group', () => {
    expect(ids(get(`/api/cellars/${C1}?excludePlaced=1`).body.bottles.items)).toEqual([b3, b2]);
    expect(ids(get(`/api/cellars/${C1}?rack=${R1}`).body.bottles.items)).toEqual([b1]);
    expect(ids(get(`/api/cellars/${C1}?rackGroup=Basement`).body.bottles.items)).toEqual([b1]);
  });

  it('groups identical bottles (wine + vintage + size) and pages over groups', () => {
    const r = get(`/api/cellars/${C1}?group=1&sort=createdAt&limit=1&skip=0`);
    expect(r.body.bottles).toMatchObject({ total: 2, count: 1, grouped: true });
    expect(r.body.bottles.items[0]).toMatchObject({ key: 'w1::2016::750ml', count: 2 });
    expect(get(`/api/cellars/${C1}?group=1&sort=createdAt&limit=1&skip=1`).body.bottles.items[0].key).toBe('w2::2021::750ml');
  });

  it('an unknown cellar is a 404', () => {
    expect(get(`/api/cellars/${'f'.repeat(24)}`).status).toBe(404);
  });
});

describe('offline answers — racks, layout, bottle', () => {
  it('racks come with their bottles joined in', () => {
    const r = get(`/api/racks?cellar=${C1}`);
    expect(r.body.racks).toHaveLength(1);
    expect(r.body.racks[0].slots[0].bottle).toMatchObject({ _id: b1, wineDefinition: { name: 'Barolo Cannubi' } });
    expect(r.body.racks[0].slots[1].bottle).toBeNull();
    expect(get(`/api/racks?cellar=${C2}`).body.racks).toEqual([]);
  });

  it('the room layout is empty offline', () => {
    expect(get(`/api/cellar-layout?cellar=${C1}`)).toEqual({ status: 200, body: { layout: null } });
  });

  it('a bottle comes with its role, image and rack placement', () => {
    const r = get(`/api/bottles/${b1}`);
    expect(r.body).toMatchObject({
      bottle: { _id: b1, wineDefinition: { name: 'Barolo Cannubi' } },
      userRole: 'owner',
      cellarColor: '#abc',
      defaultImageUrl: '/api/uploads/processed/x.png',
      rackInfo: { rackId: R1, rackName: 'Wall', position: 3, inRoom: false },
      lotSiblingIds: [],
    });
    expect(get(`/api/bottles/${b4}`).body.userRole).toBe('viewer');
    expect(get(`/api/bottles/${b9}`).status).toBe(404);
  });

  it('anything else is not answered offline', () => {
    for (const url of ['/api/wines/search?q=x', `/api/cellars/${C1}/statistics`, `/api/bottles/${b1}/lot-history`, '/api/offline/snapshot']) {
      expect(get(url)).toBeNull();
    }
  });

  it('absolute URLs work too', () => {
    expect(answerOffline(idx, 'https://cellarion.app/api/cellars').status).toBe(200);
  });
});
