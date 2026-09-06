import { fetchRates } from './currency';

// Audit 2026-09 F03-4: rates come from our own backend, never from the
// upstream provider directly, and the result is cached per session.
test('fetchRates asks the backend endpoint and caches the answer', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ base: 'USD', rates: { USD: 1, EUR: 0.92 } }) });
  vi.stubGlobal('fetch', fetchMock);
  try {
    expect(await fetchRates()).toEqual({ USD: 1, EUR: 0.92 });
    expect(await fetchRates()).toEqual({ USD: 1, EUR: 0.92 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/exchange-rates');
  } finally {
    vi.unstubAllGlobals();
  }
});
