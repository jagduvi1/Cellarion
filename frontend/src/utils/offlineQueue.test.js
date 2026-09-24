import { indexSnapshot } from './offlineData';

// In-memory store + snapshot manager, so the queue's decisions are tested alone.
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

import { writeKeyFor, queueWrite, flushQueue, resolveAttention, getQueueStatus, listAttention } from './offlineQueue';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

const C1 = 'c00000000000000000000001';
const R1 = 'a00000000000000000000001';
const b1 = 'b00000000000000000000001';
const b2 = 'b00000000000000000000002';
const SNAP = {
  schema: 1, generatedAt: '2026-09-24T12:00:00.000Z', userId: 'u1',
  cellars: [{ _id: C1, name: 'Home', user: { _id: 'u1' }, userRole: 'owner' }],
  wines: { w1: { _id: 'w1', name: 'Barolo' } },
  bottles: [{ _id: b1, cellar: C1, wineDefinition: 'w1', vintage: '2016' }, { _id: b2, cellar: C1, wineDefinition: 'w1' }],
  racks: [{ _id: R1, cellar: C1, name: 'Wall', slots: [{ position: 1, bottle: b1 }] }],
};
const res = (status, body = {}, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body });

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  localStorage.setItem('cellarion-offline', 'on');
  mem.queue.clear();
  mem.idx = indexSnapshot(SNAP);
});
afterEach(() => vi.unstubAllGlobals());

async function queue(url, method, body) {
  const key = writeKeyFor(url, method, 'u1');
  const r = await queueWrite({ url, method, body: body ? JSON.stringify(body) : undefined, key, userId: 'u1' });
  return { key, r };
}

describe('queueing', () => {
  it('a queueable write gets a key; the page gets a normal-looking answer', async () => {
    const { key, r } = await queue(`/api/bottles/${b1}/consume`, 'POST', { reason: 'drank' });
    expect(key).toMatch(/^[a-f0-9]{32}$/);
    expect(r.status).toBe(200);
    expect(r.headers.get('X-Cellarion-Offline')).toBe('queued');
    expect((await r.json()).bottle).toMatchObject({ _id: b1, status: 'drank' });
    expect(mem.queue.get(key)).toMatchObject({ kind: 'consume', status: 'pending', userId: 'u1' });
    expect(getQueueStatus().pending).toBe(1);
  });

  it('no key and nothing queued when offline mode is off or the write is not queueable', async () => {
    localStorage.setItem('cellarion-offline', 'off');
    expect(writeKeyFor(`/api/bottles/${b1}/consume`, 'POST', 'u1')).toBeNull();
    localStorage.setItem('cellarion-offline', 'on');
    expect(writeKeyFor('/api/bottles', 'POST', 'u1')).toBeNull();
    expect(writeKeyFor(`/api/bottles/${b1}/consume`, 'POST', null)).toBeNull();
  });
});

describe('sending', () => {
  it('sends in order with the op\'s key; successes are kept as sent (still laid over the copy), not pending', async () => {
    const a = await queue(`/api/racks/${R1}/slots/5`, 'PUT', { bottleId: b2 });
    const b = await queue(`/api/bottles/${b1}/consume`, 'POST', { reason: 'drank' });
    const apiFetch = vi.fn(async () => res(200, {}));
    expect(await flushQueue(apiFetch, 'u1')).toBe(2);
    expect(apiFetch.mock.calls.map((c) => c[1].headers['Idempotency-Key'])).toEqual([a.key, b.key]);
    expect(apiFetch.mock.calls[0][1]).toMatchObject({ method: 'PUT', __direct: true });
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toEqual({ bottleId: b2, expectOccupant: null });
    expect([...mem.queue.values()].map((o) => o.status)).toEqual(['sent', 'sent']);
    expect(getQueueStatus()).toMatchObject({ pending: 0, attention: 0 });
    // …and never sent again
    apiFetch.mockClear();
    await flushQueue(apiFetch, 'u1');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('still offline → stops and keeps everything pending', async () => {
    await queue(`/api/bottles/${b1}/consume`, 'POST', {});
    await queue(`/api/bottles/${b2}/consume`, 'POST', {});
    const apiFetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    expect(await flushQueue(apiFetch, 'u1')).toBe(0);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect([...mem.queue.values()].every((o) => o.status === 'pending')).toBe(true);
  });

  it('5xx, 429, 401 and "in progress" → try again later, nothing marked', async () => {
    for (const r of [res(503), res(429), res(401), res(409, { error: 'Request in progress' }, { 'Retry-After': '2' })]) {
      mem.queue.clear();
      await queue(`/api/bottles/${b1}/consume`, 'POST', {});
      await flushQueue(vi.fn(async () => r), 'u1');
      expect([...mem.queue.values()][0].status).toBe('pending');
    }
  });

  it('a refusal (the cellar changed) → needs attention, with the reason; the rest still go', async () => {
    const a = await queue(`/api/racks/${R1}/slots/5`, 'PUT', { bottleId: b2 });
    await queue(`/api/bottles/${b1}/consume`, 'POST', {});
    const apiFetch = vi.fn()
      .mockResolvedValueOnce(res(409, { error: 'This slot has changed since', code: 'slot_changed' }))
      .mockResolvedValueOnce(res(200, {}));
    expect(await flushQueue(apiFetch, 'u1')).toBe(1);
    expect(mem.queue.get(a.key)).toMatchObject({ status: 'attention', code: 'slot_changed', error: 'This slot has changed since' });
    expect(getQueueStatus()).toMatchObject({ pending: 0, attention: 1 });
    expect((await listAttention('u1')).map((o) => o.id)).toEqual([a.key]);
  });

  it('never sends another account\'s changes', async () => {
    await queue(`/api/bottles/${b1}/consume`, 'POST', {});
    const apiFetch = vi.fn(async () => res(200));
    expect(await flushQueue(apiFetch, 'u2')).toBe(0);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('the user\'s decision', () => {
  async function refused(code) {
    const { key } = await queue(`/api/racks/${R1}/slots/1`, 'PUT', { bottleId: b2 });
    await flushQueue(vi.fn(async () => res(409, { error: 'x', code })), 'u1');
    return key;
  }

  it('discard drops it', async () => {
    const key = await refused('slot_changed');
    await resolveAttention(key, 'discard', 'u1');
    expect(mem.queue.size).toBe(0);
  });

  it('apply anyway: pending again, without the preconditions, under a new key', async () => {
    const key = await refused('slot_changed');
    await resolveAttention(key, 'force', 'u1');
    const [next] = [...mem.queue.values()];
    expect(next.id).not.toBe(key);
    expect(next.status).toBe('pending');
    expect(next.body).toEqual({ bottleId: b2 });
  });

  it('try again: pending again as it was, under a new key', async () => {
    const key = await refused('other');
    await resolveAttention(key, 'retry', 'u1');
    const [next] = [...mem.queue.values()];
    expect(next.id).not.toBe(key);
    expect(next.body).toEqual({ bottleId: b2, expectOccupant: b1 });
  });
});
