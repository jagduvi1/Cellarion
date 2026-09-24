import { createApiFetch, SLOW_GET_MS } from './apiFetch';

// Offline mode (#1355): reads the network can't answer come from the device's
// copy (offlineFallback); nothing changes when there is no fallback answer.
const live = (body = 'live') => ({ status: 200, ok: true, body, headers: new Headers() });
const saved = () => ({ status: 200, ok: true, body: 'saved', headers: new Headers({ 'X-Cellarion-Offline': '2026-09-24T12:00:00Z' }) });

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const make = (fallback, extra = {}) => createApiFetch(() => 'tok', vi.fn(), vi.fn(), { offlineFallback: fallback, ...extra });

test('a live answer is used and reported live', async () => {
  fetchMock.mockResolvedValue(live());
  const onLive = vi.fn();
  const fallback = vi.fn();
  const res = await make(fallback, { onLive })('/api/cellars');
  expect(res.body).toBe('live');
  expect(fallback).not.toHaveBeenCalled();
  expect(onLive).toHaveBeenCalled();
});

test('a failed GET is answered from the device copy', async () => {
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
  const onLive = vi.fn();
  const res = await make(vi.fn(async () => saved()), { onLive })('/api/cellars');
  expect(res.body).toBe('saved');
  expect(onLive).not.toHaveBeenCalled();
});

test('a failed GET with no saved answer fails as before', async () => {
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
  await expect(make(vi.fn(async () => null))('/api/wines/search')).rejects.toThrow('Failed to fetch');
});

test('the browser reports offline → no network attempt at all', async () => {
  vi.stubGlobal('navigator', { onLine: false });
  const res = await make(vi.fn(async () => saved()))('/api/cellars');
  expect(res.body).toBe('saved');
  expect(fetchMock).not.toHaveBeenCalled();
});

test(`a GET hanging longer than ${SLOW_GET_MS} ms is answered from the device copy`, async () => {
  vi.useFakeTimers();
  fetchMock.mockReturnValue(new Promise(() => {})); // one bar of signal: never answers
  const p = make(vi.fn(async () => saved()))('/api/cellars');
  await vi.advanceTimersByTimeAsync(SLOW_GET_MS + 1);
  expect((await p).body).toBe('saved');
});

test('a slow GET with no saved answer keeps waiting for the network', async () => {
  vi.useFakeTimers();
  let resolve;
  fetchMock.mockReturnValue(new Promise((r) => { resolve = r; }));
  const p = make(vi.fn(async () => null))('/api/wines/search');
  await vi.advanceTimersByTimeAsync(SLOW_GET_MS + 1);
  resolve(live('late'));
  expect((await p).body).toBe('late');
});

test('writes are never answered from the device copy', async () => {
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
  const fallback = vi.fn(async () => saved());
  await expect(make(fallback)('/api/bottles/b1/consume', { method: 'POST' })).rejects.toThrow('Failed to fetch');
  expect(fallback).not.toHaveBeenCalled();
});

test('a successful write is reported (the device copy refreshes after it)', async () => {
  fetchMock.mockResolvedValue(live());
  const onMutation = vi.fn();
  await make(vi.fn(), { onMutation })('/api/bottles/b1', { method: 'PUT' });
  expect(onMutation).toHaveBeenCalledWith('/api/bottles/b1');
  onMutation.mockClear();
  await make(vi.fn(), { onMutation })('/api/cellars');
  expect(onMutation).not.toHaveBeenCalled();
});

test('without the offline hooks nothing changes (no timer race)', async () => {
  fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
  const apiFetch = createApiFetch(() => 'tok', vi.fn(), vi.fn());
  await expect(apiFetch('/api/cellars')).rejects.toThrow('Failed to fetch');
});
