import { renderHook, waitFor, act } from '@testing-library/react';

// The app's view of whether this server reviews contributions (GET
// /api/site/review). It must read as reviewed until the server says
// otherwise — the safe default every server starts with — and follow the
// admin switch at once.

const { useContributionReviewed, setContributionReviewed, resetContributionReviewForTests } = await import('./contributionReview');

afterEach(() => {
  resetContributionReviewForTests();
  vi.unstubAllGlobals();
});

test('reviewed until the server answers; then what it says', async () => {
  let answer;
  vi.stubGlobal('fetch', vi.fn(() => new Promise((r) => { answer = r; })));
  const { result } = renderHook(() => useContributionReviewed());
  expect(result.current).toBe(true);
  answer({ ok: true, json: async () => ({ reviewed: false }) });
  await waitFor(() => expect(result.current).toBe(false));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toMatch(/\/api\/site\/review$/);
});

test('no answer (offline, an old server) keeps it reviewed', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
  const { result } = renderHook(() => useContributionReviewed());
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(result.current).toBe(true);
});

test('the admin switch updates every reader at once', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ reviewed: true }) })));
  const { result } = renderHook(() => useContributionReviewed());
  act(() => setContributionReviewed(false));
  expect(result.current).toBe(false);
  act(() => setContributionReviewed(true));
  expect(result.current).toBe(true);
});
