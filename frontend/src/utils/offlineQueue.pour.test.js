import { indexSnapshot } from './offlineData';

// In-memory store + snapshot manager, so the queue's handling of a pour is
// tested alone (same harness as offlineQueue.test.js).
const mem = vi.hoisted(() => ({ queue: new Map(), idx: null }));
vi.mock('./offlineStore', () => ({
  readQueue: vi.fn(async () => [...mem.queue.values()].map((o) => ({ ...o }))),
  putQueued: vi.fn(async (op) => { mem.queue.set(op.id, { ...op }); return true; }),
  deleteQueued: vi.fn(async (id) => { mem.queue.delete(id); }),
}));
vi.mock('./offlineSnapshot', () => ({
  getWorkingIndex: vi.fn(async () => mem.idx),
  rebuildWorking: vi.fn(async () => mem.idx),
}));

import { writeKeyFor, queueWrite, flushQueue, resolveAttention, getQueueStatus } from './offlineQueue';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

const C1 = 'c00000000000000000000001';
const b1 = 'b00000000000000000000001';
const SNAP = {
  schema: 1, generatedAt: '2026-09-24T12:00:00.000Z', userId: 'u1',
  cellars: [{ _id: C1, name: 'Home', user: { _id: 'u1' }, userRole: 'owner' }],
  wines: { w1: { _id: 'w1', name: 'Barolo' } },
  bottles: [{
    _id: b1, cellar: C1, wineDefinition: 'w1', vintage: '2016',
    openedAt: '2026-09-24T16:00:00.000Z', preservationMethod: 'coravin', pours: [{ at: '2026-09-24T17:00:00.000Z', ml: 125 }],
  }],
  racks: [],
};
const res = (status, body = {}, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body });
const POUR = `/api/bottles/${b1}/pour`;

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  localStorage.setItem('cellarion-offline', 'on');
  mem.queue.clear();
  mem.idx = indexSnapshot(SNAP);
});
afterEach(() => vi.unstubAllGlobals());

async function queuePour(body = { ml: 150 }) {
  const key = writeKeyFor(POUR, 'POST', 'u1');
  const r = await queueWrite({ url: POUR, method: 'POST', body: JSON.stringify(body), key, userId: 'u1' });
  return { key, r };
}

describe('a pour made offline', () => {
  it('is answered at once, and sent with the glasses the user saw', async () => {
    const { key, r } = await queuePour();
    expect(r.headers.get('X-Cellarion-Offline')).toBe('queued');
    expect((await r.json()).bottle).toMatchObject({ _id: b1 });
    expect(mem.queue.get(key)).toMatchObject({ kind: 'pour', status: 'pending' });
    const apiFetch = vi.fn(async () => res(200, {}));
    expect(await flushQueue(apiFetch, 'u1')).toBe(1);
    const [url, init] = apiFetch.mock.calls[0];
    expect(url).toBe(POUR);
    expect(init).toMatchObject({ method: 'POST', __direct: true });
    expect(init.headers['Idempotency-Key']).toBe(key);
    expect(JSON.parse(init.body)).toEqual({ ml: 150, expectPours: 1 });
  });

  it('poured meanwhile → needs attention, nothing dropped', async () => {
    const { key } = await queuePour();
    const refusal = { error: 'Glasses were poured from this bottle meanwhile', code: 'state_changed' };
    expect(await flushQueue(vi.fn(async () => res(409, refusal)), 'u1')).toBe(0);
    expect(mem.queue.get(key)).toMatchObject({ kind: 'pour', status: 'attention', code: 'state_changed', httpStatus: 409 });
    expect(getQueueStatus()).toMatchObject({ pending: 0, attention: 1 });
  });

  it('apply anyway: sent again under a new key, the glass added to whatever is poured now', async () => {
    const { key } = await queuePour();
    await flushQueue(vi.fn(async () => res(409, { error: 'x', code: 'state_changed' })), 'u1');
    await resolveAttention(key, 'force', 'u1');
    const [next] = [...mem.queue.values()];
    expect(next.id).not.toBe(key);
    expect(next).toMatchObject({ kind: 'pour', status: 'pending', code: null });
    expect(next.body).toEqual({ ml: 150 });

    const apiFetch = vi.fn(async () => res(200, {}));
    expect(await flushQueue(apiFetch, 'u1')).toBe(1);
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({ ml: 150 });
  });

  it('try again: sent as it was, still with the glasses the user saw', async () => {
    const { key } = await queuePour({ ml: 100 });
    await flushQueue(vi.fn(async () => res(409, { error: 'x', code: 'state_changed' })), 'u1');
    await resolveAttention(key, 'retry', 'u1');
    expect([...mem.queue.values()][0].body).toEqual({ ml: 100, expectPours: 1 });
  });
});
