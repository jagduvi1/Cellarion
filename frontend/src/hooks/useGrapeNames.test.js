import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('../api/taxonomy', () => ({ getGrapeNames: vi.fn() }));

const { getGrapeNames } = await import('../api/taxonomy');
const { default: useGrapeNames, __resetGrapeNamesCache } = await import('./useGrapeNames');

const LIST = [{ name: 'Syrah', color: 'Red', synonyms: ['Shiraz'], wineCount: 700 }];
const ok = (body) => ({ ok: true, json: async () => body });
const apiFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  __resetGrapeNamesCache();
});

test('asks for nothing until it is enabled — the bottle page must not pay for a form nobody opened', async () => {
  getGrapeNames.mockResolvedValue(ok({ grapes: LIST }));
  const { result, rerender } = renderHook(({ on }) => useGrapeNames(apiFetch, on), { initialProps: { on: false } });
  expect(getGrapeNames).not.toHaveBeenCalled();
  expect(result.current.grapes).toBeNull();

  rerender({ on: true });
  await waitFor(() => expect(result.current.grapes).toEqual(LIST));
  expect(getGrapeNames).toHaveBeenCalledTimes(1);
});

test('the list is fetched once per tab, however many forms open', async () => {
  getGrapeNames.mockResolvedValue(ok({ grapes: LIST }));
  const first = renderHook(() => useGrapeNames(apiFetch, true));
  await waitFor(() => expect(first.result.current.grapes).toEqual(LIST));
  const second = renderHook(() => useGrapeNames(apiFetch, true));
  expect(second.result.current.grapes).toEqual(LIST);
  expect(getGrapeNames).toHaveBeenCalledTimes(1);
});

test('a failure is reported, never cached, and retry asks again', async () => {
  getGrapeNames.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
  getGrapeNames.mockResolvedValueOnce(ok({ grapes: LIST }));
  const { result } = renderHook(() => useGrapeNames(apiFetch, true));
  await waitFor(() => expect(result.current.error).toBe(true));
  expect(result.current.grapes).toBeNull();

  act(() => result.current.retry());
  await waitFor(() => expect(result.current.grapes).toEqual(LIST));
  expect(result.current.error).toBe(false);
});

test('a network error is a failure too, not an unhandled rejection', async () => {
  getGrapeNames.mockRejectedValueOnce(new Error('offline'));
  const { result } = renderHook(() => useGrapeNames(apiFetch, true));
  await waitFor(() => expect(result.current.error).toBe(true));
});
