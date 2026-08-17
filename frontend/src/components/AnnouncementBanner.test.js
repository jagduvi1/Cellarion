import { render, screen, act, waitFor } from '@testing-library/react';
import AnnouncementBanner from './AnnouncementBanner';

// i18n: the component only uses t() for the dismiss label, so the identity
// stub keeps the assertions about the MESSAGE honest.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k) => k, i18n: { language: 'en' } }),
}));

const banner = (over = {}) => ({
  enabled: true,
  message: 'Planned maintenance at 18:15 UTC',
  messageSv: 'Planerat underhåll kl 18:15 UTC',
  type: 'info',
  updatedAt: '2026-08-17T07:53:20.843Z',
  ...over,
});

/** The module-level cache lives across renders — reset the module each test. */
async function freshBanner() {
  vi.resetModules();
  return (await import('./AnnouncementBanner')).default;
}

// Node ships an experimental `localStorage` global that shadows jsdom's here
// and has no clear() — stub a plain in-memory one rather than depend on which
// implementation wins.
let store;
const stubStorage = () => {
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  });
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  stubStorage();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ok = (body) => ({ ok: true, json: async () => body });

test('shows an enabled announcement', async () => {
  const Banner = await freshBanner();
  fetch.mockResolvedValue(ok(banner()));
  render(<Banner />);
  expect(await screen.findByText('Planned maintenance at 18:15 UTC')).toBeInTheDocument();
});

/**
 * The bug this polling exists for (2026-08-17): a banner raised while people
 * already had the app open reached nobody, because the component fetched only
 * on mount. An open tab must pick it up without a reload.
 */
test('an OPEN tab picks up a banner raised after mount', async () => {
  const Banner = await freshBanner();
  fetch.mockResolvedValueOnce(ok({ enabled: false }));
  render(<Banner />);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(screen.queryByText(/maintenance/)).not.toBeInTheDocument();

  // The banner goes up on the server, then the poll interval elapses.
  fetch.mockResolvedValue(ok(banner()));
  await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100); });

  expect(await screen.findByText('Planned maintenance at 18:15 UTC')).toBeInTheDocument();
});

test('returning to the tab re-checks without waiting for the interval', async () => {
  const Banner = await freshBanner();
  fetch.mockResolvedValueOnce(ok({ enabled: false }));
  render(<Banner />);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

  fetch.mockResolvedValue(ok(banner()));
  // Past CACHE_TTL, so the visibility check actually re-asks.
  await act(async () => { await vi.advanceTimersByTimeAsync(61 * 1000); });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });

  expect(await screen.findByText('Planned maintenance at 18:15 UTC')).toBeInTheDocument();
});

/**
 * With polling, a single dropped request must not blink a live notice off the
 * page — the failure keeps the last known state instead of resolving to
 * "no banner".
 */
test('a transient fetch failure does not take down a showing banner', async () => {
  const Banner = await freshBanner();
  fetch.mockResolvedValueOnce(ok(banner()));
  render(<Banner />);
  expect(await screen.findByText('Planned maintenance at 18:15 UTC')).toBeInTheDocument();

  fetch.mockRejectedValue(new Error('network'));
  await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100); });

  expect(screen.getByText('Planned maintenance at 18:15 UTC')).toBeInTheDocument();
});

test('a dismissed version stays hidden across polls, but a NEW version returns', async () => {
  const Banner = await freshBanner();
  store.set('announcementDismissed', '2026-08-17T07:53:20.843Z');
  fetch.mockResolvedValue(ok(banner()));
  render(<Banner />);
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(screen.queryByText(/maintenance/)).not.toBeInTheDocument();

  // An edited announcement carries a new updatedAt — the dismissal is per
  // version, so it must reappear.
  fetch.mockResolvedValue(ok(banner({
    message: 'Updated notice', updatedAt: '2026-08-17T09:00:00.000Z',
  })));
  await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100); });

  expect(await screen.findByText('Updated notice')).toBeInTheDocument();
});
