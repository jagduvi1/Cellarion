import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('../api/taxonomy', () => ({ getClassifications: vi.fn() }));

const { getClassifications } = await import('../api/taxonomy');
const { default: useClassifications, __resetClassificationsCache } = await import('./useClassifications');

const LIST = [{ _id: 'k1', name: 'Spätlese', kind: 'ripeness', country: null }];
const ok = (body) => ({ ok: true, json: async () => body });
const apiFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  __resetClassificationsCache();
});

test('asks for nothing until it is enabled, then once per tab however many forms open', async () => {
  getClassifications.mockResolvedValue(ok({ classifications: LIST }));
  const first = renderHook(({ on }) => useClassifications(apiFetch, on), { initialProps: { on: false } });
  expect(getClassifications).not.toHaveBeenCalled();
  expect(first.result.current.classifications).toBeNull();

  first.rerender({ on: true });
  await waitFor(() => expect(first.result.current.classifications).toEqual(LIST));
  const second = renderHook(() => useClassifications(apiFetch, true));
  expect(second.result.current.classifications).toEqual(LIST);
  expect(getClassifications).toHaveBeenCalledTimes(1);
});

test('a failure is reported, never cached, and retry asks again', async () => {
  getClassifications.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
  getClassifications.mockResolvedValueOnce(ok({ classifications: LIST }));
  const { result } = renderHook(() => useClassifications(apiFetch, true));
  await waitFor(() => expect(result.current.error).toBe(true));
  expect(result.current.classifications).toBeNull();

  act(() => result.current.retry());
  await waitFor(() => expect(result.current.classifications).toEqual(LIST));
  expect(result.current.error).toBe(false);
});

test('a network error or a body without the list is a failure too, not an unhandled rejection', async () => {
  getClassifications.mockRejectedValueOnce(new Error('offline'));
  const offline = renderHook(() => useClassifications(apiFetch, true));
  await waitFor(() => expect(offline.result.current.error).toBe(true));

  getClassifications.mockResolvedValueOnce(ok({ error: 'nope' }));
  const garbled = renderHook(() => useClassifications(apiFetch, true));
  await waitFor(() => expect(garbled.result.current.error).toBe(true));
});
