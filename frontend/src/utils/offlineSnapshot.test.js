const store = vi.hoisted(() => ({ data: new Map() }));
vi.mock('./offlineStore', () => ({
  readSnapshot: vi.fn(async (uid) => store.data.get(String(uid)) || null),
  writeSnapshot: vi.fn(async (s) => { store.data.set(String(s.userId), s); return true; }),
  clearSnapshots: vi.fn(async () => { store.data.clear(); }),
  readQueue: vi.fn(async () => store.queue || []),
  deleteQueued: vi.fn(async (id) => { store.queue = (store.queue || []).filter((o) => o.id !== id); }),
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

  // Release audit 2026-09-27 (L): a burst of changes used up the server's
  // refresh allowance and the copy went silently stale until the 15-min timer.
  it('a 429 schedules one retry for when the server says the window reopens', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('caches', undefined);
    try {
      let calls = 0;
      const apiFetch = vi.fn(async () => {
        calls += 1;
        if (calls === 1) return { ok: false, status: 429, headers: new Headers({ 'Retry-After': '30' }), json: async () => ({}) };
        return jsonRes(SNAP);
      });
      expect(await refreshSnapshot(apiFetch, 'u1')).toBe(false);
      expect(apiFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(apiFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(apiFetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(10);
      expect(getOfflineStatus().savedAt).toBe(SNAP.generatedAt);
    } finally {
      vi.useRealTimers();
    }
  });

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

  it('a sent change stays laid over the copy until a copy requested after it arrives', async () => {
    vi.stubGlobal('caches', undefined);
    const bid = 'b00000000000000000000001';
    const sentOp = (sentAt) => ({ id: 's', userId: 'u1', kind: 'consume', status: 'sent', sentAt, bottleId: bid, createdAt: '2026-09-24T13:00:00Z', body: { reason: 'drank' } });
    // Sent after this refresh was requested → the copy may not have it: still overlaid.
    store.queue = [sentOp(new Date(Date.now() + 60000).toISOString())];
    await refreshSnapshot(vi.fn(async () => jsonRes(SNAP)), 'u1');
    expect(store.queue).toHaveLength(1);
    expect((await offlineAnswer(`/api/bottles/${bid}`, 'u1')).status).toBe(404);
    // Sent before this refresh was requested → the new copy has it: dropped.
    store.queue = [sentOp(new Date(Date.now() - 60000).toISOString())];
    await refreshSnapshot(vi.fn(async () => jsonRes(SNAP)), 'u1');
    expect(store.queue).toHaveLength(0);
  });
});

// Asking whether anything changed (scaling audit 2026-09-25, item 11): the copy
// keeps the server's ETag and sends it back; a 304 keeps the copy without the
// server building a new one, and counts as confirmed current.
describe('the 304 check', () => {
  beforeEach(() => {
    localStorage.setItem('cellarion-offline', 'on');
    vi.stubGlobal('caches', undefined); // no photo sync in these tests
  });
  const tagged = (tag) => jsonRes({ ...SNAP }, { ETag: tag });
  const notModified = () => ({ ok: false, status: 304, headers: new Headers(), json: async () => { throw new Error('a 304 has no body'); } });

  it('keeps the tag with the copy and sends it back on the next check', async () => {
    await refreshSnapshot(vi.fn(async () => tagged('W/"t1"')), 'u1');
    expect(store.data.get('u1').etag).toBe('W/"t1"');

    const apiFetch = vi.fn(async () => tagged('W/"t2"'));
    await refreshSnapshot(apiFetch, 'u1');
    expect(apiFetch).toHaveBeenCalledWith('/api/offline/snapshot', { headers: { 'If-None-Match': 'W/"t1"' } });
    expect(store.data.get('u1').etag).toBe('W/"t2"');
  });

  it('a 304 keeps the same copy, now confirmed current', async () => {
    await refreshSnapshot(vi.fn(async () => tagged('W/"t1"')), 'u1');
    const before = Date.now();

    expect(await refreshSnapshot(vi.fn(async () => notModified()), 'u1')).toBe(true);

    const kept = store.data.get('u1');
    expect(kept.bottles).toEqual(SNAP.bottles);
    expect(kept.etag).toBe('W/"t1"');
    expect(Date.parse(getOfflineStatus().savedAt)).toBeGreaterThanOrEqual(before);
    expect((await (await offlineAnswer('/api/cellars', 'u1')).json()).count).toBe(1);
  });

  it('a copy saved before tags existed asks without one and takes the full answer', async () => {
    store.data.set('u1', { ...SNAP });
    const apiFetch = vi.fn(async () => tagged('W/"t3"'));

    expect(await refreshSnapshot(apiFetch, 'u1')).toBe(true);
    expect(apiFetch).toHaveBeenCalledWith('/api/offline/snapshot', {});
    expect(store.data.get('u1').etag).toBe('W/"t3"');
  });

  it('a 304 with no copy on the device is not taken as fresh', async () => {
    expect(await refreshSnapshot(vi.fn(async () => notModified()), 'u1')).toBe(false);
    expect(store.data.has('u1')).toBe(false);
  });
});
