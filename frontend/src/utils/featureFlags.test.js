import { renderHook, act, waitFor } from '@testing-library/react';

// Feature flags on the client: the server's list (GET /api/site/features)
// combined with the user's own "Try new features early" switch. Beta is on
// only for a user who opted in; everyone means everyone; a flag the list
// does not carry (switched off on the server) is off.

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const flagsModule = await import('./featureFlags');
const { isFeatureOn, useFeature, useFeatureFlags, useFeatureFlagsReady, loadFeatureFlags, __setFeatureFlagsForTest } = flagsModule;

// Node's own localStorage has no storage behind it here; the app wraps every
// access in try/catch, the test needs a working one to read back.
const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
};

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  auth = { user: { preferences: { earlyAccess: false } } };
  __setFeatureFlagsForTest([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('beta is on only with early access; everyone is on for all; a missing flag is off', () => {
  const list = [{ key: 'vintagePage', state: 'beta' }, { key: 'other', state: 'everyone' }];
  expect(isFeatureOn(list, 'vintagePage', true)).toBe(true);
  expect(isFeatureOn(list, 'vintagePage', false)).toBe(false);
  expect(isFeatureOn(list, 'other', false)).toBe(true);
  expect(isFeatureOn(list, 'missing', true)).toBe(false);
  expect(isFeatureOn(null, 'vintagePage', true)).toBe(false);
});

test('useFeature follows the user\'s switch: turning early access on shows the beta screens at once', () => {
  __setFeatureFlagsForTest([{ key: 'vintagePage', state: 'beta' }]);
  const { result, rerender } = renderHook(() => useFeature('vintagePage'));
  expect(result.current).toBe(false);
  auth = { user: { preferences: { earlyAccess: true } } };
  rerender();
  expect(result.current).toBe(true);
  // A stray truthy value is not an opt-in.
  auth = { user: { preferences: { earlyAccess: 'yes' } } };
  rerender();
  expect(result.current).toBe(false);
});

test('a fresh list from the server reaches every subscriber and is remembered for the next visit', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ features: [{ key: 'vintagePage', state: 'everyone' }] }) })));
  const { result } = renderHook(() => useFeatureFlags());
  expect(result.current).toEqual([]);
  await act(async () => { await loadFeatureFlags({ force: true }); });
  await waitFor(() => expect(result.current).toEqual([{ key: 'vintagePage', state: 'everyone' }]));
  expect(fetch).toHaveBeenCalledWith('/api/site/features');
  expect(JSON.parse(localStorage.getItem('cellarion-feature-flags'))).toEqual([{ key: 'vintagePage', state: 'everyone' }]);
});

test('the app knows its flags only after the first answer — or a failure — so a page can wait instead of swapping layouts', async () => {
  __setFeatureFlagsForTest([], { known: false });
  const { result } = renderHook(() => useFeatureFlagsReady());
  expect(result.current).toBe(false);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  await act(async () => { await loadFeatureFlags({ force: true }); });
  await waitFor(() => expect(result.current).toBe(true));
});

test('an open tab re-reads the flags when it comes back into view', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ features: [{ key: 'vintagePage', state: 'off' }] }) })));
  renderHook(() => useFeatureFlags());
  const before = fetch.mock.calls.length;
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
  await waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(before));
  expect(fetch).toHaveBeenLastCalledWith('/api/site/features');
});

test('a failed or broken answer keeps what the app already had', async () => {
  __setFeatureFlagsForTest([{ key: 'vintagePage', state: 'beta' }]);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  await loadFeatureFlags({ force: true });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ nope: true }) })));
  await loadFeatureFlags({ force: true });
  const { result } = renderHook(() => useFeatureFlags());
  expect(result.current).toEqual([{ key: 'vintagePage', state: 'beta' }]);
});
