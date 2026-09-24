const store = vi.hoisted(() => ({ data: new Map() }));
vi.mock('./offlineStore', () => ({
  readSnapshot: vi.fn(async (uid) => store.data.get(String(uid)) || null),
  writeSnapshot: vi.fn(async (s) => { store.data.set(String(s.userId), s); return true; }),
  clearSnapshots: vi.fn(async () => { store.data.clear(); }),
  readQueue: vi.fn(async () => store.queue || []),
}));

import {
  offlineAnswer, refreshSnapshot, clearOfflineData, getOfflineStatus, markLive, photoUrlsOf,
} from './offlineSnapshot';

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
  };
}

const C1 = 'c00000000000000000000001';
const SNAP = {
  schema: 1, generatedAt: '2026-09-24T12:00:00.000Z', userId: 'u1',
  cellars: [{ _id: C1, name: 'Home', user: { _id: 'u1' }, userRole: 'owner' }],
  wines: { w1: { _id: 'w1', name: 'Barolo', image: '/api/uploads/processed/wine.png' } },
  bottles: [{ _id: 'b00000000000000000000001', cellar: C1, wineDefinition: 'w1', defaultImageUrl: '/api/uploads/processed/own.png', pendingImageUrl: 'https://example.com/x.jpg' }],
  racks: [],
};
const jsonRes = (body, headers = {}) => ({ ok: true, status: 200, headers: new Headers(headers), json: async () => body });

beforeEach(async () => {
  vi.stubGlobal('localStorage', memoryStorage());
  store.data.clear();
  await clearOfflineData();
});
afterEach(() => vi.unstubAllGlobals());

describe('with offline mode off', () => {
  it('answers nothing and stores nothing', async () => {
    store.data.set('u1', SNAP);
    expect(await offlineAnswer('/api/cellars', 'u1')).toBeNull();
    const apiFetch = vi.fn();
    expect(await refreshSnapshot(apiFetch, 'u1')).toBe(false);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('with offline mode on', () => {
  beforeEach(() => localStorage.setItem('cellarion-offline', 'on'));

  it('stores a fresh snapshot and answers from it, marked as the saved copy', async () => {
    vi.stubGlobal('caches', undefined); // no photo sync in this test
    expect(await refreshSnapshot(vi.fn(async () => jsonRes(SNAP)), 'u1')).toBe(true);
    const res = await offlineAnswer('/api/cellars', 'u1');
    expect(res.headers.get('X-Cellarion-Offline')).toBe(SNAP.generatedAt);
    expect((await res.json()).count).toBe(1);
    expect(getOfflineStatus()).toEqual({ savedAt: SNAP.generatedAt, usingSaved: true });
    markLive();
    expect(getOfflineStatus().usingSaved).toBe(false);
  });

  it('refuses a snapshot for another account or of another schema', async () => {
    expect(await refreshSnapshot(vi.fn(async () => jsonRes({ ...SNAP, userId: 'someone-else' })), 'u1')).toBe(false);
    expect(await refreshSnapshot(vi.fn(async () => jsonRes({ ...SNAP, schema: 99 })), 'u1')).toBe(false);
    expect(store.data.size).toBe(0);
  });

  it('never answers one account from another\'s snapshot', async () => {
    store.data.set('u1', SNAP);
    expect(await offlineAnswer('/api/cellars', 'u2')).toBeNull();
    expect(await offlineAnswer('/api/cellars', null)).toBeNull();
  });

  it('a network failure while refreshing keeps the old copy', async () => {
    store.data.set('u1', SNAP);
    expect(await refreshSnapshot(vi.fn(async () => { throw new TypeError('Failed to fetch'); }), 'u1')).toBe(false);
    expect(store.data.get('u1')).toBe(SNAP);
  });

  it('clearOfflineData forgets the copy', async () => {
    store.data.set('u1', SNAP);
    await clearOfflineData();
    expect(await offlineAnswer('/api/cellars', 'u1')).toBeNull();
  });
});

describe('photoUrlsOf', () => {
  it('lists the thumbnails of own photos and wine images, skipping external links', () => {
    expect([...photoUrlsOf(SNAP)].sort()).toEqual([
      '/api/uploads/thumbs/processed/own.png.webp',
      '/api/uploads/thumbs/processed/wine.png.webp',
    ]);
  });
});

describe('pending offline changes over the saved copy', () => {
  beforeEach(() => localStorage.setItem('cellarion-offline', 'on'));
  afterEach(() => { store.queue = []; });

  it('a pending change stays visible after a refresh brings a newer copy', async () => {
    vi.stubGlobal('caches', undefined);
    const bid = 'b00000000000000000000001';
    store.queue = [{ id: 'k', userId: 'u1', kind: 'consume', status: 'pending', bottleId: bid, createdAt: '2026-09-24T13:00:00Z', body: { reason: 'drank' } }];
    expect(await refreshSnapshot(vi.fn(async () => jsonRes({ ...SNAP, generatedAt: '2026-09-24T14:00:00.000Z' })), 'u1')).toBe(true);
    const res = await offlineAnswer(`/api/bottles/${bid}`, 'u1');
    expect(res.status).toBe(404); // consumed offline, still gone from the device copy
    const list = await (await offlineAnswer(`/api/cellars/${C1}`, 'u1')).json();
    expect(list.bottles.total).toBe(0);
  });
});
